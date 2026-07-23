import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function clonedBaselineRecoveryRepository(): Promise<{
  root: string;
  localRecovery: string;
  cloneTip: string;
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sigma-clone-baseline-"));
  workspaces.push(parent);
  const source = path.join(parent, "source");
  const root = path.join(parent, "clone");
  await mkdir(source);
  git(source, ["init", "-q", "--initial-branch=main"]);
  git(source, ["config", "user.email", "sigma@example.invalid"]);
  git(source, ["config", "user.name", "Sigma"]);
  await writeFile(path.join(source, "base.txt"), "base\n", "utf8");
  git(source, ["add", "base.txt"]);
  git(source, ["commit", "-qm", "base"]);
  const base = git(source, ["rev-parse", "HEAD"]);
  await writeFile(path.join(source, "upstream.txt"), "upstream\n", "utf8");
  git(source, ["add", "upstream.txt"]);
  git(source, ["commit", "-qm", "upstream baseline"]);

  git(parent, ["clone", "-q", source, root]);
  git(root, ["config", "user.email", "sigma@example.invalid"]);
  git(root, ["config", "user.name", "Sigma"]);
  const cloneTip = git(root, ["rev-parse", "HEAD"]);
  git(root, ["remote", "remove", "origin"]);
  git(root, ["reset", "--hard", base]);
  git(root, ["checkout", "-q", "--detach", base]);
  await writeFile(path.join(root, "local.txt"), "local recovery\n", "utf8");
  git(root, ["add", "local.txt"]);
  git(root, ["commit", "-qm", "local recovery"]);
  const localRecovery = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-q", "main"]);
  return { root, localRecovery, cloneTip };
}

async function divergedRecoveryRepository(): Promise<{
  root: string;
  currentHead: string;
  recoveryHead: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-diverged-recovery-"));
  workspaces.push(root);
  git(root, ["init", "-q", "--initial-branch=main"]);
  git(root, ["config", "user.email", "sigma@example.invalid"]);
  git(root, ["config", "user.name", "Sigma"]);
  await writeFile(path.join(root, "base.txt"), "base\n", "utf8");
  git(root, ["add", "base.txt"]);
  git(root, ["commit", "-qm", "base"]);
  git(root, ["checkout", "-qb", "lost-work"]);
  await writeFile(path.join(root, "recovered.txt"), "recovered\n", "utf8");
  git(root, ["add", "recovered.txt"]);
  git(root, ["commit", "-qm", "recover this work"]);
  const recoveryHead = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-q", "main"]);
  await writeFile(path.join(root, "current.txt"), "current\n", "utf8");
  git(root, ["add", "current.txt"]);
  git(root, ["commit", "-qm", "current main work"]);
  const currentHead = git(root, ["rev-parse", "HEAD"]);
  git(root, ["branch", "-D", "lost-work"]);
  return { root, currentHead, recoveryHead };
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
  goalEpoch: number
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
    mutationFrontierStateDigest: "a".repeat(64)
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
  it("does not treat an unreachable clone baseline as lost local work", async () => {
    const fixture = await clonedBaselineRecoveryRepository();
    const broker = createHostExecutionBroker();
    brokers.push(broker);
    const tools = registry(broker, new RepositoryRecoverySelectionStore());

    const receipt = await execute(tools, fixture.root, "repository_inspect", {}, 1);
    expect(receipt.ok).toBe(true);
    const result = receipt.result as any;
    expect(result.recoveryCandidates.map((item: any) => item.object))
      .toEqual([fixture.localRecovery]);
    expect(result.recoveryCandidates.map((item: any) => item.object))
      .not.toContain(fixture.cloneTip);
    expect(result.selectionStatus).toMatchObject({
      status: "selected",
      selectionKind: "unique"
    });
  });

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
      selectionStatus: { status: "model_choice_available" }
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
    expect(result.recoveryCandidates.every((item: any) =>
      typeof item.selectionEvidenceId === "string")).toBe(true);
    expect(receipt.evidence?.filter((item) =>
      item.kind === "repository_recovery_selection")).toHaveLength(
      result.recoveryCandidates.length
    );
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
    const selectionEvidenceId =
      (first.result as any).recoveryCandidates[0].selectionEvidenceId as string;

    const recovered = await execute(tools, fixture.root, "git_transaction", {
      action: "recover",
      repository: ".",
      candidateId: candidate.candidateId,
      selectionEvidenceId
    }, 1);

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

  it("merges a diverged recovery candidate without discarding the current branch", async () => {
    const fixture = await divergedRecoveryRepository();
    const broker = createHostExecutionBroker();
    brokers.push(broker);
    const selections = new RepositoryRecoverySelectionStore();
    const tools = registry(broker, selections);
    const inspected = await execute(tools, fixture.root, "repository_inspect", {}, 1);
    const candidate = (inspected.result as any).recoveryCandidates[0] as {
      candidateId: string;
      relationToHead: string;
    };
    const selectionEvidenceId =
      (inspected.result as any).selectionStatus.selectionEvidenceId as string;
    expect(candidate.relationToHead).toBe("diverged");

    const recovered = await execute(tools, fixture.root, "git_transaction", {
      action: "recover",
      repository: ".",
      candidateId: candidate.candidateId,
      selectionEvidenceId
    }, 1);

    expect(recovered.ok).toBe(true);
    const finalHead = git(fixture.root, ["rev-parse", "HEAD"]);
    expect(finalHead).not.toBe(fixture.currentHead);
    expect(finalHead).not.toBe(fixture.recoveryHead);
    expect(() => git(fixture.root, [
      "merge-base", "--is-ancestor", fixture.currentHead, finalHead
    ])).not.toThrow();
    expect(() => git(fixture.root, [
      "merge-base", "--is-ancestor", fixture.recoveryHead, finalHead
    ])).not.toThrow();
    expect(recovered.evidence?.find((item) => item.kind === "repository_delta"))
      .toMatchObject({ data: {
        operations: ["merge"],
        semanticAssertions: {
          head: finalHead,
          targetAssertions: {
            selectedHead: fixture.recoveryHead,
            selectedSymbolicRef: "refs/heads/main",
            requiredReachableObjects: expect.arrayContaining([
              fixture.currentHead,
              fixture.recoveryHead
            ]),
            satisfied: true
          }
        }
      } });
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
    const selectionEvidenceId =
      (first.result as any).recoveryCandidates[0].selectionEvidenceId as string;
    const before = git(fixture.root, ["rev-parse", "HEAD"]);
    await writeFile(path.join(fixture.root, "drift.txt"), "drift\n", "utf8");

    await expect(execute(tools, fixture.root, "git_transaction", {
      action: "recover",
      repository: ".",
      candidateId: candidate.candidateId,
      selectionEvidenceId
    }, 1)).rejects.toMatchObject({ code: "repository_recovery_selection_stale" });
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(before);
  }, 60_000);
});
