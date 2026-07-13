import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { inspectPeAuthenticodeIdentity } from "./pe-authenticode-identity.mjs";

const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SIGNTOOL_OUTPUT_BYTES = 1024 * 1024;

function normalizedDigest(value, pattern, label) {
  const digest = String(value ?? "").trim().replaceAll(":", "").toLowerCase();
  if (!pattern.test(digest)) throw new Error(`${label} is not a canonical certificate digest.`);
  return digest;
}

export function normalizeAllowedWindowsSignerCertificateSha256(values = []) {
  const configured = Array.isArray(values)
    ? values
    : String(values ?? "").split(/[;,\s]+/u).filter(Boolean);
  const result = [];
  const seen = new Set();
  for (const value of configured) {
    const digest = normalizedDigest(value, SHA256, "Allowed Windows signer certificate SHA-256");
    if (seen.has(digest)) throw new Error(`Allowed Windows signer certificate is duplicated: ${digest}.`);
    seen.add(digest);
    result.push(digest);
  }
  return result;
}

export function loadAllowedWindowsSignerCertificateSha256(env = process.env) {
  return normalizeAllowedWindowsSignerCertificateSha256(
    String(env.AGENT_WINDOWS_ALLOWED_SIGNER_CERT_SHA256 ?? "").split(/[;,\s]+/u).filter(Boolean)
  );
}

function signatureRecord(value, label) {
  const status = String(value?.status ?? "");
  const signatureType = value?.signatureType === null || value?.signatureType === undefined
    ? null
    : String(value.signatureType);
  const certificateSha256 = value?.certificateSha256 === null || value?.certificateSha256 === undefined
    ? null
    : normalizedDigest(value.certificateSha256, SHA256, `${label} signer certificate SHA-256`);
  const subject = value?.subject === null || value?.subject === undefined ? null : String(value.subject);
  const certificateTablePresent = value?.certificateTablePresent === true;
  return { status, signatureType, certificateSha256, subject, certificateTablePresent };
}

export function evaluateWindowsAuthenticodePolicy(observed, allowedCertificateSha256 = []) {
  const allowed = normalizeAllowedWindowsSignerCertificateSha256(allowedCertificateSha256);
  const signatures = {
    node: signatureRecord(observed?.node, "Node"),
    sigmaExec: signatureRecord(observed?.sigmaExec, "sigma-exec")
  };
  const signerIds = {
    node: signatures.node.certificateSha256,
    sigmaExec: signatures.sigmaExec.certificateSha256
  };
  const authenticodeVerified = Object.values(signatures).every(
    (signature) => signature.status === "Valid"
      && signature.signatureType === "Authenticode"
      && signature.certificateSha256 !== null
      && signature.certificateTablePresent
  );
  const policyConfigured = allowed.length > 0;
  const unapprovedSignerIds = authenticodeVerified
    ? [...new Set(Object.values(signerIds).filter((id) => !allowed.includes(id)))]
    : [];
  const policyVerified = authenticodeVerified && policyConfigured && unapprovedSignerIds.length === 0;
  const status = !authenticodeVerified
    ? "signature-invalid-or-missing"
    : !policyConfigured
      ? "valid-signatures-untrusted-preview"
      : policyVerified
        ? "verified-approved-signers"
        : "valid-signature-from-unapproved-signer";
  return {
    authenticodeVerified,
    policyConfigured,
    policyVerified,
    status,
    observedSignerIds: signerIds,
    unapprovedSignerIds,
    signatures
  };
}

function configuredSigntool(env) {
  const executableValue = String(env.AGENT_WINDOWS_SIGNTOOL_PATH ?? "").trim();
  const certificateValue = String(env.AGENT_WINDOWS_SIGN_CERTIFICATE_SHA1 ?? "").trim();
  const timestampValue = String(env.AGENT_WINDOWS_SIGN_TIMESTAMP_URL ?? "").trim();
  if (!executableValue && !certificateValue && !timestampValue) return null;
  if (!executableValue || !certificateValue) {
    throw new Error("Windows signing requires both AGENT_WINDOWS_SIGNTOOL_PATH and AGENT_WINDOWS_SIGN_CERTIFICATE_SHA1.");
  }
  if (!path.isAbsolute(executableValue) || path.basename(executableValue).toLowerCase() !== "signtool.exe") {
    throw new Error("AGENT_WINDOWS_SIGNTOOL_PATH must be an absolute path to signtool.exe.");
  }
  const stats = lstatSync(executableValue);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("AGENT_WINDOWS_SIGNTOOL_PATH must identify one regular, non-symbolic-link file.");
  }
  let timestampUrl = null;
  if (timestampValue) {
    const parsed = new URL(timestampValue);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new Error("AGENT_WINDOWS_SIGN_TIMESTAMP_URL must be an HTTPS URL without credentials or a fragment.");
    }
    timestampUrl = parsed.href;
  }
  return {
    executable: executableValue,
    certificateSha1: normalizedDigest(
      certificateValue,
      SHA1,
      "AGENT_WINDOWS_SIGN_CERTIFICATE_SHA1"
    ),
    timestampUrl
  };
}

function runSigntool(configuration, files, spawn) {
  const args = [
    "sign",
    "/fd", "SHA256",
    "/sha1", configuration.certificateSha1,
    ...(configuration.timestampUrl ? ["/tr", configuration.timestampUrl, "/td", "SHA256"] : []),
    ...files
  ];
  const result = spawn(configuration.executable, args, {
    encoding: "utf8",
    maxBuffer: MAX_SIGNTOOL_OUTPUT_BYTES,
    shell: false,
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      "signtool failed to sign the staged Windows release executables.",
      result.error?.message,
      result.stderr,
      result.stdout
    ].filter(Boolean).join("\n"));
  }
}

function stagedIdentity(file, label) {
  return inspectPeAuthenticodeIdentity(readFileSync(file), label);
}

function assertSigningPreservedContent(before, after, label) {
  if (before.normalizedContentSha256 !== after.normalizedContentSha256) {
    throw new Error(`Windows signing changed the Authenticode-normalized ${label} content identity.`);
  }
}

/** Sign both staged Windows executables before any digest-bearing release metadata is produced. */
export async function runWindowsSigningStage({
  targetPlatform,
  targetArch,
  nodePath,
  brokerPath,
  signer,
  env = process.env,
  spawn = spawnSync
}) {
  if (targetPlatform !== "win32") return { attempted: false, method: "not-applicable" };
  const files = Object.freeze([nodePath, brokerPath]);
  const callback = signer === undefined ? null : signer;
  if (callback !== null && typeof callback !== "function") {
    throw new Error("windowsSigner must be a function when provided.");
  }
  const configuration = callback === null ? configuredSigntool(env) : null;
  if (callback === null && !configuration) return { attempted: false, method: "unsigned-preview" };
  const before = {
    node: stagedIdentity(nodePath, "staged Windows Node"),
    sigmaExec: stagedIdentity(brokerPath, "staged sigma-exec")
  };
  if (callback !== null) {
    await callback(Object.freeze({ targetPlatform, targetArch, nodePath, brokerPath, files }));
  } else {
    runSigntool(configuration, files, spawn);
  }
  const after = {
    node: stagedIdentity(nodePath, "signed Windows Node"),
    sigmaExec: stagedIdentity(brokerPath, "signed sigma-exec")
  };
  assertSigningPreservedContent(before.node, after.node, "Node");
  assertSigningPreservedContent(before.sigmaExec, after.sigmaExec, "sigma-exec");
  return { attempted: true, method: callback === null ? "signtool" : "callback" };
}
