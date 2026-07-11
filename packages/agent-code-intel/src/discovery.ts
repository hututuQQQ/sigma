import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscoverLanguageServersOptions, LanguageServerPreset } from "./types.js";
import { nodeLanguageServerArguments } from "./node-launch.js";

function pathExecutable(name: string, pathValue: string, platform: NodeJS.Platform): string | undefined {
  const suffixes = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function unavailable(
  id: LanguageServerPreset["id"],
  languages: string[],
  executable: string,
  args: string[],
  reason: string
): LanguageServerPreset {
  return { id, languages, executable, args, source: "bundled", available: false, unavailableReason: reason };
}

export function defaultBundledLanguageServerRoot(): string | undefined {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(directory, "..", "node_modules"),
    path.resolve(directory, "..", ".."),
    path.resolve(directory, "..", "..", "node_modules"),
    path.resolve(directory, "..", "..", "..", "node_modules")
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, "typescript"))
    && existsSync(path.join(candidate, "pyright")));
}

function bundledTypeScriptServerEntry(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.join(directory, "typescript-server.mjs"),
    path.resolve(directory, "..", "dist", "typescript-server.mjs")
  ].find((candidate) => existsSync(candidate)) ?? path.join(directory, "typescript-server.mjs");
}

export function discoverLanguageServers(options: DiscoverLanguageServersOptions = {}): LanguageServerPreset[] {
  const platform = options.platform ?? process.platform;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const bundledRoot = options.bundledRoot ?? defaultBundledLanguageServerRoot();
  const root = bundledRoot ? path.resolve(bundledRoot) : undefined;
  const node = options.nodeExecutable ? path.resolve(options.nodeExecutable) : process.execPath;
  const tsEntry = bundledTypeScriptServerEntry();
  const pyrightEntry = root ? path.join(root, "pyright", "langserver.index.js") : "";
  const presets: LanguageServerPreset[] = [
    root && existsSync(path.join(root, "typescript")) && existsSync(tsEntry)
      ? { id: "typescript", languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"], executable: node, args: nodeLanguageServerArguments(tsEntry), source: "bundled", available: true }
      : unavailable("typescript", ["typescript", "typescriptreact", "javascript", "javascriptreact"], node, [], "Bundled Sigma TypeScript language server is missing."),
    root && existsSync(pyrightEntry)
      ? { id: "python", languages: ["python"], executable: node, args: nodeLanguageServerArguments(pyrightEntry, { foregroundOnly: true }), source: "bundled", available: true }
      : unavailable("python", ["python"], node, [], "Bundled Pyright is missing."),
    externalPreset("rust", ["rust"], "rust-analyzer", [], pathValue, platform),
    externalPreset("go", ["go"], "gopls", [], pathValue, platform),
    ...(options.configured ?? []).map((preset) => ({ ...preset, source: "configured" as const }))
  ];
  return presets;
}

function externalPreset(
  id: string,
  languages: string[],
  name: string,
  args: string[],
  pathValue: string,
  platform: NodeJS.Platform
): LanguageServerPreset {
  const executable = pathExecutable(name, pathValue, platform);
  return executable
    ? { id, languages, executable, args, source: "path", available: true }
    : { id, languages, executable: name, args, source: "path", available: false, unavailableReason: `${name} was not found on PATH.` };
}
