import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CheckpointManager, type CheckpointManagerOptions } from "agent-checkpoint";
import { runProcess, type ProcessExecutionPort } from "agent-platform";
import type { JsonValue, RepositoryDeltaEvidence, ToolCallPlan, ToolDescriptor, ToolReceipt } from "agent-protocol";
import type { PlannedToolExecutionContext, RegisteredEffectTool } from "agent-tools";
import {
  gitInput,
  gitOperationArgs,
  gitOperations,
  gitOperationSchema,
  isDestructiveGitOperation,
  mutatesWorktree,
  type GitOperation
} from "./repository-transaction-schema.js";

export type RepositoryCheckpointLimits = Pick<CheckpointManagerOptions, "maxFiles" | "maxBytes">;
interface GitResult { exitCode: number; stdout: string; stderr: string }

async function repositoryRoot(workspace: string, requested: string): Promise<{ root: string; gitDir: string }> {
  const workspaceRoot = await realpath(path.resolve(workspace));
  const lexical = path.resolve(workspaceRoot, requested);
  const relative = path.relative(workspaceRoot, lexical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Repository path escapes the workspace."), { code: "repository_path_escape" });
  }
  const root = await realpath(lexical);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Repository root must be a stable directory.");
  const gitDir = path.join(root, ".git");
  const gitInfo = await lstat(gitDir).catch(() => null);
  if (!gitInfo?.isDirectory() || gitInfo.isSymbolicLink()) {
    throw Object.assign(new Error("V4 git_transaction supports only a self-contained .git directory."), {
      code: "repository_gitdir_unsupported"
    });
  }
  return { root, gitDir };
}

function repositoryCheckpointManager(
  workspace: string,
  limits: RepositoryCheckpointLimits = {}
): CheckpointManager {
  return new CheckpointManager({
    rootDir: path.join(workspace, ".agent", "repository-checkpoints"),
    excludedNames: [".agent"],
    ...limits
  });
}

async function restoreOpenRepositoryCheckpoint(manager: CheckpointManager, sessionId: string): Promise<void> {
  const open = [...await manager.list(sessionId)].reverse().find((item) => item.status === "open");
  if (!open) return;
  const inspection = await manager.inspectOpen(sessionId, open.checkpointId);
  await manager.restoreOpen(sessionId, open.checkpointId, inspection.currentManifestDigest);
}

/** Restore the CAS-backed .git preimage left by a hard process interruption. */
export async function recoverInterruptedRepositoryTransactions(workspace: string, sessionId: string): Promise<void> {
  try {
    await restoreOpenRepositoryCheckpoint(repositoryCheckpointManager(workspace), sessionId);
  } catch (error) {
    throw Object.assign(new Error("Interrupted repository transaction could not be restored.", { cause: error }), {
      code: "repository_recovery_required"
    });
  }
}

function gitEnvironment(hooks: string): Record<string, string> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(hooks, "global-config-disabled"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true"
  };
}

async function runGit(
  execution: ProcessExecutionPort,
  root: string,
  args: string[],
  hooks: string,
  signal: AbortSignal
): Promise<GitResult> {
  const result = await runProcess({
    execution,
    executable: "git",
    args: ["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", ...args],
    cwd: root,
    env: gitEnvironment(hooks),
    timeoutMs: 600_000,
    maxOutputBytes: 16 * 1024 * 1024,
    signal,
    readRoots: [root],
    writeRoots: [root],
    protectedPaths: [path.join(root, ".agent")],
    network: "none"
  });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function repositoryState(
  execution: ProcessExecutionPort,
  root: string,
  gitDir: string,
  hooks: string,
  signal: AbortSignal
) {
  const command = async (args: string[]): Promise<GitResult> => await runGit(execution, root, args, hooks, signal);
  const headResult = await command(["rev-parse", "--verify", "HEAD"]);
  const refs = await command(["show-ref", "--head"]);
  const objects = await command(["rev-list", "--objects", "--all"]);
  const index = await readFile(path.join(gitDir, "index")).catch(() => Buffer.alloc(0));
  const state = {
    head: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
    refsDigest: sha(refs.stdout),
    indexDigest: sha(index),
    reachableObjects: objects.exitCode === 0 ? objects.stdout.split(/\r?\n/u).filter(Boolean).length : 0
  };
  return { ...state, stateDigest: sha(JSON.stringify(state)) };
}

async function assertNoExternalDrivers(
  execution: ProcessExecutionPort,
  root: string,
  hooks: string,
  signal: AbortSignal
): Promise<void> {
  const config = await runGit(execution, root, ["config", "--local", "--includes", "--get-regexp",
    "^(include(if)?\\..*\\.path|merge\\..*\\.driver|diff\\..*\\.command|filter\\..*\\.(clean|smudge|process)|core\\.(fsmonitor|sshcommand)|commit\\.gpgsign|tag\\.gpgsign|gpg\\..*\\.program)$"], hooks, signal);
  if (config.exitCode === 0 && config.stdout.trim()) {
    throw Object.assign(new Error("Repository config contains an external driver or helper."), {
      code: "repository_external_helper_denied"
    });
  }
}

async function createMetadataCheckpoint(
  manager: CheckpointManager,
  context: PlannedToolExecutionContext,
  repositoryRootPath: string
): Promise<string> {
  try {
    const checkpoint = await manager.create({
      sessionId: context.sessionId,
      runId: context.runId,
      workspacePath: repositoryRootPath,
      scopePaths: [".git"],
      baseSeq: 0
    });
    return checkpoint.checkpointId;
  } catch (error) {
    if ((error as { code?: unknown }).code === "checkpoint_limit_exceeded") {
      throw Object.assign(new Error("Repository metadata exceeds checkpoint limits.", { cause: error }), {
        code: "repository_checkpoint_too_large"
      });
    }
    throw error;
  }
}

async function applyGitOperations(
  execution: ProcessExecutionPort,
  root: string,
  args: readonly string[][],
  hooks: string,
  context: PlannedToolExecutionContext
): Promise<string[]> {
  const outputs: string[] = [];
  for (const operationArgs of args) {
    context.signal.throwIfAborted();
    const result = await runGit(execution, root, operationArgs, hooks, context.signal);
    outputs.push(result.stdout, result.stderr);
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(`Git operation failed with exit code ${result.exitCode}: ${result.stderr.trim()}`), {
        code: "repository_operation_failed"
      });
    }
  }
  return outputs;
}

function repositoryReceipt(
  request: { callId: string },
  context: PlannedToolExecutionContext,
  requestedOperations: GitOperation[],
  before: Awaited<ReturnType<typeof repositoryState>>,
  after: Awaited<ReturnType<typeof repositoryState>>,
  outputs: string[],
  startedAt: string
): ToolReceipt {
  const evidence: RepositoryDeltaEvidence = {
    evidenceId: randomUUID(), sessionId: context.sessionId, runId: context.runId,
    kind: "repository_delta", status: "passed", createdAt: new Date().toISOString(),
    producer: { authority: "tool", id: request.callId },
    summary: `Applied ${requestedOperations.length} controlled Git operation(s).`,
    data: {
      operationCount: requestedOperations.length,
      operations: requestedOperations.map((item) => item.op),
      beforeStateDigest: before.stateDigest, afterStateDigest: after.stateDigest,
      headBefore: before.head, headAfter: after.head,
      refsBeforeDigest: before.refsDigest, refsAfterDigest: after.refsDigest,
      indexBeforeDigest: before.indexDigest, indexAfterDigest: after.indexDigest,
      reachableObjectsBefore: before.reachableObjects,
      reachableObjectsAfter: after.reachableObjects
    }
  };
  const effects: ToolDescriptor["possibleEffects"] = ["repository.write",
    ...(requestedOperations.some(mutatesWorktree) ? ["filesystem.write" as const] : []),
    ...(requestedOperations.some(isDestructiveGitOperation) ? ["destructive" as const] : [])];
  return {
    callId: request.callId, ok: true,
    output: outputs.filter(Boolean).join("\n").slice(0, 256 * 1024),
    observedEffects: effects, actualEffects: effects,
    artifacts: [], diagnostics: [], evidence: [evidence],
    startedAt, completedAt: new Date().toISOString()
  };
}

async function executeTransaction(
  execution: ProcessExecutionPort,
  request: { callId: string; arguments: JsonValue },
  context: PlannedToolExecutionContext,
  limits: RepositoryCheckpointLimits
): Promise<ToolReceipt> {
  const startedAt = new Date().toISOString();
  const input = gitInput(request.arguments);
  const requestedRepository = typeof input.repository === "string" ? input.repository : ".";
  const requestedOperations = gitOperations(request.arguments);
  const args = requestedOperations.map(gitOperationArgs);
  const { root, gitDir } = await repositoryRoot(context.workspacePath, requestedRepository);
  const checkpoints = repositoryCheckpointManager(context.workspacePath, limits);
  await restoreOpenRepositoryCheckpoint(checkpoints, context.sessionId);
  const transactionRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-git-transaction-"));
  const hooks = path.join(transactionRoot, "empty-hooks");
  await mkdir(hooks, { recursive: true });
  let checkpointId: string | undefined;
  try {
    await assertNoExternalDrivers(execution, root, hooks, context.signal);
    const before = await repositoryState(execution, root, gitDir, hooks, context.signal);
    checkpointId = await createMetadataCheckpoint(checkpoints, context, root);
    const outputs = await applyGitOperations(execution, root, args, hooks, context);
    const after = await repositoryState(execution, root, gitDir, hooks, context.signal);
    await checkpoints.seal(context.sessionId, checkpointId);
    checkpointId = undefined;
    return repositoryReceipt(request, context, requestedOperations, before, after, outputs, startedAt);
  } catch (error) {
    if (checkpointId) {
      try {
        const inspection = await checkpoints.inspectOpen(context.sessionId, checkpointId);
        await checkpoints.restoreOpen(context.sessionId, checkpointId, inspection.currentManifestDigest);
      } catch (restoreError) {
        throw Object.assign(new AggregateError([error, restoreError], "Repository metadata rollback failed."), {
          code: "repository_recovery_required"
        });
      }
    }
    throw error;
  } finally {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function repositoryTransactionTool(
  execution: ProcessExecutionPort,
  limits: RepositoryCheckpointLimits = {}
): RegisteredEffectTool {
  return {
    descriptor: {
      name: "git_transaction",
      description: "Execute a structured, local-only Git transaction with metadata snapshot and rollback. Arbitrary argv, shell, hooks, network protocols, external drivers, external gitdirs, and workspace escapes are denied.",
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: "Workspace-relative self-contained repository root; defaults to '.'." },
          operations: { type: "array", minItems: 1, maxItems: 64, items: gitOperationSchema }
        },
        required: ["operations"],
        additionalProperties: false
      },
      possibleEffects: ["repository.write", "filesystem.write", "destructive"],
      maximumEffects: ["repository.write", "filesystem.write", "destructive"],
      availableModes: ["change"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write", "repository:git"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 600_000,
      prepare(argumentsValue): ToolCallPlan {
        const parsed = gitOperations(argumentsValue);
        const repository = gitInput(argumentsValue).repository;
        if (repository !== undefined && typeof repository !== "string") throw new Error("repository must be a string.");
        parsed.forEach(gitOperationArgs);
        const effects: ToolCallPlan["exactEffects"] = ["repository.write"];
        if (parsed.some(mutatesWorktree)) effects.push("filesystem.write");
        if (parsed.some(isDestructiveGitOperation)) effects.push("destructive");
        const root = typeof repository === "string" ? repository : ".";
        return {
          exactEffects: effects,
          readPaths: [root],
          writePaths: parsed.some(mutatesWorktree) ? [root] : [],
          network: "none",
          processMode: "none",
          checkpointScope: [root],
          idempotence: "non_replayable"
        };
      }
    },
    execute: async (request, context) => await executeTransaction(execution, request, context, limits)
  };
}
