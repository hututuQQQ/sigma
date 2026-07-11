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

#[cfg(not(windows))]
pub(crate) struct PlatformGuard {
    process_group: i32,
}

#[cfg(not(windows))]
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

#[cfg(not(windows))]
impl Drop for PlatformGuard {
    fn drop(&mut self) {
        self.cleanup_descendants();
    }
}
