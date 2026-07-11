import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { HookDefinition, HookEvent } from "./hooks.js";

export type HookSource = "home" | "workspace";

export interface HookDiscoveryRoot {
  source: HookSource;
  directory: string;
}

export interface DiscoveredHook {
  source: HookSource;
  filePath: string;
  digest: string;
  definition: HookDefinition;
}

const EVENTS: readonly HookEvent[] = [
  "session_start", "run_start", "pre_model", "post_model", "pre_tool",
  "post_tool", "plan_changed", "pre_complete", "run_end"
];
const COMMON_KEYS = new Set(["id", "event", "kind", "required", "timeout_ms"]);
const COMMAND_KEYS = new Set([...COMMON_KEYS, "command", "args", "cwd", "trust_paths"]);
const PROFILE_KEYS = new Set([...COMMON_KEYS, "profile_id", "prompt"]);
const MAX_HOOK_FILE_BYTES = 1_048_576;

export function parseHookToml(source: string, filePath = "<hook>"): HookDefinition {
  let parsed: unknown;
  try { parsed = parseToml(source); } catch (error) {
    throw new Error(`Invalid hook TOML '${filePath}': ${messageOf(error)}`, { cause: error });
  }
  const root = objectValue(parsed, filePath);
  const kind = enumValue(root.kind, ["command", "agent_profile"] as const, `${filePath}.kind`);
  rejectUnknown(root, kind === "command" ? COMMAND_KEYS : PROFILE_KEYS, filePath);
  const common = {
    id: hookId(root.id, `${filePath}.id`),
    event: enumValue(root.event, EVENTS, `${filePath}.event`),
    required: booleanValue(root.required ?? false, `${filePath}.required`),
    timeoutMs: positiveInteger(root.timeout_ms ?? 30_000, `${filePath}.timeout_ms`)
  };
  if (kind === "command") {
    return {
      ...common,
      kind,
      command: stringValue(root.command, `${filePath}.command`),
      args: root.args === undefined ? [] : stringArray(root.args, `${filePath}.args`),
      ...(root.cwd === undefined ? {} : { cwd: stringValue(root.cwd, `${filePath}.cwd`) }),
      ...(root.trust_paths === undefined ? {} : {
        trustPaths: stringArray(root.trust_paths, `${filePath}.trust_paths`)
      })
    };
  }
  return {
    ...common,
    kind,
    profileId: hookId(root.profile_id, `${filePath}.profile_id`),
    prompt: stringValue(root.prompt, `${filePath}.prompt`)
  };
}

export async function discoverHooks(roots: readonly HookDiscoveryRoot[]): Promise<DiscoveredHook[]> {
  const hooks: DiscoveredHook[] = [];
  const ids = new Map<string, string>();
  for (const root of roots) {
    for (const name of await hookFiles(root.directory)) {
      const declaredPath = path.join(root.directory, name);
      const filePath = await containedFile(root.directory, declaredPath);
      const source = await boundedRead(filePath);
      let definition = parseHookToml(source, filePath);
      if (root.source === "workspace" && definition.kind === "command") {
        validateWorkspaceCommandAssets(root.directory, definition);
      } else if (root.source === "home" && definition.kind === "command") {
        definition = await resolveHomeCommandAssets(root.directory, definition);
      }
      const previous = ids.get(definition.id);
      if (previous) throw new Error(`Duplicate hook id '${definition.id}' in '${previous}' and '${filePath}'.`);
      ids.set(definition.id, filePath);
      hooks.push({ source: root.source, filePath, digest: sha256(source), definition });
    }
  }
  return hooks;
}

async function resolveHomeCommandAssets(
  hookDirectory: string,
  hook: Extract<HookDefinition, { kind: "command" }>
): Promise<Extract<HookDefinition, { kind: "command" }>> {
  const canonicalRoot = await realpath(hookDirectory);
  const resolveExisting = async (value: string): Promise<string> => {
    if (path.isAbsolute(value) || value.startsWith("-")) return value;
    const candidate = path.resolve(canonicalRoot, value);
    if (!existsSync(candidate)) return value;
    const canonical = await realpath(candidate);
    if (!contained(canonicalRoot, canonical)) {
      throw new Error(`Home hook '${hook.id}' asset '${value}' escapes ~/.sigma/hooks.`);
    }
    return canonical;
  };
  return {
    ...hook,
    command: await resolveExisting(hook.command),
    args: await Promise.all(hook.args.map(resolveExisting))
  };
}

function validateWorkspaceCommandAssets(hookDirectory: string, hook: Extract<HookDefinition, { kind: "command" }>): void {
  const workspace = path.resolve(hookDirectory, "..", "..");
  const cwd = path.resolve(workspace, hook.cwd ?? ".");
  if (!contained(workspace, cwd)) throw new Error(`Workspace hook '${hook.id}' cwd escapes the workspace.`);
  if (path.isAbsolute(hook.command) && !contained(workspace, path.resolve(hook.command))) {
    throw new Error(`Workspace hook '${hook.id}' must use a bare system command or a workspace-relative trusted executable.`);
  }
  const externalArgument = hook.args.find((value) =>
    path.isAbsolute(value) && !contained(workspace, path.resolve(value)));
  if (externalArgument) {
    throw new Error(`Workspace hook '${hook.id}' absolute argument '${externalArgument}' escapes its trusted workspace assets.`);
  }
  const trusted = (hook.trustPaths ?? []).map((item) => {
    if (!item.trim() || path.normalize(item) === ".") {
      throw new Error(`Workspace hook '${hook.id}' trust_paths must identify a file or contained subdirectory.`);
    }
    if (path.isAbsolute(item)) throw new Error(`Workspace hook '${hook.id}' trust_paths must be workspace-relative.`);
    const resolved = path.resolve(workspace, item);
    if (!contained(workspace, resolved)) throw new Error(`Workspace hook '${hook.id}' trust path '${item}' escapes the workspace.`);
    if (!existsSync(resolved)) throw new Error(`Workspace hook '${hook.id}' trust path '${item}' does not exist.`);
    return resolved;
  });
  rejectInlineInterpreter(hook);
  rejectImplicitWorkspaceLoader(hook);
  for (const value of [hook.command, ...hook.args]) {
    if (value.startsWith("-")) continue;
    const candidate = path.resolve(cwd, value);
    if (!contained(workspace, candidate) || !existsSync(candidate)) continue;
    if (!trusted.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`))) {
      throw new Error(`Workspace hook '${hook.id}' executable asset '${value}' must be declared in trust_paths.`);
    }
  }
}

function rejectImplicitWorkspaceLoader(hook: Extract<HookDefinition, { kind: "command" }>): void {
  const executable = path.basename(hook.command).toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "");
  const first = hook.args[0]?.toLowerCase();
  const implicit = new Set([
    "make", "nmake", "msbuild", "gradle", "gradlew", "mvn", "cargo",
    "npm", "npx", "pnpm", "pnpx", "yarn", "bun", "deno", "pipenv", "poetry"
  ]);
  const moduleLoader = ["python", "python3", "py"].includes(executable) && first === "-m";
  if (implicit.has(executable) || moduleLoader) {
    throw new Error(
      `Workspace hook '${hook.id}' cannot use '${executable}' because it implicitly loads executable code or configuration from cwd; invoke a declared trust_paths executable directly.`
    );
  }
}

function rejectInlineInterpreter(hook: Extract<HookDefinition, { kind: "command" }>): void {
  const executable = path.basename(hook.command).toLowerCase().replace(/\.exe$/u, "");
  const flags: Readonly<Record<string, ReadonlySet<string>>> = {
    node: new Set(["-e", "--eval", "-p", "--print"]),
    python: new Set(["-c"]), python3: new Set(["-c"]), py: new Set(["-c"]),
    ruby: new Set(["-e"]), perl: new Set(["-e"]),
    powershell: new Set(["-command", "-c"]), pwsh: new Set(["-command", "-c"]),
    cmd: new Set(["/c", "/k"]), sh: new Set(["-c"]), bash: new Set(["-c"]), zsh: new Set(["-c"])
  };
  const denied = flags[executable];
  if (denied && hook.args.some((item) => denied.has(item.toLowerCase()))) {
    throw new Error(
      `Workspace hook '${hook.id}' cannot use inline interpreter code; place executable code in a declared trust_paths asset.`
    );
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function defaultHookRoots(homeDirectory: string, workspaceDirectory: string): HookDiscoveryRoot[] {
  return [
    { source: "home", directory: path.join(homeDirectory, ".sigma", "hooks") },
    { source: "workspace", directory: path.join(workspaceDirectory, ".agent", "hooks") }
  ];
}

export class HookCatalog {
  readonly hooks: readonly DiscoveredHook[];
  private readonly byId: ReadonlyMap<string, DiscoveredHook>;

  constructor(discovered: readonly DiscoveredHook[], injected: readonly HookDefinition[] = []) {
    const merged = [...discovered];
    const known = new Map(merged.map((hook) => [hook.definition.id, hook.filePath]));
    for (const definition of injected) {
      const previous = known.get(definition.id);
      if (previous) throw new Error(`Duplicate hook id '${definition.id}' in '${previous}' and injected hook catalog.`);
      known.set(definition.id, "<injected>");
      merged.push({ source: "home", filePath: "<injected>", digest: sha256(JSON.stringify(definition)), definition });
    }
    this.hooks = merged;
    this.byId = new Map(merged.map((hook) => [hook.definition.id, hook]));
  }

  resolve(id: string): DiscoveredHook {
    const hook = this.byId.get(id);
    if (!hook) throw new Error(`Unknown hook '${id}'.`);
    return hook;
  }
}

async function hookFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function containedFile(root: string, candidate: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(candidate);
  if (!canonicalFile.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error(`Hook file '${candidate}' escapes its root.`);
  return canonicalFile;
}

async function boundedRead(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_HOOK_FILE_BYTES) throw new Error(`Hook file '${filePath}' is invalid or exceeds 1 MiB.`);
  return await readFile(filePath, "utf8");
}

function rejectUnknown(value: Record<string, unknown>, known: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !known.has(key));
  if (unknown) throw new Error(`Unknown hook key '${label}.${unknown}'.`);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Hook '${label}' must be a table.`);
  return value as Record<string, unknown>;
}

function hookId(value: unknown, label: string): string {
  const id = stringValue(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) throw new Error(`Hook '${label}' has an invalid id.`);
  return id;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Hook '${label}' requires a non-empty string.`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Hook '${label}' requires a string array.`);
  }
  return [...value] as string[];
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Hook '${label}' requires a boolean.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Hook '${label}' requires a positive integer.`);
  return Number(value);
}

function enumValue<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new Error(`Hook '${label}' must be one of: ${options.join(", ")}.`);
  }
  return value as T;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
