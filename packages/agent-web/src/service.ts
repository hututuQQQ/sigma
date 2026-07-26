import type {
  RuntimeControlPort,
  ToolCallPlan
} from "agent-protocol";
import type { WebResponse } from "agent-execution";
import {
  createExternalArtifact,
  readWebBody,
  resolveWebReference,
  webReference
} from "./artifacts.js";
import {
  EXA_ORIGIN,
  ExaWebSearchProvider,
  type WebSearchProvider
} from "./exa-provider.js";
import { normalizePage } from "./normalize.js";
import {
  boundedWebOutput,
  findLiteral,
  isDirectWebUrl,
  lineNumbered,
  orderedOperations,
  planWebRun,
  resolveClickUrl,
  resolveOpenUrl,
  webOperationError,
  type InternalOperation,
  type OrderedOperation
} from "./service-support.js";
import type {
  WebClickInput,
  WebExecutionAuthority,
  WebExecutionResult,
  WebFindInput,
  WebManifest,
  WebOpenInput,
  WebRunInput,
  WebRunResult,
  WebSearchInput,
  WebServiceOptions
} from "./types.js";

export class WebResearchService {
  private readonly provider: WebSearchProvider;

  constructor(private readonly options: WebServiceOptions) {
    this.provider = new ExaWebSearchProvider(
      options.broker,
      options.apiKey,
      options.now ?? (() => new Date())
    );
  }

  async plan(input: WebRunInput, control?: RuntimeControlPort): Promise<ToolCallPlan> {
    return await planWebRun(input, control);
  }

  async execute(
    input: WebRunInput,
    authority: WebExecutionAuthority
  ): Promise<WebExecutionResult> {
    const settled: InternalOperation[] = [];
    for (const operation of orderedOperations(input)) {
      const usesNetwork = operation.kind === "search_query"
        || operation.kind === "click"
        || (operation.kind === "open" && authority.callPlan.network === "full");
      try {
        settled.push(await this.executeOne(operation, authority));
      } catch (error) {
        settled.push(webOperationError(operation, error, usesNetwork));
      }
    }
    const bounded = boundedWebOutput(
      settled.map((item) => item.result),
      input.response_length
    );
    const result: WebRunResult = {
      version: 1,
      provider: "exa",
      operations: bounded.operations,
      truncated: bounded.truncated,
      contentTrust: "external_untrusted"
    };
    return {
      result,
      output: bounded.output,
      artifacts: [...new Set(settled.flatMap((item) => item.artifacts))],
      artifactRefs: settled.flatMap((item) => item.artifactRefs),
      usedNetwork: settled.some((item) => item.usedNetwork)
    };
  }

  private async executeOne(
    operation: OrderedOperation,
    authority: WebExecutionAuthority
  ): Promise<InternalOperation> {
    if (operation.kind === "search_query") {
      return await this.search(operation.index, operation.input, authority);
    }
    if (operation.kind === "open") {
      return await this.open(operation.index, operation.input, authority);
    }
    if (operation.kind === "click") {
      return await this.click(operation.index, operation.input, authority);
    }
    return await this.find(operation.index, operation.input, authority);
  }

  private async search(
    index: number,
    input: WebSearchInput,
    authority: WebExecutionAuthority
  ): Promise<InternalOperation> {
    const search = await this.provider.search(input, authority);
    const raw = await createExternalArtifact(
      authority, `web-search-${index + 1}.txt`, search.rawText, "text/plain; charset=utf-8"
    );
    const manifest: WebManifest = {
      schemaVersion: 1,
      provider: "exa",
      sourceArtifactId: raw.artifactId,
      entries: search.results.map((result) => ({
        kind: "search_result",
        url: result.url,
        title: result.title,
        ...(result.snippet ? { snippet: result.snippet } : {})
      }))
    };
    const content = JSON.stringify(manifest);
    const stored = await createExternalArtifact(
      authority, `web-search-${index + 1}.manifest.json`, content, "application/json"
    );
    const rendered = manifest.entries.map((entry, entryIndex) => [
      `${entryIndex + 1}. ${entry.title}`,
      `URL: ${entry.url}`,
      `Ref: ${webReference(stored.artifactId, entryIndex)}`,
      ...(entry.snippet ? [`Snippet: ${entry.snippet}`] : [])
    ].join("\n")).join("\n\n");
    return {
      result: {
        operation: "search_query",
        index,
        status: "succeeded",
        title: `Search: ${input.q}`,
        url: EXA_ORIGIN,
        ref_id: webReference(stored.artifactId, 0),
        content: rendered,
        truncated: false
      },
      artifacts: [raw.artifactId, stored.artifactId],
      artifactRefs: [raw.ref, stored.ref],
      usedNetwork: true
    };
  }

  private async requestPage(
    url: string,
    authority: WebExecutionAuthority
  ): Promise<WebResponse> {
    if (!this.options.broker.webRequest) {
      throw Object.assign(new Error("Connected broker does not provide Web requests."), {
        code: "web_broker_unavailable"
      });
    }
    return await this.options.broker.webRequest({
      url,
      method: "GET",
      headers: {
        accept: "text/html,text/plain,text/markdown,application/json,application/xml,application/rss+xml,application/atom+xml;q=0.9",
        "user-agent": "Sigma-Code-Web/1"
      },
      networkTargets: authority.callPlan.networkTargets ?? [],
      networkApproved: authority.approval?.networkApproved === true,
      timeoutMs: 30_000,
      maxResponseBytes: 5 * 1_024 * 1_024
    }, { signal: authority.signal, timeoutMs: 60_000 });
  }

  private async fetchedPage(
    index: number,
    operation: "open" | "click",
    url: string,
    lineno: number,
    authority: WebExecutionAuthority
  ): Promise<InternalOperation> {
    const response = await this.requestPage(url, authority);
    if (response.redirectUrl) {
      throw Object.assign(new Error(
        `Cross-origin redirect requires a new approved open call: ${response.redirectUrl}`
      ), { code: "web_cross_origin_redirect" });
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`Page returned HTTP ${response.status}.`), {
        code: "web_page_http_error"
      });
    }
    const page = normalizePage(
      response.body,
      response.headers["content-type"] ?? "",
      response.finalUrl
    );
    const body = await createExternalArtifact(
      authority, `web-page-${operation}-${index + 1}.md`, page.markdown,
      "text/markdown; charset=utf-8"
    );
    const manifest: WebManifest = {
      schemaVersion: 1,
      provider: "direct",
      entries: [{
        kind: "page",
        url: response.finalUrl,
        title: page.title,
        bodyArtifactId: body.artifactId,
        lineCount: page.markdown.split("\n").length,
        links: page.links
      }]
    };
    const content = JSON.stringify(manifest);
    const stored = await createExternalArtifact(
      authority, `web-page-${operation}-${index + 1}.manifest.json`, content, "application/json"
    );
    return {
      result: {
        operation,
        index,
        status: "succeeded",
        url: response.finalUrl,
        title: page.title,
        ref_id: webReference(stored.artifactId, 0),
        content: lineNumbered(page.markdown, lineno),
        truncated: page.truncated || response.truncated
      },
      artifacts: [body.artifactId, stored.artifactId],
      artifactRefs: [body.ref, stored.ref],
      usedNetwork: true
    };
  }

  private async open(
    index: number,
    input: WebOpenInput,
    authority: WebExecutionAuthority
  ): Promise<InternalOperation> {
    const url = await resolveOpenUrl(input, authority.runtimeControl);
    if (url) return await this.fetchedPage(index, "open", url, input.lineno ?? 1, authority);
    const reference = await resolveWebReference(input.ref_id, authority.runtimeControl);
    const body = await readWebBody(reference.entry, authority.runtimeControl);
    return {
      result: {
        operation: "open",
        index,
        status: "succeeded",
        url: reference.entry.url,
        title: reference.entry.title,
        ref_id: input.ref_id,
        content: lineNumbered(body, input.lineno ?? 1),
        truncated: false
      },
      artifacts: [],
      artifactRefs: [],
      usedNetwork: false
    };
  }

  private async click(
    index: number,
    input: WebClickInput,
    authority: WebExecutionAuthority
  ): Promise<InternalOperation> {
    const url = await resolveClickUrl(input, authority.runtimeControl);
    return await this.fetchedPage(index, "click", url, 1, authority);
  }

  private async find(
    index: number,
    input: WebFindInput,
    authority: WebExecutionAuthority
  ): Promise<InternalOperation> {
    if (isDirectWebUrl(input.ref_id)) {
      throw Object.assign(new Error("find requires an opened page reference."), {
        code: "web_find_ref_invalid"
      });
    }
    const reference = await resolveWebReference(input.ref_id, authority.runtimeControl);
    const body = await readWebBody(reference.entry, authority.runtimeControl);
    return {
      result: {
        operation: "find",
        index,
        status: "succeeded",
        url: reference.entry.url,
        title: reference.entry.title,
        ref_id: input.ref_id,
        content: findLiteral(body, input.pattern),
        truncated: false
      },
      artifacts: [],
      artifactRefs: [],
      usedNetwork: false
    };
  }
}
