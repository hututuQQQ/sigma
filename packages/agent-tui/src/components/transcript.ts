import {
  bold, BoxRenderable, cyan, dim, green, MarkdownRenderable, red, t, TextRenderable
} from "@opentui/core";
import type { PresentationState, TranscriptItem } from "agent-presentation";
import type { CliRenderer, Renderable } from "@opentui/core";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { TuiTheme } from "./theme.js";

interface MessageNode {
  item: TranscriptItem;
  root: Renderable;
  body: TextRenderable | MarkdownRenderable;
  combined: boolean;
}

const maximumMountedMessages = 400;
const maximumRenderedMessageCharacters = 12 * 1024;

function renderedMessageText(value: string): string {
  const content = sanitizeTerminalText(value);
  if (content.length <= maximumRenderedMessageCharacters) return content;
  const marker = "\n… [middle omitted in terminal view] …\n";
  const available = maximumRenderedMessageCharacters - marker.length;
  const leading = Math.floor(available / 4);
  return `${content.slice(0, leading)}${marker}${content.slice(-(available - leading))}`;
}

function label(item: TranscriptItem, theme: TuiTheme): string | ReturnType<typeof t> {
  const suffix = item.delivery === "steer" ? " · steer" : item.delivery === "follow_up" ? " · follow-up" : "";
  if (theme.noColor) return `${item.role === "user" ? "you" : item.role === "system" ? "error" : "sigma"}${suffix}`;
  if (item.role === "user") return t`${bold(cyan("you"))}${dim(suffix)}`;
  if (item.role === "system") return t`${bold(red("error"))}`;
  return t`${bold(green("sigma"))}`;
}

function plainMessageContent(item: TranscriptItem, theme: TuiTheme): string | ReturnType<typeof t> {
  const content = renderedMessageText(item.text);
  const suffix = item.delivery === "steer" ? " · steer" : item.delivery === "follow_up" ? " · follow-up" : "";
  const heading = item.role === "system" ? "error" : `you${suffix}`;
  if (theme.noColor) return `${heading}\n${content}`;
  if (item.role === "system") return t`${bold(red("error"))}\n${content}`;
  return t`${bold(cyan("you"))}${dim(suffix)}\n${content}`;
}

function textBody(renderer: CliRenderer, item: TranscriptItem, theme: TuiTheme): TextRenderable {
  return new TextRenderable(renderer, {
    id: `message:${item.id}`,
    content: plainMessageContent(item, theme),
    width: "100%",
    height: "auto",
    wrapMode: "word",
    marginBottom: 1,
    paddingRight: 1,
    ...(item.role === "system" && theme.error ? { fg: theme.error } : {})
  });
}

function messageNode(renderer: CliRenderer, item: TranscriptItem, theme: TuiTheme): MessageNode {
  if (item.role !== "assistant") {
    const body = textBody(renderer, item, theme);
    return { item, root: body, body, combined: true };
  }
  const box = new BoxRenderable(renderer, {
    id: `message:${item.id}`,
    width: "100%",
    height: "auto",
    flexDirection: "column",
    marginBottom: 1,
    paddingRight: 1
  });
  box.add(new TextRenderable(renderer, {
    id: `${item.id}:label`, content: label(item, theme), width: "100%", height: 1
  }));
  const body = new MarkdownRenderable(renderer, {
    id: `${item.id}:body`, content: renderedMessageText(item.text), syntaxStyle: theme.syntax,
    streaming: item.streaming, conceal: true, width: "100%", height: "auto",
    tableOptions: { style: "columns", wrapMode: "word", borders: false },
    renderNode: (token) => token.type === "code" ? new TextRenderable(renderer, {
      id: `${item.id}:code`, content: renderedMessageText(token.text), width: "100%", height: "auto",
      wrapMode: "char", ...(theme.success ? { fg: theme.success } : {})
    }) : undefined
  });
  box.add(body);
  return { item, root: box, body, combined: false };
}

function updateNode(node: MessageNode, item: TranscriptItem, theme: TuiTheme): void {
  const content = renderedMessageText(item.text);
  if (node.body instanceof MarkdownRenderable) {
    if (node.body.content !== content) node.body.content = content;
    node.body.streaming = item.streaming;
  } else if (node.item.text !== item.text || node.item.delivery !== item.delivery) {
    node.body.content = node.combined ? plainMessageContent(item, theme) : content;
  }
  node.item = item;
}

export class TranscriptView {
  private readonly nodes = new Map<string, MessageNode>();
  private readonly omitted: TextRenderable;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly container: { add(child: Renderable): number; remove(child: Renderable): void },
    private readonly theme: TuiTheme
  ) {
    this.omitted = new TextRenderable(renderer, {
      id: "transcript-omitted", width: "100%", height: 0, visible: false,
      ...(theme.muted ? { fg: theme.muted } : {})
    });
    container.add(this.omitted);
  }

  sync(view: PresentationState): void {
    const visibleTranscript = view.transcript.slice(-maximumMountedMessages);
    const omittedCount = view.transcript.length - visibleTranscript.length;
    this.omitted.content = omittedCount > 0 ? `… ${omittedCount} earlier messages omitted from the live viewport …` : "";
    this.omitted.visible = omittedCount > 0;
    this.omitted.height = omittedCount > 0 ? 2 : 0;
    const live = new Set(visibleTranscript.map((item) => item.id));
    for (const [id, node] of this.nodes) {
      if (live.has(id)) continue;
      this.container.remove(node.root);
      node.root.destroyRecursively();
      this.nodes.delete(id);
    }
    for (const item of visibleTranscript) {
      const current = this.nodes.get(item.id);
      if (current) updateNode(current, item, this.theme);
      else {
        const node = messageNode(this.renderer, item, this.theme);
        this.nodes.set(item.id, node);
        this.container.add(node.root);
      }
    }
  }
}
