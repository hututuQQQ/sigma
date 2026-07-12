import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_ARCHIVE_LISTING_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const WINDOWS_FORBIDDEN_CHARACTER = /[<>:"|?*]/u;

function archiveError(label, detail) {
  return new Error(`${label} failed archive safety validation: ${detail}`);
}

function listingLines(output) {
  return String(output).split(/\r?\n/u).filter((line) => line.length > 0);
}

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function withArchiveSnapshot(bytes, callback) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sigma-archive-snapshot-"));
  const archive = path.join(directory, "archive.bin");
  try {
    writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
    return callback(archive);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runTarListing(args, label, spawn) {
  const result = spawn("tar", args, {
    encoding: "utf8",
    maxBuffer: MAX_ARCHIVE_LISTING_BYTES
  });
  if (result.error || result.status !== 0) {
    throw archiveError(label, result.error?.message ?? result.stderr ?? result.stdout ?? "tar listing failed");
  }
  return listingLines(result.stdout);
}

function expandedSize(verboseLine, rawEntry, label) {
  const entryStart = verboseLine.lastIndexOf(rawEntry);
  if (entryStart < 0) {
    throw archiveError(label, `cannot bind verbose metadata to member ${rawEntry}`);
  }
  const fields = verboseLine.slice(0, entryStart).trim().split(/\s+/u);
  // `--numeric-owner` gives two deliberately recognized layouts:
  // GNU tar: mode uid/gid size date time
  // bsdtar:  mode links uid gid size date time
  // Human-readable output from an unknown implementation fails closed.
  let sizeField;
  if (/^(?:0|[1-9][0-9]*)\/(?:0|[1-9][0-9]*)$/u.test(fields[1] ?? "")) {
    sizeField = fields[2];
  } else if (fields.slice(1, 5).length === 4
    && fields.slice(1, 5).every((field) => /^(?:0|[1-9][0-9]*)$/u.test(field))) {
    sizeField = fields[4];
  }
  if (!sizeField || !/^(?:0|[1-9][0-9]*)$/u.test(sizeField)) {
    throw archiveError(label, `member ${rawEntry} has an unreadable expanded size`);
  }
  const size = Number(sizeField);
  if (!Number.isSafeInteger(size) || size > MAX_EXPANDED_ENTRY_BYTES) {
    throw archiveError(label, `member ${rawEntry} exceeds the ${MAX_EXPANDED_ENTRY_BYTES}-byte limit`);
  }
  return size;
}

/** Validate portable archive member names before any extractor sees them. */
export function validateArchiveEntryNames(entries, root, label = "archive") {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw archiveError(label, `entry count must be between 1 and ${MAX_ARCHIVE_ENTRIES}`);
  }
  if (typeof root !== "string" || root.length === 0 || root.includes("/") || root.includes("\\")) {
    throw archiveError(label, "the expected top-level directory is invalid");
  }
  const seen = new Set();
  return entries.map((rawEntry) => {
    if (typeof rawEntry !== "string" || rawEntry.length === 0 || rawEntry.length > 4096) {
      throw archiveError(label, "an entry name is empty or too long");
    }
    if (rawEntry !== rawEntry.normalize("NFC")
      || rawEntry.includes("\\")
      || containsControlCharacter(rawEntry)) {
      throw archiveError(label, `entry is not a canonical portable path: ${JSON.stringify(rawEntry)}`);
    }
    const entry = rawEntry.endsWith("/") ? rawEntry.slice(0, -1) : rawEntry;
    if (entry.length === 0 || entry.startsWith("/") || /^[A-Za-z]:/u.test(entry)) {
      throw archiveError(label, `entry is absolute or empty: ${JSON.stringify(rawEntry)}`);
    }
    const segments = entry.split("/");
    if (segments[0] !== root) {
      throw archiveError(label, `entry is outside the expected ${root}/ directory: ${rawEntry}`);
    }
    for (const segment of segments) {
      if (segment.length === 0 || segment.length > 255 || segment === "." || segment === ".."
        || WINDOWS_FORBIDDEN_CHARACTER.test(segment)
        || /[. ]$/u.test(segment)
        || WINDOWS_RESERVED_NAME.test(segment)) {
        throw archiveError(label, `entry contains an unsafe path segment: ${rawEntry}`);
      }
    }
    const collisionKey = entry.normalize("NFC").toLowerCase();
    if (seen.has(collisionKey)) {
      throw archiveError(label, `entry is duplicated under portable path rules: ${rawEntry}`);
    }
    seen.add(collisionKey);
    return entry;
  });
}

/**
 * Inspect names and member types from the same immutable byte buffer that will
 * later be extracted. `allowedTypes` uses tar's leading type characters.
 */
export function inspectArchiveBytes(
  bytes,
  { root, label = "archive", allowedTypes = new Set(["-", "d"]), spawn = spawnSync }
) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) {
    throw archiveError(label, `archive size must be between 1 and ${MAX_ARCHIVE_BYTES} bytes`);
  }
  return withArchiveSnapshot(bytes, (archive) => {
    const rawEntries = runTarListing(["-tf", archive], label, spawn);
    const verbose = runTarListing(["-tvf", archive, "--numeric-owner"], label, spawn);
    if (verbose.length !== rawEntries.length) {
      throw archiveError(label, "name and type listings do not account for the same members");
    }
    const entries = validateArchiveEntryNames(rawEntries, root, label);
    let expandedBytes = 0;
    const records = entries.map((name, index) => {
      const type = verbose[index]?.[0];
      if (!type || !allowedTypes.has(type)) {
        throw archiveError(label, `member ${name} has forbidden type ${JSON.stringify(type)}`);
      }
      const size = expandedSize(verbose[index], rawEntries[index], label);
      expandedBytes += size;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_ARCHIVE_BYTES) {
        throw archiveError(label, `expanded members exceed the ${MAX_EXPANDED_ARCHIVE_BYTES}-byte total limit`);
      }
      return { name, type, size };
    });
    const recordByPortableName = new Map(records.map((record) => [
      record.name.normalize("NFC").toLowerCase(), record
    ]));
    for (const record of records) {
      const segments = record.name.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        const ancestor = segments.slice(0, index).join("/").normalize("NFC").toLowerCase();
        const ancestorRecord = recordByPortableName.get(ancestor);
        if (ancestorRecord && ancestorRecord.type !== "d") {
          throw archiveError(label, `member ${record.name} descends from non-directory ${ancestorRecord.name}`);
        }
      }
    }
    return { entries, records, expandedBytes };
  });
}

/** Extract a previously inspected archive byte buffer into an empty directory. */
export function extractArchiveBytes(bytes, destination, label = "archive", spawn = spawnSync) {
  return withArchiveSnapshot(bytes, (archive) => {
    const result = spawn("tar", ["-xf", archive, "-C", destination], {
      encoding: "buffer",
      maxBuffer: 1024 * 1024
    });
    if (result.error || result.status !== 0) {
      throw archiveError(label, result.error?.message ?? String(result.stderr ?? result.stdout ?? "tar extraction failed"));
    }
  });
}

/** Stream one preflighted regular member to memory without interpreting its path. */
export function extractArchiveMemberBytes(
  bytes,
  member,
  { label = "archive", maxBytes = 256 * 1024 * 1024, spawn = spawnSync } = {}
) {
  return withArchiveSnapshot(bytes, (archive) => {
    const result = spawn("tar", ["-xOf", archive, "--", member], {
      encoding: "buffer",
      maxBuffer: maxBytes
    });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      throw archiveError(label, result.error?.message ?? String(result.stderr ?? "member extraction failed"));
    }
    if (result.stdout.length === 0 || result.stdout.length > maxBytes) {
      throw archiveError(label, `member ${member} is empty or exceeds ${maxBytes} bytes`);
    }
    return result.stdout;
  });
}
