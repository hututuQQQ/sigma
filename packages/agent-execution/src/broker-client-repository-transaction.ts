import path from "node:path";
import { BrokerTransport } from "./broker-transport.js";
import { BrokerPolicyError, BrokerProtocolError } from "./errors.js";
import type {
  BrokerRequestOptions, RepositoryOperation, RepositoryTransactionBeginRequest,
  RepositoryTransactionBoundRequest, RepositoryTransactionContinueRequest,
  RepositoryTransactionLeaseRequest,
  RepositoryTransactionWireLease,
  RepositoryTransactionRecoverRequest, RepositoryTransactionResult,
  RepositoryRunBaselineBoundRequest, RepositoryRunBaselineResult
} from "./types.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrokerProtocolError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new BrokerProtocolError(`${label} is invalid.`);
  return value;
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

export function parseRepositoryTransactionLease(input: unknown): RepositoryTransactionWireLease {
  const value = record(input, "Repository transaction lease");
  if (value.protocolVersion !== 1 || value.network !== "none" || value.uses !== 1
    || !validDigest(value.executableSha256)) {
    throw new BrokerProtocolError("Repository transaction lease has unsupported semantics.");
  }
  const runBaseline = record(value.runBaseline, "Repository run baseline lease");
  if (runBaseline.schemaVersion !== 1
    || typeof runBaseline.baselineId !== "string" || !runBaseline.baselineId
    || typeof runBaseline.restoreCapability !== "string" || !runBaseline.restoreCapability) {
    throw new BrokerProtocolError("Repository run baseline lease has unsupported semantics.");
  }
  return {
    protocolVersion: 1,
    leaseId: text(value.leaseId, "Repository transaction leaseId"),
    sessionId: text(value.sessionId, "Repository transaction sessionId"),
    runId: text(value.runId, "Repository transaction runId"),
    repositoryRoot: text(value.repositoryRoot, "Repository transaction repositoryRoot"),
    gitDir: text(value.gitDir, "Repository transaction gitDir"),
    commonDir: text(value.commonDir, "Repository transaction commonDir"),
    executable: text(value.executable, "Repository transaction executable"),
    executableSha256: value.executableSha256,
    network: "none",
    uses: 1,
    runBaseline: {
      schemaVersion: 1,
      baselineId: runBaseline.baselineId as string,
      restoreCapability: runBaseline.restoreCapability as string
    }
  };
}

export function parseRepositoryRunBaselineResult(input: unknown): RepositoryRunBaselineResult {
  const value = record(input, "Repository run baseline result");
  if (value.protocolVersion !== 1 || !["restored", "released"].includes(String(value.status))) {
    throw new BrokerProtocolError("Repository run baseline result has unsupported semantics.");
  }
  const result: RepositoryRunBaselineResult = {
    protocolVersion: 1,
    status: value.status as "restored" | "released",
    baselineId: text(value.baselineId, "Repository run baseline baselineId"),
    sessionId: text(value.sessionId, "Repository run baseline sessionId"),
    runId: text(value.runId, "Repository run baseline runId"),
    repositoryRoot: text(value.repositoryRoot, "Repository run baseline repositoryRoot")
  };
  if (result.status === "restored") {
    const parsed = parseRepositoryTransactionResult({
      protocolVersion: 1,
      status: "sealed",
      semanticAssertions: value.semanticAssertions
    });
    if (!parsed.semanticAssertions) {
      throw new BrokerProtocolError("Restored repository run baseline has no semantic assertions.");
    }
    result.semanticAssertions = parsed.semanticAssertions;
  } else if (value.semanticAssertions !== undefined) {
    throw new BrokerProtocolError("Released repository run baseline must not claim restored assertions.");
  }
  return result;
}

const statuses = new Set([
  "conflicts_pending", "completed_pending_seal", "aborted", "recovered", "sealed"
]);

function validNonNegativeCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function assertRepositoryTargetAssertions(input: unknown): void {
  const target = record(input, "Repository transaction target assertions");
  const selectedHeadValid = typeof target.selectedHead === "string"
    && /^[a-f0-9]{40,64}$/u.test(target.selectedHead);
  const selectedRefValid = target.selectedSymbolicRef === null
    || typeof target.selectedSymbolicRef === "string";
  const required = target.requiredReachableObjects;
  const requiredValid = Array.isArray(required) && required.length >= 1
    && required.every((item) => typeof item === "string" && /^[a-f0-9]{40,64}$/u.test(item));
  if (target.schemaVersion !== 1 || target.satisfied !== true
    || !selectedHeadValid || !selectedRefValid || !requiredValid) {
    throw new BrokerProtocolError("Repository transaction target assertions are invalid.");
  }
}

function assertRepositorySemanticAssertions(input: unknown): void {
  const assertions = record(input, "Repository transaction semantic assertions");
  const headValid = assertions.head === null
    || (typeof assertions.head === "string" && /^[a-f0-9]{40,64}$/u.test(assertions.head));
  const refValid = assertions.symbolicRef === null || typeof assertions.symbolicRef === "string";
  const digests = [
    assertions.refsDigest, assertions.reachabilityDigest, assertions.indexDigest,
    assertions.conflictsDigest, assertions.trackedDigest, assertions.untrackedDigest
  ];
  const counts = [
    assertions.reachableObjectCount, assertions.conflictCount,
    assertions.trackedCount, assertions.untrackedCount
  ];
  if (assertions.schemaVersion !== 1 || !headValid || !refValid
    || !digests.every(validDigest) || !counts.every(validNonNegativeCount)) {
    throw new BrokerProtocolError("Repository transaction semantic assertions are invalid.");
  }
  if (assertions.targetAssertions !== undefined) {
    assertRepositoryTargetAssertions(assertions.targetAssertions);
  }
}

export function parseRepositoryTransactionResult(input: unknown): RepositoryTransactionResult {
  const value = record(input, "Repository transaction result");
  if (value.protocolVersion !== 1 || typeof value.status !== "string" || !statuses.has(value.status)) {
    throw new BrokerProtocolError("Repository transaction result has unsupported semantics.");
  }
  if (value.transactionHandle !== undefined && typeof value.transactionHandle !== "string") {
    throw new BrokerProtocolError("Repository transaction handle is invalid.");
  }
  if (value.conflictCount !== undefined
    && (!Number.isSafeInteger(value.conflictCount) || (value.conflictCount as number) < 0)) {
    throw new BrokerProtocolError("Repository transaction conflictCount is invalid.");
  }
  if (value.recovered !== undefined
    && (!Number.isSafeInteger(value.recovered) || (value.recovered as number) < 0)) {
    throw new BrokerProtocolError("Repository transaction recovered count is invalid.");
  }
  if (value.semanticAssertions !== undefined) {
    assertRepositorySemanticAssertions(value.semanticAssertions);
  }
  return value as unknown as RepositoryTransactionResult;
}

function validateBinding(value: string, label: string): void {
  if (!value || value.length > 512 || /[\0\r\n]/u.test(value)) {
    throw new BrokerPolicyError(`Repository transaction ${label} is invalid.`);
  }
}

function operations(value: RepositoryOperation[]): RepositoryOperation[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new BrokerPolicyError("Repository transaction operations are invalid.");
  }
  return value.map((operation) => {
    if (!operation || typeof operation.operationClass !== "string"
      || !Array.isArray(operation.args)
      || operation.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
      throw new BrokerPolicyError("Repository transaction operation is invalid.");
    }
    return { operationClass: operation.operationClass, args: [...operation.args] };
  });
}

function expectedPostconditions(
  value: RepositoryTransactionBeginRequest["expectedPostconditions"]
): RepositoryTransactionBeginRequest["expectedPostconditions"] {
  if (!value) return undefined;
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40,64}$/u.test(value.selectedHead)
    || (value.selectedSymbolicRef !== null
      && (typeof value.selectedSymbolicRef !== "string" || !value.selectedSymbolicRef))
    || !Array.isArray(value.requiredReachableObjects)
    || value.requiredReachableObjects.length < 1 || value.requiredReachableObjects.length > 64
    || value.requiredReachableObjects.some((item) => !/^[a-f0-9]{40,64}$/u.test(item))) {
    throw new BrokerPolicyError("Repository transaction expected postconditions are invalid.");
  }
  return { ...value, requiredReachableObjects: [...new Set(value.requiredReachableObjects)] };
}

export async function acquireRepositoryTransactionLease(
  transport: BrokerTransport,
  request: RepositoryTransactionLeaseRequest,
  options: BrokerRequestOptions
): Promise<RepositoryTransactionWireLease> {
  if (request.protocolVersion !== 1 || request.network !== "none") {
    throw new BrokerPolicyError("Repository write transactions require the current local-only lease.");
  }
  validateBinding(request.sessionId, "sessionId");
  validateBinding(request.runId, "runId");
  for (const [label, value] of Object.entries({
    repositoryRoot: request.repositoryRoot, gitDir: request.gitDir, commonDir: request.commonDir
  })) {
    if (!path.isAbsolute(value)) throw new BrokerPolicyError(`Repository transaction ${label} must be absolute.`);
  }
  return parseRepositoryTransactionLease(await transport.request("repositoryTransaction.acquire", {
    ...request,
    repositoryRoot: path.resolve(request.repositoryRoot),
    gitDir: path.resolve(request.gitDir),
    commonDir: path.resolve(request.commonDir)
  }, options));
}

export async function beginRepositoryTransaction(
  transport: BrokerTransport,
  request: RepositoryTransactionBeginRequest,
  options: BrokerRequestOptions
): Promise<RepositoryTransactionResult> {
  if (request.protocolVersion !== 1) throw new BrokerPolicyError("Unsupported repository transaction protocol.");
  return parseRepositoryTransactionResult(await transport.request("repositoryTransaction.begin", {
    protocolVersion: request.protocolVersion,
    leaseId: request.leaseId,
    operations: operations(request.operations),
    ...(request.expectedPostconditions
      ? { expectedPostconditions: expectedPostconditions(request.expectedPostconditions) } : {})
  }, options));
}

export async function continueRepositoryTransaction(
  transport: BrokerTransport,
  request: RepositoryTransactionContinueRequest,
  options: BrokerRequestOptions
): Promise<RepositoryTransactionResult> {
  validateBinding(request.sessionId, "sessionId");
  validateBinding(request.runId, "runId");
  return parseRepositoryTransactionResult(await transport.request("repositoryTransaction.continue", {
    ...request, protocolVersion: 1, operations: operations(request.operations ?? [])
  }, options));
}

async function boundRequest(
  transport: BrokerTransport,
  method: "abort" | "seal",
  request: RepositoryTransactionBoundRequest,
  options: BrokerRequestOptions
): Promise<RepositoryTransactionResult> {
  validateBinding(request.sessionId, "sessionId");
  validateBinding(request.runId, "runId");
  return parseRepositoryTransactionResult(await transport.request(`repositoryTransaction.${method}`, {
    ...request, protocolVersion: 1
  }, options));
}

export async function abortRepositoryTransaction(
  transport: BrokerTransport,
  request: RepositoryTransactionBoundRequest,
  options: BrokerRequestOptions
): Promise<RepositoryTransactionResult> {
  return await boundRequest(transport, "abort", request, options);
}

export async function sealRepositoryTransaction(
  transport: BrokerTransport,
  request: RepositoryTransactionBoundRequest,
  options: BrokerRequestOptions
): Promise<RepositoryTransactionResult> {
  return await boundRequest(transport, "seal", request, options);
}

export async function recoverRepositoryTransactions(
  transport: BrokerTransport,
  request: RepositoryTransactionRecoverRequest,
  options: BrokerRequestOptions
): Promise<RepositoryTransactionResult> {
  validateBinding(request.sessionId, "sessionId");
  if (request.runId !== undefined) validateBinding(request.runId, "runId");
  return parseRepositoryTransactionResult(await transport.request("repositoryTransaction.recover", {
    ...request, protocolVersion: 1
  }, options));
}

async function repositoryRunBaselineRequest(
  transport: BrokerTransport,
  method: "restore" | "release",
  request: RepositoryRunBaselineBoundRequest,
  options: BrokerRequestOptions
): Promise<RepositoryRunBaselineResult> {
  validateBinding(request.sessionId, "run baseline sessionId");
  validateBinding(request.runId, "run baseline runId");
  validateBinding(request.baselineId, "run baseline baselineId");
  validateBinding(request.restoreCapability, "run baseline restoreCapability");
  if (request.protocolVersion !== 1 || !path.isAbsolute(request.repositoryRoot)) {
    throw new BrokerPolicyError("Repository run baseline request is invalid.");
  }
  return parseRepositoryRunBaselineResult(await transport.request(
    `repositoryRunBaseline.${method}`,
    { ...request, repositoryRoot: path.resolve(request.repositoryRoot) },
    options
  ));
}

export async function restoreRepositoryRunBaseline(
  transport: BrokerTransport,
  request: RepositoryRunBaselineBoundRequest,
  options: BrokerRequestOptions
): Promise<RepositoryRunBaselineResult> {
  return await repositoryRunBaselineRequest(transport, "restore", request, options);
}

export async function releaseRepositoryRunBaseline(
  transport: BrokerTransport,
  request: RepositoryRunBaselineBoundRequest,
  options: BrokerRequestOptions
): Promise<RepositoryRunBaselineResult> {
  return await repositoryRunBaselineRequest(transport, "release", request, options);
}
