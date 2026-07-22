use crate::process::BrokerState;
use crate::protocol::{
    PROTOCOL_VERSION, RpcError, SharedWriter, read_request, send_error, send_result,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const BOUNDARY_ROOT: &str = "/run/sigma-oci";
const BROKER_SOCKET: &str = "/run/sigma-oci/broker.sock";
const ATTESTATION_PATH: &str = "/run/sigma-oci/attestation.json";
const ARTIFACT_ROOT: &str = "/run/sigma-oci/artifacts";
const SAFE_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PACKAGE_TIMEOUT: Duration = Duration::from_secs(600);
const PROTECTED_PATHS: &[&str] = &[
    "/app",
    "/logs",
    "/opt/agent-cli",
    "/opt/sigma-control",
    "/opt/sigma-helper",
    "/opt/sigma-package",
    "/root/.docker",
    "/root/.ssh",
    "/run/credentials",
    "/run/secrets",
    "/run/sigma-oci",
    "/usr/local/bin/agent",
    "/usr/local/bin/bwrap",
];

#[derive(Clone)]
struct InstalledPackage {
    name: String,
    version: String,
    source: String,
    digest: String,
}

impl InstalledPackage {
    fn value(&self) -> Value {
        json!({
            "name": self.name,
            "version": self.version,
            "source": self.source,
            "digest": self.digest,
        })
    }
}

#[derive(Clone)]
struct ManagedIdentity {
    engine: String,
    selector: String,
    target_id: String,
    target_started_at: String,
    image_id: String,
    labels_digest: String,
    helper_digest: String,
    attestation_digest: String,
}

pub(crate) struct ManagedServerContext {
    identity: ManagedIdentity,
    workspace: PathBuf,
    attempts: Mutex<HashSet<String>>,
    installed: Mutex<Vec<InstalledPackage>>,
    runtime_aliases: Mutex<BTreeSet<String>>,
    preparation_lock: Mutex<()>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagedEnvironmentPrepareParams {
    protocol_version: u32,
    session_id: String,
    requested_executable: String,
    packages: Vec<String>,
}

struct ServerConfig {
    workspace: PathBuf,
    engine: String,
    network: String,
}

pub(crate) fn try_run_managed_server() -> Option<i32> {
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() != Some("--managed-server") {
        return None;
    }
    Some(match parse_server_config(arguments.collect()) {
        Ok(config) => match run_server(config) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!(
                    "managed broker startup failed [{}]: {}",
                    error.code, error.message
                );
                2
            }
        },
        Err(error) => {
            eprintln!(
                "managed broker arguments failed [{}]: {}",
                error.code, error.message
            );
            2
        }
    })
}

fn parse_server_config(arguments: Vec<String>) -> Result<ServerConfig, RpcError> {
    let mut workspace = None;
    let mut engine = None;
    let mut network = None;
    let mut index = 0;
    while index < arguments.len() {
        let flag = arguments[index].as_str();
        let value = arguments.get(index + 1).ok_or_else(|| {
            RpcError::new(
                "managed_environment_bootstrap_invalid",
                format!("missing value for {flag}"),
            )
        })?;
        match flag {
            "--workspace" if workspace.is_none() => workspace = Some(PathBuf::from(value)),
            "--engine" if engine.is_none() => engine = Some(value.clone()),
            "--network" if network.is_none() => network = Some(value.clone()),
            _ => {
                return Err(RpcError::new(
                    "managed_environment_bootstrap_invalid",
                    format!("unsupported or repeated managed broker argument '{flag}'"),
                ));
            }
        }
        index += 2;
    }
    let requested_workspace = workspace.ok_or_else(|| {
        RpcError::new(
            "managed_environment_bootstrap_invalid",
            "--workspace is required",
        )
    })?;
    let workspace = requested_workspace.canonicalize().map_err(|error| {
        RpcError::new(
            "managed_environment_bootstrap_invalid",
            format!(
                "cannot resolve managed workspace '{}': {error}",
                requested_workspace.display()
            ),
        )
    })?;
    if !workspace.is_dir() || workspace == Path::new("/") {
        return Err(RpcError::new(
            "managed_environment_bootstrap_invalid",
            "managed workspace must be a non-root directory",
        ));
    }
    let engine = engine.unwrap_or_else(|| "docker".into());
    if engine != "docker" && engine != "podman" {
        return Err(RpcError::new(
            "managed_environment_bootstrap_invalid",
            "managed broker engine must be docker or podman",
        ));
    }
    let network = network.unwrap_or_else(|| "none".into());
    if network != "full" {
        return Err(RpcError::new(
            "managed_environment_required_unavailable",
            "managed environment preparation requires an explicitly full-network disposable target",
        ));
    }
    if unsafe { libc::geteuid() } != 0 {
        return Err(RpcError::new(
            "managed_environment_required_unavailable",
            "managed broker bootstrap must run as root in the disposable target",
        ));
    }
    Ok(ServerConfig {
        workspace,
        engine,
        network,
    })
}

fn run_server(config: ServerConfig) -> Result<(), RpcError> {
    if Path::new(BOUNDARY_ROOT).exists() {
        return Err(RpcError::new(
            "managed_environment_boundary_exists",
            "the fixed managed broker boundary already exists",
        ));
    }
    fs::create_dir(BOUNDARY_ROOT).map_err(RpcError::from)?;
    set_mode(Path::new(BOUNDARY_ROOT), 0o700)?;
    fs::create_dir(ARTIFACT_ROOT).map_err(RpcError::from)?;
    set_mode(Path::new(ARTIFACT_ROOT), 0o700)?;
    let listener = UnixListener::bind(BROKER_SOCKET).map_err(RpcError::from)?;
    set_mode(Path::new(BROKER_SOCKET), 0o660)?;
    let context = Arc::new(ManagedServerContext::new(&config)?);
    write_attestation(&context.attestation_document())?;
    set_mode(Path::new(BOUNDARY_ROOT), 0o555)?;

    let state = Arc::new(BrokerState::new_managed(
        instance_id(),
        Path::new(ARTIFACT_ROOT),
        context,
    ));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let state = state.clone();
                thread::spawn(move || serve_connection(state, stream));
            }
            Err(error) => {
                state.shutdown();
                return Err(RpcError::new(
                    "broker_io_error",
                    format!("managed broker socket failed: {error}"),
                ));
            }
        }
    }
    state.shutdown();
    Ok(())
}

fn serve_connection(state: Arc<BrokerState>, mut stream: UnixStream) {
    let writer_stream = match stream.try_clone() {
        Ok(value) => value,
        Err(_) => return,
    };
    let writer: SharedWriter = Arc::new(Mutex::new(Box::new(writer_stream)));
    loop {
        let request = match read_request(&mut stream) {
            Ok(Some(value)) => value,
            Ok(None) | Err(_) => return,
        };
        if request.protocol_version != PROTOCOL_VERSION {
            send_error(
                &writer,
                request.request_id,
                RpcError::new(
                    "unsupported_protocol",
                    format!(
                        "expected protocol {PROTOCOL_VERSION}, got {}",
                        request.protocol_version
                    ),
                ),
            );
            continue;
        }
        if request.method == "shutdown" {
            send_result(&writer, request.request_id, json!({ "shutdown": true }));
            state.shutdown();
            return;
        }
        if let Err(error) = state.begin_request(request.request_id, &request.method) {
            send_error(&writer, request.request_id, error);
            continue;
        }
        let request_state = state.clone();
        let request_writer = writer.clone();
        thread::spawn(move || crate::handle_request(request_state, request_writer, request));
    }
}

impl ManagedServerContext {
    fn new(config: &ServerConfig) -> Result<Self, RpcError> {
        debug_assert_eq!(config.network, "full");
        let helper_digest = file_digest(&std::env::current_exe().map_err(RpcError::from)?)?;
        let root = fs::metadata("/").map_err(RpcError::from)?;
        let mount_namespace = fs::read_link("/proc/self/ns/mnt")
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|_| "unavailable".into());
        let started = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let target_seed = json!({
            "pid": std::process::id(),
            "started": started.to_string(),
            "mountNamespace": mount_namespace,
            "rootDevice": root.dev(),
            "rootInode": root.ino(),
        });
        let target_id = stable_sha256(&target_seed);
        let target_started_at = format!("unix-nanos:{started}");
        let image_id = stable_sha256(&json!({
            "rootDevice": root.dev(),
            "rootInode": root.ino(),
            "osRelease": fs::read_to_string("/etc/os-release").unwrap_or_default(),
        }));
        let labels_digest = stable_sha256(&json!({
            "managedBy": "sigma-fixed-launcher",
            "network": config.network,
            "rootKind": "container_cow",
        }));
        let selector = format!("fixed-managed/{}", &target_id[7..39]);
        let attestation_payload = json!({
            "protocolVersion": 1,
            "engine": config.engine,
            "selector": selector,
            "targetId": target_id,
            "targetStartedAt": target_started_at,
            "imageId": image_id,
            "imageDigest": Value::Null,
            "labelsDigest": labels_digest,
            "helperDigest": helper_digest,
        });
        let attestation_digest = stable_sha256(&attestation_payload);
        Ok(Self {
            identity: ManagedIdentity {
                engine: config.engine.clone(),
                selector,
                target_id,
                target_started_at,
                image_id,
                labels_digest,
                helper_digest,
                attestation_digest,
            },
            workspace: config.workspace.clone(),
            attempts: Mutex::new(HashSet::new()),
            installed: Mutex::new(Vec::new()),
            runtime_aliases: Mutex::new(BTreeSet::new()),
            preparation_lock: Mutex::new(()),
        })
    }

    fn attestation_document(&self) -> Value {
        let proof_payload = json!({
            "protocolVersion": 1,
            "targetAttestationDigest": self.identity.attestation_digest,
            "targetId": self.identity.target_id,
            "targetStartedAt": self.identity.target_started_at,
            "rootKind": "container_cow",
            "effectiveNetwork": "full",
            "disposable": true,
            "protectedPaths": PROTECTED_PATHS,
        });
        let mut proof = proof_payload.as_object().cloned().unwrap_or_default();
        proof.insert(
            "proofDigest".into(),
            Value::String(stable_sha256(&proof_payload)),
        );
        json!({
            "protocolVersion": 1,
            "engine": self.identity.engine,
            "selector": self.identity.selector,
            "targetId": self.identity.target_id,
            "targetStartedAt": self.identity.target_started_at,
            "imageId": self.identity.image_id,
            "labelsDigest": self.identity.labels_digest,
            "helperDigest": self.identity.helper_digest,
            "attestationDigest": self.identity.attestation_digest,
            "managedEnvironment": Value::Object(proof),
            "workspace": self.workspace,
        })
    }

    pub(crate) fn decorate_doctor(&self, mut report: Value) -> Value {
        report["sandbox"]["backend"] = Value::String("oci".into());
        report["container"] = json!({
            "available": true,
            "backend": "oci",
            "engine": self.identity.engine,
            "target": "managed",
            "targetId": self.identity.target_id,
            "targetStartedAt": self.identity.target_started_at,
            "imageId": self.identity.image_id,
            "helperDigest": self.identity.helper_digest,
            "attestationDigest": self.identity.attestation_digest,
        });
        report["capabilities"]["managedEnvironment"] = json!({
            "available": true,
            "prepare": true,
        });
        report["capabilities"]["runtimeDataDigest"] = Value::String(self.runtime_data_digest());
        if let Ok(aliases) = self.runtime_aliases.lock() {
            let mut commands = report["capabilities"]["runtimeCommands"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect::<BTreeSet<_>>();
            commands.extend(aliases.iter().cloned());
            report["capabilities"]["runtimeCommands"] =
                Value::Array(commands.into_iter().map(Value::String).collect());
        }
        report
    }

    pub(crate) fn prepare(
        &self,
        state: &BrokerState,
        request: ManagedEnvironmentPrepareParams,
    ) -> Result<Value, RpcError> {
        let request = canonical_request(request)?;
        if !state.has_scratch_session(&request.session_id)? {
            return Err(RpcError::new(
                "managed_environment_required_unavailable",
                "managed preparation requires a live broker-issued session scratch lease",
            ));
        }
        let opportunity = stable_sha256(&json!({
            "sessionId": request.session_id,
            "requestedExecutable": request.requested_executable,
        }));
        {
            let mut attempts = self.attempts.lock().map_err(lock_error)?;
            if !attempts.insert(opportunity.clone()) {
                return Err(RpcError::new(
                    "managed_environment_prepare_repeated",
                    "the recovery opportunity for this executable has already been consumed",
                ));
            }
        }
        let _preparation = self.preparation_lock.lock().map_err(lock_error)?;
        let previous_closure =
            runtime_closure(&self.decorate_doctor(crate::sandbox::doctor_report()))?;
        let manager = package_manager()?;
        install_packages(&manager, &request.packages, &self.workspace)?;
        let installed = query_installed_packages(&manager, &request.packages)?;
        if resolve_executable(&request.requested_executable).is_none() {
            return Err(RpcError::new(
                "runtime_data_unavailable",
                "the declared package set did not provide the requested executable",
            ));
        }
        {
            let mut evidence = self.installed.lock().map_err(lock_error)?;
            for item in &installed {
                if let Some(existing) = evidence.iter_mut().find(|value| value.name == item.name) {
                    *existing = item.clone();
                } else {
                    evidence.push(item.clone());
                }
            }
            evidence.sort_by(|left, right| left.name.cmp(&right.name));
        }
        if let Some(alias) = executable_alias(&request.requested_executable) {
            self.runtime_aliases
                .lock()
                .map_err(lock_error)?
                .insert(alias);
        }
        let current_closure =
            runtime_closure(&self.decorate_doctor(crate::sandbox::doctor_report()))?;
        if current_closure["digest"] == previous_closure["digest"] {
            return Err(RpcError::new(
                "managed_environment_prepare_ineffective",
                "managed preparation did not change the authenticated runtime closure",
            ));
        }
        let installed_values = installed
            .iter()
            .map(InstalledPackage::value)
            .collect::<Vec<_>>();
        let packages = request.packages;
        let attempt_digest = stable_sha256(&json!({
            "opportunity": opportunity,
            "packages": packages,
        }));
        let installed_evidence_digest = stable_sha256(&Value::Array(installed_values.clone()));
        let payload = json!({
            "protocolVersion": 1,
            "status": "prepared",
            "sessionId": request.session_id,
            "requestedExecutable": request.requested_executable,
            "packages": packages,
            "installedPackages": installed_values,
            "packageManager": manager.name,
            "signaturePolicy": "trusted-system-package-manager-defaults",
            "attemptDigest": attempt_digest,
            "installedEvidenceDigest": installed_evidence_digest,
            "previousRuntimeClosureDigest": previous_closure["digest"],
            "runtimeClosure": current_closure,
        });
        let mut result = payload.as_object().cloned().unwrap_or_default();
        result.insert(
            "receiptDigest".into(),
            Value::String(stable_sha256(&payload)),
        );
        Ok(Value::Object(result))
    }

    fn runtime_data_digest(&self) -> String {
        let values = self
            .installed
            .lock()
            .map(|items| {
                items
                    .iter()
                    .map(InstalledPackage::value)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        stable_sha256(&Value::Array(values))
    }
}

struct PackageManager {
    name: &'static str,
    executable: PathBuf,
}

fn package_manager() -> Result<PackageManager, RpcError> {
    for name in ["apt-get", "apk", "dnf", "microdnf", "yum"] {
        if let Some(executable) = trusted_executable(name) {
            return Ok(PackageManager { name, executable });
        }
    }
    Err(RpcError::new(
        "runtime_data_unavailable",
        "the disposable target has no supported trusted system package manager",
    ))
}

fn install_packages(
    manager: &PackageManager,
    packages: &[String],
    workspace: &Path,
) -> Result<(), RpcError> {
    if manager.name == "apt-get" {
        run_package_command(manager, &["update".into()], workspace)?;
        let mut arguments = vec![
            "install".into(),
            "-y".into(),
            "--no-install-recommends".into(),
            "--".into(),
        ];
        arguments.extend(packages.iter().cloned());
        run_package_command(manager, &arguments, workspace)
    } else if manager.name == "apk" {
        let mut arguments = vec!["add".into(), "--no-progress".into()];
        arguments.extend(packages.iter().cloned());
        run_package_command(manager, &arguments, workspace)
    } else {
        let mut arguments = vec!["-y".into(), "install".into()];
        arguments.extend(packages.iter().cloned());
        run_package_command(manager, &arguments, workspace)
    }
}

fn run_package_command(
    manager: &PackageManager,
    arguments: &[String],
    workspace: &Path,
) -> Result<(), RpcError> {
    let bwrap = trusted_executable("bwrap").ok_or_else(|| {
        RpcError::new(
            "managed_environment_required_unavailable",
            "managed preparation requires the trusted bubblewrap boundary",
        )
    })?;
    let mut command = Command::new(bwrap);
    command.args([
        "--die-with-parent",
        "--new-session",
        "--bind",
        "/",
        "/",
        "--dev-bind",
        "/dev",
        "/dev",
        "--proc",
        "/proc",
        "--clearenv",
        "--setenv",
        "PATH",
        SAFE_PATH,
        "--setenv",
        "HOME",
        "/root",
        "--setenv",
        "DEBIAN_FRONTEND",
        "noninteractive",
        "--chdir",
        "/",
    ]);
    let mut hidden = BTreeSet::new();
    hidden.insert(workspace.to_path_buf());
    for path in [
        "/app",
        "/logs",
        "/root/.docker",
        "/root/.ssh",
        "/run/credentials",
        "/run/secrets",
    ] {
        hidden.insert(PathBuf::from(path));
    }
    for path in hidden {
        if path.exists() {
            if !fs::symlink_metadata(&path)
                .map_err(RpcError::from)?
                .is_dir()
            {
                return Err(RpcError::new(
                    "managed_environment_boundary_unsafe",
                    format!(
                        "protected managed path '{}' is not a directory",
                        path.display()
                    ),
                ));
            }
            command.arg("--tmpfs").arg(path);
        }
    }
    for path in [
        "/opt/agent-cli",
        "/opt/sigma-control",
        "/opt/sigma-helper",
        "/opt/sigma-package",
        "/run/sigma-oci",
        "/usr/local/bin/agent",
        "/usr/local/bin/bwrap",
    ] {
        let path = Path::new(path);
        if path.exists() {
            command.arg("--ro-bind").arg(path).arg(path);
        }
    }
    command.arg("--").arg(&manager.executable).args(arguments);
    command
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let status = run_bounded(&mut command, PACKAGE_TIMEOUT)?;
    if status.success() {
        Ok(())
    } else {
        Err(RpcError::new(
            "managed_environment_prepare_failed",
            format!(
                "trusted package manager '{}' exited unsuccessfully",
                manager.name
            ),
        ))
    }
}

fn query_installed_packages(
    manager: &PackageManager,
    packages: &[String],
) -> Result<Vec<InstalledPackage>, RpcError> {
    packages
        .iter()
        .map(|package| {
            let version = match manager.name {
                "apt-get" => capture_command(
                    trusted_executable("dpkg-query").ok_or_else(|| {
                        RpcError::new(
                            "runtime_data_unavailable",
                            "dpkg-query is unavailable after apt installation",
                        )
                    })?,
                    &["-W", "-f=${Version}", package],
                )?,
                "apk" => capture_command(manager.executable.clone(), &["info", "-v", package])?,
                _ => capture_command(
                    trusted_executable("rpm").ok_or_else(|| {
                        RpcError::new(
                            "runtime_data_unavailable",
                            "rpm is unavailable after package installation",
                        )
                    })?,
                    &["-q", "--qf", "%{VERSION}-%{RELEASE}", package],
                )?,
            };
            let source = format!("trusted-system-package-manager:{}", manager.name);
            let digest = stable_sha256(&json!({
                "name": package,
                "version": version,
                "source": source,
            }));
            Ok(InstalledPackage {
                name: package.clone(),
                version,
                source,
                digest,
            })
        })
        .collect()
}

fn capture_command(executable: PathBuf, arguments: &[&str]) -> Result<String, RpcError> {
    let output = Command::new(executable)
        .args(arguments)
        .env_clear()
        .env("PATH", SAFE_PATH)
        .stdin(Stdio::null())
        .output()
        .map_err(RpcError::from)?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return Err(RpcError::new(
            "runtime_data_unavailable",
            "installed package version evidence is unavailable",
        ));
    }
    let value = String::from_utf8(output.stdout)
        .map_err(|_| RpcError::new("runtime_data_unavailable", "package version is not UTF-8"))?
        .trim()
        .to_owned();
    if value.is_empty() || value.len() > 512 || value.contains('\0') {
        return Err(RpcError::new(
            "runtime_data_unavailable",
            "installed package version evidence is invalid",
        ));
    }
    Ok(value)
}

fn canonical_request(
    mut request: ManagedEnvironmentPrepareParams,
) -> Result<ManagedEnvironmentPrepareParams, RpcError> {
    let session_valid = !request.session_id.is_empty()
        && request.session_id.len() <= 128
        && request
            .session_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.'));
    let executable_valid = executable_alias(&request.requested_executable).is_some()
        || (Path::new(&request.requested_executable).is_absolute()
            && !request
                .requested_executable
                .split('/')
                .any(|part| part == ".."));
    request.packages.sort();
    request.packages.dedup();
    let packages_valid = !request.packages.is_empty()
        && request.packages.len() <= 32
        && request.packages.iter().all(|package| {
            package.len() <= 128
                && package
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && package.bytes().all(|value| {
                    value.is_ascii_alphanumeric() || matches!(value, b'+' | b'.' | b'_' | b'-')
                })
        });
    if request.protocol_version != 1 || !session_valid || !executable_valid || !packages_valid {
        return Err(RpcError::new(
            "managed_environment_prepare_invalid",
            "managed environment preparation request is invalid",
        ));
    }
    Ok(request)
}

fn executable_alias(value: &str) -> Option<String> {
    let alias = Path::new(value).file_name()?.to_str()?;
    if alias.is_empty()
        || alias.len() > 128
        || !alias.as_bytes()[0].is_ascii_alphanumeric()
        || !alias
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
    {
        return None;
    }
    Some(alias.to_owned())
}

fn resolve_executable(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
    if path.is_absolute() {
        return trusted_path(path);
    }
    trusted_executable(value)
}

fn trusted_executable(name: &str) -> Option<PathBuf> {
    SAFE_PATH
        .split(':')
        .find_map(|directory| trusted_path(&Path::new(directory).join(name)))
}

fn trusted_path(candidate: &Path) -> Option<PathBuf> {
    let canonical = candidate.canonicalize().ok()?;
    let metadata = canonical.metadata().ok()?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
        || metadata.mode() & 0o111 == 0
    {
        return None;
    }
    let mut ancestor = canonical.parent();
    while let Some(directory) = ancestor {
        let info = directory.metadata().ok()?;
        if !info.is_dir() || info.uid() != 0 || info.mode() & 0o022 != 0 {
            return None;
        }
        ancestor = directory.parent();
    }
    Some(canonical)
}

fn runtime_closure(report: &Value) -> Result<Value, RpcError> {
    let platform = report["platform"].as_str().ok_or_else(|| {
        RpcError::new(
            "broker_protocol_error",
            "managed doctor platform is missing",
        )
    })?;
    let architecture = report["architecture"].as_str().ok_or_else(|| {
        RpcError::new(
            "broker_protocol_error",
            "managed doctor architecture is missing",
        )
    })?;
    let mut paths = report["capabilities"]["executableSearchPaths"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    paths.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
    paths.dedup();
    let mut commands = report["capabilities"]["runtimeCommands"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    commands.sort_by(|left, right| left.as_str().cmp(&right.as_str()));
    commands.dedup();
    let runtime_data_digest = report["capabilities"]["runtimeDataDigest"]
        .as_str()
        .ok_or_else(|| {
            RpcError::new(
                "broker_protocol_error",
                "managed doctor runtime data digest is missing",
            )
        })?;
    let payload = json!({
        "protocolVersion": 1,
        "platform": platform,
        "architecture": architecture,
        "executableSearchPathsDigest": stable_sha256(&Value::Array(paths.clone())),
        "runtimeCommandsDigest": stable_sha256(&Value::Array(commands.clone())),
        "runtimeDataDigest": runtime_data_digest,
        "targetAttestationDigest": report["container"]["attestationDigest"],
        "complete": report["capabilities"]["runtimeCommandSnapshotComplete"] == Value::Bool(true)
            && !paths.is_empty(),
    });
    let mut result = payload.as_object().cloned().unwrap_or_default();
    result.insert("digest".into(), Value::String(stable_sha256(&payload)));
    Ok(Value::Object(result))
}

fn run_bounded(command: &mut Command, timeout: Duration) -> Result<ExitStatus, RpcError> {
    let mut child = command.spawn().map_err(RpcError::from)?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(RpcError::from)? {
            return Ok(status);
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RpcError::new(
                "managed_environment_prepare_timeout",
                "trusted package manager exceeded its bounded preparation deadline",
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn write_attestation(value: &Value) -> Result<(), RpcError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(ATTESTATION_PATH)
        .map_err(RpcError::from)?;
    let payload = serde_json::to_vec(value).map_err(|error| {
        RpcError::new(
            "broker_protocol_error",
            format!("cannot encode managed attestation: {error}"),
        )
    })?;
    file.write_all(&payload).map_err(RpcError::from)?;
    file.write_all(b"\n").map_err(RpcError::from)?;
    file.sync_all().map_err(RpcError::from)?;
    set_mode(Path::new(ATTESTATION_PATH), 0o444)
}

fn set_mode(path: &Path, mode: u32) -> Result<(), RpcError> {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(RpcError::from)
}

fn file_digest(path: &Path) -> Result<String, RpcError> {
    let mut file = fs::File::open(path).map_err(RpcError::from)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(RpcError::from)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn stable_sha256(value: &Value) -> String {
    let encoded = serde_json::to_vec(&canonical_value(value)).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(encoded);
    format!("sha256:{:x}", hasher.finalize())
}

fn canonical_value(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_value).collect()),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let mut result = Map::new();
            for key in keys {
                result.insert(key.clone(), canonical_value(&values[key]));
            }
            Value::Object(result)
        }
        _ => value.clone(),
    }
}

fn instance_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("managed-{}-{nanos}", std::process::id())
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new("broker_internal_error", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_request_rejects_options_and_normalizes_packages() {
        let request = canonical_request(ManagedEnvironmentPrepareParams {
            protocol_version: 1,
            session_id: "session-1".into(),
            requested_executable: "tool".into(),
            packages: vec!["zlib".into(), "alpha+dev".into(), "zlib".into()],
        })
        .unwrap();
        assert_eq!(request.packages, ["alpha+dev", "zlib"]);
        for invalid in ["-option", "../escape", "name/child", ""] {
            assert!(
                canonical_request(ManagedEnvironmentPrepareParams {
                    protocol_version: 1,
                    session_id: "session-1".into(),
                    requested_executable: "tool".into(),
                    packages: vec![invalid.into()],
                })
                .is_err()
            );
        }
    }

    #[test]
    fn stable_digest_is_object_order_independent() {
        assert_eq!(
            stable_sha256(&json!({"b": [2, {"z": 1, "a": 0}], "a": true})),
            stable_sha256(&json!({"a": true, "b": [2, {"a": 0, "z": 1}]})),
        );
    }

    #[test]
    fn executable_alias_is_bounded_and_path_safe() {
        assert_eq!(
            executable_alias("/usr/bin/example-tool").as_deref(),
            Some("example-tool")
        );
        assert!(executable_alias("bad alias").is_none());
        assert!(executable_alias(".hidden").is_none());
    }
}
