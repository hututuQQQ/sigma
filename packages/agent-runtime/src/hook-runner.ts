import { lstat } from "node:fs/promises";
import path from "node:path";
import { isSecretEnvironmentKey, SecretRedactor,
  type ExecutionBroker, type ScratchLeaseV1 } from "agent-execution";
import type { HookRunnerPort, HookRunnerRequest, HookRunnerResult } from "agent-extensions";

async function runtimeScratchLease(
  broker: ExecutionBroker,
  sessionId: string | undefined,
  signal: AbortSignal
): Promise<ScratchLeaseV1 | undefined> {
  if (!sessionId || !broker.acquireScratchLease) return undefined;
  return await broker.acquireScratchLease({ protocolVersion: 1, sessionId }, { signal });
}

function scratchPolicy(scratchLease: ScratchLeaseV1 | undefined): { scratchLease?: ScratchLeaseV1 } {
  return scratchLease ? { scratchLease } : {};
}

function containedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function releaseDiscardedArtifacts(
  broker: ExecutionBroker,
  result: Awaited<ReturnType<ExecutionBroker["execute"]>>
): Promise<void> {
  const artifactIds = result.outputArtifacts?.map((item) => item.brokerArtifactId) ?? [];
  if (artifactIds.length > 0) {
    await broker.releaseOutputArtifacts?.(artifactIds).catch(() => undefined);
  }
}

async function hookReadRoots(
  workspacePath: string,
  hook: Extract<HookRunnerRequest["hook"], { kind: "command" }>,
  cwd: string,
  frozenInvocationRoot?: string
): Promise<string[]> {
  const roots = new Set([workspacePath, cwd, ...(frozenInvocationRoot ? [frozenInvocationRoot] : [])]);
  for (const value of [hook.command, ...hook.args]) {
    if (!path.isAbsolute(value)) continue;
    const info = await lstat(value).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isDirectory()) roots.add(path.resolve(value));
    else if (info?.isFile() && !info.isSymbolicLink()) roots.add(path.dirname(path.resolve(value)));
  }
  return [...roots];
}

function frozenInvocationRoot(
  configuredRoot: string | undefined,
  hook: Extract<HookRunnerRequest["hook"], { kind: "command" }>,
  cwd: string
): string | undefined {
  if (!configuredRoot) return undefined;
  const root = path.resolve(configuredRoot);
  const candidates = [hook.command, ...hook.args, cwd]
    .filter((value) => path.isAbsolute(value))
    .map((value) => path.resolve(value))
    .filter((value) => containedPath(root, value));
  if (candidates.length === 0) return undefined;
  const invocations = new Set(candidates.map((candidate) => {
    const relative = path.relative(root, candidate);
    const [sessionHash, invocation] = relative.split(path.sep);
    if (!sessionHash || !/^[a-f0-9]{64}$/u.test(sessionHash)
      || !invocation || !/^invoke-[A-Za-z0-9_-]+$/u.test(invocation)) {
      throw new Error(`Frozen hook asset '${candidate}' is outside an identity-bound invocation root.`);
    }
    return path.join(root, sessionHash, invocation);
  }));
  if (invocations.size !== 1) throw new Error("Frozen hook assets span multiple invocation roots.");
  return [...invocations][0];
}

/** Runs executable hooks exclusively through sigma-exec. The hook receives one
 * JSON request on stdin and must return one JSON object on stdout. */
export class BrokerCommandHookRunner implements HookRunnerPort {
  private readonly workspacePath: string;
  private readonly redactor: SecretRedactor;

  constructor(
    private readonly broker: ExecutionBroker,
    workspacePath: string,
    private readonly agentProfileRunner?: HookRunnerPort,
    secretEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly beforeCommandHook?: (hookId: string) => Promise<void> | void,
    private readonly frozenAssetRoot?: string
  ) {
    this.workspacePath = path.resolve(workspacePath);
    this.redactor = new SecretRedactor(Object.fromEntries(
      Object.entries(secretEnvironment).filter(([name]) => isSecretEnvironmentKey(name))
    ));
  }

  async run(request: HookRunnerRequest, signal: AbortSignal): Promise<HookRunnerResult> {
    const safeRequest = {
      ...request,
      input: this.redactor.redactUnknown(request.input) as Readonly<Record<string, unknown>>
    };
    if (request.hook.kind === "agent_profile") {
      if (!this.agentProfileRunner) {
        return {
          ok: false,
          error: `No read-only agent-profile hook runner is configured for '${request.hook.profileId}'.`,
          durationMs: 0
        };
      }
      return await this.agentProfileRunner.run(safeRequest, signal);
    }
    const startedAt = performance.now();
    try {
      await this.beforeCommandHook?.(request.hook.id);
      const cwd = path.resolve(this.workspacePath, request.hook.cwd ?? ".");
      const allowedFrozenCwd = this.frozenAssetRoot
        ? containedPath(path.resolve(this.frozenAssetRoot), cwd) : false;
      if (!containedPath(this.workspacePath, cwd) && !allowedFrozenCwd) {
        throw new Error(`Hook cwd '${request.hook.cwd}' escapes the workspace.`);
      }
      const invocationRoot = frozenInvocationRoot(this.frozenAssetRoot, request.hook, cwd);
      const scratchLease = await runtimeScratchLease(this.broker, request.sessionId, signal);
      const result = await this.broker.execute({
        command: {
          executable: request.hook.command,
          args: [...request.hook.args],
          cwd,
          stdin: `${JSON.stringify({ event: request.event, input: safeRequest.input })}\n`
        },
        policy: {
          sandbox: "required",
          network: "none",
          readRoots: await hookReadRoots(this.workspacePath, request.hook, cwd, invocationRoot),
          writeRoots: [],
          protectedPaths: [
            path.join(this.workspacePath, ".git"),
            path.join(this.workspacePath, ".agent"),
            ...(invocationRoot ? [invocationRoot] : [])
          ],
          ...scratchPolicy(scratchLease)
        },
        timeoutMs: request.hook.timeoutMs,
        idleTimeoutMs: request.hook.timeoutMs,
        maxOutputBytes: request.policy.maxOutputBytes
      }, { signal, timeoutMs: request.hook.timeoutMs + 1_000 });
      await releaseDiscardedArtifacts(this.broker, result);
      const durationMs = Math.max(0, performance.now() - startedAt);
      if (result.outputTruncated) {
        return { ok: false, error: "Hook output was truncated.", durationMs };
      }
      if (result.state !== "exited" || result.exitCode !== 0) {
        const detail = this.redactor.redactText(result.stderr.trim()) || `exit code ${String(result.exitCode)}`;
        return { ok: false, error: `Hook command failed: ${detail}`, durationMs };
      }
      const output = result.stdout.trim();
      return { ok: true, output: output ? JSON.parse(output) : {}, durationMs };
    } catch (error) {
      return {
        ok: false,
        error: this.redactor.redactText(messageOf(error)),
        durationMs: Math.max(0, performance.now() - startedAt)
      };
    }
  }
}
