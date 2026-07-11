use crate::protocol::RpcError;
use std::process::Child;

#[cfg(windows)]
pub(crate) struct PlatformGuard {
    handle: isize,
}

#[cfg(windows)]
impl PlatformGuard {
    pub(crate) fn attach(child: &mut Child) -> Result<Self, RpcError> {
        use std::mem::size_of;
        use std::os::windows::io::AsRawHandle;
        use std::ptr::null;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(null(), null());
            if job.is_null() {
                let _ = child.kill();
                return Err(RpcError::new(
                    "process_containment_failed",
                    "CreateJobObjectW failed",
                ));
            }
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let assigned = set != 0 && AssignProcessToJobObject(job, child.as_raw_handle()) != 0;
            if !assigned {
                windows_sys::Win32::Foundation::CloseHandle(job);
                let _ = child.kill();
                return Err(RpcError::new(
                    "process_containment_failed",
                    "failed to assign process to kill-on-close Job Object",
                ));
            }
            Ok(Self {
                handle: job as isize,
            })
        }
    }

    pub(crate) fn terminate(&self, _child: &mut Child) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle as _, 1);
        }
    }

    pub(crate) fn force_terminate(&self, child: &mut Child) {
        self.terminate(child);
    }

    pub(crate) fn cleanup_descendants(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle as _, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for PlatformGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

#[cfg(all(not(windows), not(target_os = "linux")))]
pub(crate) struct PlatformGuard {
    process_group: i32,
}

#[cfg(all(not(windows), not(target_os = "linux")))]
impl PlatformGuard {
    pub(crate) fn attach(child: &mut Child) -> Result<Self, RpcError> {
        Ok(Self {
            process_group: child.id() as i32,
        })
    }

    pub(crate) fn terminate(&self, child: &mut Child) {
        #[cfg(unix)]
        unsafe {
            if libc::kill(-self.process_group, libc::SIGTERM) != 0 {
                let _ = child.kill();
            }
        }
        #[cfg(not(unix))]
        {
            let _ = child.kill();
        }
    }

    pub(crate) fn force_terminate(&self, child: &mut Child) {
        #[cfg(unix)]
        unsafe {
            if libc::kill(-self.process_group, libc::SIGKILL) != 0 {
                let _ = child.kill();
            }
        }
        #[cfg(not(unix))]
        {
            let _ = child.kill();
        }
    }

    pub(crate) fn cleanup_descendants(&self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-self.process_group, libc::SIGKILL);
        }
    }
}

#[cfg(all(not(windows), not(target_os = "linux")))]
impl Drop for PlatformGuard {
    fn drop(&mut self) {
        self.cleanup_descendants();
    }
}

#[cfg(target_os = "linux")]
const INTERNAL_PROCESS_WATCHDOG: &str = "--internal-linux-process-watchdog";

#[cfg(target_os = "linux")]
pub(crate) struct PlatformGuard {
    process_group: i32,
    watchdog_write: Option<std::os::fd::OwnedFd>,
    watchdog: Option<Child>,
}

#[cfg(target_os = "linux")]
impl PlatformGuard {
    pub(crate) fn attach(child: &mut Child) -> Result<Self, RpcError> {
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let process_group = child.id() as i32;
        let mut descriptors = [0; 2];
        if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            let _ = child.kill();
            return Err(RpcError::new(
                "process_containment_failed",
                format!(
                    "failed to create Linux process watchdog pipe: {}",
                    std::io::Error::last_os_error()
                ),
            ));
        }
        let watchdog_read = unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptors[0]) };
        let watchdog_write = unsafe { std::os::fd::OwnedFd::from_raw_fd(descriptors[1]) };
        let read_fd = watchdog_read.as_raw_fd();
        let write_fd = watchdog_write.as_raw_fd();
        let executable = std::env::current_exe().map_err(|error| {
            let _ = child.kill();
            RpcError::new(
                "process_containment_failed",
                format!("failed to resolve Linux process watchdog: {error}"),
            )
        })?;
        let mut command = Command::new(executable);
        command
            .arg(INTERNAL_PROCESS_WATCHDOG)
            .arg(read_fd.to_string())
            .arg(process_group.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(read_fd, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::close(write_fd);
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let watchdog = command.spawn().map_err(|error| {
            let _ = child.kill();
            RpcError::new(
                "process_containment_failed",
                format!("failed to start Linux process watchdog: {error}"),
            )
        })?;
        drop(watchdog_read);
        Ok(Self {
            process_group,
            watchdog_write: Some(watchdog_write),
            watchdog: Some(watchdog),
        })
    }

    pub(crate) fn terminate(&mut self, child: &mut Child) {
        unsafe {
            if libc::kill(-self.process_group, libc::SIGTERM) != 0 {
                let _ = child.kill();
            }
        }
    }

    pub(crate) fn force_terminate(&mut self, child: &mut Child) {
        unsafe {
            if libc::kill(-self.process_group, libc::SIGKILL) != 0 {
                let _ = child.kill();
            }
        }
    }

    pub(crate) fn cleanup_descendants(&mut self) {
        unsafe {
            libc::kill(-self.process_group, libc::SIGKILL);
        }
        drop(self.watchdog_write.take());
        if let Some(mut watchdog) = self.watchdog.take() {
            for _ in 0..50 {
                if watchdog.try_wait().ok().flatten().is_some() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            let _ = watchdog.kill();
            let _ = watchdog.wait();
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for PlatformGuard {
    fn drop(&mut self) {
        self.cleanup_descendants();
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn try_run_internal_mode() -> Option<i32> {
    use std::os::fd::RawFd;

    let mut arguments = std::env::args();
    let _program = arguments.next()?;
    if arguments.next()?.as_str() != INTERNAL_PROCESS_WATCHDOG {
        return None;
    }
    let read_fd = arguments.next()?.parse::<RawFd>().ok()?;
    let process_group = arguments.next()?.parse::<i32>().ok()?;
    Some(run_watchdog(read_fd, process_group))
}

#[cfg(target_os = "linux")]
fn run_watchdog(read_fd: std::os::fd::RawFd, process_group: i32) -> i32 {
    if read_fd < 0 || process_group <= 1 {
        return 2;
    }
    let mut byte = 0_u8;
    loop {
        let result = unsafe { libc::read(read_fd, (&mut byte as *mut u8).cast(), 1) };
        if result == 0 {
            break;
        }
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            unsafe {
                libc::close(read_fd);
            }
            return 3;
        }
    }
    unsafe {
        libc::close(read_fd);
        libc::kill(-process_group, libc::SIGKILL);
    }
    0
}
