import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const PROVENANCE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const MAX_PROVENANCE_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const MAX_PROVENANCE_PAYLOAD_BYTES = 1024 * 1024;
const MAX_SIGNATURES = 16;
const MAX_KEY_FILE_BYTES = 64 * 1024;

function lengthPrefix(value) {
  return Buffer.from(String(value), "ascii");
}

/** DSSE pre-authentication encoding, using byte rather than character lengths. */
export function dssePreAuthEncoding(payloadType, payload) {
  const type = Buffer.from(payloadType, "utf8");
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([
    Buffer.from("DSSEv1 ", "ascii"),
    lengthPrefix(type.length),
    Buffer.from(" ", "ascii"),
    type,
    Buffer.from(" ", "ascii"),
    lengthPrefix(bytes.length),
    Buffer.from(" ", "ascii"),
    bytes
  ]);
}

function assertEd25519(key, label) {
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} must be an Ed25519 key.`);
  }
  return key;
}

function privateKey(value) {
  return assertEd25519(
    value?.type === "private" ? value : createPrivateKey(value),
    "Release provenance private key"
  );
}

function publicKey(value) {
  const candidate = value?.type === "public" ? value : createPublicKey(value);
  return assertEd25519(candidate, "Trusted release provenance public key");
}

export function releaseProvenanceKeyId(value) {
  const key = value?.type === "private" ? createPublicKey(value) : publicKey(value);
  const spki = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("hex");
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has unexpected or missing fields.`);
  }
}

function canonicalBase64(value, label, maximumBytes) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`${label} is not canonical base64.`);
  }
  if (value.length > Math.ceil(maximumBytes / 3) * 4) throw new Error(`${label} is too large.`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximumBytes) throw new Error(`${label} is too large.`);
  if (bytes.toString("base64") !== value) throw new Error(`${label} is not canonical base64.`);
  return bytes;
}

export function createProvenanceEnvelope(statement, signingPrivateKey) {
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) {
    throw new Error("Release provenance statement must be a JSON object.");
  }
  const serialized = JSON.stringify(statement, null, 2);
  if (serialized === undefined) throw new Error("Release provenance statement is not JSON serializable.");
  const payload = Buffer.from(`${serialized}\n`, "utf8");
  if (payload.length === 0 || payload.length > MAX_PROVENANCE_PAYLOAD_BYTES) {
    throw new Error("Release provenance payload is empty or too large.");
  }
  const signatures = [];
  if (signingPrivateKey !== undefined && signingPrivateKey !== null) {
    const key = privateKey(signingPrivateKey);
    const signature = sign(null, dssePreAuthEncoding(PROVENANCE_PAYLOAD_TYPE, payload), key);
    if (signature.length !== 64) throw new Error("Ed25519 produced an unexpected signature length.");
    signatures.push({
      keyid: releaseProvenanceKeyId(key),
      sig: signature.toString("base64")
    });
  }
  return {
    payloadType: PROVENANCE_PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures
  };
}

function trustedKeyMap(values) {
  const result = new Map();
  for (const value of values ?? []) {
    const wrapped = value && typeof value === "object" && Object.hasOwn(value, "key");
    if (wrapped) exactObject(value, value.keyId === undefined ? ["key"] : ["key", "keyId"], "Trusted release provenance key");
    const key = publicKey(wrapped ? value.key : value);
    const keyid = releaseProvenanceKeyId(key);
    if (value?.keyId !== undefined && value.keyId !== keyid) {
      throw new Error(`Trusted release provenance key ID does not match its public key: ${value.keyId}.`);
    }
    if (result.has(keyid)) throw new Error(`Trusted release provenance key is duplicated: ${keyid}.`);
    result.set(keyid, key);
  }
  return result;
}

export function verifyProvenanceEnvelope(envelope, trustedPublicKeys = []) {
  exactObject(envelope, ["payloadType", "payload", "signatures"], "Portable provenance DSSE envelope");
  if (!envelope || typeof envelope !== "object" || envelope.payloadType !== PROVENANCE_PAYLOAD_TYPE) {
    throw new Error("Portable provenance sidecar is not a supported DSSE envelope.");
  }
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length > MAX_SIGNATURES) {
    throw new Error(`Portable provenance DSSE signatures must contain at most ${MAX_SIGNATURES} entries.`);
  }
  const payload = canonicalBase64(
    envelope.payload,
    "Portable provenance DSSE payload",
    MAX_PROVENANCE_PAYLOAD_BYTES
  );
  const payloadText = payload.toString("utf8");
  if (!Buffer.from(payloadText, "utf8").equals(payload)) {
    throw new Error("Portable provenance DSSE payload is not canonical UTF-8.");
  }
  let statement;
  try {
    statement = JSON.parse(payloadText);
  } catch (error) {
    throw new Error(
      `Portable provenance DSSE payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) {
    throw new Error("Portable provenance DSSE payload must contain a JSON object statement.");
  }
  const trusted = trustedKeyMap(trustedPublicKeys);
  const seen = new Set();
  const verifiedKeyIds = [];
  const pae = dssePreAuthEncoding(envelope.payloadType, payload);
  for (const signature of envelope.signatures) {
    exactObject(signature, ["keyid", "sig"], "Portable provenance DSSE signature");
    if (!/^[a-f0-9]{64}$/u.test(String(signature?.keyid ?? "")) || seen.has(signature.keyid)) {
      throw new Error("Portable provenance DSSE contains an invalid or duplicate key ID.");
    }
    seen.add(signature.keyid);
    const signatureBytes = canonicalBase64(
      signature.sig,
      `Portable provenance DSSE signature ${signature.keyid}`,
      64
    );
    if (signatureBytes.length !== 64) {
      throw new Error(`Portable provenance DSSE signature ${signature.keyid} must be 64 bytes.`);
    }
    const key = trusted.get(signature.keyid);
    if (!key) continue;
    if (!verify(null, pae, key, signatureBytes)) {
      throw new Error(`Portable provenance DSSE signature is invalid for trusted key ${signature.keyid}.`);
    }
    verifiedKeyIds.push(signature.keyid);
  }
  const verified = verifiedKeyIds.length > 0;
  return {
    statement,
    signature: {
      required: true,
      verified,
      status: verified
        ? "verified"
        : envelope.signatures.length === 0
          ? "unsigned-preview"
          : trusted.size === 0
            ? "trust-policy-unconfigured"
            : "untrusted-signer",
      keyIds: [...seen],
      verifiedKeyIds
    }
  };
}

function configuredFiles(value) {
  const files = String(value ?? "").split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  if (files.length > MAX_SIGNATURES || new Set(files.map((file) => path.resolve(file))).size !== files.length) {
    throw new Error(`Release provenance key files must contain at most ${MAX_SIGNATURES} unique paths.`);
  }
  return files;
}

function readKeyFile(file, label) {
  const absolute = path.resolve(file);
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0 || stats.size > MAX_KEY_FILE_BYTES) {
    throw new Error(`${label} must be a non-empty regular file no larger than ${MAX_KEY_FILE_BYTES} bytes.`);
  }
  return readFileSync(absolute, "utf8");
}

export function loadReleaseProvenancePrivateKey(env = process.env) {
  const file = String(env.AGENT_RELEASE_SIGNING_PRIVATE_KEY_FILE ?? "").trim();
  return file ? readKeyFile(file, "Release provenance private key file") : undefined;
}

export function loadTrustedReleaseProvenanceKeys(env = process.env) {
  return configuredFiles(env.AGENT_RELEASE_TRUSTED_PUBLIC_KEY_FILES)
    .map((file) => readKeyFile(file, "Trusted release provenance public key file"));
}
