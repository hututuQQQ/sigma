use serde::Serialize;
use std::time::Instant;

#[derive(Debug)]
pub struct OutputRing {
    bytes: Vec<u8>,
    maximum: usize,
    start_offset: u64,
    total_written: u64,
    updated_at: Instant,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSnapshot {
    pub data: String,
    pub next_offset: u64,
    pub dropped_bytes: u64,
}

impl OutputRing {
    pub fn new(maximum: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(maximum.min(64 * 1024)),
            maximum,
            start_offset: 0,
            total_written: 0,
            updated_at: Instant::now(),
        }
    }

    pub fn append(&mut self, chunk: &[u8]) {
        self.updated_at = Instant::now();
        self.total_written = self.total_written.saturating_add(chunk.len() as u64);
        if chunk.len() >= self.maximum {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - self.maximum..]);
            self.start_offset = self.total_written.saturating_sub(self.maximum as u64);
            return;
        }
        let excess = self
            .bytes
            .len()
            .saturating_add(chunk.len())
            .saturating_sub(self.maximum);
        if excess > 0 {
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
                    String::from_utf8_lossy(&candidate[..valid]).into_owned(),
                    valid,
                )
            }
            Err(_) => (
                String::from_utf8_lossy(candidate).into_owned(),
                candidate.len(),
            ),
        };
        OutputSnapshot {
            data,
            next_offset: effective.saturating_add(consumed as u64),
            dropped_bytes: self.start_offset.saturating_sub(requested_offset),
        }
    }

    pub fn updated_at(&self) -> Instant {
        self.updated_at
    }

    pub fn truncated(&self) -> bool {
        self.start_offset > 0
    }
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
}
