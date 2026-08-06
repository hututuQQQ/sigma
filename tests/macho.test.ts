import { describe, expect, it } from "vitest";
import {
  assertArm64MachOBytes,
  inspectMachOBytes,
  isUniversalMachOBytes,
  machoCpuTypes,
  machoFileTypes
} from "../scripts/macho.mjs";

function thinMachO(cpuType: number, fileType = machoFileTypes.executable): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  bytes.writeUInt32LE(cpuType, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(fileType, 12);
  return bytes;
}

describe("Mach-O release validation", () => {
  it("accepts a thin ARM64 executable", () => {
    expect(assertArm64MachOBytes(
      thinMachO(machoCpuTypes.arm64), "node", [machoFileTypes.executable]
    )).toMatchObject({
      format: "Mach-O",
      machine: "0x0100000c",
      targetPlatform: "darwin",
      targetArch: "arm64",
      fileType: machoFileTypes.executable
    });
  });

  it("rejects x64, universal, ELF, and PE inputs", () => {
    expect(() => assertArm64MachOBytes(thinMachO(machoCpuTypes.x64), "node"))
      .toThrow("must be ARM64 Mach-O; detected x64");
    const universal = Buffer.alloc(32);
    universal.set([0xca, 0xfe, 0xba, 0xbe]);
    expect(isUniversalMachOBytes(universal)).toBe(true);
    expect(isUniversalMachOBytes(thinMachO(machoCpuTypes.arm64))).toBe(false);
    expect(() => inspectMachOBytes(universal, "native.node")).toThrow("universal/fat Mach-O");
    const elf = Buffer.alloc(32);
    elf.set([0x7f, 0x45, 0x4c, 0x46]);
    expect(() => inspectMachOBytes(elf, "native.node")).toThrow("is ELF, not Mach-O");
    const pe = Buffer.alloc(32);
    pe.set([0x4d, 0x5a]);
    expect(() => inspectMachOBytes(pe, "native.node")).toThrow("is PE, not Mach-O");
  });

  it("accepts ARM64 bundle images only for native modules", () => {
    expect(() => assertArm64MachOBytes(
      thinMachO(machoCpuTypes.arm64, machoFileTypes.bundle),
      "native.node",
      [machoFileTypes.bundle, machoFileTypes.dylib]
    )).not.toThrow();
    expect(() => assertArm64MachOBytes(
      thinMachO(machoCpuTypes.arm64, machoFileTypes.bundle),
      "sigma-exec",
      [machoFileTypes.executable]
    )).toThrow("unsupported Mach-O file type");
  });
});
