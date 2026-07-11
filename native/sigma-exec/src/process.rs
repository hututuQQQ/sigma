use crate::output::{OutputRing, OutputSnapshot};
use crate::output_artifact::{
    ArtifactCapture, OutputArtifactMetadata, RedactionConfig, RedactionSecret,
    cleanup_artifact_root, prepare_artifact_root,
};
use crate::platform::PlatformGuard;
use crate::protocol::RpcError;
use crate::sandbox::{ProcessParams, ProtectedPathGuard, build_command};
use serde::Deserialize;
use serde_json::{Value, json, to_value};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

static ARTIFACT_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandleParams {
    pub handle_id: String,
    #[serde(default)]
    pub stdout_offset: u64,
    #[serde(default)]
    pub stderr_offset: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteParams {
    pub handle_id: String,
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub target_request_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseArtifactParams {
    #[serde(default)]
    pub artifact_ids: Vec<String>,
}

struct ManagedProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Arc<Mutex<OutputRing>>,
    stderr: Arc<Mutex<OutputRing>>,
    started: Instant,
    exit_code: Option<i32>,
    signal: Option<String>,
    exited: bool,
    terminated: bool,
    cancelled: bool,
    capture_threads: Vec<JoinHandle<()>>,
    stdout_artifact: Arc<Mutex<ArtifactCapture>>,
    stderr_artifact: Arc<Mutex<ArtifactCapture>>,
    output_artifacts: Vec<OutputArtifactMetadata>,
    protected_path_guards: Vec<ProtectedPathGuard>,
    _guard: PlatformGuard,
}

pub struct BrokerState {
    instance_id: String,
    allow_unsafe: bool,
    sequence: AtomicU64,
    processes: Mutex<HashMap<String, Arc<Mutex<ManagedProcess>>>>,
    requests: Mutex<HashMap<u64, String>>,
    cancelled_requests: Mutex<HashSet<u64>>,
    artifact_root: PathBuf,
    artifacts: Mutex<HashMap<String, PathBuf>>,
    redaction: Mutex<RedactionConfig>,
}

impl BrokerState {
    pub fn new(instance_id: String, allow_unsafe: bool) -> Self {
        let artifact_root = std::env::temp_dir().join(format!(
            "sigma-exec-artifacts-{instance_id}-{}",
            ARTIFACT_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        Self {
            instance_id,
            allow_unsafe,
            sequence: AtomicU64::new(1),
            processes: Mutex::new(HashMap::new()),
            requests: Mutex::new(HashMap::new()),
            cancelled_requests: Mutex::new(HashSet::new()),
            artifact_root,
            artifacts: Mutex::new(HashMap::new()),
            redaction: Mutex::new(RedactionConfig::default()),
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn artifact_root(&self) -> &PathBuf {
        &self.artifact_root
    }

    pub fn prepare_artifact_root(&self) -> Result<(), RpcError> {
        prepare_artifact_root(&self.artifact_root)
            .map_err(|error| RpcError::new("sandbox_unavailable", error.to_string()))
    }

    pub fn configure_redaction(&self, secrets: Vec<RedactionSecret>) -> Result<(), RpcError> {
        if !self.processes.lock().map_err(lock_error)?.is_empty() {
            return Err(RpcError::new(
                "broker_protocol_error",
                "artifact redaction cannot change while processes exist",
            ));
        }
        let config = RedactionConfig::new(secrets)
            .map_err(|error| RpcError::new("broker_protocol_error", error.to_string()))?;
        *self.redaction.lock().map_err(lock_error)? = config;
        Ok(())
    }

    pub fn spawn(&self, params: ProcessParams) -> Result<Value, RpcError> {
        let (handle, process) = self.spawn_managed(params, false)?;
        let process_id = process.lock().map_err(lock_error)?.child.id();
        Ok(json!({ "handleId": handle, "processId": process_id }))
    }

    pub fn execute(&self, request_id: u64, params: ProcessParams) -> Result<Value, RpcError> {
        if params.pty {
            return Err(RpcError::new(
                "pty_unavailable",
                "PTY mode is available only through process.spawn",
            ));
        }
        let timeout = Duration::from_millis(params.timeout_ms.unwrap_or(120_000));
        let idle_timeout = params.idle_timeout_ms.map(Duration::from_millis);
        let (handle, process) = self.spawn_managed(params, true)?;
        self.requests
            .lock()
            .map_err(lock_error)?
            .insert(request_id, handle.clone());
        if self
            .cancelled_requests
            .lock()
            .map_err(lock_error)?
            .remove(&request_id)
        {
            let mut managed = process.lock().map_err(lock_error)?;
            if !managed.exited {
                terminate(&mut managed, true)?;
            }
        }
        let mut timed_out = false;
        let mut idle_timed_out = false;
        loop {
            let mut managed = process.lock().map_err(lock_error)?;
            refresh(&mut managed)?;
            if managed.exited {
                break;
            }
            if managed.started.elapsed() >= timeout {
                timed_out = true;
                terminate(&mut managed, false)?;
            } else if idle_timeout.is_some_and(|limit| last_activity(&managed).elapsed() >= limit) {
                idle_timed_out = true;
                terminate(&mut managed, false)?;
            }
            drop(managed);
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(5));
        let managed = process.lock().map_err(lock_error)?;
        self.register_artifacts(&managed)?;
        let result = process_json(&managed, 0, 0, Some((timed_out, idle_timed_out)))?;
        drop(managed);
        self.requests
            .lock()
            .map_err(lock_error)?
            .remove(&request_id);
        self.cancelled_requests
            .lock()
            .map_err(lock_error)?
            .remove(&request_id);
        self.processes.lock().map_err(lock_error)?.remove(&handle);
        Ok(result)
    }

    pub fn poll(&self, params: HandleParams) -> Result<Value, RpcError> {
        let process = self.process(&params.handle_id)?;
        let mut managed = process.lock().map_err(lock_error)?;
        refresh(&mut managed)?;
        self.register_artifacts(&managed)?;
        process_json(&managed, params.stdout_offset, params.stderr_offset, None)
    }

    pub fn write(&self, params: WriteParams) -> Result<Value, RpcError> {
        if params.data.contains('\0') {
            return Err(RpcError::new(
                "policy_denied",
                "process input contains a NUL byte",
            ));
        }
        let process = self.process(&params.handle_id)?;
        let mut managed = process.lock().map_err(lock_error)?;
        refresh(&mut managed)?;
        if managed.exited {
            return Err(RpcError::new("process_exited", "process has exited"));
        }
        let stdin = managed
            .stdin
            .as_mut()
            .ok_or_else(|| RpcError::new("process_stdin_closed", "process stdin is closed"))?;
        stdin.write_all(params.data.as_bytes())?;
        stdin.flush()?;
        Ok(json!({}))
    }

    pub fn terminate(&self, params: HandleParams) -> Result<Value, RpcError> {
        let process = self.process(&params.handle_id)?;
        let mut managed = process.lock().map_err(lock_error)?;
        refresh(&mut managed)?;
        if !managed.exited {
            terminate(&mut managed, false)?;
        }
        self.register_artifacts(&managed)?;
        process_json(&managed, params.stdout_offset, params.stderr_offset, None)
    }

    pub fn release_process(&self, params: HandleParams) -> Result<Value, RpcError> {
        let process = self.process(&params.handle_id)?;
        let mut managed = process.lock().map_err(lock_error)?;
        refresh(&mut managed)?;
        if !managed.exited {
            return Err(RpcError::new(
                "process_running",
                "a running process cannot be released",
            ));
        }
        drop(managed);
        self.processes
            .lock()
            .map_err(lock_error)?
            .remove(&params.handle_id);
        Ok(json!({ "released": true }))
    }

    pub fn release_artifacts(&self, params: ReleaseArtifactParams) -> Result<Value, RpcError> {
        if params.artifact_ids.len() > 128 {
            return Err(RpcError::new(
                "broker_protocol_error",
                "at most 128 output artifacts may be released at once",
            ));
        }
        let mut artifacts = self.artifacts.lock().map_err(lock_error)?;
        let mut released = 0_u64;
        for artifact_id in params.artifact_ids {
            if let Some(path) = artifacts.remove(&artifact_id) {
                let _ = std::fs::remove_file(path);
                released += 1;
            }
        }
        Ok(json!({ "released": released }))
    }

    pub fn cancel(&self, params: CancelParams) -> Result<Value, RpcError> {
        let handle = self
            .requests
            .lock()
            .map_err(lock_error)?
            .get(&params.target_request_id)
            .cloned();
        if let Some(handle_id) = handle.as_ref() {
            let process = self.process(handle_id)?;
            let mut managed = process.lock().map_err(lock_error)?;
            if !managed.exited {
                terminate(&mut managed, true)?;
            }
        } else {
            let mut cancelled = self.cancelled_requests.lock().map_err(lock_error)?;
            if cancelled.len() >= 4096 {
                return Err(RpcError::new(
                    "broker_busy",
                    "too many pending cancellation records",
                ));
            }
            cancelled.insert(params.target_request_id);
        }
        Ok(json!({ "cancelled": handle.is_some() }))
    }

    pub fn shutdown(&self) {
        let processes = match self.processes.lock() {
            Ok(value) => value.values().cloned().collect::<Vec<_>>(),
            Err(_) => return,
        };
        for process in processes {
            if let Ok(mut managed) = process.lock() {
                let _ = refresh(&mut managed);
                if !managed.exited {
                    let _ = terminate(&mut managed, false);
                }
            }
        }
        if let Ok(mut values) = self.processes.lock() {
            values.clear();
        }
        if let Ok(mut artifacts) = self.artifacts.lock() {
            artifacts.clear();
        }
        cleanup_artifact_root(&self.artifact_root);
    }

    fn spawn_managed(
        &self,
        params: ProcessParams,
        close_stdin: bool,
    ) -> Result<(String, Arc<Mutex<ManagedProcess>>), RpcError> {
        let maximum = params.max_output_bytes;
        let initial_input = params.command.stdin.clone();
        let mut prepared = build_command(&params, self.allow_unsafe)?;
        let handle = format!(
            "{}-{}",
            self.instance_id,
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let redaction = self.redaction.lock().map_err(lock_error)?.clone();
        let stdout_artifact = Arc::new(Mutex::new(ArtifactCapture::create(
            &self.artifact_root,
            &handle,
            "stdout",
            redaction.clone(),
        )?));
        let stderr_artifact = Arc::new(Mutex::new(ArtifactCapture::create(
            &self.artifact_root,
            &handle,
            "stderr",
            redaction,
        )?));
        let mut child = prepared
            .command
            .spawn()
            .map_err(|error| RpcError::new("process_spawn_failed", error.to_string()))?;
        let guard = PlatformGuard::attach(&mut child)?;
        let stdout = Arc::new(Mutex::new(OutputRing::new(maximum)));
        let stderr = Arc::new(Mutex::new(OutputRing::new(maximum)));
        let stdout_capture = capture(
            child
                .stdout
                .take()
                .ok_or_else(|| RpcError::new("process_spawn_failed", "stdout pipe missing"))?,
            stdout.clone(),
            stdout_artifact.clone(),
        );
        let stderr_capture = capture(
            child
                .stderr
                .take()
                .ok_or_else(|| RpcError::new("process_spawn_failed", "stderr pipe missing"))?,
            stderr.clone(),
            stderr_artifact.clone(),
        );
        let mut stdin = child.stdin.take();
        if !prepared.bootstrap_stdin.is_empty() {
            let pipe = stdin.as_mut().ok_or_else(|| {
                RpcError::new("process_spawn_failed", "sandbox bootstrap stdin is missing")
            })?;
            pipe.write_all(&prepared.bootstrap_stdin)?;
            pipe.flush()?;
        }
        if let Some(input) = initial_input {
            if let Some(pipe) = stdin.as_mut() {
                pipe.write_all(input.as_bytes())?;
                pipe.flush()?;
            }
        }
        if close_stdin {
            stdin.take();
        }
        let process = Arc::new(Mutex::new(ManagedProcess {
            child,
            stdin,
            stdout,
            stderr,
            started: Instant::now(),
            exit_code: None,
            signal: None,
            exited: false,
            terminated: false,
            cancelled: false,
            capture_threads: vec![stdout_capture, stderr_capture],
            stdout_artifact,
            stderr_artifact,
            output_artifacts: Vec::new(),
            protected_path_guards: prepared.protected_path_guards,
            _guard: guard,
        }));
        self.processes
            .lock()
            .map_err(lock_error)?
            .insert(handle.clone(), process.clone());
        Ok((handle, process))
    }

    fn register_artifacts(&self, process: &ManagedProcess) -> Result<(), RpcError> {
        if process.output_artifacts.is_empty() {
            return Ok(());
        }
        let mut artifacts = self.artifacts.lock().map_err(lock_error)?;
        for artifact in &process.output_artifacts {
            artifacts
                .entry(artifact.artifact_id.clone())
                .or_insert_with(|| artifact.path.clone());
        }
        Ok(())
    }

    fn process(&self, handle: &str) -> Result<Arc<Mutex<ManagedProcess>>, RpcError> {
        self.processes
            .lock()
            .map_err(lock_error)?
            .get(handle)
            .cloned()
            .ok_or_else(|| {
                RpcError::new(
                    "process_not_found",
                    format!("unknown process handle '{handle}'"),
                )
            })
    }
}

fn capture(
    mut reader: impl Read + Send + 'static,
    output: Arc<Mutex<OutputRing>>,
    artifact: Arc<Mutex<ArtifactCapture>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0_u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Err(_) => {
                    if let Ok(mut capture) = artifact.lock() {
                        capture.mark_incomplete();
                    }
                    break;
                }
                Ok(count) => {
                    if let Ok(mut ring) = output.lock() {
                        ring.append(&chunk[..count]);
                    }
                    if let Ok(mut capture) = artifact.lock() {
                        capture.append(&chunk[..count]);
                    }
                }
            }
        }
        if let Ok(mut capture) = artifact.lock() {
            capture.finish_capture();
        }
    })
}

fn refresh(process: &mut ManagedProcess) -> Result<(), RpcError> {
    if process.exited {
        return Ok(());
    }
    if let Some(status) = process.child.try_wait()? {
        set_exit(process, status);
    }
    Ok(())
}

fn set_exit(process: &mut ManagedProcess, status: ExitStatus) {
    process.exited = true;
    process.exit_code = status.code();
    process._guard.cleanup_descendants();
    for capture in process.capture_threads.drain(..) {
        let _ = capture.join();
    }
    let keep = !process.terminated && !process.cancelled;
    let stdout_truncated = process
        .stdout
        .lock()
        .map(|ring| ring.truncated())
        .unwrap_or(false);
    let stderr_truncated = process
        .stderr
        .lock()
        .map(|ring| ring.truncated())
        .unwrap_or(false);
    process.output_artifacts = [
        (&process.stdout_artifact, stdout_truncated),
        (&process.stderr_artifact, stderr_truncated),
    ]
    .into_iter()
    .filter_map(|(artifact, truncated)| artifact.lock().ok()?.publish(keep, truncated))
    .collect();
    // The sandbox is gone, so transient guards for absent protected paths can
    // now be removed. Guard Drop only removes an unchanged, marker-only path.
    process.protected_path_guards.clear();
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        process.signal = status.signal().map(|signal| format!("SIG{signal}"));
    }
}

fn terminate(process: &mut ManagedProcess, cancelled: bool) -> Result<(), RpcError> {
    process.cancelled |= cancelled;
    process.terminated = true;
    process.stdin.take();
    process._guard.terminate(&mut process.child);
    let deadline = Instant::now() + Duration::from_millis(750);
    loop {
        if let Some(status) = process.child.try_wait()? {
            set_exit(process, status);
            return Ok(());
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    process._guard.force_terminate(&mut process.child);
    process.child.kill()?;
    let status = process.child.wait()?;
    set_exit(process, status);
    Ok(())
}

fn last_activity(process: &ManagedProcess) -> Instant {
    let stdout = process
        .stdout
        .lock()
        .map(|ring| ring.updated_at())
        .unwrap_or(process.started);
    let stderr = process
        .stderr
        .lock()
        .map(|ring| ring.updated_at())
        .unwrap_or(process.started);
    stdout.max(stderr)
}

fn process_json(
    process: &ManagedProcess,
    stdout_offset: u64,
    stderr_offset: u64,
    execution: Option<(bool, bool)>,
) -> Result<Value, RpcError> {
    let stdout = process
        .stdout
        .lock()
        .map_err(lock_error)?
        .snapshot(stdout_offset, process.exited);
    let stderr = process
        .stderr
        .lock()
        .map_err(lock_error)?
        .snapshot(stderr_offset, process.exited);
    let state = if !process.exited {
        "running"
    } else if process.terminated {
        "terminated"
    } else {
        "exited"
    };
    let mut value = json!({
        "state": state,
        "exitCode": process.exit_code,
        "signal": process.signal,
        "durationMs": process.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        "stdout": snapshot_json(stdout)?,
        "stderr": snapshot_json(stderr)?,
        "outputArtifacts": process.output_artifacts,
    });
    if let Some((timed_out, idle_timed_out)) = execution {
        value["timedOut"] = json!(timed_out);
        value["idleTimedOut"] = json!(idle_timed_out);
        value["cancelled"] = json!(process.cancelled);
    }
    Ok(value)
}

fn snapshot_json(snapshot: OutputSnapshot) -> Result<Value, RpcError> {
    to_value(snapshot).map_err(|error| RpcError::new("broker_protocol_error", error.to_string()))
}

fn lock_error<T>(_error: std::sync::PoisonError<T>) -> RpcError {
    RpcError::new("broker_state_error", "broker state lock poisoned")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::{CommandSpec, ExecutionPolicy, NetworkMode, SandboxMode};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    fn command(long_running: bool) -> CommandSpec {
        #[cfg(windows)]
        {
            let executable = std::env::var("COMSPEC")
                .unwrap_or_else(|_| "C:\\Windows\\System32\\cmd.exe".into());
            let script = if long_running {
                "ping -n 6 127.0.0.1 >nul"
            } else {
                "echo sigma-native-ok"
            };
            let mut env = BTreeMap::new();
            for key in ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT"] {
                if let Ok(value) = std::env::var(key) {
                    env.insert(key.into(), value);
                }
            }
            CommandSpec {
                executable,
                args: vec!["/d".into(), "/s".into(), "/c".into(), script.into()],
                cwd: std::env::current_dir().unwrap(),
                env,
                stdin: None,
            }
        }
        #[cfg(not(windows))]
        {
            let script = if long_running {
                "sleep 5"
            } else {
                "printf sigma-native-ok"
            };
            CommandSpec {
                executable: "/bin/sh".into(),
                args: vec!["-c".into(), script.into()],
                cwd: std::env::current_dir().unwrap(),
                env: BTreeMap::new(),
                stdin: None,
            }
        }
    }

    fn params(long_running: bool) -> ProcessParams {
        ProcessParams {
            command: command(long_running),
            policy: ExecutionPolicy {
                sandbox: SandboxMode::Unsafe,
                network: NetworkMode::None,
                network_approved: false,
                read_roots: vec![std::env::current_dir().unwrap()],
                write_roots: Vec::new(),
                protected_paths: Vec::<PathBuf>::new(),
                unsafe_host_exec_approved: true,
            },
            max_output_bytes: 1024,
            timeout_ms: Some(2_000),
            idle_timeout_ms: None,
            pty: false,
            pty_columns: 120,
            pty_rows: 30,
        }
    }

    #[test]
    fn executes_with_explicit_unsafe_approval_and_captures_output() {
        let state = BrokerState::new("test".into(), true);
        let result = state.execute(1, params(false)).unwrap();
        assert_eq!(result["state"], "exited");
        assert!(
            result["stdout"]["data"]
                .as_str()
                .unwrap()
                .contains("sigma-native-ok")
        );
        state.shutdown();
    }

    #[test]
    fn publishes_redacted_overflow_and_releases_the_temp_file() {
        let state = BrokerState::new("overflow".into(), true);
        state
            .configure_redaction(vec![RedactionSecret {
                name: "fixture".into(),
                value: "native".into(),
            }])
            .unwrap();
        let mut request = params(false);
        request.max_output_bytes = 4;
        let result = state.execute(11, request).unwrap();
        assert!(result["stdout"]["droppedBytes"].as_u64().unwrap() > 0);
        let artifact = &result["outputArtifacts"][0];
        assert_eq!(artifact["stream"], "stdout");
        assert_eq!(artifact["redacted"], true);
        assert_eq!(artifact["complete"], true);
        assert_eq!(artifact["sha256"].as_str().unwrap().len(), 64);
        let path = PathBuf::from(artifact["path"].as_str().unwrap());
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains("native"));
        assert!(content.contains("[REDACTED]"));
        state
            .release_artifacts(ReleaseArtifactParams {
                artifact_ids: vec![artifact["artifactId"].as_str().unwrap().into()],
            })
            .unwrap();
        assert!(!path.exists());
        state.shutdown();
    }

    #[test]
    fn unsafe_execution_is_denied_without_broker_opt_in() {
        let state = BrokerState::new("test".into(), false);
        let error = state.spawn(params(false)).unwrap_err();
        assert_eq!(error.code, "policy_denied");
    }

    #[test]
    fn cancellation_arriving_before_spawn_is_not_lost() {
        let state = BrokerState::new("test".into(), true);
        state
            .cancel(CancelParams {
                target_request_id: 7,
            })
            .unwrap();
        let result = state.execute(7, params(true)).unwrap();
        assert_eq!(result["state"], "terminated");
        assert_eq!(result["cancelled"], true);
        assert_eq!(
            std::fs::read_dir(state.artifact_root())
                .map(|entries| entries.count())
                .unwrap_or(0),
            0
        );
        state.shutdown();
    }

    #[test]
    fn releases_only_terminal_background_processes() {
        let state = BrokerState::new("release".into(), true);
        let running = state.spawn(params(true)).unwrap();
        let running_handle = running["handleId"].as_str().unwrap().to_owned();
        let error = state
            .release_process(HandleParams {
                handle_id: running_handle.clone(),
                stdout_offset: 0,
                stderr_offset: 0,
            })
            .unwrap_err();
        assert_eq!(error.code, "process_running");
        state
            .terminate(HandleParams {
                handle_id: running_handle.clone(),
                stdout_offset: 0,
                stderr_offset: 0,
            })
            .unwrap();
        state
            .release_process(HandleParams {
                handle_id: running_handle.clone(),
                stdout_offset: 0,
                stderr_offset: 0,
            })
            .unwrap();
        assert!(
            state
                .poll(HandleParams {
                    handle_id: running_handle,
                    stdout_offset: 0,
                    stderr_offset: 0,
                })
                .is_err()
        );
        assert!(state.processes.lock().unwrap().is_empty());
        state.shutdown();
    }
}
