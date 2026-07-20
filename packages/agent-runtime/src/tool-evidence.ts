import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CommandEvidence,
  DiagnosticEvidence,
  EvidenceRecord,
  InputAccessEvidence,
  RepositoryDeltaEvidence,
  ToolCallPlan,
  ToolReceipt,
  ValidationEvidence,
  WorkspaceDeltaEvidence
} from "agent-protocol";

export interface ReceiptEvidenceScope {
  sessionId: string;
  runId: string;
  workspaceDeltas: WorkspaceDeltaEvidence[];
  validationScope?: {
    frontierRevision: number;
    stateDigest: string;
    coveredPaths: string[];
    claim?: Omit<import("agent-protocol").ValidationClaimV1, "status">;
  };
}

export function effectsOutsidePlan(receipt: ToolReceipt, plan: ToolCallPlan): string[] {
  const allowed = new Set(plan.exactEffects);
  return [...new Set(receipt.actualEffects ?? receipt.observedEffects)].filter((effect) => !allowed.has(effect));
}

export function assertToolReceiptIdentity(receipt: ToolReceipt, expectedCallId: string): void {
  if (receipt.callId === expectedCallId) return;
  throw Object.assign(new Error(
    `Tool receipt callId '${receipt.callId}' does not match requested callId '${expectedCallId}'.`
  ), { code: "tool_receipt_identity_mismatch" });
}

function evidenceBase(scope: ReceiptEvidenceScope, receipt: ToolReceipt): Pick<
  EvidenceRecord,
  "evidenceId" | "sessionId" | "runId" | "createdAt" | "producer"
> {
  return {
    evidenceId: randomUUID(),
    sessionId: scope.sessionId,
    runId: scope.runId,
    createdAt: receipt.completedAt || new Date().toISOString(),
    producer: { authority: "tool", id: receipt.callId }
  };
}

function sanitizeValidation(
  raw: ValidationEvidence,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope
): ValidationEvidence {
  const frontier = scope.validationScope;
  if (!frontier) throw Object.assign(new Error("Validation evidence is missing its frozen mutation frontier."), {
    code: "validation_frontier_missing"
  });
  return {
    ...evidenceBase(scope, receipt),
    kind: "validation",
    status: receipt.ok && raw.status === "passed" ? "passed" : "failed",
    summary: raw.summary,
    data: {
      validator: raw.data.validator,
      ...(raw.data.command ? { command: raw.data.command } : {}),
      ...(raw.data.exitCode === undefined ? {} : { exitCode: raw.data.exitCode }),
      ...(raw.data.termination ? { termination: { ...raw.data.termination } } : {}),
      artifactIds: [...new Set(receipt.artifacts)],
      frontierRevision: frontier.frontierRevision,
      stateDigest: frontier.stateDigest,
      coveredPaths: [...frontier.coveredPaths],
      ...(frontier.claim ? {
        claim: {
          ...frontier.claim,
          subject: { ...frontier.claim.subject },
          status: raw.data.termination?.processStarted === false
            ? "unavailable" as const
            : receipt.ok && raw.status === "passed" ? "passed" as const : "failed" as const
        }
      } : {})
    }
  };
}

function sanitizeCommand(raw: CommandEvidence, receipt: ToolReceipt, scope: ReceiptEvidenceScope): CommandEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "command",
    status: receipt.ok && raw.status === "passed" ? "passed" : "failed",
    summary: raw.summary,
    data: {
      command: raw.data.command,
      exitCode: raw.data.exitCode,
      ...(raw.data.signal ? { signal: raw.data.signal } : {}),
      artifactIds: [...new Set(receipt.artifacts)],
      ...(raw.data.stdoutArtifactId && receipt.artifacts.includes(raw.data.stdoutArtifactId)
        ? { stdoutArtifactId: raw.data.stdoutArtifactId } : {}),
      ...(raw.data.stderrArtifactId && receipt.artifacts.includes(raw.data.stderrArtifactId)
        ? { stderrArtifactId: raw.data.stderrArtifactId } : {})
    }
  };
}

function sanitizeDiagnostic(raw: DiagnosticEvidence, receipt: ToolReceipt, scope: ReceiptEvidenceScope): DiagnosticEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "diagnostic",
    status: receipt.ok ? raw.status : "failed",
    summary: raw.summary,
    data: { source: raw.data.source, diagnostic: raw.data.diagnostic }
  };
}

function canonicalInputAccessPath(
  value: string,
  inputScope: InputAccessEvidence["data"]["scope"]
): string | undefined {
  if (inputScope === "external") {
    return path.isAbsolute(value) ? path.normalize(value).split(path.sep).join("/") : undefined;
  }
  const portable = value.replaceAll("\\", "/");
  const normalized = path.posix.normalize(portable);
  return path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)
    || normalized === ".." || normalized.startsWith("../") ? undefined : normalized;
}

function approvedInputAccessPath(
  raw: InputAccessEvidence,
  plan: ToolCallPlan
): { canonicalPath: string | undefined; valid: boolean } {
  const canonicalPath = canonicalInputAccessPath(raw.data.path, raw.data.scope);
  const approvedPaths = new Set(plan.readPaths.flatMap((value) => {
    const canonical = canonicalInputAccessPath(value, raw.data.scope);
    return canonical === undefined ? [] : [canonical];
  }));
  return { canonicalPath, valid: canonicalPath !== undefined && approvedPaths.has(canonicalPath) };
}

function inputAccessSelectionMatchesReceipt(raw: InputAccessEvidence, receipt: ToolReceipt): boolean {
  if (!raw.data.selection) return true;
  const outputSha256 = createHash("sha256").update(receipt.output, "utf8").digest("hex");
  return raw.data.selection.sha256 === outputSha256
    && raw.data.selection.byteLength === Buffer.byteLength(receipt.output, "utf8");
}

function inputAccessFailureCode(
  raw: InputAccessEvidence,
  pathValid: boolean,
  selectionValid: boolean
): string | undefined {
  if (!pathValid) return "input_access_path_invalid";
  if (!selectionValid) return "input_access_content_mismatch";
  return raw.data.failureCode;
}

function sanitizeInputAccess(
  raw: InputAccessEvidence,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope,
  plan: ToolCallPlan
): InputAccessEvidence {
  const { canonicalPath, valid: pathValid } = approvedInputAccessPath(raw, plan);
  const selectionValid = inputAccessSelectionMatchesReceipt(raw, receipt);
  const passed = receipt.ok && raw.status === "passed" && pathValid && selectionValid;
  const failureCode = inputAccessFailureCode(raw, pathValid, selectionValid);
  return {
    ...evidenceBase(scope, receipt),
    kind: "input_access",
    status: passed ? "passed" : "failed",
    summary: raw.summary,
    data: {
      path: canonicalPath ?? raw.data.path,
      scope: raw.data.scope,
      ...(raw.data.sha256 ? { sha256: raw.data.sha256 } : {}),
      ...(raw.data.byteLength === undefined ? {} : { byteLength: raw.data.byteLength }),
      ...(selectionValid && raw.data.selection ? { selection: { ...raw.data.selection } } : {}),
      ...(failureCode ? { failureCode } : {})
    }
  };
}

function sanitizeRepositoryDelta(
  raw: RepositoryDeltaEvidence,
  receipt: ToolReceipt,
  scope: ReceiptEvidenceScope
): RepositoryDeltaEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "repository_delta",
    status: receipt.ok && raw.status === "passed" ? "passed" : "failed",
    summary: raw.summary,
    data: { ...raw.data, operations: [...raw.data.operations] }
  };
}

function synthesizedDiagnostic(
  receipt: ToolReceipt,
  toolName: string,
  scope: ReceiptEvidenceScope,
  actualEffects: ToolReceipt["observedEffects"]
): DiagnosticEvidence {
  return {
    ...evidenceBase(scope, receipt),
    kind: "diagnostic",
    status: receipt.ok ? "informational" : "failed",
    summary: `${toolName} ${receipt.ok ? "completed" : "failed"}.`,
    data: { source: toolName, diagnostic: {
      callId: receipt.callId,
      effects: actualEffects,
      diagnostics: [...receipt.diagnostics]
    } }
  };
}

/**
 * Tool-returned evidence is untrusted data. Re-issue only kinds justified by
 * the approved/observed effects, stamp the active run, and discard privileged
 * review, waiver, checkpoint, child, and workspace-delta claims. Workspace
 * deltas are emitted only by the checkpoint manager after sealing.
 */
export function normalizeReceiptEvidence(
  receipt: ToolReceipt,
  toolName: string,
  plan: ToolCallPlan,
  scope: ReceiptEvidenceScope
): ToolReceipt {
  const actualEffects = [...new Set(receipt.actualEffects ?? receipt.observedEffects)];
  const evidence = (receipt.evidence ?? []).flatMap((raw): EvidenceRecord[] => {
    if (raw.kind === "validation" && plan.exactEffects.includes("validation") && actualEffects.includes("validation")) {
      return [sanitizeValidation(raw, receipt, scope)];
    }
    if (raw.kind === "repository_delta" && plan.exactEffects.includes("repository.write")
      && actualEffects.includes("repository.write")) {
      return [sanitizeRepositoryDelta(raw, receipt, scope)];
    }
    if (raw.kind === "command" && actualEffects.some((effect) => effect === "process.spawn" || effect === "process.spawn.readonly")) {
      return [sanitizeCommand(raw, receipt, scope)];
    }
    if (raw.kind === "diagnostic") return [sanitizeDiagnostic(raw, receipt, scope)];
    if (raw.kind === "input_access" && actualEffects.includes("filesystem.read")) {
      return [sanitizeInputAccess(raw, receipt, scope, plan)];
    }
    return [];
  });
  return {
    ...receipt,
    actualEffects,
    evidence: evidence.length > 0 ? evidence : [synthesizedDiagnostic(receipt, toolName, scope, actualEffects)]
  };
}
