import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWindowsAppContainerNodeCompatibility,
  createWindowsAppContainerNodeCompatibilityProof,
  inspectPeAuthenticodeIdentity,
  WINDOWS_APPCONTAINER_NODE_COMPATIBILITY,
  WINDOWS_NODE_GLOBAL_PIPE_MARKER,
  WINDOWS_NODE_LOCAL_PIPE_MARKER
} from "../packages/agent-execution/src/index.js";
import { inspectPeAuthenticodeIdentity as inspectScriptIdentity } from "../scripts/pe-authenticode-identity.mjs";

const PE_OFFSET = 0x80;
const HEADERS_SIZE = 0x200;
const SECTION_SIZE = 0x200;

function certificateBytes(payloadByte: number): Buffer {
  const result = Buffer.alloc(16, 0);
  result.writeUInt32LE(16, 0);
  result.writeUInt16LE(0x0200, 4);
  result.writeUInt16LE(0x0002, 6);
  result.fill(payloadByte, 8);
  return result;
}

function peFixture(options: { pe32?: boolean; certificateByte?: number; checksum?: number } = {}): Buffer {
  const pe32 = options.pe32 ?? false;
  const optionalSize = pe32 ? 0xe0 : 0xf0;
  const optionalOffset = PE_OFFSET + 24;
  const sectionOffset = optionalOffset + optionalSize;
  const body = Buffer.alloc(HEADERS_SIZE + SECTION_SIZE, 0);
  body.write("MZ", 0, "ascii");
  body.writeUInt32LE(PE_OFFSET, 0x3c);
  body.write("PE\0\0", PE_OFFSET, "binary");
  body.writeUInt16LE(pe32 ? 0x014c : 0x8664, PE_OFFSET + 4);
  body.writeUInt16LE(1, PE_OFFSET + 6);
  body.writeUInt16LE(optionalSize, PE_OFFSET + 20);
  body.writeUInt16LE(pe32 ? 0x010b : 0x020b, optionalOffset);
  body.writeUInt32LE(options.checksum ?? 0x11223344, optionalOffset + 64);
  body.writeUInt32LE(HEADERS_SIZE, optionalOffset + 60);
  body.writeUInt32LE(16, optionalOffset + (pe32 ? 92 : 108));
  body.write(".text\0\0\0", sectionOffset, "binary");
  body.writeUInt32LE(SECTION_SIZE, sectionOffset + 16);
  body.writeUInt32LE(HEADERS_SIZE, sectionOffset + 20);
  for (let index = HEADERS_SIZE; index < body.length; index += 1) body[index] = index % 251;
  if (options.certificateByte === undefined) return body;
  const certificate = certificateBytes(options.certificateByte);
  const signed = Buffer.concat([body, certificate]);
  const securityDirectoryOffset = optionalOffset + (pe32 ? 128 : 144);
  signed.writeUInt32LE(body.length, securityDirectoryOffset);
  signed.writeUInt32LE(certificate.length, securityDirectoryOffset + 4);
  return signed;
}

function expectBothReject(bytes: Buffer, message: RegExp): void {
  expect(() => inspectPeAuthenticodeIdentity(bytes, "fixture")).toThrow(message);
  expect(() => inspectScriptIdentity(bytes, "fixture")).toThrow(message);
}

function patchedApprovedNode(): Buffer {
  const source = readFileSync(process.execPath);
  const offset = source.indexOf(WINDOWS_NODE_GLOBAL_PIPE_MARKER);
  if (offset < 0 || source.indexOf(WINDOWS_NODE_GLOBAL_PIPE_MARKER, offset + 1) >= 0) {
    throw new Error("approved Node fixture has an unexpected global pipe marker layout");
  }
  const patched = Buffer.from(source);
  patched.fill(0, offset, offset + WINDOWS_NODE_GLOBAL_PIPE_MARKER.length);
  WINDOWS_NODE_LOCAL_PIPE_MARKER.copy(patched, offset);
  return patched;
}

const approvedWindowsNodeAvailable = process.platform === "win32"
  && process.arch === "x64"
  && createHash("sha256").update(readFileSync(process.execPath)).digest("hex")
    === WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.sourceSha256;

describe("PE Authenticode-normalized content identity", () => {
  it.each([false, true])("is stable across certificate/checksum changes for pe32=%s", (pe32) => {
    const unsigned = peFixture({ pe32, checksum: 1 });
    const firstSigned = peFixture({ pe32, certificateByte: 0xaa, checksum: 2 });
    const secondSigned = peFixture({ pe32, certificateByte: 0x55, checksum: 3 });
    const unsignedIdentity = inspectPeAuthenticodeIdentity(unsigned);
    const firstIdentity = inspectPeAuthenticodeIdentity(firstSigned);
    const secondIdentity = inspectPeAuthenticodeIdentity(secondSigned);

    expect(firstIdentity.normalizedContentSha256).toBe(unsignedIdentity.normalizedContentSha256);
    expect(secondIdentity.normalizedContentSha256).toBe(unsignedIdentity.normalizedContentSha256);
    expect(new Set([
      unsignedIdentity.fullSha256,
      firstIdentity.fullSha256,
      secondIdentity.fullSha256
    ]).size).toBe(3);
    expect(unsignedIdentity.certificateTable).toBeNull();
    expect(firstIdentity.certificateTable).toEqual({ offset: unsigned.length, size: 16, entries: 1 });
    expect(inspectScriptIdentity(firstSigned)).toEqual(firstIdentity);
  });

  it("accepts a certificate-stripped form with the same normalized identity", () => {
    const signed = peFixture({ certificateByte: 0x42, checksum: 0x99887766 });
    const signedIdentity = inspectPeAuthenticodeIdentity(signed);
    const stripped = Buffer.from(signed.subarray(0, signedIdentity.certificateTable!.offset));
    stripped.fill(0, signedIdentity.checksumOffset, signedIdentity.checksumOffset + 4);
    stripped.fill(0, signedIdentity.securityDirectoryOffset, signedIdentity.securityDirectoryOffset + 8);

    expect(inspectPeAuthenticodeIdentity(stripped)).toMatchObject({
      normalizedContentSha256: signedIdentity.normalizedContentSha256,
      certificateTable: null
    });
  });

  it("fails closed for certificate ranges that overlap content, are not at EOF, or are malformed", () => {
    const signed = peFixture({ certificateByte: 0x42 });
    const identity = inspectPeAuthenticodeIdentity(signed);

    const overlapsSection = Buffer.from(signed);
    overlapsSection.writeUInt32LE(HEADERS_SIZE, identity.securityDirectoryOffset);
    overlapsSection.writeUInt32LE(overlapsSection.length - HEADERS_SIZE, identity.securityDirectoryOffset + 4);
    expectBothReject(overlapsSection, /overlaps PE headers or section data/u);

    const notAtEof = Buffer.from(signed);
    notAtEof.writeUInt32LE(identity.certificateTable!.size - 8, identity.securityDirectoryOffset + 4);
    expectBothReject(notAtEof, /only data at EOF/u);

    const oneSided = Buffer.from(signed);
    oneSided.writeUInt32LE(0, identity.securityDirectoryOffset);
    expectBothReject(oneSided, /both be zero or non-zero/u);

    const malformedEntry = Buffer.from(signed);
    malformedEntry.writeUInt32LE(32, identity.certificateTable!.offset);
    expectBothReject(malformedEntry, /exceeds the declared certificate table/u);
  });

  it.runIf(approvedWindowsNodeAvailable)(
    "pins patched Node normalized content while binding proofs to each full file",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-pe-identity-"));
      try {
        const first = patchedApprovedNode();
        const firstIdentity = inspectPeAuthenticodeIdentity(first);
        expect(firstIdentity).toMatchObject({
          fullSha256: WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.unsignedPatchedSha256,
          normalizedContentSha256: WINDOWS_APPCONTAINER_NODE_COMPATIBILITY.normalizedContentSha256
        });
        const second = Buffer.from(first);
        second[firstIdentity.certificateTable!.offset + 8] ^= 0xff;
        const firstPath = path.join(directory, "node-first.exe");
        const secondPath = path.join(directory, "node-second.exe");
        await writeFile(firstPath, first);
        await writeFile(secondPath, second);

        const firstProof = createWindowsAppContainerNodeCompatibilityProof(firstPath);
        const secondProof = createWindowsAppContainerNodeCompatibilityProof(secondPath);
        expect(firstProof.normalizedContentSha256).toBe(secondProof.normalizedContentSha256);
        expect(firstProof.executableSha256).not.toBe(secondProof.executableSha256);
        expect(() => assertWindowsAppContainerNodeCompatibility(secondPath, secondProof, "node"))
          .not.toThrow();
        expect(() => assertWindowsAppContainerNodeCompatibility(secondPath, firstProof, "node"))
          .toThrow(/no longer matches its compatibility proof/u);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000
  );
});
