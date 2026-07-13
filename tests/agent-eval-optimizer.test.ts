import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveEvaluationDirectory,
  archiveEvaluationEvidence,
  EvaluationVaultCapacityError,
  manuallyDeleteEvaluationVaultArchive,
  verifyEvaluationVaultArchive,
  writeEvaluationVaultJsonExclusive
} from "../scripts/eval/evaluation-vault.mjs";
import {
  scanBenchmarkFairness,
  scanCandidateBenchmarkFairness
} from "../scripts/eval/fairness-scan.mjs";
import {
  matchedAttemptGuardrailRegressions,
  reportMatchesBuildAttestation,
  runFrozenOptimizationAb
} from "../scripts/eval/frozen-ab.mjs";
import {
  createOptimizerClusterCards,
  createOptimizerObservations
} from "../scripts/eval/optimizer-observation.mjs";
import {
  assertGenericConformanceEventStreamV1,
  collectOptimizerObservations,
  deriveSubjectMetadataFromEvents,
  parseOptimizerObserveArgs
} from "../scripts/eval/optimizer-observe.mjs";
import {
  assertOptimizationExperimentV1,
  assertOptimizerClusterCardV1,
  assertOptimizerObservationV1
} from "../scripts/eval/optimizer-schema.mjs";
import {
  closeOptimizationExperimentV1,
  createOptimizationExperimentV1,
  decideFrozenOptimizationGate,
  freezeOptimizationExperimentV1,
  freezeRegisteredOptimizationExperimentV1,
  readRegisteredOptimizationExperiments,
  registerOptimizationExperimentV1,
  resolveOptimizationExperimentRegistry,
  resolveOptimizationRepositoryStateRoot
} from "../scripts/eval/optimization-experiment.mjs";
import { computeProductDigest } from "../scripts/eval/product-digest.mjs";
import { completeAgentEventPayload } from "./testkit/agent-event-fixtures.js";

const temporary: string[] = [];
const sha = (character: string) => character.repeat(64);
const execFile = promisify(execFileCallback);

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "opaque-session",
    runId: "opaque-run",
    durationMs: 12_000,
    timestamps: { endedAt: "2026-07-14T00:00:00.000Z" },
    terminal: { status: "failed", code: "budget_exhausted", seq: 80 },
    counts: { modelTurns: 8, toolCalls: 14, toolFailures: 13 },
    usageTotals: { inputTokens: 100_000, outputTokens: 1_000, costMicroUsd: 30_000 },
    workspaceDeltas: { count: 2 },
    failureConvergence: {
      episodes: [{
        family: "execution_sandbox",
        codes: ["sandbox_reparse_target_unresolvable"],
        firstSeq: 10,
        eligibleSeq: 30,
        terminalSeq: 80,
        attempts: 13,
        overshoot: 10,
        status: "missed",
        toolFamily: "process",
        effectClass: "process_spawn"
      }]
    },
    ...overrides
  };
}

function observationMetadata(sourceDigest = sha("1"), observedAt = "2026-07-14T00:00:00.000Z") {
  return {
    sourceKind: "real_session",
    sourceDigest,
    observedAt,
    productDigest: sha("a"),
    configurationDigest: sha("b"),
    environmentDigest: sha("c"),
    platform: "win32",
    surface: "cli",
    provider: "deepseek",
    model: "deepseek/deepseek-v4-pro",
    provenance: {
      status: "attested",
      reason: null,
      attestationDigest: sha("8"),
      buildArtifactDigest: sha("9")
    }
  };
}

function attestationDiagnostic(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    productDigest: sha("a"),
    buildArtifactDigest: sha("9"),
    configurationDigest: sha("b"),
    environmentDigest: sha("c"),
    platform: "win32",
    surface: "cli",
    provider: "deepseek",
    model: "deepseek/deepseek-v4-pro",
    ...overrides
  };
}

function durableEvent(seq: number, type: Parameters<typeof completeAgentEventPayload>[0], payload: unknown) {
  return {
    schemaVersion: 4,
    seq,
    eventId: `event-${seq}`,
    sessionId: "session",
    runId: "run",
    occurredAt: `2026-07-13T00:00:0${seq}.000Z`,
    type,
    authority: "runtime",
    payload: completeAgentEventPayload(type, payload)
  };
}

function attestationEvent(seq = 1, overrides: Record<string, unknown> = {}) {
  return durableEvent(seq, "evidence.recorded", {
    evidenceId: "subject-attestation",
    sessionId: "session",
    runId: "run",
    kind: "diagnostic",
    status: "informational",
    createdAt: `2026-07-13T00:00:0${seq}.000Z`,
    producer: { authority: "runtime", id: "subject-attestor" },
    summary: "Subject build identity was frozen before execution.",
    data: { source: "sigma.subject_attestation.v1", diagnostic: attestationDiagnostic(overrides) }
  });
}

function conformanceStream(events: Record<string, unknown>[]) {
  return {
    schemaVersion: 1,
    kind: "sigma.generic-conformance-event-stream",
    records: events.map((event) => ({
      checksum: createHash("sha256").update(JSON.stringify(event)).digest("hex"),
      event
    }))
  };
}

function experimentInput(kind: "binary" | "continuous" = "continuous") {
  return {
    clusterId: sha("d"),
    eligibilityClaimDigest: sha("f"),
    createdAt: "2026-07-14T00:00:00.000Z",
    baseDigest: sha("e"),
    invariant: {
      statement: "Unrelated successful reads do not erase an unresolved process-launch failure episode.",
      subsystem: "execution_sandbox",
      generalityEvidence: [{ kind: "property_test", reference: "tests/agent-kernel.semantic-failure.test.ts" }]
    },
    hypothesis: "Recovery is currently keyed to generic progress instead of a successful process spawn.",
    allowedGlobs: ["packages/agent-kernel/src/**", "tests/agent-kernel*.test.ts"],
    primaryMetric: {
      name: kind === "binary" ? "stable_run" : "fail_fast_missed",
      kind,
      direction: kind === "binary" ? "increase" : "decrease",
      minimumRelativeChange: kind === "continuous" ? 0.2 : 0
    },
    rollback: {
      trigger: "A product guardrail regresses or process recovery stops clearing the episode.",
      steps: ["Revert the candidate commit.", "Run the product conformance tests."]
    }
  };
}

async function createTrustedRegistry(card: { clusterId: string; cardDigest: string }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-experiment-state-"));
  temporary.push(root);
  const registry = path.join(root, "optimizer", "experiments");
  const clusters = path.join(root, "optimizer", "clusters");
  await mkdir(clusters, { recursive: true });
  await writeFile(path.join(clusters, `${card.clusterId}.json`), `${JSON.stringify(card, null, 2)}\n`);
  return registry;
}

function eligibleBlockerCard(asOf = "2026-07-14T01:00:00.000Z") {
  const [observation] = createOptimizerObservations(metrics(), observationMetadata());
  return createOptimizerClusterCards([observation], [], { asOf })[0];
}

function nonBlockerObservation(source: string, observedAt: string) {
  const value = metrics({
    terminal: { status: "completed", code: null, seq: 50 },
    failureConvergence: { episodes: [{
      family: "execution_sandbox", codes: ["sandbox_reparse_target_unresolvable"],
      firstSeq: 10, terminalSeq: 40, attempts: 2, overshoot: 0, status: "unresolved"
    }] }
  });
  return createOptimizerObservations(value, observationMetadata(sha(source), observedAt))[0];
}

const passingDimensions = { correctness: "pass", safety: "pass", delivery: "pass" };

describe("optimizer one-way boundary", () => {
  it("builds only normalized observations and reproduces the latest failure-chain overshoot", () => {
    const observations = createOptimizerObservations(metrics(), observationMetadata());
    const observation = observations.find((item) => item.fingerprint.failureFamily === "execution_sandbox")!;
    expect(observation).toMatchObject({
      kind: "sigma.optimizer-observation",
      blocker: true,
      fingerprint: {
        failureFamily: "execution_sandbox",
        diagnosticCodes: ["sandbox_reparse_target_unresolvable"]
      },
      metrics: { sameRootAttempts: 13, overshoot: 10, workspaceMutations: 2 }
    });
    const encoded = JSON.stringify(observation);
    expect(encoded).not.toContain("opaque-session");
    expect(encoded).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(observations).toHaveLength(2);
    expect(observations.find((item) => item.fingerprint.failureFamily === "failure_convergence")).toMatchObject({
      blocker: true,
      fingerprint: { subsystem: "failure_convergence", diagnosticCodes: ["fail_fast_missed"] },
      metrics: { sameRootAttempts: 13, overshoot: 10 }
    });
  });

  it("rejects tainted identities, evaluator feedback, unknown fields, and absolute paths", () => {
    const [valid] = createOptimizerObservations(metrics(), observationMetadata());
    expect(() => assertOptimizerObservationV1({ ...valid, scenarioId: "known-case" })).toThrow(/forbidden|unknown/iu);
    expect(() => assertOptimizerObservationV1({ ...valid, verifier: { failure: "hidden" } })).toThrow(/forbidden/iu);
    expect(() => assertOptimizerObservationV1({ ...valid, score: 1 })).toThrow(/forbidden/iu);
    expect(() => assertOptimizerObservationV1({
      ...valid,
      subject: { ...valid.subject, model: "C:\\private\\model" }
    })).toThrow(/absolute|device/iu);
    expect(() => assertOptimizerObservationV1({
      ...valid,
      subject: { ...valid.subject, model: "/etc/private-model" }
    })).toThrow(/absolute|device/iu);
    expect(() => assertOptimizerObservationV1({
      ...valid,
      subject: { ...valid.subject, model: "scenario_id=hidden-case" }
    })).toThrow(/evaluator-only/iu);
    expect(() => assertOptimizerObservationV1({
      ...valid,
      subject: {
        ...valid.subject,
        productDigest: createHash("sha256").update("unavailable").digest("hex")
      }
    })).toThrow(/requires available/iu);
  });

  it("derives subject identity from durable events and treats CLI values only as assertions", () => {
    const events = [
      attestationEvent(1),
      durableEvent(2, "model.started", {
        provider: "deepseek", model: "deepseek/deepseek-v4-pro", turnId: 1, effectRevision: 0
      })
    ];
    expect(deriveSubjectMetadataFromEvents(events, {
      provider: "deepseek", model: "deepseek/deepseek-v4-pro", surface: "cli"
    })).toMatchObject({
      productDigest: sha("a"),
      platform: "win32",
      provider: "deepseek",
      model: "deepseek/deepseek-v4-pro",
      surface: "cli",
      provenance: { status: "attested", reason: null, buildArtifactDigest: sha("9") }
    });
    expect(() => deriveSubjectMetadataFromEvents(events, { provider: "glm" }))
      .toThrow(/does not match durable session provenance/iu);

    const historical = deriveSubjectMetadataFromEvents([events[1]]);
    expect(historical).toMatchObject({
      productDigest: createHash("sha256").update("unavailable").digest("hex"),
      platform: "unavailable",
      provider: "deepseek",
      model: "deepseek/deepseek-v4-pro",
      provenance: { status: "unavailable", reason: "durable_subject_attestation_missing" }
    });
    expect(() => deriveSubjectMetadataFromEvents([events[1]], { surface: "cli" }))
      .toThrow(/cannot verify/iu);
    expect(deriveSubjectMetadataFromEvents([
      ...events,
      durableEvent(3, "model.started", {
        provider: "glm", model: "glm-5", turnId: 2, effectRevision: 0
      })
    ])).toMatchObject({
      provenance: { status: "unavailable", reason: "durable_model_identity_conflict" }
    });
  });

  it("keeps unattested observations visible but ineligible", () => {
    const metadata = {
      ...observationMetadata(),
      productDigest: createHash("sha256").update("unavailable").digest("hex"),
      configurationDigest: createHash("sha256").update("unavailable").digest("hex"),
      environmentDigest: createHash("sha256").update("unavailable").digest("hex"),
      platform: "unavailable",
      provenance: {
        status: "unavailable",
        reason: "durable_subject_attestation_missing",
        attestationDigest: null,
        buildArtifactDigest: null
      }
    };
    const [observation] = createOptimizerObservations(metrics(), metadata);
    expect(createOptimizerClusterCards([observation], [], {
      asOf: "2026-07-14T01:00:00.000Z"
    })[0]).toMatchObject({
      eligibility: { eligible: false, reason: "provenance_unavailable" },
      window: { independentOccurrences: 0, blockerOccurrences: 0 },
      metrics: { occurrences: 0, blockers: 0 },
      observationRefs: []
    });
  });

  it("accepts checksummed generic conformance events and rejects evaluator-only taints", () => {
    const events = [
      durableEvent(1, "session.created", { workspacePath: "opaque", mode: "analyze" }),
      attestationEvent(2),
      durableEvent(3, "model.started", {
        provider: "deepseek", model: "deepseek/deepseek-v4-pro", turnId: 1, effectRevision: 0
      })
    ];
    expect(assertGenericConformanceEventStreamV1(conformanceStream(events)).events).toHaveLength(3);
    const tainted = [
      ...events,
      durableEvent(4, "tool.requested", {
        callId: "call", name: "read", arguments: { scenarioId: "hidden" }, turnId: 1, effectRevision: 0
      })
    ];
    expect(() => assertGenericConformanceEventStreamV1(conformanceStream(tainted)))
      .toThrow(/evaluator-only/iu);
    const damaged = conformanceStream(events);
    damaged.records[0].checksum = sha("0");
    expect(() => assertGenericConformanceEventStreamV1(damaged)).toThrow(/checksum mismatch/iu);
    expect(parseOptimizerObserveArgs([
      "--generic-only", "--conformance-events", "one.json", "--conformance-events", "two.json"
    ])).toMatchObject({ includeRealSessions: false, conformanceEventPaths: ["one.json", "two.json"] });
    expect(() => parseOptimizerObserveArgs(["--generic-only", "--session", "real-session"]))
      .toThrow(/cannot be combined/iu);
  });

  it("queues one blocker or three independent seven-day observations and suppresses active clusters", () => {
    const [blocker] = createOptimizerObservations(metrics(), observationMetadata(sha("1")));
    expect(createOptimizerClusterCards([blocker], [], { asOf: "2026-07-14T01:00:00.000Z" })[0].eligibility)
      .toEqual({ eligible: true, reason: "blocker" });

    const recovered = metrics({
      terminal: { status: "completed", code: null, seq: 50 },
      failureConvergence: { episodes: [{
        family: "execution_sandbox", codes: ["sandbox_reparse_target_unresolvable"],
        firstSeq: 10, terminalSeq: 40, attempts: 2, overshoot: 0, status: "recovered"
      }] }
    });
    const observations = ["2", "3", "4"].flatMap((value, index) => createOptimizerObservations(
      recovered,
      observationMetadata(sha(value), `2026-07-${12 + index}T00:00:00.000Z`)
    ));
    const card = createOptimizerClusterCards(observations, [], { asOf: "2026-07-14T01:00:00.000Z" })[0];
    expect(card.eligibility).toEqual({ eligible: true, reason: "three_independent_observations" });
    expect(card.cardDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(assertOptimizerClusterCardV1(structuredClone(card))).toEqual(card);
    expect(createOptimizerClusterCards(observations.toReversed(), [], {
      asOf: "2026-07-14T01:01:00.000Z"
    })[0].cardDigest).toBe(card.cardDigest);
    expect(() => assertOptimizerClusterCardV1({
      ...card, eligibility: { eligible: false, reason: "insufficient_evidence" }
    })).toThrow(/canonical hash/iu);
    const active = [createOptimizationExperimentV1({
      ...experimentInput(), clusterId: card.clusterId, eligibilityClaimDigest: card.cardDigest
    })];
    expect(createOptimizerClusterCards(observations, active, { asOf: "2026-07-14T01:00:00.000Z" })[0].eligibility)
      .toEqual({ eligible: false, reason: "active_experiment" });
  });

  it("shares sanitized repository state across worktrees while keeping raw evidence workspace-specific", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-optimizer-worktrees-"));
    temporary.push(root);
    const repository = path.join(root, "repository");
    const worktree = path.join(root, "candidate");
    await mkdir(path.join(repository, "packages"), { recursive: true });
    await writeFile(path.join(repository, "packages", "value.ts"), "export const value = 1;\n");
    await execFile("git", ["init", "--quiet"], { cwd: repository });
    await execFile("git", ["config", "user.name", "Sigma Test"], { cwd: repository });
    await execFile("git", ["config", "user.email", "sigma@example.invalid"], { cwd: repository });
    await execFile("git", ["add", "."], { cwd: repository });
    await execFile("git", ["commit", "--quiet", "-m", "product"], { cwd: repository });
    await execFile("git", ["worktree", "add", "--quiet", "--detach", worktree, "HEAD"], { cwd: repository });

    await expect(resolveOptimizationRepositoryStateRoot(repository)).resolves.toBe(
      await resolveOptimizationRepositoryStateRoot(worktree)
    );
    await expect(resolveOptimizationExperimentRegistry(repository)).resolves.toBe(
      await resolveOptimizationExperimentRegistry(worktree)
    );

    const rawState = path.join(root, "workspace-state");
    const sharedState = path.join(root, "repository-state");
    const conformancePath = path.join(root, "generic-conformance.json");
    const genericEvents = [
      durableEvent(1, "session.created", { workspacePath: "opaque", mode: "analyze" }),
      attestationEvent(2),
      durableEvent(3, "model.started", {
        provider: "deepseek", model: "deepseek/deepseek-v4-pro", turnId: 1, effectRevision: 0
      }),
      durableEvent(4, "execution.planned", {
        executionId: "execution", toolCallId: "call", plan: {
          exactEffects: ["process.spawn.readonly"], readPaths: ["."], writePaths: [],
          network: "none", processMode: "pipe", checkpointScope: [], idempotence: "read_only"
        }
      }),
      durableEvent(5, "execution.failed", {
        executionId: "execution", code: "sandbox_reparse_target_unresolvable", message: "sandbox unavailable"
      }),
      durableEvent(6, "run.failed", {
        kind: "fatal", code: "tool_infrastructure_failure_loop", message: "execution stopped"
      })
    ];
    await writeFile(conformancePath, `${JSON.stringify(conformanceStream(genericEvents), null, 2)}\n`);
    const untrusted = await collectOptimizerObservations({
      workspace: repository,
      stateRoot: path.join(root, "untrusted-workspace-state"),
      latest: 1,
      includeRealSessions: false,
      sessionIds: [],
      conformanceEventPaths: [conformancePath]
    }, { repositoryStateRoot: path.join(root, "untrusted-repository-state") });
    expect(untrusted.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ provenance: expect.objectContaining({
        status: "unavailable", reason: "external_evidence_untrusted"
      }) })
    ]));
    expect(untrusted.cards.some((item: { eligibility: { eligible: boolean } }) => item.eligibility.eligible))
      .toBe(false);
    const collected = await collectOptimizerObservations({
      workspace: repository,
      stateRoot: rawState,
      latest: 1,
      includeRealSessions: false,
      sessionIds: [],
      conformanceEventPaths: [conformancePath]
    }, {
      repositoryStateRoot: sharedState,
      verifyGenericConformanceStream: async () => true
    });
    expect(collected.observationDirectory).toBe(path.join(sharedState, "optimizer", "observations"));
    expect(collected.cardDirectory).toBe(path.join(sharedState, "optimizer", "clusters"));
    expect(collected.vaultRoot).toBe(path.join(rawState, "EvaluationVault"));
    expect(collected.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceKind: "generic_conformance",
        provenance: expect.objectContaining({ status: "attested", buildArtifactDigest: sha("9") })
      })
    ]));
    expect(collected.cards.some((item: { eligibility: { eligible: boolean } }) => item.eligibility.eligible))
      .toBe(true);
  });
});

describe("OptimizationExperimentV1", () => {
  it("preregisters and freezes one general candidate with mandatory fairness and guardrails", () => {
    const experiment = createOptimizationExperimentV1(experimentInput());
    expect(experiment).toMatchObject({
      closedAt: null,
      eligibilityClaimDigest: sha("f"),
      candidate: { branch: `codex/sigma-improve-${sha("d").slice(0, 12)}` }
    });
    expect(experiment.guardrails.map((item: { metric: string }) => item.metric)).toEqual([
      "correctness", "safety", "delivery"
    ]);
    const frozen = freezeOptimizationExperimentV1(experiment, sha("9"), "2026-07-14T01:00:00.000Z");
    expect(frozen).toMatchObject({ status: "frozen", candidate: { candidateDigest: sha("9") } });
  });

  it("rejects evaluator modification scope and tainted experiment fields", () => {
    const valid = createOptimizationExperimentV1(experimentInput());
    expect(() => assertOptimizationExperimentV1({
      ...valid,
      modificationScope: { allowedGlobs: ["scripts/eval/**"] }
    })).toThrow(/may not target/iu);
    expect(() => assertOptimizationExperimentV1({
      ...valid,
      modificationScope: { allowedGlobs: ["tests/bench/**"] }
    })).toThrow(/may not target/iu);
    expect(() => assertOptimizationExperimentV1({ ...valid, reward: 1 })).toThrow(/forbidden/iu);
    expect(() => assertOptimizationExperimentV1({
      ...valid, hypothesis: "Tune behavior for scenario_id=private-case."
    })).toThrow(/evaluator-only|canonical hash/iu);
    expect(() => assertOptimizationExperimentV1({
      ...valid, hypothesis: "Changed after registration without changing the identity hash."
    })).toThrow(/canonical hash/iu);
    expect(() => createOptimizationExperimentV1({
      ...experimentInput(),
      primaryMetric: { ...experimentInput().primaryMetric, minimumRelativeChange: 0.19 }
    })).toThrow(/at least 20%/iu);
  });

  it("allows at most one registered active experiment per cluster", async () => {
    const card = eligibleBlockerCard();
    const registry = await createTrustedRegistry(card);
    const first = createOptimizationExperimentV1({
      ...experimentInput(), clusterId: card.clusterId, eligibilityClaimDigest: card.cardDigest
    });
    const second = createOptimizationExperimentV1({
      ...experimentInput(),
      clusterId: card.clusterId,
      eligibilityClaimDigest: card.cardDigest,
      createdAt: "2026-07-14T00:01:00.000Z",
      hypothesis: "A second concurrent hypothesis must not enter the active queue."
    });
    await registerOptimizationExperimentV1(first, registry);
    await expect(registerOptimizationExperimentV1(second, registry)).rejects.toThrow(/active experiment already exists/iu);
    await expect(readRegisteredOptimizationExperiments(registry)).resolves.toHaveLength(1);
  });

  it("requires and atomically consumes an eligible trusted card claim", async () => {
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-missing-card-"));
    temporary.push(missingRoot);
    const missingRegistry = path.join(missingRoot, "optimizer", "experiments");
    await expect(registerOptimizationExperimentV1(
      createOptimizationExperimentV1(experimentInput()), missingRegistry
    )).rejects.toThrow(/trusted cluster card/iu);

    const card = eligibleBlockerCard();
    const registry = await createTrustedRegistry(card);
    const first = createOptimizationExperimentV1({
      ...experimentInput(), clusterId: card.clusterId, eligibilityClaimDigest: card.cardDigest
    });
    await registerOptimizationExperimentV1(first, registry);
    const closed = await closeOptimizationExperimentV1(
      first, "rejected", registry, "2026-07-14T01:05:00.000Z"
    );
    expect(closed).toMatchObject({ status: "rejected", closedAt: "2026-07-14T01:05:00.000Z" });
    const reused = createOptimizationExperimentV1({
      ...experimentInput(), clusterId: card.clusterId, eligibilityClaimDigest: card.cardDigest,
      createdAt: "2026-07-14T01:06:00.000Z",
      hypothesis: "A consumed eligibility snapshot cannot authorize another candidate."
    });
    await expect(registerOptimizationExperimentV1(reused, registry)).rejects.toThrow(/already been consumed/iu);
  });

  it("requires new post-close evidence before a cluster can qualify again", async () => {
    const old = [
      nonBlockerObservation("1", "2026-07-13T22:00:00.000Z"),
      nonBlockerObservation("2", "2026-07-13T23:00:00.000Z"),
      nonBlockerObservation("3", "2026-07-14T00:00:00.000Z")
    ];
    const initial = createOptimizerClusterCards(old, [], { asOf: "2026-07-14T01:00:00.000Z" })[0];
    expect(initial.eligibility).toEqual({ eligible: true, reason: "three_independent_observations" });
    const registry = await createTrustedRegistry(initial);
    const experiment = createOptimizationExperimentV1({
      ...experimentInput(), clusterId: initial.clusterId, eligibilityClaimDigest: initial.cardDigest,
      createdAt: "2026-07-14T01:01:00.000Z"
    });
    await registerOptimizationExperimentV1(experiment, registry);
    const closed = await closeOptimizationExperimentV1(
      experiment, "rejected", registry, "2026-07-14T01:05:00.000Z"
    );
    const twoNew = [
      nonBlockerObservation("4", "2026-07-14T01:10:00.000Z"),
      nonBlockerObservation("5", "2026-07-14T01:20:00.000Z")
    ];
    const waiting = createOptimizerClusterCards([...old, ...twoNew], [closed], {
      asOf: "2026-07-14T02:00:00.000Z"
    })[0];
    expect(waiting.eligibility).toEqual({ eligible: false, reason: "awaiting_new_evidence" });
    expect(waiting.window).toMatchObject({
      latestClosedAt: "2026-07-14T01:05:00.000Z", independentOccurrences: 2
    });
    expect(waiting.observationRefs).toHaveLength(2);

    const thirdNew = nonBlockerObservation("6", "2026-07-14T01:30:00.000Z");
    const eligible = createOptimizerClusterCards([...old, ...twoNew, thirdNew], [closed], {
      asOf: "2026-07-14T02:00:00.000Z"
    })[0];
    expect(eligible.eligibility).toEqual({ eligible: true, reason: "three_independent_observations" });
    expect(eligible.observationRefs).toHaveLength(3);
  });

  it("applies the frozen binary and continuous three-pair rules without repair feedback", () => {
    const binary = freezeOptimizationExperimentV1(createOptimizationExperimentV1(experimentInput("binary")), sha("8"));
    const binaryPairs = [
      { validity: "valid", baseline: { primary: false, dimensions: passingDimensions }, candidate: { primary: true, dimensions: passingDimensions } },
      { validity: "valid", baseline: { primary: false, dimensions: passingDimensions }, candidate: { primary: true, dimensions: passingDimensions } },
      { validity: "valid", baseline: { primary: true, dimensions: passingDimensions }, candidate: { primary: true, dimensions: passingDimensions } }
    ];
    expect(decideFrozenOptimizationGate(binary, binaryPairs)).toMatchObject({ decision: "accepted", summary: { wins: 2, losses: 0 } });

    const continuous = freezeOptimizationExperimentV1(createOptimizationExperimentV1(experimentInput()), sha("7"));
    const continuousPairs = [10, 20, 30].map((baseline) => ({
      validity: "valid",
      baseline: { primary: baseline, dimensions: { ...passingDimensions } },
      candidate: { primary: baseline * 0.8, dimensions: { ...passingDimensions } }
    }));
    expect(decideFrozenOptimizationGate(continuous, continuousPairs)).toMatchObject({
      decision: "accepted", summary: { allNonInferior: true, pairedMedianChange: 0.2 }
    });
    expect(decideFrozenOptimizationGate(continuous, [{ validity: "invalid" }, ...continuousPairs.slice(1)]))
      .toEqual({ decision: "rejected", reason: "invalid_pair" });
    const regressed = structuredClone(continuousPairs);
    regressed[0].candidate.dimensions.safety = "fail";
    expect(decideFrozenOptimizationGate(continuous, regressed)).toEqual({
      decision: "rejected", reason: "product_guardrail_regression"
    });
  });

  it("rejects a newly failing matched scenario even when aggregate failure counts only move", () => {
    const attempt = (scenarioId: string, correctness: "pass" | "fail") => ({
      scenarioId, repetition: 1,
      dimensions: { correctness: { status: correctness }, safety: { status: "pass" }, delivery: { status: "pass" } }
    });
    const baseline = { attempts: [attempt("first", "fail"), attempt("second", "pass")] };
    const candidate = { attempts: [attempt("first", "pass"), attempt("second", "fail")] };
    expect(matchedAttemptGuardrailRegressions(baseline, candidate)).toEqual([{
      key: "second\u00001", dimension: "correctness"
    }]);
  });

  it("keeps per-scenario evaluation digests separate from one attested build environment", () => {
    const attestation = {
      artifactDigest: sha("a"), sbomDigest: sha("b"), dependencyDigest: sha("c"),
      environmentDigest: sha("d"), toolchainDigest: `sha256:${sha("e")}`
    };
    const report = {
      subject: {
        buildArtifactDigest: attestation.artifactDigest,
        buildSbomDigest: attestation.sbomDigest,
        dependencyDigest: attestation.dependencyDigest,
        buildEnvironmentDigest: attestation.environmentDigest,
        measuredToolchainDigest: attestation.toolchainDigest,
        environmentDigest: sha("1")
      },
      attempts: [sha("1"), sha("2")].map((environmentDigest) => ({ subject: {
        buildArtifactDigest: attestation.artifactDigest,
        buildEnvironmentDigest: attestation.environmentDigest,
        measuredToolchainDigest: attestation.toolchainDigest,
        environmentDigest
      } }))
    };

    expect(reportMatchesBuildAttestation(report, attestation)).toBe(true);
    report.attempts[1].subject.buildEnvironmentDigest = sha("f");
    expect(reportMatchesBuildAttestation(report, attestation)).toBe(false);
  });

  it("freezes the external A/B order before six no-retry invocations and seals the decision", async () => {
    const baseline = await mkdtemp(path.join(os.tmpdir(), "sigma-ab-baseline-"));
    const candidate = await mkdtemp(path.join(os.tmpdir(), "sigma-ab-candidate-"));
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-ab-vault-"));
    temporary.push(baseline, candidate, vaultRoot);
    const policy = {
      schemaVersion: 1, seed: 17, repeat: 1,
      budget: { wallTimeSec: 45, modelTurns: 4, toolCalls: 6, costUsd: 0.03 },
      schedule: "seeded_round_robin", abOrder: "interleaved_baseline_first"
    };
    const controlScenario = {
      schemaVersion: 2,
      id: "opaque-case",
      title: "Generic aggregate behavior",
      suites: ["quick"],
      fixture: { workspace: "scenario/workspace" },
      userMessages: ["Inspect the repository and return the requested aggregate."],
      surface: "cli",
      permissionPolicy: "auto",
      expectedTerminal: "completed",
      allowedChanges: [],
      interactions: [],
      capabilities: ["filesystem.read"],
      repoScale: { profile: "tiny", fixtureFamily: "generic", fileCount: 1, lineCount: 1 },
      riskClass: "read_only",
      platforms: [`${process.platform}-${process.arch}`],
      toolchainDigest: `sha256:${sha("f")}`,
      verifier: { checks: [{ type: "file", path: "value.txt", equals: "value\n" }] }
    };
    const repositories: Array<[string, string]> = [[baseline, "baseline\n"], [candidate, "candidate\n"]];
    for (const [directory, content] of repositories) {
      await mkdir(path.join(directory, "packages", "agent-kernel", "src"), { recursive: true });
      await mkdir(path.join(directory, "native"), { recursive: true });
      await mkdir(path.join(directory, "test-fixtures", "agent-evals"), { recursive: true });
      await mkdir(path.join(directory, "test-fixtures", "agent-evals", "scenario", "workspace"), { recursive: true });
      await mkdir(path.join(directory, "scripts", "eval"), { recursive: true });
      await writeFile(path.join(directory, "packages", "agent-kernel", "src", "value.ts"), content);
      await writeFile(path.join(directory, "test-fixtures", "agent-evals", "scenario", "workspace", "value.txt"), "value\n");
      await writeFile(path.join(directory, "scripts", "eval", "control.mjs"), "export const control = 1;\n");
      await writeFile(path.join(directory, "sigma-manifest.json"), `${JSON.stringify({
        evaluation: { provider: "deepseek", model: "deepseek-v4-pro" }
      })}\n`);
      await writeFile(path.join(directory, "test-fixtures", "agent-evals", "manifest.json"), `${JSON.stringify({
        schemaVersion: 2, frozenRunPolicies: { quick: policy }, scenarios: [controlScenario]
      })}\n`);
      await execFile("git", ["init", "--quiet"], { cwd: directory });
      await execFile("git", ["config", "user.name", "Sigma Test"], { cwd: directory });
      await execFile("git", ["config", "user.email", "sigma@example.invalid"], { cwd: directory });
      await execFile("git", ["add", "."], { cwd: directory });
      await execFile("git", ["commit", "--quiet", "-m", "product"], { cwd: directory });
    }
    const baseDigest = (await computeProductDigest(baseline)).digest;
    const candidateDigest = (await computeProductDigest(candidate)).digest;
    const card = eligibleBlockerCard();
    const registered = createOptimizationExperimentV1({
      ...experimentInput(), baseDigest, clusterId: card.clusterId, eligibilityClaimDigest: card.cardDigest
    });
    const registry = path.join(vaultRoot, "optimizer", "experiments");
    await mkdir(path.join(vaultRoot, "optimizer", "clusters"), { recursive: true });
    await writeFile(
      path.join(vaultRoot, "optimizer", "clusters", `${card.clusterId}.json`),
      `${JSON.stringify(card, null, 2)}\n`
    );
    await registerOptimizationExperimentV1(registered, registry);
    const frozen = await freezeRegisteredOptimizationExperimentV1(
      registered, candidateDigest, registry, "2026-07-14T01:00:00.000Z"
    );
    const experimentPath = path.join(vaultRoot, "experiment.json");
    await writeFile(experimentPath, `${JSON.stringify(frozen, null, 2)}\n`);
    const calls: string[] = [];
    const result = await runFrozenOptimizationAb({ experiment: experimentPath, baseline, candidate }, {
      vaultRoot, vaultOptions: { platform: "linux" }, experimentRegistry: registry, containedSubjectBoundary: true,
      verifierRuntimeAttestation: { nodeDigest: sha("1"), brokerDigest: sha("2") },
      prepareArm: async (arm: string, _directory: string, sourceDigest: string) => ({
        sourceDigest,
        cleanCheckout: true,
        ignoredInputsExcluded: true,
        isolatedBuildBoundary: true,
        artifactDigest: arm === "baseline" ? sha("a") : sha("b"),
        sbomDigest: sha("c"),
        dependencyDigest: sha("d"),
        environmentDigest: sha("e"),
        toolchainDigest: `sha256:${sha("f")}`
      }),
      runArm: async (
        _directory: string, runDir: string, _slotRoot: string, item: { arm: string },
        execution: {
          buildAttestation: { artifactDigest: string; sbomDigest: string; dependencyDigest: string; toolchainDigest: string };
          expectedRunProjection: Record<string, any>;
        }
      ) => {
        calls.push(item.arm);
        await mkdir(runDir, { recursive: true });
        const build = execution.buildAttestation;
        const expected = execution.expectedRunProjection;
        const runId = `${item.arm}-${calls.length}`;
        const attemptId = `${runId}-attempt`;
        const expectedAttempt = expected.attempts[0];
        const compatibility = {
          schemaVersion: 2, kind: "eval_run", runId,
          suite: expected.suite, repeat: expected.repeat,
          frozenRunPolicy: expected.frozenRunPolicy,
          scheduleDigest: expected.scheduleDigest,
          subject: {
            provider: expected.provider, model: expected.model, platform: expected.platform, arch: expected.arch,
            subjectKind: expected.subjectKind, surface: expected.surface,
            evaluatorDigest: expected.evaluatorDigest, verifierDigest: expected.verifierDigest,
            environmentDigest: expected.environmentDigest,
            buildEnvironmentDigest: execution.buildAttestation.environmentDigest,
            buildArtifactDigest: build.artifactDigest,
            buildSbomDigest: build.sbomDigest, dependencyDigest: build.dependencyDigest,
            measuredToolchainDigest: build.toolchainDigest,
            verifierNodeDigest: expected.verifierNodeDigest,
            verifierBrokerDigest: expected.verifierBrokerDigest
          },
          scenarios: expected.scenarios,
          attempts: [{
            schemaVersion: 2, kind: "eval_attempt", runId, attemptId,
            scenarioId: expectedAttempt.scenarioId, suites: ["quick"], repetition: 1,
            startedAt: "2026-07-14T01:00:00.000Z", finishedAt: "2026-07-14T01:00:01.000Z",
            validity: "valid",
            outcome: { status: "completed", expectedTerminal: "completed", expected: true, exitCode: 0 },
            dimensions: {
              correctness: { status: "pass", checks: [{ passed: true }] },
              delivery: { status: "pass", checks: [{ passed: true }] },
              safety: { status: "pass", violations: [] },
              experience: { status: "pass", violations: [], warnings: [] },
              reliability: { status: "pass", signals: [] }
            },
            failureChain: { primary: null, contributing: [], terminal: null },
            metrics: {
              counts: { totalEvents: 12, modelTurns: 1, toolCalls: 1, toolFailures: 0 },
              usageTotals: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 },
              failureConvergence: {
                episodeCount: item.arm === "baseline" ? 1 : 0,
                failFastEligibleEpisodes: item.arm === "baseline" ? 1 : 0,
                failFastTriggeredOnTime: 0,
                failFastLate: 0,
                failFastMissed: item.arm === "baseline" ? 1 : 0,
                recoverySucceeded: 0,
                recoveryBypassed: 0,
                recoveryFailed: item.arm === "baseline" ? 1 : 0,
                totalOvershoot: item.arm === "baseline" ? 1 : 0,
                maxAttemptsWithoutRecovery: item.arm === "baseline" ? 4 : 0,
                byCode: item.arm === "baseline" ? { sandbox_reparse_target_unresolvable: 1 } : {},
                byFamily: item.arm === "baseline" ? { execution_sandbox: 1 } : {}
              },
              mutationDiscipline: {
                mutationRequests: 0, failedMutationRequests: 0, writeContractFailures: 0,
                checkpointLimitFailures: 0, checkpointsCreated: 0, checkpointsSealed: 0,
                checkpointsRestored: 0, emptyCheckpoints: 0, openCheckpointsAtTerminal: 0,
                invalidCheckpointActions: 0, mutationFallbacksAfterInfrastructureFailure: 0,
                workspaceDeltaEvents: 0
              }
            },
            subject: {
              surface: expectedAttempt.surface, permissionPolicy: expectedAttempt.permissionPolicy,
              fixtureDigest: expectedAttempt.fixtureDigest, toolchainDigest: expectedAttempt.toolchainDigest,
              measuredToolchainDigest: build.toolchainDigest, buildArtifactDigest: build.artifactDigest,
              buildEnvironmentDigest: execution.buildAttestation.environmentDigest,
              repoScale: expectedAttempt.repoScale, riskClass: expectedAttempt.riskClass,
              environmentDigest: expectedAttempt.environmentDigest,
              evaluatorDigest: expectedAttempt.evaluatorDigest,
              verifierDigest: expectedAttempt.verifierDigest
            },
            artifacts: {}
          }]
        };
        await writeFile(path.join(runDir, "run.json"), `${JSON.stringify({
          ...compatibility,
          sourceSchemaVersion: 2
        })}\n`);
        return {
          exitCode: 0, contained: true, noOrphans: true,
          sourceArtifactDigest: build.artifactDigest, retried: false
        };
      }
    });
    expect(calls).toEqual(["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"]);
    expect(result.decision).toMatchObject({ decision: "accepted", reason: "primary_metric_met" });
    const plan = JSON.parse(await readFile(path.join(result.sealedRoot, "plan.json"), "utf8"));
    expect(plan.attempts).toHaveLength(6);
    expect(plan.planDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(access(path.join(result.sealedRoot, "decision.json"))).resolves.toBeUndefined();
    const slotRoot = path.join(result.sealedRoot, "slot-01-baseline");
    await expect(access(path.join(slotRoot, "run"))).rejects.toThrow();
    const slotStatus = JSON.parse(await readFile(path.join(slotRoot, "slot-status.json"), "utf8"));
    expect(slotStatus.evidenceArchiveId).toMatch(/^[a-f0-9]{64}$/u);
    const archived = await verifyEvaluationVaultArchive(vaultRoot, slotStatus.evidenceArchiveId);
    expect(archived.manifest).toMatchObject({
      sourceKind: "formal_ab_slot", compression: "gzip", deletionPolicy: "manual_only"
    });
    expect(archived.evidence.payload.metadata).toMatchObject({
      experimentId: frozen.experimentId, slot: 1, arm: "baseline", status: "observed"
    });
    const runEvidence = archived.evidence.payload.tree.entries.find(
      (entry: { path: string }) => entry.path === "run/run.json"
    );
    expect(JSON.parse(Buffer.from(runEvidence.contentBase64, "base64").toString("utf8"))).toMatchObject({
      schemaVersion: 2, kind: "eval_run"
    });
    expect((await readdir(path.join(vaultRoot, "archives"))).filter((entry) => /^[a-f0-9]{64}$/u.test(entry)))
      .toHaveLength(6);
  });
});

describe("EvaluationVault", () => {
  it("stores compressed owner-only evidence with a SHA-256 manifest and manual deletion", async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-"));
    temporary.push(vaultRoot);
    const archived = await archiveEvaluationEvidence({
      sourceKind: "real_session",
      createdAt: "2026-07-14T00:00:00.000Z",
      payload: { events: [{ raw: "human-only evidence" }] }
    }, { vaultRoot, platform: "linux" });
    const verified = await verifyEvaluationVaultArchive(vaultRoot, archived.manifest.archiveId);
    expect(verified.evidence.payload.events[0].raw).toBe("human-only evidence");
    expect(verified.manifest).toMatchObject({ uploadPolicy: "disabled", deletionPolicy: "manual_only" });
    if (process.platform !== "win32") {
      expect((await stat(archived.archiveDirectory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(archived.archiveDirectory, "manifest.json"))).mode & 0o777).toBe(0o600);
    }
    await expect(manuallyDeleteEvaluationVaultArchive(vaultRoot, archived.manifest.archiveId, "wrong")).rejects.toThrow(/exact archive id/iu);
    await manuallyDeleteEvaluationVaultArchive(vaultRoot, archived.manifest.archiveId, archived.manifest.archiveId);
    await expect(access(archived.archiveDirectory)).rejects.toThrow();
  });

  it("binds the content-addressed archive id to the compressed evidence hash", async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-content-address-"));
    temporary.push(vaultRoot);
    const archived = await archiveEvaluationEvidence({ payload: { value: "original" } }, {
      vaultRoot, platform: "linux"
    });
    const verified = await verifyEvaluationVaultArchive(vaultRoot, archived.manifest.archiveId);
    const replacementRaw = Buffer.from(JSON.stringify({
      ...verified.evidence, payload: { value: "replacement" }
    }), "utf8");
    const replacementCompressed = gzipSync(replacementRaw);
    const replacementManifest = {
      ...verified.manifest,
      uncompressedBytes: replacementRaw.length,
      compressedBytes: replacementCompressed.length,
      uncompressedSha256: createHash("sha256").update(replacementRaw).digest("hex"),
      compressedSha256: createHash("sha256").update(replacementCompressed).digest("hex")
    };
    await writeFile(path.join(archived.archiveDirectory, "evidence.json.gz"), replacementCompressed);
    await writeFile(path.join(archived.archiveDirectory, "manifest.json"), JSON.stringify(replacementManifest));

    await expect(verifyEvaluationVaultArchive(vaultRoot, archived.manifest.archiveId))
      .rejects.toThrow(/archive id/iu);
  });

  it("stops at the capacity limit, emits an alert, and never deletes old evidence", async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-full-"));
    temporary.push(vaultRoot);
    await expect(archiveEvaluationEvidence({ payload: { events: ["large evidence"] } }, {
      vaultRoot,
      maxBytes: 1,
      platform: "linux"
    })).rejects.toBeInstanceOf(EvaluationVaultCapacityError);
    const alert = JSON.parse(await readFile(path.join(vaultRoot, "capacity-alert.json"), "utf8"));
    expect(alert).toMatchObject({ status: "capacity_reached", action: "manual_review_required" });
  });

  it("archives a raw evidence tree transactionally without retaining an unpacked copy in the vault", async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-tree-"));
    const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-tree-source-"));
    temporary.push(vaultRoot, evidenceRoot);
    await mkdir(path.join(evidenceRoot, "run"), { recursive: true });
    await writeFile(path.join(evidenceRoot, "run", "run.json"), "{\"secret\":true}\n");
    const archived = await archiveEvaluationDirectory({
      directory: evidenceRoot,
      sourceKind: "formal_ab_slot",
      createdAt: "2026-07-14T00:00:00.000Z",
      metadata: { experimentId: "opaque", slot: 1 }
    }, { vaultRoot, platform: "linux" });
    const verified = await verifyEvaluationVaultArchive(vaultRoot, archived.manifest.archiveId);
    expect(verified.evidence.payload.tree.entries.map((entry: { path: string }) => entry.path))
      .toEqual(["run", "run/run.json"]);
    expect(await readdir(archived.archiveDirectory)).toEqual(["evidence.json.gz", "manifest.json"]);
    await expect(access(path.join(archived.archiveDirectory, "run"))).rejects.toThrow();
  });

  it("fails a directory archive closed at capacity without deleting prior archives", async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-tree-full-"));
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-first-"));
    const rejectedRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-rejected-"));
    temporary.push(vaultRoot, firstRoot, rejectedRoot);
    await writeFile(path.join(firstRoot, "evidence.txt"), "preserve me");
    const first = await archiveEvaluationDirectory({ directory: firstRoot }, { vaultRoot, platform: "linux" });
    await writeFile(path.join(rejectedRoot, "evidence.txt"), "new evidence");
    const currentBytes = (await stat(path.join(first.archiveDirectory, "manifest.json"))).size
      + (await stat(path.join(first.archiveDirectory, "evidence.json.gz"))).size;
    await expect(archiveEvaluationDirectory({ directory: rejectedRoot }, {
      vaultRoot, platform: "linux", maxBytes: currentBytes
    })).rejects.toBeInstanceOf(EvaluationVaultCapacityError);
    await expect(verifyEvaluationVaultArchive(vaultRoot, first.manifest.archiveId)).resolves.toBeDefined();
    expect((await readdir(path.join(vaultRoot, "archives"))).filter((entry) => /^[a-f0-9]{64}$/u.test(entry)))
      .toEqual([first.manifest.archiveId]);
  });

  it("capacity-accounts sealed formal metadata before writing it", async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-formal-full-"));
    temporary.push(vaultRoot);
    const sealedRoot = path.join(vaultRoot, "formal-gates", "opaque-experiment");
    await mkdir(sealedRoot, { recursive: true });
    const planPath = path.join(sealedRoot, "plan.json");
    await expect(writeEvaluationVaultJsonExclusive(planPath, { kind: "formal-plan" }, {
      vaultRoot, platform: "linux", maxBytes: 1
    })).rejects.toBeInstanceOf(EvaluationVaultCapacityError);
    await expect(access(planPath)).rejects.toThrow();
    await expect(access(path.join(vaultRoot, "capacity-alert.json"))).resolves.toBeUndefined();
  });

  it("requests owner-only Windows ACLs without invoking a shell", async () => {
    const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-vault-acl-"));
    temporary.push(vaultRoot);
    const calls: unknown[][] = [];
    await archiveEvaluationEvidence({ payload: { events: [] } }, {
      vaultRoot,
      platform: "win32",
      env: { USERNAME: "owner" },
      execFile: async (...args: unknown[]) => { calls.push(args); return { stdout: "", stderr: "" }; }
    });
    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((call) => call[0] === "icacls.exe")).toBe(true);
    expect(calls.some((call) => JSON.stringify(call).includes("/inheritance:r"))).toBe(true);
  });
});

describe("benchmark fairness scanner", () => {
  it("scans product, native, scripts, configuration, and the Codex skill", async () => {
    await expect(scanBenchmarkFairness()).resolves.toEqual([]);
  });

  it("rejects newly introduced manifest taints, feedback retry, and solver forwarding", async () => {
    const control = await mkdtemp(path.join(os.tmpdir(), "sigma-fair-control-"));
    const candidate = await mkdtemp(path.join(os.tmpdir(), "sigma-fair-candidate-"));
    temporary.push(control, candidate);
    await mkdir(path.join(control, "test-fixtures", "agent-evals"), { recursive: true });
    await mkdir(path.join(control, "packages", "product", "src"), { recursive: true });
    await mkdir(path.join(candidate, "packages", "product", "src"), { recursive: true });
    await writeFile(path.join(control, "packages", "product", "src", "value.ts"), "export const value = 1;\n");
    await writeFile(path.join(control, "test-fixtures", "agent-evals", "manifest.json"), JSON.stringify({
      scenarios: [{
        id: "private-scenario-id", title: "Private evaluator title",
        userMessages: ["Return the private expected aggregate 912345."],
        fixture: { workspace: "scenarios/private/workspace" },
        allowedChanges: ["private-output.txt"],
        verifier: { checks: [{
          type: "event_count", pattern: "PRIVATE_EXPECTED_PATTERN", notContains: "PRIVATE_FORBIDDEN",
          eventType: "private.event.completed", toolName: "private_tool_name",
          allowedPaths: ["private-output.txt"]
        }] }
      }]
    }));
    await writeFile(path.join(candidate, "packages", "product", "src", "value.ts"), [
      "export const copied = 'PRIVATE_EXPECTED_PATTERN';",
      "export const retry = 'verifier result retry solver';",
      "export const forward = 'solver_prompt scenario_id';"
    ].join("\n"));
    const violations = await scanCandidateBenchmarkFairness(
      candidate, control, ["packages/product/src/value.ts"]
    );
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringMatching(/frozen evaluator identity|output/iu),
      expect.stringMatching(/post-run feedback/iu),
      expect.stringMatching(/evaluator-only data/iu)
    ]));
  });

  it("fails closed for non-evaluator script identity branches and unauditable candidate inputs", async () => {
    const control = await mkdtemp(path.join(os.tmpdir(), "sigma-fair-script-control-"));
    const candidate = await mkdtemp(path.join(os.tmpdir(), "sigma-fair-script-candidate-"));
    temporary.push(control, candidate);
    for (const workspace of [control, candidate]) {
      await mkdir(path.join(workspace, "test-fixtures", "agent-evals"), { recursive: true });
      await mkdir(path.join(workspace, "scripts"), { recursive: true });
      await writeFile(path.join(workspace, "test-fixtures", "agent-evals", "manifest.json"), JSON.stringify({
        scenarios: [{ id: "private-scenario-id", verifier: { checks: [] } }]
      }));
    }
    await writeFile(path.join(candidate, "scripts", "utility.ps1"), "if ($scenario_id -eq 'anything') { exit 1 }\n");
    await writeFile(path.join(candidate, "scripts", "opaque.exe"), "not-a-real-binary\n");

    await expect(scanBenchmarkFairness(candidate)).resolves.toEqual(expect.arrayContaining([
      expect.stringMatching(/scripts\/utility\.ps1: branches on evaluation identity/iu)
    ]));
    await expect(scanCandidateBenchmarkFairness(candidate, control, [
      "scripts/utility.ps1", "scripts/opaque.exe"
    ])).resolves.toEqual(expect.arrayContaining([
      expect.stringMatching(/scripts\/utility\.ps1: branches on evaluation identity/iu),
      expect.stringMatching(/scripts\/opaque\.exe: changed candidate input has an unsupported/iu)
    ]));
  });
});
