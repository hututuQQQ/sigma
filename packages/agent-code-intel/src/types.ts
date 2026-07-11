export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: unknown[];
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

export interface LspTransport {
  write(data: Uint8Array, signal?: AbortSignal): Promise<void>;
  chunks(signal?: AbortSignal): AsyncIterable<Uint8Array>;
  close(): Promise<void>;
}

export interface LspClientOptions {
  rootPath: string;
  transport: LspTransport;
  requestTimeoutMs?: number;
  clientName?: string;
  onNotification?(method: string, params: unknown): void;
}

export interface LanguageServerPreset {
  id: "typescript" | "python" | "rust" | "go" | string;
  languages: string[];
  executable: string;
  args: string[];
  source: "bundled" | "path" | "configured";
  available: boolean;
  unavailableReason?: string;
}

export interface DiscoverLanguageServersOptions {
  bundledRoot?: string;
  nodeExecutable?: string;
  pathValue?: string;
  platform?: NodeJS.Platform;
  configured?: LanguageServerPreset[];
}
