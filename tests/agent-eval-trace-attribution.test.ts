import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { digest } from "../scripts/eval/common.mjs";
import {
  buildAggregateTraceAttribution,
  buildTraceAttribution
} from "../scripts/eval/trace-attribution.mjs";
import { rootDir } from "../scripts/eval/common.mjs";

function event(seq: number, type: string, payload: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    seq,
    eventId: `event-${seq}`,
    sessionId: "session",
    runId: "run",
    occurredAt: new Date(Date.UTC(2026, 7, 1, 0, 0, seq)).toISOString(),
    type,
    authority: type.startsWith("tool.") ? "tool" : "runtime",
    payload
  };
}

function usage(inputTokens = 100, outputTokens = 10, cacheReadTokens: number | undefined = 40) {
  return {
    providerId: "openai-codex",
    modelId: "gpt-5.6-sol",
    providerReported: true,
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    latencyMs: 1_000
  };
}

function prompt(turnId: number) {
  return {
    turnId,
    requestDigest: String(turnId).padStart(64, "a").slice(-64),
    toolSchemaDigest: "b".repeat(64),
    traceObservation: {
      schemaVersion: 1,
      tokenEstimator: "context_plan_approximate_tokens",
      tokenAccuracy: "estimated",
      estimatedTokens: {
        systemBaseContext: 20,
        toolSchema: 10,
        conversationHistory: 50,
        toolResults: 20,
        total: 100
      },
      visibleToolNames: ["read", "validate", "write"]
    }
  };
}

function modelEvents(seq: number, turnId: number) {
  return [
    event(seq, "model.started", { turnId, provider: "openai-codex", model: "gpt-5.6-sol" }),
    event(seq + 1, "model.prompt_materialized", prompt(turnId)),
    event(seq + 2, "model.completed", {
      turnId, model: "gpt-5.6-sol", usage: usage(), text: "", toolCalls: []
    })
  ];
}

function receipt(seq: number, turnId: number, callId: string, name: string, output: string, effects: string[]) {
  return event(seq, "tool.completed", {
    turnId,
    callId,
    name,
    output,
    observedEffects: effects,
    actualEffects: effects,
    artifactRefs: [],
    traceObservation: {
      schemaVersion: 1,
      rawBytes: Buffer.byteLength(output),
      modelVisibleBytes: Buffer.byteLength(`visible:${output}`),
      fullOutputDigest: digest(output)
    },
    startedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, seq - 1)).toISOString(),
    completedAt: new Date(Date.UTC(2026, 7, 1, 0, 0, seq)).toISOString()
  });
}

function requested(seq: number, turnId: number, callId: string, name: string, argumentsValue: object) {
  return event(seq, "tool.requested", { turnId, callId, name, arguments: argumentsValue });
}

function syntheticTrace() {
  return [
    event(1, "session.created", { mode: "change" }),
    event(2, "run.started", { mode: "change" }),
    ...modelEvents(3, 1),
    requested(6, 1, "read-1", "read", { path: "src/a.ts", start: 1, end: 20 }),
    receipt(7, 1, "read-1", "read", "alpha", ["filesystem.read"]),
    ...modelEvents(8, 2),
    requested(11, 2, "read-2", "read", { end: 20, path: "src/a.ts", start: 1 }),
    receipt(12, 2, "read-2", "read", "alpha", ["filesystem.read"]),
    ...modelEvents(13, 3),
    requested(16, 3, "write-1", "write", { path: "src/a.ts", content: "changed" }),
    event(17, "checkpoint.sealed", {
      checkpointId: "checkpoint", status: "sealed",
      preManifestDigest: "c".repeat(64), postManifestDigest: "d".repeat(64),
      delta: { added: [], modified: ["src/a.ts"], deleted: [] }
    }),
    receipt(18, 3, "write-1", "write", "changed", ["filesystem.write"]),
    ...modelEvents(19, 4),
    requested(22, 4, "read-3", "read", { path: "src/a.ts", start: 1, end: 20 }),
    receipt(23, 4, "read-3", "read", "alpha", ["filesystem.read"]),
    ...modelEvents(24, 5),
    requested(27, 5, "validate-1", "validate", { command: "pnpm test" }),
    receipt(28, 5, "validate-1", "validate", "pass", ["validation"]),
    event(29, "evidence.recorded", {
      evidenceId: "validation-1", kind: "validation", status: "passed",
      data: { frontierRevision: 1 }
    }),
    ...modelEvents(30, 6),
    requested(33, 6, "validate-2", "validate", { command: "pnpm test" }),
    receipt(34, 6, "validate-2", "validate", "pass", ["validation"]),
    ...modelEvents(35, 7),
    event(38, "run.completed", { kind: "completed" })
  ];
}

function metadata() {
  return {
    attemptId: "attempt",
    scenarioId: "general-scenario",
    repetition: 1,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    profile: "standard",
    runMode: "change",
    harnessDigest: "e".repeat(64),
    compilerDigest: "f".repeat(64),
    durationMs: 38_000
  };
}

describe("neutral trace attribution", () => {
  it("classifies turns, preserves source refs, and applies deterministic repeat boundaries", () => {
    const { report } = buildTraceAttribution(syntheticTrace(), metadata());
    expect(report.totals.turnCategories).toMatchObject({
      inspect: 3, mutation: 1, validation: 2, completion_tail: 2
    });
    expect(report.derived.repeats.toolCalls).toHaveLength(2);
    expect(report.derived.repeats.reads).toHaveLength(1);
    expect(report.derived.repeats.observations).toHaveLength(3);
    expect(report.derived.repeats.validations).toHaveLength(1);
    expect(report.derived.repeats.reads[0]).toMatchObject({
      previousRef: { eventId: "event-6" },
      currentRef: { eventId: "event-11" },
      mutationFrontierRevision: 0
    });
    expect(report.derived.repeats.reads.some((item: { currentRef: { eventId: string } }) =>
      item.currentRef.eventId === "event-22")).toBe(false);
    expect(report.derived.repeats.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        currentRef: expect.objectContaining({ eventId: "event-23" }),
        mutationIntervened: true
      })
    ]));
    expect(report.derived.milestones).toMatchObject({
      firstToolCall: { turnOrdinal: 1 },
      firstMutation: { turnOrdinal: 3 },
      lastMutation: { turnOrdinal: 3 },
      firstValidation: { turnOrdinal: 5 },
      finalCompletion: { turnOrdinal: 7 }
    });
    expect(report.derived.completionTail).toMatchObject({ count: 2 });
    expect(report.derived.completionTail.turns.map((turn: { turnOrdinal: number }) => turn.turnOrdinal))
      .toEqual([6, 7]);
    expect(report.derived.repeats.toolCalls.every((item: { currentRef: unknown; previousRef: unknown }) =>
      item.currentRef && item.previousRef)).toBe(true);
  });

  it("advances the repeat frontier after successful restoration evidence", () => {
    const restorationTrace = (status: "passed" | "failed") => [
      event(1, "session.created", { mode: "change" }),
      event(2, "run.started", { mode: "change" }),
      event(3, "checkpoint.sealed", {
        checkpointId: "checkpoint", status: "sealed",
        preManifestDigest: "a".repeat(64), postManifestDigest: "b".repeat(64),
        delta: { added: [], modified: ["src/a.ts"], deleted: [] }
      }),
      ...modelEvents(4, 1),
      requested(7, 1, "read-1", "read", { path: "src/a.ts", start: 1, end: 20 }),
      receipt(8, 1, "read-1", "read", "alpha", ["filesystem.read"]),
      event(9, "evidence.recorded", {
        evidenceId: "restoration", sessionId: "session", runId: "run",
        kind: "restoration", status, producer: { authority: "runtime" },
        data: {
          frontierRevision: 1,
          frontierStateDigest: "b".repeat(64),
          baselineManifestDigest: "a".repeat(64),
          currentManifestDigest: "a".repeat(64),
          repository: { status: "unchanged" }
        }
      }),
      ...modelEvents(10, 2),
      requested(13, 2, "read-2", "read", { path: "src/a.ts", start: 1, end: 20 }),
      receipt(14, 2, "read-2", "read", "alpha", ["filesystem.read"]),
      event(15, "run.completed", { kind: "completed" })
    ];
    const passed = buildTraceAttribution(restorationTrace("passed"), metadata()).report;
    expect(passed.derived.repeats.toolCalls).toHaveLength(0);
    expect(passed.derived.repeats.reads).toHaveLength(0);
    expect(passed.derived.repeats.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ mutationIntervened: true })
    ]));
    expect(passed.modelCalls[1].mutationFrontierRevision.start).toBe(2);

    const failed = buildTraceAttribution(restorationTrace("failed"), metadata()).report;
    expect(failed.derived.repeats.toolCalls).toHaveLength(1);
    expect(failed.derived.repeats.reads).toHaveLength(1);
    expect(failed.modelCalls[1].mutationFrontierRevision.start).toBe(1);
  });

  it("marks recovery and user-input turns from events without interpreting task answers", () => {
    const events = [
      event(1, "session.created", { mode: "change" }),
      event(2, "run.started", { mode: "change" }),
      ...modelEvents(3, 1),
      requested(6, 1, "failed", "read", { path: "a" }),
      event(7, "tool.failed", {
        turnId: 1, callId: "failed", name: "read", output: "failed",
        actualEffects: ["filesystem.read"], observedEffects: ["filesystem.read"]
      }),
      ...modelEvents(8, 2),
      event(11, "diagnostic", { kind: "recovery.retry_model", message: "retry" }),
      requested(12, 2, "question", "request_input", {}),
      event(13, "execution.planned", {
        toolCallId: "question", plan: { exactEffects: ["outcome.request_input"] }
      }),
      event(14, "run.suspended", { kind: "needs_input" })
    ];
    const { report } = buildTraceAttribution(events, metadata());
    expect(report.totals.turnCategories).toMatchObject({ recovery: 1, user_input: 1 });
    expect(report.modelCalls[1].classification.labels).toEqual(expect.arrayContaining(["recovery", "user_input"]));
  });

  it("keeps missing provider and cache usage unavailable instead of inventing zeroes", () => {
    const missing = [
      event(1, "session.created", { mode: "change" }),
      event(2, "run.started", { mode: "change" }),
      event(3, "model.started", { turnId: 1, provider: "provider", model: "model" }),
      event(4, "model.prompt_materialized", prompt(1)),
      event(5, "model.completed", { turnId: 1, model: "model" })
    ];
    const missingUsage = buildTraceAttribution(missing, metadata()).report.modelCalls[0].usage;
    expect(missingUsage.providerReported).toMatchObject({
      accuracy: "unavailable", inputTokens: null, outputTokens: null, cacheReadTokens: null
    });
    expect(missingUsage.uncachedInputPlusOutputV1.value).toBeNull();

    missing[4]!.payload = {
      turnId: 1,
      model: "model",
      usage: {
        providerId: "openai-codex", modelId: "gpt-5.6-sol",
        providerReported: true, inputTokens: 10, outputTokens: 2, latencyMs: 1_000
      }
    };
    const missingCache = buildTraceAttribution(missing, metadata()).report.modelCalls[0].usage;
    expect(missingCache.providerReported.cacheReadTokens).toBeNull();
    expect(missingCache.accounted.cacheReadTokens).toBeNull();
    expect(missingCache.uncachedInputPlusOutputV1.value).toBeNull();
  });

  it("redacts labels and stores only digests for arguments and tool output", () => {
    const secret = "credential-secret-value";
    const events = syntheticTrace();
    events[2]!.payload.provider = secret;
    events[5]!.payload.name = secret;
    events[5]!.payload.arguments = { path: secret, credential: secret };
    events[6]!.payload.output = secret;
    const { report } = buildTraceAttribution(events, {
      ...metadata(), provider: secret, model: secret, profile: secret,
      redactor: (value: unknown) => String(value).split(secret).join("[REDACTED]")
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(JSON.stringify(report)).toContain("[REDACTED]");
  });

  it("produces deterministic JSON and self-digests against the versioned schema", async () => {
    const first = buildTraceAttribution(syntheticTrace(), metadata()).report;
    const second = buildTraceAttribution(syntheticTrace(), metadata()).report;
    expect(second).toEqual(first);
    const { reportDigest, ...unsigned } = first;
    expect(reportDigest).toBe(digest(unsigned));
    const schema = JSON.parse(await readFile(
      path.join(rootDir, "scripts", "eval", "trace-attribution.schema.json"), "utf8"
    ));
    expect(first.$schema).toBe(schema.$id);
    expect(schema.$defs.attempt.properties.attributionVersion.const).toBe("trace-attribution-1.0.0");
  });

  it("leaves the complete outbound model request identical when attribution is enabled", () => {
    const request = {
      messages: [{ role: "user", content: "neutral request" }],
      tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }],
      toolChoice: "auto",
      maxOutputTokens: 4096,
      temperature: 0
    };
    const run = (enabled: boolean) => {
      const outbound = structuredClone(request);
      if (enabled) buildTraceAttribution(syntheticTrace(), metadata());
      return outbound;
    };
    expect(run(true)).toEqual(run(false));
    expect(run(true)).toEqual(request);
  });

  it("aggregates only evaluator-side scenario labels and product-terminal success distributions", () => {
    const first = buildTraceAttribution(syntheticTrace(), metadata()).summary;
    const second = { ...first, attemptId: "attempt-2", scenarioId: "other", repetition: 2 };
    const report = buildAggregateTraceAttribution([second, first], {
      runId: "run", finishedAt: "2026-08-01T00:01:00.000Z",
      provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "max", profile: "standard"
    });
    expect(report.scenarios.map((scenario: { scenarioId: string }) => scenario.scenarioId))
      .toEqual(["general-scenario", "other"]);
    expect(report.successfulAttemptDistributions.modelTurns).toMatchObject({ count: 2, p50: 7 });
    expect(report.configuration).toMatchObject({
      provider: "openai-codex", model: "gpt-5.6-sol", reasoningEffort: "max", profile: "standard"
    });
  });
});
