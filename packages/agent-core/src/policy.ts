import path from "node:path";

export function isPathInside(parentPath: string, candidatePath: string): boolean {
  const parent = path.resolve(parentPath);
  const candidate = path.resolve(candidatePath);
  const normalizedParent = process.platform === "win32" ? parent.toLowerCase() : parent;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
}

export function resolveWorkspacePath(workspacePath: string, requestedPath: string): string {
  const workspace = path.resolve(workspacePath);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspace, requestedPath);

  if (!isPathInside(workspace, candidate)) {
    throw new Error(`Path is outside the workspace: ${requestedPath}`);
  }

  return candidate;
}

export function isProbablyMutatingCommand(command: string): boolean {
  const patterns = [
    /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln)\b/,
    /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update|exec|run)\b/,
    /\b(git)\s+(add|commit|push|checkout|switch|reset|clean|merge|rebase|apply)\b/,
    /\b(python|python3|node|tsx|ts-node)\b/,
    />\s*[^&]|\btee\b|\bsed\s+-i\b/
  ];
  return patterns.some((pattern) => pattern.test(command));
}
