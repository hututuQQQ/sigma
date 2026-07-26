use crate::protocol::RpcError;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const CONTAINER_MARKERS: &[&str] = &["/.dockerenv", "/run/.containerenv"];
const HOST_CONTROL_SOCKETS: &[&str] = &[
    "/var/run/docker.sock",
    "/run/docker.sock",
    "/run/containerd/containerd.sock",
    "/run/podman/podman.sock",
];
const NESTED_SANDBOX_REPLACED_ROOTS: &[&str] = &["/proc", "/dev"];
const MAX_PROTECTED_SUBMOUNTS: usize = 128;
const MAX_MOUNT_POINT_BYTES: usize = 4_096;
const CAP_SETGID: u32 = 6;
const CAP_SETUID: u32 = 7;
const CAP_SYS_ADMIN: u32 = 21;
// Harbor grants the outer task container CAP_SYS_ADMIN solely so bubblewrap
// can create a nested mount namespace. Enclosing-container commands retain
// the outer UID map so ordinary system tools can change account, but
// bubblewrap drops CAP_SYS_ADMIN before the hardened launcher starts.
// The attestation below independently requires a copy-on-write container
// root with no host-control sockets. Capabilities which directly inspect or
// control the enclosing host remain disallowed.
const DISALLOWED_CAPABILITIES: &[u32] = &[
    16, // CAP_SYS_MODULE
    17, // CAP_SYS_RAWIO
    19, // CAP_SYS_PTRACE
    22, // CAP_SYS_BOOT
    38, // CAP_PERFMON
    39, // CAP_BPF
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EnclosingContainerBoundary {
    pub(crate) available: bool,
    pub(crate) attestation_digest: Option<String>,
    pub(crate) protected_paths: Vec<PathBuf>,
    pub(crate) reason: Option<String>,
}

impl EnclosingContainerBoundary {
    pub(crate) fn report(&self) -> Value {
        json!({
            "available": self.available,
            "rootKind": if self.available { "container_cow" } else { "unavailable" },
            "attestationDigest": self.attestation_digest,
            "protectedPaths": self.protected_paths,
            "reason": self.reason,
        })
    }
}

static ENCLOSING_CONTAINER_BOUNDARY: OnceLock<EnclosingContainerBoundary> = OnceLock::new();

pub(crate) fn inspect_enclosing_container_boundary() -> &'static EnclosingContainerBoundary {
    ENCLOSING_CONTAINER_BOUNDARY.get_or_init(|| {
        inspect_inner().unwrap_or_else(|reason| EnclosingContainerBoundary {
            available: false,
            attestation_digest: None,
            protected_paths: Vec::new(),
            reason: Some(reason),
        })
    })
}

pub(crate) fn require_enclosing_container_boundary(
    requested_protected_paths: &[PathBuf],
) -> Result<(), RpcError> {
    let boundary = inspect_enclosing_container_boundary();
    if !boundary.available {
        return Err(RpcError::new(
            "enclosing_container_unavailable",
            boundary
                .reason
                .as_deref()
                .unwrap_or("the enclosing container boundary could not be attested"),
        ));
    }
    let current = inspect_inner().map_err(|reason| {
        RpcError::new(
            "enclosing_container_attestation_changed",
            format!("the enclosing container boundary no longer matches its attestation: {reason}"),
        )
    })?;
    if current.attestation_digest != boundary.attestation_digest {
        return Err(RpcError::new(
            "enclosing_container_attestation_changed",
            "the enclosing container mount or capability boundary changed after discovery",
        ));
    }
    let protected = requested_protected_paths
        .iter()
        .filter_map(|path| path.canonicalize().ok())
        .collect::<BTreeSet<_>>();
    if let Some(missing) = current
        .protected_paths
        .iter()
        .find(|path| !protected.contains(*path))
    {
        return Err(RpcError::new(
            "enclosing_container_protection_required",
            format!(
                "enclosing-container policy must protect attested external mount '{}'",
                missing.display()
            ),
        ));
    }
    Ok(())
}

fn inspect_inner() -> Result<EnclosingContainerBoundary, String> {
    let marker = trusted_container_marker()?;
    let mountinfo = fs::read_to_string("/proc/self/mountinfo")
        .map_err(|error| format!("cannot read mount namespace: {error}"))?;
    let mounts = parse_mountinfo(&mountinfo)?;
    let root_mount = mounts
        .iter()
        .find(|mount| mount.mount_point == Path::new("/"))
        .ok_or_else(|| "root filesystem was not found in mountinfo".to_owned())?;
    let root_filesystem = root_mount.filesystem_type.as_str();
    if root_filesystem != "overlay" && root_filesystem != "fuse-overlayfs" {
        return Err(format!(
            "root filesystem '{root_filesystem}' is not an attested copy-on-write container root"
        ));
    }
    let protected_paths = writable_host_submounts(&mounts, root_mount)?;
    let effective_capabilities = effective_capabilities()?;
    let disallowed = DISALLOWED_CAPABILITIES
        .iter()
        .copied()
        .filter(|capability| effective_capabilities & (1_u64 << capability) != 0)
        .collect::<Vec<_>>();
    if !disallowed.is_empty() {
        return Err(format!(
            "process retains host-control capabilities: {}",
            disallowed
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    if unsafe { libc::geteuid() } != 0 {
        return Err("enclosing-container mutation requires effective UID 0".into());
    }
    let missing = [CAP_SETGID, CAP_SETUID, CAP_SYS_ADMIN]
        .into_iter()
        .filter(|capability| effective_capabilities & (1_u64 << capability) == 0)
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "process lacks required enclosing-container capabilities: {}",
            missing
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    if let Some(socket) = HOST_CONTROL_SOCKETS
        .iter()
        .map(Path::new)
        .find(|socket| socket.exists())
    {
        return Err(format!(
            "host-control socket is visible at '{}'",
            socket.display()
        ));
    }

    let marker_metadata = fs::metadata(&marker)
        .map_err(|error| format!("cannot re-inspect container marker: {error}"))?;
    let mount_namespace_digest = format!("{:x}", Sha256::digest(mountinfo.as_bytes()));
    let protected_paths_material = protected_paths
        .iter()
        .map(|path| path.as_os_str().as_bytes())
        .collect::<Vec<_>>()
        .join(&0);
    let material = format!(
        "sigma-enclosing-container\0{}\0{}\0{}\0{}\0{:x}\0{}\0{}",
        marker.display(),
        marker_metadata.dev(),
        marker_metadata.ino(),
        root_filesystem,
        effective_capabilities,
        mount_namespace_digest,
        String::from_utf8_lossy(&protected_paths_material)
    );
    let digest = format!("sha256:{:x}", Sha256::digest(material.as_bytes()));
    Ok(EnclosingContainerBoundary {
        available: true,
        attestation_digest: Some(digest),
        protected_paths,
        reason: None,
    })
}

fn trusted_container_marker() -> Result<PathBuf, String> {
    let mut reasons = Vec::new();
    for marker in CONTAINER_MARKERS.iter().map(Path::new) {
        let metadata = match fs::symlink_metadata(marker) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                reasons.push(format!("cannot inspect '{}': {error}", marker.display()));
                continue;
            }
        };
        if !metadata.file_type().is_file() {
            reasons.push(format!("'{}' is not a regular file", marker.display()));
            continue;
        }
        if metadata.uid() != 0 {
            reasons.push(format!("'{}' is not owned by root", marker.display()));
            continue;
        }
        if metadata.permissions().mode() & 0o022 != 0 {
            reasons.push(format!(
                "'{}' is writable by group or other",
                marker.display()
            ));
            continue;
        }
        return Ok(marker.to_path_buf());
    }
    Err(if reasons.is_empty() {
        "no trusted container marker is present".into()
    } else {
        reasons.join("; ")
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MountInfoEntry {
    major_minor: String,
    mount_point: PathBuf,
    mount_options: String,
    filesystem_type: String,
}

impl MountInfoEntry {
    fn writable(&self) -> bool {
        self.mount_options.split(',').any(|option| option == "rw")
    }
}

fn parse_mountinfo(mountinfo: &str) -> Result<Vec<MountInfoEntry>, String> {
    let mut mounts = Vec::new();
    for (index, line) in mountinfo.lines().enumerate() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let separator = fields
            .iter()
            .position(|field| *field == "-")
            .ok_or_else(|| format!("mountinfo line {} has no field separator", index + 1))?;
        if fields.len() < 6 || separator + 3 >= fields.len() {
            return Err(format!("mountinfo line {} is incomplete", index + 1));
        }
        mounts.push(MountInfoEntry {
            major_minor: fields[2].to_owned(),
            mount_point: decode_mountinfo_path(fields[4], index + 1)?,
            mount_options: fields[5].to_owned(),
            filesystem_type: fields[separator + 1].to_owned(),
        });
    }
    Ok(mounts)
}

fn decode_mountinfo_path(value: &str, line: usize) -> Result<PathBuf, String> {
    let input = value.as_bytes();
    let mut decoded = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] != b'\\' {
            decoded.push(input[index]);
            index += 1;
            continue;
        }
        if index + 3 >= input.len() {
            return Err(format!("mountinfo line {line} has a truncated path escape"));
        }
        let escaped = &input[index + 1..index + 4];
        let byte = match escaped {
            b"040" => b' ',
            b"011" => b'\t',
            b"012" => b'\n',
            b"134" => b'\\',
            _ => {
                return Err(format!(
                    "mountinfo line {line} has an unsupported path escape"
                ));
            }
        };
        decoded.push(byte);
        index += 4;
    }
    if decoded.len() > MAX_MOUNT_POINT_BYTES {
        return Err(format!("mountinfo line {line} mount point is too long"));
    }
    let decoded = String::from_utf8(decoded)
        .map_err(|_| format!("mountinfo line {line} mount point is not UTF-8"))?;
    let path = PathBuf::from(decoded);
    if !path.is_absolute() {
        return Err(format!("mountinfo line {line} mount point is not absolute"));
    }
    Ok(path)
}

#[cfg(test)]
fn parse_root_filesystem_type(mountinfo: &str) -> Option<String> {
    parse_mountinfo(mountinfo)
        .ok()?
        .into_iter()
        .find_map(|mount| (mount.mount_point == Path::new("/")).then_some(mount.filesystem_type))
}

fn writable_host_submounts(
    mounts: &[MountInfoEntry],
    root: &MountInfoEntry,
) -> Result<Vec<PathBuf>, String> {
    let paths = mounts
        .iter()
        .filter(|mount| {
            mount.mount_point != Path::new("/")
                && mount.writable()
                && mount.major_minor != root.major_minor
                && !NESTED_SANDBOX_REPLACED_ROOTS
                    .iter()
                    .map(Path::new)
                    .any(|root| mount.mount_point.starts_with(root))
        })
        .map(|mount| {
            mount.mount_point.canonicalize().map_err(|error| {
                format!(
                    "cannot resolve writable external submount '{}': {error}",
                    mount.mount_point.display()
                )
            })
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    if paths.len() > MAX_PROTECTED_SUBMOUNTS {
        return Err(format!(
            "writable external submount count {} exceeds protected-path limit {MAX_PROTECTED_SUBMOUNTS}",
            paths.len()
        ));
    }
    Ok(paths.into_iter().collect())
}

fn effective_capabilities() -> Result<u64, String> {
    parse_effective_capabilities(
        &fs::read_to_string("/proc/self/status")
            .map_err(|error| format!("cannot read process capabilities: {error}"))?,
    )
    .ok_or_else(|| "CapEff was not found in process status".into())
}

fn parse_effective_capabilities(status: &str) -> Option<u64> {
    status.lines().find_map(|line| {
        let value = line.strip_prefix("CapEff:")?.trim();
        u64::from_str_radix(value, 16).ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_root_filesystem_from_mountinfo() {
        let input = concat!(
            "55 41 0:48 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n",
            "41 32 0:39 / / rw,relatime - overlay overlay rw,lowerdir=/lower\n",
        );
        assert_eq!(
            parse_root_filesystem_type(input).as_deref(),
            Some("overlay")
        );
    }

    #[test]
    fn protects_writable_host_submounts_below_a_cow_root() {
        let input = concat!(
            "41 32 0:39 / / rw,relatime - overlay overlay rw,lowerdir=/lower\n",
            "42 41 8:1 /host/project /tmp rw,relatime - ext4 /dev/sda1 rw\n",
        );
        let mounts = parse_mountinfo(input).expect("valid mountinfo");
        let root = mounts
            .iter()
            .find(|mount| mount.mount_point == Path::new("/"))
            .expect("root mount");
        assert_eq!(
            writable_host_submounts(&mounts, root),
            Ok(vec![PathBuf::from("/tmp")])
        );
    }

    #[test]
    fn permits_read_only_host_and_submounts_replaced_by_the_nested_sandbox() {
        let input = concat!(
            "41 32 0:39 / / rw,relatime - overlay overlay rw,lowerdir=/lower\n",
            "42 41 8:1 /host/project /workspace ro,relatime - ext4 /dev/sda1 rw\n",
            "43 41 0:48 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n",
            "44 41 0:49 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k\n",
        );
        let mounts = parse_mountinfo(input).expect("valid mountinfo");
        let root = mounts
            .iter()
            .find(|mount| mount.mount_point == Path::new("/"))
            .expect("root mount");
        assert_eq!(writable_host_submounts(&mounts, root), Ok(Vec::new()));
    }

    #[test]
    fn decodes_mountinfo_paths_before_protecting_them() {
        let input = concat!(
            "41 32 0:39 / / rw,relatime - overlay overlay rw,lowerdir=/lower\n",
            "42 41 8:1 /host/project /tmp/sigma\\040external rw,relatime - ext4 /dev/sda1 rw\n",
        );
        let mounts = parse_mountinfo(input).expect("valid mountinfo");
        assert_eq!(mounts[1].mount_point, PathBuf::from("/tmp/sigma external"));
    }

    #[test]
    fn rejects_ambiguous_mountinfo_path_escapes() {
        let input =
            "41 32 0:39 / /tmp/sigma\\999 rw,relatime - overlay overlay rw,lowerdir=/lower\n";
        assert_eq!(
            parse_mountinfo(input),
            Err("mountinfo line 1 has an unsupported path escape".into())
        );
    }

    #[test]
    fn parses_effective_capabilities() {
        let input = "Name:\tsigma-exec\nCapEff:\t00000000a80425fb\n";
        assert_eq!(
            parse_effective_capabilities(input),
            Some(0x0000_0000_a804_25fb)
        );
    }
}
