import type { ProjectProfile } from "../harness/project-detector.js";
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

export function projectHintsFromProfile(profile: ProjectProfile): string[] {
  const hints: string[] = [];
  if (profile.node.hasPackageJson) hints.push("node", "package.json", profile.node.packageManager);
  if (profile.node.hasTypeScript) hints.push("typescript", "tsconfig");
  if (profile.python.hasPython) hints.push("python");
  if (profile.python.pytestLikely) hints.push("pytest");
  if (profile.python.prefersUv) hints.push("uv");
  if (profile.hasGoMod) hints.push("go.mod", "go");
  if (profile.hasCargoToml) hints.push("Cargo.toml", "rust", "cargo");
  if (profile.hasPomXml) hints.push("pom.xml", "java", "maven");
  if (profile.hasGradle) hints.push("gradle", "java");
  if (profile.hasMakefile) hints.push("makefile", "make");
  return hints;
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
