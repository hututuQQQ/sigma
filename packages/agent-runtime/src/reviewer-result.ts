import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  ModelResponse,
  ReviewEvidence
} from "agent-protocol";
import type {
  ReviewerInput,
  ReviewerToolCheck
} from "./reviewer-contracts.js";
import { reviewerResponseObject } from "./reviewer-response-object.js";

export function isActionableErrorFinding(finding: JsonValue): boolean {
  if (finding && typeof finding === "object" && !Array.isArray(finding)
    && Object.hasOwn(finding, "actionable") && Object.hasOwn(finding, "severity")) {
    const structured = finding as Record<string, JsonValue>;
    return structured.actionable === true && structured.severity === "error";
  }
  return true;
}

interface ParsedReviewResult {
  findings: JsonValue[];
  protocolFailure: boolean;
  verdict: "approved" | "changes_requested" | "blocked";
  criteria: Array<{
    criterion: string;
    status: "satisfied" | "failed" | "unverified";
    evidence: string[];
    summary?: string;
    coverage?: {
      scope: "complete" | "partial" | "unavailable";
      rationale: string;
      checkedClaims: string[];
      limitations: string[];
      falsificationAttempt: string;
    };
  }>;
  requiredValidations: Array<{
    purpose: string;
    coveredPaths?: string[];
    claimKind?: "probe" | "syntax" | "typecheck" | "lint" | "unit" | "integration" | "acceptance";
    commandSuggestion?: string;
  }>;
}

type CriterionCoverage = NonNullable<
  ParsedReviewResult["criteria"][number]["coverage"]
>;

function optionalEvidenceIds(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((entry) =>
    typeof entry === "string" && entry.trim().length > 0)
    ? value as string[]
    : undefined;
}

function nonEmptyStrings(
  value: unknown,
  minimum: number,
  maximum: number
): string[] | undefined {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
    ? value as string[]
    : undefined;
}

function parsedCoverage(
  value: unknown,
  _verificationPolicy: ReviewerInput["verificationPolicy"]
): CriterionCoverage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const checkedClaims = nonEmptyStrings(item.checkedClaims, 1, 32);
  const limitations = nonEmptyStrings(item.limitations, 0, 16);
  const declaredScope = String(item.scope);
  if (!["complete", "partial", "unavailable"].includes(declaredScope)
    || typeof item.rationale !== "string" || item.rationale.trim().length === 0
    || typeof item.falsificationAttempt !== "string"
    || item.falsificationAttempt.trim().length === 0
    || !checkedClaims || !limitations) return undefined;
  return {
    scope: declaredScope === "complete" && limitations.length > 0
      ? "partial"
      : declaredScope as CriterionCoverage["scope"],
    rationale: item.rationale,
    checkedClaims,
    limitations,
    falsificationAttempt: item.falsificationAttempt
  };
}

function criterionReference(
  input: ReviewerInput,
  item: Record<string, unknown>
): { criterion: string; evidence: string[] } | undefined {
  const indexedCriteria = (input.acceptanceCriteria?.length ?? 0) > 0
    ? input.acceptanceCriteria!
    : [input.goal];
  if (Number.isInteger(item.criterionIndex)) {
    const index = Number(item.criterionIndex);
    const criterion = indexedCriteria[index];
    const evidence = optionalEvidenceIds(item.evidenceIds);
    return index >= 0 && typeof criterion === "string"
      && evidence !== undefined
      ? { criterion, evidence }
      : undefined;
  }
  return undefined;
}

function parsedCriterion(
  input: ReviewerInput,
  raw: unknown
): ParsedReviewResult["criteria"][number] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const reference = criterionReference(input, item);
  const coverage = parsedCoverage(
    item.coverage,
    input.verificationPolicy ?? "standard"
  );
  if (!reference || !["satisfied", "failed", "unverified"].includes(String(item.status))
    || !coverage
    || (item.summary !== undefined && typeof item.summary !== "string")) {
    return undefined;
  }
  const declaredStatus = item.status as "satisfied" | "failed" | "unverified";
  return {
    ...reference,
    status: declaredStatus === "satisfied" && coverage.scope !== "complete"
      ? "unverified"
      : declaredStatus,
    coverage,
    ...(typeof item.summary === "string" ? { summary: item.summary } : {})
  };
}

function parsedCriteria(
  input: ReviewerInput,
  value: unknown
): ParsedReviewResult["criteria"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: ParsedReviewResult["criteria"] = [];
  for (const raw of value) {
    const parsed = parsedCriterion(input, raw);
    if (!parsed) return undefined;
    result.push(parsed);
  }
  return result;
}

function validCoveredPaths(value: unknown): boolean {
  return value === undefined || Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

function validClaimKind(value: unknown): boolean {
  return value === undefined
    || ["probe", "syntax", "typecheck", "lint", "unit", "integration", "acceptance"]
      .includes(String(value));
}

function parsedRequiredValidation(
  raw: unknown
): ParsedReviewResult["requiredValidations"][number] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  if (typeof item.purpose !== "string" || item.purpose.trim().length === 0
    || !validCoveredPaths(item.coveredPaths)
    || !validClaimKind(item.claimKind)
    || item.commandSuggestion !== undefined
      && typeof item.commandSuggestion !== "string") return undefined;
  return {
    purpose: item.purpose,
    ...(Array.isArray(item.coveredPaths)
      ? { coveredPaths: item.coveredPaths as string[] }
      : {}),
    ...(typeof item.claimKind === "string"
      ? {
          claimKind: item.claimKind as NonNullable<
            ParsedReviewResult["requiredValidations"][number]["claimKind"]
          >
        }
      : {}),
    ...(typeof item.commandSuggestion === "string"
      ? { commandSuggestion: item.commandSuggestion }
      : {})
  };
}

function parsedRequiredValidations(
  value: unknown
): ParsedReviewResult["requiredValidations"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: ParsedReviewResult["requiredValidations"] = [];
  for (const raw of value) {
    const parsed = parsedRequiredValidation(raw);
    if (!parsed) return undefined;
    result.push(parsed);
  }
  return result;
}

function validReviewVerdict(value: unknown): boolean {
  return value === "approved"
    || value === "changes_requested"
    || value === "blocked"
    || value === "validation_required";
}

function reviewRequirements(input: ReviewerInput): string[] {
  return (input.acceptanceCriteria?.length ?? 0) > 0
    ? [...input.acceptanceCriteria!]
    : [input.goal];
}

function criteriaDeclareAllAcceptance(
  input: ReviewerInput,
  criteria: ParsedReviewResult["criteria"]
): boolean {
  return reviewRequirements(input).every((criterion) =>
    criteria.some((item) => item.criterion === criterion));
}

function structurallyIncompleteReview(input: ReviewerInput, values: {
  parsed: Record<string, unknown> | null;
  rawFindings: unknown[] | undefined;
  criteria: ParsedReviewResult["criteria"] | undefined;
  requiredValidations: ParsedReviewResult["requiredValidations"] | undefined;
}): boolean {
  if (!values.parsed || !validReviewVerdict(values.parsed.verdict)
    || values.rawFindings === undefined) return true;
  if (!values.criteria || !values.requiredValidations) return true;
  return !criteriaDeclareAllAcceptance(input, values.criteria);
}

function normalizedReviewFindings(rawFindings: unknown[] | undefined): JsonValue[] {
  return (rawFindings ?? []).filter((item): item is JsonValue => item === null
    || ["string", "number", "boolean", "object"].includes(typeof item));
}

function normalizedReviewVerdict(input: {
  rawVerdict?: unknown;
  protocolFailure: boolean;
  structurallyIncomplete: boolean;
  findings: readonly JsonValue[];
  criteria: ParsedReviewResult["criteria"];
  requiredValidations: ParsedReviewResult["requiredValidations"];
}): ParsedReviewResult["verdict"] {
  const failed = input.criteria.some((item) => item.status === "failed");
  if (input.protocolFailure) return "blocked";
  if (input.structurallyIncomplete) return "changes_requested";
  if (input.rawVerdict === "blocked") return "blocked";
  if (input.rawVerdict === "changes_requested"
    || input.rawVerdict === "validation_required"
    || input.findings.some(isActionableErrorFinding) || failed) {
    return "changes_requested";
  }
  const unverified = input.criteria.some((item) => item.status === "unverified")
    || input.requiredValidations.length > 0;
  return unverified ? "changes_requested" : "approved";
}

function parsedReviewResult(
  input: ReviewerInput,
  response: ModelResponse
): ParsedReviewResult {
  const parsed = reviewerResponseObject(response);
  const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : undefined;
  const criteria = parsedCriteria(input, parsed?.criteria);
  const requiredValidations = parsedRequiredValidations(parsed?.requiredValidations);
  const protocolFailure = parsed === null;
  const structurallyIncomplete = structurallyIncompleteReview(input, {
    parsed,
    rawFindings,
    criteria,
    requiredValidations
  });
  const findings = normalizedReviewFindings(rawFindings);
  const parsedByCriterion = new Map(
    (criteria ?? []).map((item) => [item.criterion, item])
  );
  const normalizedCriteria = reviewRequirements(input).map((criterion) =>
    parsedByCriterion.get(criterion) ?? {
      criterion,
      status: "unverified" as const,
      evidence: [],
      coverage: {
        scope: "unavailable" as const,
        rationale:
          "The reviewer response omitted a valid structured assessment for this requirement.",
        checkedClaims: [criterion],
        limitations: ["Structured coverage was unavailable."],
        falsificationAttempt:
          "No valid structured falsification attempt was submitted."
      },
      summary:
        "The independent reviewer must reassess this requirement with a valid structured verdict."
    });
  const normalizedRequired = [...(requiredValidations ?? [])];
  const verdict = normalizedReviewVerdict({
    rawVerdict: parsed?.verdict,
    protocolFailure,
    structurallyIncomplete,
    findings,
    criteria: normalizedCriteria,
    requiredValidations: normalizedRequired
  });
  return {
    findings,
    protocolFailure,
    verdict,
    criteria: normalizedCriteria,
    requiredValidations: normalizedRequired
  };
}

export function reviewEvidence(
  input: ReviewerInput,
  reviewerId: string,
  response: ModelResponse,
  checks: readonly ReviewerToolCheck[] = []
): ReviewEvidence {
  const result = parsedReviewResult(input, response);
  const runtimeEvidenceIds = [...new Set([
    ...checks.flatMap((item) => item.evidenceIds),
    ...input.validations.map((item) => item.evidenceId),
    ...input.workspaceDeltas.map((item) => item.evidenceId),
    ...(input.environmentMutations ?? [])
      .filter((item) => item.status === "passed")
      .map((item) => item.evidenceId)
  ])];
  const criteria = result.criteria.map((item) => ({
    ...item,
    evidence: item.evidence.length > 0
      ? [...new Set(item.evidence)]
      : [...runtimeEvidenceIds]
  }));
  return {
    evidenceId: randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId,
    kind: "review",
    status: result.verdict === "approved" ? "passed" : "failed",
    createdAt: new Date().toISOString(),
    producer: { authority: "runtime", id: reviewerId },
    summary: result.protocolFailure
      ? "Independent reviewer returned an invalid protocol response."
      : result.verdict === "approved"
        ? "Independent reviewer approved the change."
        : "Independent reviewer requested changes.",
    data: {
      schemaVersion: 1,
      reviewerId,
      verdict: result.verdict,
      findings: result.findings,
      criteria,
      requiredValidations: result.requiredValidations,
      frontierRevision: input.frontierRevision,
      stateDigest: input.stateDigest,
      reviewBasisDigest: input.reviewBasisDigest,
      ...(input.completionCandidateDigest
        ? { completionCandidateDigest: input.completionCandidateDigest }
        : {}),
      validationEvidenceIds: input.validations.map((item) => item.evidenceId),
      durableEvidenceIds: [...new Set([
        ...runtimeEvidenceIds,
        ...criteria.flatMap((item) => item.evidence)
      ])],
      actualChecks: checks.map((item) => ({
        toolName: item.toolName,
        evidenceIds: [...item.evidenceIds],
        summary: item.summary
      })),
      ...(result.protocolFailure
        ? {
            failureCode: "review_protocol_invalid" as const
          }
        : {})
    }
  };
}
