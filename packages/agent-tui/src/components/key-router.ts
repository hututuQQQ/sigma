import type { KeyEvent } from "@opentui/core";
import type { OverlayMode } from "./overlay.js";

export interface KeyRouterHost {
  overlayMode(): OverlayMode;
  composerText(): string;
  composerLine(): { row: number; lines: number };
  interrupt(): void;
  closeOverlay(): void;
  showHelp(): void;
  toggleActivity(): void;
  scroll(delta: number): void;
  approvalKey(key: KeyEvent): boolean;
  commandKey(key: KeyEvent): boolean;
  history(direction: -1 | 1): void;
  newline(): void;
  submit(kind: "default" | "follow_up"): void;
}

function consume(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

function isEnter(key: KeyEvent): boolean {
  return key.name === "return" || key.name === "enter";
}

function isHelpKey(key: KeyEvent): boolean {
  return !key.ctrl && !key.meta && (key.name === "?" || key.sequence === "?");
}

export function routeKey(host: KeyRouterHost, key: KeyEvent): void {
  if (key.eventType === "release") return;
  if (routeInterrupt(host, key) || routeFullOverlay(host, key)
    || routeGlobal(host, key) || routeOverlay(host, key) || routeComposer(host, key)) consume(key);
}

function routeInterrupt(host: KeyRouterHost, key: KeyEvent): boolean {
  if (key.ctrl && key.name === "c") {
    if (!key.repeated) host.interrupt();
    return true;
  }
  return false;
}

function routeFullOverlay(host: KeyRouterHost, key: KeyEvent): boolean {
  const mode = host.overlayMode();
  if (mode !== "approval" && mode !== "help") return false;
  if (key.name === "pageup" || key.name === "pagedown") {
    host.scroll(key.name === "pageup" ? -8 : 8);
  } else if (key.ctrl && (key.name === "u" || key.name === "d")) {
    host.scroll(key.name === "u" ? -6 : 6);
  } else if (mode === "approval") {
    host.approvalKey(key);
  } else if (key.name === "escape") {
    host.closeOverlay();
  }
  return true;
}

function routeGlobal(host: KeyRouterHost, key: KeyEvent): boolean {
  if (key.ctrl && key.name === "o") { host.toggleActivity(); return true; }
  if (key.name === "pageup" || key.name === "pagedown") {
    host.scroll(key.name === "pageup" ? -8 : 8); return true;
  }
  if (key.ctrl && (key.name === "u" || key.name === "d")) {
    host.scroll(key.name === "u" ? -6 : 6); return true;
  }
  return false;
}

function routeOverlay(host: KeyRouterHost, key: KeyEvent): boolean {
  if (host.overlayMode() === "commands" && host.commandKey(key)) {
    return true;
  }
  return false;
}

function routeComposer(host: KeyRouterHost, key: KeyEvent): boolean {
  if (host.composerText() === "" && isHelpKey(key)) {
    host.showHelp(); return true;
  }
  if (key.ctrl && key.name === "j") { host.newline(); return true; }
  if (isEnter(key)) {
    if (key.shift) host.newline();
    else host.submit(key.meta || key.option ? "follow_up" : "default");
    return true;
  }
  const line = host.composerLine();
  if (key.name === "up" && line.row === 0) { host.history(-1); return true; }
  if (key.name === "down" && line.row === line.lines - 1) { host.history(1); return true; }
  return false;
}
