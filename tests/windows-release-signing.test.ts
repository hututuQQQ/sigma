import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPeAuthenticodeIdentity } from "../scripts/pe-authenticode-identity.mjs";
import {
  evaluateWindowsAuthenticodePolicy,
  runWindowsSigningStage
} from "../scripts/windows-release-signing.mjs";

function peFixture(seed: number): Buffer {
  const result = Buffer.alloc(0x400, 0);
  result.write("MZ", 0, "ascii");
  result.writeUInt32LE(0x80, 0x3c);
  result.write("PE\0\0", 0x80, "binary");
  result.writeUInt16LE(0x8664, 0x84);
  result.writeUInt16LE(1, 0x86);
  result.writeUInt16LE(0xf0, 0x94);
  result.writeUInt16LE(0x020b, 0x98);
  result.writeUInt32LE(0x200, 0x98 + 60);
  result.writeUInt32LE(16, 0x98 + 108);
  const section = 0x98 + 0xf0;
  result.write(".text\0\0\0", section, "binary");
  result.writeUInt32LE(0x200, section + 16);
  result.writeUInt32LE(0x200, section + 20);
  result.fill(seed, 0x200);
  return result;
}

function withCertificate(bytes: Buffer, seed: number): Buffer {
  const before = inspectPeAuthenticodeIdentity(bytes);
  expect(before.certificateTable).toBeNull();
  const certificate = Buffer.alloc(16, seed);
  certificate.writeUInt32LE(16, 0);
  certificate.writeUInt16LE(0x0200, 4);
  certificate.writeUInt16LE(0x0002, 6);
  const result = Buffer.concat([bytes, certificate]);
  result.writeUInt32LE(bytes.length, before.securityDirectoryOffset);
  result.writeUInt32LE(certificate.length, before.securityDirectoryOffset + 4);
  result.writeUInt32LE(seed, before.checksumOffset);
  return result;
}

describe("Windows release signing", () => {
  it("requires both valid signatures to match the external certificate SHA-256 policy", () => {
    const approvedNode = "a".repeat(64);
    const approvedBroker = "b".repeat(64);
    const valid = {
      node: {
        status: "Valid",
        signatureType: "Authenticode",
        certificateSha256: approvedNode,
        subject: "CN=Node",
        certificateTablePresent: true
      },
      sigmaExec: {
        status: "Valid",
        signatureType: "Authenticode",
        certificateSha256: approvedBroker,
        subject: "CN=Broker",
        certificateTablePresent: true
      }
    };
    expect(evaluateWindowsAuthenticodePolicy(valid, [approvedNode, approvedBroker])).toMatchObject({
      authenticodeVerified: true,
      policyConfigured: true,
      policyVerified: true,
      status: "verified-approved-signers"
    });
    expect(evaluateWindowsAuthenticodePolicy(valid, [approvedNode, "c".repeat(64)])).toMatchObject({
      authenticodeVerified: true,
      policyVerified: false,
      status: "valid-signature-from-unapproved-signer",
      unapprovedSignerIds: [approvedBroker]
    });
    expect(evaluateWindowsAuthenticodePolicy({
      ...valid,
      sigmaExec: { ...valid.sigmaExec, status: "HashMismatch" }
    }, [approvedNode, approvedBroker])).toMatchObject({
      authenticodeVerified: false,
      policyVerified: false,
      status: "signature-invalid-or-missing"
    });
    expect(evaluateWindowsAuthenticodePolicy({
      ...valid,
      node: { ...valid.node, signatureType: "Catalog" }
    }, [approvedNode, approvedBroker])).toMatchObject({
      authenticodeVerified: false,
      policyVerified: false,
      status: "signature-invalid-or-missing"
    });
    expect(evaluateWindowsAuthenticodePolicy({
      ...valid,
      sigmaExec: { ...valid.sigmaExec, certificateTablePresent: false }
    }, [approvedNode, approvedBroker])).toMatchObject({
      authenticodeVerified: false,
      policyVerified: false,
      status: "signature-invalid-or-missing"
    });
  });

  it("invokes one explicitly configured signtool executable without a shell", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-signtool-stage-"));
    try {
      const signtool = path.join(directory, "signtool.exe");
      const nodePath = path.join(directory, "node.exe");
      const brokerPath = path.join(directory, "sigma-exec.exe");
      await writeFile(signtool, "fixture");
      await writeFile(nodePath, peFixture(1));
      await writeFile(brokerPath, peFixture(2));
      const calls: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = [];
      const result = await runWindowsSigningStage({
        targetPlatform: "win32",
        targetArch: "x64",
        nodePath,
        brokerPath,
        env: {
          AGENT_WINDOWS_SIGNTOOL_PATH: signtool,
          AGENT_WINDOWS_SIGN_CERTIFICATE_SHA1: "d".repeat(40),
          AGENT_WINDOWS_SIGN_TIMESTAMP_URL: "https://timestamp.example.test"
        },
        spawn: (executable: string, args: string[], options: Record<string, unknown>) => {
          calls.push({ executable, args, options });
          return { status: 0, stdout: "", stderr: "" };
        }
      });
      expect(result).toEqual({ attempted: true, method: "signtool" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        executable: signtool,
        args: [
          "sign", "/fd", "SHA256", "/sha1", "d".repeat(40),
          "/tr", "https://timestamp.example.test/", "/td", "SHA256",
          nodePath, brokerPath
        ],
        options: expect.objectContaining({ shell: false, windowsHide: true })
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows certificate-only changes but rejects replacement of Node or broker content", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-signing-content-"));
    try {
      const nodePath = path.join(directory, "node.exe");
      const brokerPath = path.join(directory, "sigma-exec.exe");
      await writeFile(nodePath, peFixture(3));
      await writeFile(brokerPath, peFixture(4));
      await expect(runWindowsSigningStage({
        targetPlatform: "win32",
        targetArch: "x64",
        nodePath,
        brokerPath,
        signer: async ({ files }: { files: readonly string[] }) => {
          for (const [index, file] of files.entries()) {
            await writeFile(file, withCertificate(await readFile(file), index + 1));
          }
        },
        env: {}
      })).resolves.toEqual({ attempted: true, method: "callback" });

      await writeFile(nodePath, peFixture(3));
      await writeFile(brokerPath, peFixture(4));
      await expect(runWindowsSigningStage({
        targetPlatform: "win32",
        targetArch: "x64",
        nodePath,
        brokerPath,
        signer: async () => {
          const changed = await readFile(brokerPath);
          changed[0x220] ^= 0xff;
          await writeFile(brokerPath, changed);
        },
        env: {}
      })).rejects.toThrow("changed the Authenticode-normalized sigma-exec content identity");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
