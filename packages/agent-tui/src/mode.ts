export type TuiRunMode = "plan" | "build";

export const PLAN_DISABLED_TOOLS = [
  "write",
  "edit",
  "apply_patch",
  "bash",
  "shell_session",
  "service"
] as const;

export function mergeDisabledToolsForMode(mode: TuiRunMode, configured: string[] | undefined): string[] | undefined {
  const merged = new Set(configured ?? []);
  if (mode === "plan") {
    for (const tool of PLAN_DISABLED_TOOLS) merged.add(tool);
  }
  return merged.size > 0 ? [...merged] : undefined;
}
