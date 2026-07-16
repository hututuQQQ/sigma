import { describe, expect, it } from "vitest";
import { inspectLinuxElfBytes } from "../scripts/linux-elf.mjs";
import {
  assertLinuxRuntimeLibraryInventory,
  linuxRuntimeLibraryNames
} from "../scripts/linux-portable-runtime-config.mjs";

function minimalElf(extra = "") {
  const bytes = Buffer.alloc(64 + Buffer.byteLength(extra));
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes[6] = 1;
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(0x003e, 18);
  bytes.writeUInt16LE(64, 52);
  if (extra) bytes.write(extra, 64, "latin1");
  return bytes;
}

describe("Linux portable runtime compatibility", () => {
  it("detects a GLIBC requirement above the 2.28 product ceiling", () => {
    const inspection = inspectLinuxElfBytes(
      minimalElf("GLIBC_2.17\0GLIBC_2.39\0"),
      "host Node fixture"
    );
    expect(inspection.glibcVersions).toEqual(["2.17", "2.39"]);
    expect(inspection.maxGlibc).toBe("2.39");
  });

  it("rejects a runtime inventory that omits libatomic", () => {
    const incomplete = linuxRuntimeLibraryNames
      .filter((name) => name !== "libatomic.so.1")
      .map((name) => ({ name }));
    expect(() => assertLinuxRuntimeLibraryInventory(incomplete, "test runtime"))
      .toThrow("libatomic.so.1");
  });

  it("rejects duplicate or extra runtime libraries instead of hiding manifest gaps", () => {
    const duplicated = [...linuxRuntimeLibraryNames, linuxRuntimeLibraryNames[0], "libextra.so.1"]
      .map((name) => ({ name }));
    expect(() => assertLinuxRuntimeLibraryInventory(duplicated, "test runtime"))
      .toThrow("must include exactly");
  });
});
