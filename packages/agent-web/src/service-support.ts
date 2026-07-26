import type {
  ArtifactRef,
  RuntimeControlPort,
  ToolCallPlan
} from "agent-protocol";
import type { WebNetworkTarget } from "agent-execution";
import { resolveWebReference } from "./artifacts.js";
import { EXA_ORIGIN } from "./exa-provider.js";
import type {
  WebClickInput,
  WebFindInput,
  WebOpenInput,
  WebOperationResult,
  WebRunInput,
  WebSearchInput
} from "./types.js";

const OUTPUT_BUDGETS = { short: 4_000, medium: 8_000, long: 12_000 } as const;
const DIRECT_URL = /^https?:\/\//iu;

export interface InternalOperation {
  result: WebOperationResult;
  artifacts: string[];
  artifactRefs: ArtifactRef[];
  usedNetwork: boolean;
}

export type OrderedOperation =
  | { kind: "search_query"; index: number; input: WebSearchInput }
  | { kind: "open"; index: number; input: WebOpenInput }
  | { kind: "click"; index: number; input: WebClickInput }
  | { kind: "find"; index: number; input: WebFindInput };

export function isDirectWebUrl(value: string): boolean {
  return DIRECT_URL.test(value);
}

export function orderedOperations(input: WebRunInput): OrderedOperation[] {
  return [
    ...(input.search_query ?? []).map((item, index) => ({
      kind: "search_query" as const, index, input: item
    })),
    ...(input.open ?? []).map((item, index) => ({
      kind: "open" as const, index, input: item
    })),
    ...(input.click ?? []).map((item, index) => ({
      kind: "click" as const, index, input: item
    })),
    ...(input.find ?? []).map((item, index) => ({
      kind: "find" as const, index, input: item
    }))
  ];
}

function canonicalTarget(value: string, method: "GET" | "POST"): WebNetworkTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("Web URL must be absolute."), { code: "web_url_invalid" });
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw Object.assign(new Error("Web URL must be public HTTP(S) without credentials or a fragment."), {
      code: "web_url_invalid"
    });
  }
  return { origin: url.origin, method };
}

export async function resolveOpenUrl(
  input: WebOpenInput,
  control: RuntimeControlPort | undefined
): Promise<string | undefined> {
  if (isDirectWebUrl(input.ref_id)) return input.ref_id;
  const reference = await resolveWebReference(input.ref_id, control);
  return reference.entry.kind === "search_result" ? reference.entry.url : undefined;
}

export async function resolveClickUrl(
  input: WebClickInput,
  control: RuntimeControlPort | undefined
): Promise<string> {
  if (isDirectWebUrl(input.ref_id)) {
    throw Object.assign(new Error("click requires an opened page reference."), {
      code: "web_click_ref_invalid"
    });
  }
  const reference = await resolveWebReference(input.ref_id, control);
  if (reference.entry.kind !== "page" || !reference.entry.links) {
    throw Object.assign(new Error("click requires an opened HTML page with static links."), {
      code: "web_click_ref_invalid"
    });
  }
  const link = reference.entry.links.find((item) => item.id === input.id);
  if (!link || typeof link.url !== "string") {
    throw Object.assign(new Error(`Static link ${input.id} does not exist on this page.`), {
      code: "web_link_missing"
    });
  }
  return link.url;
}

async function plannedTargets(
  input: WebRunInput,
  control: RuntimeControlPort | undefined
): Promise<WebNetworkTarget[]> {
  const values: WebNetworkTarget[] = [];
  for (const operation of orderedOperations(input)) {
    if (operation.kind === "search_query") {
      values.push({ origin: EXA_ORIGIN, method: "POST" });
    } else if (operation.kind === "open") {
      const url = await resolveOpenUrl(operation.input, control);
      if (url) values.push(canonicalTarget(url, "GET"));
    } else if (operation.kind === "click") {
      values.push(canonicalTarget(await resolveClickUrl(operation.input, control), "GET"));
    }
  }
  const seen = new Set<string>();
  return values.filter((target) => {
    const key = `${target.method}\0${target.origin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function planWebRun(
  input: WebRunInput,
  control: RuntimeControlPort | undefined
): Promise<ToolCallPlan> {
  const targets = await plannedTargets(input, control);
  const network = targets.length > 0;
  return {
    exactEffects: network ? ["network"] : [],
    readPaths: [],
    writePaths: [],
    network: network ? "full" : "none",
    ...(network ? { networkTargets: targets } : {}),
    processMode: "none",
    checkpointScope: [],
    idempotence: "read_only"
  };
}

export function webOperationError(
  operation: OrderedOperation,
  error: unknown,
  usedNetwork: boolean
): InternalOperation {
  const value = error instanceof Error ? error : new Error(String(error));
  const code = typeof (value as Error & { code?: unknown }).code === "string"
    ? String((value as Error & { code?: unknown }).code) : "web_operation_failed";
  return {
    result: {
      operation: operation.kind,
      index: operation.index,
      status: "failed",
      error: {
        code,
        message: value.message.slice(0, 1_000),
        retryable: [
          "web_request_failed",
          "web_provider_rate_limited",
          "web_provider_http_error"
        ].includes(code)
      },
      truncated: false
    },
    artifacts: [],
    artifactRefs: [],
    usedNetwork
  };
}

export function lineNumbered(markdown: string, startLine = 1): string {
  const lines = markdown.split("\n");
  const first = Math.min(lines.length, Math.max(0, startLine - 1));
  return lines.slice(first).map((line, index) => `L${first + index + 1}: ${line}`).join("\n");
}

export function findLiteral(markdown: string, pattern: string): string {
  const lines = markdown.split("\n");
  const needle = pattern.toLocaleLowerCase();
  const matches = lines.flatMap((line, index) =>
    line.toLocaleLowerCase().includes(needle) ? [index] : []).slice(0, 20);
  if (matches.length === 0) return `No literal matches for "${pattern}".`;
  const shown = new Set<number>();
  const groups = matches.map((index) => {
    const values: string[] = [];
    for (let line = Math.max(0, index - 1); line <= Math.min(lines.length - 1, index + 1); line += 1) {
      if (shown.has(line)) continue;
      shown.add(line);
      values.push(`L${line + 1}: ${lines[line]}`);
    }
    return values.join("\n");
  }).filter(Boolean);
  return groups.join("\n--\n");
}

function operationOutput(result: WebOperationResult): string {
  const heading = `[${result.operation} ${result.index + 1}] ${result.status}`;
  if (result.status === "failed") {
    return `${heading}\nError: ${result.error?.code}: ${result.error?.message}`;
  }
  return [
    heading,
    ...(result.title ? [`Title: ${result.title}`] : []),
    ...(result.url ? [`URL: ${result.url}`] : []),
    ...(result.ref_id ? [`Ref: ${result.ref_id}`] : []),
    ...(result.content ? [result.content] : [])
  ].join("\n");
}

export function boundedWebOutput(
  values: WebOperationResult[],
  responseLength: WebRunInput["response_length"]
): { operations: WebOperationResult[]; output: string; truncated: boolean } {
  const output: string[] = [];
  const results: WebOperationResult[] = [];
  let remaining: number = OUTPUT_BUDGETS[responseLength ?? "short"];
  let truncated = false;
  for (const value of values) {
    const separator = output.length === 0 ? "" : "\n\n";
    const full = operationOutput(value);
    const available = Math.max(0, remaining - separator.length);
    if (full.length <= available) {
      output.push(full);
      results.push(value);
      remaining -= separator.length + full.length;
      continue;
    }
    const marker = "...[web output truncated]...";
    if (available > 0) {
      const bounded = available <= marker.length
        ? marker.slice(0, available)
        : `${full.slice(0, available - marker.length)}${marker}`;
      output.push(bounded);
      results.push({ ...value, content: bounded, truncated: true });
    } else {
      const { content: _content, ...metadata } = value;
      results.push({ ...metadata, truncated: true });
    }
    remaining = 0;
    truncated = true;
  }
  return { operations: results, output: output.join("\n\n"), truncated };
}
