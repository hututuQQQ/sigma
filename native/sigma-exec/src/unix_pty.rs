use std::io;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::ptr::{null, null_mut};

const INTERNAL_PTY_LAUNCHER: &str = "--internal-unix-pty-launcher";

pub(crate) fn try_run_internal_mode() -> Option<i32> {
    let mut arguments = std::env::args();
    let _program = arguments.next()?;
    if arguments.next()?.as_str() != INTERNAL_PTY_LAUNCHER {
        return None;
    }
    Some(run(arguments.collect()))
}

fn run(arguments: Vec<String>) -> i32 {
    match run_pty(arguments) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("sigma-exec PTY launcher failed: {error}");
            125
        }
    }
}

fn run_pty(arguments: Vec<String>) -> io::Result<i32> {
    if arguments.len() < 3 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "PTY launcher requires columns, rows, and an executable",
        ));
    }
    let columns = dimension(&arguments[0], "columns")?;
    let rows = dimension(&arguments[1], "rows")?;
    let executable = &arguments[2];
    let command_arguments = &arguments[3..];
    let size = libc::winsize {
        ws_row: rows,
        ws_col: columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let mut master = -1;
    let child = unsafe { libc::forkpty(&mut master, null_mut(), null(), &size) };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child == 0 {
        let error = Command::new(executable).args(command_arguments).exec();
        eprintln!("sigma-exec PTY exec failed: {error}");
        unsafe { libc::_exit(126) }
    }
    let input = unsafe { libc::dup(master) };
    if input < 0 {
        unsafe {
            libc::kill(child, libc::SIGKILL);
            libc::close(master);
        }
        return Err(io::Error::last_os_error());
    }
    std::thread::spawn(move || {
        copy_fd(libc::STDIN_FILENO, input);
        unsafe {
            libc::close(input);
        }
    });
    copy_fd(master, libc::STDOUT_FILENO);
    unsafe {
        libc::close(master);
    }
    wait_for_child(child)
}

fn dimension(value: &str, label: &str) -> io::Result<u16> {
    value
        .parse::<u16>()
        .ok()
        .filter(|item| *item > 0)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("PTY {label} must be a positive 16-bit integer"),
            )
        })
}

fn copy_fd(input: i32, output: i32) {
    let mut buffer = [0_u8; 8192];
    loop {
        let read = unsafe { libc::read(input, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read <= 0 {
            return;
        }
        let mut offset = 0;
        while offset < read as usize {
            let written = unsafe {
                libc::write(
                    output,
                    buffer[offset..read as usize].as_ptr().cast(),
                    read as usize - offset,
                )
            };
            if written <= 0 {
                return;
            }
            offset += written as usize;
        }
    }
}

fn wait_for_child(child: libc::pid_t) -> io::Result<i32> {
    let mut status = 0;
    if unsafe { libc::waitpid(child, &mut status, 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    if libc::WIFEXITED(status) {
        Ok(libc::WEXITSTATUS(status))
    } else if libc::WIFSIGNALED(status) {
        Ok(128 + libc::WTERMSIG(status))
    } else {
        Ok(125)
    }
}
