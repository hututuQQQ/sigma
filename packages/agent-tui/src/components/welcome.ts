import {
  ASCIIFontRenderable, bold, BoxRenderable, fg, t, TextRenderable, type CliRenderer
} from "@opentui/core";
import type { PresentationState } from "agent-presentation";
import type { TuiTheme } from "./theme.js";

const minimumWelcomeWidth = 48;
const minimumWelcomeHeight = 16;

export function shouldShowWelcome(view: PresentationState, width: number, height: number): boolean {
  return width >= minimumWelcomeWidth
    && height >= minimumWelcomeHeight
    && view.status === "idle"
    && view.transcript.length === 0
    && view.activity.length === 0;
}

export class WelcomeView {
  readonly box: BoxRenderable;
  private readonly fullLockup: BoxRenderable;
  private readonly compactLockup: TextRenderable;
  private readonly title: TextRenderable;
  private readonly hint: TextRenderable;

  constructor(renderer: CliRenderer, theme: TuiTheme) {
    this.box = new BoxRenderable(renderer, {
      id: "welcome", position: "absolute", width: "100%", height: "100%",
      flexDirection: "column", alignItems: "center", justifyContent: "center"
    });
    const prompt = new TextRenderable(renderer, {
      id: "welcome:brand:prompt",
      content: theme.prompt ? t`${bold(fg(theme.prompt)(">_"))}` : ">_",
      width: 2, height: 1, marginRight: 2, selectable: false
    });
    const wordmark = new ASCIIFontRenderable(renderer, {
      id: "welcome:brand:wordmark", text: "SIGMA", font: "tiny",
      backgroundColor: "transparent", selectable: false,
      ...(theme.brand ? { color: theme.brand } : {})
    });
    this.fullLockup = new BoxRenderable(renderer, {
      id: "welcome:brand", width: "auto", height: 2,
      flexDirection: "row", alignItems: "flex-end"
    });
    this.fullLockup.add(prompt);
    this.fullLockup.add(wordmark);
    this.compactLockup = new TextRenderable(renderer, {
      id: "welcome:brand:compact",
      content: theme.prompt && theme.brand
        ? t`${bold(fg(theme.prompt)(">_"))}  ${bold(fg(theme.brand)("Σ SIGMA"))}`
        : ">_  Σ SIGMA",
      width: 11, height: 1, visible: false, selectable: false
    });
    this.title = new TextRenderable(renderer, {
      id: "welcome:title",
      content: t`${bold("What do you want to build?")}`,
      width: 26, height: 1, marginTop: 1, selectable: false
    });
    this.hint = new TextRenderable(renderer, {
      id: "welcome:hint", content: "Type a task or / for commands", width: 30, height: 1,
      marginTop: 1, selectable: false, ...(theme.muted ? { fg: theme.muted } : {})
    });
    for (const child of [this.fullLockup, this.compactLockup, this.title, this.hint]) this.box.add(child);
  }

  update(view: PresentationState, width: number, height: number): void {
    const visible = shouldShowWelcome(view, width, height);
    const full = visible && width >= 60 && height >= 18;
    this.box.visible = visible;
    this.fullLockup.visible = full;
    this.compactLockup.visible = visible && !full;
    this.title.visible = visible;
    this.hint.visible = full;
  }
}
