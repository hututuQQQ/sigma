use crate::protocol::RpcError;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
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
// Harbor grants the outer task container CAP_SYS_ADMIN solely so bubblewrap
// can create a nested mount/user namespace. The command still runs inside
// that nested namespace, and the attestation below independently requires a
// copy-on-write container root with no host-control sockets. Capabilities
// which directly inspect or control the enclosing host remain disallowed.
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
    pub(crate) reason: Option<String>,
}

impl EnclosingContainerBoundary {
    pub(crate) fn report(&self) -> Value {
        json!({
            "available": self.available,
            "rootKind": if self.available { "container_cow" } else { "unavailable" },
            "attestationDigest": self.attestation_digest,
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
            reason: Some(reason),
        })
    })
}

pub(crate) fn require_enclosing_container_boundary() -> Result<(), RpcError> {
    let boundary = inspect_enclosing_container_boundary();
    if boundary.available {
        return Ok(());
    }
    Err(RpcError::new(
        "enclosing_container_unavailable",
        boundary
            .reason
            .as_deref()
            .unwrap_or("the enclosing container boundary could not be attested"),
    ))
}

fn inspect_inner() -> Result<EnclosingContainerBoundary, String> {
    let marker = trusted_container_marker()?;
    let root_filesystem = root_filesystem_type()?;
    if root_filesystem != "overlay" && root_filesystem != "fuse-overlayfs" {
        return Err(format!(
            "root filesystem '{root_filesystem}' is not an attested copy-on-write container root"
        ));
    }
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
    let material = format!(
        "v1\0{}\0{}\0{}\0{}\0{:x}",
        marker.display(),
        marker_metadata.dev(),
        marker_metadata.ino(),
        root_filesystem,
        effective_capabilities
    );
    let digest = format!("sha256:{:x}", Sha256::digest(material.as_bytes()));
    Ok(EnclosingContainerBoundary {
        available: true,
        attestation_digest: Some(digest),
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

fn root_filesystem_type() -> Result<String, String> {
    parse_root_filesystem_type(
        &fs::read_to_string("/proc/self/mountinfo")
            .map_err(|error| format!("cannot read mount namespace: {error}"))?,
    )
    .ok_or_else(|| "root filesystem was not found in mountinfo".into())
}

fn parse_root_filesystem_type(mountinfo: &str) -> Option<String> {
    for line in mountinfo.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.get(4).copied() != Some("/") {
            continue;
        }
        let separator = fields.iter().position(|field| *field == "-")?;
        return fields.get(separator + 1).map(|value| (*value).to_owned());
    }
    None
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
    fn parses_effective_capabilities() {
        let input = "Name:\tsigma-exec\nCapEff:\t00000000a80425fb\n";
        assert_eq!(
            parse_effective_capabilities(input),
            Some(0x0000_0000_a804_25fb)
        );
    }
}
