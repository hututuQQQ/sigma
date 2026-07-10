import { bold, BoxRenderable, fg, t, TextRenderable, type CliRenderer } from "@opentui/core";
import type { PresentationState } from "agent-presentation";
import type { TuiTheme } from "./theme.js";

const minimumWelcomeWidth = 48;
const minimumWelcomeHeight = 16;

const promptRows = ["    ", "    ", ">_  ", "    ", "    "];
const sigmaRows = ["████████", "     ██ ", "   ██   ", " ██     ", "████████"];

function logoContent(theme: TuiTheme): string | ReturnType<typeof t> {
  if (theme.noColor || !theme.brand || !theme.prompt) {
    return promptRows.map((row, index) => `${row}  ${sigmaRows[index]}`).join("\n");
  }
  const prompt = fg(theme.prompt);
  const brand = fg(theme.brand);
  return t`${prompt(promptRows[0])}  ${brand(sigmaRows[0])}\n${prompt(promptRows[1])}  ${brand(sigmaRows[1])}\n${prompt(promptRows[2])}  ${brand(sigmaRows[2])}\n${prompt(promptRows[3])}  ${brand(sigmaRows[3])}\n${prompt(promptRows[4])}  ${brand(sigmaRows[4])}`;
}

export function shouldShowWelcome(view: PresentationState, width: number, height: number): boolean {
  return width >= minimumWelcomeWidth
    && height >= minimumWelcomeHeight
    && view.status === "idle"
    && view.transcript.length === 0
    && view.activity.length === 0;
}

export class WelcomeView {
  readonly box: BoxRenderable;

  constructor(renderer: CliRenderer, theme: TuiTheme) {
    this.box = new BoxRenderable(renderer, {
      id: "welcome", position: "absolute", width: "100%", height: "100%",
      flexDirection: "column", alignItems: "center", justifyContent: "center"
    });
    this.box.add(new TextRenderable(renderer, {
      id: "welcome:logo", content: logoContent(theme), width: 14, height: 5, selectable: false
    }));
    this.box.add(new TextRenderable(renderer, {
      id: "welcome:title",
      content: theme.brand ? t`${bold(fg(theme.brand)("Welcome to Sigma"))}` : "Welcome to Sigma",
      width: 16, height: 1, marginTop: 1, selectable: false
    }));
    this.box.add(new TextRenderable(renderer, {
      id: "welcome:hint", content: "Type a message or / for commands", width: 32, height: 1,
      marginTop: 1, selectable: false, ...(theme.muted ? { fg: theme.muted } : {})
    }));
  }

  update(view: PresentationState, width: number, height: number): void {
    this.box.visible = shouldShowWelcome(view, width, height);
  }
}
