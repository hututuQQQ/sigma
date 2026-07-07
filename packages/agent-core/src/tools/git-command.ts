export interface GitCommandSpec {
  command: string;
  argsPrefix: string[];
}

function stringListFromJson(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function gitCommandSpec(): GitCommandSpec {
  return {
    command: process.env.AGENT_GIT_PATH || "git",
    argsPrefix: stringListFromJson(process.env.AGENT_GIT_ARGS)
  };
}
