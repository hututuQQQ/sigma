import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_PROVENANCE_PAYLOAD_BYTES,
  PROVENANCE_PAYLOAD_TYPE,
  createProvenanceEnvelope,
  verifyProvenanceEnvelope
} from "../scripts/release-provenance-signing.mjs";

describe("release provenance DSSE", () => {
  it("verifies Ed25519 only against an externally supplied trusted key", () => {
    const trusted = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const envelope = createProvenanceEnvelope({ subject: "artifact" }, trusted.privateKey);
    expect(verifyProvenanceEnvelope(envelope, [trusted.publicKey]).signature).toMatchObject({
      verified: true,
      status: "verified"
    });
    expect(verifyProvenanceEnvelope(envelope, [other.publicKey]).signature).toMatchObject({
      verified: false,
      status: "untrusted-signer"
    });
    expect(verifyProvenanceEnvelope(createProvenanceEnvelope({ subject: "preview" }), []).signature)
      .toMatchObject({ verified: false, status: "unsigned-preview" });
  });

  it("rejects non-64-byte signatures, invalid UTF-8 payloads, and unexpected fields", () => {
    const key = generateKeyPairSync("ed25519");
    const envelope = createProvenanceEnvelope({ subject: "artifact" }, key.privateKey);
    const shortSignature = structuredClone(envelope);
    shortSignature.signatures[0].sig = Buffer.alloc(63).toString("base64");
    expect(() => verifyProvenanceEnvelope(shortSignature, [key.publicKey])).toThrow("must be 64 bytes");

    const invalidUtf8 = {
      payloadType: PROVENANCE_PAYLOAD_TYPE,
      payload: Buffer.from([0xff, 0xfe]).toString("base64"),
      signatures: []
    };
    expect(() => verifyProvenanceEnvelope(invalidUtf8)).toThrow("not canonical UTF-8");

    expect(() => verifyProvenanceEnvelope({ ...envelope, unexpected: true }, [key.publicKey]))
      .toThrow("unexpected or missing fields");
    expect(() => verifyProvenanceEnvelope({
      ...envelope,
      signatures: [{ ...envelope.signatures[0], extra: true }]
    }, [key.publicKey])).toThrow("unexpected or missing fields");
  });

  it("bounds the signed payload before base64 envelope expansion", () => {
    expect(() => createProvenanceEnvelope({ value: "x".repeat(MAX_PROVENANCE_PAYLOAD_BYTES) }))
      .toThrow("payload is empty or too large");
    expect(() => verifyProvenanceEnvelope({
      payloadType: PROVENANCE_PAYLOAD_TYPE,
      payload: Buffer.alloc(MAX_PROVENANCE_PAYLOAD_BYTES + 1).toString("base64"),
      signatures: []
    })).toThrow("too large");
  });
});
