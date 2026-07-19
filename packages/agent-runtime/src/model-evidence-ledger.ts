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

function findingText(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return rendered.length <= 1_000 ? rendered : `${rendered.slice(0, 1_000)}…`;
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
  return [
    `- validation capability profile: ${!current ? "not derived" : capabilities?.complete ? "complete" : "incomplete (strict requirements retained)"}`,
    ...projects.map((project) => `  - project ${project.projectId}: unit=${project.unit ? "available" : "unavailable"}; static=${project.staticClaims.join(", ") || "none"}`),
    ...(fallbackPaths.length > 0 ? [`- capability fallback: substantive acceptance${staticFallback ? " plus available static validation" : ""} for ${fallbackPaths.join(", ")}`] : []),
    `- generally available validation command families: ${commandFamilies.length > 0 ? commandFamilies.join(", ") : "none detected"}`
  ];
}

function validationLines(validation: FrontierValidationReadiness): string[] {
  const observedClaims = [...new Set(validation.validations
    .filter((item) => item.status === "passed")
    .map((item) => item.data.claim?.kind ?? "untyped"))].sort();
  const observedCoverage = validation.validations.filter((item) => item.status === "passed")
    .slice(-12)
    .map((item) => `${item.data.claim?.kind ?? "untyped"}: ${item.data.coveredPaths.length > 0
      ? item.data.coveredPaths.join(", ") : "no assurance coverage"}`);
  return [
    `- recognized passed claims: ${observedClaims.length > 0 ? observedClaims.join(", ") : "none"}`,
    ...(validation.missingClaims.length > 0 ? [`- validation claims still missing: ${validation.missingClaims.join(", ")}`] : []),
    ...(validation.missingPaths.length > 0 ? [`- validation still missing/failed for: ${validation.missingPaths.join(", ")}`] : []),
    ...observedCoverage.map((item) => `  - ${item}`),
    ...(validation.latestFailed ? [`- latest failed validation: ${validation.latestFailed.summary}`] : [])
  ];
}

function reviewLines(session: RuntimeSession): string[] {
  const review = currentFrontierReview(session);
  const reviewMode = session.services.profile?.profile.mutationPolicy.reviewMode ?? "advisory";
  return [
    `- independent review mode: ${reviewMode}`,
    ...(review ? [`- latest review: ${review.data.verdict} (${review.status})`,
      ...review.data.findings.slice(0, 12).map((item) => `  - ${findingText(item)}`)] : [])
  ];
}

/** Model-visible V5 completion state. Internal evidence and checkpoint IDs are
 * deliberately absent: the runtime owns their association and final handoff. */
export function evidenceLedger(session: RuntimeSession): ContextItem {
  const frontier = session.durable.state.mutationFrontier;
  const validation = frontierValidationReadiness(session);
  const requirement = assuranceRequirement(session);
  const changed = frontier.changedPaths.slice(0, 200);
  const lines = [
    "Completion status (runtime-owned; do not supply evidence IDs):",
    `- final mutation revision: ${frontier.revision}`,
    `- net changed paths (${frontier.changedPaths.length}): ${changed.length > 0 ? changed.join(", ") : "none"}`,
    ...(changed.length < frontier.changedPaths.length ? [`- ${frontier.changedPaths.length - changed.length} additional paths omitted from this display`] : []),
    `- semantic validation: ${frontier.changedPaths.length === 0 ? "not required" : validation.ready ? "passed for every net changed path" : "blocking"}`,
    `- required validation claims: ${requirement.requiredClaims.length > 0 ? requirement.requiredClaims.join(", ") : "none"}`,
    ...capabilityLines(session, changed),
    ...validationLines(validation),
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
