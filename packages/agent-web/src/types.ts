import type {
  ArtifactRef,
  RuntimeControlPort,
  ToolCallPlan,
  ToolExecutionContext
} from "agent-protocol";
import type { ExecutionBroker } from "agent-execution";

export interface WebSearchInput {
  q: string;
  domains?: string[];
  recency?: number;
}

export interface WebOpenInput {
  ref_id: string;
  lineno?: number;
}

export interface WebClickInput {
  ref_id: string;
  id: number;
}

export interface WebFindInput {
  ref_id: string;
  pattern: string;
}

export interface WebRunInput {
  search_query?: WebSearchInput[];
  open?: WebOpenInput[];
  click?: WebClickInput[];
  find?: WebFindInput[];
  response_length?: "short" | "medium" | "long";
}

export interface WebLink {
  id: number;
  title: string;
  url: string;
}

export interface WebManifestEntry {
  kind: "search_result" | "page";
  url: string;
  title: string;
  snippet?: string;
  bodyArtifactId?: string;
  lineCount?: number;
  links?: WebLink[];
}

export interface WebManifest {
  schemaVersion: 1;
  provider: "exa" | "direct";
  sourceArtifactId?: string;
  entries: WebManifestEntry[];
}

export interface WebOperationResult {
  operation: "search_query" | "open" | "click" | "find";
  index: number;
  status: "succeeded" | "failed";
  url?: string;
  title?: string;
  ref_id?: string;
  content?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  truncated: boolean;
}

export interface WebRunResult {
  version: 1;
  provider: "exa";
  operations: WebOperationResult[];
  truncated: boolean;
  contentTrust: "external_untrusted";
}

export interface WebExecutionResult {
  result: WebRunResult;
  output: string;
  artifacts: string[];
  artifactRefs: ArtifactRef[];
  usedNetwork: boolean;
}

export interface WebServiceOptions {
  broker: ExecutionBroker;
  apiKey?: string;
  now?: () => Date;
}

export interface WebExecutionAuthority {
  callPlan: ToolCallPlan;
  approval: ToolExecutionContext["approval"];
  signal: AbortSignal;
  createArtifact: ToolExecutionContext["createArtifact"];
  runtimeControl?: RuntimeControlPort;
}

export interface SearchProviderResult {
  provider: "exa";
  rawText: string;
  results: Array<{
    url: string;
    title: string;
    snippet?: string;
  }>;
}
