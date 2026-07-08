import path from "node:path";
import type { ToolDefinition } from "agent-ai";
import { runCommand } from "../command-runner.js";
import { gitCommandSpec } from "../tools/git-command.js";
import { formatMemorySnippet, searchMemories } from "../memory/local-memory.js";
import type { ContextSourceEntry } from "../types.js";
import { contextSourceEntry } from "./source-map.js";

export interface ContextAssemblyBlock {
  id: string;
  content: string;
  source: ContextSourceEntry;
}

function block(options: {
  id: string;
  kind: ContextSourceEntry["kind"];
  label: string;
  content: string;
  cacheable?: boolean;
  truncated?: boolean;
  activationReason?: string;
  path?: string;
  authority?: ContextSourceEntry["authority"];
}): ContextAssemblyBlock {
  return {
    id: options.id,
    content: options.content,
    source: contextSourceEntry({
      id: options.id,
      kind: options.kind,
      label: options.label,
      content: options.content,
      cacheable: options.cacheable,
      truncated: options.truncated,
      modelVisible: true,
      activationReason: options.activationReason,
      path: options.path,
      authority: options.authority
    })
  };
}

export function staticContextBlocks(options: {
  systemPrompt: string;
  projectInstructions?: string;
  repoMap?: string;
  skills?: string;
  tools: ToolDefinition[];
}): ContextAssemblyBlock[] {
  const blocks = [
    block({
      id: "system_prompt",
      kind: "system",
      label: "System prompt",
      content: options.systemPrompt,
      cacheable: true,
      activationReason: "base agent instructions",
      authority: "system"
    }),
    ...(options.projectInstructions
      ? [block({
          id: "project_instructions",
          kind: "project_instructions",
          label: "Project instructions",
          content: options.projectInstructions,
          cacheable: true,
          activationReason: "workspace instructions discovered",
          authority: "project"
        })]
      : []),
    ...(options.repoMap
      ? [block({
          id: "repo_map",
          kind: "repo_map",
          label: "Repository map",
          content: options.repoMap,
          cacheable: false,
          activationReason: "contextMode repo-map",
          authority: "runtime"
        })]
      : []),
    ...(options.skills
      ? [block({
          id: "skills",
          kind: "skills",
          label: "Selected skills",
          content: options.skills,
          cacheable: true,
          activationReason: "skill retrieval matched instruction/project hints",
          authority: "system"
        })]
      : []),
    block({
      id: "tool_definitions_static",
      kind: "tool_definitions",
      label: "Tool definitions",
      content: JSON.stringify(options.tools),
      cacheable: true,
      activationReason: "model tool schema",
      authority: "system"
    })
  ];
  return blocks;
}

export async function recentDiffBlock(workspacePath: string, maxChars = 8000): Promise<ContextAssemblyBlock | null> {
  const git = gitCommandSpec();
  const result = await runCommand({
    command: git.command,
    args: [...git.argsPrefix, "diff", "--stat", "--", "."],
    cwd: path.resolve(workspacePath),
    timeoutMs: 5000,
    windowsHide: true
  });
  if (result.exitCode !== 0 || result.timedOut || result.error) return null;
  const text = result.stdout.toString("utf8").trim();
  if (!text) return null;
  const content = text.length > maxChars ? `${text.slice(0, maxChars)}\n[diff stat truncated]` : text;
  return block({
    id: "recent_diff",
    kind: "diff",
    label: "Recent workspace diff",
    content: `Current git diff stat:\n${content}`,
    truncated: text.length > maxChars,
    activationReason: "workspace has uncommitted changes",
    authority: "runtime"
  });
}

export async function memoryContextBlock(options: {
  workspacePath: string;
  query: string;
  maxItems?: number;
  maxChars?: number;
}): Promise<ContextAssemblyBlock | null> {
  const memories = await searchMemories({
    workspacePath: options.workspacePath,
    query: options.query,
    limit: options.maxItems ?? 5
  });
  if (memories.length === 0) return null;
  const maxChars = options.maxChars ?? 6000;
  const body = memories.map((record) => formatMemorySnippet(record, 1200)).join("\n");
  const content = body.length > maxChars ? `${body.slice(0, maxChars)}\n[memory snippets truncated]` : body;
  return block({
    id: "memory_snippets",
    kind: "memory",
    label: "Relevant long-term memories",
    content: `Relevant durable memories. Verify against current files before relying on project facts.\n${content}`,
    truncated: body.length > maxChars,
    activationReason: "memory search matched objective and active files",
    authority: "memory"
  });
}
