import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { McpConfigSource, WorkspaceMcpTrustAttestation } from "agent-config";

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function digest(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export async function verifyWorkspaceMcpTrust(
  workspacePath: string,
  source: McpConfigSource,
  attestation: WorkspaceMcpTrustAttestation | undefined
): Promise<void> {
  if (source !== "workspace") {
    if (attestation) throw new Error("Workspace MCP trust attestation is invalid for a non-workspace configuration source.");
    return;
  }
  if (!attestation) throw new Error("Workspace MCP configuration requires an explicit trust attestation.");
  if (!attestation.trusted) {
    throw new Error("Workspace MCP configuration is not trusted. Review .agent/config.toml and rerun with --trust-workspace-mcp.");
  }
  const canonicalWorkspacePath = await realpath(workspacePath);
  if (!samePath(canonicalWorkspacePath, attestation.canonicalWorkspacePath)) {
    throw new Error("Workspace MCP trust does not match the canonical workspace path.");
  }
  const configSource = await readFile(path.join(canonicalWorkspacePath, ".agent", "config.toml"));
  if (digest(configSource) !== attestation.configDigest) {
    throw new Error("Workspace MCP configuration changed after trust was evaluated; explicit trust is required again.");
  }
}
