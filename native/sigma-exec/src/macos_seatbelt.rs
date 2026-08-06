use crate::protocol::RpcError;
use crate::sandbox::{
    NetworkMode, PreparedCommand, ProcessParams, configure_common, protected_path_candidates,
};
use crate::scratch::{DisposableWorkspace, ScratchLease};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";
const INTERNAL_PROBE: &str = "--internal-macos-seatbelt-probe";
const BASE_POLICY: &str = include_str!("macos_seatbelt_base.sbpl");
const PLATFORM_POLICY: &str = include_str!("macos_seatbelt_platform.sbpl");

#[derive(Clone, Copy)]
enum AccessKind {
    File,
    Directory,
}

struct ProfileParameter {
    name: String,
    value: PathBuf,
}

struct SeatbeltProfile {
    text: String,
    parameters: Vec<ProfileParameter>,
}

pub(crate) fn try_run_internal_mode() -> Option<i32> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next()?;
    if arguments.next()? != OsStr::new(INTERNAL_PROBE) {
        return None;
    }
    Some(run_internal_probe(arguments.collect()))
}

fn run_internal_probe(arguments: Vec<OsString>) -> i32 {
    if arguments.len() != 6 {
        eprintln!(
            "macOS Seatbelt probe requires mode, readable, writable, forbidden, protected, and port arguments"
        );
        return 2;
    }
    let mode = arguments[0].to_string_lossy();
    let readable = PathBuf::from(&arguments[1]);
    let writable = PathBuf::from(&arguments[2]);
    let forbidden = PathBuf::from(&arguments[3]);
    let protected = PathBuf::from(&arguments[4]);
    let port = match arguments[5].to_string_lossy().parse::<u16>() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("invalid macOS Seatbelt probe port: {error}");
            return 2;
        }
    };

    match std::fs::read_to_string(readable.join("allowed.txt")) {
        Ok(contents) if contents == "allowed" => {}
        Ok(contents) => {
            eprintln!("Seatbelt probe read unexpected declared-root contents: {contents:?}");
            return 3;
        }
        Err(error) => {
            eprintln!("Seatbelt probe could not read the declared readable root: {error}");
            return 3;
        }
    }
    if let Err(error) = std::fs::write(writable.join("allowed-write.txt"), b"allowed") {
        eprintln!("Seatbelt probe could not write the declared writable root: {error}");
        return 4;
    }
    if std::fs::read_to_string(forbidden.join("forbidden.txt")).is_ok() {
        eprintln!("Seatbelt probe read outside the declared roots");
        return 5;
    }
    if std::fs::write(forbidden.join("forbidden-write.txt"), b"forbidden").is_ok() {
        eprintln!("Seatbelt probe wrote outside the declared roots");
        return 6;
    }
    if std::fs::write(protected.join("protected-write.txt"), b"forbidden").is_ok() {
        eprintln!("Seatbelt probe wrote a protected path");
        return 7;
    }

    let connection = TcpStream::connect(("127.0.0.1", port));
    match (mode.as_ref(), &connection) {
        ("none", Err(_)) | ("loopback", Ok(_)) => 0,
        ("none", Ok(_)) => {
            eprintln!("Seatbelt no-network probe unexpectedly connected to loopback");
            8
        }
        ("loopback", Err(error)) => {
            eprintln!("Seatbelt loopback probe could not connect to loopback: {error}");
            9
        }
        _ => 2,
    }
}

pub(crate) fn detect() -> Result<(), RpcError> {
    validate_sandbox_executable()?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let requested_base = std::env::temp_dir().join(format!(
        "sigma-seatbelt-self-test-{}-{nonce}",
        std::process::id()
    ));
    let base = create_canonical_self_test_root(&requested_base)?;
    let readable = base.join("readable");
    let writable = readable.join("writable");
    let protected = writable.join("protected");
    let forbidden = base.join("forbidden");
    for directory in [&readable, &writable, &protected, &forbidden] {
        std::fs::create_dir_all(directory).map_err(RpcError::from)?;
    }
    std::fs::write(readable.join("allowed.txt"), b"allowed").map_err(RpcError::from)?;
    std::fs::write(forbidden.join("forbidden.txt"), b"forbidden").map_err(RpcError::from)?;

    let result = (|| {
        run_policy_probe(
            "none",
            &readable,
            &writable,
            &forbidden,
            &protected,
            NetworkMode::None,
        )?;
        run_policy_probe(
            "loopback",
            &readable,
            &writable,
            &forbidden,
            &protected,
            NetworkMode::Loopback,
        )?;
        run_pty_probe(&readable)
    })();
    let _ = std::fs::remove_dir_all(&base);
    result
}

fn create_canonical_self_test_root(requested: &Path) -> Result<PathBuf, RpcError> {
    std::fs::create_dir_all(requested).map_err(RpcError::from)?;
    requested.canonicalize().map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!(
                "cannot resolve macOS Seatbelt self-test root '{}': {error}",
                requested.display()
            ),
        )
    })
}

fn validate_sandbox_executable() -> Result<(), RpcError> {
    let metadata = std::fs::symlink_metadata(SANDBOX_EXEC).map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!("cannot inspect trusted {SANDBOX_EXEC}: {error}"),
        )
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.uid() != 0
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!("trusted {SANDBOX_EXEC} has unsafe ownership, type, or permissions"),
        ));
    }
    Ok(())
}

fn run_policy_probe(
    mode: &str,
    readable: &Path,
    writable: &Path,
    forbidden: &Path,
    protected: &Path,
    network: NetworkMode,
) -> Result<(), RpcError> {
    let helper = std::env::current_exe().map_err(RpcError::from)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(RpcError::from)?;
    let port = listener.local_addr().map_err(RpcError::from)?.port();
    let profile = build_profile(
        &[readable.to_owned()],
        &[writable.to_owned()],
        &[],
        &[protected.to_owned()],
        &helper,
        network,
    )?;
    let mut command = sandbox_command(&profile)?;
    command
        .arg(&helper)
        .arg(INTERNAL_PROBE)
        .arg(mode)
        .arg(readable)
        .arg(writable)
        .arg(forbidden)
        .arg(protected)
        .arg(port.to_string())
        .current_dir(readable)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = command.output().map_err(RpcError::from)?;
    drop(listener);
    if output.status.success() {
        Ok(())
    } else {
        Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "macOS Seatbelt {mode} self-test failed ({})",
                output_failure(&output)
            ),
        ))
    }
}

fn run_pty_probe(readable: &Path) -> Result<(), RpcError> {
    let helper = std::env::current_exe().map_err(RpcError::from)?;
    let profile = build_profile(
        &[readable.to_owned()],
        &[],
        &[],
        &[],
        &helper,
        NetworkMode::None,
    )?;
    let mut command = sandbox_command(&profile)?;
    command
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
        .current_dir(readable)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let output = command.output().map_err(RpcError::from)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "macOS Seatbelt forkpty self-test failed ({})",
                output_failure(&output)
            ),
        ))
    }
}

fn output_failure(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stderr = stderr.trim();
    format!(
        "exitCode={}, signal={}, stderr={}",
        output
            .status
            .code()
            .map_or_else(|| "none".to_owned(), |code| code.to_string()),
        output
            .status
            .signal()
            .map_or_else(|| "none".to_owned(), |signal| signal.to_string()),
        if stderr.is_empty() { "<empty>" } else { stderr }
    )
}

pub(crate) fn prepare_command(
    params: &ProcessParams,
    scratch: Option<&ScratchLease>,
    disposable_workspace: Option<&DisposableWorkspace>,
) -> Result<PreparedCommand, RpcError> {
    if disposable_workspace.is_some() {
        return Err(RpcError::new(
            "validation_disposable_workspace_unavailable",
            "macOS Seatbelt cannot provide a same-path disposable validation workspace",
        ));
    }
    let executable = resolve_executable(params)?;
    let mut read_roots = canonical_roots(&params.policy.read_roots)?;
    let mut write_roots = canonical_roots(&params.policy.write_roots)?;
    let execution_roots = canonical_roots(&params.policy.execution_roots)?;
    if let Some(lease) = scratch {
        for root in [
            lease.home_source(),
            lease.temp_source(),
            lease.var_temp_source(),
        ] {
            let root = root.canonicalize().map_err(RpcError::from)?;
            read_roots.push(root.clone());
            write_roots.push(root);
        }
    }
    deduplicate_paths(&mut read_roots);
    deduplicate_paths(&mut write_roots);
    let protected = protected_path_candidates(params)?;
    let helper = std::env::current_exe().map_err(RpcError::from)?;
    let profile = build_profile(
        &read_roots,
        &write_roots,
        &execution_roots,
        &protected,
        &helper,
        params.policy.network.clone(),
    )?;
    let mut command = sandbox_command(&profile)?;
    if params.pty {
        command
            .arg(&helper)
            .arg("--internal-unix-pty-launcher")
            .arg(params.pty_columns.to_string())
            .arg(params.pty_rows.to_string())
            .arg(&executable)
            .arg(&params.command.executable)
            .args(&params.command.args);
    } else {
        command.arg(&executable).args(&params.command.args);
    }
    configure_common(&mut command, params);
    if let Some(lease) = scratch {
        command
            .env("HOME", lease.home_source())
            .env("TMPDIR", lease.temp_source())
            .env("TMP", lease.temp_source())
            .env("TEMP", lease.temp_source())
            .env("XDG_CACHE_HOME", lease.home_source().join(".cache"))
            .env("XDG_CONFIG_HOME", lease.home_source().join(".config"))
            .env("XDG_DATA_HOME", lease.home_source().join(".local/share"))
            .env("XDG_STATE_HOME", lease.home_source().join(".local/state"));
    }
    Ok(PreparedCommand {
        command,
        bootstrap_stdin: Vec::new(),
        protected_path_guards: Vec::new(),
        launch_failure_nonce: None,
        disposable_workspace: None,
    })
}

fn canonical_roots(roots: &[PathBuf]) -> Result<Vec<PathBuf>, RpcError> {
    let mut result = roots
        .iter()
        .map(|root| {
            root.canonicalize().map_err(|error| {
                RpcError::new(
                    "policy_denied",
                    format!(
                        "cannot resolve macOS sandbox root '{}': {error}",
                        root.display()
                    ),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    deduplicate_paths(&mut result);
    Ok(result)
}

fn deduplicate_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = BTreeSet::new();
    paths.retain(|path| seen.insert(path.clone()));
}

fn resolve_executable(params: &ProcessParams) -> Result<PathBuf, RpcError> {
    let requested = PathBuf::from(&params.command.executable);
    let mut candidates = Vec::new();
    if requested.is_absolute() {
        candidates.push(requested);
    } else if params.command.executable.contains('/') {
        candidates.push(params.command.cwd.join(requested));
    } else if let Some(search) = params.command.env.get("PATH") {
        candidates.extend(std::env::split_paths(search).map(|directory| {
            if directory.is_absolute() {
                directory.join(&requested)
            } else {
                params.command.cwd.join(directory).join(&requested)
            }
        }));
    }
    let execution_roots = canonical_roots(&params.policy.execution_roots)?;
    let system_roots = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/libexec"]
        .into_iter()
        .filter_map(|root| Path::new(root).canonicalize().ok())
        .collect::<Vec<_>>();
    for candidate in candidates {
        let Ok(candidate) = candidate.canonicalize() else {
            continue;
        };
        let metadata = std::fs::metadata(&candidate).map_err(RpcError::from)?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
            continue;
        }
        let trusted = system_roots.iter().any(|root| candidate.starts_with(root))
            || execution_roots
                .iter()
                .any(|root| candidate.starts_with(root));
        if !trusted {
            return Err(RpcError::new(
                "executable_unavailable",
                format!(
                    "resolved executable '{}' is outside trusted system and declared execution roots",
                    candidate.display()
                ),
            ));
        }
        if let Some(expected) = params.policy.executable_sha256.as_deref() {
            let actual = file_sha256(&candidate)?;
            if actual != expected {
                return Err(RpcError::new(
                    "executable_changed",
                    format!(
                        "executable '{}' no longer matches its authorized SHA-256",
                        candidate.display()
                    ),
                ));
            }
        }
        return Ok(candidate);
    }
    Err(RpcError::new(
        "executable_not_found",
        format!("cannot resolve executable '{}'", params.command.executable),
    ))
}

fn file_sha256(path: &Path) -> Result<String, RpcError> {
    let mut file = File::open(path).map_err(RpcError::from)?;
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

fn build_profile(
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
    execution_roots: &[PathBuf],
    protected_paths: &[PathBuf],
    helper: &Path,
    network: NetworkMode,
) -> Result<SeatbeltProfile, RpcError> {
    let mut parameters = Vec::new();
    let mut sections = vec![BASE_POLICY.to_owned(), PLATFORM_POLICY.to_owned()];
    let protected = protected_paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let name = format!("PROTECTED_{index}");
            parameters.push(ProfileParameter {
                name: name.clone(),
                value: path.clone(),
            });
            name
        })
        .collect::<Vec<_>>();

    for (index, path) in read_roots.iter().chain(execution_roots).enumerate() {
        let name = format!("READ_ROOT_{index}");
        let kind = access_kind(path)?;
        parameters.push(ProfileParameter {
            name: name.clone(),
            value: path.clone(),
        });
        sections.push(read_policy(&name, kind));
    }
    for (index, path) in write_roots.iter().enumerate() {
        let name = format!("WRITE_ROOT_{index}");
        let kind = access_kind(path)?;
        parameters.push(ProfileParameter {
            name: name.clone(),
            value: path.clone(),
        });
        sections.push(write_policy(&name, kind, &protected));
    }
    let helper_name = "SIGMA_HELPER".to_owned();
    parameters.push(ProfileParameter {
        name: helper_name.clone(),
        value: helper.to_owned(),
    });
    sections.push(read_policy(&helper_name, AccessKind::File));
    sections.push(match network {
        NetworkMode::None => String::new(),
        NetworkMode::Loopback => concat!(
            "; loopback-only network\n",
            "(allow network-bind (local ip \"*:*\"))\n",
            "(allow network-inbound (local ip \"localhost:*\"))\n",
            "(allow network-outbound (remote ip \"localhost:*\"))\n"
        )
        .to_owned(),
        NetworkMode::Full => concat!(
            "; approved full network\n",
            "(allow network-bind)\n",
            "(allow network-inbound)\n",
            "(allow network-outbound)\n"
        )
        .to_owned(),
    });
    Ok(SeatbeltProfile {
        text: sections.join("\n"),
        parameters,
    })
}

fn access_kind(path: &Path) -> Result<AccessKind, RpcError> {
    let metadata = std::fs::metadata(path).map_err(RpcError::from)?;
    Ok(if metadata.is_dir() {
        AccessKind::Directory
    } else {
        AccessKind::File
    })
}

fn read_policy(name: &str, kind: AccessKind) -> String {
    let filter = match kind {
        AccessKind::Directory => format!("(subpath (param \"{name}\"))"),
        AccessKind::File => format!("(literal (param \"{name}\"))"),
    };
    format!("(allow file-read* file-test-existence {filter})\n(allow file-map-executable {filter})")
}

fn write_policy(name: &str, kind: AccessKind, protected: &[String]) -> String {
    let root = match kind {
        AccessKind::Directory => format!("(subpath (param \"{name}\"))"),
        AccessKind::File => format!("(literal (param \"{name}\"))"),
    };
    let mut requirements = vec![root];
    for item in protected {
        requirements.push(format!("(require-not (literal (param \"{item}\")))"));
        requirements.push(format!("(require-not (subpath (param \"{item}\")))"));
    }
    format!(
        "(allow file-write* (require-all {}))",
        requirements.join(" ")
    )
}

fn sandbox_command(profile: &SeatbeltProfile) -> Result<Command, RpcError> {
    let mut command = Command::new(SANDBOX_EXEC);
    for parameter in &profile.parameters {
        let value = parameter.value.to_str().ok_or_else(|| {
            RpcError::new(
                "policy_denied",
                format!(
                    "macOS sandbox path is not valid UTF-8: '{}'",
                    parameter.value.display()
                ),
            )
        })?;
        command.arg("-D").arg(format!("{}={value}", parameter.name));
    }
    command.arg("-p").arg(&profile.text).arg("--");
    Ok(command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn write_policy_excludes_protected_paths() {
        let policy = write_policy(
            "WRITE_ROOT_0",
            AccessKind::Directory,
            &["PROTECTED_0".to_owned()],
        );
        assert!(policy.contains("subpath (param \"WRITE_ROOT_0\")"));
        assert!(policy.contains("require-not (literal (param \"PROTECTED_0\"))"));
        assert!(policy.contains("require-not (subpath (param \"PROTECTED_0\"))"));
    }

    #[test]
    fn platform_policy_keeps_firmlink_traversal_read_only() {
        assert!(PLATFORM_POLICY.contains("file-read* file-test-existence (literal \"/\")"));
        assert!(PLATFORM_POLICY.contains("/System/Volumes/Data/Users"));
        assert!(!PLATFORM_POLICY.contains("file-write* (subpath \"/tmp\")"));
        assert!(!PLATFORM_POLICY.contains("com.apple.app-sandbox.read-write"));
    }

    #[test]
    fn self_test_root_resolves_symlink_aliases_before_building_the_profile() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let fixture = std::env::temp_dir().join(format!(
            "sigma-seatbelt-canonical-root-test-{}-{nonce}",
            std::process::id()
        ));
        let actual_parent = fixture.join("actual");
        let alias = fixture.join("alias");
        std::fs::create_dir_all(&actual_parent).expect("create actual self-test parent");
        symlink(&actual_parent, &alias).expect("create self-test path alias");

        let resolved = create_canonical_self_test_root(&alias.join("probe"))
            .expect("canonicalize self-test root through alias");
        assert_eq!(
            resolved,
            actual_parent
                .canonicalize()
                .expect("canonical actual self-test parent")
                .join("probe")
        );

        std::fs::remove_dir_all(&fixture).expect("remove canonical-root fixture");
    }
}
