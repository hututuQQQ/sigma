import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type KeyEvent } from "@opentui/core";
import type { ApprovalItem } from "agent-presentation";
import type { CliRenderer } from "@opentui/core";
import type { TuiCommandDefinition } from "./commands.js";
import { helpText } from "./commands.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { TuiTheme } from "./theme.js";

export type OverlayMode = "none" | "help" | "commands" | "approval";

const approvalOptions = ["Allow once", "Always allow matching effects this session", "Deny"] as const;
const approvalFooter = "↑/↓ choose · 1/2/3 or y/a/n · enter confirm · esc deny · PgUp/PgDn arguments";

export function approvalChoice(key: KeyEvent): number | undefined {
  if (key.ctrl || key.meta || key.option) return undefined;
  const choices: Record<string, number> = { "1": 0, y: 0, "2": 1, a: 1, "3": 2, n: 2, escape: 2 };
  return choices[key.name];
}

function inlineText(value: string, maximum: number): string {
  const content = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  const characters = [...content];
  return characters.length <= maximum ? content : `${characters.slice(0, maximum - 1).join("")}…`;
}

function commandText(items: readonly TuiCommandDefinition[], selected: number): string {
  return items.map((item, index) => `${index === selected ? "›" : " "} ${item.usage.padEnd(28)} ${item.description}`).join("\n")
    + "\n\n↑/↓ select · tab complete · enter run · esc close";
}

function approvalSummary(item: ApprovalItem): string {
  const effects = item.effects.length > 0 ? item.effects.map((effect) => inlineText(effect, 80)).join(", ") : "not declared";
  return [
    `Tool      ${inlineText(item.toolName, 160)}`,
    `Effects   ${inlineText(effects, 320)}`,
    `Reason    ${inlineText(item.reason || "No reason supplied", 512)}`,
    `Request   ${inlineText(item.requestId, 160)}`
  ].join("\n");
}

function approvalArguments(item: ApprovalItem): string {
  const preview = sanitizeTerminalText(item.argumentPreview || "No arguments supplied");
  return item.argumentPreviewTruncated
    ? `${preview}\n[preview truncated; beginning and end retained]`
    : preview;
}

export class OverlayView {
  readonly box: BoxRenderable;
  private readonly scroll: ScrollBoxRenderable;
  private readonly text: TextRenderable;
  private readonly summary: TextRenderable;
  private readonly argumentsLabel: TextRenderable;
  private readonly choices: BoxRenderable;
  private readonly choiceRows: TextRenderable[];
  private readonly compactChoices: TextRenderable;
  private readonly footer: TextRenderable;
  private approvalRequestId?: string;
  mode: OverlayMode = "none";

  constructor(private readonly renderer: CliRenderer, private readonly theme: TuiTheme) {
    this.box = new BoxRenderable(renderer, {
      id: "overlay", position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
      zIndex: 100, flexDirection: "column", padding: 1, border: true, borderStyle: "rounded",
      visible: false, ...(theme.surface ? { backgroundColor: theme.surface } : {}),
      ...(theme.accent ? { borderColor: theme.accent } : {})
    });
    this.summary = new TextRenderable(renderer, {
      id: "overlay-summary", width: "100%", height: 0, visible: false, wrapMode: "none", truncate: true
    });
    this.argumentsLabel = new TextRenderable(renderer, {
      id: "overlay-arguments-label", width: "100%", height: 0, visible: false, content: "Arguments",
      ...(theme.muted ? { fg: theme.muted } : {})
    });
    this.scroll = new ScrollBoxRenderable(renderer, {
      id: "overlay-scroll", width: "100%", height: 0, minHeight: 0, viewportCulling: true,
      scrollY: true, stickyScroll: false
    });
    this.text = new TextRenderable(renderer, {
      id: "overlay-text", width: "100%", height: "auto", wrapMode: "word", content: ""
    });
    this.choices = new BoxRenderable(renderer, {
      id: "overlay-choices", width: "100%", height: 0, flexDirection: "column"
    });
    this.choiceRows = approvalOptions.map((option, optionIndex) => new TextRenderable(renderer, {
      id: `overlay-choice-${optionIndex}`, width: "100%", height: 1, truncate: true,
      content: `  ${optionIndex + 1}. ${option}`
    }));
    for (const row of this.choiceRows) this.choices.add(row);
    this.compactChoices = new TextRenderable(renderer, {
      id: "overlay-choices-compact", width: "100%", height: 0, visible: false, truncate: true
    });
    this.footer = new TextRenderable(renderer, {
      id: "overlay-footer", width: "100%", height: 0, visible: false, truncate: true,
      content: approvalFooter, ...(theme.muted ? { fg: theme.muted } : {})
    });
    this.scroll.add(this.text);
    for (const child of [this.summary, this.argumentsLabel, this.scroll, this.choices, this.compactChoices, this.footer]) {
      this.box.add(child);
    }
  }

  hide(): void {
    this.mode = "none";
    this.approvalRequestId = undefined;
    this.box.title = undefined;
    this.box.visible = false;
  }

  showHelp(): void {
    this.mode = "help";
    this.approvalRequestId = undefined;
    this.hideApprovalChrome();
    this.text.content = sanitizeTerminalText(helpText());
    this.layoutHelp();
    this.box.visible = true;
    this.scroll.scrollTo(0);
  }

  showCommands(items: readonly TuiCommandDefinition[], selected: number): void {
    this.mode = "commands";
    this.approvalRequestId = undefined;
    this.box.title = undefined;
    this.box.top = "auto";
    this.box.bottom = 3;
    this.box.height = Math.min(10, items.length + 4);
    this.box.paddingX = 1;
    this.box.paddingY = 1;
    this.hideApprovalChrome();
    this.text.content = sanitizeTerminalText(commandText(items, selected));
    this.scroll.visible = true;
    this.scroll.height = Math.max(1, Math.min(10, items.length + 4) - 4);
    this.box.visible = true;
    this.scroll.scrollTo(0);
  }

  showApproval(item: ApprovalItem, index: number, total: number, selected: number): void {
    const isNewRequest = this.approvalRequestId !== item.requestId;
    this.mode = "approval";
    this.configureFullBox(` Approval required (${index + 1}/${total}) `, this.renderer.height >= 14);
    this.summary.content = sanitizeTerminalText(approvalSummary(item));
    this.argumentsLabel.content = "Arguments";
    const argumentsContent = approvalArguments(item);
    if (this.text.plainText !== argumentsContent) this.text.content = argumentsContent;
    this.layoutApproval();
    this.selectApproval(selected);
    this.box.visible = true;
    this.approvalRequestId = item.requestId;
    if (isNewRequest) this.scroll.scrollTo(0);
  }

  selectApproval(selected: number): void {
    const normalized = Math.max(0, Math.min(approvalOptions.length - 1, selected));
    this.choiceRows.forEach((row, index) => {
      row.content = `${index === normalized ? "›" : " "} ${index + 1}. ${approvalOptions[index]}`;
      row.bg = index === normalized && this.theme.selection
        ? this.theme.selection
        : this.theme.surface ?? "transparent";
    });
    this.compactChoices.content = approvalOptions
      .map((option, index) => `${index === normalized ? "›" : " "}${index + 1} ${option}`)
      .join(" · ");
  }

  scrollBy(delta: number): void {
    this.scroll.scrollBy(delta, "step");
  }

  resize(): void {
    if (this.mode === "help") this.layoutHelp();
    else if (this.mode === "approval") {
      this.configureFullBox(this.box.title ?? " Approval required ", this.renderer.height >= 14);
      this.layoutApproval();
    }
  }

  private configureFullBox(title: string, padded: boolean): void {
    this.box.top = 0;
    this.box.bottom = "auto";
    this.box.height = "100%";
    this.box.paddingX = this.renderer.width >= 20 ? 1 : 0;
    this.box.paddingY = padded ? 1 : 0;
    this.box.title = title;
  }

  private hideApprovalChrome(): void {
    for (const node of [this.summary, this.argumentsLabel, this.choices, this.compactChoices, this.footer]) {
      node.visible = false;
      node.height = 0;
    }
  }

  private layoutHelp(): void {
    const padded = this.renderer.height >= 6;
    this.configureFullBox(" Sigma help ", padded);
    this.scroll.visible = true;
    this.scroll.height = Math.max(1, this.renderer.height - 2 - (padded ? 2 : 0));
  }

  private layoutApproval(): void {
    const verticalPadding = this.renderer.height >= 14 ? 2 : 0;
    const available = Math.max(1, this.renderer.height - 2 - verticalPadding);
    const expandedChoices = available >= 3;
    const choiceHeight = expandedChoices ? 3 : 1;
    const footerHeight = available > choiceHeight ? 1 : 0;
    let remaining = Math.max(0, available - choiceHeight - footerHeight);
    const summaryHeight = remaining >= 6 ? 4 : remaining >= 2 ? 2 : 0;
    remaining -= summaryHeight;
    const labelHeight = remaining >= 2 ? 1 : 0;
    const argumentsHeight = Math.max(0, remaining - labelHeight);

    this.summary.visible = summaryHeight > 0;
    this.summary.height = summaryHeight;
    this.argumentsLabel.visible = labelHeight > 0;
    this.argumentsLabel.height = labelHeight;
    this.scroll.visible = argumentsHeight > 0;
    this.scroll.height = argumentsHeight;
    this.choices.visible = expandedChoices;
    this.choices.height = expandedChoices ? choiceHeight : 0;
    this.compactChoices.visible = !expandedChoices;
    this.compactChoices.height = expandedChoices ? 0 : choiceHeight;
    this.footer.visible = footerHeight > 0;
    this.footer.height = footerHeight;
  }
}
