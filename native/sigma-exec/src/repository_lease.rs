use crate::protocol::RpcError;
use crate::sandbox::{NetworkMode, ProcessParams};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static LEASE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AcquireRepositoryMetadataLeaseParams {
    repository_root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    executable: String,
    network: NetworkMode,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryMetadataLeaseV1 {
    protocol_version: u32,
    lease_id: String,
    repository_root: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    executable: PathBuf,
    executable_sha256: String,
    network: NetworkMode,
    uses: u32,
}

#[derive(Clone)]
struct LeaseRecord {
    lease: RepositoryMetadataLeaseV1,
}

#[derive(Default)]
pub(crate) struct RepositoryMetadataLeases {
    values: Mutex<HashMap<String, LeaseRecord>>,
}

impl RepositoryMetadataLeases {
    pub(crate) fn acquire(
        &self,
        params: AcquireRepositoryMetadataLeaseParams,
    ) -> Result<RepositoryMetadataLeaseV1, RpcError> {
        if params.network != NetworkMode::None {
            return Err(RpcError::new(
                "policy_denied",
                "repository metadata leases are local-only",
            ));
        }
        let repository_root = canonical_directory(&params.repository_root, "repository root")?;
        let git_dir = canonical_directory(&params.git_dir, "Git directory")?;
        let common_dir = canonical_directory(&params.common_dir, "Git common directory")?;
        validate_topology(&repository_root, &git_dir, &common_dir)?;
        let executable = trusted_git_executable(&params.executable)?;
        self.issue(repository_root, git_dir, common_dir, executable)
    }

    fn issue(
        &self,
        repository_root: PathBuf,
        git_dir: PathBuf,
        common_dir: PathBuf,
        executable: PathBuf,
    ) -> Result<RepositoryMetadataLeaseV1, RpcError> {
        let executable_sha256 = pinned_executable_sha256(&executable)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let lease_id = format!(
            "repository-metadata-{}-{nonce}",
            LEASE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let lease = RepositoryMetadataLeaseV1 {
            protocol_version: 1,
            lease_id: lease_id.clone(),
            repository_root,
            git_dir,
            common_dir,
            executable,
            executable_sha256,
            network: NetworkMode::None,
            uses: 1,
        };
        self.values.lock().map_err(lock_error)?.insert(
            lease_id,
            LeaseRecord {
                lease: lease.clone(),
            },
        );
        Ok(lease)
    }

    #[cfg(test)]
    fn acquire_test_executable(
        &self,
        repository_root: &Path,
        git_dir: &Path,
        executable: &Path,
    ) -> Result<RepositoryMetadataLeaseV1, RpcError> {
        let repository_root = canonical_directory(repository_root, "repository root")?;
        let git_dir = canonical_directory(git_dir, "Git directory")?;
        validate_topology(&repository_root, &git_dir, &git_dir)?;
        let executable = executable.canonicalize().map_err(RpcError::from)?;
        self.issue(repository_root, git_dir.clone(), git_dir, executable)
    }

    /// Consume before validation or launch. A malformed request burns the
    /// capability, so an intercepted id can never be probed repeatedly.
    pub(crate) fn consume(&self, params: &mut ProcessParams) -> Result<(), RpcError> {
        // Never trust a wire-provided expansion. Only the consumed lease below
        // may repopulate this internal launcher field.
        params.policy.repository_metadata_roots.clear();
        let Some(lease_id) = params.policy.repository_metadata_lease_id.take() else {
            return Ok(());
        };
        let record = self
            .values
            .lock()
            .map_err(lock_error)?
            .remove(&lease_id)
            .ok_or_else(|| {
                RpcError::new(
                    "repository_metadata_lease_invalid",
                    "repository metadata lease is unknown, expired, or already used",
                )
            })?;
        let lease = record.lease;
        if params.policy.network != NetworkMode::None {
            return Err(RpcError::new(
                "repository_metadata_lease_invalid",
                "repository metadata lease cannot authorize network access",
            ));
        }
        let executable = resolve_command_executable(params)?;
        if executable != lease.executable {
            return Err(RpcError::new(
                "repository_metadata_lease_invalid",
                "repository metadata lease is bound to a different Git executable",
            ));
        }
        let executable_sha256 = pinned_executable_sha256(&executable).map_err(|error| {
            RpcError::new(
                "repository_metadata_lease_invalid",
                format!(
                    "trusted Git executable could not be re-pinned: {}",
                    error.message
                ),
            )
        })?;
        if executable_sha256 != lease.executable_sha256 {
            return Err(RpcError::new(
                "repository_metadata_lease_invalid",
                "trusted Git executable changed after its lease was issued",
            ));
        }
        // Both native launchers re-pin the exact executable object and verify
        // this digest immediately before exec/CreateProcess.
        params.policy.executable_sha256 = Some(lease.executable_sha256.clone());
        let cwd = params.command.cwd.canonicalize().map_err(RpcError::from)?;
        if cwd != lease.repository_root {
            return Err(RpcError::new(
                "repository_metadata_lease_invalid",
                "repository metadata lease is bound to a different repository root",
            ));
        }
        validate_git_invocation(params, &lease)?;
        let permitted = [
            lease.repository_root.as_path(),
            lease.git_dir.as_path(),
            lease.common_dir.as_path(),
        ];
        for root in &params.policy.write_roots {
            let canonical = root.canonicalize().map_err(RpcError::from)?;
            if !permitted
                .iter()
                .any(|allowed| canonical.starts_with(allowed))
            {
                return Err(RpcError::new(
                    "repository_metadata_lease_invalid",
                    "repository transaction requested a root outside its bound topology",
                ));
            }
        }
        for required in permitted {
            if !params.policy.read_roots.iter().any(|root| {
                root.canonicalize()
                    .is_ok_and(|canonical| required.starts_with(canonical))
            }) {
                return Err(RpcError::new(
                    "repository_metadata_lease_invalid",
                    "repository transaction did not declare its complete topology readable",
                ));
            }
        }
        params.policy.repository_metadata_roots = vec![lease.git_dir.clone()];
        if lease.common_dir != lease.git_dir {
            params
                .policy
                .repository_metadata_roots
                .push(lease.common_dir);
        }
        #[cfg(windows)]
        {
            // Git for Windows is an MSYS program and resolves its current
            // directory by enumerating every ancestor. A repository inside a
            // private user profile therefore cannot be its process cwd without
            // widening AppContainer access to unrelated siblings. The signed
            // one-use lease instead binds explicit --git-dir/--work-tree
            // arguments above; launch from the already-attested, read-only Git
            // runtime directory and derive that read capability in the broker.
            let runtime_root = lease.executable.parent().ok_or_else(|| {
                RpcError::new(
                    "repository_metadata_lease_invalid",
                    "trusted Git executable has no runtime directory",
                )
            })?;
            let runtime_root = canonical_directory(runtime_root, "Git runtime directory")?;
            params.command.cwd = runtime_root.clone();
            if !params.policy.read_roots.iter().any(|root| {
                root.canonicalize()
                    .is_ok_and(|root| runtime_root.starts_with(root))
            }) {
                params.policy.read_roots.push(runtime_root);
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn pinned_executable_sha256(path: &Path) -> Result<String, RpcError> {
    crate::linux_mount_source::PinnedMountSource::pin(path)?.sha256()
}

#[cfg(windows)]
fn pinned_executable_sha256(path: &Path) -> Result<String, RpcError> {
    crate::windows_sandbox::pinned_executable_sha256(path)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn pinned_executable_sha256(path: &Path) -> Result<String, RpcError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(RpcError::from)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(RpcError::from)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn topology_argument(args: &[String], name: &str) -> Result<Option<PathBuf>, RpcError> {
    let prefix = format!("{name}=");
    let values = args
        .iter()
        .filter_map(|argument| argument.strip_prefix(&prefix))
        .collect::<Vec<_>>();
    if values.len() > 1 || args.iter().any(|argument| argument == name) {
        return Err(RpcError::new(
            "repository_metadata_lease_invalid",
            format!("repository transaction has an ambiguous {name} argument"),
        ));
    }
    values
        .first()
        .map(|value| {
            let value = Path::new(value);
            if !value.is_absolute() {
                return Err(RpcError::new(
                    "repository_metadata_lease_invalid",
                    format!("repository transaction {name} must be absolute"),
                ));
            }
            value.canonicalize().map_err(|error| {
                RpcError::new(
                    "repository_metadata_lease_invalid",
                    format!("repository transaction {name} cannot be resolved: {error}"),
                )
            })
        })
        .transpose()
}

fn validate_git_invocation(
    params: &ProcessParams,
    lease: &RepositoryMetadataLeaseV1,
) -> Result<(), RpcError> {
    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let expected_prefix = [
        "-c".to_owned(),
        format!("core.hooksPath={null_device}"),
        "-c".to_owned(),
        "core.fsmonitor=false".to_owned(),
    ];
    if !params.command.args.starts_with(&expected_prefix) {
        return Err(RpcError::new(
            "repository_metadata_lease_invalid",
            "repository transaction did not disable hooks and filesystem monitors",
        ));
    }
    if params
        .command
        .args
        .iter()
        .enumerate()
        .any(|(index, argument)| {
            (argument == "-c" && index != 0 && index != 2)
                || argument == "-C"
                || argument == "--bare"
                || argument == "--namespace"
                || argument.starts_with("--namespace=")
                || argument == "--config-env"
                || argument.starts_with("--config-env=")
        })
    {
        return Err(RpcError::new(
            "repository_metadata_lease_invalid",
            "repository transaction contains a topology-changing Git option",
        ));
    }
    const TOPOLOGY_ENVIRONMENT: [&str; 9] = [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_INDEX_FILE",
        "GIT_NAMESPACE",
        "GIT_CEILING_DIRECTORIES",
        "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    ];
    if params.command.env.keys().any(|key| {
        TOPOLOGY_ENVIRONMENT
            .iter()
            .any(|forbidden| key.eq_ignore_ascii_case(forbidden))
    }) {
        return Err(RpcError::new(
            "repository_metadata_lease_invalid",
            "repository transaction environment can redirect Git topology",
        ));
    }
    if topology_argument(&params.command.args, "--git-dir")?.as_ref() != Some(&lease.git_dir) {
        return Err(RpcError::new(
            "repository_metadata_lease_invalid",
            "repository transaction Git directory does not match its lease",
        ));
    }
    let work_tree = topology_argument(&params.command.args, "--work-tree")?;
    if lease.repository_root == lease.git_dir {
        if work_tree.is_some() {
            return Err(RpcError::new(
                "repository_metadata_lease_invalid",
                "bare repository transaction cannot declare a worktree",
            ));
        }
    } else if work_tree.as_ref() != Some(&lease.repository_root) {
        return Err(RpcError::new(
            "repository_metadata_lease_invalid",
            "repository transaction worktree does not match its lease",
        ));
    }
    Ok(())
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new(
        "broker_state_poisoned",
        "repository metadata lease state is poisoned",
    )
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, RpcError> {
    if !path.is_absolute() {
        return Err(RpcError::new(
            "policy_denied",
            format!("{label} must be absolute"),
        ));
    }
    let canonical = path.canonicalize().map_err(|error| {
        RpcError::new(
            "policy_denied",
            format!("invalid {label} '{}': {error}", path.display()),
        )
    })?;
    if !canonical.is_dir() {
        return Err(RpcError::new(
            "policy_denied",
            format!("{label} must be a directory"),
        ));
    }
    Ok(canonical)
}

fn validate_topology(root: &Path, git_dir: &Path, common_dir: &Path) -> Result<(), RpcError> {
    let marker = root.join(".git");
    let observed_git = if root == git_dir {
        git_dir.to_owned()
    } else if marker.is_dir() {
        marker.canonicalize().map_err(RpcError::from)?
    } else {
        let value = std::fs::read_to_string(&marker).map_err(|error| {
            RpcError::new(
                "policy_denied",
                format!("cannot verify repository Git indirection: {error}"),
            )
        })?;
        let target = value
            .strip_prefix("gitdir:")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RpcError::new("policy_denied", "invalid repository Git indirection"))?;
        marker
            .parent()
            .unwrap_or(root)
            .join(target)
            .canonicalize()
            .map_err(RpcError::from)?
    };
    if observed_git != git_dir {
        return Err(RpcError::new(
            "policy_denied",
            "Git directory does not belong to repository root",
        ));
    }
    let commondir = git_dir.join("commondir");
    let observed_common = match std::fs::read_to_string(&commondir) {
        Ok(value) if !value.trim().is_empty() => git_dir
            .join(value.trim())
            .canonicalize()
            .map_err(RpcError::from)?,
        Ok(_) => git_dir.to_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => git_dir.to_owned(),
        Err(error) => {
            return Err(RpcError::new(
                "policy_denied",
                format!("cannot verify repository Git common-directory indirection: {error}"),
            ));
        }
    };
    if observed_common != common_dir {
        return Err(RpcError::new(
            "policy_denied",
            "Git common directory does not belong to Git directory",
        ));
    }
    Ok(())
}

fn trusted_git_executable(requested: &str) -> Result<PathBuf, RpcError> {
    let path = Path::new(requested);
    let candidates = if path.is_absolute() {
        vec![path.to_owned()]
    } else if !requested.contains('/') && !requested.contains('\\') {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|directory| directory.join(requested))
            .collect()
    } else {
        Vec::new()
    };
    for candidate in candidates {
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        let name = canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !name.eq_ignore_ascii_case("git") && !name.eq_ignore_ascii_case("git.exe") {
            continue;
        }
        let metadata = canonical.metadata().map_err(RpcError::from)?;
        if !metadata.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.uid() != 0 || metadata.permissions().mode() & 0o022 != 0 {
                continue;
            }
        }
        #[cfg(windows)]
        if !crate::windows_sandbox::existing_lpac_read_execute(&canonical)? {
            continue;
        }
        return Ok(canonical);
    }
    Err(RpcError::new(
        "executable_unavailable",
        "repository metadata lease requires a trusted system Git executable",
    ))
}

fn resolve_command_executable(params: &ProcessParams) -> Result<PathBuf, RpcError> {
    let requested = Path::new(&params.command.executable);
    let candidates = if requested.is_absolute() {
        vec![requested.to_owned()]
    } else if params.command.executable.contains('/') || params.command.executable.contains('\\') {
        vec![params.command.cwd.join(requested)]
    } else {
        let search = params
            .command
            .env
            .get("PATH")
            .map(String::as_str)
            .unwrap_or("");
        std::env::split_paths(search)
            .map(|directory| directory.join(requested))
            .collect()
    };
    candidates
        .into_iter()
        .find_map(|candidate| candidate.canonicalize().ok())
        .ok_or_else(|| {
            RpcError::new(
                "executable_unavailable",
                "cannot resolve leased Git executable",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::{CommandSpec, ExecutionPolicy, ProcessLifecycle, SandboxMode};
    use std::collections::BTreeMap;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn repository() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "sigma-repository-lease-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        root
    }

    #[test]
    fn rejects_unrelated_metadata_and_non_git_executable() {
        let root = repository();
        let unrelated = root.parent().unwrap().join(format!(
            "unrelated-{}",
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&unrelated).unwrap();
        let store = RepositoryMetadataLeases::default();
        let error = store
            .acquire(AcquireRepositoryMetadataLeaseParams {
                repository_root: root.clone(),
                git_dir: unrelated.clone(),
                common_dir: unrelated.clone(),
                executable: "not-git".into(),
                network: NetworkMode::None,
            })
            .unwrap_err();
        assert_eq!(error.code, "policy_denied");
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(unrelated).unwrap();
    }

    #[test]
    fn rejects_unreadable_common_directory_indirection() {
        let root = repository();
        let git_dir = root.join(".git").canonicalize().unwrap();
        std::fs::create_dir(git_dir.join("commondir")).unwrap();
        let store = RepositoryMetadataLeases::default();
        let error = store
            .acquire(AcquireRepositoryMetadataLeaseParams {
                repository_root: root.clone(),
                git_dir: git_dir.clone(),
                common_dir: git_dir,
                executable: "not-git".into(),
                network: NetworkMode::None,
            })
            .unwrap_err();
        assert_eq!(error.code, "policy_denied");
        assert!(error.message.contains("common-directory indirection"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn issued_capability_is_bound_local_and_consumed_once() {
        let Ok(executable) = trusted_git_executable("git") else {
            return;
        };
        let root = repository();
        let git_dir = root.join(".git").canonicalize().unwrap();
        let store = RepositoryMetadataLeases::default();
        let lease = store
            .acquire(AcquireRepositoryMetadataLeaseParams {
                repository_root: root.clone(),
                git_dir: git_dir.clone(),
                common_dir: git_dir.clone(),
                executable: executable.to_string_lossy().into_owned(),
                network: NetworkMode::None,
            })
            .unwrap();
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
        let trusted_runtime = root.parent().unwrap().join(format!(
            "trusted-runtime-{}",
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&trusted_runtime).unwrap();
        let params = ProcessParams {
            command: CommandSpec {
                executable: executable.to_string_lossy().into_owned(),
                args: vec![
                    "-c".into(),
                    format!(
                        "core.hooksPath={}",
                        if cfg!(windows) { "NUL" } else { "/dev/null" }
                    ),
                    "-c".into(),
                    "core.fsmonitor=false".into(),
                    format!("--git-dir={}", git_dir.display()),
                    format!("--work-tree={}", root.display()),
                    "status".into(),
                ],
                cwd: root.clone(),
                env,
                stdin: None,
            },
            policy: ExecutionPolicy {
                sandbox: SandboxMode::Required,
                network: NetworkMode::None,
                network_approved: false,
                read_roots: vec![root.clone(), git_dir.clone(), trusted_runtime.clone()],
                write_roots: vec![root.clone(), git_dir.clone()],
                execution_roots: Vec::new(),
                executable_sha256: None,
                protected_paths: vec![root.join(".agent")],
                disposable_workspace_root: None,
                read_only_validation_workspace_root: None,
                repository_metadata_lease_id: Some(lease.lease_id.clone()),
                scratch_lease_id: None,
                scratch_session_id: None,
                repository_metadata_roots: vec![root.parent().unwrap().to_owned()],
                session_scratch_roots: Vec::new(),
                disposable_workspace_authorized_root: None,
                #[cfg(test)]
                unsafe_host_exec_approved: false,
            },
            max_output_bytes: 1_024,
            timeout_ms: Some(1_000),
            idle_timeout_ms: None,
            lifecycle: ProcessLifecycle::Session,
            pty: false,
            pty_columns: 80,
            pty_rows: 24,
        };
        let mut first = params.clone();
        store.consume(&mut first).unwrap();
        assert_eq!(
            first.policy.executable_sha256.as_deref(),
            Some(lease.executable_sha256.as_str())
        );
        assert_eq!(
            first.policy.repository_metadata_roots,
            vec![git_dir.clone()]
        );
        #[cfg(windows)]
        assert_eq!(
            first.command.cwd,
            executable.parent().unwrap().canonicalize().unwrap()
        );
        let mut reuse = params.clone();
        let error = store.consume(&mut reuse).unwrap_err();
        assert_eq!(error.code, "repository_metadata_lease_invalid");

        let forged_lease = store
            .acquire(AcquireRepositoryMetadataLeaseParams {
                repository_root: root.clone(),
                git_dir: git_dir.clone(),
                common_dir: git_dir.clone(),
                executable: executable.to_string_lossy().into_owned(),
                network: NetworkMode::None,
            })
            .unwrap();
        let mut forged = params;
        forged.policy.repository_metadata_lease_id = Some(forged_lease.lease_id);
        forged.command.args[5] = format!("--work-tree={}", trusted_runtime.display());
        let error = store.consume(&mut forged).unwrap_err();
        assert_eq!(error.code, "repository_metadata_lease_invalid");
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(trusted_runtime).unwrap();
    }

    #[test]
    fn executable_replacement_after_acquire_is_rejected_and_burns_the_lease() {
        let root = repository();
        let git_dir = root.join(".git").canonicalize().unwrap();
        let executable = root.join(if cfg!(windows) { "git.exe" } else { "git" });
        std::fs::write(&executable, b"original trusted executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let store = RepositoryMetadataLeases::default();
        let lease = store
            .acquire_test_executable(&root, &git_dir, &executable)
            .unwrap();
        assert_eq!(lease.executable_sha256.len(), 64);

        let original = root.join("git.original");
        std::fs::rename(&executable, &original).unwrap();
        std::fs::write(&executable, b"replacement executable").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let params = ProcessParams {
            command: CommandSpec {
                executable: executable.to_string_lossy().into_owned(),
                args: Vec::new(),
                cwd: root.clone(),
                env: BTreeMap::new(),
                stdin: None,
            },
            policy: ExecutionPolicy {
                sandbox: SandboxMode::Required,
                network: NetworkMode::None,
                network_approved: false,
                read_roots: vec![root.clone()],
                write_roots: vec![root.clone()],
                execution_roots: Vec::new(),
                executable_sha256: None,
                protected_paths: vec![root.join(".agent")],
                disposable_workspace_root: None,
                read_only_validation_workspace_root: None,
                repository_metadata_lease_id: Some(lease.lease_id.clone()),
                scratch_lease_id: None,
                scratch_session_id: None,
                repository_metadata_roots: Vec::new(),
                session_scratch_roots: Vec::new(),
                disposable_workspace_authorized_root: None,
                unsafe_host_exec_approved: false,
            },
            max_output_bytes: 1_024,
            timeout_ms: Some(1_000),
            idle_timeout_ms: None,
            lifecycle: ProcessLifecycle::Session,
            pty: false,
            pty_columns: 80,
            pty_rows: 24,
        };
        let mut replaced = params.clone();
        let error = store.consume(&mut replaced).unwrap_err();
        assert_eq!(error.code, "repository_metadata_lease_invalid");
        assert!(error.message.contains("changed after its lease"));
        let mut reuse = params;
        let error = store.consume(&mut reuse).unwrap_err();
        assert_eq!(error.code, "repository_metadata_lease_invalid");
        assert!(error.message.contains("already used"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
