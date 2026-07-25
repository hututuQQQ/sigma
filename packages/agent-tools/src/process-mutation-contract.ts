import { lstat } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "agent-protocol";
import { isInside, resolveWorkspacePath } from "agent-platform";

type ProcessAccess = "readonly" | "write";

export interface ProcessMutationContract {
  access: ProcessAccess;
  scope: "workspace" | "enclosing_container";
  writeRoots: string[];
  expectedChanges: string[];
}

interface ProcessMutationDeclaration {
  access?: ProcessAccess;
  legacy: string[];
  writeRoots: string[];
  expectedChanges: string[];
}

export function writePlanError(
  message: string,
  code: "write_scope_required" | "write_plan_invalid" | "write_plan_missing" | "write_plan_stale" | "policy_denied"
): Error {
  return Object.assign(new Error(message), { code });
}

function pathStrings(input: Record<string, JsonValue>, key: string): string[] {
  const value = input[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Tool argument '${key}' must be a string array.`);
  }
  const values = [...value] as string[];
  if (values.some((item) => item.length === 0)) {
    throw writePlanError(`${key} entries must be non-empty paths.`, "write_plan_invalid");
  }
  return [...new Set(values)];
}

function mutationDeclaration(input: Record<string, JsonValue>): ProcessMutationDeclaration {
  const rawAccess = input.access;
  if (rawAccess !== undefined && rawAccess !== "readonly" && rawAccess !== "write") {
    throw writePlanError("access must be readonly or write.", "write_plan_invalid");
  }
  const access = rawAccess as ProcessAccess | undefined;
  const legacy = pathStrings(input, "writePaths");
  const writeRoots = pathStrings(input, "writeRoots");
  const expectedChanges = pathStrings(input, "expectedChanges");
  const hasNewWriteScope = writeRoots.length + expectedChanges.length > 0;
  if (legacy.length > 0 && hasNewWriteScope) {
    throw writePlanError(
      "Legacy writePaths cannot be combined with writeRoots or expectedChanges.",
      "write_plan_invalid"
    );
  }
  return { ...(access ? { access } : {}), legacy, writeRoots, expectedChanges };
}

function readonlyContract(declaration: ProcessMutationDeclaration): ProcessMutationContract {
  const declaredPaths = declaration.legacy.length + declaration.writeRoots.length + declaration.expectedChanges.length;
  if (declaredPaths > 0) {
    throw writePlanError("Readonly process access cannot declare write scope.", "write_plan_invalid");
  }
  return {
    access: "readonly",
    scope: "workspace",
    writeRoots: [],
    expectedChanges: []
  };
}

function writeContract(
  declaration: ProcessMutationDeclaration,
  runMode: "analyze" | "change"
): ProcessMutationContract {
  if (runMode !== "change") {
    throw writePlanError("Process write access is unavailable in analyze mode.", "policy_denied");
  }
  const roots = declaration.legacy.length > 0 ? declaration.legacy : declaration.writeRoots;
  const expected = declaration.legacy.length > 0 ? declaration.legacy : declaration.expectedChanges;
  if (roots.length === 0 || expected.length === 0) {
    throw writePlanError(
      "Write access requires non-empty writeRoots and expectedChanges.",
      "write_scope_required"
    );
  }
  return {
    access: "write",
    scope: "workspace",
    writeRoots: roots,
    expectedChanges: expected
  };
}

async function nearestExistingWriteRoot(workspacePath: string, requested: string): Promise<string> {
  const workspaceRoot = await resolveWorkspacePath(workspacePath, ".");
  let current = path.resolve(workspaceRoot, requested);
  if (!isInside(workspaceRoot, current)) {
    throw writePlanError(`Process mutation path escapes the workspace: ${requested}.`, "write_plan_invalid");
  }
  for (;;) {
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      throw writePlanError(`Process mutation paths cannot traverse links: ${requested}.`, "write_plan_invalid");
    }
    if (info?.isDirectory()) return portableWorkspacePath(workspaceRoot, current);
    if (info) current = path.dirname(current);
    else {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (!isInside(workspaceRoot, current)) break;
  }
  throw writePlanError(`No existing workspace write root contains: ${requested}.`, "write_plan_invalid");
}

async function inferExpectedChangesContract(
  declaration: ProcessMutationDeclaration,
  workspacePath: string
): Promise<ProcessMutationDeclaration> {
  if (declaration.access || declaration.legacy.length > 0 || declaration.expectedChanges.length === 0) {
    return declaration;
  }
  const inferredRoots = declaration.writeRoots.length > 0
    ? declaration.writeRoots
    : await Promise.all(declaration.expectedChanges.map(async (item) =>
      await nearestExistingWriteRoot(workspacePath, item)
    ));
  return { ...declaration, access: "write", writeRoots: [...new Set(inferredRoots)] };
}

function isProtectedWorkspacePath(workspaceRoot: string, target: string): boolean {
  const relative = path.relative(workspaceRoot, target);
  return relative.split(path.sep).filter(Boolean)
    .some((segment) => segment.toLowerCase() === ".git" || segment.toLowerCase() === ".agent");
}

function portableWorkspacePath(workspaceRoot: string, target: string): string {
  const relative = path.relative(workspaceRoot, target).split(path.sep).join("/");
  return relative || ".";
}

async function stableMutationPath(
  workspaceRoot: string,
  requested: string,
  requireExisting: boolean
): Promise<string> {
  const lexical = path.resolve(workspaceRoot, requested);
  if (!isInside(workspaceRoot, lexical)) {
    throw writePlanError(`Process mutation path escapes the workspace: ${requested}.`, "write_plan_invalid");
  }
  const segments = path.relative(workspaceRoot, lexical).split(path.sep).filter(Boolean);
  let current = workspaceRoot;
  let missing = false;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) {
      missing = true;
      break;
    }
    if (info.isSymbolicLink()) {
      throw writePlanError(`Process mutation paths cannot traverse links: ${requested}.`, "write_plan_invalid");
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw writePlanError(`Process mutation path has a non-directory parent: ${requested}.`, "write_plan_invalid");
    }
  }
  if (requireExisting && missing) {
    throw writePlanError(`Process writeRoots must already exist: ${requested}.`, "write_plan_invalid");
  }
  return await resolveWorkspacePath(workspaceRoot, requested).catch((error) => {
    throw writePlanError(
      `Invalid process mutation path '${requested}': ${error instanceof Error ? error.message : String(error)}`,
      "write_plan_invalid"
    );
  });
}

async function stableEnclosingContainerPath(
  requested: string,
  requireExisting: boolean
): Promise<string> {
  if (!path.isAbsolute(requested)) {
    throw writePlanError(
      `Enclosing-container mutation paths must be canonical absolute paths: ${requested}.`,
      "write_plan_invalid"
    );
  }
  const lexical = path.resolve(requested);
  const filesystemRoot = path.parse(lexical).root;
  const segments = path.relative(filesystemRoot, lexical).split(path.sep).filter(Boolean);
  let current = filesystemRoot;
  let missing = false;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) {
      missing = true;
      break;
    }
    if (info.isSymbolicLink()) {
      throw writePlanError(
        `Enclosing-container mutation paths cannot traverse links: ${requested}.`,
        "write_plan_invalid"
      );
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw writePlanError(
        `Enclosing-container mutation path has a non-directory parent: ${requested}.`,
        "write_plan_invalid"
      );
    }
  }
  if (requireExisting && missing) {
    throw writePlanError(
      `Process writeRoots must already exist: ${requested}.`,
      "write_plan_invalid"
    );
  }
  return lexical;
}

function mutationContractScope(
  workspaceRoot: string,
  contract: ProcessMutationContract
): ProcessMutationContract["scope"] {
  const classify = (item: string): ProcessMutationContract["scope"] => {
    const lexical = path.isAbsolute(item)
      ? path.resolve(item)
      : path.resolve(workspaceRoot, item);
    return isInside(workspaceRoot, lexical) ? "workspace" : "enclosing_container";
  };
  const scopes = new Set([
    ...contract.writeRoots.map(classify),
    ...contract.expectedChanges.map(classify)
  ]);
  if (scopes.size !== 1) {
    throw writePlanError(
      "A process call cannot mix workspace and enclosing-container mutations; use separate calls so workspace rollback remains complete.",
      "write_plan_invalid"
    );
  }
  return [...scopes][0] ?? "workspace";
}

function assertMutationScopeAllowed(
  scope: ProcessMutationContract["scope"],
  background: boolean,
  writeScope: "workspace" | "enclosing-container"
): void {
  if (scope === "enclosing_container" && writeScope !== "enclosing-container") {
    throw writePlanError(
      "Absolute mutation paths outside the workspace require writeScope=enclosing-container.",
      "policy_denied"
    );
  }
  if (background && scope === "workspace") {
    throw writePlanError(
      "Background processes cannot receive workspace write access.",
      "policy_denied"
    );
  }
}

function stablePathResolver(
  workspaceRoot: string,
  scope: ProcessMutationContract["scope"]
): (item: string, requireExisting: boolean) => Promise<string> {
  if (scope === "workspace") {
    return async (item, requireExisting) =>
      await stableMutationPath(workspaceRoot, item, requireExisting);
  }
  return async (item, requireExisting) =>
    await stableEnclosingContainerPath(item, requireExisting);
}

async function assertStableWriteRoots(
  roots: readonly string[],
  declaredRoots: readonly string[]
): Promise<void> {
  for (const [index, root] of roots.entries()) {
    const info = await lstat(root).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw writePlanError(
        `Process writeRoots must be stable existing directories: ${declaredRoots[index]}.`,
        "write_plan_invalid"
      );
    }
  }
}

function assertExpectedChangesContained(
  roots: readonly string[],
  expected: readonly string[],
  declaredExpected: readonly string[]
): void {
  const outside = declaredExpected.filter((_item, index) =>
    !roots.some((root) => isInside(root, expected[index]!)));
  if (outside.length === 0) return;
  throw writePlanError(
    `Expected changes must be contained by writeRoots: ${outside.join(", ")}.`,
    "write_plan_invalid"
  );
}

function projectedMutationContract(
  workspaceRoot: string,
  scope: ProcessMutationContract["scope"],
  roots: string[],
  expected: string[]
): ProcessMutationContract {
  if (scope === "enclosing_container") {
    return {
      access: "write",
      scope,
      writeRoots: roots,
      expectedChanges: expected
    };
  }
  return {
    access: "write",
    scope,
    writeRoots: roots.map((item) => portableWorkspacePath(workspaceRoot, item)),
    expectedChanges: expected.map((item) => portableWorkspacePath(workspaceRoot, item))
  };
}

async function validateMutationContract(
  workspacePath: string,
  contract: ProcessMutationContract,
  background: boolean,
  writeScope: "workspace" | "enclosing-container"
): Promise<ProcessMutationContract> {
  if (contract.access === "readonly") return contract;
  const workspaceRoot = await resolveWorkspacePath(workspacePath, ".");
  const scope = mutationContractScope(workspaceRoot, contract);
  assertMutationScopeAllowed(scope, background, writeScope);
  const stable = stablePathResolver(workspaceRoot, scope);
  const roots = await Promise.all(contract.writeRoots.map(async (item) =>
    await stable(item, true)
  ));
  await assertStableWriteRoots(roots, contract.writeRoots);
  const expected = await Promise.all(contract.expectedChanges.map(async (item) =>
    await stable(item, false)
  ));
  if (scope === "workspace"
    && [...roots, ...expected].some((item) => isProtectedWorkspacePath(workspaceRoot, item))) {
    throw writePlanError("Process write scope cannot include .git or .agent metadata.", "policy_denied");
  }
  assertExpectedChangesContained(roots, expected, contract.expectedChanges);
  return projectedMutationContract(workspaceRoot, scope, roots, expected);
}

export async function processMutationContract(
  input: Record<string, JsonValue>,
  workspacePath: string,
  runMode: "analyze" | "change",
  background: boolean,
  writeScope: "workspace" | "enclosing-container" = "workspace"
): Promise<ProcessMutationContract> {
  const declaration = await inferExpectedChangesContract(mutationDeclaration(input), workspacePath);
  const contract = declaration.access === "write" || declaration.legacy.length > 0
    ? writeContract(declaration, runMode)
    : readonlyContract(declaration);
  return await validateMutationContract(workspacePath, contract, background, writeScope);
}
