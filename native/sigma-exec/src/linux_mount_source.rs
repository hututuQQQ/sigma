use crate::protocol::RpcError;
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{File, Metadata};
use std::io;
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    kind: u32,
}

impl FileIdentity {
    fn from_metadata(metadata: &Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            kind: metadata.mode() & libc::S_IFMT,
        }
    }
}

pub(crate) struct ResolvedMountSource {
    destination: PathBuf,
    identity: FileIdentity,
}

impl ResolvedMountSource {
    pub(crate) fn resolve(path: &Path) -> Result<Self, RpcError> {
        if !path.is_absolute() {
            return Err(RpcError::new(
                "policy_denied",
                "sandbox mount sources must be absolute",
            ));
        }
        let original = std::fs::metadata(path).map_err(|error| invalid_root(path, error))?;
        let destination = path
            .canonicalize()
            .map_err(|error| invalid_root(path, error))?;
        let resolved =
            std::fs::symlink_metadata(&destination).map_err(|error| invalid_root(path, error))?;
        let identity = FileIdentity::from_metadata(&original);
        if identity != FileIdentity::from_metadata(&resolved) {
            return Err(changed_root(path));
        }
        Ok(Self {
            destination,
            identity,
        })
    }

    pub(crate) fn destination(&self) -> &Path {
        &self.destination
    }

    pub(crate) fn is_directory(&self) -> bool {
        self.identity.kind == libc::S_IFDIR
    }

    pub(crate) fn pin(self) -> Result<PinnedMountSource, RpcError> {
        let encoded = CString::new(self.destination.as_os_str().as_bytes()).map_err(|_| {
            RpcError::new(
                "policy_denied",
                "sandbox mount source contains an embedded NUL byte",
            )
        })?;
        // O_PATH gives both files and directories a stable identity without
        // granting a new read or write mode. O_NOFOLLOW ensures a last-moment
        // symlink replacement is opened as the link itself and rejected by
        // the identity comparison below.
        let opened_fd = unsafe {
            libc::open(
                encoded.as_ptr(),
                libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if opened_fd < 0 {
            return Err(invalid_root(&self.destination, io::Error::last_os_error()));
        }
        let opened = unsafe { File::from_raw_fd(opened_fd) };
        if FileIdentity::from_metadata(
            &opened
                .metadata()
                .map_err(|error| invalid_root(&self.destination, error))?,
        ) != self.identity
        {
            return Err(changed_root(&self.destination));
        }
        let current = std::fs::symlink_metadata(&self.destination)
            .map_err(|error| invalid_root(&self.destination, error))?;
        if FileIdentity::from_metadata(&current) != self.identity {
            return Err(changed_root(&self.destination));
        }

        // A mount-source descriptor must not collide with standard I/O. Keep
        // CLOEXEC set in the broker and clear it only in the forked bwrap
        // child, so concurrent unrelated launches cannot inherit this root.
        let descriptor = duplicate_descriptor(&opened, &self.destination)?;
        Ok(PinnedMountSource {
            destination: self.destination,
            descriptor,
        })
    }
}

#[derive(Debug)]
pub(crate) struct PinnedMountSource {
    destination: PathBuf,
    descriptor: File,
}

impl PinnedMountSource {
    pub(crate) fn pin(path: &Path) -> Result<Self, RpcError> {
        ResolvedMountSource::resolve(path)?.pin()
    }

    pub(crate) fn destination(&self) -> &Path {
        &self.destination
    }

    pub(crate) fn raw_fd(&self) -> RawFd {
        self.descriptor.as_raw_fd()
    }

    pub(crate) fn fd_path(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.raw_fd()))
    }

    pub(crate) fn is_file(&self) -> Result<bool, RpcError> {
        self.descriptor
            .metadata()
            .map(|metadata| metadata.is_file())
            .map_err(|error| invalid_root(&self.destination, error))
    }

    pub(crate) fn is_executable_file(&self) -> Result<bool, RpcError> {
        if !self.is_file()? {
            return Ok(false);
        }
        // faccessat2 with AT_EMPTY_PATH asks the kernel about this exact open
        // file object. AT_EACCESS matches the credentials execve will use and
        // avoids a second pathname lookup after authorization.
        let result = unsafe {
            libc::syscall(
                libc::SYS_faccessat2,
                self.raw_fd(),
                c"".as_ptr(),
                libc::X_OK,
                libc::AT_EMPTY_PATH | libc::AT_EACCESS,
            )
        };
        if result == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::EACCES | libc::EPERM)) {
            return Ok(false);
        }
        Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "cannot verify executable access for '{}': {error}",
                self.destination.display()
            ),
        ))
    }

    pub(crate) fn sha256(&self) -> Result<String, RpcError> {
        let mut reader = File::open(self.fd_path()).map_err(|error| {
            RpcError::new(
                "executable_unavailable",
                format!(
                    "cannot read pinned executable '{}': {error}",
                    self.destination.display()
                ),
            )
        })?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = reader.read(&mut buffer).map_err(|error| {
                RpcError::new(
                    "executable_unavailable",
                    format!(
                        "cannot hash pinned executable '{}': {error}",
                        self.destination.display()
                    ),
                )
            })?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    pub(crate) fn occupies_destination(&self, destination: &Path) -> Result<bool, RpcError> {
        if self.destination.starts_with(destination) {
            return Ok(true);
        }
        let relative = match destination.strip_prefix(&self.destination) {
            Ok(relative) => relative,
            Err(_) => return Ok(false),
        };
        if relative.as_os_str().is_empty() {
            return Ok(true);
        }
        let mut current = duplicate_descriptor(&self.descriptor, &self.destination)?;
        let components = relative.components().collect::<Vec<_>>();
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                return Err(RpcError::new(
                    "policy_denied",
                    "reserved sandbox path contains an invalid relative component",
                ));
            };
            let encoded = CString::new(name.as_bytes()).map_err(|_| {
                RpcError::new(
                    "policy_denied",
                    "reserved sandbox path contains an embedded NUL byte",
                )
            })?;
            let mut flags = libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW;
            if index + 1 < components.len() {
                flags |= libc::O_DIRECTORY;
            }
            let child_fd = unsafe { libc::openat(current.as_raw_fd(), encoded.as_ptr(), flags) };
            if child_fd < 0 {
                let error = io::Error::last_os_error();
                return match error.raw_os_error() {
                    Some(libc::ENOENT) => Ok(false),
                    // A non-directory or symlink in an intermediate component
                    // still occupies the reserved destination and must fail
                    // closed instead of being hidden by an internal mount.
                    Some(libc::ENOTDIR | libc::ELOOP) => Ok(true),
                    _ => Err(invalid_root(destination, error)),
                };
            }
            current = unsafe { File::from_raw_fd(child_fd) };
            if FileIdentity::from_metadata(
                &current
                    .metadata()
                    .map_err(|error| invalid_root(destination, error))?,
            )
            .kind
                == libc::S_IFLNK
            {
                return Ok(true);
            }
        }
        Ok(true)
    }

    pub(crate) fn destination_matches_identity(&self) -> Result<bool, RpcError> {
        let expected = FileIdentity::from_metadata(
            &self
                .descriptor
                .metadata()
                .map_err(|error| invalid_root(&self.destination, error))?,
        );
        match std::fs::symlink_metadata(&self.destination) {
            Ok(metadata) => Ok(FileIdentity::from_metadata(&metadata) == expected),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(invalid_root(&self.destination, error)),
        }
    }

    pub(crate) fn append_bind(&self, command: &mut Command, read_only: bool) {
        self.append_bind_at(command, read_only, &self.destination);
    }

    pub(crate) fn append_bind_at(
        &self,
        command: &mut Command,
        read_only: bool,
        destination: &Path,
    ) {
        command
            .arg(if read_only {
                "--ro-bind-fd"
            } else {
                "--bind-fd"
            })
            .arg(self.raw_fd().to_string())
            .arg(destination);
    }

    pub(crate) fn into_descriptor(self) -> File {
        self.descriptor
    }

    pub(crate) fn is_descendant_of(&self, ancestor: &PinnedMountSource) -> Result<bool, RpcError> {
        let relative = match self.destination.strip_prefix(&ancestor.destination) {
            Ok(relative) => relative,
            Err(_) => return Ok(false),
        };
        let expected = FileIdentity::from_metadata(
            &self
                .descriptor
                .metadata()
                .map_err(|error| invalid_root(&self.destination, error))?,
        );
        let mut current = duplicate_descriptor(&ancestor.descriptor, &ancestor.destination)?;
        let components = relative.components().collect::<Vec<_>>();
        if components.is_empty() {
            let actual = FileIdentity::from_metadata(
                &current
                    .metadata()
                    .map_err(|error| invalid_root(&ancestor.destination, error))?,
            );
            return Ok(actual == expected);
        }
        for (index, component) in components.iter().enumerate() {
            let Component::Normal(name) = component else {
                return Err(RpcError::new(
                    "policy_denied",
                    "canonical sandbox root contains an invalid relative component",
                ));
            };
            let encoded = CString::new(name.as_bytes()).map_err(|_| {
                RpcError::new(
                    "policy_denied",
                    "sandbox root component contains an embedded NUL byte",
                )
            })?;
            let mut flags = libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW;
            if index + 1 < components.len() {
                flags |= libc::O_DIRECTORY;
            }
            let child_fd = unsafe { libc::openat(current.as_raw_fd(), encoded.as_ptr(), flags) };
            if child_fd < 0 {
                return Ok(false);
            }
            current = unsafe { File::from_raw_fd(child_fd) };
            let identity = FileIdentity::from_metadata(
                &current
                    .metadata()
                    .map_err(|error| invalid_root(&self.destination, error))?,
            );
            if identity.kind == libc::S_IFLNK {
                return Ok(false);
            }
        }
        Ok(FileIdentity::from_metadata(
            &current
                .metadata()
                .map_err(|error| invalid_root(&self.destination, error))?,
        ) == expected)
    }
}

fn duplicate_descriptor(descriptor: &File, path: &Path) -> Result<File, RpcError> {
    let inherited_fd = unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
    if inherited_fd < 0 {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "cannot reserve a sandbox mount descriptor for '{}': {}",
                path.display(),
                io::Error::last_os_error()
            ),
        ));
    }
    Ok(unsafe { File::from_raw_fd(inherited_fd) })
}

pub(crate) fn inherit_mount_sources(
    command: &mut Command,
    sources: &[RawFd],
) -> Result<(), RpcError> {
    if sources.is_empty() {
        return Ok(());
    }
    if sources.iter().any(|fd| *fd < 3) {
        return Err(RpcError::new(
            "sandbox_unavailable",
            "sandbox mount descriptors must not overlap standard I/O",
        ));
    }
    let sources = sources.to_vec();
    // SAFETY: this closure runs after fork and before exec. It only calls
    // fcntl, which is async-signal-safe, and operates on descriptors kept
    // alive by PreparedCommand until Command::spawn has completed.
    unsafe {
        command.pre_exec(move || {
            for descriptor in &sources {
                let flags = libc::fcntl(*descriptor, libc::F_GETFD);
                if flags < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::fcntl(*descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Ok(())
}

fn invalid_root(path: &Path, error: io::Error) -> RpcError {
    RpcError::new(
        "policy_denied",
        format!("invalid sandbox root '{}': {error}", path.display()),
    )
}

fn changed_root(path: &Path) -> RpcError {
    RpcError::new(
        "policy_denied",
        format!(
            "sandbox root changed while its mount source was being pinned: '{}'",
            path.display()
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "sigma-mount-source-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn rejects_a_symlink_replacement_between_resolution_and_pin() {
        let root = test_root("swap");
        let declared = root.join("declared");
        let moved = root.join("moved");
        let replacement = root.join("replacement");
        std::fs::create_dir_all(&declared).expect("create declared root");
        std::fs::create_dir_all(&replacement).expect("create replacement root");
        let resolved = ResolvedMountSource::resolve(&declared).expect("resolve root");
        std::fs::rename(&declared, &moved).expect("rename declared root");
        symlink(&replacement, &declared).expect("replace root with symlink");

        let error = resolved.pin().expect_err("replacement must fail closed");
        assert_eq!(error.code, "policy_denied");
        assert!(error.message.contains("changed while"));
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn pins_directory_and_file_objects_across_path_replacement() {
        let root = test_root("stable");
        let directory = root.join("directory");
        let moved_directory = root.join("moved-directory");
        let file = root.join("file.txt");
        let moved_file = root.join("moved-file.txt");
        let replacement = root.join("replacement");
        std::fs::create_dir_all(&directory).expect("create directory root");
        std::fs::write(directory.join("value.txt"), "trusted-directory")
            .expect("write directory value");
        std::fs::write(&file, "trusted-file").expect("write file root");
        std::fs::create_dir_all(&replacement).expect("create replacement");
        std::fs::write(replacement.join("value.txt"), "replacement-directory")
            .expect("write replacement value");
        let directory_source = PinnedMountSource::pin(&directory).expect("pin directory");
        let file_source = PinnedMountSource::pin(&file).expect("pin file");
        std::fs::rename(&directory, &moved_directory).expect("move directory");
        std::fs::rename(&file, &moved_file).expect("move file");
        symlink(&replacement, &directory).expect("replace directory path");
        std::fs::write(&file, "replacement-file").expect("replace file path");

        let directory_fd = PathBuf::from(format!(
            "/proc/self/fd/{}/value.txt",
            directory_source.raw_fd()
        ));
        let file_fd = PathBuf::from(format!("/proc/self/fd/{}", file_source.raw_fd()));
        assert_eq!(
            std::fs::read_to_string(directory_fd).expect("read pinned directory"),
            "trusted-directory"
        );
        assert_eq!(
            std::fs::read_to_string(file_fd).expect("read pinned file"),
            "trusted-file"
        );
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn inherits_only_explicit_mount_descriptors_and_emits_fd_bind_arguments() {
        let root = test_root("inherit");
        std::fs::create_dir_all(&root).expect("create test root");
        let file = root.join("value.txt");
        std::fs::write(&file, "trusted").expect("write test file");
        let source = PinnedMountSource::pin(&file).expect("pin file");
        let descriptor = source.raw_fd();
        let parent_flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        assert_ne!(parent_flags & libc::FD_CLOEXEC, 0);

        let mut rendered = Command::new("/bin/true");
        source.append_bind(&mut rendered, true);
        let arguments = rendered
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            arguments,
            vec![
                "--ro-bind-fd".to_owned(),
                descriptor.to_string(),
                source.destination().to_string_lossy().into_owned(),
            ]
        );

        let mut child = Command::new("/bin/sh");
        child
            .arg("-c")
            .arg(format!("test -r /proc/self/fd/{descriptor}"));
        inherit_mount_sources(&mut child, &[descriptor]).expect("configure inheritance");
        assert!(child.status().expect("run inheritance probe").success());
        let flags_after = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        assert_ne!(flags_after & libc::FD_CLOEXEC, 0);
        std::fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn rejects_a_nested_root_from_a_replacement_ancestor() {
        let root = test_root("ancestry");
        let declared = root.join("declared");
        let moved = root.join("moved");
        std::fs::create_dir_all(declared.join("child")).expect("create declared tree");
        let ancestor = PinnedMountSource::pin(&declared).expect("pin ancestor");
        let original = PinnedMountSource::pin(&declared.join("child")).expect("pin child");
        assert!(
            original
                .is_descendant_of(&ancestor)
                .expect("verify ancestry")
        );
        std::fs::rename(&declared, &moved).expect("move declared tree");
        std::fs::create_dir_all(declared.join("child")).expect("create replacement tree");
        let replacement =
            PinnedMountSource::pin(&declared.join("child")).expect("pin replacement child");

        assert!(
            !replacement
                .is_descendant_of(&ancestor)
                .expect("verify ancestry")
        );
        std::fs::remove_dir_all(root).expect("remove test root");
    }
}
