use crate::protocol::RpcError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir, read_dir, read_to_string, remove_dir, remove_file, write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SandboxMode {
    Required,
    Unsafe,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    None,
    Full,
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
    pub protected_paths: Vec<PathBuf>,
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
}

static STATUS: OnceLock<Mutex<Option<SandboxStatus>>> = OnceLock::new();
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

pub fn doctor_report() -> Value {
    let status = sandbox_status();
    let network_modes = if status.available {
        json!(["none", "full"])
    } else {
        json!([])
    };
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
            "hardening": {
                "landlockAbi": status.landlock_abi,
                "noNewPrivileges": status.no_new_privileges,
                "seccompFilter": status.seccomp_filter,
                "lessPrivilegedAppContainer": status.less_privileged_appcontainer,
            },
        },
        "capabilities": {
            "foreground": true,
            "background": true,
            "stdin": true,
            "pty": cfg!(any(target_os = "linux", target_os = "windows")) && status.available,
            "networkModes": network_modes,
        }
    })
}

pub struct PreparedCommand {
    pub command: Command,
    pub bootstrap_stdin: Vec<u8>,
    pub protected_path_guards: Vec<ProtectedPathGuard>,
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
) -> Result<PreparedCommand, RpcError> {
    validate(params, allow_unsafe)?;
    let guards = match params.policy.sandbox {
        SandboxMode::Required => create_missing_protected_guards(params)?,
        SandboxMode::Unsafe => Vec::new(),
    };
    let mut prepared = match params.policy.sandbox {
        SandboxMode::Required => build_sandboxed_command(params),
        SandboxMode::Unsafe => build_host_command(params),
    }?;
    prepared.protected_path_guards = guards;
    Ok(prepared)
}

fn validate(params: &ProcessParams, allow_unsafe: bool) -> Result<(), RpcError> {
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
    if params.policy.sandbox == SandboxMode::Unsafe
        && (!allow_unsafe || !params.policy.unsafe_host_exec_approved)
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
        let canonical = root.canonicalize().map_err(|error| {
            RpcError::new("policy_denied", format!("invalid sandbox root: {error}"))
        })?;
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
        if name.eq_ignore_ascii_case(".git") || name.eq_ignore_ascii_case(".agent") {
            return Err(RpcError::new(
                "policy_denied",
                "metadata directories cannot be writable roots",
            ));
        }
    }
    let all_roots = params
        .policy
        .read_roots
        .iter()
        .chain(params.policy.write_roots.iter())
        .map(|root| root.canonicalize())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            RpcError::new("policy_denied", format!("invalid sandbox root: {error}"))
        })?;
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
        let key = if cfg!(windows) {
            canonical.to_string_lossy().to_lowercase()
        } else {
            canonical.to_string_lossy().into_owned()
        };
        resolved.entry(key).or_insert(canonical);
    }
    Ok(resolved.into_values().collect())
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
    Ok(canonical.join(suffix))
}

fn canonical_roots(roots: &[PathBuf]) -> Result<Vec<PathBuf>, RpcError> {
    roots
        .iter()
        .map(|root| {
            root.canonicalize().map_err(|error| {
                RpcError::new("policy_denied", format!("invalid sandbox root: {error}"))
            })
        })
        .collect()
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

fn configure_common(command: &mut Command, params: &ProcessParams) {
    command.current_dir(&params.command.cwd);
    command.env_clear();
    command.envs(&params.command.env);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
    })
}

#[cfg(target_os = "linux")]
fn build_sandboxed_command(params: &ProcessParams) -> Result<PreparedCommand, RpcError> {
    const HELPER_MOUNT: &str = "/.sigma-exec";
    let bwrap = find_in_path("bwrap")
        .ok_or_else(|| RpcError::new("sandbox_unavailable", "bubblewrap not found"))?;
    let mut command = Command::new(bwrap);
    command.args(["--die-with-parent", "--new-session", "--unshare-all"]);
    if params.policy.network == NetworkMode::Full {
        command.arg("--share-net");
    }
    let system_roots = linux_system_roots();
    let read_roots = canonical_roots(&params.policy.read_roots)?;
    let write_roots = canonical_roots(&params.policy.write_roots)?;
    for root in &system_roots {
        let value = root.to_string_lossy();
        command.args(["--ro-bind", value.as_ref(), value.as_ref()]);
    }
    command.args(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]);
    bind_roots(&mut command, &params.policy.read_roots, true)?;
    bind_roots(&mut command, &params.policy.write_roots, false)?;
    bind_protected(&mut command, params)?;
    command.arg("--clearenv");
    for (key, value) in &params.command.env {
        command.args(["--setenv", key, value]);
    }
    let cwd = params
        .command
        .cwd
        .canonicalize()
        .map_err(|error| RpcError::new("policy_denied", format!("invalid cwd: {error}")))?;
    let helper = std::env::current_exe().map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!("cannot resolve sigma-exec hardening helper: {error}"),
        )
    })?;
    command.arg("--ro-bind").arg(&helper).arg(HELPER_MOUNT);
    command.args(["--chdir", cwd.to_string_lossy().as_ref(), "--"]);
    command
        .arg(HELPER_MOUNT)
        .arg(crate::linux_hardening::INTERNAL_HARDENED_LAUNCHER);
    for root in system_roots
        .iter()
        .map(PathBuf::as_path)
        .chain(read_roots.iter().map(PathBuf::as_path))
        .chain([
            Path::new("/tmp"),
            Path::new("/proc"),
            Path::new("/dev"),
            Path::new(HELPER_MOUNT),
        ])
    {
        command.arg("--read").arg(root);
    }
    for root in write_roots
        .iter()
        .map(PathBuf::as_path)
        .chain([Path::new("/tmp"), Path::new("/dev")])
    {
        command.arg("--write").arg(root);
    }
    command.arg("--");
    if params.pty {
        command
            .arg(HELPER_MOUNT)
            .arg("--internal-unix-pty-launcher")
            .arg(params.pty_columns.to_string())
            .arg(params.pty_rows.to_string())
            .arg(&params.command.executable)
            .args(&params.command.args);
    } else {
        command
            .arg(&params.command.executable)
            .args(&params.command.args);
    }
    configure_common(&mut command, params);
    Ok(PreparedCommand {
        command,
        bootstrap_stdin: Vec::new(),
        protected_path_guards: Vec::new(),
    })
}

#[cfg(target_os = "windows")]
fn build_sandboxed_command(params: &ProcessParams) -> Result<PreparedCommand, RpcError> {
    crate::windows_sandbox::prepare_command(params)
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn build_sandboxed_command(_params: &ProcessParams) -> Result<PreparedCommand, RpcError> {
    Err(RpcError::new(
        "sandbox_unavailable",
        "required sandbox backend is unavailable on this platform",
    ))
}

#[cfg(target_os = "linux")]
fn bind_roots(command: &mut Command, roots: &[PathBuf], read_only: bool) -> Result<(), RpcError> {
    for root in roots {
        let canonical = root.canonicalize().map_err(|error| {
            RpcError::new("policy_denied", format!("invalid sandbox root: {error}"))
        })?;
        let value = canonical.to_string_lossy().into_owned();
        command.args([
            if read_only { "--ro-bind" } else { "--bind" },
            &value,
            &value,
        ]);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn bind_protected(command: &mut Command, params: &ProcessParams) -> Result<(), RpcError> {
    let read_roots = canonical_roots(&params.policy.read_roots)?;
    let derived = minimal_roots(&read_roots)
        .into_iter()
        .flat_map(|root| [root.join(".git"), root.join(".agent")]);
    for item in params.policy.protected_paths.iter().cloned().chain(derived) {
        if !item.exists() {
            continue;
        }
        let canonical = item.canonicalize().map_err(|error| {
            RpcError::new("policy_denied", format!("invalid protected path: {error}"))
        })?;
        let value = canonical.to_string_lossy().into_owned();
        command.args(["--ro-bind", &value, &value]);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|path| path.join(name))
            .find(|candidate| candidate.is_file())
    })
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
fn detect_sandbox() -> SandboxStatus {
    let Some(bwrap) = find_in_path("bwrap") else {
        return SandboxStatus {
            available: false,
            backend: "bubblewrap",
            self_test_passed: false,
            setup_required: true,
            reason: Some("bubblewrap is not installed".into()),
            landlock_abi: None,
            no_new_privileges: false,
            seccomp_filter: false,
            less_privileged_appcontainer: false,
        };
    };
    let base_passed = Command::new(&bwrap)
        .args([
            "--die-with-parent",
            "--new-session",
            "--unshare-all",
            "--ro-bind",
            "/",
            "/",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--",
            "/bin/true",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
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
            "--ro-bind",
            "/",
            "/",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--",
        ])
        .arg(&helper)
        .arg(crate::linux_hardening::INTERNAL_HARDENED_LAUNCHER)
        .args(["--read", "/", "--write", "/tmp", "--write", "/dev", "--"])
        .arg(&helper)
        .args([
            "--internal-unix-pty-launcher",
            "80",
            "24",
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
                protected_paths: vec![root.join(".git"), root.join(".agent")],
                unsafe_host_exec_approved: false,
            },
            max_output_bytes: 1024,
            timeout_ms: Some(1_000),
            idle_timeout_ms: None,
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
}
