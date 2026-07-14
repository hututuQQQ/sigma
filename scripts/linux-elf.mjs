import { readFile } from "node:fs/promises";

const PT_INTERP = 3;
const SHT_DYNAMIC = 6;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_SONAME = 14;
const DT_RPATH = 15;
const DT_RUNPATH = 29;

function checkedNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`ELF ${label} is outside the supported range.`);
  }
  return number;
}

function range(buffer, offset, size, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0
    || offset + size > buffer.length) {
    throw new Error(`ELF ${label} is truncated.`);
  }
  return buffer.subarray(offset, offset + size);
}

function cString(buffer, offset, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= buffer.length) {
    throw new Error(`ELF ${label} string offset is invalid.`);
  }
  const end = buffer.indexOf(0, offset);
  if (end < 0) throw new Error(`ELF ${label} string is not terminated.`);
  return buffer.toString("utf8", offset, end);
}

function parseVersion(value) {
  const [major, minor] = value.split(".").map(Number);
  return { major, minor };
}

export function compareGlibcVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  return a.major === b.major ? a.minor - b.minor : a.major - b.major;
}

export function inspectLinuxElfBytes(buffer, label = "binary") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64
    || !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`${label} is not an ELF binary.`);
  }
  if (buffer[4] !== 2 || buffer[5] !== 1) {
    throw new Error(`${label} must be a 64-bit little-endian ELF binary.`);
  }

  const programOffset = checkedNumber(buffer.readBigUInt64LE(32), "program header offset");
  const sectionOffset = checkedNumber(buffer.readBigUInt64LE(40), "section header offset");
  const programEntrySize = buffer.readUInt16LE(54);
  const programCount = buffer.readUInt16LE(56);
  const sectionEntrySize = buffer.readUInt16LE(58);
  const sectionCount = buffer.readUInt16LE(60);
  const interpreters = [];

  if (programCount > 0 && programEntrySize < 56) throw new Error(`${label} has an invalid ELF program header size.`);
  for (let index = 0; index < programCount; index += 1) {
    const header = range(buffer, programOffset + index * programEntrySize, programEntrySize, "program header");
    if (header.readUInt32LE(0) !== PT_INTERP) continue;
    const offset = checkedNumber(header.readBigUInt64LE(8), "interpreter offset");
    const size = checkedNumber(header.readBigUInt64LE(32), "interpreter size");
    interpreters.push(range(buffer, offset, size, "interpreter").toString("utf8").replace(/\0+$/u, ""));
  }

  const sections = [];
  if (sectionCount > 0 && sectionEntrySize < 64) throw new Error(`${label} has an invalid ELF section header size.`);
  for (let index = 0; index < sectionCount; index += 1) {
    const header = range(buffer, sectionOffset + index * sectionEntrySize, sectionEntrySize, "section header");
    sections.push({
      type: header.readUInt32LE(4),
      offset: checkedNumber(header.readBigUInt64LE(24), "section offset"),
      size: checkedNumber(header.readBigUInt64LE(32), "section size"),
      link: header.readUInt32LE(40),
      entrySize: checkedNumber(header.readBigUInt64LE(56), "section entry size")
    });
  }

  const needed = [];
  let soname = null;
  let rpath = null;
  let runpath = null;
  for (const section of sections.filter((candidate) => candidate.type === SHT_DYNAMIC)) {
    const strings = sections[section.link];
    if (!strings) throw new Error(`${label} has a dynamic section without a string table.`);
    const stringTable = range(buffer, strings.offset, strings.size, "dynamic string table");
    const dynamic = range(buffer, section.offset, section.size, "dynamic section");
    const entrySize = section.entrySize || 16;
    if (entrySize < 16) throw new Error(`${label} has an invalid ELF dynamic entry size.`);
    for (let offset = 0; offset + 16 <= dynamic.length; offset += entrySize) {
      const tag = Number(dynamic.readBigInt64LE(offset));
      if (tag === DT_NULL) break;
      if (![DT_NEEDED, DT_SONAME, DT_RPATH, DT_RUNPATH].includes(tag)) continue;
      const value = checkedNumber(dynamic.readBigUInt64LE(offset + 8), "dynamic string");
      const text = cString(stringTable, value, "dynamic");
      if (tag === DT_NEEDED) needed.push(text);
      else if (tag === DT_SONAME) soname = text;
      else if (tag === DT_RPATH) rpath = text;
      else if (tag === DT_RUNPATH) runpath = text;
    }
  }

  const versions = [...new Set(
    [...buffer.toString("latin1").matchAll(/GLIBC_(\d+\.\d+)/gu)].map((match) => match[1])
  )].sort(compareGlibcVersions);
  return {
    interpreters,
    linkage: interpreters.length === 0 && needed.length === 0 ? "static" : "dynamic",
    needed: [...new Set(needed)],
    soname,
    rpath,
    runpath,
    glibcVersions: versions,
    maxGlibc: versions.at(-1) ?? null
  };
}

export async function inspectLinuxElf(filePath) {
  return inspectLinuxElfBytes(await readFile(filePath), filePath);
}

