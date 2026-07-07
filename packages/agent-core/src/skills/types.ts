export interface AgentSkill {
  name: string;
  triggers: string[];
  summary: string;
  inspectSteps: string[];
  implementSteps: string[];
  verifySteps: string[];
  source: "built-in" | "workspace";
  sourcePath?: string;
}

export interface SkillRetrievalInput {
  instruction: string;
  projectHints: string[];
}
