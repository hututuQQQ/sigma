import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SegmentedJsonlStore } from "../packages/agent-store/src/index.js";
import { EffectToolRegistry } from "../packages/agent-tools/src/index.js";
import {
  assertSubjectAttestationContextV1,
  assertSubjectProductAttestationV1,
  createSubjectAttestationContextV1,
  SUBJECT_ATTESTATION_SOURCE_V1
} from "../packages/agent-runtime/src/index.js";
import { createRuntime } from "../packages/agent-runtime/src/testing.js";
import { deriveSubjectMetadataFromEvents } from "../scripts/eval/optimizer-observe.mjs";
import { fakeFinalTurn, SmokeFakeGateway } from "../scripts/smoke-fake-model.mjs";

const temporary: string[] = [];
const sha = (character: string): string => character.repeat(64);

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (directory) =>
    await rm(directory, { recursive: true, force: true })));
});

function productAttestation() {
  return {
    schemaVersion: 1 as const,
    productDigest: sha("a"),
    buildArtifactDigest: sha("b"),
    environmentDigest: sha("c"),
    platform: process.platform as "win32" | "linux"
  };
}

describe("runtime subject attestation", () => {
  it("rejects unavailable or evaluator-shaped launcher input", () => {
    expect(() => assertSubjectProductAttestationV1({
      ...productAttestation(),
      taskId: "forbidden"
    })).toThrow(/contain exactly/iu);
    expect(() => assertSubjectProductAttestationV1({
      ...productAttestation(),
      productDigest: "ba691ba042bcedd9a61a36f5969026bc95859dccdc7e47f24e6bce35673baf2f"
    })).toThrow(/available lowercase SHA-256/iu);
    const context = createSubjectAttestationContextV1(
      productAttestation(), { permissionMode: "auto" }, "cli", process.platform
    );
    expect(() => assertSubjectAttestationContextV1({ ...context, verifier: "forbidden" }))
      .toThrow(/contain exactly/iu);
  });

  it("persists one attestation before the first model turn and feeds the collector", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-subject-attestation-"));
    temporary.push(workspace);
    const storeRootDir = path.join(workspace, ".agent");
    const gateway = new SmokeFakeGateway([fakeFinalTurn("Attestation smoke completed.")]);
    const subjectAttestation = createSubjectAttestationContextV1(
      productAttestation(),
      { permissionMode: "auto", networkMode: "none" },
      "cli",
      process.platform
    );
    const runtime = createRuntime({
      gateway,
      store: new SegmentedJsonlStore({ rootDir: storeRootDir }),
      storeRootDir,
      tools: new EffectToolRegistry(),
      permissionMode: "auto",
      runDeadlineMs: 60_000,
      subjectAttestation
    });
    const session = await runtime.createSession({ workspacePath: workspace, mode: "analyze" });
    await runtime.command({
      type: "submit",
      sessionId: session.sessionId,
      text: "Return a concise runtime smoke result.",
      mode: "analyze"
    });
    await runtime.waitForOutcome(session.sessionId);

    const events = [];
    for await (const event of runtime.sessionEvents(session.sessionId)) events.push(event);
    const attestations = events.filter((event) => event.type === "evidence.recorded"
      && (event.payload as { data?: { source?: string } }).data?.source === SUBJECT_ATTESTATION_SOURCE_V1);
    expect(attestations).toHaveLength(1);
    expect(attestations[0]).toMatchObject({
      authority: "runtime",
      payload: {
        producer: { authority: "runtime", id: "subject-attestor" },
        data: { diagnostic: {
          productDigest: sha("a"),
          buildArtifactDigest: sha("b"),
          environmentDigest: sha("c"),
          platform: process.platform,
          surface: "cli",
          provider: "fake",
          model: "smoke-fake-model"
        } }
      }
    });
    expect(attestations[0]!.seq).toBeLessThan(
      events.find((event) => event.type === "model.started")!.seq
    );

    expect(deriveSubjectMetadataFromEvents(events)).toMatchObject({
      productDigest: sha("a"),
      platform: process.platform,
      surface: "cli",
      provider: "fake",
      model: "smoke-fake-model",
      provenance: { status: "attested", buildArtifactDigest: sha("b") }
    });
    expect(() => deriveSubjectMetadataFromEvents(events, { model: "different-model" }))
      .toThrow(/does not match durable session provenance/iu);
    const conflicting = events.map((event) => event.type === "model.started" ? {
      ...event,
      payload: { ...(event.payload as Record<string, unknown>), model: "different-model" }
    } : event);
    expect(deriveSubjectMetadataFromEvents(conflicting)).toMatchObject({
      provenance: { status: "unavailable", reason: "durable_model_identity_conflict" }
    });
  });
});
