import { createHash } from "node:crypto";

const DIGEST = /^[a-f0-9]{64}$/u;

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Frozen session ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  label: string
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new Error(`Frozen session ${label} has unknown key '${unknown}'.`);
  const optional = new Set(["cwd", "trustPaths", "trust"]);
  const missing = [...keys].find((key) => !(key in value) && !optional.has(key));
  if (missing) throw new Error(`Frozen session ${label} has missing key '${missing}'.`);
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Frozen session ${label} must be non-empty text.`);
  }
  return value;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Frozen session ${label} must be text.`);
  return value;
}

export function id(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(result)) {
    throw new Error(`Frozen session ${label} is invalid.`);
  }
  return result;
}

export function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(`Frozen session ${label} is invalid.`);
  }
  return value;
}

export function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Frozen session ${label} must be boolean.`);
  return value;
}

export function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Frozen session ${label} must be a positive integer.`);
  }
  return Number(value);
}

export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)
    || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`Frozen session ${label} must be a string array.`);
  }
  return [...value] as string[];
}

export function oneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  label: string
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`Frozen session ${label} is invalid.`);
  }
  return value as T;
}

export function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Frozen session customization contains duplicate ${label} ids.`);
  }
}

export function ordered(values: string[]): boolean {
  return values.every((value, index) =>
    index === 0 || values[index - 1]!.localeCompare(value) <= 0);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
