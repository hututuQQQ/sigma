export type ValidationScope = "syntax" | "focused" | "package" | "project";
export type ValidationKind = "test" | "typecheck" | "build" | "lint" | "compile" | "manual-check";
export type ValidationCost = "cheap" | "medium" | "expensive";

export interface DiscoveredProjectRoot {
  root: string;
  relativeRoot: string;
  type: "node" | "python" | "go" | "rust" | "maven" | "gradle" | "make";
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  scripts?: Record<string, string>;
  makeTargets?: string[];
  markerFiles: string[];
}

export interface ProjectDiscoveryResult {
  workspacePath: string;
  roots: DiscoveredProjectRoot[];
  changedFiles: string[];
  changedFileRoots: Record<string, string[]>;
  skipped: Array<{ reason: string; relatedFiles: string[] }>;
}

export interface ValidationCandidate {
  command: string;
  cwd: string;
  scope: ValidationScope;
  kind: ValidationKind;
  cost: ValidationCost;
  relatedFiles: string[];
  reason: string;
  timeoutSec: number;
  analyzerHints: string[];
  source: string;
}

export interface SkippedValidationCandidate {
  command?: string;
  cwd?: string;
  reason: string;
  relatedFiles: string[];
}

export interface ValidationPlan {
  workspacePath: string;
  candidates: ValidationCandidate[];
  skipped: SkippedValidationCandidate[];
}

export interface ValidationPlannerOptions {
  workspacePath: string;
  configuredCommands?: string[];
  changedFiles?: string[];
  maxCommands?: number;
  timeoutSec?: number;
}
