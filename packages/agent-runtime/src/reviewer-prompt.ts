import type {
  ModelMessage,
  ModelToolDefinition
} from "agent-protocol";
import type { ReviewerInput } from "./reviewer-contracts.js";

function verificationPolicyMessage(
  policy: NonNullable<ReviewerInput["verificationPolicy"]>
): string {
  return policy === "strict"
    ? "Strict verification requires complete coverage with no remaining limitation and at least one current-frontier check you execute yourself."
    : "Standard verification is an evidence-based engineering judgment. A satisfied criterion still requires complete material coverage and an empty limitations list. Use limitations only for unresolved gaps that could change whether the criterion is satisfied; record genuinely non-material caveats as non-actionable informational findings instead. Independent checks plus an inspectable generalization argument may establish complete material coverage without exhaustive enumeration.";
}

function reviewPayload(
  input: ReviewerInput,
  requirements: Array<{ index: number; source: string; text: string }>,
  verificationPolicy: NonNullable<ReviewerInput["verificationPolicy"]>
): unknown {
  const diagnosticProjection = (input_: NonNullable<
    ReviewerInput["environmentMutations"]
  >) => input_.map((item) => ({
    evidenceId: item.evidenceId,
    status: item.status,
    summary: item.summary,
    data: item.data
  }));
  return {
    goal: input.goal,
    requirements,
    frontierRevision: input.frontierRevision,
    stateDigest: input.stateDigest,
    reviewBasisDigest: input.reviewBasisDigest,
    reviewMode: input.reviewMode,
    verificationPolicy,
    logicalWorkspacePath: input.logicalWorkspacePath ?? null,
    verificationScratchPath: input.verificationScratchPath
      ?? ".sigma-review-scratch",
    inputAccesses: input.inputAccesses ?? [],
    sessionReceipts: input.sessionReceipts ?? [],
    postReviewReceipts: input.postReviewReceipts ?? [],
    goalReferencedWorkspaceReads: input.goalReferencedWorkspaceReads ?? [],
    workspaceDeltas: input.workspaceDeltas.map((item) => ({
      evidenceId: item.evidenceId,
      checkpointId: item.data.checkpointId,
      delta: item.data.delta,
      diffPreview: item.data.reviewDiff
        ? item.data.reviewDiff.slice(0, 8_192)
        : "[diff artifact unavailable; use read_change_set or inspect the workspace]",
      diffByteLength: Buffer.byteLength(item.data.reviewDiff ?? "", "utf8"),
      reviewDiffPaths: item.data.reviewDiffPaths ?? [],
      opaqueArtifacts: item.data.opaqueArtifacts ?? [],
      reviewProblem: item.data.reviewProblem
    })),
    environmentMutations: diagnosticProjection(input.environmentMutations ?? []),
    processSettlements: diagnosticProjection(input.processSettlements ?? []),
    validations: input.validations.map((item) => ({
      evidenceId: item.evidenceId,
      status: item.status,
      summary: item.summary,
      data: item.data
    })),
    validationReadiness: input.validationReadiness ?? null
  };
}

export function reviewMessages(input: ReviewerInput): ModelMessage[] {
  const acceptanceCriteria = input.acceptanceCriteria ?? [];
  const verificationPolicy = input.verificationPolicy ?? "standard";
  const requirements = acceptanceCriteria.length > 0
    ? acceptanceCriteria.map((text, index) => ({
        index,
        source: "acceptance_criterion",
        text
      }))
    : [{ index: 0, source: "durable_user_goal", text: input.goal }];
  return [{
    role: "system",
    content: [
      "You are Sigma's independent read-only completion reviewer.",
      "Use the original durable user instructions, numbered requirements, current mutation frontier, consolidated change material, and existing evidence.",
      "Actively inspect the workspace and any declared enclosing-container mutation paths, or run the highest-value checks when tools are available. Your tools operate read-only against the parent state; checks that need temporary writes run only in a disposable overlay.",
      "The supplied logical workspace path names the parent workspace. Inside reviewer tools, address anything under that path relative to the current workspace root so the same checks work in the disposable overlay.",
      "The supplied verification scratch path is a session-stable directory inside that logical workspace. Create it when needed and place generated build or test artifacts there if a later tool call must inspect or execute them. Do not use /tmp or another external path for cross-call artifacts: external temporary paths are not part of the session-addressable overlay.",
      "The verification sandbox has its own isolated process namespace. Its /proc or process table cannot prove that a main-session or durably handed-off process is absent; use supplied main-session receipts and externally observable readiness checks instead.",
      "Main-session receipts are bounded authenticated records of actions and results, but they do not decide semantic sufficiency. Treat them as objective leads and independently check the requirement before approval.",
      "Post-review tool receipts are bounded, non-authoritative leads about the repair episode. Use them to choose checks, but independently inspect or validate the current state before approval.",
      "Try to falsify the completion claim rather than confirm a plausible implementation. A polished happy path or a passing sample can establish only what it actually exercised.",
      "A substantive rejection needs a concrete observed failure, an authoritative specification conflict, or a material requirement that remains unknown after you attempted the strongest feasible independent check. Speculation such as 'likely', 'probably', or 'may be wrong' is residual risk, not an actionable defect.",
      "An unavailable reference answer or external oracle is not by itself a reason to fail. First try to derive an independent oracle from the primary input and specification, use a disposable scratch check, or establish the required property through invariants and adversarial examples. Never invent reference contents.",
      "Do not request that the main agent provide an unavailable reference answer as a repair. In Standard verification, if the strongest feasible independent check finds no concrete defect, record the absent oracle as residual risk and decide from the available semantic evidence; in Strict verification, keep materially unsupported claims unverified.",
      "Evaluate every numbered requirement. A materially unsupported requirement after the strongest feasible check is unverified. A failed validation is a correctness signal. Runtime command labels, file extensions, inferred claim kinds, and declared covered paths are non-authoritative metadata; judge semantic coverage from the actual command, output, change, and user requirement.",
      "For each criterion, explicitly declare evidence coverage. 'complete' means the checks and reasoning cover every materially distinct part of the claim, not formal proof over inaccessible external data; representative or sampled checks are 'partial' unless you provide an inspectable argument showing why they imply the untested cases. Improvement over one baseline alone does not establish a best, maximum, or minimum claim. A criterion cannot be satisfied while its limitations list contains an unresolved gap; put only genuinely non-material caveats in informational findings.",
      verificationPolicyMessage(verificationPolicy),
      "Opaque content may be accepted only from identity evidence plus applicable passed validation. Never claim to have inspected hidden content or edited files.",
      "Use changes_requested for a reproduced implementation error, an authoritative specification conflict, or a materially unsupported requirement after feasible checks; blocked only when verification cannot proceed; and approved only when every numbered requirement is satisfied.",
      "Keep the verdict compact: at most 8 findings and 6 required validations. The runtime binds authenticated workspace, validation, and reviewer-check evidence to the verdict; do not copy opaque evidence IDs into the submission.",
      "The verification session has a bounded inspection phase. Its final model turn exposes only submit_verification, so gather the highest-value evidence before then and use that final turn for the verdict.",
      "When submit_verification is available, call it exactly once and alone after inspecting enough evidence. Otherwise return one strict JSON object with keys verdict, findings, criteria, and requiredValidations; criteria must use criterionIndex, evidenceIds, status, coverage, and an optional summary.",
      "The supplied material can include complete goal-referenced workspace read snapshots."
    ].join(" ")
  }, {
    role: "user",
    content: JSON.stringify(reviewPayload(input, requirements, verificationPolicy))
  }];
}

export function reviewVerdictReminder(
  verificationPolicy: NonNullable<ReviewerInput["verificationPolicy"]> = "standard"
): ModelMessage {
  return {
    role: "developer",
    content: [
      "[verification_verdict_required]",
      "The inspection phase is now closed. Do not narrate, inspect again, or call any other tool.",
      "Call submit_verification exactly once and as the only tool call in this response.",
      "Cover every numbered requirement. The runtime will bind the authenticated evidence produced or supplied in this review; do not reproduce opaque evidence IDs.",
      "For every criterion include coverage scope, checked claims, remaining limitations, and the falsification attempt.",
      verificationPolicyMessage(verificationPolicy),
      "If material evidence is still missing after the strongest feasible check, mark that criterion unverified; do not invent evidence."
    ].join(" ")
  };
}

const findingSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    actionable: { type: "boolean" },
    severity: { type: "string", enum: ["error", "warning", "info"] },
    summary: { type: "string" },
    code: { type: "string" }
  },
  required: ["actionable", "severity", "summary"]
};

const criterionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    criterionIndex: { type: "integer", minimum: 0 },
    status: {
      type: "string",
      enum: ["satisfied", "failed", "unverified"]
    },
    coverage: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: {
          type: "string",
          enum: ["complete", "partial", "unavailable"]
        },
        rationale: { type: "string" },
        checkedClaims: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 32
        },
        limitations: {
          type: "array",
          items: { type: "string" },
          maxItems: 16
        },
        falsificationAttempt: { type: "string" }
      },
      required: [
        "scope",
        "rationale",
        "checkedClaims",
        "limitations",
        "falsificationAttempt"
      ]
    },
    summary: { type: "string" }
  },
  required: ["criterionIndex", "status", "coverage"]
};

const requiredValidationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    purpose: { type: "string" },
    coveredPaths: {
      type: "array",
      items: { type: "string" },
      maxItems: 32
    },
    claimKind: {
      type: "string",
      enum: [
        "probe",
        "syntax",
        "typecheck",
        "lint",
        "unit",
        "integration",
        "acceptance"
      ]
    },
    commandSuggestion: { type: "string" }
  },
  required: ["purpose"]
};

export function reviewResultTool(): ModelToolDefinition {
  return {
    name: "submit_verification",
    description: "Submit one compact, evidence-linked independent completion verdict.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        verdict: {
          type: "string",
          enum: ["approved", "changes_requested", "blocked"]
        },
        findings: {
          type: "array",
          maxItems: 8,
          items: findingSchema
        },
        criteria: {
          type: "array",
          items: criterionSchema
        },
        requiredValidations: {
          type: "array",
          maxItems: 6,
          items: requiredValidationSchema
        }
      },
      required: ["verdict", "findings", "criteria", "requiredValidations"]
    }
  };
}
