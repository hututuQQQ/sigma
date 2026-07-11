import path from "node:path";
import type { WorkspaceCustomizationTrustAttestation } from "agent-config";
import { workspaceCustomizationManifest } from "agent-extensions";
import type { WorkspaceExecutableHookArtifact } from "./customization.js";

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

export function verifyWorkspaceCustomizationTrust(
  workspacePath: string,
  executableWorkspaceHookIds: readonly string[],
  attestation: WorkspaceCustomizationTrustAttestation | undefined,
  resolvedArtifacts: readonly WorkspaceExecutableHookArtifact[] = []
): void {
  const required = executableWorkspaceHookIds.length > 0;
  if (!required && !attestation) return;
  if (!attestation) {
    throw new Error(
      `Workspace executable hooks (${executableWorkspaceHookIds.join(", ")}) require an explicit customization trust attestation.`
    );
  }
  if (!attestation.trusted) {
    throw new Error("Workspace customization is not trusted. Review workspace profiles, hooks, and skills, then rerun with --trust-workspace-customization.");
  }
  const manifest = workspaceCustomizationManifest(workspacePath);
  if (!samePath(manifest.canonicalWorkspacePath, attestation.canonicalWorkspacePath)) {
    throw new Error("Workspace customization trust does not match the canonical workspace path.");
  }
  if (manifest.customizationDigest !== attestation.customizationDigest) {
    throw new Error("Workspace customization changed after trust was evaluated; explicit trust is required again.");
  }
  const files = new Map(manifest.files.map((file) => [file.relativePath, file.digest]));
  for (const artifact of resolvedArtifacts) {
    const relativePath = path.relative(manifest.canonicalWorkspacePath, artifact.filePath).split(path.sep).join("/");
    if (relativePath === ".." || relativePath.startsWith("../") || files.get(relativePath) !== artifact.digest) {
      throw new Error(`Workspace hook '${artifact.id}' changed while customization was being resolved.`);
    }
  }
}
