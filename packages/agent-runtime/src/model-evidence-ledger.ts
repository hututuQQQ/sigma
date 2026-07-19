import type { ContextItem } from "agent-protocol";
import { approximateTokens } from "agent-context";
import {
  projectCapabilitiesForPath,
  type ProjectValidationCapabilities
} from "agent-context";
import {
  currentFrontierReview,
  frontierValidationReadiness,
  type FrontierValidationReadiness
} from "./mutation-evidence.js";
import type { RuntimeSession } from "./types.js";
import { assuranceRequirement } from "./assurance-engine.js";
import {
  boundedProjectionV1,
  projectionMetadata,
  type BoundedProjectionV1
} from "./bounded-projection.js";

// Several independent projections can appear in one completion ledger. A
// smaller per-list display budget keeps their aggregate below 32 KiB while
// the shared projection primitive still enforces the public 16 KiB ceiling.
const LEDGER_LIST_MAX_BYTES = 3 * 1024;

function findingText(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length <= 1_000 ? rendered : `${rendered.slice(0, 1_000)}…`;
}

function projected(
  values: readonly string[],
  evidenceRef: string
): BoundedProjectionV1 {
  return boundedProjectionV1(values, { evidenceRef, maxBytes: LEDGER_LIST_MAX_BYTES });
}

function projectionLines(
  label: string,
  values: readonly string[],
  evidenceRef: string,
  empty = "none"
): string[] {
  const view = projected(values, evidenceRef);
  return [
    `- ${label} projection: ${projectionMetadata(view)}`,
    `  - visible entries: ${view.entries.length > 0 ? view.entries.join(", ") : empty}`
  ];
}

function capabilityProjects(
  session: RuntimeSession,
  changed: readonly string[]
): ProjectValidationCapabilities[] {
  const capabilities = session.interaction.validationCapabilities;
  const current = capabilities?.stateDigest === session.durable.state.mutationFrontier.currentStateDigest;
  if (!current || !capabilities) return [];
  return [...new Map(changed.map((item) => {
    const project = projectCapabilitiesForPath(capabilities, item);
    return [project?.projectId ?? ".", project];
  })).values()].filter((item): item is ProjectValidationCapabilities => item !== undefined);
}

function capabilityLines(session: RuntimeSession, changed: readonly string[]): string[] {
  const capabilities = session.interaction.validationCapabilities;
  const current = capabilities?.stateDigest === session.durable.state.mutationFrontier.currentStateDigest;
  const projects = capabilityProjects(session, changed);
  const fallbackPaths = current && capabilities?.complete
    ? changed.filter((item) => /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|c|cc|cpp|h|hpp)$/iu.test(item)
      && projectCapabilitiesForPath(capabilities, item)?.unit !== true)
    : [];
  const commandFamilies = [...new Set(projects.flatMap((item) => item.commandFamilies))].sort();
  const requirement = assuranceRequirement(session);
  const staticFallback = requirement.requiredClaims.includes("syntax")
    || requirement.requiredClaims.includes("typecheck");
  const reference = `runtime:validation-capabilities:${session.durable.runId}:${capabilities?.stateDigest ?? "unavailable"}`;
  return [
    `- validation capability profile: ${!current ? "not derived" : capabilities?.complete ? "complete" : "incomplete (strict requirements retained)"}`,
    ...projectionLines("affected projects", projects.map((project) =>
      `${project.projectId}: unit=${project.unit ? "available" : "unavailable"}; static=${project.staticClaims.join(", ") || "none"}`), `${reference}:projects`),
    ...projectionLines(
      `capability fallback paths (${staticFallback ? "acceptance plus available static validation" : "substantive acceptance"})`,
      fallbackPaths,
      `${reference}:fallback-paths`
    ),
    ...projectionLines("generally available validation command families", commandFamilies, `${reference}:command-families`)
  ];
}

function validationLines(
  session: RuntimeSession,
  validation: FrontierValidationReadiness
): string[] {
  const observedClaims = [...new Set(validation.validations
    .filter((item) => item.status === "passed")
    .map((item) => item.data.claim?.kind ?? "untyped"))].sort();
  const observedCoverage = validation.validations
    .filter((item) => item.status === "passed")
    .flatMap((item) => {
      const claim = item.data.claim?.kind ?? "untyped";
      return item.data.coveredPaths.length > 0
        ? item.data.coveredPaths.map((path) => `${claim}: ${path}`)
        : [`${claim}: no assurance coverage`];
    });
  const reference = `runtime:validation-frontier:${session.durable.runId}:${session.durable.state.mutationFrontier.revision}`;
  return [
    ...projectionLines("recognized passed claims", observedClaims, `${reference}:passed-claims`),
    ...projectionLines("validation claims still missing", validation.missingClaims, `${reference}:missing-claims`),
    ...projectionLines("validation still missing or failed paths", validation.missingPaths, `${reference}:missing-paths`),
    ...projectionLines("recognized validation coverage", observedCoverage, `${reference}:coverage`),
    ...(validation.latestFailed
      ? projectionLines("latest failed validation", [findingText(validation.latestFailed.summary)], `${reference}:latest-failure`)
      : [])
  ];
}

function reviewLines(session: RuntimeSession): string[] {
  const review = currentFrontierReview(session);
  const reviewMode = session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
  const reference = `runtime:frontier-review:${session.durable.runId}:${session.durable.state.mutationFrontier.revision}`;
  return [
    `- independent review mode: ${reviewMode}`,
    ...(review ? [
      `- latest review: ${review.data.verdict} (${review.status})`,
      ...projectionLines("review findings", review.data.findings.map(findingText), `${reference}:findings`)
    ] : [])
  ];
}

/** Model-visible V5 completion state. Internal evidence and checkpoint IDs are
 * deliberately absent: the runtime owns their association and final handoff. */
export function evidenceLedger(session: RuntimeSession): ContextItem {
  const frontier = session.durable.state.mutationFrontier;
  const validation = frontierValidationReadiness(session);
  const requirement = assuranceRequirement(session);
  const frontierReference = `runtime:mutation-frontier:${session.durable.runId}:${frontier.revision}`;
  const lines = [
    "Completion status (runtime-owned; do not supply evidence IDs):",
    `- final mutation revision: ${frontier.revision}`,
    ...projectionLines("net changed paths", frontier.changedPaths, `${frontierReference}:changed-paths`),
    `- semantic validation: ${frontier.changedPaths.length === 0 ? "not required" : validation.ready ? "passed for every net changed path" : "blocking"}`,
    ...projectionLines("required validation claims", requirement.requiredClaims, `${frontierReference}:required-claims`),
    ...capabilityLines(session, frontier.changedPaths),
    ...validationLines(session, validation),
    ...reviewLines(session),
    "When work is complete, stop naturally with the final user-facing summary. The runtime completion coordinator will evaluate assurance and review gates. If validation cannot be repaired after concrete attempts, call report_blocked. Use request_user_input only for a real user decision."
  ];
  const content = lines.join("\n");
  return {
    id: `runtime:completion-status:${session.durable.runId}:${frontier.revision}:${session.durable.state.evidence.length}`,
    authority: "runtime",
    provenance: "completion_status",
    content,
    tokenCount: approximateTokens(content),
    priority: 9_900
  };
}
