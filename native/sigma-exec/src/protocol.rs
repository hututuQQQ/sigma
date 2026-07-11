use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};

pub const PROTOCOL_VERSION: u32 = 1;
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub protocol_version: u32,
    pub request_id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response<'a> {
    protocol_version: u32,
    request_id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a RpcError>,
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: None,
        }
    }
}

impl From<io::Error> for RpcError {
    fn from(value: io::Error) -> Self {
        Self::new("broker_io_error", value.to_string())
    }
}

pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

pub fn read_request(reader: &mut impl Read) -> Result<Option<Request>, RpcError> {
    let mut header = [0_u8; 4];
    let count = reader.read(&mut header[..1])?;
    if count == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(RpcError::new(
            "broker_protocol_error",
            format!("invalid frame size {length}"),
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    let request: Request = serde_json::from_slice(&payload).map_err(|error| {
        RpcError::new(
            "broker_protocol_error",
            format!("invalid request JSON: {error}"),
        )
    })?;
    if request.request_id == 0 {
        return Err(RpcError::new(
            "broker_protocol_error",
            "requestId must be positive",
        ));
    }
    Ok(Some(request))
}

pub fn send_result(writer: &SharedWriter, request_id: u64, result: Value) {
    let response = Response {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        ok: true,
        result: Some(&result),
        error: None,
    };
    if !send(writer, &response) {
        send_fallback_error(
            writer,
            request_id,
            "broker response exceeds the maximum frame size",
        );
    }
}

pub fn send_error(writer: &SharedWriter, request_id: u64, error: RpcError) {
    let response = Response {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        ok: false,
        result: None,
        error: Some(&error),
    };
    if !send(writer, &response) {
        send_fallback_error(
            writer,
            request_id,
            "broker error response could not be encoded within the maximum frame size",
        );
    }
}

fn send_fallback_error(writer: &SharedWriter, request_id: u64, message: &'static str) {
    let error = RpcError::new("broker_protocol_error", message);
    let response = Response {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        ok: false,
        result: None,
        error: Some(&error),
    };
    let _ = send(writer, &response);
}

fn send(writer: &SharedWriter, response: &Response<'_>) -> bool {
    let Some(payload) = response_payload(response) else {
        return false;
    };
    let mut stdout = match writer.lock() {
        Ok(value) => value,
        Err(_) => return false,
    };
    stdout
        .write_all(&(payload.len() as u32).to_be_bytes())
        .is_ok()
        && stdout.write_all(&payload).is_ok()
        && stdout.flush().is_ok()
}

fn response_payload(response: &Response<'_>) -> Option<Vec<u8>> {
    bounded_response_payload(serde_json::to_vec(response))
}

fn bounded_response_payload(encoded: serde_json::Result<Vec<u8>>) -> Option<Vec<u8>> {
    match encoded {
        Ok(value) if value.len() <= MAX_FRAME_BYTES => Some(value),
        Ok(_) | Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    use std::sync::MutexGuard;

    struct SerializationFailure;

    impl Serialize for SerializationFailure {
        fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
        where
            S: serde::Serializer,
        {
            Err(serde::ser::Error::custom(
                "intentional serialization failure",
            ))
        }
    }

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn framed(value: &Value) -> Vec<u8> {
        let payload = serde_json::to_vec(value).unwrap();
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&payload);
        frame
    }

    fn capture_writer() -> (SharedWriter, Arc<Mutex<Vec<u8>>>) {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(Capture(bytes.clone()))));
        (writer, bytes)
    }

    fn decoded_response(bytes: &Arc<Mutex<Vec<u8>>>) -> Value {
        let bytes = bytes.lock().unwrap();
        let length = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(bytes.len(), length + 4);
        serde_json::from_slice(&bytes[4..]).unwrap()
    }

    #[test]
    fn reads_valid_request_and_default_params() {
        let value = json!({"protocolVersion": 1, "requestId": 7, "method": "doctor"});
        let request = read_request(&mut Cursor::new(framed(&value)))
            .unwrap()
            .unwrap();
        assert_eq!(request.protocol_version, 1);
        assert_eq!(request.request_id, 7);
        assert_eq!(request.method, "doctor");
        assert_eq!(request.params, Value::Null);
    }

    #[test]
    fn handles_eof_and_rejects_truncated_or_invalid_frames() {
        assert!(
            read_request(&mut Cursor::new(Vec::<u8>::new()))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            read_request(&mut Cursor::new(vec![0])).unwrap_err().code,
            "broker_io_error"
        );
        for length in [0_u32, (MAX_FRAME_BYTES + 1) as u32] {
            let error = read_request(&mut Cursor::new(length.to_be_bytes().to_vec())).unwrap_err();
            assert_eq!(error.code, "broker_protocol_error");
        }
        let truncated = [4_u32.to_be_bytes().as_slice(), b"{}"].concat();
        assert_eq!(
            read_request(&mut Cursor::new(truncated)).unwrap_err().code,
            "broker_io_error"
        );
        let invalid_json = [1_u32.to_be_bytes().as_slice(), b"{"].concat();
        assert_eq!(
            read_request(&mut Cursor::new(invalid_json))
                .unwrap_err()
                .code,
            "broker_protocol_error"
        );
        let zero_id = json!({"protocolVersion": 1, "requestId": 0, "method": "doctor"});
        assert_eq!(
            read_request(&mut Cursor::new(framed(&zero_id)))
                .unwrap_err()
                .code,
            "broker_protocol_error"
        );
    }

    #[test]
    fn frames_success_and_error_responses() {
        let (writer, bytes) = capture_writer();
        send_result(&writer, 9, json!({"ready": true}));
        assert_eq!(
            decoded_response(&bytes),
            json!({
                "protocolVersion": 1, "requestId": 9, "ok": true, "result": {"ready": true}
            })
        );

        let (writer, bytes) = capture_writer();
        let mut error = RpcError::new("policy_denied", "no");
        error.data = Some(json!({"path": "outside"}));
        send_error(&writer, 10, error);
        assert_eq!(
            decoded_response(&bytes),
            json!({
                "protocolVersion": 1, "requestId": 10, "ok": false,
                "error": {"code": "policy_denied", "message": "no", "data": {"path": "outside"}}
            })
        );
    }

    #[test]
    fn reports_oversized_output_and_handles_poisoned_writer_without_panicking() {
        let (writer, bytes) = capture_writer();
        send_result(&writer, 1, Value::String("x".repeat(MAX_FRAME_BYTES + 1)));
        assert_eq!(
            decoded_response(&bytes),
            json!({
                "protocolVersion": 1, "requestId": 1, "ok": false,
                "error": {
                    "code": "broker_protocol_error",
                    "message": "broker response exceeds the maximum frame size"
                }
            })
        );

        let poisoned = writer.clone();
        let _ = std::thread::spawn(move || {
            let _guard: MutexGuard<'_, Box<dyn Write + Send>> = poisoned.lock().unwrap();
            panic!("poison test writer");
        })
        .join();
        send_result(&writer, 2, Value::Null);
        assert!(bounded_response_payload(serde_json::to_vec(&SerializationFailure)).is_none());
    }

    #[test]
    fn converts_io_errors_to_typed_rpc_errors() {
        let error = RpcError::from(io::Error::other("broken"));
        assert_eq!(error.code, "broker_io_error");
        assert!(error.message.contains("broken"));
        assert!(error.data.is_none());
    }
}
