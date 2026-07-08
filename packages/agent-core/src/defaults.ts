import type {
  AgentFinalEvidenceMode,
  AgentHarnessValidationMode,
  CompactionMode
} from "./types.js";

export const DEFAULT_COMPACTION_MODE: CompactionMode = "model_sub_session";
export const DEFAULT_MAX_MESSAGE_HISTORY_CHARS = 120000;
export const DEFAULT_VALIDATION_MODE: AgentHarnessValidationMode = "auto";
export const DEFAULT_FINAL_EVIDENCE_MODE: AgentFinalEvidenceMode = "auto";
export const DEFAULT_SUBAGENTS_ENABLED = true;
