#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./common.mjs";
import { archiveEvaluationEvidence } from "./evaluation-vault.mjs";
import {
  assertV5EventStream, listV5Sessions, readV5Session, resolveWorkspaceStateRoot
} from "./event-store.mjs";
import { reduceAgentEvents } from "./metrics.mjs";
import { createOptimizerClusterCards, createOptimizerObservations } from "./optimizer-observation.mjs";
import { assertOptimizerObservationV1, sha256 } from "./optimizer-schema.mjs";
import {
  readRegisteredOptimizationExperiments, resolveOptimizationRepositoryStateRoot
} from "./optimization-experiment.mjs";

function positiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

// eslint-disable-next-line complexity -- the explicit CLI allowlist keeps provenance inputs fail closed.
export function parseOptimizerObserveArgs(argv) {
  const options = {
    workspace: ".", latest: 10, includeRealSessions: true, sessionIds: [], conformanceEventPaths: []
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`Missing value after ${argument}.`);
      return value;
    };
    if (argument === "--workspace") options.workspace = next();
    else if (argument === "--state-root") options.stateRoot = next();
    else if (argument === "--output") options.output = next();
    else if (argument === "--vault-root") options.vaultRoot = next();
    else if (argument === "--latest") options.latest = positiveInteger(next(), "--latest");
    else if (argument === "--session") options.sessionIds.push(next());
    else if (argument === "--sessions") options.sessionIds.push(...next().split(",").filter(Boolean));
    else if (argument === "--conformance-events") options.conformanceEventPaths.push(next());
    else if (argument === "--generic-only") options.includeRealSessions = false;
    else if (argument === "--provider") options.provider = next();
    else if (argument === "--model") options.model = next();
    else if (argument === "--surface") options.surface = next();
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.includeRealSessions && options.sessionIds.length > 0) {
    throw new Error("--generic-only cannot be combined with --session or --sessions.");
  }
  return options;
}

const HEX_64 = /^[a-f0-9]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{1,95}$/u;
const DEFAULT_DIGEST = sha256("unavailable");
// A launcher that can bind source and built artifacts may record this as
// runtime-authority diagnostic evidence before the first model turn. The
// optimizer never substitutes the collector's current checkout for it.
export const OPTIMIZER_SUBJECT_ATTESTATION_SOURCE_V1 = "sigma.subject_attestation.v1";
export const OPTIMIZER_SUBJECT_ATTESTOR_ID_V1 = "subject-attestor";
const GENERIC_EVALUATOR_KEY = /^(?:benchmark|scenario(?:id|name)?|task(?:id|name)|dataset(?:id|name)?|fixture(?:id|name)?|verifier|reward|score|expected(?:output|result)|rawprompt)$/iu;
const GENERIC_EVALUATOR_CONTENT = /(?:\bbenchmark\b|\b(?:scenario|task|dataset|fixture|verifier|reward|score)[_-]?(?:id|name|result|output)?\b|\bexpected[_ -]?(?:output|result)\b|\b(?:raw|original)[_ -]?prompt\b)/iu;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function digestField(value, label) {
  if (typeof value !== "string" || !HEX_64.test(value) || value === DEFAULT_DIGEST) {
    throw new Error(`${label} must be an available lowercase SHA-256 digest.`);
  }
  return value;
}

function codeField(value, label) {
  if (typeof value !== "string" || !SAFE_CODE.test(value)) throw new Error(`${label} must be a stable code.`);
  return value;
}

function modelField(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty model identity of at most 128 characters.`);
  }
  return value;
}

function parseSubjectAttestationEvent(event) {
  const payload = object(event.payload);
  const data = object(payload.data);
  if (data.source !== OPTIMIZER_SUBJECT_ATTESTATION_SOURCE_V1) return null;
  if (event.type !== "evidence.recorded" || event.authority !== "runtime"
    || payload.kind !== "diagnostic" || !["passed", "informational"].includes(payload.status)
    || object(payload.producer).authority !== "runtime"
    || object(payload.producer).id !== OPTIMIZER_SUBJECT_ATTESTOR_ID_V1) {
    throw new Error("Subject attestation evidence has an untrusted durable authority.");
  }
  const diagnostic = object(data.diagnostic);
  exactKeys(diagnostic, [
    "schemaVersion", "productDigest", "buildArtifactDigest", "configurationDigest",
    "environmentDigest", "platform", "surface", "provider", "model"
  ], "Subject attestation");
  if (diagnostic.schemaVersion !== 1) throw new Error("Subject attestation schemaVersion must equal 1.");
  const platform = diagnostic.platform;
  if (platform !== "win32" && platform !== "linux") throw new Error("Subject attestation platform is unsupported.");
  const value = {
    productDigest: digestField(diagnostic.productDigest, "Subject attestation productDigest"),
    buildArtifactDigest: digestField(diagnostic.buildArtifactDigest, "Subject attestation buildArtifactDigest"),
    configurationDigest: digestField(diagnostic.configurationDigest, "Subject attestation configurationDigest"),
    environmentDigest: digestField(diagnostic.environmentDigest, "Subject attestation environmentDigest"),
    platform,
    surface: codeField(diagnostic.surface, "Subject attestation surface"),
    provider: codeField(diagnostic.provider, "Subject attestation provider"),
    model: modelField(diagnostic.model, "Subject attestation model")
  };
  return { value, attestationDigest: sha256(canonicalJson(value)) };
}

function durableSubjectAttestation(events) {
  const matching = events.filter((event) => object(object(event.payload).data).source
    === OPTIMIZER_SUBJECT_ATTESTATION_SOURCE_V1);
  if (matching.length === 0) return { status: "unavailable", reason: "durable_subject_attestation_missing" };
  const parsed = [];
  try {
    for (const event of matching) parsed.push(parseSubjectAttestationEvent(event));
  } catch {
    return { status: "unavailable", reason: "durable_subject_attestation_invalid" };
  }
  const unique = new Map(parsed.map((item) => [item.attestationDigest, item]));
  if (unique.size !== 1) return { status: "unavailable", reason: "durable_subject_attestation_conflict" };
  return { status: "attested", ...unique.values().next().value };
}

function identityFromPayload(payload, providerKey, modelKey) {
  const provider = payload[providerKey];
  const model = payload[modelKey];
  return typeof provider === "string" && typeof model === "string" ? { provider, model } : null;
}

function uniqueIdentity(items) {
  const unique = new Map(items.filter(Boolean).map((item) => [`${item.provider}\0${item.model}`, item]));
  return unique.size === 1 ? { status: "available", value: unique.values().next().value }
    : unique.size > 1 ? { status: "conflict" } : { status: "unavailable" };
}

function durableModelIdentity(events) {
  const started = uniqueIdentity(events.filter((event) => event.type === "model.started" && event.authority === "runtime")
    .map((event) => identityFromPayload(object(event.payload), "provider", "model")));
  const measured = uniqueIdentity(events.filter((event) => event.type === "usage.recorded" && event.authority === "runtime"
    && object(event.payload).role === "orchestrator")
    .map((event) => identityFromPayload(object(event.payload), "providerId", "modelId")));
  if (measured.status === "conflict" || (measured.status !== "available" && started.status === "conflict")) {
    return { status: "conflict" };
  }
  if (measured.status === "available" && started.status === "available"
    && (measured.value.provider !== started.value.provider || measured.value.model !== started.value.model)) {
    return { status: "conflict" };
  }
  return measured.status === "available" ? measured : started;
}

function verifyAssertion(name, asserted, actual, unavailable) {
  if (asserted === undefined) return;
  if (actual === unavailable) throw new Error(`Cannot verify --${name}; durable ${name} provenance is unavailable.`);
  if (asserted !== actual) throw new Error(`--${name} does not match durable session provenance.`);
}

function attestedIdentity(attestation) {
  if (attestation.status !== "attested") return null;
  return { provider: attestation.value.provider, model: attestation.value.model };
}

function modelIdentityConflicts(modelIdentity, attested) {
  if (modelIdentity.status === "conflict") return true;
  if (modelIdentity.status !== "available" || !attested) return false;
  return modelIdentity.value.provider !== attested.provider || modelIdentity.value.model !== attested.model;
}

function resolvedIdentity(modelIdentity, attested, conflict) {
  if (conflict) return null;
  return modelIdentity.status === "available" ? modelIdentity.value : attested;
}

function attestedSubjectMetadata(attestation, identity) {
  return {
    ...attestation.value,
    provider: identity?.provider ?? attestation.value.provider,
    model: identity?.model ?? attestation.value.model,
    provenance: {
      status: "attested", reason: null, attestationDigest: attestation.attestationDigest,
      buildArtifactDigest: attestation.value.buildArtifactDigest
    }
  };
}

function unavailableSubjectMetadata(attestation, identity, modelConflict) {
  return {
    productDigest: DEFAULT_DIGEST,
    configurationDigest: DEFAULT_DIGEST,
    environmentDigest: DEFAULT_DIGEST,
    platform: "unavailable",
    surface: "unknown_surface",
    provider: identity?.provider ?? "unknown_provider",
    model: identity?.model ?? "unavailable",
    provenance: {
      status: "unavailable",
      reason: modelConflict ? "durable_model_identity_conflict" : attestation.reason,
      attestationDigest: null,
      buildArtifactDigest: null
    }
  };
}

function untrustedExternalSubjectMetadata(metadata) {
  return unavailableSubjectMetadata(
    { reason: "external_evidence_untrusted" },
    { provider: metadata.provider, model: metadata.model },
    false
  );
}

export function deriveSubjectMetadataFromEvents(events, assertions = {}) {
  const attestation = durableSubjectAttestation(events);
  const modelIdentity = durableModelIdentity(events);
  const durableIdentity = attestedIdentity(attestation);
  const modelConflict = modelIdentityConflicts(modelIdentity, durableIdentity);
  const identity = resolvedIdentity(modelIdentity, durableIdentity, modelConflict);
  const metadata = attestation.status === "attested" && !modelConflict
    ? attestedSubjectMetadata(attestation, identity)
    : unavailableSubjectMetadata(attestation, identity, modelConflict);
  verifyAssertion("provider", assertions.provider, metadata.provider, "unknown_provider");
  verifyAssertion("model", assertions.model, metadata.model, "unavailable");
  verifyAssertion("surface", assertions.surface, metadata.surface, "unknown_surface");
  return metadata;
}

function rejectGenericEvaluatorKeys(value, location = "stream") {
  if (typeof value === "string") {
    if (GENERIC_EVALUATOR_CONTENT.test(value)) {
      throw new Error(`${location} contains evaluator-only identity or feedback content.`);
    }
    return;
  }
  if (Array.isArray(value)) return value.forEach((item, index) => rejectGenericEvaluatorKeys(item, `${location}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (GENERIC_EVALUATOR_KEY.test(key)) {
      throw new Error(`${location}.${key} is evaluator-only and cannot enter generic conformance ingestion.`);
    }
    rejectGenericEvaluatorKeys(item, `${location}.${key}`);
  }
}

export function assertGenericConformanceEventStreamV1(input) {
  const value = object(input);
  exactKeys(value, ["schemaVersion", "kind", "records"], "Generic conformance event stream");
  if (value.schemaVersion !== 1 || value.kind !== "sigma.generic-conformance-event-stream") {
    throw new Error("Unsupported generic conformance event stream schema.");
  }
  if (!Array.isArray(value.records) || value.records.length < 1) {
    throw new Error("Generic conformance event stream records must not be empty.");
  }
  const events = value.records.map((entry, index) => {
    const record = object(entry);
    exactKeys(record, ["checksum", "event"], `Generic conformance record ${index}`);
    if (typeof record.checksum !== "string" || !HEX_64.test(record.checksum)
      || record.checksum !== sha256(JSON.stringify(record.event))) {
      throw new Error(`Generic conformance record ${index} checksum mismatch.`);
    }
    return record.event;
  });
  assertV5EventStream(events);
  rejectGenericEvaluatorKeys(events);
  return { value, events };
}

async function readStoredObservations(directory) {
  const names = await readdir(directory).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const observations = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const parsed = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    observations.push(assertOptimizerObservationV1(parsed));
  }
  return observations;
}

async function writeObservations(directory, observations) {
  await mkdir(directory, { recursive: true });
  for (const observation of observations) {
    const target = path.join(directory, `${observation.observationId}.json`);
    await writeFile(target, `${JSON.stringify(observation, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch((error) => {
      if (error?.code !== "EEXIST") throw error;
    });
  }
}

async function writeClusterCard(directory, card) {
  const target = path.join(directory, `${card.clusterId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(card, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function archiveSession(stored, workspace, vaultRoot) {
  return archiveEvaluationEvidence({
    workspace,
    sourceKind: "real_session",
    createdAt: stored.meta.updatedAt,
    payload: { meta: stored.meta, events: stored.events }
  }, { vaultRoot });
}

async function archiveConformanceStream(stream, workspace, vaultRoot) {
  const last = stream.events.at(-1);
  return archiveEvaluationEvidence({
    workspace,
    sourceKind: "generic_conformance",
    createdAt: last.occurredAt,
    payload: stream.value
  }, { vaultRoot });
}

async function readConformanceStream(filePath) {
  return assertGenericConformanceEventStreamV1(JSON.parse(await readFile(filePath, "utf8")));
}

async function selectedSessionIds(stateRoot, options) {
  if (options.includeRealSessions === false) return [];
  if (options.sessionIds.length > 0) return [...new Set(options.sessionIds)];
  const available = await listV5Sessions(stateRoot);
  return available.slice(0, options.latest).map((item) => item.sessionId);
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertNoLinkedAncestor(target) {
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
    if (info.isSymbolicLink()) throw new Error("Optimizer state paths may not traverse symlinks or junctions.");
  }
}

async function validateOptimizerStorage(
  workspace, stateRoot, repositoryStateRoot, output, vaultRoot, conformanceEventPaths
) {
  const canonicalWorkspace = await realpath(workspace);
  for (const statePath of [stateRoot, repositoryStateRoot]) {
    if (inside(canonicalWorkspace, statePath) || inside(statePath, canonicalWorkspace)) {
      throw new Error("Optimizer state and EvaluationVault must be outside the product workspace.");
    }
  }
  if (inside(stateRoot, repositoryStateRoot) || inside(repositoryStateRoot, stateRoot)) {
    throw new Error("Raw workspace evidence and shared repository optimizer state must use separate trees.");
  }
  if (!inside(stateRoot, vaultRoot)) {
    throw new Error("EvaluationVault must stay inside the workspace-specific state root.");
  }
  if (!inside(repositoryStateRoot, output)) {
    throw new Error("Sanitized optimizer output must stay inside the shared repository state root.");
  }
  if (inside(output, vaultRoot) || inside(vaultRoot, output)) {
    throw new Error("Sanitized optimizer output and EvaluationVault must be separate trees.");
  }
  for (const sourcePath of conformanceEventPaths) {
    const canonicalSource = await realpath(sourcePath);
    if (inside(canonicalWorkspace, canonicalSource) || inside(output, canonicalSource)
      || inside(vaultRoot, canonicalSource)) {
      throw new Error("Generic conformance event input must come from an external trusted evidence tree.");
    }
  }
  await Promise.all([stateRoot, repositoryStateRoot, output, vaultRoot].map(assertNoLinkedAncestor));
  await Promise.all(conformanceEventPaths.map(assertNoLinkedAncestor));
}

export async function collectOptimizerObservations(options, dependencies = {}) {
  const workspace = path.resolve(options.workspace ?? ".");
  const stateRoot = path.resolve(options.stateRoot ?? await resolveWorkspaceStateRoot(workspace));
  const vaultRoot = path.resolve(options.vaultRoot ?? path.join(stateRoot, "EvaluationVault"));
  const repositoryStateRoot = path.resolve(
    dependencies.repositoryStateRoot ?? await resolveOptimizationRepositoryStateRoot(workspace)
  );
  const output = path.resolve(
    options.output ?? path.join(repositoryStateRoot, "optimizer", "observations")
  );
  const conformanceEventPaths = (options.conformanceEventPaths ?? []).map((item) => path.resolve(item));
  await validateOptimizerStorage(
    workspace, stateRoot, repositoryStateRoot, output, vaultRoot, conformanceEventPaths
  );
  const sessionIds = await selectedSessionIds(stateRoot, options);
  const created = [];
  const archives = [];
  for (const sessionId of sessionIds) {
    const stored = await readV5Session(stateRoot, sessionId);
    archives.push(await archiveSession(stored, workspace, vaultRoot));
    const metrics = reduceAgentEvents(stored.events, { sessionId });
    created.push(...createOptimizerObservations(metrics, {
      sourceKind: "real_session",
      sourceDigest: sha256(canonicalJson({ meta: stored.meta, events: stored.events })),
      observedAt: stored.meta.updatedAt,
      ...deriveSubjectMetadataFromEvents(stored.events, options)
    }));
  }
  for (const sourcePath of conformanceEventPaths) {
    const stream = await readConformanceStream(sourcePath);
    archives.push(await archiveConformanceStream(stream, workspace, vaultRoot));
    const metrics = reduceAgentEvents(stream.events);
    const derived = deriveSubjectMetadataFromEvents(stream.events, options);
    const trusted = typeof dependencies.verifyGenericConformanceStream === "function"
      && await dependencies.verifyGenericConformanceStream({
        sourcePath,
        sourceDigest: sha256(canonicalJson(stream.value)),
        events: structuredClone(stream.events)
      }) === true;
    created.push(...createOptimizerObservations(metrics, {
      sourceKind: "generic_conformance",
      sourceDigest: sha256(canonicalJson(stream.value)),
      observedAt: stream.events.at(-1).occurredAt,
      ...(trusted ? derived : untrustedExternalSubjectMetadata(derived))
    }));
  }
  await writeObservations(output, created);
  const all = await readStoredObservations(output);
  const registry = path.join(repositoryStateRoot, "optimizer", "experiments");
  const experiments = await readRegisteredOptimizationExperiments(registry);
  const cardOptions = dependencies.asOf === undefined ? undefined : { asOf: dependencies.asOf };
  const cards = createOptimizerClusterCards(all, experiments, cardOptions);
  const cardDirectory = path.join(repositoryStateRoot, "optimizer", "clusters");
  await mkdir(cardDirectory, { recursive: true });
  for (const card of cards) await writeClusterCard(cardDirectory, card);
  return {
    workspace, stateRoot, repositoryStateRoot, vaultRoot,
    observationDirectory: output, cardDirectory, observations: created, cards, archives
  };
}

function help() {
  return [
    "Usage: node scripts/eval/optimizer-observe.mjs [options]",
    "  --workspace <path>   Sigma workspace (default: .)",
    "  --state-root <path>  Explicit V5 state root",
    "  --latest <n>         Inspect latest N real sessions (default: 10)",
    "  --session <id>       Select an exact real session; repeatable",
    "  --conformance-events <path>  Add a checksummed generic V5 event stream; repeatable",
    "  --generic-only       Skip real-session state when ingesting generic conformance events",
    "  --provider/--model/--surface  Assert (never supply) durable subject identity",
    "  --output <path>      Sanitized directory inside shared repository state",
    "  --vault-root <path>  Owner-only EvaluationVault override"
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptimizerObserveArgs(argv);
  if (options.help) {
    process.stdout.write(`${help()}\n`);
    return null;
  }
  const result = await collectOptimizerObservations(options);
  process.stdout.write(`${JSON.stringify({
    observations: result.observations.length,
    eligibleClusters: result.cards.filter((item) => item.eligibility.eligible).length,
    observationDirectory: result.observationDirectory,
    cardDirectory: result.cardDirectory,
    vaultRoot: result.vaultRoot
  }, null, 2)}\n`);
  return result;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
