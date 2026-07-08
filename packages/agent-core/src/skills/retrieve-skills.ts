import type { ProjectDiscoveryResult } from "../validation/validation-types.js";
import type { AgentSkill, SkillRetrievalInput } from "./types.js";

const MAX_SELECTED_SKILLS = 3;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.+-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

export function projectHintsFromDiscovery(discovery: ProjectDiscoveryResult): string[] {
  const hints: string[] = [];
  for (const root of discovery.roots) {
    hints.push(root.type, ...root.markerFiles);
    if (root.packageManager) hints.push(root.packageManager);
    if (root.scripts?.test) hints.push("test");
    if (root.scripts?.build) hints.push("build");
    if (root.scripts?.lint) hints.push("lint");
    if (root.scripts?.typecheck || root.scripts?.["type-check"] || root.scripts?.tsc) hints.push("typescript", "tsconfig");
    if (root.type === "python" && root.markerFiles.some((file) => file === "pytest.ini" || file === "pyproject.toml")) {
      hints.push("pytest");
    }
    if (root.markerFiles.includes("uv.lock")) hints.push("uv");
    if (root.type === "go") hints.push("go.mod");
    if (root.type === "rust") hints.push("Cargo.toml", "cargo");
    if (root.type === "maven" || root.type === "gradle") hints.push("java");
    if (root.type === "make") hints.push("makefile");
  }
  return [...new Set(hints)];
}

function scoreSkill(skill: AgentSkill, input: SkillRetrievalInput): number {
  const instructionTokens = tokenize(input.instruction);
  const hintTokens = tokenize(input.projectHints.join(" "));
  const haystack = tokenize([
    skill.name,
    skill.summary,
    skill.triggers.join(" "),
    skill.inspectSteps.join(" "),
    skill.implementSteps.join(" "),
    skill.verifySteps.join(" ")
  ].join(" "));
  let score = 0;
  for (const trigger of skill.triggers) {
    const triggerTokens = tokenize(trigger);
    for (const token of triggerTokens) {
      if (instructionTokens.has(token)) score += 5;
      if (hintTokens.has(token)) score += 3;
    }
    if (input.instruction.toLowerCase().includes(trigger.toLowerCase())) score += 6;
  }
  for (const token of instructionTokens) {
    if (haystack.has(token)) score += 1;
  }
  for (const token of hintTokens) {
    if (haystack.has(token)) score += 1;
  }
  if (skill.source === "workspace" && score > 0) score += 1;
  return score;
}

export function retrieveSkills(skills: AgentSkill[], input: SkillRetrievalInput): AgentSkill[] {
  return skills
    .map((skill, index) => ({ skill, score: scoreSkill(skill, input), index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SELECTED_SKILLS)
    .map((entry) => entry.skill);
}
