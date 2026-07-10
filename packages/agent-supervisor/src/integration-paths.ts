import path from "node:path";

interface IntegrationIsolation {
  repositoryRoot?: string;
  sourceWorkspacePath: string;
}

export function nulPaths(output: string): string[] {
  return output.split("\0").filter(Boolean).map((item) => item.replaceAll("\\", "/"));
}

function withinWriteScope(file: string, scopes: string[]): boolean {
  if (scopes.length === 0) return true;
  const normalized = file.replaceAll("\\", "/");
  return scopes.some((scope) => {
    const candidate = scope.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}

export function outsideWriteScope(
  isolation: IntegrationIsolation,
  scopes: string[],
  files: string[]
): string[] {
  const repositoryRoot = isolation.repositoryRoot;
  if (!repositoryRoot) return files.filter((file) => !withinWriteScope(file, scopes));
  const prefix = path.relative(repositoryRoot, isolation.sourceWorkspacePath).replaceAll("\\", "/");
  const effective = !prefix ? scopes : scopes.map((scope) => `${prefix}/${scope.replaceAll("\\", "/").replace(/^\.\//u, "")}`);
  return files.filter((file) => !withinWriteScope(file, effective));
}
