use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub(crate) const MAX_ARTIFACT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REDACTION_LINE_BYTES: usize = 1024 * 1024;
const REDACTED_VALUE: &[u8] = b"[REDACTED]";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RedactionSecret {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RedactionConfig {
    values: Vec<Vec<u8>>,
}

impl RedactionConfig {
    pub(crate) fn new(secrets: Vec<RedactionSecret>) -> io::Result<Self> {
        if secrets.len() > 128 {
            return Err(invalid("at most 128 artifact redaction values are allowed"));
        }
        let mut values = Vec::new();
        for secret in secrets {
            if secret.name.len() > 128 || secret.name.contains('\0') {
                return Err(invalid(
                    "artifact redaction names must be bounded and NUL-free",
                ));
            }
            if secret.value.len() < 4
                || secret.value.len() > 64 * 1024
                || secret.value.contains('\0')
            {
                return Err(invalid(
                    "artifact redaction values must be 4..65536 bytes and NUL-free",
                ));
            }
            values.push(secret.value.into_bytes());
        }
        values.sort_by_key(|value| std::cmp::Reverse(value.len()));
        values.dedup();
        Ok(Self { values })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OutputArtifactMetadata {
    pub artifact_id: String,
    pub name: String,
    pub stream: &'static str,
    pub path: PathBuf,
    pub sha256: String,
    pub size_bytes: u64,
    pub complete: bool,
    pub redacted: bool,
    pub redaction_lossy: bool,
}

pub(crate) struct ArtifactCapture {
    artifact_id: String,
    name: String,
    stream: &'static str,
    path: PathBuf,
    file: Option<File>,
    hasher: Sha256,
    size_bytes: u64,
    complete: bool,
    finished: bool,
    published: bool,
    redactor: OutputRedactor,
}

impl ArtifactCapture {
    pub(crate) fn create(
        root: &Path,
        handle: &str,
        stream: &'static str,
        config: RedactionConfig,
    ) -> io::Result<Self> {
        prepare_artifact_root(root)?;
        let artifact_id = format!("{handle}-{stream}");
        let path = root.join(format!("{artifact_id}.log"));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path)?;
        Ok(Self {
            artifact_id,
            name: format!("process-{handle}-{stream}.log"),
            stream,
            path,
            file: Some(file),
            hasher: Sha256::new(),
            size_bytes: 0,
            complete: true,
            finished: false,
            published: false,
            redactor: OutputRedactor::new(config),
        })
    }

    pub(crate) fn append(&mut self, input: &[u8]) {
        if self.finished {
            return;
        }
        let redacted = self.redactor.push(input, false);
        self.write_redacted(&redacted);
    }

    pub(crate) fn finish_capture(&mut self) {
        if self.finished {
            return;
        }
        let redacted = self.redactor.push(&[], true);
        self.write_redacted(&redacted);
        if let Some(file) = self.file.as_mut()
            && file.flush().and_then(|_| file.sync_all()).is_err()
        {
            self.complete = false;
        }
        self.finished = true;
    }

    pub(crate) fn mark_incomplete(&mut self) {
        self.complete = false;
    }

    pub(crate) fn publish(
        &mut self,
        keep: bool,
        truncated: bool,
    ) -> Option<OutputArtifactMetadata> {
        self.finish_capture();
        self.file.take();
        if !keep || !truncated {
            let _ = fs::remove_file(&self.path);
            return None;
        }
        let digest = self.hasher.clone().finalize();
        self.published = true;
        Some(OutputArtifactMetadata {
            artifact_id: self.artifact_id.clone(),
            name: self.name.clone(),
            stream: self.stream,
            path: self.path.clone(),
            sha256: hex(&digest),
            size_bytes: self.size_bytes,
            complete: self.complete && !self.redactor.lossy,
            redacted: true,
            redaction_lossy: self.redactor.lossy,
        })
    }

    /** Read a small completed capture for broker-internal protocol recovery. */
    pub(crate) fn completed_text(&self, maximum_bytes: usize) -> Option<String> {
        if !self.finished || !self.complete || self.size_bytes > maximum_bytes as u64 {
            return None;
        }
        String::from_utf8(fs::read(&self.path).ok()?).ok()
    }

    fn write_redacted(&mut self, value: &[u8]) {
        if value.is_empty() || self.file.is_none() {
            return;
        }
        if self.size_bytes.saturating_add(value.len() as u64) > MAX_ARTIFACT_BYTES {
            self.complete = false;
            return;
        }
        let result = self.file.as_mut().expect("checked").write_all(value);
        if result.is_err() {
            self.complete = false;
            self.file.take();
            return;
        }
        self.hasher.update(value);
        self.size_bytes = self.size_bytes.saturating_add(value.len() as u64);
    }
}

impl Drop for ArtifactCapture {
    fn drop(&mut self) {
        self.file.take();
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

pub(crate) fn cleanup_artifact_root(root: &Path) {
    let _ = fs::remove_dir_all(root);
}

pub(crate) fn prepare_artifact_root(root: &Path) -> io::Result<()> {
    fs::create_dir_all(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

struct OutputRedactor {
    line: Vec<u8>,
    discard_line: bool,
    lossy: bool,
    literals: LiteralRedactor,
}

impl OutputRedactor {
    fn new(config: RedactionConfig) -> Self {
        Self {
            line: Vec::new(),
            discard_line: false,
            lossy: false,
            literals: LiteralRedactor::new(config.values),
        }
    }

    fn push(&mut self, input: &[u8], final_input: bool) -> Vec<u8> {
        let mut named = Vec::new();
        for byte in input {
            if self.discard_line {
                if *byte == b'\n' {
                    named.extend_from_slice(b"[REDACTED:oversized-output-line]\n");
                    self.discard_line = false;
                }
                continue;
            }
            if *byte == b'\n' {
                named.extend_from_slice(redact_named_line(&self.line).as_bytes());
                named.push(b'\n');
                self.line.clear();
            } else {
                self.line.push(*byte);
                if self.line.len() > MAX_REDACTION_LINE_BYTES {
                    self.line.clear();
                    self.discard_line = true;
                    self.lossy = true;
                }
            }
        }
        if final_input {
            if self.discard_line {
                named.extend_from_slice(b"[REDACTED:oversized-output-line]");
                self.discard_line = false;
            } else if !self.line.is_empty() {
                named.extend_from_slice(redact_named_line(&self.line).as_bytes());
                self.line.clear();
            }
        }
        self.literals.push(&named, final_input)
    }
}

struct LiteralRedactor {
    secrets: Vec<Vec<u8>>,
    pending: Vec<u8>,
    maximum: usize,
}

impl LiteralRedactor {
    fn new(secrets: Vec<Vec<u8>>) -> Self {
        let maximum = secrets.iter().map(Vec::len).max().unwrap_or(1);
        Self {
            secrets,
            pending: Vec::new(),
            maximum,
        }
    }

    fn push(&mut self, input: &[u8], final_input: bool) -> Vec<u8> {
        self.pending.extend_from_slice(input);
        let safe_end = if final_input {
            self.pending.len()
        } else {
            self.pending
                .len()
                .saturating_sub(self.maximum.saturating_sub(1))
        };
        let mut output = Vec::new();
        let mut index = 0;
        while index < safe_end {
            if let Some(secret) = self
                .secrets
                .iter()
                .find(|secret| self.pending[index..].starts_with(secret))
            {
                output.extend_from_slice(REDACTED_VALUE);
                index += secret.len();
            } else {
                output.push(self.pending[index]);
                index += 1;
            }
        }
        self.pending.drain(..index);
        output
    }
}

fn redact_named_line(input: &[u8]) -> String {
    let text = String::from_utf8_lossy(input);
    let bytes = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    let mut index = 0;
    while index < bytes.len() {
        if !identifier_byte(bytes[index]) {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && identifier_byte(bytes[index]) {
            index += 1;
        }
        let name = &text[start..index];
        if !secret_name(name) {
            continue;
        }
        let Some((value_start, value_end, closing_quote)) = assignment_value(bytes, start, index)
        else {
            continue;
        };
        output.push_str(&text[cursor..start]);
        output.push_str("[REDACTED_NAME]");
        output.push_str(&text[index..value_start]);
        output.push_str("[REDACTED]");
        if let Some(quote) = closing_quote {
            output.push(quote as char);
        }
        cursor = value_end;
        index = value_end;
    }
    output.push_str(&text[cursor..]);
    output
}

fn assignment_value(bytes: &[u8], start: usize, end: usize) -> Option<(usize, usize, Option<u8>)> {
    let mut index = end;
    if index < bytes.len() && matches!(bytes[index], b'\'' | b'"') {
        index += 1;
    }
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
        index += 1;
    }
    if index < bytes.len() && matches!(bytes[index], b'=' | b':') {
        index += 1;
    } else if !bytes[start..end].starts_with(b"--") || index == end {
        return None;
    }
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
        index += 1;
    }
    let value_start = index;
    if index >= bytes.len() {
        return Some((value_start, value_start, None));
    }
    if matches!(bytes[index], b'\'' | b'"') {
        let quote = bytes[index];
        let content_start = index + 1;
        let closing = bytes[content_start..]
            .iter()
            .position(|byte| *byte == quote)
            .map(|offset| content_start + offset);
        return Some(match closing {
            Some(position) => (content_start, position + 1, Some(quote)),
            None => (content_start, bytes.len(), None),
        });
    }
    // Unquoted secret-named values are deliberately redacted through end-of-line.
    // Header values such as `Authorization: Bearer <token>` and cookie strings may
    // contain spaces or separators; attempting to preserve a suffix risks leaking
    // the credential. Over-redaction is the safe and deterministic boundary here.
    Some((value_start, bytes.len(), None))
}

fn identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn secret_name(value: &str) -> bool {
    let mut normalized = String::with_capacity(value.len());
    let mut previous_lowercase = false;
    for character in value.trim_start_matches('-').chars() {
        if character.is_ascii_uppercase() && previous_lowercase {
            normalized.push('_');
        }
        normalized.push(if character == '-' {
            '_'
        } else {
            character.to_ascii_lowercase()
        });
        previous_lowercase = character.is_ascii_lowercase();
    }
    let parts = normalized
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    parts.iter().any(|part| {
        matches!(
            *part,
            "apikey"
                | "authorization"
                | "cookie"
                | "credential"
                | "password"
                | "passwd"
                | "secret"
                | "session"
                | "token"
        )
    }) || parts.windows(2).any(|pair| {
        matches!(
            pair,
            ["api", "key"] | ["private", "key"] | ["access", "key"]
        )
    })
}

fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(TABLE[(byte >> 4) as usize] as char);
        output.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    output
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::OutputDecoder;

    #[test]
    fn redacts_literal_values_across_chunks_and_secret_named_assignments() {
        let config = RedactionConfig::new(vec![RedactionSecret {
            name: "provider".into(),
            value: "abcdef".into(),
        }])
        .unwrap();
        let mut redactor = OutputRedactor::new(config);
        let mut output = redactor.push(b"prefix abc", false);
        output.extend(redactor.push(
            b"def API_KEY=visible\nAuthorization: Bearer second-secret\n\"password\":\"hidden\"\n",
            true,
        ));
        let value = String::from_utf8(output).unwrap();
        assert!(!value.contains("abcdef"));
        assert!(!value.contains("API_KEY"));
        assert!(!value.contains("visible"));
        assert!(!value.contains("password"));
        assert!(!value.contains("hidden"));
        assert!(!value.contains("second-secret"));
        assert!(value.contains("[REDACTED]"));
    }

    #[test]
    fn oversized_lines_are_discarded_instead_of_leaking_unparsed_values() {
        let mut redactor = OutputRedactor::new(RedactionConfig::default());
        let value = vec![b'x'; MAX_REDACTION_LINE_BYTES + 1];
        let output = redactor.push(&value, true);
        assert_eq!(
            String::from_utf8(output).unwrap(),
            "[REDACTED:oversized-output-line]"
        );
        assert!(redactor.lossy);
    }

    #[test]
    fn utf16le_is_normalized_before_literal_and_named_secret_redaction() {
        let secret = "秘密abcd";
        let text = format!("prefix {secret} API_KEY=visible\n");
        let mut encoded = vec![0xff, 0xfe];
        encoded.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        let mut decoder = OutputDecoder::default();
        let mut redactor = OutputRedactor::new(
            RedactionConfig::new(vec![RedactionSecret {
                name: "provider".into(),
                value: secret.into(),
            }])
            .unwrap(),
        );
        let mut output = Vec::new();
        for chunk in encoded.chunks(3) {
            let normalized = decoder.push(chunk, false).unwrap();
            output.extend(redactor.push(&normalized, false));
        }
        let normalized = decoder.push(&[], true).unwrap();
        output.extend(redactor.push(&normalized, true));
        let value = String::from_utf8(output).unwrap();
        assert!(!value.contains(secret));
        assert!(!value.contains("API_KEY"));
        assert!(!value.contains("visible"));
        assert!(value.contains("[REDACTED]"));
        assert!(!value.contains('\u{fffd}'));
    }
}
