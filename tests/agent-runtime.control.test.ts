import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommandEvidence,
  DiagnosticEvidence,
  ToolReceipt
} from "../packages/agent-protocol/src/index.js";
import { BudgetController } from "../packages/agent-runtime/src/budget-controller.js";
import { RuntimeControlService } from "../packages/agent-runtime/src/runtime-control.js";
import type { RuntimeControlServiceOptions } from "../packages/agent-runtime/src/runtime-control-contracts.js";
import { RuntimeEventLog } from "../packages/agent-runtime/src/runtime-event-log.js";
import { materializeLargeToolArtifacts } from "../packages/agent-runtime/src/large-tool-artifacts.js";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import {
  EffectToolRegistry,
  registerBuiltinTools
} from "../packages/agent-tools/src/index.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function commandEvidence(sessionId: string, runId: string): CommandEvidence {
  return {
    evidenceId: "command-proof",
    sessionId,
    runId,
    kind: "command",
    status: "passed",
    createdAt: "2026-01-01T00:00:00.000Z",
    producer: { authority: "tool", id: "shell" },
    summary: "Command completed.",
    data: { command: "test", exitCode: 0 }
  };
}

function receipt(artifactId: string): ToolReceipt {
  return {
    callId: "large-output",
    ok: true,
    output: "large output",
    outcome: { status: "succeeded", output: "large output", diagnosticCodes: [] },
    observedEffects: ["filesystem.read"],
    actualEffects: ["filesystem.read"],
    artifacts: [artifactId],
    artifactRefs: [{
      artifactId,
      name: "large.txt",
      digest: artifactId,
      mediaType: "text/plain; charset=utf-8"
    }],
    diagnostics: [],
    evidence: [],
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z"
  };
}

describe("runtime control tools", () => {
  it("projects a low-friction plan schema and normalizes runtime-owned details", async () => {
    const updateDescriptor = registerBuiltinTools(new EffectToolRegistry()).modelDescriptors()
      .find((descriptor) => descriptor.name === "update_plan")!;
    const properties = updateDescriptor.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toEqual([
      "explanation", "goal", "acceptanceCriteria", "plan"
    ]);
    const stepSchema = (properties.plan as {
      items: { properties: Record<string, unknown> };
    }).items;
    expect(Object.keys(stepSchema.properties)).toEqual([
      "id", "step", "status", "blockedReason"
    ]);
    expect(stepSchema.properties).not.toHaveProperty("expectedRevision");
    expect(stepSchema.properties).not.toHaveProperty("evidenceIds");

    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-plan-"));
    temporaryRoots.push(root);
    const session = runtimeSessionFixture({ workspacePath: root });
    session.durable.state.evidence.push(commandEvidence(
      session.identity.sessionId,
      session.durable.runId
    ));
    const eventLog = new RuntimeEventLog(new SegmentedJsonlStore({ rootDir: root }));
    const emit = eventLog.emit.bind(eventLog);
    const control = new RuntimeControlService({
      checkpoints: {} as RuntimeControlServiceOptions["checkpoints"],
      budgets: new BudgetController(emit),
      emit,
      createArtifact: async () => "a".repeat(64),
      readArtifact: async () => ""
    }).forSession(session);

    const result = await control.updateWorkPlan({
      goal: "implement and verify",
      acceptanceCriteria: ["implementation exists", "checks pass"],
      plan: [{
        id: "implement",
        step: "Implement",
        status: "completed"
      }, {
        id: "verify",
        step: "Verify",
        status: "in_progress"
      }, {
        id: "document",
        step: "Document",
        status: "in_progress"
      }]
    });
    expect(result.status).toBe("normalized");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "multiple_active_steps" })
    ]));
    expect(result.plan.activeStepId).toBe("verify");
    expect(result.plan.plan.filter((step) => step.status === "in_progress")).toHaveLength(1);
    expect(session.durable.state.plan.nodes[0]).toMatchObject({
      owner: { kind: "root" },
      evidence: []
    });
    expect(session.durable.state.plan.activeNodeId).toBe("verify");

    const noActiveProvided = await control.updateWorkPlan({
      goal: "implement and verify",
      plan: [{ id: "verify", step: "Verify", status: "pending" }]
    });
    expect(noActiveProvided.status).toBe("normalized");
    expect(noActiveProvided.plan.activeStepId).toBe("verify");

  });

  it("preserves runtime-owned dependency anchors during a model checklist rewrite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-plan-child-anchor-"));
    temporaryRoots.push(root);
    const session = runtimeSessionFixture({ workspacePath: root });
    session.durable.state.plan = {
      revision: 1,
      goal: "coordinate work",
      activeNodeId: "main",
      nodes: [{
        id: "anchor",
        title: "Prepare child input",
        dependencies: [],
        status: "pending",
        owner: { kind: "root" },
        acceptanceCriteria: [],
        evidence: []
      }, {
        id: "main",
        title: "Main work",
        dependencies: [],
        status: "in_progress",
        owner: { kind: "root" },
        acceptanceCriteria: [],
        evidence: []
      }, {
        id: "child-work",
        title: "Delegated work",
        dependencies: ["anchor"],
        status: "pending",
        owner: { kind: "child", childId: "child-1" },
        acceptanceCriteria: [],
        evidence: []
      }]
    };
    const eventLog = new RuntimeEventLog(new SegmentedJsonlStore({ rootDir: root }));
    const emit = eventLog.emit.bind(eventLog);
    const control = new RuntimeControlService({
      checkpoints: {} as RuntimeControlServiceOptions["checkpoints"],
      budgets: new BudgetController(emit),
      emit,
      createArtifact: async () => "a".repeat(64),
      readArtifact: async () => ""
    }).forSession(session);

    const result = await control.updateWorkPlan({
      goal: "coordinate work",
      plan: [{ id: "main", step: "Main work", status: "in_progress" }]
    });

    expect(result.status).toBe("normalized");
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "runtime_dependency_preserved",
      stepId: "anchor"
    }));
    expect(session.durable.state.plan.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "anchor", owner: { kind: "root" } }),
      expect.objectContaining({
        id: "child-work",
        dependencies: ["anchor"],
        owner: { kind: "child", childId: "child-1" }
      })
    ]));
  });

  it("pages every frontier path with digest-bound cursors", async () => {
    const session = runtimeSessionFixture();
    session.durable.state.mutationFrontier = {
      revision: 3,
      baselineManifestDigest: "a".repeat(64),
      currentStateDigest: "b".repeat(64),
      changedPaths: Array.from({ length: 10_013 }, (_, index) =>
        `packages/p-${String(index).padStart(5, "0")}.ts`),
      sourceCheckpointIds: []
    };
    const control = new RuntimeControlService({
      readArtifact: async () => ""
    } as RuntimeControlServiceOptions).forSession(session);
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await control.readWorkspaceFrontier({ cursor, limit: 500 });
      paths.push(...page.paths);
      cursor = page.nextCursor;
    } while (cursor);
    expect(paths).toHaveLength(10_013);
    expect(new Set(paths).size).toBe(10_013);

    const first = await control.readWorkspaceFrontier({ limit: 100 });
    session.durable.state.mutationFrontier = {
      ...session.durable.state.mutationFrontier,
      revision: 4,
      changedPaths: [...session.durable.state.mutationFrontier.changedPaths, "new.ts"]
    };
    await expect(control.readWorkspaceFrontier({ cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "frontier_cursor_stale" });
  });

  it("reads only receipt-referenced artifacts with UTF-8-safe paging", async () => {
    const content = Buffer.from("你好，Sigma🙂", "utf8");
    const artifactId = createHash("sha256").update(content).digest("hex");
    const session = runtimeSessionFixture();
    session.durable.state.receipts.push(receipt(artifactId));
    const service = new RuntimeControlService({
      readArtifact: async () => content.toString("utf8"),
      readArtifactBytes: async () => content
    } as RuntimeControlServiceOptions);
    const control = service.forSession(session);
    const pieces: Buffer[] = [];
    let offset: number | undefined;
    do {
      const page = await control.readArtifact({
        artifactId,
        ...(offset === undefined ? {} : { offsetBytes: offset }),
        maxBytes: 4
      });
      expect(page.digest).toBe(artifactId);
      pieces.push(page.encoding === "utf8"
        ? Buffer.from(page.content, "utf8")
        : Buffer.from(page.content, "base64"));
      offset = page.nextOffset;
    } while (offset !== undefined);
    expect(Buffer.concat(pieces).toString("utf8")).toBe("你好，Sigma🙂");

    const other = runtimeSessionFixture({ sessionId: "other", runId: "other-run" });
    await expect(service.forSession(other).readArtifact({ artifactId }))
      .rejects.toMatchObject({ code: "artifact_not_in_session_receipts" });
  });

  it("allows current-session background settlement artifacts without crossing sessions", async () => {
    const content = Buffer.from("durable background build output", "utf8");
    const artifactId = createHash("sha256").update(content).digest("hex");
    const session = runtimeSessionFixture();
    session.durable.state.evidence.push({
      evidenceId: "process-settlement",
      sessionId: session.identity.sessionId,
      runId: session.durable.runId,
      kind: "diagnostic",
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      producer: { authority: "runtime", id: "process-settlement:build" },
      summary: "Background build settled.",
      data: {
        source: "background_process_settlement",
        diagnostic: {
          schemaVersion: 1,
          processId: "build",
          outputArtifactIds: [artifactId]
        }
      }
    } satisfies DiagnosticEvidence);
    const service = new RuntimeControlService({
      readArtifact: async () => content.toString("utf8"),
      readArtifactBytes: async () => content
    } as RuntimeControlServiceOptions);

    await expect(service.forSession(session).readArtifact({ artifactId }))
      .resolves.toMatchObject({
        artifactId,
        content: "durable background build output",
        eof: true
      });

    const other = runtimeSessionFixture({ sessionId: "other", runId: "other-run" });
    await expect(service.forSession(other).readArtifact({ artifactId }))
      .rejects.toMatchObject({ code: "artifact_not_in_session_receipts" });
  });

  it("externalizes every model-projected output or result over 12,000 characters", async () => {
    const created = new Map<string, string>();
    const base = receipt("unused");
    base.artifacts = [];
    base.artifactRefs = [];
    base.output = "o".repeat(12_001);
    base.result = { payload: "r".repeat(12_001) };
    const materialized = await materializeLargeToolArtifacts(
      "session",
      "generic_tool",
      base,
      async (_sessionId, value) => {
        const content = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
        const id = createHash("sha256").update(content).digest("hex");
        created.set(id, content);
        return id;
      }
    );
    expect(materialized.artifactRefs).toHaveLength(2);
    expect(materialized.artifactRefs?.map((value) => value.name)).toEqual([
      "generic_tool-large-output-output.txt",
      "generic_tool-large-output-result.json"
    ]);
    expect([...created.values()]).toContain(base.output);
    expect([...created.values()]).toContain(JSON.stringify(base.result));
    expect(materialized.output).toBe(base.output);
    expect(materialized.result).toEqual(base.result);
  });
});
