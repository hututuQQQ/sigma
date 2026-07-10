import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue, ModelGateway, ModelToolCall, ModelToolDefinition, ToolDescriptor, ToolReceipt, WorkspaceDelta
} from "agent-protocol";
import { planContext, type ContextPlan, type PlanContextOptions } from "agent-context";
import { resolveWorkspacePath } from "agent-platform";
import { completionEvidenceError, parseCompletionProposal } from "agent-tools";
import type { RuntimeSession } from "./types.js";

export function modelTools(descriptors: readonly ToolDescriptor[]): ModelToolDefinition[] {
  return descriptors.map((item) => ({ name: item.name, description: item.description, inputSchema: item.inputSchema }));
}

export async function providerSizedPlan(
  gateway: ModelGateway,
  input: Omit<PlanContextOptions, "contextWindowTokens">
): Promise<ContextPlan> {
  const providerLimit = gateway.capabilities.contextWindowTokens;
  let planningLimit = providerLimit;
  while (planningLimit > input.outputReserveTokens) {
    const plan = planContext({ ...input, contextWindowTokens: planningLimit });
    const tokens = await gateway.countTokens(plan.messages, input.tools);
    if (tokens + input.outputReserveTokens <= providerLimit) return plan;
    const ratio = providerLimit / (tokens + input.outputReserveTokens);
    const next = Math.min(planningLimit - 1, Math.floor(planningLimit * ratio * 0.98));
    if (next <= input.outputReserveTokens) break;
    planningLimit = next;
  }
  throw Object.assign(new Error("Provider tokenizer could not fit mandatory context and the newest user turn."), {
    code: "context_overflow"
  });
}

export function requestTargets(call: ModelToolCall, descriptor: ToolDescriptor): string[] {
  if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) return [];
  const input = call.arguments as Record<string, JsonValue>;
  return (descriptor.contextPathArguments ?? []).flatMap((key) => typeof input[key] === "string" ? [input[key] as string] : []);
}

export function porcelainEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  const records = output.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const file = record.slice(3).replaceAll("\\", "/");
    if (file && file !== ".agent" && !file.startsWith(".agent/")) entries.set(file, status);
    if (status.includes("R")) index += 1;
  }
  return entries;
}

export async function fileFingerprint(workspace: string, file: string): Promise<string> {
  try {
    const target = await resolveWorkspacePath(workspace, file);
    const info = await stat(target);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return `${info.size}:${info.mtimeMs}`;
    return createHash("sha256").update(await readFile(target)).digest("hex");
  } catch {
    return "missing";
  }
}

export function workspaceDelta(before: Map<string, string>, after: Map<string, string>): WorkspaceDelta {
  const result: WorkspaceDelta = { added: [], modified: [], deleted: [] };
  for (const [file, status] of after) {
    if (before.get(file) === status) continue;
    if (status === "??" || status.includes("A")) result.added.push(file);
    else if (status.includes("D")) result.deleted.push(file);
    else result.modified.push(file);
  }
  return result;
}

export function mergeDelta(left: WorkspaceDelta | undefined, right: WorkspaceDelta): WorkspaceDelta {
  const merge = (key: keyof WorkspaceDelta): string[] => [...new Set([...(left?.[key] ?? []), ...right[key]])].sort();
  return { added: merge("added"), modified: merge("modified"), deleted: merge("deleted") };
}

export function failed(call: ModelToolCall, startedAt: string, output: string, diagnostic: string): ToolReceipt {
  return { callId: call.id, ok: false, output, observedEffects: [], artifacts: [], diagnostics: [diagnostic], startedAt, completedAt: new Date().toISOString() };
}

export function completionFailure(session: RuntimeSession, call: ModelToolCall, descriptor: ToolDescriptor, startedAt: string): ToolReceipt | null {
  if (!descriptor.possibleEffects.includes("outcome.propose")) return null;
  const proposal = parseCompletionProposal(call.arguments);
  if (!proposal) return failed(call, startedAt, "Completion proposal does not match the required schema.", "invalid_completion_proposal");
  const successful = new Set(session.state.receipts.filter((item) => item.ok).map((item) => item.callId));
  const evidenceError = completionEvidenceError(proposal, successful);
  if (!evidenceError) return null;
  const available = session.state.receipts.filter((item) => item.ok).slice(-20).map((item) => item.callId);
  const guidance = available.length > 0
    ? `Copy exact evidenceCallIds from this available successful receipt list: ${available.join(", ")}.`
    : "No successful tool receipts are available yet; run the required inspection, mutation, or validation tool first.";
  return failed(call, startedAt, `${evidenceError}\n${guidance}`, "invalid_completion_evidence");
}

function normalizedRelative(workspacePath: string, candidate: string): string | null {
  const relative = path.relative(workspacePath, path.resolve(workspacePath, candidate)).replaceAll("\\", "/");
  return !relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) ? null : relative;
}

function inWriteScope(file: string, scopes: readonly string[]): boolean {
  return scopes.some((raw) => {
    const scope = raw.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return file === scope || file.startsWith(`${scope}/`);
  });
}

export function writeScopeFailure(session: RuntimeSession, call: ModelToolCall, descriptor: ToolDescriptor, startedAt: string): ToolReceipt | null {
  if (!session.strictWriteScope || !descriptor.possibleEffects.some((effect) => effect === "filesystem.write" || effect === "destructive")) return null;
  const input = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
    ? call.arguments as Record<string, JsonValue> : null;
  if (!input) return failed(call, startedAt, "Scoped writer tools require structured path arguments.", "write_scope_denied");
  const targets = (descriptor.writePathArguments ?? []).flatMap((key) => typeof input[key] === "string" ? [input[key] as string] : []);
  if (targets.length === 0) return failed(call, startedAt, `Tool '${call.name}' can write outside declared paths and is disabled in an exclusive shared workspace.`, "write_scope_denied");
  const outside = targets.filter((target) => {
    const relative = normalizedRelative(session.workspacePath, target);
    return relative === null || !inWriteScope(relative, session.writeScope);
  });
  return outside.length > 0 ? failed(call, startedAt, `Write target is outside the delegated scope: ${outside.join(", ")}.`, "write_scope_denied") : null;
}

export function lockKeys(session: RuntimeSession, descriptor: ToolDescriptor): string[] {
  const scope = process.platform === "win32" ? session.workspacePath.toLowerCase() : session.workspacePath;
  const resources = descriptor.resourceKeys.map((key) => `${scope}:${key}`);
  return descriptor.executionMode === "parallel" ? resources : [...resources, `${scope}:runtime:serial`];
}

export function requiresInstructionReplan(descriptor: ToolDescriptor): boolean {
  const risky = new Set(["filesystem.write", "process.spawn", "agent.spawn", "network", "validation", "outcome.propose", "destructive", "open_world"]);
  return descriptor.possibleEffects.some((effect) => risky.has(effect));
}

export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error("Operation cancelled.")); };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export function steeringRestart(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { code?: unknown } | undefined)?.code === "steering_restart";
}
