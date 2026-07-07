import { truncateMiddle } from "../compaction.js";
import type { AgentSkill } from "./types.js";

const DEFAULT_SKILLS_MAX_CHARS = 8000;

function bulletSection(title: string, items: string[]): string[] {
  if (items.length === 0) return [];
  return [title, ...items.slice(0, 6).map((item) => `- ${item}`)];
}

export function formatSkill(skill: AgentSkill): string {
  const lines = [
    `### ${skill.name}`,
    `source: ${skill.source}${skill.sourcePath ? ` (${skill.sourcePath})` : ""}`,
    `summary: ${skill.summary}`,
    ...(skill.triggers.length > 0 ? [`triggers: ${skill.triggers.join(", ")}`] : []),
    ...bulletSection("inspect:", skill.inspectSteps),
    ...bulletSection("implement:", skill.implementSteps),
    ...bulletSection("verify:", skill.verifySteps)
  ];
  return lines.join("\n");
}

export function formatSelectedSkills(skills: AgentSkill[], maxChars = DEFAULT_SKILLS_MAX_CHARS): string {
  const budget = Math.max(0, Math.floor(maxChars));
  if (skills.length === 0 || budget === 0) return "";
  let output = "## Selected Skills\nUse these generic playbooks when they apply; do not follow them blindly.";
  for (const skill of skills) {
    const formatted = `\n\n${formatSkill(skill)}`;
    if (output.length + formatted.length > budget) {
      const remaining = budget - output.length;
      if (remaining > 200) output += truncateMiddle(formatted, remaining).text;
      break;
    }
    output += formatted;
  }
  return output.length <= budget ? output : truncateMiddle(output, budget).text;
}
