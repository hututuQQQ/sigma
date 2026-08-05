import { readFile } from "node:fs/promises";

const MACHO_64_LE = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const MACHO_64_BE = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);
const FAT_MAGICS = Object.freeze([
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbf]),
  Buffer.from([0xbf, 0xba, 0xfe, 0xca])
]);

export const machoCpuTypes = Object.freeze({
  x64: 0x01000007,
  arm64: 0x0100000c
});

export const machoFileTypes = Object.freeze({
  executable: 0x2,
  dylib: 0x6,
  bundle: 0x8
});

function startsWith(buffer, marker) {
  return buffer.length >= marker.length && buffer.subarray(0, marker.length).equals(marker);
}

function hexadecimal(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

function architectureForCpu(cpuType) {
  if (cpuType === machoCpuTypes.arm64) return "arm64";
  if (cpuType === machoCpuTypes.x64) return "x64";
  return `unknown-${hexadecimal(cpuType)}`;
}

/** Inspect a thin 64-bit Mach-O image. Universal binaries fail closed. */
export function inspectMachOBytes(bytes, label = "binary") {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) {
    throw new Error(`${label} has a truncated executable header.`);
  }
  if (FAT_MAGICS.some((magic) => startsWith(bytes, magic))) {
    throw new Error(`${label} is a universal/fat Mach-O; a single ARM64 slice is required.`);
  }
  if (startsWith(bytes, Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`${label} is ELF, not Mach-O.`);
  }
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    throw new Error(`${label} is PE, not Mach-O.`);
  }

  let readUInt32;
  let endianness;
  if (startsWith(bytes, MACHO_64_LE)) {
    readUInt32 = (offset) => bytes.readUInt32LE(offset);
    endianness = "little";
  } else if (startsWith(bytes, MACHO_64_BE)) {
    readUInt32 = (offset) => bytes.readUInt32BE(offset);
    endianness = "big";
  } else {
    throw new Error(`${label} is not a recognized 64-bit Mach-O image.`);
  }

  const cpuType = readUInt32(4);
  const fileType = readUInt32(12);
  return {
    format: "Mach-O",
    machine: hexadecimal(cpuType),
    targetPlatform: "darwin",
    targetArch: architectureForCpu(cpuType),
    fileType,
    endianness
  };
}

export async function inspectMachO(filePath) {
  return inspectMachOBytes(await readFile(filePath), filePath);
}

export function assertArm64MachOBytes(bytes, label, allowedFileTypes = [
  machoFileTypes.executable,
  machoFileTypes.dylib,
  machoFileTypes.bundle
]) {
  const inspection = inspectMachOBytes(bytes, label);
  if (inspection.targetArch !== "arm64") {
    throw new Error(`${label} must be ARM64 Mach-O; detected ${inspection.targetArch} (${inspection.machine}).`);
  }
  if (!allowedFileTypes.includes(inspection.fileType)) {
    throw new Error(`${label} has unsupported Mach-O file type ${hexadecimal(inspection.fileType)}.`);
  }
  return inspection;
}

export async function assertArm64MachO(filePath, allowedFileTypes) {
  return assertArm64MachOBytes(await readFile(filePath), filePath, allowedFileTypes);
}
