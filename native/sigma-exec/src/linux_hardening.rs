use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::ffi::{CString, OsStr, OsString};
use std::fs;
use std::io;
use std::mem::size_of;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const INTERNAL_HARDENED_LAUNCHER: &str = "--internal-linux-hardened-launcher";
pub(crate) const INTERNAL_CWD_PIN_MOUNT: &str = "/tmp/.sigma-exec-cwd";
const INTERNAL_HARDENING_PROBE: &str = "--internal-linux-hardening-probe";
const LANDLOCK_CREATE_RULESET_VERSION: libc::c_uint = 1;
const LANDLOCK_RULE_PATH_BENEATH: libc::c_int = 1;
const MINIMUM_LANDLOCK_ABI: i32 = 3;

const ACCESS_EXECUTE: u64 = 1 << 0;
const ACCESS_WRITE_FILE: u64 = 1 << 1;
const ACCESS_READ_FILE: u64 = 1 << 2;
const ACCESS_READ_DIR: u64 = 1 << 3;
const ACCESS_REMOVE_DIR: u64 = 1 << 4;
const ACCESS_REMOVE_FILE: u64 = 1 << 5;
const ACCESS_MAKE_CHAR: u64 = 1 << 6;
const ACCESS_MAKE_DIR: u64 = 1 << 7;
const ACCESS_MAKE_REG: u64 = 1 << 8;
const ACCESS_MAKE_SOCK: u64 = 1 << 9;
const ACCESS_MAKE_FIFO: u64 = 1 << 10;
const ACCESS_MAKE_BLOCK: u64 = 1 << 11;
const ACCESS_MAKE_SYM: u64 = 1 << 12;
const ACCESS_REFER: u64 = 1 << 13;
const ACCESS_TRUNCATE: u64 = 1 << 14;
const ACCESS_READ: u64 = ACCESS_EXECUTE | ACCESS_READ_FILE | ACCESS_READ_DIR;
const ACCESS_WRITE_ALLOWED_V1: u64 = ACCESS_WRITE_FILE
    | ACCESS_REMOVE_DIR
    | ACCESS_REMOVE_FILE
    | ACCESS_MAKE_DIR
    | ACCESS_MAKE_REG
    | ACCESS_MAKE_SOCK
    | ACCESS_MAKE_FIFO
    | ACCESS_MAKE_SYM;
const ACCESS_WRITE_HANDLED_V1: u64 = ACCESS_WRITE_ALLOWED_V1 | ACCESS_MAKE_CHAR | ACCESS_MAKE_BLOCK;

#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
}

#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: libc::c_int,
}

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

struct OwnedFd(libc::c_int);

impl Drop for OwnedFd {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.0);
        }
    }
}

#[derive(Debug)]
struct LauncherSpec {
    read_roots: Vec<PathBuf>,
    write_roots: Vec<PathBuf>,
    cwd_pin: PathBuf,
    argv0: OsString,
    loopback: bool,
    command: Vec<OsString>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HardeningReport {
    pub landlock_abi: i32,
    pub no_new_privileges: bool,
    pub seccomp_filter: bool,
    pub landlock_write_denied: bool,
    pub dangerous_syscall_denied: bool,
    pub mount_namespace: bool,
    pub pid_namespace: bool,
    pub network_namespace: bool,
}

pub(crate) fn try_run_internal_mode() -> Option<i32> {
    let mut arguments = std::env::args_os();
    let _program = arguments.next()?;
    let mode = arguments.next()?;
    if mode == OsStr::new(INTERNAL_HARDENED_LAUNCHER) {
        return Some(run_launcher(arguments.collect()));
    }
    if mode == OsStr::new(INTERNAL_HARDENING_PROBE) {
        return Some(run_probe(arguments.collect()));
    }
    None
}

fn run_launcher(arguments: Vec<OsString>) -> i32 {
    match parse_launcher(arguments).and_then(launch) {
        Ok(never) => never,
        Err(error) => {
            eprintln!("sigma-exec Linux hardening failed: {error}");
            125
        }
    }
}

fn launch(spec: LauncherSpec) -> io::Result<i32> {
    if unsafe { libc::getpid() } != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "hardened launcher must be sandbox PID 1",
        ));
    }
    if spec.loopback {
        enable_loopback()?;
        drop_capabilities()?;
    }
    attest_directory_identity(Path::new("."), &spec.cwd_pin)?;
    apply_landlock_and_seccomp(&spec.read_roots, &spec.write_roots)?;
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        let error = Command::new(&spec.command[0])
            .arg0(&spec.argv0)
            .args(&spec.command[1..])
            .exec();
        eprintln!("sigma-exec command launch failed: {error}");
        unsafe { libc::_exit(126) };
    }
    let status = wait_for_child(child)?;
    unsafe {
        libc::kill(-1, libc::SIGKILL);
    }
    reap_descendants()?;
    Ok(exit_code(status))
}

fn wait_for_child(child: libc::pid_t) -> io::Result<libc::c_int> {
    loop {
        let mut status = 0;
        let result = unsafe { libc::waitpid(child, &mut status, 0) };
        if result == child {
            return Ok(status);
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn reap_descendants() -> io::Result<()> {
    loop {
        let mut status = 0;
        let result = unsafe { libc::waitpid(-1, &mut status, 0) };
        if result > 0 {
            continue;
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ECHILD) {
            return Ok(());
        }
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn exit_code(status: libc::c_int) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        255
    }
}

fn parse_launcher(arguments: Vec<OsString>) -> io::Result<LauncherSpec> {
    let mut read_roots = Vec::new();
    let mut write_roots = Vec::new();
    let mut cwd_pin = None;
    let mut argv0 = None;
    let mut loopback = false;
    let mut index = 0;
    while index < arguments.len() {
        if arguments[index] == OsStr::new("--") {
            let command = arguments[index + 1..].to_vec();
            if command.is_empty() {
                return Err(invalid("hardening launcher requires a command after '--'"));
            }
            if read_roots.is_empty() {
                return Err(invalid(
                    "hardening launcher requires at least one read root",
                ));
            }
            let cwd_pin = cwd_pin
                .ok_or_else(|| invalid("hardening launcher requires exactly one cwd pin"))?;
            let argv0 = argv0
                .ok_or_else(|| invalid("hardening launcher requires exactly one argv0 value"))?;
            return Ok(LauncherSpec {
                read_roots: canonical_roots(read_roots)?,
                write_roots: canonical_roots(write_roots)?,
                cwd_pin: canonical_directory(cwd_pin, "cwd pin")?,
                argv0,
                loopback,
                command,
            });
        }
        match arguments[index].to_str() {
            Some("--read") | Some("--write") => {
                let destination = if arguments[index] == OsStr::new("--read") {
                    &mut read_roots
                } else {
                    &mut write_roots
                };
                index += 1;
                let value = arguments
                    .get(index)
                    .ok_or_else(|| invalid("hardening root flag requires a path"))?;
                destination.push(PathBuf::from(value));
                index += 1;
            }
            Some("--cwd-pin") => {
                if cwd_pin.is_some() {
                    return Err(invalid("hardening launcher accepts only one cwd pin"));
                }
                index += 1;
                let value = arguments
                    .get(index)
                    .ok_or_else(|| invalid("hardening cwd pin flag requires a path"))?;
                cwd_pin = Some(PathBuf::from(value));
                index += 1;
            }
            Some("--argv0") => {
                if argv0.is_some() {
                    return Err(invalid("hardening launcher accepts only one argv0 value"));
                }
                index += 1;
                let value = arguments
                    .get(index)
                    .ok_or_else(|| invalid("hardening argv0 flag requires a value"))?;
                argv0 = Some(value.clone());
                index += 1;
            }
            Some("--loopback") => {
                if loopback {
                    return Err(invalid("hardening launcher accepts only one loopback flag"));
                }
                loopback = true;
                index += 1;
            }
            _ => {
                return Err(invalid(
                    "hardening launcher accepts only --argv0/--cwd-pin/--loopback/--read/--write roots",
                ));
            }
        }
    }
    Err(invalid(
        "hardening launcher is missing the '--' command delimiter",
    ))
}

fn enable_loopback() -> io::Result<()> {
    let descriptor =
        unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    let socket = OwnedFd(descriptor);
    let mut request = unsafe { std::mem::zeroed::<libc::ifreq>() };
    request.ifr_name[0] = b'l' as libc::c_char;
    request.ifr_name[1] = b'o' as libc::c_char;
    if unsafe { libc::ioctl(socket.0, libc::SIOCGIFFLAGS as _, &mut request) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let flags = unsafe { request.ifr_ifru.ifru_flags };
    request.ifr_ifru.ifru_flags = flags | libc::IFF_UP as libc::c_short;
    if unsafe { libc::ioctl(socket.0, libc::SIOCSIFFLAGS as _, &request) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn drop_capabilities() -> io::Result<()> {
    const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
    let header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let data = [CapabilityData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    if unsafe { libc::syscall(libc::SYS_capset, &header, data.as_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn canonical_directory(path: PathBuf, label: &str) -> io::Result<PathBuf> {
    if !path.is_absolute() {
        return Err(invalid("hardening paths must be absolute"));
    }
    let canonical = path.canonicalize()?;
    if !canonical.is_dir() {
        return Err(invalid(&format!("hardening {label} must be a directory")));
    }
    Ok(canonical)
}

fn attest_directory_identity(current: &Path, pinned: &Path) -> io::Result<()> {
    let current = fs::metadata(current)?;
    let pinned = fs::metadata(pinned)?;
    if !current.is_dir()
        || !pinned.is_dir()
        || current.dev() != pinned.dev()
        || current.ino() != pinned.ino()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sandbox cwd does not match its pinned directory object",
        ));
    }
    Ok(())
}

fn canonical_roots(roots: Vec<PathBuf>) -> io::Result<Vec<PathBuf>> {
    let mut result = BTreeSet::new();
    for root in roots {
        if !root.is_absolute() {
            return Err(invalid("Landlock roots must be absolute"));
        }
        result.insert(root.canonicalize()?);
    }
    Ok(result.into_iter().collect())
}

fn apply_landlock_and_seccomp(read_roots: &[PathBuf], write_roots: &[PathBuf]) -> io::Result<()> {
    #[cfg(not(target_arch = "x86_64"))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Sigma Linux hardening currently supports x86_64 only",
    ));

    #[cfg(target_arch = "x86_64")]
    {
        let abi = landlock_abi()?;
        let handled_access = handled_access(abi);
        let ruleset = create_ruleset(handled_access)?;
        for root in read_roots {
            add_path_rule(&ruleset, root, read_access(root)?)?;
        }
        for root in write_roots {
            add_path_rule(&ruleset, root, write_access(root, abi)?)?;
        }
        set_no_new_privileges()?;
        if unsafe { libc::syscall(libc::SYS_landlock_restrict_self, ruleset.0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        install_seccomp_filter()?;
        Ok(())
    }
}

fn landlock_abi() -> io::Result<i32> {
    let result = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<RulesetAttr>(),
            0,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if result < MINIMUM_LANDLOCK_ABI as libc::c_long {
        return Err(if result < 0 {
            io::Error::last_os_error()
        } else {
            io::Error::new(
                io::ErrorKind::Unsupported,
                format!(
                    "Landlock ABI {result} is below required ABI {MINIMUM_LANDLOCK_ABI} (TRUNCATE containment)"
                ),
            )
        });
    }
    Ok(result as i32)
}

fn handled_access(abi: i32) -> u64 {
    ACCESS_READ
        | ACCESS_WRITE_HANDLED_V1
        | if abi >= 2 { ACCESS_REFER } else { 0 }
        | if abi >= 3 { ACCESS_TRUNCATE } else { 0 }
}

fn create_ruleset(handled_access_fs: u64) -> io::Result<OwnedFd> {
    let attribute = RulesetAttr { handled_access_fs };
    let descriptor = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            &attribute,
            size_of::<RulesetAttr>(),
            0,
        )
    };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(OwnedFd(descriptor as libc::c_int))
}

fn add_path_rule(ruleset: &OwnedFd, path: &Path, allowed_access: u64) -> io::Result<()> {
    let value = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| invalid("Landlock root contains NUL"))?;
    let descriptor = unsafe { libc::open(value.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
    if descriptor < 0 {
        return Err(io::Error::last_os_error());
    }
    let parent = OwnedFd(descriptor);
    let attribute = PathBeneathAttr {
        allowed_access,
        parent_fd: parent.0,
    };
    let result = unsafe {
        libc::syscall(
            libc::SYS_landlock_add_rule,
            ruleset.0,
            LANDLOCK_RULE_PATH_BENEATH,
            &attribute,
            0,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn read_access(path: &Path) -> io::Result<u64> {
    Ok(if path.metadata()?.is_dir() {
        ACCESS_READ
    } else {
        ACCESS_EXECUTE | ACCESS_READ_FILE
    })
}

fn write_access(path: &Path, abi: i32) -> io::Result<u64> {
    let metadata = path.metadata()?;
    let directory_versioned =
        if abi >= 2 { ACCESS_REFER } else { 0 } | if abi >= 3 { ACCESS_TRUNCATE } else { 0 };
    let file_versioned = if abi >= 3 { ACCESS_TRUNCATE } else { 0 };
    Ok(if metadata.is_dir() {
        ACCESS_READ | ACCESS_WRITE_ALLOWED_V1 | directory_versioned
    } else {
        ACCESS_EXECUTE | ACCESS_READ_FILE | ACCESS_WRITE_FILE | file_versioned
    })
}

fn set_no_new_privileges() -> io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_arch = "x86_64")]
fn install_seccomp_filter() -> io::Result<()> {
    let mut filter = seccomp_filter();
    let program = libc::sock_fprog {
        len: u16::try_from(filter.len()).map_err(|_| invalid("seccomp filter is too large"))?,
        filter: filter.as_mut_ptr(),
    };
    if unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &program as *const libc::sock_fprog,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(target_arch = "x86_64")]
fn seccomp_filter() -> Vec<libc::sock_filter> {
    const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
    const X32_SYSCALL_BIT: u32 = 0x4000_0000;
    let statement = |code: u32, value: u32| unsafe { libc::BPF_STMT(code as u16, value) };
    let jump = |code: u32, value: u32, yes: u8, no: u8| unsafe {
        libc::BPF_JUMP(code as u16, value, yes, no)
    };
    // EACCES is deliberate: privileged mount attempts without this filter
    // normally fail with EPERM, so the doctor probe can prove our deny branch
    // actually ran instead of merely observing namespace privilege loss.
    let deny = libc::SECCOMP_RET_ERRNO | libc::EACCES as u32;
    let mut result = vec![
        statement(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 4),
        jump(
            libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
            AUDIT_ARCH_X86_64,
            1,
            0,
        ),
        statement(libc::BPF_RET | libc::BPF_K, libc::SECCOMP_RET_KILL_PROCESS),
        statement(libc::BPF_LD | libc::BPF_W | libc::BPF_ABS, 0),
        jump(
            libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K,
            X32_SYSCALL_BIT,
            0,
            1,
        ),
        statement(libc::BPF_RET | libc::BPF_K, deny),
    ];
    for syscall in denied_syscalls() {
        result.push(jump(
            libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
            *syscall as u32,
            0,
            1,
        ));
        result.push(statement(libc::BPF_RET | libc::BPF_K, deny));
    }
    result.push(statement(
        libc::BPF_RET | libc::BPF_K,
        libc::SECCOMP_RET_ALLOW,
    ));
    result
}

#[cfg(target_arch = "x86_64")]
fn denied_syscalls() -> &'static [libc::c_long] {
    &[
        libc::SYS_ptrace,
        libc::SYS_pivot_root,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_reboot,
        libc::SYS_iopl,
        libc::SYS_ioperm,
        libc::SYS_init_module,
        libc::SYS_delete_module,
        libc::SYS_quotactl,
        libc::SYS_kexec_load,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_keyctl,
        libc::SYS_unshare,
        libc::SYS_perf_event_open,
        libc::SYS_name_to_handle_at,
        libc::SYS_open_by_handle_at,
        libc::SYS_setns,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_kcmp,
        libc::SYS_finit_module,
        libc::SYS_kexec_file_load,
        libc::SYS_bpf,
        libc::SYS_userfaultfd,
        libc::SYS_open_tree,
        libc::SYS_move_mount,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_fspick,
        libc::SYS_pidfd_getfd,
        libc::SYS_mount_setattr,
        libc::SYS_quotactl_fd,
    ]
}

fn run_probe(arguments: Vec<OsString>) -> i32 {
    match hardening_probe(arguments) {
        Ok(report) => match serde_json::to_string(&report) {
            Ok(value) => {
                println!("{value}");
                0
            }
            Err(error) => {
                eprintln!("hardening probe serialization failed: {error}");
                125
            }
        },
        Err(error) => {
            eprintln!("hardening probe failed: {error}");
            125
        }
    }
}

fn hardening_probe(arguments: Vec<OsString>) -> io::Result<HardeningReport> {
    if arguments.len() != 5 {
        return Err(invalid(
            "hardening probe requires allowed/denied directories and parent mount/PID/network namespaces",
        ));
    }
    let allowed = PathBuf::from(&arguments[0]).join("allowed-write");
    let denied = PathBuf::from(&arguments[1]).join("denied-write");
    fs::write(&allowed, b"allowed")?;
    let landlock_write_denied = fs::write(&denied, b"denied")
        .err()
        .and_then(|error| error.raw_os_error())
        == Some(libc::EACCES);
    let status = fs::read_to_string("/proc/self/status")?;
    let no_new_privileges = status_value(&status, "NoNewPrivs") == Some("1");
    let seccomp_filter = status_value(&status, "Seccomp") == Some("2");
    let mount_result = unsafe {
        libc::syscall(
            libc::SYS_mount,
            std::ptr::null::<libc::c_char>(),
            std::ptr::null::<libc::c_char>(),
            std::ptr::null::<libc::c_char>(),
            0,
            std::ptr::null::<libc::c_void>(),
        )
    };
    let dangerous_syscall_denied =
        mount_result == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EACCES);
    let namespace_changed = |name: &str, parent: &OsStr| -> io::Result<bool> {
        Ok(fs::read_link(format!("/proc/self/ns/{name}"))?.as_os_str() != parent)
    };
    Ok(HardeningReport {
        landlock_abi: landlock_abi()?,
        no_new_privileges,
        seccomp_filter,
        landlock_write_denied,
        dangerous_syscall_denied,
        mount_namespace: namespace_changed("mnt", &arguments[2])?,
        pid_namespace: namespace_changed("pid", &arguments[3])?,
        network_namespace: namespace_changed("net", &arguments[4])?,
    })
}

fn status_value<'a>(status: &'a str, key: &str) -> Option<&'a str> {
    status.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        (name == key).then(|| value.trim())
    })
}

pub(crate) fn self_test(bwrap: &Path) -> Result<HardeningReport, String> {
    let helper = std::env::current_exe()
        .map_err(|error| format!("cannot resolve sigma-exec hardening helper: {error}"))?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let root = std::env::temp_dir().join(format!(
        "sigma-hardening-test-{}-{unique}",
        std::process::id()
    ));
    let allowed = root.join("allowed");
    let denied = root.join("denied");
    let parent_mount = fs::read_link("/proc/self/ns/mnt").map_err(|error| error.to_string())?;
    let parent_pid = fs::read_link("/proc/self/ns/pid").map_err(|error| error.to_string())?;
    let parent_network = fs::read_link("/proc/self/ns/net").map_err(|error| error.to_string())?;
    fs::create_dir_all(&allowed).map_err(|error| error.to_string())?;
    fs::create_dir_all(&denied).map_err(|error| error.to_string())?;
    let output = Command::new(bwrap)
        .args(self_test_arguments(
            &helper,
            &allowed,
            &denied,
            parent_mount.as_os_str(),
            parent_pid.as_os_str(),
            parent_network.as_os_str(),
        ))
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("hardening self-test launch failed: {error}"));
    let cleanup = fs::remove_dir_all(&root);
    let output = output?;
    cleanup.map_err(|error| format!("hardening self-test cleanup failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "hardening self-test exited {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let report: HardeningReport = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("hardening self-test returned invalid JSON: {error}"))?;
    if report.landlock_abi < MINIMUM_LANDLOCK_ABI
        || !report.no_new_privileges
        || !report.seccomp_filter
        || !report.landlock_write_denied
        || !report.dangerous_syscall_denied
        || !report.mount_namespace
        || !report.pid_namespace
        || !report.network_namespace
    {
        return Err(format!("hardening self-test assertions failed: {report:?}"));
    }
    Ok(report)
}

fn self_test_arguments(
    helper: &Path,
    allowed: &Path,
    denied: &Path,
    parent_mount: &OsStr,
    parent_pid: &OsStr,
    parent_network: &OsStr,
) -> Vec<OsString> {
    [
        OsString::from("--die-with-parent"),
        OsString::from("--new-session"),
        OsString::from("--unshare-all"),
        OsString::from("--as-pid-1"),
        OsString::from("--cap-add"),
        OsString::from("CAP_NET_ADMIN"),
        OsString::from("--ro-bind"),
        OsString::from("/"),
        OsString::from("/"),
        OsString::from("--tmpfs"),
        OsString::from("/tmp"),
        OsString::from("--bind"),
        allowed.as_os_str().to_owned(),
        allowed.as_os_str().to_owned(),
        OsString::from("--bind"),
        denied.as_os_str().to_owned(),
        denied.as_os_str().to_owned(),
        OsString::from("--ro-bind"),
        allowed.as_os_str().to_owned(),
        OsString::from(INTERNAL_CWD_PIN_MOUNT),
        OsString::from("--chdir"),
        allowed.as_os_str().to_owned(),
        OsString::from("--proc"),
        OsString::from("/proc"),
        OsString::from("--dev"),
        OsString::from("/dev"),
        OsString::from("--"),
        helper.as_os_str().to_owned(),
        OsString::from(INTERNAL_HARDENED_LAUNCHER),
        OsString::from("--cwd-pin"),
        OsString::from(INTERNAL_CWD_PIN_MOUNT),
        OsString::from("--argv0"),
        helper.as_os_str().to_owned(),
        OsString::from("--loopback"),
        OsString::from("--read"),
        OsString::from("/"),
        OsString::from("--write"),
        allowed.as_os_str().to_owned(),
        OsString::from("--"),
        helper.as_os_str().to_owned(),
        OsString::from(INTERNAL_HARDENING_PROBE),
        allowed.as_os_str().to_owned(),
        denied.as_os_str().to_owned(),
        parent_mount.to_owned(),
        parent_pid.to_owned(),
        parent_network.to_owned(),
    ]
    .into_iter()
    .collect()
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_test_argv_keeps_binds_and_probe_namespace_arguments_in_order() {
        let arguments = self_test_arguments(
            Path::new("/sigma-exec"),
            Path::new("/tmp/allowed"),
            Path::new("/tmp/denied"),
            OsStr::new("mnt:[1]"),
            OsStr::new("pid:[2]"),
            OsStr::new("net:[3]"),
        );
        let values = arguments
            .iter()
            .map(|item| item.to_string_lossy())
            .collect::<Vec<_>>();
        assert_eq!(values[3], "--as-pid-1");
        assert_eq!(
            &values[7..15],
            [
                "--tmpfs",
                "/tmp",
                "--bind",
                "/tmp/allowed",
                "/tmp/allowed",
                "--bind",
                "/tmp/denied",
                "/tmp/denied",
            ]
        );
        let cwd_pin = values
            .windows(2)
            .any(|pair| pair == ["--cwd-pin", INTERNAL_CWD_PIN_MOUNT]);
        assert!(cwd_pin);
        let argv0 = values
            .windows(2)
            .any(|pair| pair == ["--argv0", "/sigma-exec"]);
        assert!(argv0);
        let probe = values
            .iter()
            .position(|value| *value == INTERNAL_HARDENING_PROBE)
            .expect("probe argument");
        assert_eq!(
            &values[probe + 1..],
            [
                "/tmp/allowed",
                "/tmp/denied",
                "mnt:[1]",
                "pid:[2]",
                "net:[3]",
            ]
        );
    }

    #[test]
    fn launcher_parser_requires_roots_delimiter_and_command() {
        assert!(parse_launcher(vec![]).is_err());
        assert!(parse_launcher(vec!["--".into(), "/bin/true".into()]).is_err());
        assert!(parse_launcher(vec!["--read".into(), "/".into()]).is_err());
        let parsed = parse_launcher(vec![
            "--cwd-pin".into(),
            "/".into(),
            "--argv0".into(),
            "true".into(),
            "--loopback".into(),
            "--read".into(),
            "/".into(),
            "--write".into(),
            "/tmp".into(),
            "--".into(),
            "/bin/true".into(),
        ])
        .expect("valid launcher");
        assert_eq!(parsed.command[0], OsStr::new("/bin/true"));
        assert_eq!(parsed.argv0, OsStr::new("true"));
        assert!(parsed.loopback);
        assert!(
            parse_launcher(vec![
                "--cwd-pin".into(),
                "/".into(),
                "--cwd-pin".into(),
                "/".into(),
                "--argv0".into(),
                "true".into(),
                "--read".into(),
                "/".into(),
                "--".into(),
                "/bin/true".into(),
            ])
            .is_err()
        );
    }

    #[test]
    fn cwd_attestation_rejects_replacement_and_preserves_relative_execution() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "sigma-cwd-attestation-{}-{unique}",
            std::process::id()
        ));
        let declared = root.join("declared");
        let pin_alias = root.join("pin-alias");
        fs::create_dir_all(&declared).expect("create cwd");
        let executable = declared.join("relative-tool");
        fs::write(&executable, "#!/bin/sh\nprintf pinned-cwd-ok")
            .expect("write relative executable");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("make relative executable runnable");
        symlink(&declared, &pin_alias).expect("create cwd pin alias");

        attest_directory_identity(&declared, &pin_alias).expect("same cwd object should attest");
        let output = Command::new("./relative-tool")
            .current_dir(&declared)
            .output()
            .expect("run relative executable");
        assert!(output.status.success());
        assert_eq!(output.stdout, b"pinned-cwd-ok");

        fs::remove_file(&pin_alias).expect("remove pin alias");
        let pinned = root.join("pinned-original");
        fs::rename(&declared, &pinned).expect("move original cwd");
        fs::create_dir_all(&declared).expect("create replacement cwd");
        assert!(attest_directory_identity(&declared, &pinned).is_err());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn seccomp_denylist_covers_required_escape_surfaces() {
        for required in [
            libc::SYS_mount,
            libc::SYS_pivot_root,
            libc::SYS_ptrace,
            libc::SYS_bpf,
            libc::SYS_perf_event_open,
            libc::SYS_keyctl,
        ] {
            assert!(denied_syscalls().contains(&required));
        }
        assert_eq!(
            seccomp_filter().last().expect("allow").k,
            libc::SECCOMP_RET_ALLOW
        );
    }
}
