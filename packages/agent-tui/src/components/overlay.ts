import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import type { ApprovalItem } from "agent-presentation";
import type { CliRenderer } from "@opentui/core";
import type { TuiCommandDefinition } from "./commands.js";
import { helpText } from "./commands.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { TuiTheme } from "./theme.js";

export type OverlayMode = "none" | "help" | "commands" | "approval";

function commandText(items: readonly TuiCommandDefinition[], selected: number): string {
  return items.map((item, index) => `${index === selected ? "›" : " "} ${item.usage.padEnd(28)} ${item.description}`).join("\n")
    + "\n\n↑/↓ select · tab complete · enter run · esc close";
}

function approvalText(item: ApprovalItem, index: number, total: number, selected: number): string {
  const options = ["Allow once", "Always allow matching effects this session", "Deny"];
  const choices = options.map((option, optionIndex) => `${optionIndex === selected ? "›" : " "} ${optionIndex + 1}. ${option}`).join("\n");
  const effects = item.effects.length > 0 ? item.effects.join(", ") : "not declared";
  const argumentsBlock = item.argumentPreview || "No arguments supplied";
  const truncated = item.argumentPreviewTruncated ? "\n[preview truncated; beginning and end retained]" : "";
  return `Approval required (${index + 1}/${total})\n\nTool      ${item.toolName}\nEffects   ${effects}\nRequest   ${item.requestId}\nReason    ${item.reason || "No reason supplied"}\n\nArguments\n${argumentsBlock}${truncated}\n\n${choices}\n\n↑/↓ or 1/2/3 · y/a/n · enter confirm · esc deny`;
}

export class OverlayView {
  readonly box: BoxRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly text: TextRenderable;
  mode: OverlayMode = "none";

  constructor(renderer: CliRenderer, theme: TuiTheme) {
    this.box = new BoxRenderable(renderer, {
      id: "overlay", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      zIndex: 100, flexDirection: "column", padding: 1, border: true, borderStyle: "rounded",
      visible: false, ...(theme.accent ? { borderColor: theme.accent } : {})
    });
    this.scroll = new ScrollBoxRenderable(renderer, {
      id: "overlay-scroll", width: "100%", height: "100%", viewportCulling: true,
      scrollY: true, stickyScroll: false
    });
    this.text = new TextRenderable(renderer, {
      id: "overlay-text", width: "100%", height: "auto", wrapMode: "word", content: ""
    });
    this.scroll.add(this.text);
    this.box.add(this.scroll);
  }

  hide(): void {
    this.mode = "none";
    this.box.visible = false;
  }

  showHelp(): void {
    this.showFull("help", helpText());
  }

  showCommands(items: readonly TuiCommandDefinition[], selected: number): void {
    this.mode = "commands";
    this.box.top = "auto";
    this.box.bottom = 3;
    this.box.height = Math.min(10, items.length + 4);
    this.text.content = sanitizeTerminalText(commandText(items, selected));
    this.box.visible = true;
    this.scroll.scrollTo(0);
  }

  showApproval(item: ApprovalItem, index: number, total: number, selected: number): void {
    this.showFull("approval", approvalText(item, index, total, selected));
  }

  scrollBy(delta: number): void {
    this.scroll.scrollBy(delta, "step");
  }

  private showFull(mode: OverlayMode, content: string): void {
    this.mode = mode;
    this.box.top = 0;
    this.box.bottom = "auto";
    this.box.height = "100%";
    this.text.content = sanitizeTerminalText(content);
    this.box.visible = true;
    this.scroll.scrollTo(0);
  }
}
