use serde::Serialize;
use std::fmt;
use std::time::Instant;

const INVALID_OUTPUT_ENCODING: &str = "invalid_output_encoding";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDecodingError {
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for OutputDecodingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Clone, Copy, Debug)]
enum OutputEncoding {
    Utf8,
    Utf16Le,
    #[cfg(windows)]
    WindowsOem,
}

#[derive(Debug, Default)]
pub struct OutputDecoder {
    encoding: Option<OutputEncoding>,
    pending: Vec<u8>,
}

#[derive(Debug)]
pub struct OutputRing {
    bytes: Vec<u8>,
    maximum: usize,
    start_offset: u64,
    total_written: u64,
    updated_at: Instant,
    decoding_error: Option<OutputDecodingError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSnapshot {
    pub data: String,
    pub next_offset: u64,
    pub dropped_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoding_error: Option<OutputDecodingError>,
}

impl OutputDecoder {
    pub fn push(
        &mut self,
        input: &[u8],
        final_input: bool,
    ) -> Result<Vec<u8>, OutputDecodingError> {
        self.pending.extend_from_slice(input);
        if self.encoding.is_none() {
            let Some((encoding, prefix)) = detect_encoding(&self.pending, final_input)? else {
                return Ok(Vec::new());
            };
            self.encoding = Some(encoding);
            self.pending.drain(..prefix);
        }
        match self.encoding.expect("encoding selected") {
            OutputEncoding::Utf8 => self.decode_utf8(final_input),
            OutputEncoding::Utf16Le => self.decode_utf16le(final_input),
            #[cfg(windows)]
            OutputEncoding::WindowsOem => self.decode_windows_oem(final_input),
        }
    }

    fn decode_utf8(&mut self, final_input: bool) -> Result<Vec<u8>, OutputDecodingError> {
        match std::str::from_utf8(&self.pending) {
            Ok(_) => Ok(std::mem::take(&mut self.pending)),
            Err(error) if error.error_len().is_none() && !final_input => {
                let valid = error.valid_up_to();
                Ok(self.pending.drain(..valid).collect())
            }
            Err(_) => {
                #[cfg(windows)]
                {
                    self.encoding = Some(OutputEncoding::WindowsOem);
                    self.decode_windows_oem(final_input)
                }
                #[cfg(not(windows))]
                {
                    Err(invalid_encoding(
                        "process output is neither valid UTF-8 nor supported UTF-16LE",
                    ))
                }
            }
        }
    }

    fn decode_utf16le(&mut self, final_input: bool) -> Result<Vec<u8>, OutputDecodingError> {
        if final_input && self.pending.len() % 2 != 0 {
            return Err(invalid_encoding(
                "UTF-16LE process output ended with an incomplete code unit",
            ));
        }
        let mut complete = self.pending.len() - (self.pending.len() % 2);
        if !final_input && complete >= 2 {
            let last = u16::from_le_bytes([self.pending[complete - 2], self.pending[complete - 1]]);
            if (0xd800..=0xdbff).contains(&last) {
                complete -= 2;
            }
        }
        if complete == 0 {
            return Ok(Vec::new());
        }
        let units = self.pending[..complete]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        let decoded = String::from_utf16(&units).map_err(|_| {
            invalid_encoding("UTF-16LE process output contains an invalid surrogate sequence")
        })?;
        self.pending.drain(..complete);
        Ok(decoded.into_bytes())
    }

    #[cfg(windows)]
    fn decode_windows_oem(&mut self, final_input: bool) -> Result<Vec<u8>, OutputDecodingError> {
        let maximum_suffix = if final_input {
            0
        } else {
            self.pending.len().min(4)
        };
        for suffix in 0..=maximum_suffix {
            let complete = self.pending.len() - suffix;
            match windows_oem_to_string(&self.pending[..complete]) {
                Ok(decoded) => {
                    self.pending.drain(..complete);
                    return Ok(decoded.into_bytes());
                }
                Err(_) if suffix < maximum_suffix => continue,
                Err(_) => break,
            }
        }
        Err(invalid_encoding(
            "process output is neither valid UTF-8, UTF-16LE, nor strict Windows OEM text",
        ))
    }
}

#[cfg(windows)]
fn windows_oem_to_string(input: &[u8]) -> Result<String, ()> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Globalization::{CP_OEMCP, MB_ERR_INVALID_CHARS, MultiByteToWideChar};

    if input.is_empty() {
        return Ok(String::new());
    }
    let length = i32::try_from(input.len()).map_err(|_| ())?;
    let required = unsafe {
        MultiByteToWideChar(
            CP_OEMCP,
            MB_ERR_INVALID_CHARS,
            input.as_ptr(),
            length,
            null_mut(),
            0,
        )
    };
    if required <= 0 {
        return Err(());
    }
    let mut output = vec![0_u16; required as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_OEMCP,
            MB_ERR_INVALID_CHARS,
            input.as_ptr(),
            length,
            output.as_mut_ptr(),
            required,
        )
    };
    if written != required {
        return Err(());
    }
    String::from_utf16(&output).map_err(|_| ())
}

fn detect_encoding(
    input: &[u8],
    final_input: bool,
) -> Result<Option<(OutputEncoding, usize)>, OutputDecodingError> {
    if input.starts_with(&[0xff, 0xfe]) {
        return Ok(Some((OutputEncoding::Utf16Le, 2)));
    }
    if input.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Ok(Some((OutputEncoding::Utf8, 3)));
    }
    if !final_input && ([0xff].starts_with(input) || [0xef, 0xbb, 0xbf].starts_with(input)) {
        return Ok(None);
    }
    if strong_utf16le_nul_pattern(input) {
        return Ok(Some((OutputEncoding::Utf16Le, 0)));
    }
    if !final_input && input.len() < 4 && input.iter().all(|byte| byte.is_ascii() && *byte != 0) {
        return Ok(None);
    }
    match std::str::from_utf8(input) {
        Ok(_) => Ok(Some((OutputEncoding::Utf8, 0))),
        Err(error) if error.error_len().is_none() && !final_input => Ok(None),
        Err(_) if !final_input && input.len() < 4 => Ok(None),
        Err(_) => {
            #[cfg(windows)]
            {
                windows_oem_to_string(input)
                    .map(|_| Some((OutputEncoding::WindowsOem, 0)))
                    .map_err(|_| invalid_encoding(
                        "process output is neither valid UTF-8, UTF-16LE, nor strict Windows OEM text",
                    ))
            }
            #[cfg(not(windows))]
            {
                Err(invalid_encoding(
                    "process output is neither valid UTF-8 nor supported UTF-16LE",
                ))
            }
        }
    }
}

fn strong_utf16le_nul_pattern(input: &[u8]) -> bool {
    let complete = input.len() - (input.len() % 2);
    if complete < 2 {
        return false;
    }
    let pairs = complete / 2;
    let odd_zeroes = input[..complete]
        .iter()
        .skip(1)
        .step_by(2)
        .filter(|byte| **byte == 0)
        .count();
    let even_zeroes = input[..complete]
        .iter()
        .step_by(2)
        .filter(|byte| **byte == 0)
        .count();
    odd_zeroes * 3 >= pairs * 2 && even_zeroes * 4 <= pairs
}

fn invalid_encoding(message: &str) -> OutputDecodingError {
    OutputDecodingError {
        code: INVALID_OUTPUT_ENCODING,
        message: message.into(),
    }
}

impl OutputRing {
    pub fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(maximum.min(64 * 1024)),
            maximum,
            start_offset: 0,
            total_written: 0,
            updated_at: Instant::now(),
            decoding_error: None,
        }
    }

    pub fn append(&mut self, chunk: &[u8]) {
        self.updated_at = Instant::now();
        self.total_written = self.total_written.saturating_add(chunk.len() as u64);
        if chunk.len() >= self.maximum {
            let mut start = chunk.len() - self.maximum;
            while start < chunk.len() && utf8_continuation(chunk[start]) {
                start += 1;
            }
            self.bytes.clear();
            self.bytes.extend_from_slice(&chunk[start..]);
            self.start_offset = self
                .total_written
                .saturating_sub((chunk.len() - start) as u64);
            return;
        }
        let mut excess = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(self.maximum);
        if excess > 0 {
            while excess < self.bytes.len() && utf8_continuation(self.bytes[excess]) {
                excess += 1;
            }
            self.bytes.drain(..excess);
            self.start_offset = self.start_offset.saturating_add(excess as u64);
        }
        self.bytes.extend_from_slice(chunk);
    }

    pub fn snapshot(&self, requested_offset: u64, final_output: bool) -> OutputSnapshot {
        let effective = requested_offset
            .max(self.start_offset)
            .min(self.total_written);
        let index = effective.saturating_sub(self.start_offset) as usize;
        let candidate = &self.bytes[index..];
        let (data, consumed) = match std::str::from_utf8(candidate) {
            Ok(value) => (value.to_owned(), candidate.len()),
            Err(error) if error.error_len().is_none() && !final_output => {
                let valid = error.valid_up_to();
                (
                    String::from_utf8(candidate[..valid].to_vec()).expect("validated UTF-8"),
                    valid,
                )
            }
            Err(_) => (String::new(), 0),
        };
        OutputSnapshot {
            data,
            next_offset: effective.saturating_add(consumed as u64),
            dropped_bytes: self.start_offset.saturating_sub(requested_offset),
            decoding_error: self.decoding_error.clone(),
        }
    }

    pub fn mark_decoding_error(&mut self, error: OutputDecodingError) {
        self.updated_at = Instant::now();
        self.decoding_error.get_or_insert(error);
    }

    pub fn updated_at(&self) -> Instant {
        self.updated_at
    }

    pub fn truncated(&self) -> bool {
        self.start_offset > 0
    }
}

fn utf8_continuation(byte: u8) -> bool {
    byte & 0b1100_0000 == 0b1000_0000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_tail_and_reports_cursor_gap() {
        let mut ring = OutputRing::new(5);
        ring.append(b"abc");
        ring.append(b"defg");
        let snapshot = ring.snapshot(0, false);
        assert_eq!(snapshot.data, "cdefg");
        assert_eq!(snapshot.next_offset, 7);
        assert_eq!(snapshot.dropped_bytes, 2);
    }

    #[test]
    fn holds_an_incomplete_utf8_suffix_until_the_next_snapshot() {
        let mut ring = OutputRing::new(16);
        ring.append(&[0xe4, 0xb8]);
        let partial = ring.snapshot(0, false);
        assert_eq!(partial.data, "");
        assert_eq!(partial.next_offset, 0);
        ring.append(&[0xad]);
        let complete = ring.snapshot(partial.next_offset, false);
        assert_eq!(complete.data, "中");
        assert_eq!(complete.next_offset, 3);
    }

    #[test]
    fn normalizes_fragmented_utf8_and_utf16le_without_lossy_replacement() {
        let mut utf8 = OutputDecoder::default();
        assert_eq!(utf8.push(&[0xe4, 0xb8], false).unwrap(), b"");
        assert_eq!(
            String::from_utf8(utf8.push(&[0xad], true).unwrap()).unwrap(),
            "中"
        );

        let text = "中文 secret-value\n";
        let mut encoded = vec![0xff, 0xfe];
        encoded.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        let mut utf16 = OutputDecoder::default();
        let mut normalized = utf16.push(&encoded[..3], false).unwrap();
        normalized.extend(utf16.push(&encoded[3..7], false).unwrap());
        normalized.extend(utf16.push(&encoded[7..], true).unwrap());
        assert_eq!(String::from_utf8(normalized).unwrap(), text);

        let bomless = "plain text\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let mut bomless_decoder = OutputDecoder::default();
        assert_eq!(
            String::from_utf8(bomless_decoder.push(&bomless, true).unwrap()).unwrap(),
            "plain text\n"
        );
    }

    #[test]
    fn rejects_unknown_or_malformed_output_encoding_with_a_stable_code() {
        let mut decoder = OutputDecoder::default();
        let unknown = decoder.push(&[0xff, 0xff, 0xff], true);
        #[cfg(windows)]
        match unknown {
            Ok(value) => {
                let text = String::from_utf8(value).unwrap();
                assert!(!text.contains('\u{fffd}'));
            }
            Err(error) => assert_eq!(error.code, "invalid_output_encoding"),
        }
        #[cfg(not(windows))]
        assert_eq!(unknown.unwrap_err().code, "invalid_output_encoding");

        let mut malformed_utf16 = OutputDecoder::default();
        let error = malformed_utf16
            .push(&[0xff, 0xfe, 0x00, 0xd8], true)
            .unwrap_err();
        assert_eq!(error.code, "invalid_output_encoding");

        // GBK/CP936 bytes for "\u{4e2d}\u{6587}" also happen to form printable
        // UTF-16 code units. Accepting printable pairs as BOM-less UTF-16 would
        // silently reinterpret unknown legacy encodings before redaction.
        let mut cp936 = OutputDecoder::default();
        let decoded = cp936.push(&[0xd6, 0xd0, 0xce, 0xc4], true);
        #[cfg(windows)]
        match decoded {
            Ok(value) => {
                let text = String::from_utf8(value).unwrap();
                assert!(!text.contains('\u{fffd}'));
            }
            Err(error) => assert_eq!(error.code, "invalid_output_encoding"),
        }
        #[cfg(not(windows))]
        assert_eq!(decoded.unwrap_err().code, "invalid_output_encoding");
    }

    #[cfg(windows)]
    #[test]
    fn strictly_normalizes_the_active_windows_oem_code_page() {
        assert_eq!(
            windows_oem_to_string(b"plain diagnostic").unwrap(),
            "plain diagnostic"
        );
    }

    #[test]
    fn byte_bounded_tail_never_emits_a_partial_utf8_character() {
        let mut ring = OutputRing::new(4);
        ring.append("a中文".as_bytes());
        let snapshot = ring.snapshot(0, true);
        assert_eq!(snapshot.data, "文");
        assert!(!snapshot.data.contains('\u{fffd}'));
    }
}
