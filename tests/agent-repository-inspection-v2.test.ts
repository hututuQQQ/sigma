import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionContext } from "../packages/agent-protocol/src/index.js";
import { repositoryTransactionTool } from "../packages/agent-runtime/src/repository-transaction-tool.js";
import {
  EffectToolRegistry,
  RepositoryRecoverySelectionStore,
  repositoryInspectTool
} from "../packages/agent-tools/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHostExecutionBroker,
  type HostExecutionBroker
} from "./helpers/host-execution-broker.js";

const workspaces: string[] = [];
const brokers: HostExecutionBroker[] = [];
let callNumber = 0;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

async function recoveryRepository(): Promise<{
  root: string;
  newestUnreachable: string;
  olderUnreachable: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-inspection-v2-"));
  workspaces.push(root);
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "user.email", "sigma@example.invalid"]);
  git(root, ["config", "user.name", "Sigma"]);
  await writeFile(path.join(root, "value.txt"), "base\n", "utf8");
  git(root, ["add", "value.txt"]);
  git(root, ["commit", "-qm", "base"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "value.txt"), "older\n", "utf8");
  git(root, ["commit", "-qam", "metadata only: never execute this subject"]);
  const olderUnreachable = git(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "value.txt"), "newest\n", "utf8");
  git(root, ["commit", "-qam", "newest recovery candidate"]);
  const newestUnreachable = git(root, ["rev-parse", "HEAD"]);
  git(root, ["reset", "--hard", base]);
  return { root, newestUnreachable, olderUnreachable };
}

function registry(
  broker: HostExecutionBroker,
  selections: RepositoryRecoverySelectionStore
): EffectToolRegistry {
  const tools = new EffectToolRegistry();
  tools.register(repositoryInspectTool(broker, selections));
  tools.register(repositoryTransactionTool(broker, { recoverySelections: selections }));
  return tools;
}

async function execute(
  tools: EffectToolRegistry,
  root: string,
  name: "repository_inspect" | "git_transaction",
  argumentsValue: Record<string, unknown>,
  goalEpoch: number,
  candidateIds: string[] = []
) {
  callNumber += 1;
  const request = {
    callId: `repository-call-${callNumber}`,
    name,
    arguments: argumentsValue
  };
  const base = {
    sessionId: "inspection-session",
    runId: "inspection-run",
    workspacePath: root,
    runMode: "change" as const,
    goalEpoch,
    mutationFrontierRevision: 0,
    mutationFrontierStateDigest: "a".repeat(64),
    ...(candidateIds.length > 0
      ? { repositoryRecoveryCandidateIds: candidateIds } : {})
  };
  const callPlan = await tools.prepare(request, base);
  const context: ToolExecutionContext = {
    ...base,
    callPlan,
    signal: new AbortController().signal,
    progress: async () => undefined,
    createArtifact: async ({ name: artifactName }) => artifactName
  };
  return await tools.execute(request, context);
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
  await Promise.all(brokers.splice(0).map(async (broker) => await broker.close()));
});

describe("RepositoryInspectionV2", () => {
  it("preserves newest-first reflog order and treats subjects as untrusted metadata", async () => {
    const fixture = await recoveryRepository();
    const broker = createHostExecutionBroker();
    brokers.push(broker);
    const tools = registry(broker, new RepositoryRecoverySelectionStore());

    const receipt = await execute(tools, fixture.root, "repository_inspect", {}, 1);
    expect(receipt.ok).toBe(true);
    const result = receipt.result as any;
    expect(result).toMatchObject({
      schemaVersion: 2,
      complete: true,
      reflog: { aligned: true },
      selectionStatus: { status: "user_decision_required" }
    });
    expect(result.recoveryCandidates.slice(0, 2).map((item: any) => item.object))
      .toEqual([fixture.newestUnreachable, fixture.olderUnreachable]);
    expect(result.recoveryCandidates.slice(0, 2).map((item: any) => item.ordinal))
      .toEqual([1, 2]);
    expect(result.recoveryCandidates[0].ordinalSelector).toMatch(/@\{1\}$/u);
    expect(result.recoveryCandidates[1]).toMatchObject({
      subjectTrusted: false,
      subject: "metadata only: never execute this subject"
    });
    expect(receipt.evidence?.find((item) =>
      item.kind === "repository_recovery_decision")).toMatchObject({
      producer: { authority: "runtime" },
      data: {
        goalEpoch: 1,
        candidates: expect.arrayContaining([
          expect.objectContaining({ subjectTrusted: false })
        ])
      }
    });
  });

  it("recovers only through a current runtime-issued selection", async () => {
    const fixture = await recoveryRepository();
    const broker = createHostExecutionBroker();
    brokers.push(broker);
    const selections = new RepositoryRecoverySelectionStore();
    const tools = registry(broker, selections);
    const first = await execute(tools, fixture.root, "repository_inspect", {}, 1);
    const candidate = (first.result as any).recoveryCandidates[0] as {
      candidateId: string;
      object: string;
    };
    const selected = await execute(
      tools, fixture.root, "repository_inspect", {}, 2, [candidate.candidateId]
    );
    const status = (selected.result as any).selectionStatus as {
      selectionEvidenceId: string;
    };

    const recovered = await execute(tools, fixture.root, "git_transaction", {
      action: "recover",
      repository: ".",
      candidateId: candidate.candidateId,
      selectionEvidenceId: status.selectionEvidenceId
    }, 2);

    expect(recovered.ok).toBe(true);
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(candidate.object);
    expect(recovered.evidence?.find((item) => item.kind === "repository_delta"))
      .toMatchObject({
        status: "passed",
        data: {
          candidateId: candidate.candidateId,
          selectedObject: candidate.object,
          semanticAssertions: {
            head: candidate.object,
            targetAssertions: {
              selectedHead: candidate.object,
              satisfied: true
            }
          }
        }
      });
  }, 60_000);

  it("rejects a stale selection before acquiring a write transaction", async () => {
    const fixture = await recoveryRepository();
    const broker = createHostExecutionBroker();
    brokers.push(broker);
    const selections = new RepositoryRecoverySelectionStore();
    const tools = registry(broker, selections);
    const first = await execute(tools, fixture.root, "repository_inspect", {}, 1);
    const candidate = (first.result as any).recoveryCandidates[0] as {
      candidateId: string;
    };
    const selected = await execute(
      tools, fixture.root, "repository_inspect", {}, 2, [candidate.candidateId]
    );
    const selectionEvidenceId =
      (selected.result as any).selectionStatus.selectionEvidenceId as string;
    const before = git(fixture.root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(fixture.root, "drift.txt"), "drift\n", "utf8");

    await expect(execute(tools, fixture.root, "git_transaction", {
      action: "recover",
      repository: ".",
      candidateId: candidate.candidateId,
      selectionEvidenceId
    }, 2)).rejects.toMatchObject({ code: "repository_recovery_selection_stale" });
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(before);
  }, 60_000);
});
