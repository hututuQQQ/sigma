#[cfg(target_os = "linux")]
mod linux_hardening;
#[cfg(target_os = "linux")]
mod linux_mount_source;
mod output;
mod output_artifact;
mod platform;
mod process;
mod protocol;
mod sandbox;
#[cfg(target_os = "linux")]
mod unix_pty;
#[cfg(windows)]
mod windows_sandbox;

use output_artifact::RedactionSecret;
use process::{BrokerState, CancelParams, HandleParams, ReleaseArtifactParams, WriteParams};
use protocol::{
    PROTOCOL_VERSION, Request, RpcError, SharedWriter, read_request, send_error, send_result,
};
use sandbox::ProcessParams;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloParams {
    #[serde(default)]
    redaction_secrets: Vec<RedactionSecret>,
}

fn decode<T: DeserializeOwned>(value: Value, label: &str) -> Result<T, RpcError> {
    serde_json::from_value(value).map_err(|error| {
        RpcError::new("broker_protocol_error", format!("invalid {label}: {error}"))
    })
}

fn dispatch(state: &BrokerState, request: Request) -> Result<Value, RpcError> {
    match request.method.as_str() {
        "hello" => {
            let params = decode::<HelloParams>(request.params, "hello params")?;
            state.configure_redaction(params.redaction_secrets)?;
            state.prepare_artifact_root()?;
            Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "instanceId": state_instance_id(state),
                "artifactRoot": state.artifact_root(),
                "server": { "name": "sigma-exec", "version": env!("CARGO_PKG_VERSION") }
            }))
        }
        "doctor" => Ok(sandbox::doctor_report()),
        "sandbox.setup" => sandbox::setup_sandbox(),
        "exec" => state.execute(
            request.request_id,
            decode::<ProcessParams>(request.params, "exec params")?,
        ),
        "process.spawn" => state.spawn(decode::<ProcessParams>(
            request.params,
            "process.spawn params",
        )?),
        "process.poll" => state.poll(decode::<HandleParams>(
            request.params,
            "process.poll params",
        )?),
        "process.write" => state.write(decode::<WriteParams>(
            request.params,
            "process.write params",
        )?),
        "process.terminate" => state.terminate(decode::<HandleParams>(
            request.params,
            "process.terminate params",
        )?),
        "process.release" => state.release_process(decode::<HandleParams>(
            request.params,
            "process.release params",
        )?),
        "artifact.release" => state.release_artifacts(decode::<ReleaseArtifactParams>(
            request.params,
            "artifact.release params",
        )?),
        "cancel" => state.cancel(decode::<CancelParams>(request.params, "cancel params")?),
        _ => Err(RpcError::new(
            "method_not_found",
            format!("unsupported broker method '{}'", request.method),
        )),
    }
}

fn state_instance_id(state: &BrokerState) -> String {
    state.instance_id().to_owned()
}

fn handle_request(state: Arc<BrokerState>, writer: SharedWriter, request: Request) {
    let request_id = request.request_id;
    if request.protocol_version != PROTOCOL_VERSION {
        send_error(
            &writer,
            request_id,
            RpcError::new(
                "unsupported_protocol",
                format!(
                    "expected protocol {PROTOCOL_VERSION}, got {}",
                    request.protocol_version
                ),
            ),
        );
        return;
    }
    match dispatch(&state, request) {
        Ok(result) => send_result(&writer, request_id, result),
        Err(error) => send_error(&writer, request_id, error),
    }
    state.finish_request(request_id);
}

fn instance_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}", std::process::id())
}

const INTERNAL_MCP_READONLY_PROBE: &str = "--internal-mcp-readonly-probe";

fn try_run_mcp_readonly_probe() -> Option<i32> {
    let mut arguments = std::env::args().skip(1);
    if arguments.next().as_deref() != Some(INTERNAL_MCP_READONLY_PROBE) {
        return None;
    }
    let Some(initialize_marker) = arguments.next() else {
        eprintln!("sigma-exec MCP probe requires initialize and idle marker paths");
        return Some(2);
    };
    let Some(idle_marker) = arguments.next() else {
        eprintln!("sigma-exec MCP probe requires initialize and idle marker paths");
        return Some(2);
    };
    Some(run_mcp_readonly_probe(
        io::stdin().lock(),
        io::stdout(),
        Path::new(&initialize_marker),
        Path::new(&idle_marker),
    ))
}

fn run_mcp_readonly_probe<R: BufRead, W: Write>(
    mut input: R,
    mut output: W,
    initialize_marker: &Path,
    idle_marker: &Path,
) -> i32 {
    // Both writes are intentionally attempted by the sandboxed child. The release smoke
    // asserts that a zero-write-root MCP policy prevents either marker from appearing.
    let _ = std::fs::write(initialize_marker, b"unexpected MCP initialize write");
    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => return 0,
            Ok(_) => {}
            Err(error) => {
                eprintln!("sigma-exec MCP probe stdin failed: {error}");
                return 3;
            }
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        match message.get("method").and_then(Value::as_str) {
            Some("initialize") => {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                let protocol_version = message
                    .pointer("/params/protocolVersion")
                    .cloned()
                    .unwrap_or_else(|| Value::String("2025-11-25".into()));
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": protocol_version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": "sigma-exec-readonly-probe", "version": env!("CARGO_PKG_VERSION") }
                    }
                });
                if writeln!(output, "{response}")
                    .and_then(|()| output.flush())
                    .is_err()
                {
                    return 4;
                }
            }
            Some("notifications/initialized") => {
                let _ = std::fs::write(idle_marker, b"unexpected MCP idle write");
                if writeln!(
                    output,
                    "{}",
                    json!({
                        "jsonrpc": "2.0",
                        "method": "sigma/read-only-probe",
                        "params": { "phase": "idle-write-attempted" }
                    })
                )
                .and_then(|()| output.flush())
                .is_err()
                {
                    return 4;
                }
            }
            Some("tools/list") => {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                if writeln!(
                    output,
                    "{}",
                    json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [] } })
                )
                .and_then(|()| output.flush())
                .is_err()
                {
                    return 4;
                }
            }
            _ => {}
        }
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    if let Some(code) = platform::try_run_internal_mode() {
        std::process::exit(code);
    }
    #[cfg(target_os = "linux")]
    if let Some(code) = linux_hardening::try_run_internal_mode() {
        std::process::exit(code);
    }
    #[cfg(target_os = "linux")]
    if let Some(code) = unix_pty::try_run_internal_mode() {
        std::process::exit(code);
    }
    #[cfg(windows)]
    if let Some(code) = windows_sandbox::try_run_internal_mode() {
        std::process::exit(code);
    }
    if let Some(code) = try_run_mcp_readonly_probe() {
        std::process::exit(code);
    }
    let allow_unsafe = std::env::args()
        .skip(1)
        .any(|argument| argument == "--allow-unsafe-host-exec");
    let state = Arc::new(BrokerState::new(instance_id(), allow_unsafe));
    let writer: SharedWriter = Arc::new(Mutex::new(Box::new(io::stdout())));
    let mut stdin = io::stdin().lock();
    loop {
        let request = match read_request(&mut stdin) {
            Ok(Some(value)) => value,
            Ok(None) => break,
            Err(error) => {
                eprintln!("sigma-exec protocol input failed: {}", error.code);
                break;
            }
        };
        if request.protocol_version != PROTOCOL_VERSION {
            send_error(
                &writer,
                request.request_id,
                RpcError::new(
                    "unsupported_protocol",
                    format!(
                        "expected protocol {PROTOCOL_VERSION}, got {}",
                        request.protocol_version
                    ),
                ),
            );
            continue;
        }
        if request.method == "shutdown" {
            send_result(&writer, request.request_id, json!({ "shutdown": true }));
            state.shutdown();
            thread::sleep(Duration::from_millis(100));
            return;
        }
        if let Err(error) = state.begin_request(request.request_id, &request.method) {
            send_error(&writer, request.request_id, error);
            continue;
        }
        let request_state = state.clone();
        let request_writer = writer.clone();
        thread::spawn(move || handle_request(request_state, request_writer, request));
    }
    state.shutdown();
}

#[cfg(test)]
mod mcp_probe_tests {
    use super::run_mcp_readonly_probe;
    use serde_json::Value;
    use std::io::Cursor;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn probe_attempts_both_writes_and_speaks_the_minimum_mcp_protocol() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sigma-mcp-probe-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let initialize_marker = root.join("initialize.txt");
        let idle_marker = root.join("idle.txt");
        let input = concat!(
            "not-json\n",
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"test-version\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/list\"}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"ignored\"}\n"
        );
        let mut output = Vec::new();
        assert_eq!(
            run_mcp_readonly_probe(
                Cursor::new(input.as_bytes()),
                &mut output,
                &initialize_marker,
                &idle_marker,
            ),
            0
        );
        assert!(initialize_marker.exists());
        assert!(idle_marker.exists());
        let messages = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["id"], 7);
        assert_eq!(messages[0]["result"]["protocolVersion"], "test-version");
        assert_eq!(messages[1]["params"]["phase"], "idle-write-attempted");
        assert_eq!(messages[2]["id"], 8);
        assert_eq!(messages[2]["result"]["tools"], serde_json::json!([]));
        std::fs::remove_dir_all(root).unwrap();
    }
}
