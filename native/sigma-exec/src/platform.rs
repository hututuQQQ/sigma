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
    watchdog: Option<Child>,
}

#[cfg(target_os = "linux")]
impl PlatformGuard {
    pub(crate) fn attach(child: &mut Child) -> Result<Self, RpcError> {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let process_group = child.id() as i32;
        let broker_pid = unsafe { libc::getpid() };
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
            .arg(broker_pid.to_string())
            .arg(process_group.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        unsafe {
            command.pre_exec(|| {
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
        Ok(Self {
            process_group,
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
        if let Some(mut watchdog) = self.watchdog.take() {
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
    let mut arguments = std::env::args();
    let _program = arguments.next()?;
    if arguments.next()?.as_str() != INTERNAL_PROCESS_WATCHDOG {
        return None;
    }
    let broker_pid = arguments.next()?.parse::<i32>().ok()?;
    let process_group = arguments.next()?.parse::<i32>().ok()?;
    Some(run_watchdog(broker_pid, process_group))
}

#[cfg(target_os = "linux")]
fn run_watchdog(broker_pid: i32, process_group: i32) -> i32 {
    if broker_pid <= 1 || process_group <= 1 {
        return 2;
    }
    let broker_fd = unsafe { libc::syscall(libc::SYS_pidfd_open, broker_pid, 0) as i32 };
    if broker_fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return 3;
        }
    } else {
        let mut descriptor = libc::pollfd {
            fd: broker_fd,
            events: libc::POLLIN,
            revents: 0,
        };
        loop {
            let result = unsafe { libc::poll(&mut descriptor, 1, -1) };
            if result >= 0 {
                break;
            }
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                unsafe {
                    libc::close(broker_fd);
                }
                return 4;
            }
        }
        unsafe {
            libc::close(broker_fd);
        }
    }
    unsafe {
        libc::kill(process_group, libc::SIGKILL);
        libc::kill(-process_group, libc::SIGKILL);
    }
    0
}
