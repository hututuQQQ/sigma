import { createHash } from "node:crypto";
import { SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1, type JsonValue } from "agent-protocol";
import type { RuntimeEventEmitter } from "./runtime-event-emitter.js";
import type { RuntimeSession } from "./types.js";

export const SUBJECT_ATTESTATION_SOURCE_V1 = SUBJECT_ATTESTATION_EVIDENCE_SOURCE_V1;
export const SUBJECT_ATTESTOR_ID_V1 = "subject-attestor";

export interface SubjectProductAttestationV1 {
  schemaVersion: 1;
  productDigest: string;
  buildArtifactDigest: string;
  environmentDigest: string;
  platform: "win32" | "linux";
}

export interface SubjectAttestationContextV1 extends SubjectProductAttestationV1 {
  configurationDigest: string;
  surface: string;
}

export interface SubjectAttestationV1 extends SubjectAttestationContextV1 {
  provider: string;
  model: string;
}

const HEX_64 = /^[a-f0-9]{64}$/u;
const SAFE_CODE = /^[a-z][a-z0-9_]{1,95}$/u;
const UNAVAILABLE_DIGEST = createHash("sha256").update("unavailable", "utf8").digest("hex");

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !HEX_64.test(value) || value === UNAVAILABLE_DIGEST) {
    throw new Error(`${label} must be an available lowercase SHA-256 digest.`);
  }
  return value;
}

function code(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_CODE.test(value)) {
    throw new Error(`${label} must be a stable code.`);
  }
  return value;
}

function model(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value.includes("\0")) {
    throw new Error("Subject attestation model must be a non-empty identity of at most 128 characters.");
  }
  return value;
}

function platform(value: unknown): "win32" | "linux" {
  if (value !== "win32" && value !== "linux") {
    throw new Error("Subject attestation platform must be win32 or linux.");
  }
  return value;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function digestSubjectConfigurationV1(configuration: JsonValue): string {
  return createHash("sha256")
    .update(canonical({ schemaVersion: 1, configuration }), "utf8")
    .digest("hex");
}

export function assertSubjectProductAttestationV1(input: unknown): SubjectProductAttestationV1 {
  const value = record(input, "Subject product attestation");
  exactKeys(value, [
    "schemaVersion", "productDigest", "buildArtifactDigest", "environmentDigest", "platform"
  ], "Subject product attestation");
  if (value.schemaVersion !== 1) throw new Error("Subject product attestation schemaVersion must equal 1.");
  return {
    schemaVersion: 1,
    productDigest: digest(value.productDigest, "Subject product attestation productDigest"),
    buildArtifactDigest: digest(value.buildArtifactDigest, "Subject product attestation buildArtifactDigest"),
    environmentDigest: digest(value.environmentDigest, "Subject product attestation environmentDigest"),
    platform: platform(value.platform)
  };
}

export function assertSubjectAttestationContextV1(input: unknown): SubjectAttestationContextV1 {
  const value = record(input, "Subject attestation context");
  exactKeys(value, [
    "schemaVersion", "productDigest", "buildArtifactDigest", "environmentDigest", "platform",
    "configurationDigest", "surface"
  ], "Subject attestation context");
  const product = assertSubjectProductAttestationV1({
    schemaVersion: value.schemaVersion,
    productDigest: value.productDigest,
    buildArtifactDigest: value.buildArtifactDigest,
    environmentDigest: value.environmentDigest,
    platform: value.platform
  });
  return {
    ...product,
    configurationDigest: digest(value.configurationDigest, "Subject attestation configurationDigest"),
    surface: code(value.surface, "Subject attestation surface")
  };
}

export function createSubjectAttestationContextV1(
  product: unknown,
  configuration: JsonValue,
  surface: string,
  observedPlatform: NodeJS.Platform
): SubjectAttestationContextV1 {
  const trusted = assertSubjectProductAttestationV1(product);
  if (trusted.platform !== observedPlatform) {
    throw new Error("Subject product attestation platform does not match the runtime platform.");
  }
  return {
    ...trusted,
    configurationDigest: digestSubjectConfigurationV1(configuration),
    surface: code(surface, "Subject attestation surface")
  };
}

export function subjectAttestationForSession(
  context: SubjectAttestationContextV1,
  session: RuntimeSession
): SubjectAttestationV1 {
  const trusted = assertSubjectAttestationContextV1(context);
  return {
    ...trusted,
    provider: code(session.services.gateway.provider, "Subject attestation provider"),
    model: model(session.services.gateway.model)
  };
}

export async function emitSubjectAttestationV1(
  session: RuntimeSession,
  context: SubjectAttestationContextV1 | undefined,
  emit: RuntimeEventEmitter
): Promise<void> {
  if (!context || session.identity.parentSessionId) return;
  const diagnostic = subjectAttestationForSession(context, session);
  await emit(session, "evidence.recorded", "runtime", {
    evidenceId: `subject-attestation:${session.durable.runId}`,
    sessionId: session.identity.sessionId,
    runId: session.durable.runId,
    kind: "diagnostic",
    status: "informational",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: SUBJECT_ATTESTOR_ID_V1 },
    summary: "Subject build identity was frozen before execution.",
    data: { source: SUBJECT_ATTESTATION_SOURCE_V1, diagnostic: { ...diagnostic } }
  });
}
