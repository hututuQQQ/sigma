import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listV3Sessions, readV3Session, resolveWorkspaceStateRoot } from "../scripts/eval/event-store.mjs";
import { reduceAgentEvents, renderSessionMetricsMarkdown } from "../scripts/eval/metrics.mjs";
import { auditSessions, renderSessionAuditMarkdown, writeSessionAudit } from "../scripts/eval/session-audit.mjs";

const epoch = Date.parse("2026-07-12T00:00:00.000Z");

function eventFactory(sessionId = "session", runId = "run") {
  let seq = 0;
  let tick = 0;
  return (type: string, payload: Record<string, unknown> = {}, advanceMs = 1_000) => {
    tick += advanceMs;
    seq += 1;
    return {
      schemaVersion: 3,
      seq,
      eventId: `event-${seq}`,
      sessionId,
      runId,
      occurredAt: new Date(epoch + tick).toISOString(),
      type,
      authority: type.startsWith("user.") ? "user" : type.startsWith("tool.") && type !== "tool.requested" ? "tool" : "runtime",
      payload
    };
  };
}

function usage(sessionId: string, runId: string, index: number, inputTokens = 18_000) {
  return {
    usageId: `usage-${index}`,
    requestId: `request-${index}`,
    sessionId,
    runId,
    role: "orchestrator",
    routeId: "route",
    providerId: "deepseek",
    modelId: "deepseek-v4-pro",
    tokenizerId: "approx",
    tokenizerAccuracy: "approximate",
    providerReported: true,
    inputTokens,
    outputTokens: 100,
    reasoningTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicroUsd: 1_000,
    latencyMs: 2_000,
    attempt: 1,
    occurredAt: new Date(epoch + index * 1_000).toISOString()
  };
}

function storedLine(value: unknown) {
  const checksum = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `${JSON.stringify({ checksum, event: value })}\n`;
}

async function writeSession(root: string, sessionId: string, updatedAt: string, events: unknown[]) {
  const directory = path.join(root, "stores", "v3", "sessions", sessionId);
  await mkdir(path.join(directory, "events"), { recursive: true });
  await writeFile(path.join(directory, "events", "000001.jsonl"), events.map(storedLine).join(""), "utf8");
  await writeFile(path.join(directory, "meta.json"), `${JSON.stringify({
    schemaVersion: 3,
    eventSchemaVersion: 3,
    snapshotSchemaVersion: 3,
    sessionId,
    createdAt: events[0]?.occurredAt ?? updatedAt,
    updatedAt,
    lastSeq: events.length,
    segment: 1,
    segmentEvents: events.length
  })}\n`, "utf8");
}

describe("agent experience event metrics", () => {
  it("identifies the repeated-read, failure, compaction, token, stagnation, and deadline portrait", () => {
    const make = eventFactory();
    const events = [
      make("session.created"),
      make("run.started", { mode: "analyze", deadlineAt: new Date(epoch + 900_000).toISOString() }),
      make("user.message", { text: "count code lines" })
    ];
    let compactions = 0;
    for (let index = 0; index < 130; index += 1) {
      if (index < 60) {
        events.push(make("model.started", { turnId: index + 1, effectRevision: index + 1 }));
        events.push(make("usage.recorded", usage("session", "run", index + 1)));
      }
      if (compactions < 23 && index % 5 === 0) {
        events.push(make("context.compacted", { omittedHistoryTurns: index }));
        compactions += 1;
      }
      const callId = `read-${index}`;
      events.push(make("tool.requested", {
        callId,
        name: "read_file",
        arguments: { path: "src/index.ts", offset: 0, limit: 200 },
        turnId: Math.min(index + 1, 60),
        effectRevision: Math.min(index + 1, 60)
      }));
      events.push(make(index < 38 ? "tool.failed" : "tool.completed", {
        callId,
        name: "read_file",
        ok: index >= 38,
        output: index < 38 ? "read failed" : "same file output",
        diagnostics: index < 38 ? ["failure"] : [],
        observedEffects: ["filesystem.read"],
        actualEffects: ["filesystem.read"],
        startedAt: new Date(epoch).toISOString(),
        completedAt: new Date(epoch + 1).toISOString(),
        turnId: Math.min(index + 1, 60),
        effectRevision: Math.min(index + 1, 60)
      }));
    }
    events.push(make("run.failed", { kind: "recoverable_failure", code: "budget_exhausted", message: "Run deadline exceeded." }, 900_000));

    const metrics = reduceAgentEvents(events);

    expect(metrics.counts).toMatchObject({
      modelTurns: 60,
      toolCalls: 130,
      toolFailures: 38,
      contextCompactions: 23
    });
    expect(metrics.usageTotals).toMatchObject({ records: 60, inputTokens: 1_080_000, outputTokens: 6_000 });
    expect(metrics.repeatedExactRequests).toMatchObject({ total: 130, unique: 1, repeated: 129 });
    expect(metrics.repeatedExactRequests.rate).toBeCloseTo(129 / 130);
    expect(metrics.repeatedOutputs.repeated).toBe(128);
    expect(metrics.consecutiveToolFailures).toMatchObject({ longest: 38 });
    expect(metrics.consecutiveToolFailures.streaks[0]).toMatchObject({ count: 38, tools: { read_file: 38 } });
    expect(metrics.stagnationWindows[0]).toMatchObject({
      workUnits: 127,
      modelTurns: 21,
      toolCalls: 91,
      compactions: 15,
      repeatedRequests: 91
    });
    expect(metrics.terminal).toMatchObject({ status: "failed", code: "budget_exhausted" });
    expect(metrics.hardFailures.map((item: { code: string }) => item.code)).toEqual(["budget_exhausted", "deadline_exceeded"]);
  });

  it("detects read-only mutation, post-answer churn, and stale work after steering without copying content", () => {
    const make = eventFactory("steer-session");
    const secretAnswer = "final answer containing SHOULD_NOT_APPEAR";
    const events = [
      make("run.started", { mode: "analyze" }),
      make("user.message", { text: "inspect" }),
      make("model.completed", { text: secretAnswer, toolCalls: [], turnId: 1, effectRevision: 1 }),
      make("user.steer", { text: "stop and do something else" }),
      make("tool.requested", { callId: "old", name: "read_file", arguments: { path: "old.ts" }, turnId: 1, effectRevision: 1 }),
      make("tool.failed", { callId: "old", name: "read_file", output: "cancelled", turnId: 1, effectRevision: 1 }),
      make("model.started", { turnId: 2, effectRevision: 2 }),
      make("tool.requested", { callId: "write", name: "write_file", arguments: { path: "new.ts" }, turnId: 2, effectRevision: 2 }),
      make("tool.completed", {
        callId: "write",
        name: "write_file",
        output: "written",
        observedEffects: ["filesystem.write"],
        actualEffects: ["filesystem.write"],
        workspaceDelta: { added: ["new.ts"], modified: [], deleted: [] },
        turnId: 2,
        effectRevision: 2
      }),
      make("run.completed", { message: "complete", evidence: [], outcomeRevision: 2 })
    ];

    const metrics = reduceAgentEvents(events);

    expect(metrics.postAnswerChurn).toMatchObject({ events: 5, modelTurns: 1, toolCalls: 2 });
    expect(metrics.steer).toMatchObject({ count: 1, staleActions: 1, staleToolCalls: 1, maxStopDelayMs: 2_000 });
    expect(metrics.workspaceDeltas).toMatchObject({ count: 1, added: ["new.ts"], changedFiles: ["new.ts"] });
    expect(metrics.hardFailures).toContainEqual({ code: "read_only_workspace_mutation", seq: null });
    expect(JSON.stringify(metrics)).not.toContain("SHOULD_NOT_APPEAR");
    expect(renderSessionMetricsMarkdown(metrics)).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("does not classify fresh execution bookkeeping without a revision as stale after steering", () => {
    const make = eventFactory("fresh-steer-session");
    const events = [
      make("run.started", { mode: "change" }),
      make("model.started", { turnId: 1, effectRevision: 1 }),
      make("user.steer", { text: "replace the goal" }),
      make("model.started", { turnId: 2, effectRevision: 2 }),
      make("tool.requested", { callId: "fresh", name: "read_file", arguments: {}, turnId: 2, effectRevision: 2 }),
      make("execution.started", { executionId: "fresh" }),
      make("execution.completed", { executionId: "fresh" }),
      make("tool.completed", { callId: "fresh", name: "read_file", output: "ok", turnId: 2, effectRevision: 2 }),
      make("run.completed", {})
    ];

    expect(reduceAgentEvents(events).steer).toMatchObject({
      count: 1,
      staleActions: 0,
      staleToolCalls: 0,
      maxStopDelayMs: 0,
      events: [{ firstFreshActionMs: 1_000 }]
    });
  });

  it("recognizes an answer paired with complete_task without counting protocol finalization as churn", () => {
    const make = eventFactory("completion-session");
    const events = [
      make("run.started", { mode: "change" }),
      make("model.completed", {
        text: "Done.",
        toolCalls: [{ id: "complete", name: "complete_task", arguments: {} }],
        turnId: 1,
        effectRevision: 1
      }),
      make("tool.requested", { callId: "complete", name: "complete_task", arguments: {}, turnId: 1, effectRevision: 1 }),
      make("execution.started", { executionId: "complete" }),
      make("execution.completed", { executionId: "complete" }),
      make("tool.completed", { callId: "complete", name: "complete_task", output: "ok", turnId: 1, effectRevision: 1 }),
      make("run.completed", {})
    ];

    expect(reduceAgentEvents(events).postAnswerChurn).toMatchObject({
      answerSeq: 2,
      events: 0,
      modelTurns: 0,
      toolCalls: 0,
      durationMs: 0
    });
  });

  it("uses only the latest run boundary and resets answer churn after a follow-up", () => {
    const first = eventFactory("multi-run", "run-1");
    const second = eventFactory("multi-run", "run-2");
    const events = [
      first("run.started"), first("model.completed", { text: "first answer", toolCalls: [] }), first("run.completed"),
      second("run.started"), second("model.completed", { text: "draft answer", toolCalls: [] }),
      second("user.follow_up", { text: "continue" }), second("model.started", { turnId: 2 })
    ].map((item, index) => ({ ...item, seq: index + 1, eventId: `multi-${index + 1}` }));

    const metrics = reduceAgentEvents(events);
    expect(metrics.terminal.status).toBe("incomplete");
    expect(metrics.counts.modelTurns).toBe(1);
    expect(metrics.postAnswerChurn).toMatchObject({ answerSeq: null, events: 0, toolCalls: 0 });
  });
});

describe("V3 historical session audit", () => {
  it("resolves workspace state, validates official records, selects latest or exact sessions, and writes versioned reports", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-workspace-"));
    const stateHome = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-state-"));
    const stateRoot = await resolveWorkspaceStateRoot(workspace, {
      env: { SIGMA_STATE_HOME: stateHome },
      platform: "win32",
      homeDir: workspace
    });
    const oldMake = eventFactory("old-session", "old-run");
    const newMake = eventFactory("new-session", "new-run");
    const oldEvents = [oldMake("session.created"), oldMake("run.started", { mode: "analyze" }), oldMake("run.completed", { message: "done" })];
    const newEvents = [newMake("session.created"), newMake("run.started", { mode: "change" }), newMake("run.cancelled", { reason: "cancelled" })];
    await writeSession(stateRoot, "old-session", "2026-07-12T01:00:00.000Z", oldEvents);
    await writeSession(stateRoot, "new-session", "2026-07-12T02:00:00.000Z", newEvents);

    expect((await listV3Sessions(stateRoot)).map((item) => item.sessionId)).toEqual(["new-session", "old-session"]);
    await expect(readV3Session(stateRoot, "new-session")).resolves.toMatchObject({ meta: { lastSeq: 3 } });

    const latest = await auditSessions({
      workspace,
      stateRoot,
      latest: 1,
      generatedAt: "2026-07-12T03:00:00.000Z"
    });
    expect(latest).toMatchObject({
      schemaVersion: 1,
      kind: "sigma.agent-session-audit",
      selection: { latest: 1, sessionIds: ["new-session"] },
      summary: { sessionCount: 1 },
      sessions: [{ schemaVersion: 1, sessionId: "new-session" }]
    });

    const exact = await auditSessions({ workspace, stateRoot, sessionIds: ["old-session"], generatedAt: "2026-07-12T03:00:00.000Z" });
    expect(exact.selection).toEqual({ latest: null, sessionIds: ["old-session"] });
    const output = path.join(workspace, "audit-output");
    const written = await writeSessionAudit(exact, output);
    expect(JSON.parse(await readFile(written.jsonPath, "utf8"))).toMatchObject({ schemaVersion: 1, summary: { sessionCount: 1 } });
    expect(await readFile(written.markdownPath, "utf8")).toContain("# Sigma Agent Session Audit");
    expect(renderSessionAuditMarkdown(exact)).toContain("Session old-session");
  });

  it("rejects checksum corruption and metadata/event disagreement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-corrupt-"));
    const make = eventFactory("corrupt-session");
    const events = [make("session.created")];
    await writeSession(root, "corrupt-session", "2026-07-12T01:00:00.000Z", events);
    const file = path.join(root, "stores", "v3", "sessions", "corrupt-session", "events", "000001.jsonl");
    const stored = JSON.parse((await readFile(file, "utf8")).trim());
    stored.checksum = "0".repeat(64);
    await writeFile(file, `${JSON.stringify(stored)}\n`, "utf8");
    await expect(readV3Session(root, "corrupt-session")).rejects.toThrow("checksum mismatch");

    await writeFile(file, storedLine(events[0]), "utf8");
    const metaPath = path.join(root, "stores", "v3", "sessions", "corrupt-session", "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.lastSeq = 2;
    await writeFile(metaPath, `${JSON.stringify(meta)}\n`, "utf8");
    await expect(readV3Session(root, "corrupt-session")).rejects.toThrow("metadata/event mismatch");
  });
});
