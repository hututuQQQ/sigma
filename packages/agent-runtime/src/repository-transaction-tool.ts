import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { CheckpointManager, type CheckpointManagerOptions } from "agent-checkpoint";
import { repositoryTopology, workspaceTransactionRoot, type ProcessExecutionPort } from "agent-platform";
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
import {
  GIT_NULL_DEVICE,
  assertNoExternalDrivers,
  repositoryState,
  runGit
} from "./repository-transaction-state.js";

export type RepositoryCheckpointLimits = Pick<CheckpointManagerOptions, "maxFiles" | "maxBytes">;

async function repositoryRoot(
  workspace: string,
  requested: string,
  execution: ProcessExecutionPort,
  signal: AbortSignal,
  allowExternalMetadata: boolean
): Promise<{ root: string; gitDir: string; commonDir: string; externalMetadata: boolean; bare: boolean }> {
  const workspaceRoot = await realpath(path.resolve(workspace));
  const lexical = path.resolve(workspaceRoot, requested);
  const relative = path.relative(workspaceRoot, lexical);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Repository path escapes the workspace."), { code: "repository_path_escape" });
  }
  const root = await realpath(lexical);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Repository root must be a stable directory.");
  const topology = await repositoryTopology(root, signal, execution, { allowExternalMetadata });
  if (!topology) throw Object.assign(new Error("Repository metadata was not found."), {
    code: "workspace_not_git_root"
  });
  return {
    root,
    gitDir: topology.gitDir,
    commonDir: topology.commonDir,
    externalMetadata: topology.trust === "external_untrusted",
    bare: topology.kind === "bare"
  };
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

async function atomicRepositoryCheckpointManager(
  workspace: string,
  limits: RepositoryCheckpointLimits = {}
): Promise<CheckpointManager> {
  const legacyRoot = path.join(workspace, ".agent", "repository-checkpoints");
  const rootDir = await workspaceTransactionRoot({
    workspacePath: workspace,
    stateRootDir: legacyRoot,
    namespace: "repository-checkpoint-state"
  });
  return new CheckpointManager({ rootDir, excludedNames: [".agent"], ...limits });
}

async function restoreOpenRepositoryCheckpoint(manager: CheckpointManager, sessionId: string): Promise<void> {
  for (;;) {
    const open = [...await manager.list(sessionId)].reverse().find((item) => item.status === "open");
    if (!open) return;
    const inspection = await manager.inspectOpen(sessionId, open.checkpointId);
    await manager.restoreOpen(sessionId, open.checkpointId, inspection.currentManifestDigest);
  }
}

/** Restore the atomic repository/worktree preimage left by a hard interruption. */
export async function recoverInterruptedRepositoryTransactions(workspace: string, sessionId: string): Promise<void> {
  try {
    await restoreOpenRepositoryCheckpoint(await atomicRepositoryCheckpointManager(workspace), sessionId);
    // V1 repository transactions stored metadata-only checkpoints here.
    await restoreOpenRepositoryCheckpoint(repositoryCheckpointManager(workspace), sessionId);
  } catch (error) {
    throw Object.assign(new Error("Interrupted repository transaction could not be restored.", { cause: error }), {
      code: "repository_recovery_required"
    });
  }
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative)
    && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function atomicCheckpointScope(paths: string[]): { workspacePath: string; scopePaths: string[] } {
  const minimal = [...new Set(paths.map((item) => path.resolve(item)))]
    .filter((item, index, values) => !values.some((candidate, candidateIndex) =>
      candidateIndex !== index && pathWithin(candidate, item)));
  const first = minimal[0];
  if (!first) {
    throw Object.assign(new Error("Repository transaction has no checkpoint scope."), {
      code: "repository_atomicity_unavailable"
    });
  }
  let workspacePath = first;
  while (!minimal.every((item) => pathWithin(workspacePath, item))) {
    const parent = path.dirname(workspacePath);
    if (parent === workspacePath) {
      throw Object.assign(new Error("Repository transaction roots do not share a filesystem scope."), {
        code: "repository_atomicity_unavailable"
      });
    }
    workspacePath = parent;
  }
  return {
    workspacePath,
    scopePaths: minimal.map((item) => path.relative(workspacePath, item) || ".")
  };
}

async function createRepositoryCheckpoint(
  manager: CheckpointManager,
  context: PlannedToolExecutionContext,
  captureRoots: string[]
): Promise<string> {
  try {
    const scope = atomicCheckpointScope(captureRoots);
    const checkpoint = await manager.create({
      sessionId: context.sessionId,
      runId: context.runId,
      ...scope,
      baseSeq: 0
    });
    return checkpoint.checkpointId;
  } catch (error) {
    if ((error as { code?: unknown }).code === "checkpoint_limit_exceeded") {
      throw Object.assign(new Error("Repository transaction preimage exceeds checkpoint limits.", { cause: error }), {
        code: "repository_checkpoint_too_large"
      });
    }
    throw error;
  }
}

async function applyGitOperations(
  execution: ProcessExecutionPort,
  root: string,
  metadataRoots: string[],
  args: readonly string[][],
  hooks: string,
  context: PlannedToolExecutionContext
): Promise<string[]> {
  const outputs: string[] = [];
  for (const operationArgs of args) {
    context.signal.throwIfAborted();
    const result = await runGit(
      execution, root, metadataRoots, operationArgs, hooks, context.signal, context.sessionId
    );
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
  startedAt: string,
  externalMetadata: boolean
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
      reachableObjectsAfter: after.reachableObjects,
      conflictsBeforeDigest: before.conflictsDigest,
      conflictsAfterDigest: after.conflictsDigest,
      conflictCountBefore: before.conflictCount,
      conflictCountAfter: after.conflictCount
    }
  };
  const effects: ToolDescriptor["possibleEffects"] = ["repository.write",
    ...(externalMetadata ? ["filesystem.read.external" as const] : []),
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
  const capability = await repositoryRoot(
    context.workspacePath, requestedRepository, execution, context.signal, false
  );
  if (capability.externalMetadata && context.approval?.externalReadApproved !== true) {
    throw Object.assign(new Error("External Git metadata requires a fresh repository-bound approval."), {
      code: "external_read_required"
    });
  }
  const { root, gitDir, commonDir, externalMetadata, bare } = await repositoryRoot(
    context.workspacePath, requestedRepository, execution, context.signal, capability.externalMetadata
  );
  if (bare && requestedOperations.some(mutatesWorktree)) {
    throw Object.assign(new Error("This Git operation requires a worktree, but the repository is bare."), {
      code: "repository_bare"
    });
  }
  const metadataRoots = [...new Set([gitDir, commonDir])];
  const captureRoots = requestedOperations.some(mutatesWorktree)
    ? [root, ...metadataRoots]
    : metadataRoots;
  const checkpoints = await atomicRepositoryCheckpointManager(context.workspacePath, limits);
  await restoreOpenRepositoryCheckpoint(checkpoints, context.sessionId);
  await restoreOpenRepositoryCheckpoint(repositoryCheckpointManager(context.workspacePath, limits), context.sessionId);
  // The platform null device is immutable from the sandbox and cannot contain
  // hooks. Unlike a host temporary directory, it is present in every broker
  // namespace without granting another read root.
  const hooks = GIT_NULL_DEVICE;
  let checkpointId: string | undefined;
  try {
    await assertNoExternalDrivers(
      execution, root, metadataRoots, hooks, context.signal, context.sessionId
    );
    const before = await repositoryState(
      execution, root, gitDir, metadataRoots, hooks, context.signal, context.sessionId
    );
    checkpointId = await createRepositoryCheckpoint(checkpoints, context, captureRoots);
    const outputs = await applyGitOperations(execution, root, metadataRoots, args, hooks, context);
    const after = await repositoryState(
      execution, root, gitDir, metadataRoots, hooks, context.signal, context.sessionId
    );
    await checkpoints.seal(context.sessionId, checkpointId);
    checkpointId = undefined;
    return repositoryReceipt(
      request, context, requestedOperations, before, after, outputs, startedAt, externalMetadata
    );
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
  }
}

export function repositoryTransactionTool(
  execution: ProcessExecutionPort,
  limits: RepositoryCheckpointLimits = {}
): RegisteredEffectTool {
  return {
    descriptor: {
      name: "git_transaction",
      description: "Execute a structured, local-only Git transaction with topology-aware metadata snapshot and rollback. Linked worktrees, submodules, and bare repositories are recognized; external metadata requires a fresh approval. Arbitrary argv, shell, hooks, network protocols, external drivers, and workspace escapes are denied.",
      inputSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: "Workspace-relative repository root; defaults to '.'." },
          operations: { type: "array", minItems: 1, maxItems: 64, items: gitOperationSchema }
        },
        required: ["operations"],
        additionalProperties: false
      },
      possibleEffects: ["repository.write", "filesystem.read.external", "filesystem.write", "destructive"],
      maximumEffects: ["repository.write", "filesystem.read.external", "filesystem.write", "destructive"],
      availableModes: ["change"],
      executionMode: "exclusive",
      resourceKeys: ["workspace:write", "repository:git"],
      approval: "prompt",
      idempotent: false,
      timeoutMs: 600_000,
      async prepare(argumentsValue, context): Promise<ToolCallPlan> {
        const parsed = gitOperations(argumentsValue);
        const repository = gitInput(argumentsValue).repository;
        if (repository !== undefined && typeof repository !== "string") throw new Error("repository must be a string.");
        parsed.forEach(gitOperationArgs);
        const effects: ToolCallPlan["exactEffects"] = ["repository.write"];
        if (parsed.some(mutatesWorktree)) effects.push("filesystem.write");
        if (parsed.some(isDestructiveGitOperation)) effects.push("destructive");
        const root = typeof repository === "string" ? repository : ".";
        const topology = await repositoryRoot(
          context.workspacePath, root, execution, AbortSignal.timeout(10_000), false
        );
        if (topology.externalMetadata) effects.push("filesystem.read.external");
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
