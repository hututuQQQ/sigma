import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listV5Sessions, readV5Session, resolveWorkspaceStateRoot } from "../scripts/eval/event-store.mjs";
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
      schemaVersion: 5,
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
  const directory = path.join(root, "stores", "v5", "sessions", sessionId);
  await mkdir(path.join(directory, "events"), { recursive: true });
  await writeFile(path.join(directory, "events", "000001.jsonl"), events.map(storedLine).join(""), "utf8");
  await writeFile(path.join(directory, "meta.json"), `${JSON.stringify({
    schemaVersion: 5,
    eventSchemaVersion: 5,
    snapshotSchemaVersion: 5,
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
    expect(metrics.repeatedExactRequests).toMatchObject({ total: 130, unique: 60, repeated: 70 });
    expect(metrics.repeatedExactRequests.rate).toBeCloseTo(70 / 130);
    expect(metrics.repeatedOutputs.repeated).toBe(128);
    expect(metrics.consecutiveToolFailures).toMatchObject({ longest: 38 });
    expect(metrics.consecutiveToolFailures.streaks[0]).toMatchObject({ count: 38, tools: { read_file: 38 } });
    expect(metrics.stagnationWindows[0]).toMatchObject({
      workUnits: 127,
      modelTurns: 21,
      toolCalls: 91,
      compactions: 15,
      repeatedRequests: 70
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

    expect(metrics.postAnswerChurn).toMatchObject({ answerSeq: 10, events: 0, modelTurns: 0, toolCalls: 0 });
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

  it("recognizes an answer paired with runtime finalization without counting coordinator work as churn", () => {
    const make = eventFactory("completion-session");
    const events = [
      make("run.started", { mode: "change" }),
      make("model.completed", {
        text: "Done.",
        toolCalls: [{ id: "complete", name: "runtime_finalize", arguments: {} }],
        turnId: 1,
        effectRevision: 1
      }),
      make("tool.requested", { callId: "complete", name: "runtime_finalize", arguments: {}, turnId: 1, effectRevision: 1 }),
      make("execution.started", { executionId: "complete" }),
      make("execution.completed", { executionId: "complete" }),
      make("tool.completed", { callId: "complete", name: "runtime_finalize", output: "ok", turnId: 1, effectRevision: 1 }),
      make("run.completed", {})
    ];

    expect(reduceAgentEvents(events).postAnswerChurn).toMatchObject({
      answerSeq: 6,
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

  it("clusters typed sandbox failures across actions, deduplicates execution/tool evidence, and measures ten-call overshoot", () => {
    const make = eventFactory("sandbox-episode");
    const events = [make("run.started", { mode: "analyze" })];
    for (let index = 0; index < 13; index += 1) {
      const callId = `process-${index}`;
      events.push(make("execution.planned", {
        executionId: callId,
        toolCallId: callId,
        plan: { exactEffects: ["process.spawn.readonly"], processMode: "pipe" }
      }));
      events.push(make("tool.requested", { callId, name: "execute", arguments: { variant: index } }));
      events.push(make("execution.failed", {
        executionId: callId,
        code: "sandbox_reparse_target_unresolvable",
        message: "redacted"
      }));
      events.push(make("tool.failed", {
        callId,
        name: "execute",
        ok: false,
        output: "redacted",
        diagnostics: ["sandbox_reparse_target_unresolvable"]
      }));
      if (index === 4) {
        events.push(make("tool.completed", {
          callId: "read-success",
          name: "read_file",
          ok: true,
          output: "ok",
          observedEffects: ["filesystem.read"]
        }));
      }
    }
    events.push(make("run.failed", {
      kind: "recoverable_failure", code: "budget_exhausted", message: "budget exhausted"
    }));

    const convergence = reduceAgentEvents(events).failureConvergence;
    expect(convergence).toMatchObject({
      episodeCount: 1,
      byFamily: { execution_sandbox: 13 },
      failFastEligibleEpisodes: 1,
      failFastMissed: 1,
      totalOvershoot: 10,
      recoveryFailed: 1
    });
    expect(convergence.episodes[0]).toMatchObject({
      family: "execution_sandbox", attempts: 13, overshoot: 10, failFastMissed: true
    });
    expect(convergence.episodes[0].evidenceSeq).toHaveLength(26);
  });

  it("requires a successful process spawn to recover an execution cluster and ignores generic denials", () => {
    const make = eventFactory("sandbox-recovery");
    const events = [make("run.started", { mode: "analyze" })];
    for (let index = 0; index < 3; index += 1) {
      const executionId = `failed-${index}`;
      events.push(make("execution.failed", { executionId, code: "sandbox_setup_failed", message: "redacted" }));
    }
    events.push(make("tool.completed", {
      callId: "read", name: "list_files", ok: true, output: "ok", observedEffects: ["filesystem.read"]
    }));
    events.push(make("execution.failed", { executionId: "generic", code: "policy_denied", message: "redacted" }));
    events.push(make("tool.failed", {
      callId: "exit", name: "execute", ok: false, output: "redacted", diagnostics: ["exit_code=125"]
    }));
    events.push(make("process.spawned", {
      processId: "process", executionId: "recovery", mode: "pipe", brokerInstanceId: "broker"
    }));
    events.push(make("run.completed", { kind: "completed", message: "done", evidence: [] }));

    const convergence = reduceAgentEvents(events).failureConvergence;
    expect(convergence).toMatchObject({
      episodeCount: 1,
      recoverySucceeded: 1,
      recoveryFailed: 0,
      failFastTriggeredOnTime: 0,
      failFastMissed: 0
    });
    expect(convergence.episodes[0]).toMatchObject({ attempts: 3, status: "recovered", overshoot: 0 });
  });

  it("scopes duplicate requests to workspace and effect revisions", () => {
    const make = eventFactory("revision-aware");
    const request = (callId: string, effectRevision: number) => make("tool.requested", {
      callId, name: "read_file", arguments: { path: "same" }, effectRevision
    });
    const events = [
      make("run.started", { mode: "change" }),
      make("model.started", { turnId: 1, effectRevision: 1 }),
      request("read-1", 1), request("read-2", 1),
      make("model.started", { turnId: 2, effectRevision: 2 }),
      request("read-3", 2),
      make("tool.completed", {
        callId: "write", name: "write_file", ok: true, output: "ok",
        observedEffects: ["filesystem.write"],
        workspaceDelta: { added: [], modified: ["changed"], deleted: [] }
      }),
      make("model.started", { turnId: 3, effectRevision: 3 }),
      request("read-4", 3), request("read-5", 3),
      make("run.completed", { kind: "completed", message: "done", evidence: [] })
    ];

    expect(reduceAgentEvents(events).repeatedExactRequests).toMatchObject({
      total: 5, unique: 3, repeated: 2, rate: 0.4
    });
  });

  it("tracks write contracts and checkpoint lifecycle without treating plans as workspace writes", () => {
    const make = eventFactory("mutation-discipline");
    const checkpoint = (checkpointId: string, status: string, delta?: Record<string, string[]>) => ({
      checkpointId, sessionId: "mutation-discipline", runId: "run", status,
      createdAt: new Date(epoch).toISOString(), preManifestDigest: "pre", ...(delta ? { delta } : {})
    });
    const events = [
      make("run.started", { mode: "analyze" }),
      make("execution.planned", {
        executionId: "execution-mutation", toolCallId: "tool-mutation",
        plan: { exactEffects: ["filesystem.write"], processMode: "none" }
      }),
      make("execution.failed", { executionId: "execution-mutation", code: "write_scope_required", message: "redacted" }),
      make("tool.failed", {
        callId: "tool-mutation", name: "write_file", ok: false, output: "redacted",
        diagnostics: ["write_scope_required"]
      }),
      make("checkpoint.created", checkpoint("empty", "open")),
      make("checkpoint.sealed", checkpoint("empty", "sealed", { added: [], modified: [], deleted: [] })),
      make("checkpoint.restored", checkpoint("restored-without-delta", "restored")),
      make("checkpoint.created", checkpoint("left-open", "open")),
      make("execution.failed", { executionId: "limit", code: "checkpoint_limit_exceeded", message: "redacted" }),
      make("run.failed", { kind: "fatal", code: "budget_exhausted", message: "done" })
    ];

    expect(reduceAgentEvents(events).mutationDiscipline).toEqual({
      mutationRequests: 1,
      failedMutationRequests: 1,
      writeContractFailures: 1,
      checkpointLimitFailures: 1,
      checkpointsCreated: 2,
      checkpointsSealed: 1,
      checkpointsRestored: 1,
      emptyCheckpoints: 1,
      openCheckpointsAtTerminal: 1,
      invalidCheckpointActions: 0,
      mutationFallbacksAfterInfrastructureFailure: 0,
      workspaceDeltaEvents: 0
    });
  });
});

describe("V5 historical session audit", () => {
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
    const created = (mode: "analyze" | "change") => ({
      workspacePath: "D:/workspace", mode, title: "audit", writeScope: ["."],
      strictWriteScope: true, modelRole: "orchestrator"
    });
    const oldEvents = [
      oldMake("session.created", created("analyze")),
      oldMake("run.started", { mode: "analyze", deadlineAt: "2026-07-12T04:00:00.000Z" }),
      oldMake("run.completed", { kind: "completed", message: "done", evidence: [], outcomeRevision: 2 })
    ];
    const newEvents = [
      newMake("session.created", created("change")),
      newMake("run.started", { mode: "change", deadlineAt: "2026-07-12T04:00:00.000Z" }),
      newMake("run.cancelled", { kind: "cancelled", reason: "cancelled", outcomeRevision: 2 })
    ];
    await writeSession(stateRoot, "old-session", "2026-07-12T01:00:00.000Z", oldEvents);
    await writeSession(stateRoot, "new-session", "2026-07-12T02:00:00.000Z", newEvents);

    expect((await listV5Sessions(stateRoot)).map((item) => item.sessionId)).toEqual(["new-session", "old-session"]);
    await expect(readV5Session(stateRoot, "new-session")).resolves.toMatchObject({ meta: { lastSeq: 3 } });

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
    const events = [make("session.created", {
      workspacePath: "D:/workspace", mode: "change", title: "audit", writeScope: ["."],
      strictWriteScope: true, modelRole: "orchestrator"
    })];
    await writeSession(root, "corrupt-session", "2026-07-12T01:00:00.000Z", events);
    const file = path.join(root, "stores", "v5", "sessions", "corrupt-session", "events", "000001.jsonl");
    const stored = JSON.parse((await readFile(file, "utf8")).trim());
    stored.checksum = "0".repeat(64);
    await writeFile(file, `${JSON.stringify(stored)}\n`, "utf8");
    await expect(readV5Session(root, "corrupt-session")).rejects.toThrow("checksum mismatch");

    await writeFile(file, storedLine(events[0]), "utf8");
    const metaPath = path.join(root, "stores", "v5", "sessions", "corrupt-session", "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.lastSeq = 2;
    await writeFile(metaPath, `${JSON.stringify(meta)}\n`, "utf8");
    await expect(readV5Session(root, "corrupt-session")).rejects.toThrow("metadata/event mismatch");
  });
});
