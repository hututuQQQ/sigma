use crate::protocol::RpcError;
use crate::repository_lease::{
    canonical_directory, pinned_executable_sha256, trusted_git_executable, validate_topology,
};
use crate::sandbox::NetworkMode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, to_value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const JOURNAL_VERSION: u32 = 2;
const RUN_BASELINE_VERSION: u32 = 1;
const DEFAULT_MAX_FILES: u64 = 200_000;
const DEFAULT_MAX_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const BROKER_FALLBACK_USER_NAME: &str = "user.name=Sigma Repository Transaction";
const BROKER_FALLBACK_USER_EMAIL: &str = "user.email=sigma-repository-transaction@example.invalid";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AcquireRepositoryTransactionLeaseParams {
    protocol_version: u32,
    session_id: String,
    run_id: String,
    repository_root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    executable: String,
    network: NetworkMode,
    #[serde(default)]
    max_snapshot_files: Option<u64>,
    #[serde(default)]
    max_snapshot_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryTransactionLeaseV2 {
    protocol_version: u32,
    lease_id: String,
    session_id: String,
    run_id: String,
    repository_root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    executable: PathBuf,
    executable_sha256: String,
    network: NetworkMode,
    uses: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_baseline: Option<RepositoryRunBaselineLeaseV1>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryRunBaselineLeaseV1 {
    schema_version: u32,
    baseline_id: String,
    restore_capability: String,
}

#[derive(Clone)]
struct TransactionLeaseRecord {
    lease: RepositoryTransactionLeaseV2,
    max_snapshot_files: u64,
    max_snapshot_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RepositoryOperationV2 {
    operation_class: String,
    args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositoryExpectedPostconditionsV3 {
    schema_version: u32,
    selected_head: String,
    selected_symbolic_ref: Option<String>,
    required_reachable_objects: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BeginRepositoryTransactionParams {
    protocol_version: u32,
    lease_id: String,
    operations: Vec<RepositoryOperationV2>,
    #[serde(default)]
    expected_postconditions: Option<RepositoryExpectedPostconditionsV3>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContinueRepositoryTransactionParams {
    protocol_version: u32,
    transaction_handle: String,
    session_id: String,
    run_id: String,
    #[serde(default)]
    operations: Vec<RepositoryOperationV2>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BoundRepositoryTransactionParams {
    protocol_version: u32,
    transaction_handle: String,
    session_id: String,
    run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoverRepositoryTransactionsParams {
    protocol_version: u32,
    session_id: String,
    #[serde(default)]
    run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RestoreRepositoryRunBaselineParams {
    protocol_version: u32,
    baseline_id: String,
    restore_capability: String,
    session_id: String,
    run_id: String,
    repository_root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReleaseRepositoryRunBaselineParams {
    protocol_version: u32,
    baseline_id: String,
    restore_capability: String,
    session_id: String,
    run_id: String,
    repository_root: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum JournalStatus {
    Applying,
    ConflictsPending,
    CompletedPendingSeal,
    Aborting,
    RepositoryStateUncertain,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RunBaselineStatus {
    Active,
    Restoring,
    RepositoryStateUncertain,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DirectoryIdentityV1 {
    platform: String,
    volume: u64,
    file: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RepositoryDirectoryIdentitiesV1 {
    repository_root: DirectoryIdentityV1,
    git_dir: DirectoryIdentityV1,
    common_dir: DirectoryIdentityV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryTransactionJournalV2 {
    journal_version: u32,
    transaction_handle: String,
    owner_instance_id: String,
    owner_pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_process_identity: Option<String>,
    session_id: String,
    run_id: String,
    repository_root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    directory_identities: Option<RepositoryDirectoryIdentitiesV1>,
    executable: PathBuf,
    executable_sha256: String,
    network: NetworkMode,
    operations: Vec<RepositoryOperationV2>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_postconditions: Option<RepositoryExpectedPostconditionsV3>,
    next_operation: usize,
    pending_operation: Option<RepositoryOperationV2>,
    status: JournalStatus,
    preimage_digest: String,
    snapshot_worktree: bool,
    snapshot_separate_git_dir: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryRunBaselineV1 {
    baseline_version: u32,
    baseline_id: String,
    restore_capability: String,
    restore_capability_sha256: String,
    owner_instance_id: String,
    owner_pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    owner_process_identity: Option<String>,
    session_id: String,
    run_id: String,
    repository_root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    directory_identities: RepositoryDirectoryIdentitiesV1,
    executable: PathBuf,
    executable_sha256: String,
    network: NetworkMode,
    preimage_digest: String,
    snapshot_worktree: bool,
    snapshot_separate_git_dir: bool,
    baseline_assertions: RepositorySemanticAssertionsV3,
    status: RunBaselineStatus,
}

#[derive(Clone)]
struct RunBaselineRecord {
    baseline: RepositoryRunBaselineV1,
    restore_capability: String,
}

#[derive(Default)]
struct SnapshotBudget {
    files: u64,
    bytes: u64,
    max_files: u64,
    max_bytes: u64,
}

#[derive(Clone)]
struct GitOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RepositorySemanticAssertionsV3 {
    schema_version: u32,
    head: Option<String>,
    symbolic_ref: Option<String>,
    refs_digest: String,
    reachability_digest: String,
    reachable_object_count: usize,
    index_digest: String,
    conflicts_digest: String,
    conflict_count: usize,
    tracked_digest: String,
    tracked_count: usize,
    untracked_digest: String,
    untracked_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_assertions: Option<RepositoryTargetAssertionsV3>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RepositoryTargetAssertionsV3 {
    schema_version: u32,
    selected_head: String,
    selected_symbolic_ref: Option<String>,
    required_reachable_objects: Vec<String>,
    satisfied: bool,
}

pub(crate) struct RepositoryTransactions {
    instance_id: String,
    owner_process_identity: Option<String>,
    root: PathBuf,
    leases: Mutex<HashMap<String, TransactionLeaseRecord>>,
    active: Mutex<HashMap<String, RepositoryTransactionJournalV2>>,
    consumed_handles: Mutex<HashSet<String>>,
    active_requests: Mutex<HashSet<u64>>,
    cancelled_requests: Mutex<HashSet<u64>>,
    run_baselines: Mutex<HashMap<String, RunBaselineRecord>>,
    consumed_run_baselines: Mutex<HashSet<String>>,
    operation_gate: Mutex<()>,
    initialization_error: Option<(String, String)>,
}

impl RepositoryTransactions {
    pub(crate) fn new(instance_id: &str) -> Self {
        let root = std::env::temp_dir().join("sigma-repository-transactions-v2");
        Self::new_with_root(instance_id, root)
    }

    fn new_with_root(instance_id: &str, root: PathBuf) -> Self {
        let initialization_error = prepare_journal_root(&root)
            .err()
            .map(|error| (error.code, error.message));
        let mut value = Self {
            instance_id: instance_id.to_owned(),
            owner_process_identity: process_identity(std::process::id()),
            root,
            leases: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
            consumed_handles: Mutex::new(HashSet::new()),
            active_requests: Mutex::new(HashSet::new()),
            cancelled_requests: Mutex::new(HashSet::new()),
            run_baselines: Mutex::new(HashMap::new()),
            consumed_run_baselines: Mutex::new(HashSet::new()),
            operation_gate: Mutex::new(()),
            initialization_error,
        };
        // A hard-killed helper cannot execute shutdown. The next helper restores
        // journals whose owning process no longer exists before accepting leases.
        if value.initialization_error.is_none() {
            if let Err(error) = value.recover_stale_journals() {
                value.initialization_error = Some((error.code, error.message));
            }
        }
        value
    }

    pub(crate) fn acquire(
        &self,
        params: AcquireRepositoryTransactionLeaseParams,
    ) -> Result<Value, RpcError> {
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        self.available()?;
        if params.protocol_version != 2 {
            return Err(atomicity_unavailable(
                "RepositoryTransactionLeaseV2 is required",
            ));
        }
        if params.network != NetworkMode::None {
            return Err(RpcError::new(
                "policy_denied",
                "repository write transactions are local-only",
            ));
        }
        validate_identity(&params.session_id, "sessionId")?;
        validate_identity(&params.run_id, "runId")?;
        let repository_root = canonical_directory(&params.repository_root, "repository root")?;
        let git_dir = canonical_directory(&params.git_dir, "Git directory")?;
        let common_dir = canonical_directory(&params.common_dir, "Git common directory")?;
        validate_topology(&repository_root, &git_dir, &common_dir)?;
        let executable = trusted_git_executable(&params.executable)?;
        let executable_sha256 = pinned_executable_sha256(&executable)?;
        if self.has_active_binding(&params.session_id, &params.run_id, &repository_root)? {
            return Err(RpcError::new(
                "repository_transaction_pending",
                "this run already owns a pending repository transaction",
            ));
        }
        let lease_id = random_capability("rtl2")?;
        let mut lease = RepositoryTransactionLeaseV2 {
            protocol_version: 2,
            lease_id: lease_id.clone(),
            session_id: params.session_id,
            run_id: params.run_id,
            repository_root,
            git_dir,
            common_dir,
            executable,
            executable_sha256,
            network: NetworkMode::None,
            uses: 1,
            run_baseline: None,
        };
        let max_snapshot_files = params
            .max_snapshot_files
            .unwrap_or(DEFAULT_MAX_FILES)
            .max(1);
        let max_snapshot_bytes = params
            .max_snapshot_bytes
            .unwrap_or(DEFAULT_MAX_BYTES)
            .max(1);
        lease.run_baseline =
            Some(self.ensure_run_baseline(&lease, max_snapshot_files, max_snapshot_bytes)?);
        self.leases.lock().map_err(lock_error)?.insert(
            lease_id,
            TransactionLeaseRecord {
                lease: lease.clone(),
                max_snapshot_files,
                max_snapshot_bytes,
            },
        );
        to_value(lease).map_err(protocol_serialization_error)
    }

    pub(crate) fn begin_request(&self, request_id: u64) -> Result<(), RpcError> {
        let mut active = self.active_requests.lock().map_err(lock_error)?;
        if !active.insert(request_id) {
            return Err(RpcError::new(
                "broker_protocol_error",
                "duplicate repository transaction request id",
            ));
        }
        Ok(())
    }

    pub(crate) fn finish_request(&self, request_id: u64) {
        if let Ok(mut active) = self.active_requests.lock() {
            active.remove(&request_id);
        }
        if let Ok(mut cancelled) = self.cancelled_requests.lock() {
            cancelled.remove(&request_id);
        }
    }

    pub(crate) fn cancel_request(&self, request_id: u64) -> bool {
        let active = self
            .active_requests
            .lock()
            .is_ok_and(|active| active.contains(&request_id));
        if active {
            let _ = self
                .cancelled_requests
                .lock()
                .map(|mut cancelled| cancelled.insert(request_id));
        }
        active
    }

    pub(crate) fn begin(
        &self,
        request_id: u64,
        params: BeginRepositoryTransactionParams,
    ) -> Result<Value, RpcError> {
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        self.available()?;
        match params.protocol_version {
            2 if params.expected_postconditions.is_none() => {}
            3 if params.expected_postconditions.is_some() => {
                validate_expected_postconditions(params.expected_postconditions.as_ref().unwrap())?;
            }
            _ => {
                return Err(invalid_transaction(
                    "V3 begin requires expectedPostconditions and V2 forbids them",
                ));
            }
        }
        if params.operations.is_empty() || params.operations.len() > 64 {
            return Err(invalid_transaction("begin requires 1..64 operations"));
        }
        validate_operations(&params.operations, false)?;
        // Burn before any other validation so a captured lease cannot become an oracle.
        let record = self
            .leases
            .lock()
            .map_err(lock_error)?
            .remove(&params.lease_id)
            .ok_or_else(|| {
                invalid_handle("repository transaction lease is unknown, expired, or already used")
            })?;
        repin_executable(&record.lease.executable, &record.lease.executable_sha256)?;
        self.ensure_no_active_repository(&record.lease.repository_root)?;
        self.reject_external_git_helpers(request_id, &record.lease)?;
        reject_present_runtime_state(&record.lease.repository_root)?;
        let handle = random_capability("rth2")?;
        let transaction_dir = self.transaction_dir(&handle);
        fs::create_dir(&transaction_dir).map_err(snapshot_error)?;
        if let Err(error) = sync_directory(&self.root) {
            let _ = remove_any(&transaction_dir);
            return Err(error);
        }
        let mut budget = SnapshotBudget {
            max_files: record.max_snapshot_files,
            max_bytes: record.max_snapshot_bytes,
            ..SnapshotBudget::default()
        };
        let directory_identities = repository_directory_identities(&record.lease)?;
        let preimage_digest = match capture_preimage(&record.lease, &transaction_dir, &mut budget) {
            Ok(value) => value,
            Err(error) => {
                let _ = remove_any(&transaction_dir);
                return Err(error);
            }
        };
        if let Err(error) =
            validate_lease_directory_identities(&record.lease, &directory_identities)
        {
            let _ = remove_any(&transaction_dir);
            return Err(error);
        }
        let snapshot_worktree = record.lease.repository_root != record.lease.git_dir;
        let snapshot_separate_git_dir = !record.lease.git_dir.starts_with(&record.lease.common_dir);
        let mut journal = RepositoryTransactionJournalV2 {
            journal_version: JOURNAL_VERSION,
            transaction_handle: handle.clone(),
            owner_instance_id: self.instance_id.clone(),
            owner_pid: std::process::id(),
            owner_process_identity: self.owner_process_identity.clone(),
            session_id: record.lease.session_id,
            run_id: record.lease.run_id,
            repository_root: record.lease.repository_root,
            git_dir: record.lease.git_dir.clone(),
            common_dir: record.lease.common_dir.clone(),
            directory_identities: Some(directory_identities),
            executable: record.lease.executable,
            executable_sha256: record.lease.executable_sha256,
            network: NetworkMode::None,
            operations: params.operations,
            expected_postconditions: params.expected_postconditions,
            next_operation: 0,
            pending_operation: None,
            status: JournalStatus::Applying,
            preimage_digest,
            snapshot_worktree,
            snapshot_separate_git_dir,
        };
        if let Err(error) = self.persist_and_track(&journal) {
            let _ = remove_any(&transaction_dir);
            let _ = sync_directory(&self.root);
            return Err(error);
        }
        match self.apply_remaining(request_id, &mut journal, Vec::new()) {
            Ok(value) => Ok(value),
            Err(original) => match self.restore_and_consume(&journal) {
                Ok(()) => Err(original),
                Err(restore) => Err(repository_state_uncertain(original, restore)),
            },
        }
    }

    pub(crate) fn continue_transaction(
        &self,
        request_id: u64,
        params: ContinueRepositoryTransactionParams,
    ) -> Result<Value, RpcError> {
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        require_v2(params.protocol_version)?;
        validate_identity(&params.session_id, "sessionId")?;
        validate_identity(&params.run_id, "runId")?;
        validate_operations(&params.operations, true)?;
        let mut journal = self.bound_journal(
            &params.transaction_handle,
            &params.session_id,
            &params.run_id,
        )?;
        if journal.status != JournalStatus::ConflictsPending {
            return Err(invalid_handle(
                "repository transaction is not awaiting conflict resolution",
            ));
        }
        repin_executable(&journal.executable, &journal.executable_sha256)?;
        let rollback_journal = journal.clone();
        let result = (|| -> Result<Value, RpcError> {
            let mut output = Vec::new();
            for operation in &params.operations {
                let result = self.run_git(Some(request_id), &journal, &operation.args)?;
                output.push(result.stdout);
                output.push(result.stderr);
                if result.exit_code != 0 {
                    return Err(RpcError::new(
                        "repository_continue_failed",
                        format!("Git add failed with exit code {}", result.exit_code),
                    ));
                }
            }
            let conflicts = self.conflict_count(Some(request_id), &journal)?;
            if conflicts > 0 {
                self.persist_and_track(&journal)?;
                return Ok(transaction_result(
                    "conflicts_pending",
                    &journal,
                    output,
                    conflicts,
                ));
            }
            let pending = journal.pending_operation.clone().ok_or_else(|| {
                RpcError::new(
                    "repository_state_uncertain",
                    "pending Git operation is missing",
                )
            })?;
            let continuation = continuation_args(&pending.operation_class)?;
            let result = self.run_git(Some(request_id), &journal, &continuation)?;
            output.push(result.stdout);
            output.push(result.stderr);
            self.reject_journal_runtime_state(Some(request_id), &journal)?;
            if result.exit_code != 0 {
                let conflicts = self.conflict_count(Some(request_id), &journal)?;
                if conflicts > 0 {
                    journal.status = JournalStatus::ConflictsPending;
                    self.persist_and_track(&journal)?;
                    return Ok(transaction_result(
                        "conflicts_pending",
                        &journal,
                        output,
                        conflicts,
                    ));
                }
                self.persist_and_track(&journal)?;
                return Err(RpcError::new(
                    "repository_continue_failed",
                    format!("Git --continue failed with exit code {}", result.exit_code),
                ));
            }
            journal.pending_operation = None;
            journal.status = JournalStatus::Applying;
            self.persist_and_track(&journal)?;
            self.apply_remaining(request_id, &mut journal, output)
        })();
        match result {
            Err(error)
                if error.code == "cancelled"
                    || error.code == "repository_runtime_state_protected"
                    || error.code == "repository_state_unavailable"
                    || error.code == "repository_postcondition_failed" =>
            {
                match self.restore_and_consume(&rollback_journal) {
                    Ok(()) => Err(error),
                    Err(restore) => Err(repository_state_uncertain(error, restore)),
                }
            }
            value => value,
        }
    }

    pub(crate) fn abort(
        &self,
        params: BoundRepositoryTransactionParams,
    ) -> Result<Value, RpcError> {
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        require_v2(params.protocol_version)?;
        let mut journal = self.bound_journal(
            &params.transaction_handle,
            &params.session_id,
            &params.run_id,
        )?;
        journal.status = JournalStatus::Aborting;
        self.persist_and_track(&journal)?;
        let abort_result = journal.pending_operation.as_ref().and_then(|operation| {
            abort_args(&operation.operation_class)
                .ok()
                .and_then(|args| self.run_git(None, &journal, &args).ok())
        });
        self.restore_and_consume(&journal).map_err(|restore| {
            repository_state_uncertain(
                RpcError::new(
                    "repository_abort_failed",
                    abort_result
                        .as_ref()
                        .map(|item| item.stderr.as_str())
                        .unwrap_or("Git abort was unavailable"),
                ),
                restore,
            )
        })?;
        Ok(json!({
            "protocolVersion": 2,
            "status": "aborted",
            "transactionHandle": params.transaction_handle,
            "rollbackState": "restored",
            "gitAbortSucceeded": abort_result.is_some_and(|item| item.exit_code == 0),
        }))
    }

    pub(crate) fn seal(&self, params: BoundRepositoryTransactionParams) -> Result<Value, RpcError> {
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        require_v2(params.protocol_version)?;
        let journal = self.bound_journal(
            &params.transaction_handle,
            &params.session_id,
            &params.run_id,
        )?;
        let postcondition = (|| -> Result<(), RpcError> {
            if journal.status != JournalStatus::CompletedPendingSeal
                || self.conflict_count(None, &journal)? != 0
            {
                return Err(RpcError::new(
                    "repository_postcondition_failed",
                    "repository transaction cannot be sealed before its conflict-free postconditions are observed",
                ));
            }
            self.reject_journal_runtime_state(None, &journal)
        })();
        if let Err(original) = postcondition {
            return match self.restore_and_consume(&journal) {
                Ok(()) => Err(original),
                Err(restore) => Err(repository_state_uncertain(original, restore)),
            };
        }
        if let Err(original) = self.consume_journal(&journal) {
            return match self.restore_and_consume(&journal) {
                Ok(()) => Err(original),
                Err(restore) => Err(repository_state_uncertain(original, restore)),
            };
        }
        Ok(json!({
            "protocolVersion": 2,
            "status": "sealed",
            "transactionHandle": params.transaction_handle,
        }))
    }

    pub(crate) fn recover(
        &self,
        params: RecoverRepositoryTransactionsParams,
    ) -> Result<Value, RpcError> {
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        require_v2(params.protocol_version)?;
        validate_identity(&params.session_id, "sessionId")?;
        if let Some(run_id) = params.run_id.as_deref() {
            validate_identity(run_id, "runId")?;
        }
        let journals = self
            .load_all_journals()?
            .into_iter()
            .filter(|journal| {
                journal.session_id == params.session_id
                    && params
                        .run_id
                        .as_ref()
                        .is_none_or(|run_id| &journal.run_id == run_id)
            })
            .collect::<Vec<_>>();
        let mut recovered = 0_u64;
        for journal in journals {
            self.restore_and_consume(&journal).map_err(|restore| {
                repository_state_uncertain(
                    RpcError::new(
                        "repository_recovery_failed",
                        "interrupted transaction requires recovery",
                    ),
                    restore,
                )
            })?;
            recovered += 1;
        }
        Ok(json!({ "protocolVersion": 2, "status": "recovered", "recovered": recovered }))
    }

    pub(crate) fn restore_run_baseline(
        &self,
        params: RestoreRepositoryRunBaselineParams,
    ) -> Result<Value, RpcError> {
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        self.available()?;
        let mut baseline = self.bound_run_baseline(
            params.protocol_version,
            &params.baseline_id,
            &params.restore_capability,
            &params.session_id,
            &params.run_id,
            &params.repository_root,
        )?;
        self.ensure_no_active_repository(&baseline.repository_root)?;
        self.leases.lock().map_err(lock_error)?.retain(|_, record| {
            record.lease.session_id != baseline.session_id
                || record.lease.run_id != baseline.run_id
                || record.lease.repository_root != baseline.repository_root
        });
        baseline.status = RunBaselineStatus::Restoring;
        self.persist_run_baseline(&baseline)?;
        self.run_baselines
            .lock()
            .map_err(lock_error)?
            .remove(&baseline.baseline_id);
        let journal = run_baseline_journal(&baseline);
        let result = (|| -> Result<RepositorySemanticAssertionsV3, RpcError> {
            restore_preimage(&journal, &self.run_baseline_dir(&baseline.baseline_id))?;
            let assertions = repository_semantic_assertions(&journal)?;
            if assertions != baseline.baseline_assertions {
                return Err(RpcError::new(
                    "repository_state_uncertain",
                    "repository run baseline restoration did not reproduce its authenticated semantic state",
                ));
            }
            Ok(assertions)
        })();
        self.consume_run_baseline(&baseline.baseline_id, result.is_ok())?;
        match result {
            Ok(assertions) => Ok(json!({
                "protocolVersion": 1,
                "status": "restored",
                "baselineId": baseline.baseline_id,
                "sessionId": baseline.session_id,
                "runId": baseline.run_id,
                "repositoryRoot": baseline.repository_root,
                "semanticAssertions": assertions,
            })),
            Err(error) => Err(repository_state_uncertain(
                RpcError::new(
                    "repository_run_baseline_restore_failed",
                    "repository run baseline restoration failed",
                ),
                error,
            )),
        }
    }

    pub(crate) fn release_run_baseline(
        &self,
        params: ReleaseRepositoryRunBaselineParams,
    ) -> Result<Value, RpcError> {
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        self.available()?;
        let baseline = self.bound_run_baseline(
            params.protocol_version,
            &params.baseline_id,
            &params.restore_capability,
            &params.session_id,
            &params.run_id,
            &params.repository_root,
        )?;
        self.ensure_no_active_repository(&baseline.repository_root)?;
        self.leases.lock().map_err(lock_error)?.retain(|_, record| {
            record.lease.session_id != baseline.session_id
                || record.lease.run_id != baseline.run_id
                || record.lease.repository_root != baseline.repository_root
        });
        self.run_baselines
            .lock()
            .map_err(lock_error)?
            .remove(&baseline.baseline_id);
        self.consume_run_baseline(&baseline.baseline_id, true)?;
        Ok(json!({
            "protocolVersion": 1,
            "status": "released",
            "baselineId": baseline.baseline_id,
            "sessionId": baseline.session_id,
            "runId": baseline.run_id,
            "repositoryRoot": baseline.repository_root,
        }))
    }

    pub(crate) fn shutdown(&self) -> Result<(), RpcError> {
        let active = self.active_requests.lock().map_err(lock_error)?;
        self.cancelled_requests
            .lock()
            .map_err(lock_error)?
            .extend(active.iter().copied());
        drop(active);
        let _operation = self.operation_gate.lock().map_err(lock_error)?;
        let journals = self
            .load_all_journals()?
            .into_iter()
            .filter(|journal| journal.owner_instance_id == self.instance_id)
            .collect::<Vec<_>>();
        for journal in journals {
            self.restore_and_consume(&journal).map_err(|restore| {
                repository_state_uncertain(
                    RpcError::new(
                        "repository_recovery_failed",
                        "broker shutdown could not restore a pending repository transaction",
                    ),
                    restore,
                )
            })?;
        }
        for baseline in self
            .load_all_run_baselines()?
            .into_iter()
            .filter(|baseline| baseline.owner_instance_id == self.instance_id)
        {
            self.run_baselines
                .lock()
                .map_err(lock_error)?
                .remove(&baseline.baseline_id);
            self.consume_run_baseline(&baseline.baseline_id, true)?;
        }
        self.leases.lock().map_err(lock_error)?.clear();
        Ok(())
    }

    fn available(&self) -> Result<(), RpcError> {
        if let Some((code, message)) = self.initialization_error.as_ref() {
            return Err(RpcError::new(code.clone(), message.clone()));
        }
        Ok(())
    }

    fn transaction_dir(&self, handle: &str) -> PathBuf {
        self.root.join(handle)
    }

    fn journal_path(&self, handle: &str) -> PathBuf {
        self.transaction_dir(handle).join("journal.json")
    }

    fn run_baseline_root(&self) -> PathBuf {
        self.root.join("run-baselines")
    }

    fn run_baseline_dir(&self, baseline_id: &str) -> PathBuf {
        self.run_baseline_root().join(baseline_id)
    }

    fn run_baseline_path(&self, baseline_id: &str) -> PathBuf {
        self.run_baseline_dir(baseline_id).join("baseline.json")
    }

    fn ensure_run_baseline(
        &self,
        lease: &RepositoryTransactionLeaseV2,
        max_snapshot_files: u64,
        max_snapshot_bytes: u64,
    ) -> Result<RepositoryRunBaselineLeaseV1, RpcError> {
        if let Some(record) = self
            .run_baselines
            .lock()
            .map_err(lock_error)?
            .values()
            .find(|record| {
                record.baseline.session_id == lease.session_id
                    && record.baseline.run_id == lease.run_id
                    && record.baseline.repository_root == lease.repository_root
            })
            .cloned()
        {
            if record.baseline.status != RunBaselineStatus::Active
                || record.baseline.git_dir != lease.git_dir
                || record.baseline.common_dir != lease.common_dir
                || record.baseline.executable != lease.executable
                || record.baseline.executable_sha256 != lease.executable_sha256
            {
                return Err(RpcError::new(
                    "repository_state_uncertain",
                    "the current run repository baseline no longer matches its authenticated topology",
                ));
            }
            return Ok(RepositoryRunBaselineLeaseV1 {
                schema_version: 1,
                baseline_id: record.baseline.baseline_id,
                restore_capability: record.restore_capability,
            });
        }
        let mut persisted = self
            .load_all_run_baselines()?
            .into_iter()
            .filter(|baseline| {
                baseline.session_id == lease.session_id
                    && baseline.run_id == lease.run_id
                    && baseline.repository_root == lease.repository_root
            })
            .collect::<Vec<_>>();
        if persisted.len() > 1 {
            return Err(RpcError::new(
                "repository_state_uncertain",
                "multiple run-scoped repository baselines claim the same binding",
            ));
        }
        if let Some(mut baseline) = persisted.pop() {
            if baseline.status != RunBaselineStatus::Active
                || baseline.git_dir != lease.git_dir
                || baseline.common_dir != lease.common_dir
                || baseline.executable != lease.executable
                || baseline.executable_sha256 != lease.executable_sha256
                || baseline.restore_capability_sha256
                    != sha256_bytes(baseline.restore_capability.as_bytes())
            {
                return Err(RpcError::new(
                    "repository_state_uncertain",
                    "persisted run-scoped repository baseline has an invalid binding",
                ));
            }
            if self.run_baseline_owner_is_live(&baseline)
                && baseline.owner_instance_id != self.instance_id
            {
                return Err(RpcError::new(
                    "repository_transaction_pending",
                    "another live broker owns this run-scoped repository baseline",
                ));
            }
            validate_live_topology(&run_baseline_journal(&baseline))?;
            repin_executable(&baseline.executable, &baseline.executable_sha256)?;
            baseline.owner_instance_id = self.instance_id.clone();
            baseline.owner_pid = std::process::id();
            baseline.owner_process_identity = self.owner_process_identity.clone();
            self.persist_run_baseline(&baseline)?;
            let restore_capability = baseline.restore_capability.clone();
            let baseline_id = baseline.baseline_id.clone();
            self.run_baselines.lock().map_err(lock_error)?.insert(
                baseline_id.clone(),
                RunBaselineRecord {
                    baseline,
                    restore_capability: restore_capability.clone(),
                },
            );
            return Ok(RepositoryRunBaselineLeaseV1 {
                schema_version: 1,
                baseline_id,
                restore_capability,
            });
        }
        fs::create_dir_all(self.run_baseline_root()).map_err(snapshot_error)?;
        let baseline_id = random_capability("rrb1")?;
        let restore_capability = random_capability("rrc1")?;
        let baseline_dir = self.run_baseline_dir(&baseline_id);
        fs::create_dir(&baseline_dir).map_err(snapshot_error)?;
        let mut budget = SnapshotBudget {
            max_files: max_snapshot_files,
            max_bytes: max_snapshot_bytes,
            ..SnapshotBudget::default()
        };
        let result = (|| -> Result<RepositoryRunBaselineV1, RpcError> {
            let identities = repository_directory_identities(lease)?;
            let preimage_digest = capture_preimage(lease, &baseline_dir, &mut budget)?;
            validate_lease_directory_identities(lease, &identities)?;
            let mut baseline = RepositoryRunBaselineV1 {
                baseline_version: RUN_BASELINE_VERSION,
                baseline_id: baseline_id.clone(),
                restore_capability: restore_capability.clone(),
                restore_capability_sha256: sha256_bytes(restore_capability.as_bytes()),
                owner_instance_id: self.instance_id.clone(),
                owner_pid: std::process::id(),
                owner_process_identity: self.owner_process_identity.clone(),
                session_id: lease.session_id.clone(),
                run_id: lease.run_id.clone(),
                repository_root: lease.repository_root.clone(),
                git_dir: lease.git_dir.clone(),
                common_dir: lease.common_dir.clone(),
                directory_identities: identities,
                executable: lease.executable.clone(),
                executable_sha256: lease.executable_sha256.clone(),
                network: NetworkMode::None,
                preimage_digest,
                snapshot_worktree: lease.repository_root != lease.git_dir,
                snapshot_separate_git_dir: !lease.git_dir.starts_with(&lease.common_dir),
                baseline_assertions: empty_repository_assertions(),
                status: RunBaselineStatus::Active,
            };
            baseline.baseline_assertions =
                repository_semantic_assertions(&run_baseline_journal(&baseline))?;
            self.persist_run_baseline(&baseline)?;
            Ok(baseline)
        })();
        let baseline = match result {
            Ok(value) => value,
            Err(error) => {
                let _ = remove_any(&baseline_dir);
                return Err(error);
            }
        };
        self.run_baselines.lock().map_err(lock_error)?.insert(
            baseline_id.clone(),
            RunBaselineRecord {
                baseline,
                restore_capability: restore_capability.clone(),
            },
        );
        Ok(RepositoryRunBaselineLeaseV1 {
            schema_version: 1,
            baseline_id,
            restore_capability,
        })
    }

    fn persist_run_baseline(&self, baseline: &RepositoryRunBaselineV1) -> Result<(), RpcError> {
        write_json_atomic(&self.run_baseline_path(&baseline.baseline_id), baseline)
    }

    fn bound_run_baseline(
        &self,
        protocol_version: u32,
        baseline_id: &str,
        restore_capability: &str,
        session_id: &str,
        run_id: &str,
        repository_root: &Path,
    ) -> Result<RepositoryRunBaselineV1, RpcError> {
        if protocol_version != 1 {
            return Err(atomicity_unavailable(
                "Repository run baseline V1 is required",
            ));
        }
        validate_capability(baseline_id, "baselineId")?;
        validate_capability(restore_capability, "restoreCapability")?;
        validate_identity(session_id, "sessionId")?;
        validate_identity(run_id, "runId")?;
        if self
            .consumed_run_baselines
            .lock()
            .map_err(lock_error)?
            .contains(baseline_id)
        {
            return Err(invalid_handle(
                "repository run baseline was already consumed",
            ));
        }
        let baseline = read_run_baseline(&self.run_baseline_path(baseline_id))?;
        let root = canonical_directory(repository_root, "repository root")?;
        if baseline.baseline_id != baseline_id
            || baseline.status != RunBaselineStatus::Active
            || baseline.session_id != session_id
            || baseline.run_id != run_id
            || baseline.repository_root != root
            || baseline.restore_capability != restore_capability
            || baseline.restore_capability_sha256 != sha256_bytes(restore_capability.as_bytes())
        {
            return Err(invalid_handle(
                "repository run baseline belongs to a different session, run, repository, or capability",
            ));
        }
        validate_live_topology(&run_baseline_journal(&baseline))?;
        repin_executable(&baseline.executable, &baseline.executable_sha256)?;
        Ok(baseline)
    }

    fn consume_run_baseline(
        &self,
        baseline_id: &str,
        remove_snapshot: bool,
    ) -> Result<(), RpcError> {
        let mut consumed = self.consumed_run_baselines.lock().map_err(lock_error)?;
        if consumed.len() >= 4096 {
            consumed.clear();
        }
        consumed.insert(baseline_id.to_owned());
        drop(consumed);
        if remove_snapshot {
            remove_any(&self.run_baseline_dir(baseline_id)).map_err(snapshot_error)?;
            sync_directory(&self.run_baseline_root())?;
        } else {
            let mut baseline = read_run_baseline(&self.run_baseline_path(baseline_id))?;
            baseline.status = RunBaselineStatus::RepositoryStateUncertain;
            self.persist_run_baseline(&baseline)?;
        }
        Ok(())
    }

    fn load_all_run_baselines(&self) -> Result<Vec<RepositoryRunBaselineV1>, RpcError> {
        let mut values = Vec::new();
        let entries = match fs::read_dir(self.run_baseline_root()) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(values),
            Err(error) => return Err(snapshot_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(snapshot_error)?;
            if !entry.file_type().map_err(snapshot_error)?.is_dir() {
                continue;
            }
            let path = entry.path().join("baseline.json");
            if path.is_file() {
                values.push(read_run_baseline(&path)?);
            }
        }
        Ok(values)
    }

    fn run_baseline_owner_is_live(&self, baseline: &RepositoryRunBaselineV1) -> bool {
        if !process_alive(baseline.owner_pid) {
            return false;
        }
        let observed_identity = process_identity(baseline.owner_pid);
        match (
            baseline.owner_process_identity.as_deref(),
            observed_identity.as_deref(),
        ) {
            (Some(expected), Some(observed)) => expected == observed,
            _ => {
                baseline.owner_pid != std::process::id()
                    || baseline.owner_instance_id == self.instance_id
                    || baseline.owner_process_identity.is_none()
            }
        }
    }

    fn persist_and_track(&self, journal: &RepositoryTransactionJournalV2) -> Result<(), RpcError> {
        write_journal(&self.journal_path(&journal.transaction_handle), journal)?;
        self.active
            .lock()
            .map_err(lock_error)?
            .insert(journal.transaction_handle.clone(), journal.clone());
        Ok(())
    }

    fn bound_journal(
        &self,
        handle: &str,
        session_id: &str,
        run_id: &str,
    ) -> Result<RepositoryTransactionJournalV2, RpcError> {
        validate_capability(handle, "transactionHandle")?;
        if self
            .consumed_handles
            .lock()
            .map_err(lock_error)?
            .contains(handle)
        {
            return Err(invalid_handle(
                "repository transaction handle was already consumed",
            ));
        }
        let journal =
            if let Some(value) = self.active.lock().map_err(lock_error)?.get(handle).cloned() {
                value
            } else {
                read_journal(&self.journal_path(handle))?
            };
        if journal.transaction_handle != handle
            || journal.session_id != session_id
            || journal.run_id != run_id
        {
            return Err(invalid_handle(
                "repository transaction handle belongs to a different session, run, or repository",
            ));
        }
        validate_live_topology(&journal)?;
        Ok(journal)
    }

    fn request_cancelled(&self, request_id: u64) -> bool {
        self.cancelled_requests
            .lock()
            .is_ok_and(|cancelled| cancelled.contains(&request_id))
    }

    fn run_git(
        &self,
        request_id: Option<u64>,
        journal: &RepositoryTransactionJournalV2,
        args: &[String],
    ) -> Result<GitOutput, RpcError> {
        run_git_bounded(journal, args, || {
            request_id.is_some_and(|request_id| self.request_cancelled(request_id))
        })
    }

    fn conflict_count(
        &self,
        request_id: Option<u64>,
        journal: &RepositoryTransactionJournalV2,
    ) -> Result<usize, RpcError> {
        let output = self.run_git(
            request_id,
            journal,
            &["ls-files".into(), "--unmerged".into(), "-z".into()],
        )?;
        if output.exit_code != 0 {
            return Err(RpcError::new(
                "repository_state_unavailable",
                "repository conflict state could not be inspected",
            ));
        }
        let mut paths = HashSet::new();
        for entry in output.stdout.split('\0').filter(|value| !value.is_empty()) {
            if let Some((_, path)) = entry.split_once('\t') {
                paths.insert(path);
            }
        }
        Ok(paths.len())
    }

    fn reject_external_git_helpers(
        &self,
        request_id: u64,
        lease: &RepositoryTransactionLeaseV2,
    ) -> Result<(), RpcError> {
        let journal = RepositoryTransactionJournalV2 {
            journal_version: JOURNAL_VERSION,
            transaction_handle: "preflight".into(),
            owner_instance_id: "preflight".into(),
            owner_pid: std::process::id(),
            owner_process_identity: self.owner_process_identity.clone(),
            session_id: lease.session_id.clone(),
            run_id: lease.run_id.clone(),
            repository_root: lease.repository_root.clone(),
            git_dir: lease.git_dir.clone(),
            common_dir: lease.common_dir.clone(),
            directory_identities: Some(repository_directory_identities(lease)?),
            executable: lease.executable.clone(),
            executable_sha256: lease.executable_sha256.clone(),
            network: NetworkMode::None,
            operations: Vec::new(),
            expected_postconditions: None,
            next_operation: 0,
            pending_operation: None,
            status: JournalStatus::Applying,
            preimage_digest: "preflight".into(),
            snapshot_worktree: false,
            snapshot_separate_git_dir: false,
        };
        let output = self.run_git(Some(request_id), &journal, &[
            "config".into(),
            "--local".into(),
            "--includes".into(),
            "--get-regexp".into(),
            "^(include(if)?\\..*\\.path|merge\\..*\\.driver|diff\\..*\\.command|filter\\..*\\.(clean|smudge|process)|core\\.(fsmonitor|sshcommand)|commit\\.gpgsign|tag\\.gpgsign|merge\\.(gpgsign|verifysignatures)|rebase\\.gpgsign|gpg\\.program|gpg\\..*\\.program)$".into(),
        ])?;
        if output.exit_code != 0 && output.exit_code != 1 {
            return Err(RpcError::new(
                "repository_state_unavailable",
                "repository configuration could not be inspected",
            ));
        }
        if output.exit_code == 0 && !output.stdout.trim().is_empty() {
            return Err(RpcError::new(
                "repository_external_helper_denied",
                "repository config contains an external driver or helper",
            ));
        }
        self.reject_journal_runtime_state(Some(request_id), &journal)
    }

    fn reject_journal_runtime_state(
        &self,
        request_id: Option<u64>,
        journal: &RepositoryTransactionJournalV2,
    ) -> Result<(), RpcError> {
        reject_present_runtime_state(&journal.repository_root)?;
        let runtime_state = self.run_git(
            request_id,
            journal,
            &["ls-files".into(), "-z".into(), "--".into(), ".agent".into()],
        )?;
        if runtime_state.exit_code != 0 {
            return Err(RpcError::new(
                "repository_state_unavailable",
                "runtime-owned repository paths could not be inspected",
            ));
        }
        if !runtime_state.stdout.is_empty() {
            return Err(RpcError::new(
                "repository_runtime_state_protected",
                "structured Git transactions cannot operate on a repository that tracks .agent",
            ));
        }
        Ok(())
    }

    fn apply_remaining(
        &self,
        request_id: u64,
        journal: &mut RepositoryTransactionJournalV2,
        mut output: Vec<String>,
    ) -> Result<Value, RpcError> {
        while journal.next_operation < journal.operations.len() {
            let operation = journal.operations[journal.next_operation].clone();
            journal.status = JournalStatus::Applying;
            self.persist_and_track(journal)?;
            let result = self.run_git(Some(request_id), journal, &operation.args)?;
            output.push(result.stdout);
            output.push(result.stderr.clone());
            // Tree-level operations can introduce a tracked `.agent` even
            // though the current index and worktree passed preflight. Never
            // publish such an intermediate state to the runtime. The caller
            // restores the broker-owned preimage before returning the error.
            self.reject_journal_runtime_state(Some(request_id), journal)?;
            if result.exit_code != 0 {
                let conflicts = self.conflict_count(Some(request_id), journal)?;
                if can_pause_for_conflict(&operation.operation_class) && conflicts > 0 {
                    journal.pending_operation = Some(operation);
                    journal.next_operation += 1;
                    journal.status = JournalStatus::ConflictsPending;
                    self.persist_and_track(journal)?;
                    return Ok(transaction_result(
                        "conflicts_pending",
                        journal,
                        output,
                        conflicts,
                    ));
                }
                return Err(RpcError::new(
                    "repository_operation_failed",
                    format!(
                        "Git {} failed with exit code {}: {}",
                        operation.operation_class,
                        result.exit_code,
                        result.stderr.trim()
                    ),
                ));
            }
            journal.next_operation += 1;
            self.persist_and_track(journal)?;
        }
        journal.status = JournalStatus::CompletedPendingSeal;
        self.persist_and_track(journal)?;
        let assertions = repository_semantic_assertions(journal)?;
        Ok(transaction_result_v3(
            "completed_pending_seal",
            journal,
            output,
            0,
            assertions,
        ))
    }

    fn restore_and_consume(
        &self,
        journal: &RepositoryTransactionJournalV2,
    ) -> Result<(), RpcError> {
        match restore_preimage(journal, &self.transaction_dir(&journal.transaction_handle)) {
            Ok(()) => self.consume_journal(journal),
            Err(error) => {
                let mut uncertain = journal.clone();
                uncertain.status = JournalStatus::RepositoryStateUncertain;
                let _ = self.persist_and_track(&uncertain);
                Err(error)
            }
        }
    }

    fn consume_journal(&self, journal: &RepositoryTransactionJournalV2) -> Result<(), RpcError> {
        self.active
            .lock()
            .map_err(lock_error)?
            .remove(&journal.transaction_handle);
        let mut consumed = self.consumed_handles.lock().map_err(lock_error)?;
        if consumed.len() >= 4096 {
            consumed.clear();
        }
        consumed.insert(journal.transaction_handle.clone());
        drop(consumed);
        remove_any(&self.transaction_dir(&journal.transaction_handle)).map_err(snapshot_error)?;
        sync_directory(&self.root)
    }

    fn load_all_journals(&self) -> Result<Vec<RepositoryTransactionJournalV2>, RpcError> {
        let mut values = Vec::new();
        let entries = match fs::read_dir(&self.root) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(values),
            Err(error) => return Err(snapshot_error(error)),
        };
        for entry in entries {
            let entry = entry.map_err(snapshot_error)?;
            if !entry.file_type().map_err(snapshot_error)?.is_dir() {
                continue;
            }
            let path = entry.path().join("journal.json");
            if !path.is_file() {
                continue;
            }
            values.push(read_journal(&path)?);
        }
        Ok(values)
    }

    fn recover_stale_journals(&self) -> Result<(), RpcError> {
        for journal in self.load_all_journals()? {
            if self.journal_owner_is_live(&journal) {
                continue;
            }
            self.restore_and_consume(&journal).map_err(|restore| {
                repository_state_uncertain(
                    RpcError::new(
                        "repository_recovery_failed",
                        "a dead broker left an interrupted repository transaction",
                    ),
                    restore,
                )
            })?;
        }
        Ok(())
    }

    fn journal_owner_is_live(&self, journal: &RepositoryTransactionJournalV2) -> bool {
        if !process_alive(journal.owner_pid) {
            return false;
        }
        let observed_identity = process_identity(journal.owner_pid);
        match (
            journal.owner_process_identity.as_deref(),
            observed_identity.as_deref(),
        ) {
            (Some(expected), Some(observed)) => expected == observed,
            // Legacy journals and platforms without a stable process birth identity
            // remain conservative: an existing PID may still own the transaction.
            _ => {
                journal.owner_pid != std::process::id()
                    || journal.owner_instance_id == self.instance_id
                    || journal.owner_process_identity.is_none()
            }
        }
    }

    fn has_active_binding(&self, session: &str, run: &str, root: &Path) -> Result<bool, RpcError> {
        Ok(self.load_all_journals()?.iter().any(|journal| {
            journal.session_id == session
                && journal.run_id == run
                && journal.repository_root == root
        }))
    }

    fn ensure_no_active_repository(&self, root: &Path) -> Result<(), RpcError> {
        if self
            .load_all_journals()?
            .iter()
            .any(|journal| journal.repository_root == root)
        {
            return Err(RpcError::new(
                "repository_transaction_pending",
                "repository already has a pending structured transaction",
            ));
        }
        Ok(())
    }
}

fn require_v2(version: u32) -> Result<(), RpcError> {
    if version == 2 {
        Ok(())
    } else {
        Err(atomicity_unavailable(
            "RepositoryTransactionLeaseV2 is required",
        ))
    }
}

fn validate_identity(value: &str, label: &str) -> Result<(), RpcError> {
    if value.is_empty() || value.len() > 512 || value.contains(['\0', '\r', '\n']) {
        return Err(invalid_transaction(format!("invalid {label}")));
    }
    Ok(())
}

fn valid_object_id(value: &str) -> bool {
    (40..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_expected_postconditions(
    expected: &RepositoryExpectedPostconditionsV3,
) -> Result<(), RpcError> {
    if expected.schema_version != 3 || !valid_object_id(&expected.selected_head) {
        return Err(invalid_transaction("invalid selectedHead postcondition"));
    }
    if let Some(reference) = expected.selected_symbolic_ref.as_deref() {
        if !reference.starts_with("refs/heads/")
            || reference.len() > 1024
            || reference.contains(['\0', '\r', '\n'])
        {
            return Err(invalid_transaction(
                "invalid selectedSymbolicRef postcondition",
            ));
        }
    }
    if expected.required_reachable_objects.is_empty()
        || expected.required_reachable_objects.len() > 64
        || expected
            .required_reachable_objects
            .iter()
            .any(|value| !valid_object_id(value))
    {
        return Err(invalid_transaction(
            "invalid requiredReachableObjects postcondition",
        ));
    }
    Ok(())
}

fn validate_capability(value: &str, label: &str) -> Result<(), RpcError> {
    if value.len() < 32
        || value.len() > 160
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(invalid_handle(format!("invalid {label}")));
    }
    Ok(())
}

fn random_capability(prefix: &str) -> Result<String, RpcError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| {
        RpcError::new(
            "repository_atomicity_unavailable",
            format!("OS randomness unavailable: {error}"),
        )
    })?;
    let mut value = String::with_capacity(prefix.len() + 1 + bytes.len() * 2);
    value.push_str(prefix);
    value.push('-');
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(value, "{byte:02x}");
    }
    Ok(value)
}

fn validate_operations(
    operations: &[RepositoryOperationV2],
    add_only: bool,
) -> Result<(), RpcError> {
    for operation in operations {
        if operation.args.is_empty() || operation.args.len() > 256 {
            return Err(invalid_transaction("operation has invalid argument count"));
        }
        let expected = operation_command(&operation.operation_class)?;
        if operation.args.first().map(String::as_str) != Some(expected) {
            return Err(invalid_transaction(
                "operation class does not match its Git command",
            ));
        }
        if add_only && operation.operation_class != "add" {
            return Err(invalid_transaction("continue accepts only add operations"));
        }
        if operation
            .args
            .iter()
            .any(|argument| argument.len() > 64 * 1024 || argument.contains(['\0', '\r', '\n']))
        {
            return Err(invalid_transaction(
                "operation contains an invalid argument",
            ));
        }
        validate_operation_grammar(operation)?;
    }
    Ok(())
}

fn validate_operation_grammar(operation: &RepositoryOperationV2) -> Result<(), RpcError> {
    let args = &operation.args;
    let valid = match operation.operation_class.as_str() {
        "add" => {
            args.len() >= 3 && args[1] == "--" && args[2..].iter().all(|value| safe_pathspec(value))
        }
        "restore" => valid_restore_args(args),
        "switch" => valid_switch_args(args),
        "commit" => {
            (args.len() == 4 && args[1] == "--no-verify" && args[2] == "-m")
                || (args.len() == 5
                    && args[1] == "--amend"
                    && args[2] == "--no-verify"
                    && args[3] == "-m")
        }
        "branch" => valid_branch_args(args),
        "tag" => valid_tag_args(args),
        "reset" => {
            args.len() == 3
                && matches!(args[1].as_str(), "--soft" | "--mixed" | "--hard")
                && safe_revision(&args[2])
        }
        "merge" => valid_merge_args(args),
        "rebase" => valid_rebase_args(args),
        "cherry_pick" => args.len() >= 2 && args[1..].iter().all(|value| safe_revision(value)),
        "revert" => {
            args.len() >= 3
                && args[1] == "--no-edit"
                && args[2..].iter().all(|value| safe_revision(value))
        }
        "update_ref" => valid_update_ref_args(args),
        "reflog_expire" => {
            args.len() >= 3
                && args.len() <= 4
                && args[1] == "expire"
                && args[2].strip_prefix("--expire=").is_some_and(safe_revision)
                && (args.len() == 3 || args[3] == "--all")
        }
        "gc" => {
            args.len() >= 2
                && args.len() <= 3
                && args[1].strip_prefix("--prune=").is_some_and(safe_revision)
                && (args.len() == 2 || args[2] == "--aggressive")
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(invalid_transaction(format!(
            "{} operation does not match the broker's exact argument grammar",
            operation.operation_class
        )))
    }
}

fn valid_restore_args(args: &[String]) -> bool {
    let mut index = 1;
    if let Some(source) = args
        .get(index)
        .and_then(|value| value.strip_prefix("--source="))
    {
        if !safe_revision(source) {
            return false;
        }
        index += 1;
    }
    let mut destination_selected = false;
    if args.get(index).is_some_and(|value| value == "--staged") {
        destination_selected = true;
        index += 1;
    }
    if args.get(index).is_some_and(|value| value == "--worktree") {
        destination_selected = true;
        index += 1;
    }
    destination_selected
        && args.get(index).is_some_and(|value| value == "--")
        && index + 1 < args.len()
        && args[index + 1..].iter().all(|value| safe_pathspec(value))
}

fn valid_switch_args(args: &[String]) -> bool {
    let mut index = 1;
    let detach = args.get(index).is_some_and(|value| value == "--detach");
    if detach {
        index += 1;
    }
    let create = args.get(index).is_some_and(|value| value == "-c");
    if create {
        if detach
            || !args
                .get(index + 1)
                .is_some_and(|value| safe_revision(value))
        {
            return false;
        }
        index += 2;
    }
    let target = args.get(index);
    if target.is_some_and(|value| !safe_revision(value)) {
        return false;
    }
    (create || target.is_some()) && index + usize::from(target.is_some()) == args.len()
}

fn valid_branch_args(args: &[String]) -> bool {
    match args {
        [_, flag, name] if matches!(flag.as_str(), "-d" | "-D") => safe_revision(name),
        [_, flag, name, new_name] if matches!(flag.as_str(), "-m" | "-M") => {
            safe_revision(name) && safe_revision(new_name)
        }
        [_, name] => safe_revision(name),
        [_, flag, name] if flag == "-f" => safe_revision(name),
        [_, name, start] => safe_revision(name) && safe_revision(start),
        [_, flag, name, start] if flag == "-f" => safe_revision(name) && safe_revision(start),
        _ => false,
    }
}

fn valid_tag_args(args: &[String]) -> bool {
    match args {
        [_, flag, name] if flag == "-d" => safe_revision(name),
        [_, flag, name] if flag == "-f" => safe_revision(name),
        [_, flag, name, target] if flag == "-f" => safe_revision(name) && safe_revision(target),
        [_, name] => safe_revision(name),
        [_, name, target] => safe_revision(name) && safe_revision(target),
        _ => false,
    }
}

fn valid_merge_args(args: &[String]) -> bool {
    (args.len() == 4
        && args[1] == "--no-edit"
        && args[2] == "--no-verify"
        && safe_revision(&args[3]))
        || (args.len() == 5
            && args[1] == "--no-edit"
            && args[2] == "--no-verify"
            && args[3] == "--no-commit"
            && safe_revision(&args[4]))
}

fn valid_rebase_args(args: &[String]) -> bool {
    match args {
        [_, upstream] => safe_revision(upstream),
        [_, upstream, branch] => safe_revision(upstream) && safe_revision(branch),
        [_, onto, onto_value, upstream] if onto == "--onto" => {
            safe_revision(onto_value) && safe_revision(upstream)
        }
        [_, onto, onto_value, upstream, branch] if onto == "--onto" => {
            safe_revision(onto_value) && safe_revision(upstream) && safe_revision(branch)
        }
        _ => false,
    }
}

fn valid_update_ref_args(args: &[String]) -> bool {
    match args {
        [_, flag, reference] if flag == "-d" => safe_ref(reference),
        [_, flag, reference, old] if flag == "-d" => safe_ref(reference) && safe_revision(old),
        [_, reference, new_value] => safe_ref(reference) && safe_revision(new_value),
        [_, reference, new_value, old_value] => {
            safe_ref(reference) && safe_revision(new_value) && safe_revision(old_value)
        }
        _ => false,
    }
}

fn safe_revision(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value.len() <= 64 * 1024
        && !value.contains(['\0', '\r', '\n'])
}

fn safe_ref(value: &str) -> bool {
    if value == "HEAD" {
        return true;
    }
    value.starts_with("refs/")
        && !value.ends_with(['/', '.'])
        && !value.ends_with(".lock")
        && !value.contains("..")
        && !value.contains("@{")
        && !value.contains("//")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
}

fn safe_pathspec(value: &str) -> bool {
    if value.is_empty()
        || value.starts_with(['/', '\\', ':'])
        || value.as_bytes().get(1) == Some(&b':')
    {
        return false;
    }
    value.split(['/', '\\']).all(|part| {
        !matches!(part, "" | "." | "..")
            && !part.eq_ignore_ascii_case(".git")
            && !part.eq_ignore_ascii_case(".agent")
    })
}

fn operation_command(class: &str) -> Result<&'static str, RpcError> {
    match class {
        "add" => Ok("add"),
        "restore" => Ok("restore"),
        "switch" => Ok("switch"),
        "commit" => Ok("commit"),
        "branch" => Ok("branch"),
        "tag" => Ok("tag"),
        "reset" => Ok("reset"),
        "merge" => Ok("merge"),
        "rebase" => Ok("rebase"),
        "cherry_pick" => Ok("cherry-pick"),
        "revert" => Ok("revert"),
        "update_ref" => Ok("update-ref"),
        "reflog_expire" => Ok("reflog"),
        "gc" => Ok("gc"),
        _ => Err(invalid_transaction("unsupported Git operation class")),
    }
}

fn can_pause_for_conflict(class: &str) -> bool {
    matches!(class, "merge" | "rebase" | "cherry_pick" | "revert")
}

fn continuation_args(class: &str) -> Result<Vec<String>, RpcError> {
    match class {
        "merge" => Ok(vec!["merge".into(), "--continue".into()]),
        "rebase" => Ok(vec!["rebase".into(), "--continue".into()]),
        "cherry_pick" => Ok(vec!["cherry-pick".into(), "--continue".into()]),
        "revert" => Ok(vec!["revert".into(), "--continue".into()]),
        _ => Err(invalid_transaction("operation cannot be continued")),
    }
}

fn abort_args(class: &str) -> Result<Vec<String>, RpcError> {
    match class {
        "merge" => Ok(vec!["merge".into(), "--abort".into()]),
        "rebase" => Ok(vec!["rebase".into(), "--abort".into()]),
        "cherry_pick" => Ok(vec!["cherry-pick".into(), "--abort".into()]),
        "revert" => Ok(vec!["revert".into(), "--abort".into()]),
        _ => Err(invalid_transaction("operation cannot be aborted")),
    }
}

fn transaction_result(
    status: &str,
    journal: &RepositoryTransactionJournalV2,
    output: Vec<String>,
    conflicts: usize,
) -> Value {
    let mut bounded = output
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if bounded.len() > 16 * 1024 * 1024 {
        bounded.truncate(16 * 1024 * 1024);
    }
    json!({
        "protocolVersion": 2,
        "status": status,
        "transactionHandle": journal.transaction_handle,
        "operation": journal.pending_operation.as_ref().map(|item| item.operation_class.as_str()),
        "conflictCount": conflicts,
        "output": bounded,
        "rollbackState": "journaled",
    })
}

fn sha256_bytes(value: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(value);
    format!("{:x}", digest.finalize())
}

fn checked_semantic_output(
    journal: &RepositoryTransactionJournalV2,
    args: &[&str],
    component: &str,
    missing_exit_one: bool,
) -> Result<Option<String>, RpcError> {
    let arguments = args
        .iter()
        .map(|value| (*value).to_owned())
        .collect::<Vec<_>>();
    let output = run_git_bounded(journal, &arguments, || false)?;
    if output.exit_code == 0 {
        return Ok(Some(output.stdout));
    }
    if missing_exit_one && output.exit_code == 1 {
        return Ok(None);
    }
    Err(RpcError::new(
        "repository_state_unavailable",
        format!(
            "repository {component} semantic assertion failed with exit code {}",
            output.exit_code
        ),
    ))
}

fn nul_entry_count(value: &str) -> usize {
    value.split('\0').filter(|entry| !entry.is_empty()).count()
}

fn conflict_path_count(value: &str) -> usize {
    value
        .split('\0')
        .filter_map(|entry| entry.split_once('\t').map(|(_, path)| path.to_owned()))
        .collect::<HashSet<_>>()
        .len()
}

fn target_assertions(
    journal: &RepositoryTransactionJournalV2,
    head: Option<&str>,
    symbolic_ref: Option<&str>,
) -> Result<Option<RepositoryTargetAssertionsV3>, RpcError> {
    let Some(expected) = journal.expected_postconditions.as_ref() else {
        return Ok(None);
    };
    if head != Some(expected.selected_head.as_str())
        || symbolic_ref != expected.selected_symbolic_ref.as_deref()
    {
        return Err(RpcError::new(
            "repository_postcondition_failed",
            "selected HEAD or symbolic ref did not match the V3 transaction expectation",
        ));
    }
    for object in &expected.required_reachable_objects {
        let output = run_git_bounded(
            journal,
            &[
                "merge-base".into(),
                "--is-ancestor".into(),
                object.clone(),
                expected.selected_head.clone(),
            ],
            || false,
        )?;
        if output.exit_code != 0 {
            return Err(RpcError::new(
                "repository_postcondition_failed",
                "a required selected object is not reachable from the selected HEAD",
            ));
        }
    }
    Ok(Some(RepositoryTargetAssertionsV3 {
        schema_version: 3,
        selected_head: expected.selected_head.clone(),
        selected_symbolic_ref: expected.selected_symbolic_ref.clone(),
        required_reachable_objects: expected.required_reachable_objects.clone(),
        satisfied: true,
    }))
}

fn repository_semantic_assertions(
    journal: &RepositoryTransactionJournalV2,
) -> Result<RepositorySemanticAssertionsV3, RpcError> {
    let head = checked_semantic_output(
        journal,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        "HEAD",
        true,
    )?
    .map(|value| value.trim().to_ascii_lowercase())
    .filter(|value| !value.is_empty());
    let symbolic_ref = checked_semantic_output(
        journal,
        &["symbolic-ref", "-q", "HEAD"],
        "symbolic ref",
        true,
    )?
    .map(|value| value.trim().to_owned())
    .filter(|value| !value.is_empty());
    let refs = checked_semantic_output(journal, &["show-ref", "--head"], "refs", true)?
        .unwrap_or_default();
    let reachability = checked_semantic_output(
        journal,
        &["rev-list", "--objects", "--all"],
        "reachability",
        false,
    )?
    .unwrap_or_default();
    let conflicts = checked_semantic_output(
        journal,
        &["ls-files", "--unmerged", "-z"],
        "conflicts",
        false,
    )?
    .unwrap_or_default();
    let tracked = checked_semantic_output(journal, &["ls-files", "-z"], "tracked files", false)?
        .unwrap_or_default();
    let untracked = checked_semantic_output(
        journal,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        "untracked files",
        false,
    )?
    .unwrap_or_default();
    let index = match fs::read(journal.git_dir.join("index")) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(snapshot_error(error)),
    };
    let target_assertions = target_assertions(journal, head.as_deref(), symbolic_ref.as_deref())?;
    Ok(RepositorySemanticAssertionsV3 {
        schema_version: 3,
        head,
        symbolic_ref,
        refs_digest: sha256_bytes(refs.as_bytes()),
        reachability_digest: sha256_bytes(reachability.as_bytes()),
        reachable_object_count: reachability.lines().filter(|line| !line.is_empty()).count(),
        index_digest: sha256_bytes(&index),
        conflicts_digest: sha256_bytes(conflicts.as_bytes()),
        conflict_count: conflict_path_count(&conflicts),
        tracked_digest: sha256_bytes(tracked.as_bytes()),
        tracked_count: nul_entry_count(&tracked),
        untracked_digest: sha256_bytes(untracked.as_bytes()),
        untracked_count: nul_entry_count(&untracked),
        target_assertions,
    })
}

fn empty_repository_assertions() -> RepositorySemanticAssertionsV3 {
    RepositorySemanticAssertionsV3 {
        schema_version: 3,
        head: None,
        symbolic_ref: None,
        refs_digest: String::new(),
        reachability_digest: String::new(),
        reachable_object_count: 0,
        index_digest: String::new(),
        conflicts_digest: String::new(),
        conflict_count: 0,
        tracked_digest: String::new(),
        tracked_count: 0,
        untracked_digest: String::new(),
        untracked_count: 0,
        target_assertions: None,
    }
}

fn run_baseline_journal(baseline: &RepositoryRunBaselineV1) -> RepositoryTransactionJournalV2 {
    RepositoryTransactionJournalV2 {
        journal_version: JOURNAL_VERSION,
        transaction_handle: baseline.baseline_id.clone(),
        owner_instance_id: baseline.owner_instance_id.clone(),
        owner_pid: baseline.owner_pid,
        owner_process_identity: baseline.owner_process_identity.clone(),
        session_id: baseline.session_id.clone(),
        run_id: baseline.run_id.clone(),
        repository_root: baseline.repository_root.clone(),
        git_dir: baseline.git_dir.clone(),
        common_dir: baseline.common_dir.clone(),
        directory_identities: Some(baseline.directory_identities.clone()),
        executable: baseline.executable.clone(),
        executable_sha256: baseline.executable_sha256.clone(),
        network: baseline.network.clone(),
        operations: Vec::new(),
        expected_postconditions: None,
        next_operation: 0,
        pending_operation: None,
        status: JournalStatus::CompletedPendingSeal,
        preimage_digest: baseline.preimage_digest.clone(),
        snapshot_worktree: baseline.snapshot_worktree,
        snapshot_separate_git_dir: baseline.snapshot_separate_git_dir,
    }
}

fn transaction_result_v3(
    status: &str,
    journal: &RepositoryTransactionJournalV2,
    output: Vec<String>,
    conflicts: usize,
    assertions: RepositorySemanticAssertionsV3,
) -> Value {
    let mut value = transaction_result(status, journal, output, conflicts);
    if let Some(record) = value.as_object_mut() {
        record.insert("protocolVersion".into(), json!(3));
        record.insert("semanticAssertions".into(), json!(assertions));
    }
    value
}

fn run_git_bounded(
    journal: &RepositoryTransactionJournalV2,
    args: &[String],
    cancelled: impl Fn() -> bool,
) -> Result<GitOutput, RpcError> {
    let cancelled = &cancelled as &dyn Fn() -> bool;
    let identity_fallbacks = if git_operation_may_create_commit(args) {
        repository_identity_fallbacks(journal, cancelled)?
    } else {
        Vec::new()
    };
    run_git_bounded_inner(journal, args, cancelled, &identity_fallbacks)
}

fn git_operation_may_create_commit(args: &[String]) -> bool {
    args.first().is_some_and(|command| {
        matches!(
            command.as_str(),
            "commit" | "merge" | "rebase" | "cherry-pick" | "revert"
        )
    })
}

fn repository_identity_fallbacks(
    journal: &RepositoryTransactionJournalV2,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<&'static str>, RpcError> {
    let mut fallbacks = Vec::new();
    for (key, fallback) in [
        ("user.name", BROKER_FALLBACK_USER_NAME),
        ("user.email", BROKER_FALLBACK_USER_EMAIL),
    ] {
        let output = run_git_bounded_inner(
            journal,
            &["config".into(), "--get".into(), key.into()],
            cancelled,
            &[],
        )?;
        match output.exit_code {
            0 if !output.stdout.trim().is_empty() => {}
            0 | 1 => fallbacks.push(fallback),
            _ => {
                return Err(RpcError::new(
                    "repository_state_unavailable",
                    format!("repository Git identity setting {key} could not be inspected"),
                ));
            }
        }
    }
    Ok(fallbacks)
}

fn run_git_bounded_inner(
    journal: &RepositoryTransactionJournalV2,
    args: &[String],
    cancelled: &dyn Fn() -> bool,
    config_overrides: &[&str],
) -> Result<GitOutput, RpcError> {
    repin_executable(&journal.executable, &journal.executable_sha256)?;
    validate_live_topology(journal)?;
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let mut command = Command::new(&journal.executable);
    command.current_dir(&journal.repository_root).args([
        "-c",
        &format!("core.hooksPath={null_device}"),
        "-c",
        "core.fsmonitor=false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "tag.gpgSign=false",
        "-c",
        "merge.gpgSign=false",
        "-c",
        "merge.verifySignatures=false",
        "-c",
        "rebase.gpgSign=false",
    ]);
    for value in config_overrides {
        command.args(["-c", value]);
    }
    command.arg(format!("--git-dir={}", journal.git_dir.display()));
    if journal.repository_root != journal.git_dir {
        command.arg(format!("--work-tree={}", journal.repository_root.display()));
    }
    command
        .args(args)
        .env_clear()
        .env("PATH", executable_parent_path(&journal.executable))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", null_device)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", ":")
        .env("GIT_SEQUENCE_EDITOR", ":")
        .stdin(Stdio::null());
    #[cfg(windows)]
    for key in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output_nonce = random_capability("git-output")?;
    let stdout_path = std::env::temp_dir().join(format!("{output_nonce}.stdout"));
    let stderr_path = std::env::temp_dir().join(format!("{output_nonce}.stderr"));
    let stdout = File::create(&stdout_path).map_err(snapshot_error)?;
    let stderr = File::create(&stderr_path).map_err(snapshot_error)?;
    command
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = unsafe { libc::getpid() };
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    libc::raise(libc::SIGKILL);
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().map_err(|error| {
        let _ = fs::remove_file(&stdout_path);
        let _ = fs::remove_file(&stderr_path);
        RpcError::new(
            "repository_operation_failed",
            format!("trusted Git launch failed: {error}"),
        )
    })?;
    let deadline = Instant::now() + Duration::from_secs(600);
    let status = loop {
        if cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&stdout_path);
            let _ = fs::remove_file(&stderr_path);
            return Err(RpcError::new(
                "cancelled",
                "repository transaction was cancelled and its preimage will be restored",
            ));
        }
        if let Some(status) = child.try_wait().map_err(RpcError::from)? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = fs::remove_file(&stdout_path);
            let _ = fs::remove_file(&stderr_path);
            return Err(RpcError::new(
                "repository_operation_timeout",
                "trusted Git exceeded its broker deadline and its preimage will be restored",
            ));
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = fs::read(&stdout_path).map_err(snapshot_error)?;
    let stderr = fs::read(&stderr_path).map_err(snapshot_error)?;
    let _ = fs::remove_file(stdout_path);
    let _ = fs::remove_file(stderr_path);
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        exit_code: status.code().unwrap_or(1),
    })
}

fn repin_executable(path: &Path, expected: &str) -> Result<(), RpcError> {
    let observed = pinned_executable_sha256(path).map_err(|error| {
        invalid_handle(format!(
            "trusted Git executable cannot be re-pinned: {}",
            error.message
        ))
    })?;
    if observed != expected {
        return Err(invalid_handle(
            "trusted Git executable changed after lease issuance",
        ));
    }
    Ok(())
}

fn reject_present_runtime_state(repository_root: &Path) -> Result<(), RpcError> {
    match fs::symlink_metadata(repository_root.join(".agent")) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(snapshot_error(error)),
        Ok(_) => Err(RpcError::new(
            "repository_runtime_state_protected",
            "structured Git transactions are unavailable while runtime-owned .agent state is present",
        )),
    }
}

fn repository_directory_identities(
    lease: &RepositoryTransactionLeaseV2,
) -> Result<RepositoryDirectoryIdentitiesV1, RpcError> {
    Ok(RepositoryDirectoryIdentitiesV1 {
        repository_root: directory_identity(&lease.repository_root)?,
        git_dir: directory_identity(&lease.git_dir)?,
        common_dir: directory_identity(&lease.common_dir)?,
    })
}

fn validate_lease_directory_identities(
    lease: &RepositoryTransactionLeaseV2,
    expected: &RepositoryDirectoryIdentitiesV1,
) -> Result<(), RpcError> {
    let observed = repository_directory_identities(lease)?;
    if &observed != expected {
        return Err(RpcError::new(
            "repository_state_uncertain",
            "repository directory identity changed while a transaction preimage was captured",
        ));
    }
    Ok(())
}

fn validate_live_topology(journal: &RepositoryTransactionJournalV2) -> Result<(), RpcError> {
    let root = canonical_directory(&journal.repository_root, "repository root")?;
    let git_dir = canonical_directory(&journal.git_dir, "Git directory")?;
    let common_dir = canonical_directory(&journal.common_dir, "Git common directory")?;
    if root != journal.repository_root
        || git_dir != journal.git_dir
        || common_dir != journal.common_dir
    {
        return Err(RpcError::new(
            "repository_state_uncertain",
            "repository topology changed while a transaction was pending",
        ));
    }
    validate_topology(&root, &git_dir, &common_dir)?;
    let expected = journal.directory_identities.as_ref().ok_or_else(|| {
        RpcError::new(
            "repository_state_uncertain",
            "repository transaction journal predates directory identity pinning",
        )
    })?;
    let observed = RepositoryDirectoryIdentitiesV1 {
        repository_root: directory_identity(&root)?,
        git_dir: directory_identity(&git_dir)?,
        common_dir: directory_identity(&common_dir)?,
    };
    if &observed != expected {
        return Err(RpcError::new(
            "repository_state_uncertain",
            "repository directory identity changed while a transaction was pending",
        ));
    }
    Ok(())
}

fn capture_preimage(
    lease: &RepositoryTransactionLeaseV2,
    transaction_dir: &Path,
    budget: &mut SnapshotBudget,
) -> Result<String, RpcError> {
    let staging = transaction_dir.join("preimage-staging");
    if lease.repository_root != lease.git_dir {
        copy_tree_filtered(
            &lease.repository_root,
            &staging.join("worktree"),
            budget,
            &[OsStr::new(".git")],
        )?;
    }
    copy_tree_filtered(&lease.common_dir, &staging.join("common"), budget, &[])?;
    if !lease.git_dir.starts_with(&lease.common_dir) {
        copy_tree_filtered(&lease.git_dir, &staging.join("git"), budget, &[])?;
    }
    sync_tree(&staging)?;
    let digest = tree_digest(&staging)?;
    let cas_root = transaction_dir.join("cas");
    fs::create_dir(&cas_root).map_err(snapshot_error)?;
    fs::rename(&staging, cas_root.join(&digest)).map_err(snapshot_error)?;
    sync_directory(&cas_root)?;
    Ok(digest)
}

fn restore_preimage(
    journal: &RepositoryTransactionJournalV2,
    transaction_dir: &Path,
) -> Result<(), RpcError> {
    let snapshot = transaction_dir.join("cas").join(&journal.preimage_digest);
    let observed_digest = tree_digest(&snapshot).map_err(|error| {
        RpcError::new(
            "repository_state_uncertain",
            format!(
                "repository transaction preimage CAS could not be verified: {}",
                error.message
            ),
        )
    })?;
    if observed_digest != journal.preimage_digest {
        return Err(RpcError::new(
            "repository_state_uncertain",
            "repository transaction preimage CAS digest does not match its journal",
        ));
    }
    // Recovery is destructive by design. Pin every target directory before
    // clearing a single byte so a renamed/reused repository path cannot make
    // an old journal overwrite unrelated data.
    validate_live_topology(journal)?;
    if journal.snapshot_worktree {
        clear_tree_filtered(&journal.repository_root, &[OsStr::new(".git")])?;
        copy_tree_filtered(
            &snapshot.join("worktree"),
            &journal.repository_root,
            &mut unlimited_budget(),
            &[],
        )?;
    }
    clear_tree_filtered(&journal.common_dir, &[])?;
    copy_tree_filtered(
        &snapshot.join("common"),
        &journal.common_dir,
        &mut unlimited_budget(),
        &[],
    )?;
    if journal.snapshot_separate_git_dir {
        clear_tree_filtered(&journal.git_dir, &[])?;
        copy_tree_filtered(
            &snapshot.join("git"),
            &journal.git_dir,
            &mut unlimited_budget(),
            &[],
        )?;
    }
    validate_live_topology(journal)
}

fn tree_digest(root: &Path) -> Result<String, RpcError> {
    let metadata = fs::symlink_metadata(root).map_err(snapshot_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(atomicity_unavailable(
            "repository transaction preimage CAS is not a directory",
        ));
    }
    let mut digest = Sha256::new();
    digest.update(b"sigma-repository-preimage-cas-v1\0");
    digest_tree_entries(root, Path::new(""), &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

fn digest_tree_entries(root: &Path, relative: &Path, digest: &mut Sha256) -> Result<(), RpcError> {
    let directory = root.join(relative);
    let mut entries = fs::read_dir(&directory)
        .map_err(snapshot_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(snapshot_error)?;
    entries.sort_by(|left, right| {
        left.file_name()
            .as_encoded_bytes()
            .cmp(right.file_name().as_encoded_bytes())
    });

    for entry in entries {
        let name = entry.file_name();
        let child_relative = relative.join(&name);
        let metadata = fs::symlink_metadata(entry.path()).map_err(snapshot_error)?;
        if metadata.file_type().is_symlink() {
            digest_record(
                digest,
                b"symlink",
                child_relative.as_os_str().as_encoded_bytes(),
            );
            digest_permissions(digest, &metadata);
            let target = fs::read_link(entry.path()).map_err(snapshot_error)?;
            digest_record(digest, b"target", target.as_os_str().as_encoded_bytes());
        } else if metadata.is_dir() {
            digest_record(
                digest,
                b"directory",
                child_relative.as_os_str().as_encoded_bytes(),
            );
            digest_permissions(digest, &metadata);
            digest_tree_entries(root, &child_relative, digest)?;
        } else if metadata.is_file() {
            digest_record(
                digest,
                b"file",
                child_relative.as_os_str().as_encoded_bytes(),
            );
            digest_permissions(digest, &metadata);
            digest.update(metadata.len().to_le_bytes());
            let mut source = File::open(entry.path()).map_err(snapshot_error)?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let count = source.read(&mut buffer).map_err(snapshot_error)?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
            }
        } else {
            return Err(atomicity_unavailable(
                "repository transaction preimage CAS contains an unsupported filesystem object",
            ));
        }
    }
    Ok(())
}

fn digest_record(digest: &mut Sha256, kind: &[u8], value: &[u8]) {
    digest.update((kind.len() as u64).to_le_bytes());
    digest.update(kind);
    digest.update((value.len() as u64).to_le_bytes());
    digest.update(value);
}

#[cfg(unix)]
fn digest_permissions(digest: &mut Sha256, metadata: &fs::Metadata) {
    use std::os::unix::fs::PermissionsExt;
    digest.update(metadata.permissions().mode().to_le_bytes());
}

#[cfg(not(unix))]
fn digest_permissions(digest: &mut Sha256, metadata: &fs::Metadata) {
    digest.update([u8::from(metadata.permissions().readonly())]);
}

fn sync_tree(root: &Path) -> Result<(), RpcError> {
    let metadata = fs::symlink_metadata(root).map_err(snapshot_error)?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_file() {
        File::open(root)
            .and_then(|file| file.sync_all())
            .map_err(snapshot_error)?;
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(atomicity_unavailable(
            "repository preimage contains an unsupported filesystem object",
        ));
    }
    for entry in fs::read_dir(root).map_err(snapshot_error)? {
        sync_tree(&entry.map_err(snapshot_error)?.path())?;
    }
    sync_directory(root)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), RpcError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(snapshot_error)
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), RpcError> {
    Ok(())
}

fn unlimited_budget() -> SnapshotBudget {
    SnapshotBudget {
        max_files: u64::MAX,
        max_bytes: u64::MAX,
        ..SnapshotBudget::default()
    }
}

fn copy_tree_filtered(
    source: &Path,
    destination: &Path,
    budget: &mut SnapshotBudget,
    excluded_names: &[&OsStr],
) -> Result<(), RpcError> {
    fs::create_dir_all(destination).map_err(snapshot_error)?;
    let source_metadata = fs::symlink_metadata(source).map_err(snapshot_error)?;
    fs::set_permissions(destination, source_metadata.permissions()).map_err(snapshot_error)?;
    for entry in fs::read_dir(source).map_err(snapshot_error)? {
        let entry = entry.map_err(snapshot_error)?;
        if excluded_names
            .iter()
            .any(|name| entry.file_name() == **name)
        {
            continue;
        }
        budget.files = budget.files.saturating_add(1);
        if budget.files > budget.max_files {
            return Err(snapshot_limit_error());
        }
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from).map_err(snapshot_error)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&from).map_err(snapshot_error)?;
            budget.bytes = budget
                .bytes
                .saturating_add(target.as_os_str().as_encoded_bytes().len() as u64);
            if budget.bytes > budget.max_bytes {
                return Err(snapshot_limit_error());
            }
            create_symlink(&target, &to, from.is_dir()).map_err(snapshot_error)?;
        } else if metadata.is_dir() {
            copy_tree_filtered(&from, &to, budget, &[])?;
        } else if metadata.is_file() {
            budget.bytes = budget.bytes.saturating_add(metadata.len());
            if budget.bytes > budget.max_bytes {
                return Err(snapshot_limit_error());
            }
            fs::copy(&from, &to).map_err(snapshot_error)?;
            fs::set_permissions(&to, metadata.permissions()).map_err(snapshot_error)?;
        } else {
            return Err(atomicity_unavailable(
                "repository contains an unsupported filesystem object",
            ));
        }
    }
    Ok(())
}

fn clear_tree_filtered(root: &Path, excluded_names: &[&OsStr]) -> Result<(), RpcError> {
    for entry in fs::read_dir(root).map_err(snapshot_error)? {
        let entry = entry.map_err(snapshot_error)?;
        if excluded_names
            .iter()
            .any(|name| entry.file_name() == **name)
        {
            continue;
        }
        remove_any(&entry.path()).map_err(snapshot_error)?;
    }
    Ok(())
}

fn remove_any(path: &Path) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        make_writable(path, &metadata)?;
        for entry in fs::read_dir(path)? {
            remove_any(&entry?.path())?;
        }
        fs::remove_dir(path)
    } else {
        make_writable(path, &metadata)?;
        fs::remove_file(path)
    }
}

#[allow(clippy::permissions_set_readonly_false)]
fn make_writable(path: &Path, metadata: &fs::Metadata) -> std::io::Result<()> {
    if metadata.permissions().readonly() {
        let mut permissions = metadata.permissions();
        permissions.set_readonly(false);
        fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

#[cfg(unix)]
fn create_symlink(target: &Path, destination: &Path, _directory: bool) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, destination)
}

#[cfg(windows)]
fn create_symlink(target: &Path, destination: &Path, directory: bool) -> std::io::Result<()> {
    if directory {
        std::os::windows::fs::symlink_dir(target, destination)
    } else {
        std::os::windows::fs::symlink_file(target, destination)
    }
}

#[cfg(not(any(unix, windows)))]
fn create_symlink(_target: &Path, _destination: &Path, _directory: bool) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks unsupported",
    ))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), RpcError> {
    let bytes = serde_json::to_vec(value).map_err(protocol_serialization_error)?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(snapshot_error)?;
    file.write_all(&bytes).map_err(snapshot_error)?;
    file.sync_all().map_err(snapshot_error)?;
    drop(file);
    atomic_replace(&temporary, path).map_err(snapshot_error)?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

fn write_journal(path: &Path, journal: &RepositoryTransactionJournalV2) -> Result<(), RpcError> {
    write_json_atomic(path, journal)
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn read_journal(path: &Path) -> Result<RepositoryTransactionJournalV2, RpcError> {
    let bytes = fs::read(path)
        .map_err(|_| invalid_handle("repository transaction handle is unknown or expired"))?;
    let journal: RepositoryTransactionJournalV2 =
        serde_json::from_slice(&bytes).map_err(|error| {
            RpcError::new(
                "repository_state_uncertain",
                format!("transaction journal is invalid: {error}"),
            )
        })?;
    if journal.journal_version != JOURNAL_VERSION {
        return Err(RpcError::new(
            "repository_state_uncertain",
            "transaction journal version is unsupported",
        ));
    }
    Ok(journal)
}

fn read_run_baseline(path: &Path) -> Result<RepositoryRunBaselineV1, RpcError> {
    let bytes = fs::read(path)
        .map_err(|_| invalid_handle("repository run baseline is unknown or expired"))?;
    let baseline: RepositoryRunBaselineV1 = serde_json::from_slice(&bytes).map_err(|error| {
        RpcError::new(
            "repository_state_uncertain",
            format!("repository run baseline manifest is invalid: {error}"),
        )
    })?;
    if baseline.baseline_version != RUN_BASELINE_VERSION {
        return Err(RpcError::new(
            "repository_state_uncertain",
            "repository run baseline version is unsupported",
        ));
    }
    Ok(baseline)
}

fn prepare_journal_root(root: &Path) -> Result<(), RpcError> {
    fs::create_dir_all(root).map_err(snapshot_error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(snapshot_error)?;
    }
    Ok(())
}

fn executable_parent_path(executable: &Path) -> String {
    executable
        .parent()
        .unwrap_or_else(|| Path::new("/"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Result<DirectoryIdentityV1, RpcError> {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).map_err(snapshot_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(RpcError::new(
            "repository_state_uncertain",
            "repository identity target is not a stable directory",
        ));
    }
    Ok(DirectoryIdentityV1 {
        platform: "unix_dev_inode".into(),
        volume: metadata.dev(),
        file: metadata.ino(),
    })
}

#[cfg(windows)]
fn directory_identity(path: &Path) -> Result<DirectoryIdentityV1, RpcError> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        GetFileInformationByHandle, OPEN_EXISTING,
    };
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(snapshot_error(std::io::Error::last_os_error()));
        }
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        let observed = GetFileInformationByHandle(handle, &mut information);
        CloseHandle(handle);
        if observed == 0 {
            return Err(snapshot_error(std::io::Error::last_os_error()));
        }
        if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(RpcError::new(
                "repository_state_uncertain",
                "repository identity target is not a stable directory",
            ));
        }
        Ok(DirectoryIdentityV1 {
            platform: "windows_volume_file_id".into(),
            volume: information.dwVolumeSerialNumber as u64,
            file: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
        })
    }
}

#[cfg(not(any(unix, windows)))]
fn directory_identity(_path: &Path) -> Result<DirectoryIdentityV1, RpcError> {
    Err(atomicity_unavailable(
        "repository directory identity pinning is unavailable on this platform",
    ))
}

#[cfg(target_os = "linux")]
fn process_identity(pid: u32) -> Option<String> {
    let stat = fs::read_to_string(Path::new("/proc").join(pid.to_string()).join("stat")).ok()?;
    let command_end = stat.rfind(')')?;
    let start_time = stat.get(command_end + 1..)?.split_whitespace().nth(19)?;
    if start_time.is_empty() || !start_time.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let boot_id = boot_id.trim();
    if boot_id.is_empty()
        || !boot_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return None;
    }
    Some(format!("linux:{boot_id}:{start_time}"))
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_identity(_pid: u32) -> Option<String> {
    None
}

#[cfg(windows)]
fn process_identity(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut exit_code = 0_u32;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let active =
            GetExitCodeProcess(process, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32;
        let observed = active
            && GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(process);
        observed.then(|| {
            let created = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
            format!("windows:{created:016x}")
        })
    }
}

#[cfg(not(any(unix, windows)))]
fn process_identity(_pid: u32) -> Option<String> {
    None
}

#[cfg(target_os = "linux")]
fn process_alive(pid: u32) -> bool {
    Path::new("/proc").join(pid.to_string()).exists()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn process_alive(pid: u32) -> bool {
    // Signal zero performs existence/permission checking without changing state.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut exit_code = 0_u32;
        let alive =
            GetExitCodeProcess(process, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32;
        CloseHandle(process);
        alive
    }
}

#[cfg(not(any(unix, windows)))]
fn process_alive(_pid: u32) -> bool {
    false
}

fn snapshot_limit_error() -> RpcError {
    RpcError::new(
        "repository_checkpoint_too_large",
        "repository transaction preimage exceeds broker snapshot limits",
    )
}

fn snapshot_error(error: std::io::Error) -> RpcError {
    RpcError::new(
        "repository_atomicity_unavailable",
        format!("repository preimage journal failed: {error}"),
    )
}

fn atomicity_unavailable(message: impl Into<String>) -> RpcError {
    RpcError::new("repository_atomicity_unavailable", message)
}

fn invalid_transaction(message: impl Into<String>) -> RpcError {
    RpcError::new("repository_transaction_invalid", message)
}

fn invalid_handle(message: impl Into<String>) -> RpcError {
    RpcError::new("repository_transaction_handle_invalid", message)
}

fn repository_state_uncertain(original: RpcError, restore: RpcError) -> RpcError {
    RpcError::new(
        "repository_state_uncertain",
        format!(
            "repository rollback failed after {}: {}; restore: {}",
            original.code, original.message, restore.message
        ),
    )
}

fn protocol_serialization_error(error: serde_json::Error) -> RpcError {
    RpcError::new("broker_protocol_error", error.to_string())
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new(
        "broker_state_poisoned",
        "repository transaction state is poisoned",
    )
}

#[cfg(test)]
#[path = "repository_transaction_tests.rs"]
mod tests;
