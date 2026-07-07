import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentSkill } from "./types.js";
import { DEFAULT_SKILLS } from "./default-skills.js";
import { resolveWorkspacePath, workspaceRelativePath } from "../policy.js";

const MAX_WORKSPACE_SKILL_BYTES = 65536;

function splitList(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function metadataValue(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

function firstHeading(content: string): string | undefined {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function sectionLines(content: string, sectionName: string): string[] {
  const heading = new RegExp(`^#{2,3}\\s+${sectionName}\\b.*$`, "im");
  const match = heading.exec(content);
  if (!match || match.index === undefined) return [];
  const rest = content.slice(match.index + match[0].length).split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rest) {
    if (/^#{1,3}\s+/.test(line)) break;
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) lines.push(bullet[1].trim());
  }
  return lines;
}

function summaryFromContent(content: string): string {
  const explicit = metadataValue(content, "summary");
  if (explicit) return explicit;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---") || /^[A-Za-z0-9_-]+\s*:/.test(trimmed)) continue;
    return trimmed.replace(/^[-*]\s+/, "");
  }
  return "Workspace skill";
}

export function parseWorkspaceSkillMarkdown(options: {
  content: string;
  filePath: string;
  workspacePath: string;
}): AgentSkill {
  const relativePath = workspaceRelativePath(options.workspacePath, options.filePath);
  const name =
    metadataValue(options.content, "name") ||
    firstHeading(options.content) ||
    path.basename(options.filePath, path.extname(options.filePath));
  const triggers = splitList(metadataValue(options.content, "triggers") ?? "");
  return {
    name,
    source: "workspace",
    sourcePath: relativePath,
    triggers,
    summary: summaryFromContent(options.content),
    inspectSteps: sectionLines(options.content, "inspect"),
    implementSteps: sectionLines(options.content, "implement"),
    verifySteps: sectionLines(options.content, "verify")
  };
}

export async function loadWorkspaceSkills(workspacePath: string): Promise<AgentSkill[]> {
  let skillsDir: string;
  try {
    skillsDir = resolveWorkspacePath(workspacePath, path.join(".agent", "skills"));
  } catch {
    return [];
  }
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: AgentSkill[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(skillsDir, entry.name);
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_WORKSPACE_SKILL_BYTES) continue;
      const content = await readFile(filePath, "utf8");
      skills.push(parseWorkspaceSkillMarkdown({ content, filePath, workspacePath }));
    } catch {
      // Malformed or unreadable workspace skills should not break an agent run.
    }
  }
  return skills;
}

export async function loadAllSkills(workspacePath: string): Promise<AgentSkill[]> {
  return [...DEFAULT_SKILLS, ...(await loadWorkspaceSkills(workspacePath))];
}
