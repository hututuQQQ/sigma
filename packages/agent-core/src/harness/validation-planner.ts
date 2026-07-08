import path from "node:path";
import { createValidationPlan, type ValidationPlan, type ValidationPlannerOptions } from "../validation/validation-planner.js";
import type { ValidationCommandSpec } from "./validation.js";

const DEFAULT_MAX_VALIDATION_COMMANDS = 12;

export interface ValidationPlanOptions extends ValidationPlannerOptions {}

export function dedupeAndBoundValidationSpecs(
  specs: ValidationCommandSpec[],
  maxCommands = DEFAULT_MAX_VALIDATION_COMMANDS
): ValidationCommandSpec[] {
  const seen = new Set<string>();
  const bounded: ValidationCommandSpec[] = [];
  const limit = Math.max(1, Math.floor(maxCommands));
  for (const spec of specs) {
    const command = spec.command.trim();
    const cwd = spec.cwd ? path.resolve(spec.cwd) : "";
    const key = `${cwd}\0${command}`;
    if (!command || seen.has(key)) continue;
    seen.add(key);
    bounded.push({ ...spec, command });
    if (bounded.length >= limit) break;
  }
  return bounded;
}

export function validationPlanToCommandSpecs(plan: ValidationPlan): ValidationCommandSpec[] {
  return plan.candidates.map((candidate) => {
    const rootCwd = path.resolve(plan.workspacePath);
    const cwd = path.resolve(candidate.cwd);
    return {
      source: candidate.source,
      command: candidate.command,
      relatedFiles: candidate.relatedFiles,
      ...(cwd !== rootCwd ? { cwd } : {})
    };
  });
}

export async function planValidation(options: ValidationPlanOptions): Promise<ValidationPlan> {
  return await createValidationPlan(options);
}

export async function planValidationCommandSpecs(options: ValidationPlanOptions): Promise<ValidationCommandSpec[]> {
  const plan = await planValidation(options);
  return dedupeAndBoundValidationSpecs(validationPlanToCommandSpecs(plan), options.maxCommands);
}
