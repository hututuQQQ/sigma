import type { ApprovalItem, PresentationState } from "agent-presentation";
import { createPresentationState } from "agent-presentation";
import type { RunMode } from "agent-protocol";
import { clearComposer, createComposer, type ComposerState } from "./composer.js";

export interface TuiState {
  sessionId?: string;
  mode: RunMode;
  view: PresentationState;
  composer: ComposerState;
  scrollOffset: number;
  activityCollapsed: boolean;
  notice?: string;
  stopped: boolean;
}

export type TuiAction =
  | { type: "session"; sessionId: string }
  | { type: "view"; view: PresentationState }
  | { type: "composer"; composer: ComposerState }
  | { type: "submitted" }
  | { type: "scroll"; delta: number; maximum: number }
  | { type: "mode"; mode: RunMode }
  | { type: "toggle_activity" }
  | { type: "notice"; message?: string }
  | { type: "stop" };

export function createTuiState(mode: RunMode = "change"): TuiState {
  return { mode, view: createPresentationState(), composer: createComposer(), scrollOffset: 0, activityCollapsed: false, stopped: false };
}

export function reduceTui(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "session": return { ...state, sessionId: action.sessionId, view: createPresentationState(), scrollOffset: 0 };
    case "view": return { ...state, view: action.view };
    case "composer": return { ...state, composer: action.composer };
    case "submitted": return { ...state, composer: clearComposer(), scrollOffset: 0 };
    case "scroll": return { ...state, scrollOffset: Math.max(0, Math.min(action.maximum, state.scrollOffset + action.delta)) };
    case "mode": return { ...state, mode: action.mode };
    case "toggle_activity": return { ...state, activityCollapsed: !state.activityCollapsed };
    case "notice": return action.message === undefined ? { ...state, notice: undefined } : { ...state, notice: action.message };
    case "stop": return { ...state, stopped: true };
  }
}

export function pendingApproval(state: TuiState): ApprovalItem | undefined {
  return state.view.approvals.find((item) => item.status === "pending");
}
