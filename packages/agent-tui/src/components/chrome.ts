import path from "node:path";
import type { ActivityItem, PresentationState } from "agent-presentation";
import type { TuiSnapshot } from "./types.js";
import { compactLine, sanitizeTerminalText } from "./terminal-text.js";

const statusSymbol: Record<ActivityItem["status"], string> = {
  queued: "○", running: "◌", completed: "✓", failed: "×", cancelled: "−"
};

export function headerText(snapshot: TuiSnapshot, width: number): string {
  const workspace = sanitizeTerminalText(path.basename(snapshot.workspace) || snapshot.workspace);
  const session = snapshot.sessionId?.slice(0, 8) ?? "new";
  if (width < 40) return `Σ ${snapshot.presentation.status} · ${snapshot.mode}`;
  if (width < 60) return `Σ Sigma · ${workspace} · ${snapshot.presentation.status}`;
  return `Σ Sigma  ${workspace}  ${snapshot.mode}  ${snapshot.presentation.status}  ${session}`;
}

function activityLine(item: ActivityItem): string {
  const progress = item.progressPercent === undefined ? "" : ` ${Math.round(item.progressPercent)}%`;
  const detail = item.detail ? ` · ${compactLine(item.detail, 120)}` : "";
  return `${statusSymbol[item.status]} ${item.title}${progress}${detail}`;
}

export function activityText(view: PresentationState, expanded: boolean): string {
  if (view.activity.length === 0) return "";
  if (expanded) return view.activity.slice(-6).map(activityLine).join("\n");
  const active = view.activity.filter((item) => item.status === "running" || item.status === "queued");
  const failures = view.activity.filter((item) => item.status === "failed");
  const item = active.at(-1) ?? failures.at(-1) ?? view.activity.at(-1)!;
  const prefix = active.length > 1 ? `${active.length} active · ` : "";
  return `${prefix}${activityLine(item)}`;
}

export function queuedText(view: PresentationState): string {
  const queued = view.queuedFollowUps;
  if (queued.length === 0) return "";
  const latest = queued.slice(-2).map((item) => `  ↳ ${compactLine(item.text, 120)}`).join("\n");
  return `• ${queued.length} queued follow-up${queued.length === 1 ? "" : "s"}\n${latest}`;
}

export function footerText(snapshot: TuiSnapshot, scrolled: boolean): string {
  if (snapshot.presentation.approvals.some((item) => item.status === "pending")) return "approval: ↑/↓ choose · enter confirm · esc deny";
  if (scrolled) return "PgDn newest · Enter send · Shift+Enter newline · ? help";
  if (snapshot.presentation.status === "running") return "Enter steer now · Alt+Enter follow-up · Ctrl+C cancel · ? help";
  return "Enter send · Shift+Enter newline · / commands · ? help";
}
