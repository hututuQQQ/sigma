import { describe, expect, it } from "vitest";
import {
  parseDarwinDirectoryEntry
} from "../packages/agent-platform/src/darwin-directory-entries.js";

function darwinRecord(name: Buffer, type = 8): Buffer {
  const recordLength = Math.ceil((22 + name.byteLength) / 4) * 4;
  const record = Buffer.alloc(recordLength);
  record.writeUInt16LE(recordLength, 16);
  record.writeUInt16LE(name.byteLength, 18);
  record.writeUInt8(type, 20);
  name.copy(record, 21);
  return record;
}

describe("Darwin directory entries", () => {
  it("parses the published 64-bit XNU dirent layout", () => {
    const file = parseDarwinDirectoryEntry(darwinRecord(Buffer.from("readme.md"), 8));
    const directory = parseDarwinDirectoryEntry(darwinRecord(Buffer.from("src"), 4));
    const link = parseDarwinDirectoryEntry(darwinRecord(Buffer.from("alias"), 10));
    expect(file.name).toBe("readme.md");
    expect(file.isFile()).toBe(true);
    expect(directory.isDirectory()).toBe(true);
    expect(link.isSymbolicLink()).toBe(true);
  });

  it("rejects malformed lengths, termination, UTF-8, and unknown entry types", () => {
    const shortRecord = darwinRecord(Buffer.from("file"));
    shortRecord.writeUInt16LE(21, 16);
    expect(() => parseDarwinDirectoryEntry(shortRecord)).toThrow(/record length/iu);

    const longName = darwinRecord(Buffer.from("file"));
    longName.writeUInt16LE(longName.byteLength, 18);
    expect(() => parseDarwinDirectoryEntry(longName)).toThrow(/name length/iu);

    const unterminated = darwinRecord(Buffer.from("file"));
    unterminated[25] = 1;
    expect(() => parseDarwinDirectoryEntry(unterminated)).toThrow(/NUL terminated/iu);

    expect(() => parseDarwinDirectoryEntry(darwinRecord(Buffer.from([0xff]), 8))).toThrow();
    expect(() => parseDarwinDirectoryEntry(darwinRecord(Buffer.from("file"), 0))).toThrow(/unsupported type/iu);
  });
});
