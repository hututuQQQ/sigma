import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, stat, writeFile
} from "node:fs/promises";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceStateRoot } from "./event-store.mjs";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const execFileAsync = promisify(execFileCallback);
const ARCHIVE_ID = /^[a-f0-9]{64}$/u;
const EVIDENCE_SOURCE_KINDS = new Set(["formal_ab_slot", "generic_conformance", "real_session"]);

export const DEFAULT_VAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export class EvaluationVaultCapacityError extends Error {
  constructor(status) {
    super(`EvaluationVault capacity reached (${status.projectedBytes}/${status.maxBytes} bytes).`);
    this.name = "EvaluationVaultCapacityError";
    this.code = "evaluation_vault_capacity_reached";
    this.status = status;
  }
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function windowsIdentity(env = process.env) {
  const username = env.USERNAME || os.userInfo().username;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${username}` : username;
}

async function hardenWindows(target, directory, options) {
  const execute = options.execFile ?? execFileAsync;
  const identity = windowsIdentity(options.env);
  const grant = directory ? `${identity}:(OI)(CI)F` : `${identity}:F`;
  await execute("icacls.exe", [target, "/inheritance:r", "/grant:r", grant], { windowsHide: true });
}

async function hardenPath(target, directory, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    await hardenWindows(target, directory, options);
    return;
  }
  await chmod(target, directory ? 0o700 : 0o600);
}

async function assertNoLinkedPath(target) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error("EvaluationVault paths may not traverse symlinks or junctions.");
  }
}

async function secureDirectory(directory, options = {}) {
  await assertNoLinkedPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await hardenPath(directory, true, options);
}

async function atomicSecureWrite(filePath, data, options = {}) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, { mode: 0o600, flag: "wx" });
  await hardenPath(temp, false, options);
  await rename(temp, filePath);
  await hardenPath(filePath, false, options);
}

export async function prepareEvaluationVaultDirectory(directory, options = {}) {
  const resolved = path.resolve(directory);
  await secureDirectory(resolved, options);
  return resolved;
}

export async function writeEvaluationVaultJson(filePath, value, options = {}) {
  await atomicSecureWrite(path.resolve(filePath), `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writeEvaluationVaultJsonExclusive(filePath, value, options = {}) {
  const resolved = path.resolve(filePath);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  if (!options.vaultRoot) {
    await writeFile(resolved, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await hardenPath(resolved, false, options);
    return;
  }
  const vaultRoot = path.resolve(options.vaultRoot);
  if (resolved !== vaultRoot && !resolved.startsWith(`${vaultRoot}${path.sep}`)) {
    throw new Error("Capacity-accounted EvaluationVault writes must remain inside the vault root.");
  }
  await secureDirectory(vaultRoot, options);
  const release = await claimCapacityTransaction(vaultRoot, options);
  try {
    const currentBytes = await directoryBytes(vaultRoot);
    const projectedBytes = currentBytes + Buffer.byteLength(data);
    const maxBytes = options.maxBytes ?? DEFAULT_VAULT_MAX_BYTES;
    if (projectedBytes > maxBytes) {
      const status = { observedAt: new Date().toISOString(), currentBytes, projectedBytes, maxBytes };
      await writeCapacityAlert(vaultRoot, status, options);
      throw new EvaluationVaultCapacityError(status);
    }
    await writeFile(resolved, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await hardenPath(resolved, false, options);
  } finally {
    await release();
  }
}

export async function claimEvaluationVaultRunDirectory(directory, options = {}) {
  const resolved = path.resolve(directory);
  await secureDirectory(path.dirname(resolved), options);
  try {
    await mkdir(resolved, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(new Error("This frozen experiment has already been consumed or partially executed."), {
        code: "formal_gate_already_consumed"
      });
    }
    throw error;
  }
  await hardenPath(resolved, true, options);
  return resolved;
}

async function directoryBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let bytes = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(target);
    else if (entry.isFile()) bytes += (await stat(target)).size;
  }
  return bytes;
}

function relativeEvidencePath(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function stableFileEvidence(target, relativePath) {
  const before = await lstat(target);
  if (!before.isFile()) throw new Error(`Evaluation evidence changed while being archived: ${relativePath}`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(target, constants.O_RDONLY | noFollow);
  try {
    const [opened, after] = await Promise.all([handle.stat(), lstat(target)]);
    if (!after.isFile() || opened.dev !== after.dev || opened.ino !== after.ino) {
      throw new Error(`Evaluation evidence changed while being archived: ${relativePath}`);
    }
    const data = await handle.readFile();
    if (data.length !== opened.size) {
      throw new Error(`Evaluation evidence changed while being archived: ${relativePath}`);
    }
    return {
      path: relativeEvidencePath(relativePath), type: "file", bytes: data.length,
      sha256: hash(data), contentBase64: data.toString("base64")
    };
  } finally {
    await handle.close();
  }
}

async function collectEvidenceTree(root, relativeDirectory = "") {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const evidence = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const target = path.join(root, relativePath);
    const info = await lstat(target);
    if (info.isDirectory()) {
      evidence.push({ path: relativeEvidencePath(relativePath), type: "directory" });
      evidence.push(...await collectEvidenceTree(root, relativePath));
    } else if (info.isFile()) {
      evidence.push(await stableFileEvidence(target, relativePath));
    } else if (info.isSymbolicLink()) {
      evidence.push({
        path: relativeEvidencePath(relativePath), type: "link", target: await readlink(target)
      });
    } else {
      throw new Error(`Unsupported evaluation evidence entry: ${relativeEvidencePath(relativePath)}`);
    }
  }
  return evidence;
}

function evidenceEnvelope(payload, metadata) {
  return {
    schemaVersion: 1,
    kind: "sigma.evaluation-vault-evidence",
    createdAt: metadata.createdAt,
    sourceKind: metadata.sourceKind,
    payload
  };
}

function archiveManifest(archiveId, raw, compressed, metadata) {
  return {
    schemaVersion: 1,
    kind: "sigma.evaluation-vault-manifest",
    archiveId,
    createdAt: metadata.createdAt,
    sourceKind: metadata.sourceKind,
    compression: "gzip",
    evidenceFile: "evidence.json.gz",
    uncompressedBytes: raw.length,
    compressedBytes: compressed.length,
    uncompressedSha256: hash(raw),
    compressedSha256: hash(compressed),
    uploadPolicy: "disabled",
    deletionPolicy: "manual_only"
  };
}

// Archive verification deliberately enumerates every integrity invariant.
// eslint-disable-next-line complexity
function assertArchiveManifest(manifest, archiveId) {
  const valid = manifest?.schemaVersion === 1
    && manifest?.kind === "sigma.evaluation-vault-manifest"
    && manifest?.archiveId === archiveId
    && typeof manifest?.createdAt === "string" && Number.isFinite(Date.parse(manifest.createdAt))
    && EVIDENCE_SOURCE_KINDS.has(manifest?.sourceKind)
    && manifest?.compression === "gzip"
    && manifest?.evidenceFile === "evidence.json.gz"
    && Number.isSafeInteger(manifest?.uncompressedBytes) && manifest.uncompressedBytes >= 0
    && Number.isSafeInteger(manifest?.compressedBytes) && manifest.compressedBytes >= 0
    && ARCHIVE_ID.test(manifest?.uncompressedSha256 ?? "")
    && ARCHIVE_ID.test(manifest?.compressedSha256 ?? "")
    && manifest.compressedSha256 === archiveId
    && manifest?.uploadPolicy === "disabled"
    && manifest?.deletionPolicy === "manual_only";
  if (!valid) throw new Error("EvaluationVault archive manifest is invalid or does not match its archive id.");
  return manifest;
}

async function writeCapacityAlert(vaultRoot, status, options) {
  const alert = {
    schemaVersion: 1,
    kind: "sigma.evaluation-vault-status",
    status: "capacity_reached",
    observedAt: status.observedAt,
    currentBytes: status.currentBytes,
    projectedBytes: status.projectedBytes,
    maxBytes: status.maxBytes,
    action: "manual_review_required"
  };
  const target = path.join(vaultRoot, "capacity-alert.json");
  try {
    await writeFile(target, `${JSON.stringify(alert, null, 2)}\n`, {
      encoding: "utf8", mode: 0o600, flag: "wx"
    });
    await hardenPath(target, false, options);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    // Capacity alerts are evidence too: retain the first one until an owner
    // explicitly reviews/removes it instead of silently replacing history.
  }
}

async function claimCapacityTransaction(vaultRoot, options) {
  const lockDirectory = path.join(vaultRoot, ".capacity-transaction");
  try {
    await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(new Error("EvaluationVault capacity transaction is already active."), {
        code: "evaluation_vault_capacity_transaction_busy"
      });
    }
    throw error;
  }
  await hardenPath(lockDirectory, true, options);
  return async () => rm(lockDirectory, { recursive: true, force: false });
}

async function commitArchive(vaultRoot, archiveDirectory, compressed, manifest, options) {
  const release = await claimCapacityTransaction(vaultRoot, options);
  try {
    const existing = await stat(archiveDirectory).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      const verified = await verifyEvaluationVaultArchive(vaultRoot, manifest.archiveId);
      return { manifest: verified.manifest, reused: true };
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const currentBytes = await directoryBytes(vaultRoot);
    const projectedBytes = currentBytes + compressed.length + manifestBytes.length;
    const maxBytes = options.maxBytes ?? DEFAULT_VAULT_MAX_BYTES;
    if (projectedBytes > maxBytes) {
      const status = { observedAt: manifest.createdAt, currentBytes, projectedBytes, maxBytes };
      await writeCapacityAlert(vaultRoot, status, options);
      throw new EvaluationVaultCapacityError(status);
    }
    const archivesRoot = path.dirname(archiveDirectory);
    await secureDirectory(archivesRoot, options);
    const incoming = path.join(archivesRoot, `.incoming-${process.pid}-${randomBytes(12).toString("hex")}`);
    await secureDirectory(incoming, options);
    try {
      await atomicSecureWrite(path.join(incoming, manifest.evidenceFile), compressed, options);
      await atomicSecureWrite(path.join(incoming, "manifest.json"), manifestBytes, options);
      await rename(incoming, archiveDirectory);
      await hardenPath(archiveDirectory, true, options);
    } catch (error) {
      await rm(incoming, { recursive: true, force: true });
      throw error;
    }
    return { manifest, reused: false };
  } finally {
    await release();
  }
}

export async function resolveEvaluationVault(workspace, stateOptions = {}) {
  const stateRoot = await resolveWorkspaceStateRoot(workspace, stateOptions);
  return path.join(stateRoot, "EvaluationVault");
}

export async function archiveEvaluationEvidence(input, options = {}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("EvaluationVault evidence createdAt must be an ISO-compatible timestamp.");
  }
  const sourceKind = EVIDENCE_SOURCE_KINDS.has(input.sourceKind) ? input.sourceKind : "real_session";
  const vaultRoot = path.resolve(options.vaultRoot ?? await resolveEvaluationVault(input.workspace ?? ".", options.stateOptions));
  await secureDirectory(vaultRoot, options);
  const raw = Buffer.from(`${JSON.stringify(evidenceEnvelope(input.payload, { createdAt, sourceKind }))}\n`, "utf8");
  const compressed = await gzipAsync(raw, { level: 9 });
  const archiveId = hash(compressed);
  const manifest = archiveManifest(archiveId, raw, compressed, { createdAt, sourceKind });
  const archiveDirectory = path.join(vaultRoot, "archives", archiveId);
  const committed = await commitArchive(vaultRoot, archiveDirectory, compressed, manifest, options);
  const verified = await verifyEvaluationVaultArchive(vaultRoot, archiveId);
  return {
    vaultRoot, archiveDirectory, manifest: verified.manifest,
    reused: committed.reused
  };
}

export async function archiveEvaluationDirectory(input, options = {}) {
  const sourceDirectory = path.resolve(input.directory);
  await assertNoLinkedPath(sourceDirectory);
  const root = await lstat(sourceDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error("Evaluation evidence source must be a real directory.");
  }
  const entries = await collectEvidenceTree(sourceDirectory);
  return archiveEvaluationEvidence({
    workspace: input.workspace,
    createdAt: input.createdAt,
    sourceKind: input.sourceKind ?? "formal_ab_slot",
    payload: {
      schemaVersion: 1,
      kind: "sigma.evaluation-directory-evidence",
      metadata: input.metadata ?? {},
      tree: { encoding: "base64", entries }
    }
  }, options);
}

export async function verifyEvaluationVaultArchive(vaultRoot, archiveId) {
  if (!ARCHIVE_ID.test(archiveId)) throw new Error("Invalid EvaluationVault archive id.");
  const archiveDirectory = path.join(path.resolve(vaultRoot), "archives", archiveId);
  const manifestPath = path.join(archiveDirectory, "manifest.json");
  await assertNoLinkedPath(manifestPath);
  const manifest = assertArchiveManifest(JSON.parse(await readFile(manifestPath, "utf8")), archiveId);
  const evidencePath = path.join(archiveDirectory, manifest.evidenceFile);
  await assertNoLinkedPath(evidencePath);
  const compressed = await readFile(evidencePath);
  if (hash(compressed) !== manifest.compressedSha256 || compressed.length !== manifest.compressedBytes) {
    throw new Error("EvaluationVault compressed evidence checksum mismatch.");
  }
  const raw = await gunzipAsync(compressed);
  if (hash(raw) !== manifest.uncompressedSha256 || raw.length !== manifest.uncompressedBytes) {
    throw new Error("EvaluationVault raw evidence checksum mismatch.");
  }
  const evidence = JSON.parse(raw.toString("utf8"));
  if (evidence?.schemaVersion !== 1 || evidence?.kind !== "sigma.evaluation-vault-evidence"
    || evidence?.createdAt !== manifest.createdAt || evidence?.sourceKind !== manifest.sourceKind) {
    throw new Error("EvaluationVault evidence envelope does not match its manifest.");
  }
  return { manifest, evidence };
}

export async function manuallyDeleteEvaluationVaultArchive(vaultRoot, archiveId, confirmation) {
  if (!ARCHIVE_ID.test(archiveId)) throw new Error("Invalid EvaluationVault archive id.");
  if (confirmation !== archiveId) throw new Error("Manual deletion requires the exact archive id as confirmation.");
  const root = path.resolve(vaultRoot);
  const target = path.resolve(root, "archives", archiveId);
  if (!target.startsWith(`${path.join(root, "archives")}${path.sep}`)) throw new Error("Unsafe EvaluationVault deletion target.");
  await rm(target, { recursive: true, force: false });
}
