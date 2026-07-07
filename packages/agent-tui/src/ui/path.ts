import path from "node:path";

export function displayPathName(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/g, "");
  const segment = normalized.split("/").filter(Boolean).at(-1);
  return segment || path.basename(value) || value;
}
