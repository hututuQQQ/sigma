import { Buffer } from "node:buffer";
import type { ExecutionBroker, WebNetworkTarget } from "agent-execution";
import type { ToolCallApproval, ToolCallPlan } from "agent-protocol";
import type { SearchProviderResult, WebSearchInput } from "./types.js";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
export const EXA_ADVANCED_MCP_URL =
  "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa";
export const EXA_ORIGIN = "https://mcp.exa.ai";

interface SearchAuthority {
  callPlan: ToolCallPlan;
  approval: ToolCallApproval | undefined;
  signal: AbortSignal;
}

interface McpContent {
  type?: unknown;
  text?: unknown;
}

function mcpPayload(body: string): Record<string, unknown> {
  const candidates = [body.trim(), ...body.split(/\r?\n/gu)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())]
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)
        && ("result" in value || "error" in value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // SSE may include comments, event names, or keep-alive frames.
    }
  }
  throw Object.assign(new Error("Exa returned neither a JSON nor SSE MCP result."), {
    code: "web_provider_malformed"
  });
}

function mcpText(payload: Record<string, unknown>): string {
  if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
    const error = payload.error as Record<string, unknown>;
    throw Object.assign(new Error(
      `Exa MCP error: ${typeof error.message === "string" ? error.message : "unknown error"}`
    ), { code: "web_provider_error" });
  }
  const result = payload.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw Object.assign(new Error("Exa MCP response is missing result content."), {
      code: "web_provider_malformed"
    });
  }
  const resultRecord = result as Record<string, unknown>;
  const content = resultRecord.content;
  if (!Array.isArray(content)) {
    throw Object.assign(new Error("Exa MCP response content is malformed."), {
      code: "web_provider_malformed"
    });
  }
  const text = (content as McpContent[])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  if (resultRecord.isError === true) {
    throw Object.assign(new Error(
      `Exa MCP tool error: ${text.trim().slice(0, 500) || "unknown error"}`
    ), { code: "web_provider_error" });
  }
  if (!text.trim()) {
    throw Object.assign(new Error("Exa MCP response contains no text results."), {
      code: "web_provider_empty"
    });
  }
  return text;
}

function httpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value.replace(/[),.;\]}]+$/u, ""));
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function titleNear(text: string, offset: number, fallback: string): string {
  const preceding = text.slice(Math.max(0, offset - 500), offset).split(/\r?\n/gu).reverse();
  for (const line of preceding) {
    const value = line
      .replace(/^\s*(?:#+|\*+|-+|\d+[.)]|title\s*:)\s*/iu, "")
      .replace(/\[([^\]]+)\]\([^)]*$/u, "$1")
      .trim();
    if (value && !/^url\s*:/iu.test(value)) return value.slice(0, 300);
  }
  return fallback;
}

function snippetNear(text: string, offset: number, urlLength: number): string | undefined {
  const value = text.slice(offset + urlLength, offset + urlLength + 700)
    .replace(/^\s*[)\]}>:—-]*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return value ? value.slice(0, 500) : undefined;
}

function objectResults(rawText: string): SearchProviderResult["results"] {
  let value: unknown;
  try {
    value = JSON.parse(rawText);
  } catch {
    return [];
  }
  const root = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const values = Array.isArray(value) ? value
    : Array.isArray(root.results) ? root.results
      : Array.isArray(root.data) ? root.data : [];
  return values.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    const url = typeof entry.url === "string" ? httpsUrl(entry.url) : undefined;
    if (!url) return [];
    const title = typeof entry.title === "string" && entry.title.trim()
      ? entry.title.trim().slice(0, 300) : new URL(url).hostname;
    const snippet = [entry.text, entry.snippet, entry.summary]
      .find((candidate) => typeof candidate === "string");
    return [{
      url,
      title,
      ...(typeof snippet === "string" ? { snippet: snippet.replace(/\s+/gu, " ").slice(0, 500) } : {})
    }];
  });
}

function textResults(rawText: string): SearchProviderResult["results"] {
  const results = objectResults(rawText);
  const markdown = /\[([^\]\n]{1,300})\]\((https:\/\/[^)\s]+)\)/giu;
  for (const match of rawText.matchAll(markdown)) {
    const url = httpsUrl(match[2]!);
    if (!url) continue;
    results.push({
      url,
      title: match[1]!.replace(/\s+/gu, " ").trim(),
      ...(snippetNear(rawText, match.index!, match[0].length)
        ? { snippet: snippetNear(rawText, match.index!, match[0].length) } : {})
    });
  }
  const bare = /https:\/\/[^\s<>"']+/giu;
  for (const match of rawText.matchAll(bare)) {
    const url = httpsUrl(match[0]);
    if (!url) continue;
    results.push({
      url,
      title: titleNear(rawText, match.index!, new URL(url).hostname),
      ...(snippetNear(rawText, match.index!, match[0].length)
        ? { snippet: snippetNear(rawText, match.index!, match[0].length) } : {})
    });
  }
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  }).slice(0, 8);
}

function advancedArguments(input: WebSearchInput, now: Date): Record<string, unknown> {
  return {
    query: input.q,
    type: "auto",
    numResults: 8,
    textMaxCharacters: 2_000,
    ...(input.domains ? { includeDomains: input.domains } : {}),
    ...(input.recency ? {
      startPublishedDate: new Date(now.getTime() - input.recency * 86_400_000)
        .toISOString().slice(0, 10)
    } : {})
  };
}

function searchArguments(input: WebSearchInput, now: Date): {
  url: string;
  name: string;
  arguments: Record<string, unknown>;
} {
  if (input.domains || input.recency) {
    return {
      url: EXA_ADVANCED_MCP_URL,
      name: "web_search_advanced_exa",
      arguments: advancedArguments(input, now)
    };
  }
  return {
    url: EXA_MCP_URL,
    name: "web_search_exa",
    arguments: {
      query: input.q,
      type: "fast",
      numResults: 8,
      livecrawl: "preferred",
      contextMaxCharacters: 12_000
    }
  };
}

function targets(plan: ToolCallPlan): WebNetworkTarget[] {
  const values = plan.networkTargets ?? [];
  if (!values.some((target) => target.origin === EXA_ORIGIN && target.method === "POST")) {
    throw Object.assign(new Error("Exa request is absent from the approved network plan."), {
      code: "web_network_plan_invalid"
    });
  }
  return values;
}

export interface WebSearchProvider {
  readonly name: "exa";
  search(input: WebSearchInput, authority: SearchAuthority): Promise<SearchProviderResult>;
}

export class ExaWebSearchProvider implements WebSearchProvider {
  readonly name = "exa" as const;
  private sequence = 1;
  private readonly sessionIds = new Map<string, string>();

  constructor(
    private readonly broker: ExecutionBroker,
    private readonly apiKey: string | undefined,
    private readonly now: () => Date
  ) {}

  async search(input: WebSearchInput, authority: SearchAuthority): Promise<SearchProviderResult> {
    if (!this.broker.webRequest) {
      throw Object.assign(new Error("Connected broker does not provide Web requests."), {
        code: "web_broker_unavailable"
      });
    }
    const call = searchArguments(input, this.now());
    const sessionId = this.sessionIds.get(call.url);
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id: this.sequence++,
      method: "tools/call",
      params: call
    }), "utf8");
    const response = await this.broker.webRequest({
      url: call.url,
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {})
      },
      body,
      networkTargets: targets(authority.callPlan),
      networkApproved: authority.approval?.networkApproved === true,
      timeoutMs: 30_000,
      maxResponseBytes: 5 * 1_024 * 1_024
    }, { signal: authority.signal, timeoutMs: 60_000 });
    const nextSessionId = response.headers["mcp-session-id"];
    if (nextSessionId) this.sessionIds.set(call.url, nextSessionId);
    if (response.status === 429) {
      throw Object.assign(new Error(
        "Exa free MCP rate limit reached (429). Configure EXA_API_KEY and retry."
      ), { code: "web_provider_rate_limited" });
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`Exa MCP returned HTTP ${response.status}.`), {
        code: "web_provider_http_error"
      });
    }
    const rawText = mcpText(mcpPayload(new TextDecoder().decode(response.body)));
    const results = textResults(rawText);
    if (results.length === 0) {
      throw Object.assign(new Error("Exa search returned no usable HTTPS result URLs."), {
        code: "web_provider_empty"
      });
    }
    return { provider: "exa", rawText, results };
  }
}
