use crate::protocol::RpcError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

static SCRATCH_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScratchLeaseStatusV1 {
    protocol_version: u32,
    lease_id: String,
    session_id: String,
    lifetime: &'static str,
    isolation: &'static str,
    persistent_across_calls: bool,
    home: PathBuf,
    temp: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AcquireScratchLeaseParams {
    protocol_version: u32,
    session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReleaseScratchLeaseParams {
    protocol_version: u32,
    session_id: String,
    lease_id: String,
}

/// Broker-owned scratch. No request field can select its host path or lease id.
/// A manager-held lease lives for exactly one runtime session. A process keeps
/// an Arc while it is alive so a racing release cannot remove its directories.
pub(crate) struct ScratchLease {
    lease_id: String,
    root: PathBuf,
    home_source: PathBuf,
    temp_source: PathBuf,
    home_destination: PathBuf,
}

#[derive(Default)]
pub(crate) struct ScratchLeases {
    by_session: Mutex<HashMap<String, Arc<ScratchLease>>>,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) struct DisposableWorkspace {
    source: PathBuf,
    destination: PathBuf,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
impl DisposableWorkspace {
    pub(crate) fn source(&self) -> &Path {
        &self.source
    }
    pub(crate) fn destination(&self) -> &Path {
        &self.destination
    }
}

impl Drop for DisposableWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.source);
    }
}

impl ScratchLease {
    pub(crate) fn new(instance_id: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let suffix = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("sigma-exec-scratch-{instance_id}-{nonce}-{suffix}"));
        let home_destination = session_home_destination(&root);
        Self {
            lease_id: format!("scratch-{instance_id}-{nonce}-{suffix}"),
            home_source: root.join("home"),
            temp_source: root.join("tmp"),
            root,
            home_destination,
        }
    }

    pub(crate) fn prepare(&self) -> Result<(), RpcError> {
        for directory in [
            self.home_source.clone(),
            self.home_source.join(".cache"),
            self.home_source.join(".config"),
            self.home_source.join(".local/share"),
            self.home_source.join(".local/state"),
            self.home_source.join(".git"),
            self.home_source.join(".agent"),
            self.temp_source.clone(),
            self.temp_source.join(".git"),
            self.temp_source.join(".agent"),
            self.root.join("disposable"),
        ] {
            std::fs::create_dir_all(&directory).map_err(|error| {
                RpcError::new(
                    "sandbox_unavailable",
                    format!(
                        "cannot prepare private session scratch '{}': {error}",
                        directory.display()
                    ),
                )
            })?;
            set_private_permissions(&directory)?;
        }
        Ok(())
    }

    pub(crate) fn status(&self, session_id: &str) -> ScratchLeaseStatusV1 {
        ScratchLeaseStatusV1 {
            protocol_version: 1,
            lease_id: self.lease_id.clone(),
            session_id: session_id.to_owned(),
            lifetime: "runtime_session",
            isolation: "private",
            persistent_across_calls: true,
            home: self.home_destination.clone(),
            temp: self.temp_destination().to_owned(),
        }
    }

    pub(crate) fn lease_id(&self) -> &str {
        &self.lease_id
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn home_source(&self) -> &Path {
        &self.home_source
    }
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn temp_source(&self) -> &Path {
        &self.temp_source
    }

    #[cfg(target_os = "linux")]
    fn temp_destination(&self) -> &Path {
        Path::new("/tmp")
    }

    #[cfg(not(target_os = "linux"))]
    fn temp_destination(&self) -> &Path {
        &self.temp_source
    }
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(crate) fn home_destination(&self) -> &Path {
        &self.home_destination
    }

    pub(crate) fn disposable_root(&self, sequence: u64) -> PathBuf {
        self.root.join("disposable").join(sequence.to_string())
    }

    #[cfg(test)]
    pub(crate) fn disposable_base(&self) -> PathBuf {
        self.root.join("disposable")
    }

    pub(crate) fn disposable_workspace(
        &self,
        workspace: &Path,
    ) -> Result<DisposableWorkspace, RpcError> {
        let workspace = workspace.canonicalize().map_err(|error| {
            RpcError::new(
                "validation_disposable_workspace_unavailable",
                format!(
                    "cannot resolve validation workspace '{}': {error}",
                    workspace.display()
                ),
            )
        })?;
        let sequence = SCRATCH_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let source = self.disposable_root(sequence);
        std::fs::create_dir(&source).map_err(|error| {
            RpcError::new(
                "validation_disposable_workspace_unavailable",
                format!("cannot create disposable validation workspace: {error}"),
            )
        })?;
        set_private_permissions(&source)?;
        if let Err(error) = copy_tree(&workspace, &source, true, cfg!(windows)) {
            let _ = std::fs::remove_dir_all(&source);
            return Err(error);
        }
        Ok(DisposableWorkspace {
            source,
            destination: workspace,
        })
    }

    pub(crate) fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl ScratchLeases {
    pub(crate) fn acquire(
        &self,
        instance_id: &str,
        params: AcquireScratchLeaseParams,
    ) -> Result<ScratchLeaseStatusV1, RpcError> {
        if params.protocol_version != 1 {
            return Err(RpcError::new(
                "unsupported_protocol",
                "scratch lease protocolVersion must be 1",
            ));
        }
        validate_session_id(&params.session_id)?;
        let mut leases = self.by_session.lock().map_err(lock_error)?;
        let lease = leases
            .entry(params.session_id.clone())
            .or_insert_with(|| Arc::new(ScratchLease::new(instance_id)))
            .clone();
        lease.prepare()?;
        Ok(lease.status(&params.session_id))
    }

    pub(crate) fn release(&self, params: ReleaseScratchLeaseParams) -> Result<bool, RpcError> {
        if params.protocol_version != 1 {
            return Err(RpcError::new(
                "unsupported_protocol",
                "scratch lease protocolVersion must be 1",
            ));
        }
        validate_session_id(&params.session_id)?;
        if params.lease_id.is_empty() || params.lease_id.len() > 256 {
            return Err(RpcError::new(
                "scratch_lease_invalid",
                "scratch leaseId is invalid",
            ));
        }
        let mut leases = self.by_session.lock().map_err(lock_error)?;
        let Some(current) = leases.get(&params.session_id) else {
            return Ok(false);
        };
        if current.lease_id() != params.lease_id {
            return Err(RpcError::new(
                "scratch_lease_invalid",
                "scratch lease does not match the runtime session",
            ));
        }
        leases.remove(&params.session_id);
        Ok(true)
    }

    pub(crate) fn resolve(
        &self,
        instance_id: &str,
        lease_id: Option<String>,
        session_id: Option<String>,
    ) -> Result<Arc<ScratchLease>, RpcError> {
        let (lease_id, session_id) = match (lease_id, session_id) {
            (None, None) => {
                let lease = Arc::new(ScratchLease::new(instance_id));
                lease.prepare()?;
                return Ok(lease);
            }
            (Some(lease_id), Some(session_id)) => (lease_id, session_id),
            _ => {
                return Err(RpcError::new(
                    "scratch_lease_invalid",
                    "scratch leaseId and sessionId must be supplied together",
                ));
            }
        };
        validate_session_id(&session_id)?;
        let leases = self.by_session.lock().map_err(lock_error)?;
        let lease = leases.get(&session_id).ok_or_else(|| {
            RpcError::new(
                "scratch_lease_invalid",
                "scratch lease is unknown or has already been released",
            )
        })?;
        if lease.lease_id() != lease_id {
            return Err(RpcError::new(
                "scratch_lease_invalid",
                "scratch lease does not match the runtime session",
            ));
        }
        lease.prepare()?;
        Ok(lease.clone())
    }

    pub(crate) fn clear(&self) {
        if let Ok(mut leases) = self.by_session.lock() {
            leases.clear();
        }
    }
}

fn validate_session_id(session_id: &str) -> Result<(), RpcError> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b'.'))
    {
        return Err(RpcError::new(
            "scratch_lease_invalid",
            "scratch sessionId must be 1-128 ASCII identifier characters",
        ));
    }
    Ok(())
}

fn lock_error<T>(error: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new("broker_internal_error", error.to_string())
}

fn copy_tree(
    source: &Path,
    destination: &Path,
    workspace_root: bool,
    include_git_metadata: bool,
) -> Result<(), RpcError> {
    let entries = std::fs::read_dir(source).map_err(|error| {
        RpcError::new(
            "validation_disposable_workspace_unavailable",
            format!(
                "cannot read validation workspace '{}': {error}",
                source.display()
            ),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(RpcError::from)?;
        let name = entry.file_name();
        if workspace_root && (name == ".agent" || (name == ".git" && !include_git_metadata)) {
            continue;
        }
        let from = entry.path();
        let to = destination.join(&name);
        let metadata = std::fs::symlink_metadata(&from).map_err(RpcError::from)?;
        if metadata.is_dir() {
            std::fs::create_dir(&to).map_err(RpcError::from)?;
            copy_tree(&from, &to, false, include_git_metadata)?;
        } else if metadata.is_file() {
            std::fs::copy(&from, &to).map_err(|error| {
                RpcError::new(
                    "validation_disposable_workspace_unavailable",
                    format!("cannot copy validation input '{}': {error}", from.display()),
                )
            })?;
        } else if metadata.file_type().is_symlink() {
            copy_symlink(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(source: &Path, destination: &Path) -> Result<(), RpcError> {
    use std::os::unix::fs::symlink;
    let target = std::fs::read_link(source).map_err(RpcError::from)?;
    symlink(target, destination).map_err(RpcError::from)
}

#[cfg(windows)]
fn copy_symlink(source: &Path, destination: &Path) -> Result<(), RpcError> {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let target = std::fs::read_link(source).map_err(RpcError::from)?;
    if source.is_dir() {
        symlink_dir(target, destination)
    } else {
        symlink_file(target, destination)
    }
    .map_err(RpcError::from)
}

#[cfg(not(any(unix, windows)))]
fn copy_symlink(_source: &Path, _destination: &Path) -> Result<(), RpcError> {
    Err(RpcError::new(
        "validation_disposable_workspace_unavailable",
        "symbolic links are unsupported",
    ))
}

#[cfg(unix)]
fn set_private_permissions(path: &Path) -> Result<(), RpcError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!(
                "cannot make private session scratch '{}': {error}",
                path.display()
            ),
        )
    })
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &Path) -> Result<(), RpcError> {
    Ok(())
}

#[cfg(unix)]
fn session_home_destination(_root: &Path) -> PathBuf {
    use std::ffi::CStr;
    let mut pwd = unsafe { std::mem::zeroed::<libc::passwd>() };
    let mut result = std::ptr::null_mut();
    let mut buffer = vec![0_u8; 16 * 1024];
    let status = unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            &mut pwd,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || pwd.pw_dir.is_null() {
        return PathBuf::from("/home/sigma");
    }
    let value = unsafe { CStr::from_ptr(pwd.pw_dir) }.to_string_lossy();
    let path = PathBuf::from(value.as_ref());
    if path.is_absolute() && path != Path::new("/") {
        path
    } else {
        PathBuf::from("/home/sigma")
    }
}

#[cfg(not(unix))]
fn session_home_destination(root: &Path) -> PathBuf {
    root.join("home")
}

impl Drop for ScratchLease {
    fn drop(&mut self) {
        self.cleanup();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scratch_is_private_persistent_and_isolated_per_lease() {
        let first = ScratchLease::new("one");
        let second = ScratchLease::new("two");
        first.prepare().unwrap();
        second.prepare().unwrap();
        assert_ne!(first.root, second.root);
        assert_ne!(first.status("one").lease_id, second.status("two").lease_id);
        #[cfg(target_os = "linux")]
        assert_eq!(first.status("one").temp, Path::new("/tmp"));
        #[cfg(not(target_os = "linux"))]
        assert_eq!(first.status("one").temp, first.temp_source);
        std::fs::write(first.temp_source.join("persisted"), b"yes").unwrap();
        first.prepare().unwrap();
        assert_eq!(
            std::fs::read(first.temp_source.join("persisted")).unwrap(),
            b"yes"
        );
        assert!(!second.temp_source.join("persisted").exists());
        let first_root = first.root.clone();
        drop(first);
        assert!(!first_root.exists());
    }

    #[test]
    fn runtime_sessions_persist_isolate_and_clean_up_on_release() {
        let leases = ScratchLeases::default();
        let first = leases
            .acquire(
                "broker",
                AcquireScratchLeaseParams {
                    protocol_version: 1,
                    session_id: "root-session".into(),
                },
            )
            .unwrap();
        let repeated = leases
            .acquire(
                "broker",
                AcquireScratchLeaseParams {
                    protocol_version: 1,
                    session_id: "root-session".into(),
                },
            )
            .unwrap();
        let child = leases
            .acquire(
                "broker",
                AcquireScratchLeaseParams {
                    protocol_version: 1,
                    session_id: "child-session".into(),
                },
            )
            .unwrap();
        assert_eq!(first.lease_id, repeated.lease_id);
        assert_ne!(first.lease_id, child.lease_id);
        let first_lease = leases
            .resolve(
                "broker",
                Some(first.lease_id.clone()),
                Some(first.session_id.clone()),
            )
            .unwrap();
        let first_root = first_lease.root.clone();
        std::fs::write(first_lease.temp_source.join("persisted"), b"yes").unwrap();
        drop(first_lease);
        assert!(first_root.exists());
        assert!(
            leases
                .release(ReleaseScratchLeaseParams {
                    protocol_version: 1,
                    session_id: first.session_id,
                    lease_id: first.lease_id,
                })
                .unwrap()
        );
        assert!(!first_root.exists());
        let child_lease = leases
            .resolve("broker", Some(child.lease_id), Some(child.session_id))
            .unwrap();
        assert!(!child_lease.temp_source.join("persisted").exists());
    }

    #[test]
    fn forged_or_cross_session_scratch_capabilities_are_rejected() {
        let leases = ScratchLeases::default();
        let first = leases
            .acquire(
                "broker",
                AcquireScratchLeaseParams {
                    protocol_version: 1,
                    session_id: "root".into(),
                },
            )
            .unwrap();
        let child = leases
            .acquire(
                "broker",
                AcquireScratchLeaseParams {
                    protocol_version: 1,
                    session_id: "child".into(),
                },
            )
            .unwrap();
        assert!(
            leases
                .resolve(
                    "broker",
                    Some(first.lease_id.clone()),
                    Some(child.session_id.clone()),
                )
                .is_err()
        );
        assert!(
            leases
                .release(ReleaseScratchLeaseParams {
                    protocol_version: 1,
                    session_id: first.session_id,
                    lease_id: "model-forged".into(),
                })
                .is_err()
        );
    }

    #[test]
    fn disposable_workspace_copies_inputs_excludes_metadata_and_cleans_up() {
        let lease = ScratchLease::new("validation");
        lease.prepare().unwrap();
        let workspace = lease.root.join("workspace-source");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("input.txt"), b"original").unwrap();
        std::fs::create_dir(workspace.join(".git")).unwrap();
        std::fs::write(workspace.join(".git/sentinel"), b"metadata").unwrap();
        std::fs::create_dir(workspace.join(".agent")).unwrap();
        let disposable = lease.disposable_workspace(&workspace).unwrap();
        let copy = disposable.source.clone();
        assert_eq!(std::fs::read(copy.join("input.txt")).unwrap(), b"original");
        if cfg!(windows) {
            assert_eq!(
                std::fs::read(copy.join(".git/sentinel")).unwrap(),
                b"metadata"
            );
        } else {
            assert!(!copy.join(".git").exists());
        }
        assert!(!copy.join(".agent").exists());
        std::fs::write(copy.join("input.txt"), b"generated").unwrap();
        assert_eq!(
            std::fs::read(workspace.join("input.txt")).unwrap(),
            b"original"
        );
        drop(disposable);
        assert!(!copy.exists());
    }
}
