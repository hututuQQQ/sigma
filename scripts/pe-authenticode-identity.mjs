import { createHash } from "node:crypto";

const DOS_HEADER_PE_OFFSET = 0x3c;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const CHECKSUM_OFFSET_IN_OPTIONAL_HEADER = 64;
const SECURITY_DIRECTORY_INDEX = 4;
const SECTION_HEADER_BYTES = 40;
const MAX_PE_SECTIONS = 96;
const WIN_CERTIFICATE_HEADER_BYTES = 8;
const WIN_CERT_REVISION_2_0 = 0x0200;
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 0x0002;
const ZERO_CHECKSUM = Buffer.alloc(4);
const ZERO_SECURITY_DIRECTORY = Buffer.alloc(8);

export class PeAuthenticodeIdentityError extends Error {
  constructor(label, detail) {
    super(`${label} has an invalid PE Authenticode layout: ${detail}`);
    this.name = "PeAuthenticodeIdentityError";
  }
}

function invalid(label, detail) {
  throw new PeAuthenticodeIdentityError(label, detail);
}

function rangeEnd(offset, size, limit, label, field) {
  const end = offset + size;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
    || offset < 0 || size < 0 || end < offset || end > limit) {
    invalid(label, `${field} is outside the file`);
  }
  return end;
}

function optionalHeaderLayout(bytes, optionalOffset, optionalSize, label) {
  const optionalEnd = rangeEnd(optionalOffset, optionalSize, bytes.length, label, "optional header");
  if (optionalSize < CHECKSUM_OFFSET_IN_OPTIONAL_HEADER + 4) {
    invalid(label, "the optional header does not contain a checksum field");
  }
  const magic = bytes.readUInt16LE(optionalOffset);
  const dataDirectoryOffset = magic === PE32_MAGIC
    ? optionalOffset + 96
    : magic === PE32_PLUS_MAGIC
      ? optionalOffset + 112
      : invalid(label, `unsupported optional-header magic 0x${magic.toString(16)}`);
  const numberOfDirectoriesOffset = magic === PE32_MAGIC ? optionalOffset + 92 : optionalOffset + 108;
  rangeEnd(numberOfDirectoriesOffset, 4, optionalEnd, label, "data-directory count");
  const numberOfDirectories = bytes.readUInt32LE(numberOfDirectoriesOffset);
  const availableDirectories = Math.floor((optionalEnd - dataDirectoryOffset) / 8);
  if (numberOfDirectories > availableDirectories) {
    invalid(label, "the data-directory count exceeds the optional header");
  }
  if (numberOfDirectories <= SECURITY_DIRECTORY_INDEX) {
    invalid(label, "the optional header does not contain a security directory");
  }
  const securityDirectoryOffset = dataDirectoryOffset + SECURITY_DIRECTORY_INDEX * 8;
  rangeEnd(securityDirectoryOffset, 8, optionalEnd, label, "security directory");
  return {
    optionalEnd,
    checksumOffset: optionalOffset + CHECKSUM_OFFSET_IN_OPTIONAL_HEADER,
    securityDirectoryOffset
  };
}

function sectionLayout(bytes, sectionTableOffset, sectionCount, sizeOfHeaders, label) {
  if (sectionCount < 1 || sectionCount > MAX_PE_SECTIONS) {
    invalid(label, `section count must be between 1 and ${MAX_PE_SECTIONS}`);
  }
  const sectionTableEnd = rangeEnd(
    sectionTableOffset,
    sectionCount * SECTION_HEADER_BYTES,
    bytes.length,
    label,
    "section table"
  );
  if (sizeOfHeaders < sectionTableEnd || sizeOfHeaders > bytes.length) {
    invalid(label, "SizeOfHeaders does not cover the PE headers");
  }
  const ranges = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTableOffset + index * SECTION_HEADER_BYTES;
    const size = bytes.readUInt32LE(section + 16);
    const offset = bytes.readUInt32LE(section + 20);
    if (size === 0) continue;
    const end = rangeEnd(offset, size, bytes.length, label, `section ${index} raw data`);
    if (offset < sizeOfHeaders) invalid(label, `section ${index} raw data overlaps the PE headers`);
    ranges.push({ offset, end });
  }
  ranges.sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].offset < ranges[index - 1].end) {
      invalid(label, "section raw-data ranges overlap");
    }
  }
  return { sectionTableEnd, lastSectionEnd: ranges.at(-1)?.end ?? sizeOfHeaders };
}

function certificateEntries(bytes, offset, size, label) {
  const end = offset + size;
  let cursor = offset;
  let entries = 0;
  while (cursor < end) {
    if (end - cursor < WIN_CERTIFICATE_HEADER_BYTES) {
      invalid(label, "the certificate table ends inside a WIN_CERTIFICATE header");
    }
    const length = bytes.readUInt32LE(cursor);
    const revision = bytes.readUInt16LE(cursor + 4);
    const certificateType = bytes.readUInt16LE(cursor + 6);
    if (length < WIN_CERTIFICATE_HEADER_BYTES) {
      invalid(label, "a WIN_CERTIFICATE entry is shorter than its header");
    }
    if (revision !== WIN_CERT_REVISION_2_0 || certificateType !== WIN_CERT_TYPE_PKCS_SIGNED_DATA) {
      invalid(label, "a WIN_CERTIFICATE entry is not Authenticode PKCS signed data revision 2.0");
    }
    const alignedLength = Math.ceil(length / 8) * 8;
    if (cursor + alignedLength > end) {
      invalid(label, "a WIN_CERTIFICATE entry exceeds the declared certificate table");
    }
    cursor += alignedLength;
    entries += 1;
  }
  if (cursor !== end || entries === 0) invalid(label, "the certificate table is not exactly accounted for");
  return entries;
}

function certificateTable(bytes, securityDirectoryOffset, minimumOffset, label) {
  const offset = bytes.readUInt32LE(securityDirectoryOffset);
  const size = bytes.readUInt32LE(securityDirectoryOffset + 4);
  if (offset === 0 && size === 0) return null;
  if (offset === 0 || size === 0) invalid(label, "the certificate offset and size must both be zero or non-zero");
  if (offset % 8 !== 0 || size % 8 !== 0) invalid(label, "the certificate table is not 8-byte aligned");
  if (offset < minimumOffset) invalid(label, "the certificate table overlaps PE headers or section data");
  if (rangeEnd(offset, size, bytes.length, label, "certificate table") !== bytes.length) {
    invalid(label, "the certificate table must be the only data at EOF");
  }
  return { offset, size, entries: certificateEntries(bytes, offset, size, label) };
}

function peLayout(bytes, label) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64) invalid(label, "the input is not a non-empty PE buffer");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) invalid(label, "the DOS MZ signature is missing");
  const peOffset = bytes.readUInt32LE(DOS_HEADER_PE_OFFSET);
  rangeEnd(peOffset, 24, bytes.length, label, "PE and COFF headers");
  if (bytes.readUInt32LE(peOffset) !== 0x00004550) invalid(label, "the PE signature is missing");
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const optional = optionalHeaderLayout(bytes, optionalOffset, optionalSize, label);
  const sizeOfHeaders = bytes.readUInt32LE(optionalOffset + 60);
  const sections = sectionLayout(bytes, optional.optionalEnd, sectionCount, sizeOfHeaders, label);
  const minimumCertificateOffset = Math.max(sizeOfHeaders, sections.sectionTableEnd, sections.lastSectionEnd);
  return {
    checksumOffset: optional.checksumOffset,
    securityDirectoryOffset: optional.securityDirectoryOffset,
    certificateTable: certificateTable(bytes, optional.securityDirectoryOffset, minimumCertificateOffset, label)
  };
}

function normalizedContentDigest(bytes, layout) {
  const contentEnd = layout.certificateTable?.offset ?? bytes.length;
  const hash = createHash("sha256");
  hash.update(bytes.subarray(0, layout.checksumOffset));
  hash.update(ZERO_CHECKSUM);
  hash.update(bytes.subarray(layout.checksumOffset + 4, layout.securityDirectoryOffset));
  hash.update(ZERO_SECURITY_DIRECTORY);
  hash.update(bytes.subarray(layout.securityDirectoryOffset + 8, contentEnd));
  return hash.digest("hex");
}

/**
 * Return a PE content identity that is stable across Authenticode signing.
 * Only the checksum and security-directory fields are normalized; a structurally
 * valid certificate table is excluded only when it is the sole data at EOF.
 */
export function inspectPeAuthenticodeIdentity(bytes, label = "PE image") {
  const layout = peLayout(bytes, label);
  return {
    fullSha256: createHash("sha256").update(bytes).digest("hex"),
    normalizedContentSha256: normalizedContentDigest(bytes, layout),
    checksumOffset: layout.checksumOffset,
    securityDirectoryOffset: layout.securityDirectoryOffset,
    certificateTable: layout.certificateTable
  };
}
