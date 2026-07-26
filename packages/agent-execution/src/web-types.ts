export interface WebNetworkTarget {
  origin: string;
  method: "GET" | "POST";
}

export interface WebRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: Uint8Array;
  networkTargets: WebNetworkTarget[];
  networkApproved: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface WebResponse {
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Cross-origin redirects are returned without being followed. */
  redirectUrl?: string;
  truncated: boolean;
  redacted: boolean;
}
