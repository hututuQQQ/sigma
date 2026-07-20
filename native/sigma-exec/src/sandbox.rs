#[cfg(target_os = "linux")]
use crate::linux_mount_source::{PinnedMountSource, ResolvedMountSource, inherit_mount_sources};
use crate::protocol::RpcError;
use crate::scratch::{DisposableWorkspace, ScratchLease};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
#[cfg(target_os = "linux")]
use std::ffi::OsString;
use std::fs::{create_dir, read_dir, read_to_string, remove_dir, remove_file, write};
#[cfg(target_os = "linux")]
use std::os::unix::fs::MetadataExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(any(target_os = "linux", test))]
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SandboxMode {
    Required,
    #[cfg(test)]
    Unsafe,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    None,
    Loopback,
    Full,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProcessLifecycle {
    #[default]
    Session,
    Deliverable,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: PathBuf,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing)]
    pub stdin: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPolicy {
    pub sandbox: SandboxMode,
    pub network: NetworkMode,
    #[serde(default)]
    pub network_approved: bool,
    #[serde(default)]
    pub read_roots: Vec<PathBuf>,
    #[serde(default)]
    pub write_roots: Vec<PathBuf>,
    #[serde(default)]
    pub execution_roots: Vec<PathBuf>,
    #[serde(default)]
    pub executable_sha256: Option<String>,
    #[serde(default)]
    pub protected_paths: Vec<PathBuf>,
    #[serde(default)]
    pub disposable_workspace_root: Option<PathBuf>,
    /** Explicit validation fallback for backends without same-path COW. The
     * workspace remains a normal read root and receives no write grant. */
    #[serde(default)]
    pub read_only_validation_workspace_root: Option<PathBuf>,
    #[serde(default)]
    pub repository_metadata_lease_id: Option<String>,
    /** Broker-issued RuntimeSession scratch capability. Both fields are
     * consumed before the launcher sees the request. */
    #[serde(default)]
    pub scratch_lease_id: Option<String>,
    #[serde(default)]
    pub scratch_session_id: Option<String>,
    /** Set only after BrokerState consumes an issued one-use lease. */
    #[serde(default)]
    pub repository_metadata_roots: Vec<PathBuf>,
    /** Broker-internal roots that are private scratch, never repository data. */
    #[serde(default)]
    pub session_scratch_roots: Vec<PathBuf>,
    /** Broker-internal authorization for a remapped disposable workspace. */
    #[serde(default)]
    pub disposable_workspace_authorized_root: Option<PathBuf>,
    #[cfg(test)]
    #[serde(default)]
    pub unsafe_host_exec_approved: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessParams {
    pub command: CommandSpec,
    pub policy: ExecutionPolicy,
    #[serde(default = "default_output_bytes")]
    pub max_output_bytes: usize,
    pub timeout_ms: Option<u64>,
    pub idle_timeout_ms: Option<u64>,
    #[serde(default)]
    pub lifecycle: ProcessLifecycle,
    #[serde(default)]
    pub pty: bool,
    #[serde(default = "default_pty_columns")]
    pub pty_columns: u16,
    #[serde(default = "default_pty_rows")]
    pub pty_rows: u16,
}

fn default_output_bytes() -> usize {
    1024 * 1024
}

fn default_pty_columns() -> u16 {
    120
}

fn default_pty_rows() -> u16 {
    30
}

#[derive(Clone, Debug)]
struct SandboxStatus {
    available: bool,
    backend: &'static str,
    self_test_passed: bool,
    setup_required: bool,
    reason: Option<String>,
    landlock_abi: Option<i32>,
    no_new_privileges: bool,
    seccomp_filter: bool,
    less_privileged_appcontainer: bool,
    mount_namespace: bool,
    pid_namespace: bool,
    network_namespace: bool,
}

static STATUS: OnceLock<Mutex<Option<SandboxStatus>>> = OnceLock::new();
#[cfg(target_os = "linux")]
static VERIFIED_BASH: OnceLock<Option<PathBuf>> = OnceLock::new();
#[cfg(target_os = "linux")]
const INTERNAL_HELPER_MOUNT: &str = "/tmp/.sigma-exec";
static PROTECTED_GUARD_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const PROTECTED_GUARD_MARKER: &str = ".sigma-exec-protected";

fn sandbox_status() -> SandboxStatus {
    let cache = STATUS.get_or_init(|| Mutex::new(None));
    let mut value = cache.lock().unwrap_or_else(|error| error.into_inner());
    value.get_or_insert_with(detect_sandbox).clone()
}

fn replace_status(status: SandboxStatus) {
    let cache = STATUS.get_or_init(|| Mutex::new(None));
    *cache.lock().unwrap_or_else(|error| error.into_inner()) = Some(status);
}

pub fn setup_sandbox() -> Result<Value, RpcError> {
    #[cfg(windows)]
    crate::windows_sandbox::setup()?;
    #[cfg(not(windows))]
    {
        let current = detect_sandbox();
        if !current.available {
            return Err(RpcError::new(
                "sandbox_unavailable",
                current
                    .reason
                    .unwrap_or_else(|| "sandbox setup failed".into()),
            ));
        }
    }
    let status = detect_sandbox();
    replace_status(status.clone());
    if !status.available || !status.self_test_passed {
        return Err(RpcError::new(
            "sandbox_unavailable",
            status
                .reason
                .unwrap_or_else(|| "sandbox self-test failed".into()),
        ));
    }
    Ok(doctor_report())
}

pub fn repair_sandbox() -> Result<Value, RpcError> {
    #[cfg(windows)]
    crate::windows_sandbox::recover_after_process_quiesced()?;
    #[cfg(not(windows))]
    {
        let current = detect_sandbox();
        if !current.available {
            return Err(RpcError::new(
                "sandbox_recovery_required",
                current
                    .reason
                    .unwrap_or_else(|| "sandbox recovery is unavailable".into()),
            ));
        }
    }
    replace_status(detect_sandbox());
    Ok(doctor_report())
}

pub fn sandbox_lease_status(workspace: &Path) -> Result<Value, RpcError> {
    #[cfg(windows)]
    {
        crate::windows_sandbox::workspace_lease_status(workspace)
    }
    #[cfg(not(windows))]
    {
        let _ = workspace;
        Err(RpcError::new(
            "filesystem_acl_unsupported",
            "workspace ACL leases are available only on Windows",
        ))
    }
}

pub fn revoke_sandbox(workspace: &Path) -> Result<Value, RpcError> {
    #[cfg(windows)]
    {
        crate::windows_sandbox::revoke_workspace_lease(workspace)
    }
    #[cfg(not(windows))]
    {
        let _ = workspace;
        Err(RpcError::new(
            "filesystem_acl_unsupported",
            "workspace ACL leases are available only on Windows",
        ))
    }
}

pub fn doctor_report() -> Value {
    let status = sandbox_status();
    let network_modes = if status.available && cfg!(target_os = "linux") {
        json!(["none", "loopback", "full"])
    } else if status.available {
        json!(["none", "full"])
    } else {
        json!([])
    };
    let shells = verified_shells(&status);
    let executable_paths = executable_search_path_snapshot();
    let runtime_commands = runtime_command_snapshot(&executable_paths);
    json!({
        "protocolVersion": crate::protocol::PROTOCOL_VERSION,
        "brokerVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "sandbox": {
            "available": status.available,
            "backend": status.backend,
            "selfTestPassed": status.self_test_passed,
            "setupRequired": status.setup_required,
            "reason": status.reason,
            "lease": if cfg!(windows) { json!({
                "protocolVersion": 1,
                "readStrategy": "persistent_workspace_root",
                "writerStrategy": "root_lease_checkpointed",
                "recoveryJournal": "writes_only",
            }) } else { Value::Null },
            "hardening": {
                "landlockAbi": status.landlock_abi,
                "noNewPrivileges": status.no_new_privileges,
                "seccompFilter": status.seccomp_filter,
                "lessPrivilegedAppContainer": status.less_privileged_appcontainer,
                "mountNamespace": status.mount_namespace,
                "pidNamespace": status.pid_namespace,
                "networkNamespace": status.network_namespace,
            },
        },
        // This helper instance is the native sandbox broker. A product may
        // launch a separate sigma-exec-derived OCI broker, but container mode
        // must never reinterpret this native process boundary as OCI.
        "container": {
            "available": false,
            "backend": "oci",
            "reason": "native sigma-exec instance; a trusted OCI launcher and attested target are required",
        },
        "capabilities": {
            "foreground": true,
            "background": true,
            "stdin": true,
            "pty": cfg!(any(target_os = "linux", target_os = "windows")) && status.available,
            "processHandoff": cfg!(target_os = "linux") && status.available && status.self_test_passed,
            "networkModes": network_modes,
            "executionRoots": true,
            "shells": shells,
            "runtimeCommands": runtime_commands.commands,
            "runtimeCommandSnapshotComplete": runtime_commands.complete,
            // OCI clients must resolve bare names against the attested target,
            // never against the control process that transports this report.
            "executableSearchPaths": executable_paths.serialized,
        }
    })
}

const MAX_EXECUTABLE_SEARCH_PATHS: usize = 128;
// This is a generic, closed probe used by repository validation capability
// discovery. It intentionally contains no task, package, or benchmark identity.
const RUNTIME_COMMAND_PROBE: &[&str] = &[
    "bun", "cargo", "deno", "dotnet", "git", "go", "gradle", "gradlew", "java", "javac", "kotlinc",
    "mvn", "mvnw", "node", "npm", "pnpm", "py", "pytest", "python", "python3", "rustc", "tsc",
    "yarn",
];

struct ExecutableSearchPathSnapshot {
    paths: Vec<PathBuf>,
    serialized: Vec<String>,
    complete: bool,
}

struct RuntimeCommandSnapshot {
    commands: Vec<String>,
    complete: bool,
}

fn executable_search_path_snapshot() -> ExecutableSearchPathSnapshot {
    let Some(value) = std::env::var_os("PATH") else {
        return ExecutableSearchPathSnapshot {
            paths: Vec::new(),
            serialized: Vec::new(),
            complete: false,
        };
    };
    let mut paths = Vec::new();
    let mut serialized = Vec::new();
    let mut complete = true;
    for (index, entry) in std::env::split_paths(&value).enumerate() {
        if index >= MAX_EXECUTABLE_SEARCH_PATHS {
            complete = false;
            break;
        }
        let Some(text) = entry.to_str().map(str::to_owned) else {
            complete = false;
            continue;
        };
        if !entry.is_absolute() {
            complete = false;
            continue;
        }
        if paths.contains(&entry) {
            continue;
        }
        paths.push(entry);
        serialized.push(text);
    }
    ExecutableSearchPathSnapshot {
        paths,
        serialized,
        complete,
    }
}

fn runtime_command_snapshot(paths: &ExecutableSearchPathSnapshot) -> RuntimeCommandSnapshot {
    let mut commands = Vec::new();
    let mut complete = paths.complete;
    for command in RUNTIME_COMMAND_PROBE {
        let (present, inspected) = command_on_search_path(command, &paths.paths);
        complete &= inspected;
        if present {
            commands.push((*command).to_owned());
        }
    }
    RuntimeCommandSnapshot { commands, complete }
}

fn command_on_search_path(command: &str, paths: &[PathBuf]) -> (bool, bool) {
    let mut present = false;
    let mut complete = true;
    for directory in paths {
        for candidate in command_candidates(directory, command) {
            match std::fs::metadata(candidate) {
                Ok(metadata) => present |= executable_metadata(&metadata),
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                    ) => {}
                Err(_) => complete = false,
            }
        }
    }
    (present, complete)
}

#[cfg(windows)]
fn command_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    ["", ".exe", ".com", ".bat", ".cmd"]
        .into_iter()
        .map(|suffix| directory.join(format!("{command}{suffix}")))
        .collect()
}

#[cfg(not(windows))]
fn command_candidates(directory: &Path, command: &str) -> Vec<PathBuf> {
    vec![directory.join(command)]
}

#[cfg(unix)]
fn executable_metadata(metadata: &std::fs::Metadata) -> bool {
    metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
}

#[cfg(windows)]
fn executable_metadata(metadata: &std::fs::Metadata) -> bool {
    metadata.is_file()
}

fn verified_shells(status: &SandboxStatus) -> Value {
    if !status.available || !status.self_test_passed {
        return json!([]);
    }
    #[cfg(windows)]
    {
        let executable = crate::windows_sandbox::verified_cmd_executable();
        executable.map_or_else(
            || json!([]),
            |path| {
                json!([{
                    "kind": "cmd",
                    "executable": path,
                    "verified": true,
                    // AppContainer cmd can execute built-ins, but Windows can
                    // still deny its descendant CreateProcess call. Do not
                    // advertise it as a general-purpose shell until that
                    // boundary has its own passing self-test.
                    "supportsChildProcesses": false,
                }])
            },
        )
    }
    #[cfg(target_os = "linux")]
    {
        linux_verified_bash().map_or_else(
            || json!([]),
            |path| {
                json!([{
                    "kind": "bash",
                    "executable": path,
                    "verified": true,
                    "supportsChildProcesses": true,
                }])
            },
        )
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    json!([])
}

#[cfg(target_os = "linux")]
fn linux_verified_bash() -> Option<PathBuf> {
    VERIFIED_BASH
        .get_or_init(|| {
            let bash = PathBuf::from("/bin/bash").canonicalize().ok()?;
            let sequence = PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "sigma-bash-self-test-{}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir(&root).ok()?;
            let marker = "sigma-bash-sandbox-ok";
            let params = ProcessParams {
                command: CommandSpec {
                    executable: bash.to_string_lossy().into_owned(),
                    args: vec![
                        "--noprofile".into(),
                        "--norc".into(),
                        "-c".into(),
                        format!("printf {marker}"),
                    ],
                    cwd: root.clone(),
                    env: BTreeMap::new(),
                    stdin: None,
                },
                policy: ExecutionPolicy {
                    sandbox: SandboxMode::Required,
                    network: NetworkMode::None,
                    network_approved: false,
                    read_roots: vec![root.clone()],
                    write_roots: Vec::new(),
                    execution_roots: Vec::new(),
                    executable_sha256: None,
                    protected_paths: Vec::new(),
                    disposable_workspace_root: None,
                    read_only_validation_workspace_root: None,
                    repository_metadata_lease_id: None,
                    scratch_lease_id: None,
                    scratch_session_id: None,
                    repository_metadata_roots: Vec::new(),
                    session_scratch_roots: Vec::new(),
                    disposable_workspace_authorized_root: None,
                    #[cfg(test)]
                    unsafe_host_exec_approved: false,
                },
                max_output_bytes: 4 * 1024,
                timeout_ms: Some(5_000),
                idle_timeout_ms: None,
                lifecycle: ProcessLifecycle::Session,
                pty: false,
                pty_columns: 80,
                pty_rows: 24,
            };
            let result = build_sandboxed_command(&params, None, None)
                .and_then(|mut prepared| prepared.command.output().map_err(RpcError::from))
                .ok();
            let _ = std::fs::remove_dir_all(&root);
            let output = result?;
            (output.status.success() && output.stdout == marker.as_bytes()).then_some(bash)
        })
        .clone()
}

pub struct PreparedCommand {
    pub command: Command,
    pub bootstrap_stdin: Vec<u8>,
    pub protected_path_guards: Vec<ProtectedPathGuard>,
    /** Broker-held nonce shared only with the trusted internal sandbox launcher. */
    pub launch_failure_nonce: Option<String>,
    /** Owns and removes a writable validation mirror after the process exits. */
    pub disposable_workspace: Option<DisposableWorkspace>,
    /** Keeps O_PATH mount sources alive until bwrap has inherited them. */
    #[cfg(target_os = "linux")]
    _mount_source_descriptors: Vec<std::fs::File>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct AuthorizedLinuxExecutable {
    source: PinnedMountSource,
    invocation_arg0: OsString,
}

pub(crate) struct ProtectedPathGuard {
    path: PathBuf,
    marker: PathBuf,
    token: String,
}

impl Drop for ProtectedPathGuard {
    fn drop(&mut self) {
        let marker_matches = read_to_string(&self.marker)
            .map(|value| value == self.token)
            .unwrap_or(false);
        let only_marker = read_dir(&self.path)
            .ok()
            .and_then(|mut entries| {
                let first = entries.next()?.ok()?;
                let no_more = entries.next().is_none();
                Some(no_more && first.file_name() == PROTECTED_GUARD_MARKER)
            })
            .unwrap_or(false);
        if marker_matches && only_marker {
            let _ = remove_file(&self.marker);
            let _ = remove_dir(&self.path);
        }
    }
}

pub fn build_command(
    params: &ProcessParams,
    allow_unsafe: bool,
    scratch: Option<&ScratchLease>,
) -> Result<PreparedCommand, RpcError> {
    validate(params, allow_unsafe)?;
    #[cfg(not(target_os = "linux"))]
    if params.policy.disposable_workspace_root.is_some() {
        return Err(RpcError::new(
            "validation_disposable_workspace_unavailable",
            "this sandbox backend cannot provide a same-path disposable validation workspace",
        ));
    }
    let disposable_workspace = match (&params.policy.disposable_workspace_root, scratch) {
        (Some(root), Some(lease)) => Some(lease.disposable_workspace(root)?),
        (Some(_), None) => {
            return Err(RpcError::new(
                "validation_disposable_workspace_unavailable",
                "validation workspace isolation requires broker session scratch",
            ));
        }
        (None, _) => None,
    };
    let effective_params = params;
    let guards = match params.policy.sandbox {
        SandboxMode::Required => create_missing_protected_guards(effective_params)?,
        #[cfg(test)]
        SandboxMode::Unsafe => Vec::new(),
    };
    let mut prepared = match params.policy.sandbox {
        SandboxMode::Required => {
            build_sandboxed_command(effective_params, scratch, disposable_workspace.as_ref())
        }
        #[cfg(test)]
        SandboxMode::Unsafe => build_host_command(effective_params),
    }?;
    prepared.protected_path_guards = guards;
    prepared.disposable_workspace = disposable_workspace;
    Ok(prepared)
}

fn validate(params: &ProcessParams, _allow_unsafe: bool) -> Result<(), RpcError> {
    if params.command.executable.is_empty()
        || params.command.executable.contains('\0')
        || params
            .command
            .args
            .iter()
            .any(|argument| argument.contains('\0'))
    {
        return Err(RpcError::new(
            "policy_denied",
            "command must be non-empty and arguments must be NUL-free",
        ));
    }
    if !params.command.cwd.is_absolute() {
        return Err(RpcError::new(
            "policy_denied",
            "command cwd must be absolute",
        ));
    }
    if params.max_output_bytes == 0 || params.max_output_bytes > 64 * 1024 * 1024 {
        return Err(RpcError::new(
            "policy_denied",
            "maxOutputBytes must be between 1 and 67108864",
        ));
    }
    if params.timeout_ms == Some(0) || params.idle_timeout_ms == Some(0) {
        return Err(RpcError::new(
            "policy_denied",
            "process timeouts must be positive",
        ));
    }
    if params.pty && (params.pty_columns == 0 || params.pty_rows == 0) {
        return Err(RpcError::new(
            "policy_denied",
            "PTY dimensions must be positive",
        ));
    }
    if params.lifecycle == ProcessLifecycle::Deliverable
        && (params.pty
            || params.command.stdin.is_some()
            || params.policy.sandbox != SandboxMode::Required)
    {
        return Err(RpcError::new(
            "policy_denied",
            "deliverable processes require the native sandbox and detached stdio",
        ));
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    if params.pty {
        return Err(RpcError::new(
            "pty_unavailable",
            "PTY is unavailable on this broker platform",
        ));
    }
    if params.policy.network == NetworkMode::Full && !params.policy.network_approved {
        return Err(RpcError::new(
            "policy_denied",
            "full network requires per-call approval",
        ));
    }
    if params
        .policy
        .executable_sha256
        .as_ref()
        .is_some_and(|digest| {
            digest.len() != 64
                || !digest
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
    {
        return Err(RpcError::new(
            "policy_denied",
            "executableSha256 must be a lowercase SHA-256 digest",
        ));
    }
    #[cfg(test)]
    if params.policy.sandbox == SandboxMode::Unsafe
        && (!_allow_unsafe || !params.policy.unsafe_host_exec_approved)
    {
        return Err(RpcError::new(
            "policy_denied",
            "unsafe execution requires launch and per-call approval",
        ));
    }
    if params.policy.sandbox == SandboxMode::Required {
        let status = sandbox_status();
        if !status.available || !status.self_test_passed {
            return Err(RpcError::new(
                "sandbox_unavailable",
                status
                    .reason
                    .clone()
                    .unwrap_or_else(|| "sandbox unavailable".into()),
            ));
        }
        validate_roots(params)?;
    }
    if params
        .policy
        .protected_paths
        .iter()
        .any(|path| !path.is_absolute())
    {
        return Err(RpcError::new(
            "policy_denied",
            "protected paths must be absolute",
        ));
    }
    for (key, value) in &params.command.env {
        if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
            return Err(RpcError::new(
                "policy_denied",
                "malformed environment entry",
            ));
        }
        if secret_key(key) {
            return Err(RpcError::new(
                "policy_denied",
                format!("secret-like environment key '{key}' is forbidden"),
            ));
        }
    }
    Ok(())
}

fn validate_roots(params: &ProcessParams) -> Result<(), RpcError> {
    let roots = params
        .policy
        .read_roots
        .iter()
        .chain(params.policy.write_roots.iter());
    let cwd = params
        .command
        .cwd
        .canonicalize()
        .map_err(|error| RpcError::new("policy_denied", format!("invalid cwd: {error}")))?;
    let mut contained = false;
    for root in roots {
        if !root.is_absolute() {
            return Err(RpcError::new(
                "policy_denied",
                "sandbox roots must be absolute",
            ));
        }
        let canonical = canonicalize_sandbox_root(root)?;
        contained |= cwd.starts_with(canonical);
    }
    if !contained {
        return Err(RpcError::new(
            "policy_denied",
            "cwd is outside declared sandbox roots",
        ));
    }
    let read_roots = canonical_roots(&params.policy.read_roots)?;
    let write_roots = canonical_roots(&params.policy.write_roots)?;
    let execution_roots = canonical_roots(&params.policy.execution_roots)?;
    if params.policy.disposable_workspace_root.is_some()
        && params.policy.read_only_validation_workspace_root.is_some()
    {
        return Err(RpcError::new(
            "policy_denied",
            "validation cannot request both same-path COW and read-only fallback",
        ));
    }
    if let Some(disposable) = params
        .policy
        .disposable_workspace_root
        .as_ref()
        .or(params.policy.read_only_validation_workspace_root.as_ref())
    {
        let canonical = canonicalize_sandbox_root(disposable)?;
        let scratch_roots = canonical_roots(&params.policy.session_scratch_roots)?;
        if write_roots.iter().any(|root| {
            !scratch_roots
                .iter()
                .any(|scratch| root.starts_with(scratch))
        }) {
            return Err(RpcError::new(
                "policy_denied",
                "isolated validation cannot declare durable write roots",
            ));
        }
        if params.policy.repository_metadata_lease_id.is_some()
            || !params.policy.repository_metadata_roots.is_empty()
        {
            return Err(RpcError::new(
                "policy_denied",
                "repository metadata leases cannot be combined with isolated validation",
            ));
        }
        if !read_roots.iter().any(|root| canonical.starts_with(root)) {
            return Err(RpcError::new(
                "policy_denied",
                "validation workspace must be contained by a declared read root",
            ));
        }
        if write_roots
            .iter()
            .any(|root| canonical.starts_with(root) || root.starts_with(&canonical))
        {
            return Err(RpcError::new(
                "policy_denied",
                "validation workspace cannot overlap durable write roots",
            ));
        }
    }
    for write_root in &write_roots {
        if !read_roots.iter().any(|root| write_root.starts_with(root)) {
            return Err(RpcError::new(
                "policy_denied",
                "write roots must be contained by a declared read root",
            ));
        }
        let name = write_root
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if (name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case(".agent"))
            && !metadata_path_authorized(write_root, &params.policy.repository_metadata_roots)
        {
            return Err(RpcError::new(
                "policy_denied",
                "metadata directories cannot be writable roots",
            ));
        }
    }
    for execution_root in &execution_roots {
        if write_roots.iter().any(|write_root| {
            write_root.starts_with(execution_root) || execution_root.starts_with(write_root)
        }) {
            return Err(RpcError::new(
                "policy_denied",
                "execution roots must not overlap writable roots",
            ));
        }
    }
    let all_roots = params
        .policy
        .read_roots
        .iter()
        .chain(params.policy.write_roots.iter())
        .map(|root| canonicalize_sandbox_root(root))
        .collect::<Result<Vec<_>, _>>()?;
    let mut protected_paths = params.policy.protected_paths.clone();
    protected_paths.extend(
        minimal_roots(&read_roots)
            .into_iter()
            .flat_map(|root| [root.join(".git"), root.join(".agent")]),
    );
    for protected in &protected_paths {
        if !protected.is_absolute() {
            return Err(RpcError::new(
                "policy_denied",
                "protected paths must be absolute",
            ));
        }
        let canonical = canonicalize_allow_missing(protected)?;
        if !all_roots.iter().any(|root| canonical.starts_with(root)) {
            return Err(RpcError::new(
                "policy_denied",
                "protected path resolves outside declared roots",
            ));
        }
        if protected.exists() {
            let metadata = std::fs::symlink_metadata(protected).map_err(RpcError::from)?;
            if metadata.file_type().is_symlink() {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "protected path '{}' cannot be a symbolic link or junction",
                        protected.display()
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn protected_path_candidates(params: &ProcessParams) -> Result<Vec<PathBuf>, RpcError> {
    let read_roots = canonical_roots(&params.policy.read_roots)?;
    let mut candidates = params.policy.protected_paths.clone();
    candidates.extend(
        minimal_roots(&read_roots)
            .into_iter()
            .flat_map(|root| [root.join(".git"), root.join(".agent")]),
    );
    let mut resolved = BTreeMap::<String, PathBuf>::new();
    for candidate in candidates {
        let canonical = canonicalize_allow_missing(&candidate)?;
        if metadata_path_authorized(&canonical, &params.policy.repository_metadata_roots) {
            continue;
        }
        let key = if cfg!(windows) {
            canonical.to_string_lossy().to_lowercase()
        } else {
            canonical.to_string_lossy().into_owned()
        };
        resolved.entry(key).or_insert(canonical);
    }
    Ok(resolved.into_values().collect())
}

fn metadata_path_authorized(path: &Path, metadata_roots: &[PathBuf]) -> bool {
    metadata_roots.iter().any(|root| path.starts_with(root))
}

fn guard_token() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!(
        "{}:{}:{}",
        std::process::id(),
        timestamp,
        PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn create_missing_protected_guards(
    params: &ProcessParams,
) -> Result<Vec<ProtectedPathGuard>, RpcError> {
    let write_roots = canonical_roots(&params.policy.write_roots)?;
    let mut guards = Vec::new();
    for protected in protected_path_candidates(params)? {
        if protected.exists() {
            if protected.join(PROTECTED_GUARD_MARKER).exists() {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "protected-path guard is already active for '{}'",
                        protected.display()
                    ),
                ));
            }
            continue;
        }
        if !write_roots.iter().any(|root| protected.starts_with(root)) {
            continue;
        }
        let parent = protected.parent().ok_or_else(|| {
            RpcError::new("policy_denied", "protected path has no parent directory")
        })?;
        let canonical_parent = parent.canonicalize().map_err(|error| {
            RpcError::new(
                "policy_denied",
                format!(
                    "missing protected path '{}' requires an existing stable parent: {error}",
                    protected.display()
                ),
            )
        })?;
        if canonical_parent != parent {
            return Err(RpcError::new(
                "policy_denied",
                format!(
                    "protected path parent changed during guard creation: '{}'",
                    protected.display()
                ),
            ));
        }
        create_dir(&protected).map_err(|error| {
            RpcError::new(
                "policy_denied",
                format!(
                    "failed to create a protected-path guard for '{}': {error}",
                    protected.display()
                ),
            )
        })?;
        let marker = protected.join(PROTECTED_GUARD_MARKER);
        let token = guard_token();
        if let Err(error) = write(&marker, &token) {
            let _ = remove_dir(&protected);
            return Err(RpcError::new(
                "policy_denied",
                format!(
                    "failed to seal protected-path guard '{}': {error}",
                    protected.display()
                ),
            ));
        }
        guards.push(ProtectedPathGuard {
            path: protected,
            marker,
            token,
        });
    }
    Ok(guards)
}

fn canonicalize_allow_missing(path: &Path) -> Result<PathBuf, RpcError> {
    let mut ancestor = path;
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or_else(|| {
            RpcError::new(
                "policy_denied",
                format!(
                    "protected path has no existing ancestor: '{}'",
                    path.display()
                ),
            )
        })?;
    }
    let canonical = ancestor.canonicalize().map_err(|error| {
        RpcError::new("policy_denied", format!("invalid protected path: {error}"))
    })?;
    let suffix = path
        .strip_prefix(ancestor)
        .map_err(|_| RpcError::new("policy_denied", "protected path normalization failed"))?;
    if suffix.as_os_str().is_empty() {
        Ok(canonical)
    } else {
        Ok(canonical.join(suffix))
    }
}

fn canonical_roots(roots: &[PathBuf]) -> Result<Vec<PathBuf>, RpcError> {
    roots
        .iter()
        .map(|root| canonicalize_sandbox_root(root))
        .collect()
}

fn canonicalize_sandbox_root(root: &Path) -> Result<PathBuf, RpcError> {
    #[cfg(target_os = "windows")]
    {
        crate::windows_sandbox::canonicalize_policy_root(root)
    }
    #[cfg(not(target_os = "windows"))]
    {
        root.canonicalize().map_err(|error| {
            RpcError::new("policy_denied", format!("invalid sandbox root: {error}"))
        })
    }
}

pub(crate) fn minimal_roots(roots: &[PathBuf]) -> Vec<&PathBuf> {
    roots
        .iter()
        .filter(|root| {
            !roots
                .iter()
                .any(|candidate| candidate != *root && root.starts_with(candidate))
        })
        .collect()
}

fn secret_key(key: &str) -> bool {
    let mut normalized = String::with_capacity(key.len());
    let mut previous_lowercase = false;
    for character in key.chars() {
        if character.is_ascii_uppercase() && previous_lowercase {
            normalized.push('_');
        }
        normalized.push(if character == '-' {
            '_'
        } else {
            character.to_ascii_lowercase()
        });
        previous_lowercase = character.is_ascii_lowercase();
    }
    let parts = normalized
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    parts.iter().any(|part| {
        matches!(
            *part,
            "apikey" | "secret" | "token" | "password" | "passwd" | "credential"
        )
    }) || parts
        .windows(2)
        .any(|pair| matches!(pair, ["api", "key"] | ["private", "key"]))
}

#[cfg(any(target_os = "linux", test))]
fn configure_common(command: &mut Command, params: &ProcessParams) {
    command.current_dir(&params.command.cwd);
    command.env_clear();
    command.envs(&params.command.env);
    if params.lifecycle == ProcessLifecycle::Deliverable {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    } else {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
}

#[cfg(test)]
fn build_host_command(params: &ProcessParams) -> Result<PreparedCommand, RpcError> {
    if params.pty {
        return Err(RpcError::new(
            "pty_unavailable",
            "unsafe host PTY execution is not supported",
        ));
    }
    let mut command = Command::new(&params.command.executable);
    command.args(&params.command.args);
    configure_common(&mut command, params);
    Ok(PreparedCommand {
        command,
        bootstrap_stdin: Vec::new(),
        protected_path_guards: Vec::new(),
        launch_failure_nonce: None,
        disposable_workspace: None,
        #[cfg(target_os = "linux")]
        _mount_source_descriptors: Vec::new(),
    })
}

#[cfg(target_os = "linux")]
fn build_sandboxed_command(
    params: &ProcessParams,
    scratch: Option<&ScratchLease>,
    disposable_workspace: Option<&DisposableWorkspace>,
) -> Result<PreparedCommand, RpcError> {
    let bwrap = trusted_bwrap().map_err(|error| RpcError::new("sandbox_unavailable", error))?;
    let mut command = Command::new(bwrap);
    // Session processes retain bubblewrap's parent-death cleanup in addition
    // to the broker watchdog. A deliverable must survive only after the
    // watchdog has been explicitly revoked by process.handoff.
    if params.lifecycle == ProcessLifecycle::Session {
        command.arg("--die-with-parent");
    }
    command.args(["--new-session", "--unshare-all", "--as-pid-1"]);
    if params.policy.network == NetworkMode::Full {
        command.arg("--share-net");
    } else if params.policy.network == NetworkMode::Loopback {
        // bubblewrap drops capabilities before the hardened launcher. Grant
        // only CAP_NET_ADMIN long enough to raise `lo`; the launcher clears
        // all effective/permitted/inheritable capabilities before applying
        // no-new-privileges, Landlock and seccomp or executing user code.
        command.args(["--cap-add", "CAP_NET_ADMIN"]);
    }
    let system_roots = linux_system_roots();
    // Resolve every policy mount into one identity snapshot before opening any
    // bwrap source descriptor. If an ancestor is replaced between groups, at
    // least one later identity check fails instead of combining roots from two
    // different trees.
    let resolved_read_roots = resolve_mount_sources(&params.policy.read_roots)?;
    let resolved_write_roots = resolve_mount_sources(&params.policy.write_roots)?;
    let resolved_execution_roots = resolve_mount_sources(&params.policy.execution_roots)?;
    let resolved_cwd = ResolvedMountSource::resolve(&params.command.cwd)?;
    if !resolved_cwd.is_directory() {
        return Err(RpcError::new(
            "policy_denied",
            "command cwd must resolve to a directory",
        ));
    }
    if !resolved_read_roots
        .iter()
        .chain(resolved_write_roots.iter())
        .any(|root| resolved_cwd.destination().starts_with(root.destination()))
    {
        return Err(RpcError::new(
            "policy_denied",
            "cwd is outside the resolved sandbox roots",
        ));
    }
    let cwd = resolved_cwd.destination().to_owned();
    validate_resolved_root_relationships(
        &resolved_read_roots,
        &resolved_write_roots,
        &resolved_execution_roots,
    )?;
    let resolved_protected_roots = resolve_protected(params, &resolved_read_roots)?;
    let read_roots = pin_resolved_mount_sources(resolved_read_roots)?;
    let write_roots = pin_resolved_mount_sources(resolved_write_roots)?;
    let execution_roots = pin_resolved_mount_sources(resolved_execution_roots)?;
    let protected_roots = pin_resolved_mount_sources(resolved_protected_roots)?;
    let disposable_source = disposable_workspace
        .map(|workspace| PinnedMountSource::pin(workspace.source()))
        .transpose()?;
    let cwd_source = resolved_cwd.pin()?;
    verify_pinned_root_hierarchy(
        &read_roots,
        &write_roots,
        &execution_roots,
        &protected_roots,
    )?;
    verify_pinned_descendants("cwd", std::slice::from_ref(&cwd_source), &read_roots, true)?;
    reject_internal_mount_conflicts(
        &read_roots,
        &write_roots,
        &execution_roots,
        &protected_roots,
    )?;
    let executable =
        authorize_linux_executable(params, &system_roots, &execution_roots, &cwd_source)?;
    let executable_destination = executable.source.destination().to_owned();
    for root in &system_roots {
        let value = root.to_string_lossy();
        command.args(["--ro-bind", value.as_ref(), value.as_ref()]);
    }
    command.args(["--proc", "/proc", "--dev", "/dev"]);
    let scratch_home = scratch
        .map(|lease| PinnedMountSource::pin(lease.home_source()))
        .transpose()?;
    let scratch_temp = scratch
        .map(|lease| PinnedMountSource::pin(lease.temp_source()))
        .transpose()?;
    if let (Some(lease), Some(home), Some(temp)) =
        (scratch, scratch_home.as_ref(), scratch_temp.as_ref())
    {
        home.append_bind_at(&mut command, false, lease.home_destination());
        temp.append_bind_at(&mut command, false, Path::new("/tmp"));
    } else {
        command.args(["--tmpfs", "/tmp"]);
    }
    bind_pinned_roots(&mut command, &read_roots, true, &system_roots);
    bind_pinned_roots(&mut command, &write_roots, false, &[]);
    bind_pinned_roots(&mut command, &execution_roots, true, &system_roots);
    if let (Some(workspace), Some(source)) = (disposable_workspace, disposable_source.as_ref()) {
        source.append_bind_at(&mut command, false, workspace.destination());
    }
    bind_pinned_roots(&mut command, &protected_roots, true, &[]);
    cwd_source.append_bind_at(
        &mut command,
        true,
        Path::new(crate::linux_hardening::INTERNAL_CWD_PIN_MOUNT),
    );
    // The strict pathname bind requires the canonical destination to exist
    // with the right type. The following FD bind mounts the pinned object and
    // verifies the resulting inode against that descriptor. Keep this pair
    // after all policy mounts so no later layer can replace it.
    append_pinned_executable_bind(&mut command, &executable.source)?;
    // configure_common() clears the bwrap process environment before spawn,
    // so only this request's reconstructed allowlisted environment can be
    // inherited. Avoid bwrap's newer --clearenv flag to retain compatibility
    // with the glibc 2.28 baseline's bubblewrap 0.4 runtime.
    for (key, value) in &params.command.env {
        command.args(["--setenv", key, value]);
    }
    if let Some(lease) = scratch {
        let home = lease.home_destination();
        command.args(["--setenv", "HOME"]).arg(home);
        command.args(["--setenv", "TMPDIR", "/tmp"]);
        command.args(["--setenv", "TMP", "/tmp"]);
        command.args(["--setenv", "TEMP", "/tmp"]);
        command
            .args(["--setenv", "XDG_CACHE_HOME"])
            .arg(home.join(".cache"));
        command
            .args(["--setenv", "XDG_CONFIG_HOME"])
            .arg(home.join(".config"));
        command
            .args(["--setenv", "XDG_DATA_HOME"])
            .arg(home.join(".local/share"));
        command
            .args(["--setenv", "XDG_STATE_HOME"])
            .arg(home.join(".local/state"));
    }
    let helper = std::env::current_exe().map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!("cannot resolve sigma-exec hardening helper: {error}"),
        )
    })?;
    let helper_source = PinnedMountSource::pin(&helper)?;
    helper_source.append_bind_at(&mut command, true, Path::new(INTERNAL_HELPER_MOUNT));
    command.arg("--chdir").arg(&cwd).arg("--");
    command
        .arg(INTERNAL_HELPER_MOUNT)
        .arg(crate::linux_hardening::INTERNAL_HARDENED_LAUNCHER)
        .arg("--cwd-pin")
        .arg(crate::linux_hardening::INTERNAL_CWD_PIN_MOUNT)
        .arg("--argv0")
        .arg(if params.pty {
            std::ffi::OsStr::new(INTERNAL_HELPER_MOUNT)
        } else {
            executable.invocation_arg0.as_os_str()
        });
    if params.policy.network == NetworkMode::Loopback {
        command.arg("--loopback");
    }
    for root in system_roots
        .iter()
        .map(PathBuf::as_path)
        .chain(read_roots.iter().map(PinnedMountSource::destination))
        .chain(execution_roots.iter().map(PinnedMountSource::destination))
        .chain([
            Path::new("/tmp"),
            Path::new("/proc"),
            Path::new("/dev"),
            Path::new(INTERNAL_HELPER_MOUNT),
        ])
    {
        command.arg("--read").arg(root);
    }
    for root in write_roots
        .iter()
        .map(PinnedMountSource::destination)
        .chain([Path::new("/tmp"), Path::new("/dev")])
    {
        command.arg("--write").arg(root);
    }
    if let Some(workspace) = disposable_workspace {
        command.arg("--write").arg(workspace.destination());
    }
    if let Some(lease) = scratch {
        command.arg("--write").arg(lease.home_destination());
    }
    command.arg("--");
    if params.pty {
        command
            .arg(INTERNAL_HELPER_MOUNT)
            .arg("--internal-unix-pty-launcher")
            .arg(params.pty_columns.to_string())
            .arg(params.pty_rows.to_string())
            .arg(&executable_destination)
            .arg(&executable.invocation_arg0)
            .args(&params.command.args);
    } else {
        command
            .arg(&executable_destination)
            .args(&params.command.args);
    }
    configure_common(&mut command, params);
    let mount_source_fds = read_roots
        .iter()
        .chain(write_roots.iter())
        .chain(execution_roots.iter())
        .chain(protected_roots.iter())
        .map(PinnedMountSource::raw_fd)
        .chain([
            helper_source.raw_fd(),
            cwd_source.raw_fd(),
            executable.source.raw_fd(),
        ])
        .chain(scratch_home.iter().map(PinnedMountSource::raw_fd))
        .chain(scratch_temp.iter().map(PinnedMountSource::raw_fd))
        .chain(disposable_source.iter().map(PinnedMountSource::raw_fd))
        .collect::<Vec<_>>();
    inherit_mount_sources(&mut command, &mount_source_fds)?;
    let mount_source_descriptors = read_roots
        .into_iter()
        .chain(write_roots)
        .chain(execution_roots)
        .chain(protected_roots)
        .map(PinnedMountSource::into_descriptor)
        .chain([
            helper_source.into_descriptor(),
            cwd_source.into_descriptor(),
            executable.source.into_descriptor(),
        ])
        .chain(
            scratch_home
                .into_iter()
                .map(PinnedMountSource::into_descriptor),
        )
        .chain(
            scratch_temp
                .into_iter()
                .map(PinnedMountSource::into_descriptor),
        )
        .chain(
            disposable_source
                .into_iter()
                .map(PinnedMountSource::into_descriptor),
        )
        .collect();
    Ok(PreparedCommand {
        command,
        bootstrap_stdin: Vec::new(),
        protected_path_guards: Vec::new(),
        launch_failure_nonce: None,
        disposable_workspace: None,
        _mount_source_descriptors: mount_source_descriptors,
    })
}

#[cfg(target_os = "windows")]
fn build_sandboxed_command(
    params: &ProcessParams,
    _scratch: Option<&ScratchLease>,
    _disposable_workspace: Option<&DisposableWorkspace>,
) -> Result<PreparedCommand, RpcError> {
    crate::windows_sandbox::prepare_command(params)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn build_sandboxed_command(
    _params: &ProcessParams,
    _scratch: Option<&ScratchLease>,
    _disposable_workspace: Option<&DisposableWorkspace>,
) -> Result<PreparedCommand, RpcError> {
    Err(RpcError::new(
        "sandbox_unavailable",
        "required sandbox backend is unavailable on this platform",
    ))
}

#[cfg(target_os = "linux")]
fn resolve_mount_sources(roots: &[PathBuf]) -> Result<Vec<ResolvedMountSource>, RpcError> {
    roots
        .iter()
        .map(|root| ResolvedMountSource::resolve(root))
        .collect()
}

#[cfg(target_os = "linux")]
fn pin_resolved_mount_sources(
    roots: Vec<ResolvedMountSource>,
) -> Result<Vec<PinnedMountSource>, RpcError> {
    roots.into_iter().map(ResolvedMountSource::pin).collect()
}

#[cfg(target_os = "linux")]
fn validate_resolved_root_relationships(
    read_roots: &[ResolvedMountSource],
    write_roots: &[ResolvedMountSource],
    execution_roots: &[ResolvedMountSource],
) -> Result<(), RpcError> {
    for write_root in write_roots {
        if !read_roots.iter().any(|read_root| {
            write_root
                .destination()
                .starts_with(read_root.destination())
        }) {
            return Err(RpcError::new(
                "policy_denied",
                "a pinned write root escaped its declared read root",
            ));
        }
    }
    for execution_root in execution_roots {
        if write_roots.iter().any(|write_root| {
            write_root
                .destination()
                .starts_with(execution_root.destination())
                || execution_root
                    .destination()
                    .starts_with(write_root.destination())
        }) {
            return Err(RpcError::new(
                "policy_denied",
                "a pinned execution root overlaps a writable root",
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_pinned_descendants(
    label: &str,
    descendants: &[PinnedMountSource],
    ancestors: &[PinnedMountSource],
    required: bool,
) -> Result<(), RpcError> {
    for descendant in descendants {
        let candidates = ancestors
            .iter()
            .filter(|ancestor| descendant.destination().starts_with(ancestor.destination()))
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            if required {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "pinned {label} has no containing read root: '{}'",
                        descendant.destination().display()
                    ),
                ));
            }
            continue;
        }
        for ancestor in candidates {
            if !descendant.is_descendant_of(ancestor)? {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "pinned {label} escaped its lexical ancestor object: '{}'",
                        descendant.destination().display()
                    ),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_pinned_group_hierarchy(label: &str, roots: &[PinnedMountSource]) -> Result<(), RpcError> {
    for (descendant_index, descendant) in roots.iter().enumerate() {
        for (ancestor_index, ancestor) in roots.iter().enumerate() {
            if descendant_index == ancestor_index
                || !descendant.destination().starts_with(ancestor.destination())
            {
                continue;
            }
            if !descendant.is_descendant_of(ancestor)? {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "nested pinned {label} came from a different ancestor object: '{}'",
                        descendant.destination().display()
                    ),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verify_pinned_root_hierarchy(
    read_roots: &[PinnedMountSource],
    write_roots: &[PinnedMountSource],
    execution_roots: &[PinnedMountSource],
    protected_roots: &[PinnedMountSource],
) -> Result<(), RpcError> {
    verify_pinned_group_hierarchy("read root", read_roots)?;
    verify_pinned_group_hierarchy("write root", write_roots)?;
    verify_pinned_group_hierarchy("execution root", execution_roots)?;
    verify_pinned_group_hierarchy("protected path", protected_roots)?;
    verify_pinned_descendants("write root", write_roots, read_roots, true)?;
    verify_pinned_descendants("protected path", protected_roots, read_roots, true)?;
    verify_pinned_descendants("protected path", protected_roots, write_roots, false)?;
    // Execution roots outside every read root are independent, explicitly
    // declared mounts. When their destination is nested under a read root,
    // however, the later bind must come from that exact pinned tree.
    verify_pinned_descendants("execution root", execution_roots, read_roots, false)
}

#[cfg(target_os = "linux")]
fn reject_internal_mount_conflicts(
    read_roots: &[PinnedMountSource],
    write_roots: &[PinnedMountSource],
    execution_roots: &[PinnedMountSource],
    protected_roots: &[PinnedMountSource],
) -> Result<(), RpcError> {
    let reserved = [
        Path::new(INTERNAL_HELPER_MOUNT),
        Path::new(crate::linux_hardening::INTERNAL_CWD_PIN_MOUNT),
    ];
    for destination in reserved {
        for root in read_roots
            .iter()
            .chain(write_roots)
            .chain(execution_roots)
            .chain(protected_roots)
        {
            if root.occupies_destination(destination)? {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "sandbox policy collides with reserved internal mount '{}'",
                        destination.display()
                    ),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn bind_pinned_roots(
    command: &mut Command,
    roots: &[PinnedMountSource],
    read_only: bool,
    covered_roots: &[PathBuf],
) {
    for root in roots {
        if covered_roots
            .iter()
            .any(|covered| root.destination().starts_with(covered))
        {
            continue;
        }
        root.append_bind(command, read_only);
    }
}

#[cfg(target_os = "linux")]
fn append_pinned_executable_bind(
    command: &mut Command,
    executable: &PinnedMountSource,
) -> Result<(), RpcError> {
    let destination = executable.destination();
    if !executable.destination_matches_identity()? {
        return Err(RpcError::new(
            "policy_denied",
            format!(
                "authorized executable destination changed before sandbox setup: '{}'",
                destination.display()
            ),
        ));
    }
    command.arg("--ro-bind").arg(destination).arg(destination);
    // bwrap verifies that the completed mount identifies this descriptor, so
    // a race while resolving its proc-fd source fails before launcher exec.
    executable.append_bind_at(command, true, destination);
    Ok(())
}

#[cfg(target_os = "linux")]
fn authorize_linux_executable(
    params: &ProcessParams,
    system_roots: &[PathBuf],
    execution_roots: &[PinnedMountSource],
    cwd: &PinnedMountSource,
) -> Result<AuthorizedLinuxExecutable, RpcError> {
    let requested = PathBuf::from(&params.command.executable);
    let mut candidates = Vec::new();
    if requested.is_absolute() {
        candidates.push(requested);
    } else if params.command.executable.as_bytes().contains(&b'/') {
        candidates.push(cwd.fd_path().join(requested));
    } else if let Some(search) = params.command.env.get("PATH") {
        candidates.extend(std::env::split_paths(search).map(|directory| {
            if directory.is_absolute() {
                directory.join(&requested)
            } else {
                cwd.fd_path().join(directory).join(&requested)
            }
        }));
    }
    let system_roots = system_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .collect::<Vec<_>>();
    for candidate in candidates {
        let Ok(source) = PinnedMountSource::pin(&candidate) else {
            continue;
        };
        if !source.is_executable_file()? {
            continue;
        }
        if let Some(expected) = params.policy.executable_sha256.as_deref()
            && source.sha256()? != expected
        {
            return Err(RpcError::new(
                "executable_unavailable",
                format!(
                    "executable '{}' no longer matches its trusted digest",
                    source.destination().display()
                ),
            ));
        }
        if system_roots
            .iter()
            .any(|root| source.destination().starts_with(root))
        {
            return Ok(AuthorizedLinuxExecutable {
                source,
                invocation_arg0: OsString::from(&params.command.executable),
            });
        }
        for root in execution_roots
            .iter()
            .filter(|root| source.destination().starts_with(root.destination()))
        {
            if source.is_descendant_of(root)? {
                return Ok(AuthorizedLinuxExecutable {
                    source,
                    invocation_arg0: OsString::from(&params.command.executable),
                });
            }
        }
        // This is the first candidate execvp could execute. Continuing the
        // PATH search would authorize a different object from the one the
        // declared command selects.
        return Err(RpcError::new(
            "executable_unavailable",
            format!(
                "resolved executable '{}' is outside trusted system and declared execution roots",
                source.destination().display()
            ),
        ));
    }
    Err(RpcError::new(
        "executable_not_found",
        format!("cannot resolve executable '{}'", params.command.executable),
    ))
}

#[cfg(target_os = "linux")]
fn resolve_protected(
    params: &ProcessParams,
    read_roots: &[ResolvedMountSource],
) -> Result<Vec<ResolvedMountSource>, RpcError> {
    let read_paths = read_roots
        .iter()
        .map(|root| root.destination().to_owned())
        .collect::<Vec<_>>();
    let derived = minimal_roots(&read_paths)
        .into_iter()
        .flat_map(|root| [root.join(".git"), root.join(".agent")]);
    let mut resolved = BTreeMap::<PathBuf, ResolvedMountSource>::new();
    for item in params.policy.protected_paths.iter().cloned().chain(derived) {
        if !item.exists() {
            continue;
        }
        let source = ResolvedMountSource::resolve(&item)?;
        if metadata_path_authorized(
            source.destination(),
            &params.policy.repository_metadata_roots,
        ) {
            continue;
        }
        if !read_roots
            .iter()
            .any(|root| source.destination().starts_with(root.destination()))
        {
            return Err(RpcError::new(
                "policy_denied",
                "a protected path escaped its pinned read root",
            ));
        }
        resolved
            .entry(source.destination().to_owned())
            .or_insert(source);
    }
    Ok(resolved.into_values().collect())
}

#[cfg(target_os = "linux")]
fn trusted_bwrap() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join("bwrap"));
        }
    }
    candidates.extend([
        PathBuf::from("/usr/bin/bwrap"),
        PathBuf::from("/bin/bwrap"),
        PathBuf::from("/usr/local/bin/bwrap"),
    ]);
    trusted_bwrap_from(&candidates)
}

#[cfg(target_os = "linux")]
fn trusted_bwrap_from(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    let mut rejected = Vec::new();
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let canonical = candidate
            .canonicalize()
            .map_err(|error| format!("cannot canonicalize '{}': {error}", candidate.display()))?;
        let metadata = canonical
            .metadata()
            .map_err(|error| format!("cannot inspect '{}': {error}", canonical.display()))?;
        if !metadata.is_file() || metadata.uid() != 0 || metadata.permissions().mode() & 0o022 != 0
        {
            rejected.push(canonical.display().to_string());
            continue;
        }
        let mut ancestor = canonical.parent();
        let mut safe = true;
        while let Some(directory) = ancestor {
            let info = directory
                .metadata()
                .map_err(|error| format!("cannot inspect '{}': {error}", directory.display()))?;
            if !info.is_dir() || info.uid() != 0 || info.permissions().mode() & 0o022 != 0 {
                safe = false;
                break;
            }
            ancestor = directory.parent();
        }
        if safe {
            return Ok(canonical);
        }
        rejected.push(canonical.display().to_string());
    }
    if rejected.is_empty() {
        Err("bubblewrap was not found at a trusted system path".into())
    } else {
        Err(format!(
            "bubblewrap failed trusted owner/permission checks: {}",
            rejected.join(", ")
        ))
    }
}

#[cfg(target_os = "linux")]
fn linux_system_roots() -> Vec<PathBuf> {
    ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]
        .into_iter()
        .map(PathBuf::from)
        .filter(|root| root.exists())
        .collect()
}

#[cfg(target_os = "linux")]
fn bwrap_supports_pinned_mounts(bwrap: &Path) -> Result<(), String> {
    let output = Command::new(bwrap)
        .arg("--help")
        .env_clear()
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("cannot inspect bubblewrap capabilities: {error}"))?;
    let mut help = output.stdout;
    help.extend_from_slice(&output.stderr);
    let help = String::from_utf8_lossy(&help);
    if output.status.success() && help.contains("--bind-fd") && help.contains("--ro-bind-fd") {
        Ok(())
    } else {
        Err("bubblewrap lacks descriptor-bound mounts required for stable sandbox roots".into())
    }
}

#[cfg(target_os = "linux")]
fn unavailable_linux_sandbox(reason: String) -> SandboxStatus {
    SandboxStatus {
        available: false,
        backend: "bubblewrap",
        self_test_passed: false,
        setup_required: true,
        reason: Some(reason),
        landlock_abi: None,
        no_new_privileges: false,
        seccomp_filter: false,
        less_privileged_appcontainer: false,
        mount_namespace: false,
        pid_namespace: false,
        network_namespace: false,
    }
}

#[cfg(target_os = "linux")]
fn detect_sandbox() -> SandboxStatus {
    let bwrap = match trusted_bwrap() {
        Ok(value) => value,
        Err(error) => return unavailable_linux_sandbox(error),
    };
    if let Err(error) = bwrap_supports_pinned_mounts(&bwrap) {
        return unavailable_linux_sandbox(error);
    }
    let base_passed = PinnedMountSource::pin(Path::new("/"))
        .and_then(|root| {
            let mut command = Command::new(&bwrap);
            command.args([
                "--die-with-parent",
                "--new-session",
                "--unshare-all",
                "--as-pid-1",
            ]);
            root.append_bind(&mut command, true);
            command
                .args(["--proc", "/proc", "--dev", "/dev", "--", "/bin/true"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            inherit_mount_sources(&mut command, &[root.raw_fd()])?;
            command.status().map_err(RpcError::from)
        })
        .map(|status| status.success())
        .unwrap_or(false);
    let hardening = base_passed
        .then(|| crate::linux_hardening::self_test(&bwrap))
        .transpose()
        .and_then(|value| value.ok_or_else(|| "bubblewrap base self-test failed".into()));
    let pty_passed = hardening.is_ok() && linux_pty_self_test(&bwrap);
    let passed = base_passed && hardening.is_ok() && pty_passed;
    let hardening_report = hardening.as_ref().ok();
    SandboxStatus {
        available: passed,
        backend: "bubblewrap+namespaces+landlock+seccomp+forkpty",
        self_test_passed: passed,
        setup_required: !passed,
        reason: (!passed).then(|| match &hardening {
            Err(error) => format!("Linux Landlock/seccomp self-test failed: {error}"),
            Ok(_) if !pty_passed => "bubblewrap hardened forkpty self-test failed".into(),
            Ok(_) => "bubblewrap kernel isolation self-test failed".into(),
        }),
        landlock_abi: hardening_report.map(|report| report.landlock_abi),
        no_new_privileges: hardening_report
            .map(|report| report.no_new_privileges)
            .unwrap_or(false),
        seccomp_filter: hardening_report
            .map(|report| report.seccomp_filter)
            .unwrap_or(false),
        less_privileged_appcontainer: false,
        mount_namespace: hardening_report
            .map(|report| report.mount_namespace)
            .unwrap_or(false),
        pid_namespace: hardening_report
            .map(|report| report.pid_namespace)
            .unwrap_or(false),
        network_namespace: hardening_report
            .map(|report| report.network_namespace)
            .unwrap_or(false),
    }
}

#[cfg(target_os = "linux")]
fn linux_pty_self_test(bwrap: &Path) -> bool {
    let helper = match std::env::current_exe() {
        Ok(value) => value,
        Err(_) => return false,
    };
    Command::new(bwrap)
        .args([
            "--die-with-parent",
            "--new-session",
            "--unshare-all",
            "--as-pid-1",
            "--ro-bind",
            "/",
            "/",
            "--tmpfs",
            "/tmp",
            "--ro-bind",
            "/",
            crate::linux_hardening::INTERNAL_CWD_PIN_MOUNT,
            "--chdir",
            "/",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--",
        ])
        .arg(&helper)
        .arg(crate::linux_hardening::INTERNAL_HARDENED_LAUNCHER)
        .args([
            "--cwd-pin",
            crate::linux_hardening::INTERNAL_CWD_PIN_MOUNT,
            "--argv0",
            "/sigma-exec",
            "--read",
            "/",
            "--write",
            "/tmp",
            "--write",
            "/dev",
            "--",
        ])
        .arg(&helper)
        .args([
            "--internal-unix-pty-launcher",
            "80",
            "24",
            "/bin/sh",
            "/bin/sh",
            "-c",
            "test -t 0 && test -t 1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn detect_sandbox() -> SandboxStatus {
    match crate::windows_sandbox::detect() {
        Ok(()) => SandboxStatus {
            available: true,
            backend: "lpac+appcontainer+job-object+conpty",
            self_test_passed: true,
            setup_required: false,
            reason: None,
            landlock_abi: None,
            no_new_privileges: false,
            seccomp_filter: false,
            less_privileged_appcontainer: true,
            mount_namespace: false,
            pid_namespace: false,
            network_namespace: false,
        },
        Err(error) => SandboxStatus {
            available: false,
            backend: "lpac+appcontainer+job-object+conpty",
            self_test_passed: false,
            setup_required: error.code == "sandbox_setup_required",
            reason: Some(error.message),
            landlock_abi: None,
            no_new_privileges: false,
            seccomp_filter: false,
            less_privileged_appcontainer: false,
            mount_namespace: false,
            pid_namespace: false,
            network_namespace: false,
        },
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn detect_sandbox() -> SandboxStatus {
    SandboxStatus {
        available: false,
        backend: "unsupported",
        self_test_passed: false,
        setup_required: false,
        reason: Some("platform is not a Sigma Code Tier 1 target".into()),
        landlock_abi: None,
        no_new_privileges: false,
        seccomp_filter: false,
        less_privileged_appcontainer: false,
        mount_namespace: false,
        pid_namespace: false,
        network_namespace: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn non_git_params(root: &Path) -> ProcessParams {
        ProcessParams {
            command: CommandSpec {
                executable: "test-command".into(),
                args: Vec::new(),
                cwd: root.to_owned(),
                env: BTreeMap::new(),
                stdin: None,
            },
            policy: ExecutionPolicy {
                sandbox: SandboxMode::Required,
                network: NetworkMode::None,
                network_approved: false,
                read_roots: vec![root.to_owned()],
                write_roots: vec![root.to_owned()],
                execution_roots: Vec::new(),
                executable_sha256: None,
                protected_paths: vec![root.join(".git"), root.join(".agent")],
                disposable_workspace_root: None,
                read_only_validation_workspace_root: None,
                repository_metadata_lease_id: None,
                scratch_lease_id: None,
                scratch_session_id: None,
                repository_metadata_roots: Vec::new(),
                session_scratch_roots: Vec::new(),
                disposable_workspace_authorized_root: None,
                #[cfg(test)]
                unsafe_host_exec_approved: false,
            },
            max_output_bytes: 1024,
            timeout_ms: Some(1_000),
            idle_timeout_ms: None,
            lifecycle: ProcessLifecycle::Session,
            pty: false,
            pty_columns: 80,
            pty_rows: 24,
        }
    }

    #[test]
    fn recognizes_secret_environment_names() {
        assert!(secret_key("DEEPSEEK_API_KEY"));
        assert!(secret_key("accessToken"));
        assert!(!secret_key("PATH"));
        assert!(!secret_key("TOKENIZERS_PARALLELISM"));
    }

    #[test]
    fn native_doctor_never_claims_an_oci_boundary() {
        let report = doctor_report();
        assert_eq!(report["container"]["backend"], "oci");
        assert_eq!(report["container"]["available"], false);
        assert!(
            report["container"]["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("trusted OCI launcher"))
        );
    }

    #[test]
    fn doctor_reports_only_absolute_executable_search_paths() {
        let report = doctor_report();
        let search_paths = report["capabilities"]["executableSearchPaths"]
            .as_array()
            .expect("doctor executable search paths");
        assert!(search_paths.len() <= 128);
        assert!(search_paths.iter().all(|value| {
            value
                .as_str()
                .is_some_and(|entry| Path::new(entry).is_absolute())
        }));
        assert!(
            report["capabilities"]["runtimeCommands"]
                .as_array()
                .is_some_and(|commands| commands.len() <= RUNTIME_COMMAND_PROBE.len())
        );
        assert!(report["capabilities"]["runtimeCommandSnapshotComplete"].is_boolean());
    }

    #[test]
    fn runtime_command_snapshot_proves_present_and_absent_known_commands() {
        let root = std::env::temp_dir().join(format!(
            "sigma-runtime-command-snapshot-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).expect("create runtime probe directory");
        let executable = root.join(if cfg!(windows) { "node.exe" } else { "node" });
        let git = root.join(if cfg!(windows) { "git.exe" } else { "git" });
        std::fs::write(&executable, b"fixture").expect("write runtime probe executable");
        std::fs::write(&git, b"fixture").expect("write git runtime probe executable");
        #[cfg(unix)]
        {
            let mut permissions = std::fs::metadata(&executable)
                .expect("runtime probe metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&executable, permissions)
                .expect("make runtime probe executable");
            let mut git_permissions = std::fs::metadata(&git)
                .expect("git runtime probe metadata")
                .permissions();
            git_permissions.set_mode(0o755);
            std::fs::set_permissions(&git, git_permissions)
                .expect("make git runtime probe executable");
        }
        let paths = ExecutableSearchPathSnapshot {
            paths: vec![root.clone()],
            serialized: vec![root.to_string_lossy().into_owned()],
            complete: true,
        };
        let present = runtime_command_snapshot(&paths);
        assert!(present.complete);
        assert!(present.commands.iter().any(|command| command == "node"));
        assert!(present.commands.iter().any(|command| command == "git"));
        assert!(!present.commands.iter().any(|command| command == "python"));

        std::fs::remove_file(executable).expect("remove runtime probe executable");
        std::fs::remove_file(git).expect("remove git runtime probe executable");
        let absent = runtime_command_snapshot(&paths);
        assert!(absent.complete);
        assert!(absent.commands.is_empty());
        std::fs::remove_dir(root).expect("remove runtime probe directory");
    }

    #[test]
    fn incomplete_search_path_never_proves_command_absence() {
        let paths = ExecutableSearchPathSnapshot {
            paths: Vec::new(),
            serialized: Vec::new(),
            complete: false,
        };
        let snapshot = runtime_command_snapshot(&paths);
        assert!(!snapshot.complete);
        assert!(snapshot.commands.is_empty());
    }

    #[test]
    fn keeps_only_top_level_read_roots_for_metadata_protection() {
        let roots = vec![
            PathBuf::from("workspace"),
            PathBuf::from("workspace").join("src"),
            PathBuf::from("runtime"),
        ];
        assert_eq!(minimal_roots(&roots), vec![&roots[0], &roots[2]]);
    }

    #[test]
    fn protects_absent_metadata_paths_without_rejecting_a_non_git_root() {
        let root = std::env::temp_dir().join(format!(
            "sigma-protected-guard-test-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).expect("create test workspace");
        let params = non_git_params(&root);
        validate_roots(&params).expect("missing protected paths should pass preflight");
        let mut guards =
            create_missing_protected_guards(&params).expect("create protected path guards");
        assert!(root.join(".git").is_dir());
        assert!(root.join(".agent").is_dir());
        assert!(root.join(".git").join(PROTECTED_GUARD_MARKER).is_file());
        assert!(root.join(".agent").join(PROTECTED_GUARD_MARKER).is_file());
        let concurrent = match create_missing_protected_guards(&params) {
            Err(error) => error,
            Ok(_) => panic!("a concurrent sandbox must not borrow another process's guards"),
        };
        assert_eq!(concurrent.code, "policy_denied");
        guards.clear();
        assert!(!root.join(".git").exists());
        assert!(!root.join(".agent").exists());
        std::fs::remove_dir_all(&root).expect("remove test workspace");
    }

    #[test]
    fn execution_roots_are_read_only_and_do_not_force_a_relative_primary_to_be_absolute() {
        let root = std::env::temp_dir().join(format!(
            "sigma-execution-root-test-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).expect("create test workspace");
        let mut params = non_git_params(&root);
        params.policy.write_roots.clear();
        params.command.executable = "cmd".into();
        params.policy.execution_roots = vec![root.clone()];
        validate_roots(&params).expect("relative primary remains valid with child execution roots");

        params.policy.write_roots = vec![root.clone()];
        let overlap = validate_roots(&params).unwrap_err();
        assert_eq!(overlap.code, "policy_denied");
        assert!(overlap.message.contains("must not overlap"));
        std::fs::remove_dir_all(&root).expect("remove test workspace");
    }

    #[test]
    fn disposable_validation_allows_only_broker_session_scratch_write_roots() {
        let root = std::env::temp_dir().join(format!(
            "sigma-disposable-write-scope-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let workspace = root.join("workspace");
        let scratch = root.join("scratch");
        let external = root.join("external");
        for directory in [&workspace, &scratch, &external] {
            std::fs::create_dir_all(directory).expect("create validation scope");
        }
        let mut params = non_git_params(&workspace);
        params.policy.disposable_workspace_root = Some(workspace.clone());
        params.policy.read_roots = vec![workspace.clone(), scratch.clone()];
        params.policy.write_roots = vec![scratch.clone()];
        params.policy.session_scratch_roots = vec![scratch.clone()];
        validate_roots(&params).expect("broker scratch is an internal validation write root");

        params.policy.read_roots.push(external.clone());
        params.policy.write_roots.push(external);
        let error = validate_roots(&params).unwrap_err();
        assert_eq!(error.code, "policy_denied");
        assert!(error.message.contains("durable write roots"));
        std::fs::remove_dir_all(root).expect("remove validation scope");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_disposable_workspace_fails_closed_without_same_path_cow() {
        let root = std::env::temp_dir().join(format!(
            "sigma-disposable-remap-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("create validation workspace");
        let input = root.join("input.txt");
        std::fs::write(&input, b"input").expect("create validation input");
        let scratch = ScratchLease::new("remap-test");
        scratch.prepare().expect("prepare private scratch");
        let mut params = non_git_params(&root);
        params.policy.sandbox = SandboxMode::Unsafe;
        params.policy.unsafe_host_exec_approved = true;
        params.policy.write_roots.clear();
        params.policy.disposable_workspace_root = Some(root.clone());
        params.command.args = vec![input.to_string_lossy().into_owned()];

        let error = match build_command(&params, true, Some(&scratch)) {
            Ok(_) => panic!("Windows must not remap a same-path validation request"),
            Err(error) => error,
        };
        assert_eq!(error.code, "validation_disposable_workspace_unavailable");
        assert!(error.message.contains("same-path"));
        assert_eq!(std::fs::read(&input).unwrap(), b"input");
        assert_eq!(
            std::fs::read_dir(scratch.disposable_base())
                .expect("disposable root")
                .count(),
            0
        );
        std::fs::remove_dir_all(root).expect("remove validation workspace");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_read_only_validation_is_explicit_and_cannot_gain_a_workspace_write_root() {
        let root = std::env::temp_dir().join(format!(
            "sigma-read-only-validation-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("create validation workspace");
        let input = root.join("input.txt");
        std::fs::write(&input, b"input").expect("create validation input");
        let mut params = non_git_params(&root);
        params.policy.sandbox = SandboxMode::Unsafe;
        params.policy.unsafe_host_exec_approved = true;
        params.policy.write_roots.clear();
        params.policy.read_only_validation_workspace_root = Some(root.clone());
        params.command.executable = "cmd.exe".into();
        params.command.args = vec![
            "/d".into(),
            "/s".into(),
            "/c".into(),
            "type input.txt".into(),
        ];

        let mut prepared = build_command(&params, true, None)
            .expect("read-only validation is executable at the real path");
        assert!(prepared.disposable_workspace.is_none());
        let output = prepared.command.output().expect("run read-only validation");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"input");

        params.policy.write_roots = vec![root.clone()];
        let error = validate_roots(&params).unwrap_err();
        assert_eq!(error.code, "policy_denied");
        assert!(error.message.contains("durable write roots"));
        assert_eq!(std::fs::read(&input).unwrap(), b"input");
        std::fs::remove_dir_all(root).expect("remove validation workspace");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_a_path_controlled_bubblewrap_candidate() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "sigma-untrusted-bwrap-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        let fake = root.join("bwrap");
        std::fs::write(&fake, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o777)).unwrap();
        let error = trusted_bwrap_from(&[fake]).unwrap_err();
        assert!(error.contains("trusted owner/permission"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_nested_mounts_pinned_from_a_replacement_ancestor() {
        let root = std::env::temp_dir().join(format!(
            "sigma-pinned-hierarchy-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let declared = root.join("declared");
        let moved = root.join("moved");
        std::fs::create_dir_all(declared.join("nested")).expect("create original tree");
        let outer = PinnedMountSource::pin(&declared).expect("pin outer root");
        std::fs::rename(&declared, &moved).expect("move original tree");
        std::fs::create_dir_all(declared.join("nested")).expect("create replacement tree");
        let nested =
            PinnedMountSource::pin(&declared.join("nested")).expect("pin replacement root");
        let mismatched = vec![outer, nested];

        for result in [
            verify_pinned_root_hierarchy(&mismatched, &[], &[], &[]),
            verify_pinned_root_hierarchy(&[], &mismatched, &[], &[]),
            verify_pinned_root_hierarchy(&[], &[], &mismatched, &[]),
            verify_pinned_root_hierarchy(&mismatched[..1], &[], &mismatched[1..], &[]),
        ] {
            let error = result.expect_err("mismatched nested root must fail closed");
            assert_eq!(error.code, "policy_denied");
        }
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn accepts_same_tree_nesting_and_an_independent_execution_root() {
        let root = std::env::temp_dir().join(format!(
            "sigma-valid-pinned-hierarchy-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let read = root.join("read");
        let nested = read.join("nested");
        let independent = root.join("independent-execution");
        std::fs::create_dir_all(&nested).expect("create nested read tree");
        std::fs::create_dir_all(&independent).expect("create independent execution root");
        let read_roots = vec![
            PinnedMountSource::pin(&read).expect("pin outer read root"),
            PinnedMountSource::pin(&nested).expect("pin nested read root"),
        ];
        let nested_execution =
            vec![PinnedMountSource::pin(&nested).expect("pin nested execution root")];
        let independent_execution =
            vec![PinnedMountSource::pin(&independent).expect("pin independent execution root")];

        verify_pinned_root_hierarchy(&read_roots, &[], &nested_execution, &[])
            .expect("same-tree nested execution root should pass");
        verify_pinned_root_hierarchy(&read_roots, &[], &independent_execution, &[])
            .expect("independent execution root should remain allowed");
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_a_protected_path_from_a_replacement_write_subtree() {
        let root = std::env::temp_dir().join(format!(
            "sigma-protected-write-hierarchy-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let read_path = root.join("read");
        let write_path = read_path.join("write");
        let moved_write = read_path.join("moved-write");
        std::fs::create_dir_all(write_path.join("protected")).expect("create original write tree");
        let read_roots = vec![PinnedMountSource::pin(&read_path).expect("pin read root")];
        let write_roots = vec![PinnedMountSource::pin(&write_path).expect("pin write root")];
        std::fs::rename(&write_path, &moved_write).expect("move original write tree");
        std::fs::create_dir_all(write_path.join("protected"))
            .expect("create replacement write tree");
        let protected_roots = vec![
            PinnedMountSource::pin(&write_path.join("protected"))
                .expect("pin replacement protected path"),
        ];

        let error = verify_pinned_root_hierarchy(&read_roots, &write_roots, &[], &protected_roots)
            .expect_err("protected path from replacement write tree must fail closed");
        assert_eq!(error.code, "policy_denied");
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn rejects_nested_protected_paths_from_different_pinned_trees() {
        let root = std::env::temp_dir().join(format!(
            "sigma-protected-group-hierarchy-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let read_path = root.join("read");
        let protected_path = read_path.join("protected");
        let moved_protected = read_path.join("moved-protected");
        std::fs::create_dir_all(protected_path.join("nested"))
            .expect("create original protected tree");
        let read_roots = vec![PinnedMountSource::pin(&read_path).expect("pin read root")];
        let outer = PinnedMountSource::pin(&protected_path).expect("pin protected root");
        std::fs::rename(&protected_path, &moved_protected).expect("move original protected tree");
        std::fs::create_dir_all(protected_path.join("nested"))
            .expect("create replacement protected tree");
        let nested =
            PinnedMountSource::pin(&protected_path.join("nested")).expect("pin nested replacement");

        let error = verify_pinned_root_hierarchy(&read_roots, &[], &[], &[outer, nested])
            .expect_err("mixed protected trees must fail closed");
        assert_eq!(error.code, "policy_denied");
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn accepts_same_tree_protected_paths_inside_and_outside_write_roots() {
        let root = std::env::temp_dir().join(format!(
            "sigma-valid-protected-hierarchy-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let read_path = root.join("read");
        let write_path = read_path.join("write");
        let protected_path = write_path.join("protected");
        let nested_path = protected_path.join("nested");
        let read_only_path = read_path.join("read-only-protected");
        std::fs::create_dir_all(&nested_path).expect("create protected write tree");
        std::fs::create_dir_all(&read_only_path).expect("create read-only protected tree");
        let read_roots = vec![PinnedMountSource::pin(&read_path).expect("pin read root")];
        let write_roots = vec![PinnedMountSource::pin(&write_path).expect("pin write root")];
        let protected_roots = vec![
            PinnedMountSource::pin(&protected_path).expect("pin protected path"),
            PinnedMountSource::pin(&nested_path).expect("pin nested protected path"),
            PinnedMountSource::pin(&read_only_path).expect("pin read-only protected path"),
        ];

        verify_pinned_root_hierarchy(&read_roots, &write_roots, &[], &protected_roots)
            .expect("same-tree protected paths should pass");
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn executable_replacement_keeps_the_pin_but_fails_destination_attestation() {
        let root = std::env::temp_dir().join(format!(
            "sigma-pinned-executable-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("create executable test root");
        let requested = root.join("requested-tool");
        let moved = root.join("pinned-original");
        let shell = Path::new("/bin/sh")
            .canonicalize()
            .expect("canonical system shell");
        std::fs::copy(shell, &requested).expect("copy executable under test");
        std::fs::set_permissions(&requested, std::fs::Permissions::from_mode(0o700))
            .expect("make copied executable runnable");
        let mut params = non_git_params(&root);
        params.command.executable = requested.to_string_lossy().into_owned();
        params.policy.write_roots.clear();
        let cwd_source = PinnedMountSource::pin(&root).expect("pin cwd");
        let execution_roots = vec![PinnedMountSource::pin(&root).expect("pin execution root")];
        let executable = authorize_linux_executable(&params, &[], &execution_roots, &cwd_source)
            .expect("authorize requested executable");

        std::fs::rename(&requested, &moved).expect("move authorized executable");
        std::fs::write(&requested, "replacement").expect("write replacement executable");
        std::fs::set_permissions(&requested, std::fs::Permissions::from_mode(0o700))
            .expect("make replacement executable-shaped");
        assert!(
            !executable
                .source
                .destination_matches_identity()
                .expect("compare executable identity")
        );
        let mut bind = Command::new("bwrap");
        let error = append_pinned_executable_bind(&mut bind, &executable.source)
            .expect_err("replacement must fail before bwrap setup");
        assert_eq!(error.code, "policy_denied");

        let pinned = executable
            .source
            .fd_path()
            .metadata()
            .expect("inspect pinned file object");
        let original = std::fs::metadata(&moved).expect("inspect moved original executable");
        assert_eq!(
            (pinned.dev(), pinned.ino()),
            (original.dev(), original.ino())
        );
        std::fs::remove_dir_all(root).expect("remove executable test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn separate_argv0_preserves_a_system_shell_alias() {
        use std::os::unix::process::CommandExt;

        let root = std::env::temp_dir().join(format!(
            "sigma-executable-argv0-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("create argv0 test root");
        let mut params = non_git_params(&root);
        params.command.executable = "/bin/sh".into();
        params.policy.write_roots.clear();
        let cwd_source = PinnedMountSource::pin(&root).expect("pin cwd");
        let executable =
            authorize_linux_executable(&params, &linux_system_roots(), &[], &cwd_source)
                .expect("authorize system shell alias");
        assert_eq!(executable.invocation_arg0, OsString::from("/bin/sh"));

        let output = Command::new(executable.source.fd_path())
            .arg0(&executable.invocation_arg0)
            .args(["-c", "printf preserved-argv0"])
            .output()
            .expect("execute shell target with invocation argv0");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"preserved-argv0");
        std::fs::remove_dir_all(root).expect("remove argv0 test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn path_search_skips_non_executable_file_then_rejects_executable_outside_roots() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "sigma-path-executable-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let allowed = root.join("allowed");
        let outside = root.join("outside");
        std::fs::create_dir_all(&allowed).expect("create allowed executable root");
        std::fs::create_dir_all(&outside).expect("create outside executable root");
        let first = allowed.join("tool");
        std::fs::write(&first, "not executable").expect("write non-executable first candidate");
        std::fs::set_permissions(&first, std::fs::Permissions::from_mode(0o600))
            .expect("remove executable permission");
        symlink("/bin/sh", outside.join("tool")).expect("link executable second candidate");
        let mut params = non_git_params(&root);
        params.command.executable = "tool".into();
        params.command.env.insert(
            "PATH".into(),
            std::env::join_paths([&allowed, &outside])
                .expect("join executable search path")
                .to_string_lossy()
                .into_owned(),
        );
        params.policy.write_roots.clear();
        let cwd_source = PinnedMountSource::pin(&root).expect("pin cwd");
        let execution_roots = vec![PinnedMountSource::pin(&allowed).expect("pin allowed root")];

        let error = authorize_linux_executable(&params, &[], &execution_roots, &cwd_source)
            .expect_err("the first runnable PATH candidate is outside execution roots");
        assert_eq!(error.code, "executable_unavailable");
        std::fs::remove_dir_all(root).expect("remove PATH test root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn canonical_executable_destination_preserves_adjacent_script_resources() {
        let root = std::env::temp_dir().join(format!(
            "sigma-executable-adjacent-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).expect("create script root");
        let script = root.join("tool.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\ncat \"$(dirname \"$0\")/resource.txt\"\n",
        )
        .expect("write adjacent-resource script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
            .expect("make script executable");
        std::fs::write(root.join("resource.txt"), "adjacent-resource")
            .expect("write adjacent resource");
        let mut params = non_git_params(&root);
        params.command.executable = script.to_string_lossy().into_owned();
        params.policy.write_roots.clear();
        let cwd_source = PinnedMountSource::pin(&root).expect("pin cwd");
        let execution_roots = vec![PinnedMountSource::pin(&root).expect("pin execution root")];
        let executable = authorize_linux_executable(&params, &[], &execution_roots, &cwd_source)
            .expect("authorize adjacent-resource script");
        assert_eq!(
            executable.source.destination(),
            script.canonicalize().expect("canonical script")
        );
        assert_eq!(executable.invocation_arg0, script.as_os_str().to_owned());

        let output = Command::new(executable.source.destination())
            .output()
            .expect("execute adjacent-resource script");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"adjacent-resource");

        let mut bind = Command::new("bwrap");
        append_pinned_executable_bind(&mut bind, &executable.source)
            .expect("append executable attestation mounts");
        let arguments = bind
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(arguments[0], "--ro-bind");
        assert_eq!(Path::new(&arguments[1]), executable.source.destination());
        assert_eq!(Path::new(&arguments[2]), executable.source.destination());
        assert_eq!(arguments[3], "--ro-bind-fd");
        assert_eq!(Path::new(&arguments[5]), executable.source.destination());
        std::fs::remove_dir_all(root).expect("remove script root");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn relative_executable_authorization_uses_the_pinned_cwd_object() {
        let root = std::env::temp_dir().join(format!(
            "sigma-relative-executable-cwd-{}-{}",
            std::process::id(),
            PROTECTED_GUARD_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let cwd = root.join("cwd");
        let moved_cwd = root.join("moved-cwd");
        std::fs::create_dir_all(&cwd).expect("create cwd");
        let relative_tool = cwd.join("relative-tool");
        std::fs::write(&relative_tool, "original").expect("write original executable");
        std::fs::set_permissions(&relative_tool, std::fs::Permissions::from_mode(0o700))
            .expect("make original executable runnable");
        let mut params = non_git_params(&root);
        params.command.cwd = cwd.clone();
        params.command.executable = "./relative-tool".into();
        params.policy.write_roots.clear();
        let cwd_source = PinnedMountSource::pin(&cwd).expect("pin cwd");
        let execution_roots = vec![PinnedMountSource::pin(&cwd).expect("pin execution root")];

        authorize_linux_executable(&params, &[], &execution_roots, &cwd_source)
            .expect("relative executable in pinned cwd should be authorized");

        std::fs::rename(&cwd, &moved_cwd).expect("move pinned cwd");
        std::fs::create_dir_all(&cwd).expect("create replacement cwd");
        std::fs::write(cwd.join("relative-tool"), "replacement")
            .expect("write replacement executable");
        let error = authorize_linux_executable(&params, &[], &execution_roots, &cwd_source)
            .expect_err("replacement cwd executable must not be authorized");
        assert_eq!(error.code, "executable_unavailable");
        std::fs::remove_dir_all(root).expect("remove test root");
    }
}
