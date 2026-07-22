import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  ExecutionBroker,
  ExecutionRequest,
  ExecutionResult,
  ProcessHandle,
  ProcessPollResult,
  ProcessSpawnRequest,
  RepositoryMetadataLeaseRequestV1,
  RepositoryMetadataLeaseV1,
  RepositoryOperationV2,
  RepositoryRunBaselineRequestV1,
  RepositoryRunBaselineResultV1,
  RepositoryTransactionBeginRequestV2,
  RepositoryTransactionBoundRequestV2, RepositoryTransactionContinueRequestV2,
  RepositoryTransactionLeaseRequestV2, RepositoryTransactionLeaseV2,
  RepositoryTransactionRecoverRequestV2, RepositoryTransactionResultV2
} from "../../packages/agent-execution/src/index.js";
import { createMinimalEnvironment } from "../../packages/agent-execution/src/index.js";

interface OutputBuffer {
  bytes: Buffer;
  startOffset: number;
  totalBytes: number;
  cursor: number;
  maximum: number;
  decoder: StringDecoder;
}

interface HostProcess {
  child: ChildProcessWithoutNullStreams;
  handle: ProcessHandle;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  startedAt: number;
  state: "running" | "exited" | "terminated";
  exitCode: number | null;
  signal: string | null;
  terminated: boolean;
}

interface HostRepositorySnapshot {
  lease: RepositoryTransactionLeaseV2;
  snapshotRoot: string;
  externalMetadataSnapshot?: string;
}

function output(maximum: number): OutputBuffer {
  return {
    bytes: Buffer.alloc(0), startOffset: 0, totalBytes: 0, cursor: 0, maximum,
    decoder: new StringDecoder("utf8")
  };
}

function append(target: OutputBuffer, chunk: Buffer): void {
  target.totalBytes += chunk.byteLength;
  const combined = Buffer.concat([target.bytes, chunk]);
  if (combined.byteLength <= target.maximum) {
    target.bytes = combined;
    return;
  }
  const excess = combined.byteLength - target.maximum;
  target.bytes = combined.subarray(excess);
  target.startOffset += excess;
}

function readOutput(target: OutputBuffer, final: boolean): { data: string; dropped: number } {
  const effective = Math.max(target.cursor, target.startOffset);
  const index = effective - target.startOffset;
  const dropped = Math.max(0, target.startOffset - target.cursor);
  const data = target.decoder.write(target.bytes.subarray(index)) + (final ? target.decoder.end() : "");
  target.cursor = target.totalBytes;
  return { data, dropped };
}

function environment(request: ExecutionRequest["command"]): NodeJS.ProcessEnv {
  return createMinimalEnvironment(request.environment);
}

async function terminateTree(child: ChildProcessWithoutNullStreams, force = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch { child.kill(force ? "SIGKILL" : "SIGTERM"); }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true, shell: false, stdio: "ignore"
    });
    killer.once("error", () => { child.kill(); resolve(); });
    killer.once("close", () => resolve());
  });
}

function waitForClose(child: ChildProcessWithoutNullStreams, milliseconds = 1_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

export class HostExecutionBroker implements ExecutionBroker {
  readonly lostProcessHandles: readonly ProcessHandle[] = [];
  private readonly instanceId = `test-host-${randomUUID()}`;
  private readonly processes = new Map<string, HostProcess>();
  private readonly repositoryLeases = new Map<string, RepositoryTransactionLeaseV2>();
  private readonly repositoryRunBaselines = new Map<string, HostRepositorySnapshot & {
    baselineId: string;
    restoreCapability: string;
  }>();
  private readonly repositoryTransactions = new Map<string, {
    handle: string;
    lease: RepositoryTransactionLeaseV2;
    snapshotRoot: string;
    externalMetadataSnapshot?: string;
    operations: RepositoryOperationV2[];
    expectedPostconditions?: RepositoryTransactionBeginRequestV2["expectedPostconditions"];
    next: number;
    pending?: RepositoryOperationV2;
    output: string[];
  }>();

  async connect(): Promise<BrokerDoctorReport> { return this.report(); }
  async doctor(): Promise<BrokerDoctorReport> { return this.report(); }

  async acquireRepositoryMetadataLease(
    request: RepositoryMetadataLeaseRequestV1,
    options: BrokerRequestOptions = {}
  ): Promise<RepositoryMetadataLeaseV1> {
    options.signal?.throwIfAborted();
    return {
      ...request,
      leaseId: `test-repository-${randomUUID()}`,
      executableSha256: "a".repeat(64),
      uses: 1
    };
  }

  async acquireRepositoryTransactionLease(
    request: RepositoryTransactionLeaseRequestV2,
    options: BrokerRequestOptions = {}
  ): Promise<RepositoryTransactionLeaseV2> {
    options.signal?.throwIfAborted();
    if (request.maxSnapshotFiles !== undefined || request.maxSnapshotBytes !== undefined) {
      const size = async (root: string): Promise<{ files: number; bytes: number }> => {
        let files = 0;
        let bytes = 0;
        for (const entry of await readdir(root, { withFileTypes: true })) {
          files += 1;
          const target = path.join(root, entry.name);
          if (entry.isDirectory()) {
            const nested = await size(target);
            files += nested.files;
            bytes += nested.bytes;
          } else {
            bytes += (await lstat(target)).size;
          }
        }
        return { files, bytes };
      };
      const observed = await size(request.repositoryRoot);
      if ((request.maxSnapshotFiles !== undefined && observed.files > request.maxSnapshotFiles)
        || (request.maxSnapshotBytes !== undefined && observed.bytes > request.maxSnapshotBytes)) {
        throw Object.assign(new Error("repository transaction preimage exceeds snapshot limits"), {
          code: "repository_checkpoint_too_large"
        });
      }
    }
    const baseLease: RepositoryTransactionLeaseV2 = {
      ...request,
      leaseId: `test-transaction-lease-${randomUUID()}`,
      executableSha256: "b".repeat(64),
      uses: 1 as const
    };
    const key = this.repositoryRunBaselineKey(request);
    let baseline = this.repositoryRunBaselines.get(key);
    if (!baseline) {
      baseline = {
        ...await this.createRepositorySnapshot(baseLease),
        baselineId: `test-run-baseline-${randomUUID()}`,
        restoreCapability: randomUUID()
      };
      this.repositoryRunBaselines.set(key, baseline);
    }
    const lease: RepositoryTransactionLeaseV2 = {
      ...baseLease,
      runBaseline: {
        schemaVersion: 1,
        baselineId: baseline.baselineId,
        restoreCapability: baseline.restoreCapability
      }
    };
    this.repositoryLeases.set(lease.leaseId, lease);
    return lease;
  }

  private repositoryRunBaselineKey(request: Pick<
    RepositoryRunBaselineRequestV1, "sessionId" | "runId" | "repositoryRoot"
  >): string {
    return `${request.sessionId}\0${request.runId}\0${path.resolve(request.repositoryRoot)}`;
  }

  private async createRepositorySnapshot(
    lease: RepositoryTransactionLeaseV2
  ): Promise<HostRepositorySnapshot> {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "sigma-host-repository-v2-"));
    await cp(lease.repositoryRoot, path.join(temporary, "worktree"), { recursive: true });
    const commonInsideRoot = path.relative(lease.repositoryRoot, lease.commonDir);
    const external = commonInsideRoot === ".." || commonInsideRoot.startsWith(`..${path.sep}`)
      || path.isAbsolute(commonInsideRoot);
    if (external) await cp(lease.commonDir, path.join(temporary, "common"), { recursive: true });
    return {
      lease,
      snapshotRoot: temporary,
      ...(external ? { externalMetadataSnapshot: path.join(temporary, "common") } : {})
    };
  }

  private gitTransactionCommand(transaction: {
    lease: RepositoryTransactionLeaseV2;
  }, args: string[]): { exitCode: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("git", [
        "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-c", "core.fsmonitor=false",
        `--git-dir=${transaction.lease.gitDir}`,
        ...(transaction.lease.repositoryRoot === transaction.lease.gitDir
          ? [] : [`--work-tree=${transaction.lease.repositoryRoot}`]),
        ...args
      ], {
        cwd: transaction.lease.repositoryRoot,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true"
        }
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return {
        exitCode: failure.status ?? 1,
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? "")
      };
    }
  }

  private hostConflictCount(transaction: { lease: RepositoryTransactionLeaseV2 }): number {
    const result = this.gitTransactionCommand(transaction, ["ls-files", "--unmerged"]);
    if (result.exitCode !== 0) throw Object.assign(new Error(result.stderr), {
      code: "repository_state_unavailable"
    });
    return new Set(result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => line.split("\t")[1])).size;
  }

  private continuation(operation: RepositoryOperationV2): string[] {
    switch (operation.operationClass) {
      case "merge": return ["merge", "--continue"];
      case "rebase": return ["rebase", "--continue"];
      case "cherry_pick": return ["cherry-pick", "--continue"];
      case "revert": return ["revert", "--continue"];
      default: throw Object.assign(new Error("operation is not continuable"), {
        code: "repository_transaction_invalid"
      });
    }
  }

  private async hostSemanticAssertions(transaction: {
    lease: RepositoryTransactionLeaseV2;
    expectedPostconditions?: RepositoryTransactionBeginRequestV2["expectedPostconditions"];
  }) {
    const command = (args: string[], missing = false): string | null => {
      const result = this.gitTransactionCommand(transaction, args);
      if (result.exitCode === 0) return result.stdout;
      if (missing && result.exitCode === 1) return null;
      throw Object.assign(new Error(result.stderr), { code: "repository_state_unavailable" });
    };
    const digest = (value: string | Buffer): string =>
      createHash("sha256").update(value).digest("hex");
    const head = command(["rev-parse", "--verify", "--quiet", "HEAD"], true)?.trim() || null;
    const symbolicRef = command(["symbolic-ref", "-q", "HEAD"], true)?.trim() || null;
    const refs = command(["show-ref", "--head"], true) ?? "";
    const reachability = command(["rev-list", "--objects", "--all"]) ?? "";
    const conflicts = command(["ls-files", "--unmerged", "-z"]) ?? "";
    const tracked = command(["ls-files", "-z"]) ?? "";
    const untracked = command(["ls-files", "--others", "--exclude-standard", "-z"]) ?? "";
    const index = await readFile(path.join(transaction.lease.gitDir, "index"))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return Buffer.alloc(0);
        throw error;
      });
    const conflictCount = new Set(conflicts.split("\0").filter(Boolean)
      .flatMap((entry) => entry.includes("\t") ? [entry.slice(entry.indexOf("\t") + 1)] : [])).size;
    const expected = transaction.expectedPostconditions;
    let targetAssertions;
    if (expected) {
      const reachable = expected.requiredReachableObjects.every((object) =>
        this.gitTransactionCommand(transaction, [
          "merge-base", "--is-ancestor", object, expected.selectedHead
        ]).exitCode === 0);
      if (head !== expected.selectedHead || symbolicRef !== expected.selectedSymbolicRef || !reachable) {
        throw Object.assign(new Error("repository target postcondition failed"), {
          code: "repository_postcondition_failed"
        });
      }
      targetAssertions = { ...expected, satisfied: true as const };
    }
    return {
      schemaVersion: 3 as const,
      head,
      symbolicRef,
      refsDigest: digest(refs),
      reachabilityDigest: digest(reachability),
      reachableObjectCount: reachability.split(/\r?\n/u).filter(Boolean).length,
      indexDigest: digest(index),
      conflictsDigest: digest(conflicts),
      conflictCount,
      trackedDigest: digest(tracked),
      trackedCount: tracked.split("\0").filter(Boolean).length,
      untrackedDigest: digest(untracked),
      untrackedCount: untracked.split("\0").filter(Boolean).length,
      ...(targetAssertions ? { targetAssertions } : {})
    };
  }

  private async applyHostTransaction(transaction: {
    handle: string; lease: RepositoryTransactionLeaseV2; snapshotRoot: string;
    externalMetadataSnapshot?: string; operations: RepositoryOperationV2[];
    expectedPostconditions?: RepositoryTransactionBeginRequestV2["expectedPostconditions"];
    next: number; pending?: RepositoryOperationV2; output: string[];
  }): Promise<RepositoryTransactionResultV2> {
    while (transaction.next < transaction.operations.length) {
      const operation = transaction.operations[transaction.next]!;
      const result = this.gitTransactionCommand(transaction, operation.args);
      transaction.output.push(result.stdout, result.stderr);
      if (result.exitCode !== 0) {
        const conflicts = this.hostConflictCount(transaction);
        if (["merge", "rebase", "cherry_pick", "revert"].includes(operation.operationClass)
          && conflicts > 0) {
          transaction.pending = operation;
          transaction.next += 1;
          return {
            protocolVersion: 2, status: "conflicts_pending",
            transactionHandle: transaction.handle, operation: operation.operationClass,
            conflictCount: conflicts, output: transaction.output.join("\n"), rollbackState: "journaled"
          };
        }
        await this.restoreHostTransaction(transaction);
        throw Object.assign(new Error(result.stderr), { code: "repository_operation_failed" });
      }
      transaction.next += 1;
    }
    try {
      return {
        protocolVersion: 3, status: "completed_pending_seal",
        transactionHandle: transaction.handle, conflictCount: 0,
        output: transaction.output.join("\n"), rollbackState: "journaled",
        semanticAssertions: await this.hostSemanticAssertions(transaction)
      };
    } catch (error) {
      await this.restoreHostTransaction(transaction);
      throw error;
    }
  }

  async beginRepositoryTransaction(
    request: RepositoryTransactionBeginRequestV2,
    options: BrokerRequestOptions = {}
  ): Promise<RepositoryTransactionResultV2> {
    options.signal?.throwIfAborted();
    const lease = this.repositoryLeases.get(request.leaseId);
    if (!lease) throw Object.assign(new Error("invalid lease"), {
      code: "repository_transaction_handle_invalid"
    });
    this.repositoryLeases.delete(request.leaseId);
    const snapshot = await this.createRepositorySnapshot(lease);
    const transaction = {
      handle: `test-transaction-${randomUUID()}`,
      lease,
      snapshotRoot: snapshot.snapshotRoot,
      ...(snapshot.externalMetadataSnapshot
        ? { externalMetadataSnapshot: snapshot.externalMetadataSnapshot } : {}),
      operations: request.operations,
      ...(request.expectedPostconditions
        ? { expectedPostconditions: request.expectedPostconditions } : {}),
      next: 0,
      output: []
    };
    this.repositoryTransactions.set(transaction.handle, transaction);
    return await this.applyHostTransaction(transaction);
  }

  async continueRepositoryTransaction(
    request: RepositoryTransactionContinueRequestV2,
    options: BrokerRequestOptions = {}
  ): Promise<RepositoryTransactionResultV2> {
    options.signal?.throwIfAborted();
    const transaction = this.boundHostTransaction(request);
    for (const operation of request.operations ?? []) {
      const result = this.gitTransactionCommand(transaction, operation.args);
      if (result.exitCode !== 0) throw Object.assign(new Error(result.stderr), {
        code: "repository_continue_failed"
      });
      transaction.output.push(result.stdout, result.stderr);
    }
    if (this.hostConflictCount(transaction) > 0) {
      return {
        protocolVersion: 2, status: "conflicts_pending",
        transactionHandle: transaction.handle, operation: transaction.pending?.operationClass,
        conflictCount: this.hostConflictCount(transaction), rollbackState: "journaled"
      };
    }
    const continuation = this.gitTransactionCommand(transaction, this.continuation(transaction.pending!));
    transaction.output.push(continuation.stdout, continuation.stderr);
    if (continuation.exitCode !== 0) throw Object.assign(new Error(continuation.stderr), {
      code: "repository_continue_failed"
    });
    transaction.pending = undefined;
    return await this.applyHostTransaction(transaction);
  }

  private boundHostTransaction(request: RepositoryTransactionBoundRequestV2) {
    const transaction = this.repositoryTransactions.get(request.transactionHandle);
    if (!transaction || transaction.lease.sessionId !== request.sessionId
      || transaction.lease.runId !== request.runId) {
      throw Object.assign(new Error("invalid transaction handle"), {
        code: "repository_transaction_handle_invalid"
      });
    }
    return transaction;
  }

  private async restoreHostTransaction(transaction: {
    handle: string; lease: RepositoryTransactionLeaseV2; snapshotRoot: string;
    externalMetadataSnapshot?: string;
  }): Promise<void> {
    await this.restoreRepositorySnapshot(transaction);
    this.repositoryTransactions.delete(transaction.handle);
  }

  private async restoreRepositorySnapshot(snapshot: HostRepositorySnapshot): Promise<void> {
    await rm(snapshot.lease.repositoryRoot, { recursive: true, force: true });
    await cp(path.join(snapshot.snapshotRoot, "worktree"), snapshot.lease.repositoryRoot, {
      recursive: true
    });
    if (snapshot.externalMetadataSnapshot) {
      await rm(snapshot.lease.commonDir, { recursive: true, force: true });
      await cp(snapshot.externalMetadataSnapshot, snapshot.lease.commonDir, { recursive: true });
    }
    await rm(snapshot.snapshotRoot, { recursive: true, force: true });
  }

  async abortRepositoryTransaction(
    request: RepositoryTransactionBoundRequestV2
  ): Promise<RepositoryTransactionResultV2> {
    const transaction = this.boundHostTransaction(request);
    await this.restoreHostTransaction(transaction);
    return {
      protocolVersion: 2, status: "aborted", transactionHandle: request.transactionHandle,
      rollbackState: "restored", gitAbortSucceeded: false
    };
  }

  async sealRepositoryTransaction(
    request: RepositoryTransactionBoundRequestV2
  ): Promise<RepositoryTransactionResultV2> {
    const transaction = this.boundHostTransaction(request);
    await rm(transaction.snapshotRoot, { recursive: true, force: true });
    this.repositoryTransactions.delete(transaction.handle);
    return { protocolVersion: 2, status: "sealed", transactionHandle: request.transactionHandle };
  }

  async recoverRepositoryTransactions(
    request: RepositoryTransactionRecoverRequestV2
  ): Promise<RepositoryTransactionResultV2> {
    const matches = [...this.repositoryTransactions.values()].filter((transaction) =>
      transaction.lease.sessionId === request.sessionId
      && (request.runId === undefined || transaction.lease.runId === request.runId));
    for (const transaction of matches) await this.restoreHostTransaction(transaction);
    return { protocolVersion: 2, status: "recovered", recovered: matches.length };
  }

  async restoreRepositoryRunBaseline(
    request: RepositoryRunBaselineRequestV1
  ): Promise<RepositoryRunBaselineResultV1> {
    const key = this.repositoryRunBaselineKey(request);
    const baseline = this.repositoryRunBaselines.get(key);
    if (!baseline) throw Object.assign(new Error("missing run baseline"), {
      code: "repository_atomicity_unavailable"
    });
    await this.restoreRepositorySnapshot(baseline);
    this.repositoryRunBaselines.delete(key);
    return {
      protocolVersion: 1,
      status: "restored",
      baselineId: baseline.baselineId,
      sessionId: request.sessionId,
      runId: request.runId,
      repositoryRoot: request.repositoryRoot,
      semanticAssertions: await this.hostSemanticAssertions(baseline)
    };
  }

  async releaseRepositoryRunBaseline(
    request: RepositoryRunBaselineRequestV1
  ): Promise<RepositoryRunBaselineResultV1> {
    const key = this.repositoryRunBaselineKey(request);
    const baseline = this.repositoryRunBaselines.get(key);
    if (!baseline) throw Object.assign(new Error("missing run baseline"), {
      code: "repository_atomicity_unavailable"
    });
    await rm(baseline.snapshotRoot, { recursive: true, force: true });
    this.repositoryRunBaselines.delete(key);
    return {
      protocolVersion: 1,
      status: "released",
      baselineId: baseline.baselineId,
      sessionId: request.sessionId,
      runId: request.runId,
      repositoryRoot: request.repositoryRoot
    };
  }

  async execute(request: ExecutionRequest, options: BrokerRequestOptions = {}): Promise<ExecutionResult> {
    options.signal?.throwIfAborted();
    const record = await this.start(request, request.maxOutputBytes ?? 16 * 1024 * 1024);
    record.child.stdin.end(request.command.stdin ?? "");
    let timedOut = false;
    let idleTimedOut = false;
    let cancelled = false;
    const abort = (): void => { cancelled = true; void terminateTree(record.child); };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; void terminateTree(record.child); }, request.timeoutMs ?? 120_000);
    timeout.unref();
    let idle = request.idleTimeoutMs
      ? setTimeout(() => { idleTimedOut = true; void terminateTree(record.child); }, request.idleTimeoutMs) : undefined;
    idle?.unref();
    const heartbeat = (): void => {
      if (!request.idleTimeoutMs || !idle) return;
      clearTimeout(idle);
      idle = setTimeout(() => { idleTimedOut = true; void terminateTree(record.child); }, request.idleTimeoutMs);
      idle.unref();
    };
    record.child.stdout.on("data", heartbeat);
    record.child.stderr.on("data", heartbeat);
    await waitForClose(record.child, (request.timeoutMs ?? 120_000) + 2_000);
    clearTimeout(timeout);
    if (idle) clearTimeout(idle);
    options.signal?.removeEventListener("abort", abort);
    const value = this.result(record);
    this.processes.delete(record.handle.id);
    return {
      ...value,
      state: value.state === "running" ? "terminated" : value.state,
      timedOut,
      idleTimedOut,
      cancelled
    };
  }

  async spawn(request: ProcessSpawnRequest, options: BrokerRequestOptions = {}): Promise<ProcessHandle> {
    options.signal?.throwIfAborted();
    const record = await this.start(request, request.maxOutputBytes ?? 16 * 1024 * 1024);
    if (request.command.stdin !== undefined) record.child.stdin.write(request.command.stdin);
    return record.handle;
  }

  async poll(handle: ProcessHandle): Promise<ProcessPollResult> {
    return this.result(this.record(handle));
  }

  async write(handle: ProcessHandle, data: string): Promise<void> {
    const record = this.record(handle);
    await new Promise<void>((resolve, reject) => record.child.stdin.write(data, (error) => error ? reject(error) : resolve()));
  }

  async terminate(handle: ProcessHandle): Promise<ProcessPollResult> {
    const record = this.record(handle);
    record.terminated = true;
    await terminateTree(record.child);
    await waitForClose(record.child);
    return this.result(record);
  }

  async close(): Promise<void> {
    for (const transaction of [...this.repositoryTransactions.values()]) {
      await this.restoreHostTransaction(transaction);
    }
    for (const baseline of this.repositoryRunBaselines.values()) {
      await rm(baseline.snapshotRoot, { recursive: true, force: true });
    }
    this.repositoryRunBaselines.clear();
    await Promise.all([...this.processes.values()].map(async (record) => {
      record.terminated = true;
      await terminateTree(record.child, true);
      await waitForClose(record.child);
    }));
    this.processes.clear();
  }

  private async start(request: ProcessSpawnRequest, maximum: number): Promise<HostProcess> {
    const child = spawn(request.command.executable, request.command.args ?? [], {
      cwd: path.resolve(request.command.cwd),
      env: environment(request.command),
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    const handle = { id: randomUUID(), brokerInstanceId: this.instanceId, systemProcessId: child.pid };
    const record: HostProcess = {
      child, handle, stdout: output(maximum), stderr: output(maximum), startedAt: Date.now(),
      state: "running", exitCode: null, signal: null, terminated: false
    };
    child.stdout.on("data", (chunk: Buffer) => append(record.stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(record.stderr, chunk));
    // A short-lived command may close its pipe before execute() finishes
    // forwarding optional stdin. Writable callbacks still receive failures;
    // this listener prevents the stream's parallel error event from escaping
    // the test broker as an uncaught EPIPE.
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      record.state = record.terminated ? "terminated" : "exited";
      record.exitCode = code;
      record.signal = signal;
    });
    this.processes.set(handle.id, record);
    try {
      await new Promise<void>((resolve, reject) => {
        const spawned = (): void => { child.removeListener("error", failed); resolve(); };
        const failed = (error: Error): void => { child.removeListener("spawn", spawned); reject(error); };
        child.once("spawn", spawned);
        child.once("error", failed);
      });
    } catch (error) {
      this.processes.delete(handle.id);
      throw error;
    }
    child.on("error", () => undefined);
    return record;
  }

  private record(handle: ProcessHandle): HostProcess {
    if (handle.brokerInstanceId !== this.instanceId) throw new Error("Process belongs to another test broker.");
    const record = this.processes.get(handle.id);
    if (!record) throw new Error(`Unknown test process '${handle.id}'.`);
    return record;
  }

  private result(record: HostProcess): ProcessPollResult {
    const final = record.state !== "running";
    const stdout = readOutput(record.stdout, final);
    const stderr = readOutput(record.stderr, final);
    return {
      handle: record.handle,
      state: record.state,
      exitCode: record.exitCode,
      signal: record.signal,
      durationMs: Date.now() - record.startedAt,
      stdout: stdout.data,
      stderr: stderr.data,
      stdoutDroppedBytes: stdout.dropped,
      stderrDroppedBytes: stderr.dropped,
      outputTruncated: stdout.dropped > 0 || stderr.dropped > 0
    };
  }

  private report(): BrokerDoctorReport {
    return {
      protocolVersion: 1,
      brokerVersion: "test-host",
      platform: process.platform,
      architecture: process.arch,
      sandbox: { available: true, backend: "test-only-host", selfTestPassed: true, setupRequired: false },
      capabilities: {
        foreground: true,
        background: true,
        stdin: true,
        pty: false,
        networkModes: ["none", "full"],
        shells: [{
          kind: process.platform === "win32" ? "cmd" : "bash",
          executable: process.platform === "win32" ? "cmd.exe" : "bash",
          verified: true,
          supportsChildProcesses: true
        }],
        runtimeCommands: ["node", process.platform === "win32" ? "npm.cmd" : "npm"]
      }
    };
  }
}

export function createHostExecutionBroker(): HostExecutionBroker {
  return new HostExecutionBroker();
}
