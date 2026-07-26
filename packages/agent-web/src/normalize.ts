import { Buffer } from "node:buffer";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { WebLink } from "./types.js";

const MAX_NORMALIZED_BYTES = 2 * 1_024 * 1_024;
const MAX_LINKS = 200;
const ACTIVE_ELEMENTS = [
  "script", "style", "noscript", "template", "form", "input", "button",
  "select", "textarea", "iframe", "frame", "object", "embed", "applet",
  "canvas", "svg"
].join(",");

export interface NormalizedPage {
  title: string;
  markdown: string;
  links: WebLink[];
  truncated: boolean;
}

function charset(contentType: string): string {
  return /charset\s*=\s*["']?([^;"'\s]+)/iu.exec(contentType)?.[1]?.trim() || "utf-8";
}

function decode(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charset(contentType), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function normalizedType(contentType: string, bytes: Uint8Array): string {
  const value = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (value) return value;
  const prefix = decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)), "text/plain").trimStart();
  return /^<!doctype\s+html|^<html[\s>]/iu.test(prefix) ? "text/html" : "text/plain";
}

function supportedTextType(mediaType: string): boolean {
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType === "application/xml"
    || mediaType === "application/rss+xml"
    || mediaType === "application/atom+xml"
    || mediaType.endsWith("+json")
    || mediaType.endsWith("+xml");
}

function assertText(mediaType: string, bytes: Uint8Array): void {
  if (mediaType === "application/pdf" || mediaType.startsWith("image/")
    || !supportedTextType(mediaType)) {
    throw Object.assign(new Error(
      `Unsupported Web content type '${mediaType || "unknown"}'; v1 accepts text only.`
    ), { code: "web_binary_unsupported" });
  }
  if (bytes.subarray(0, Math.min(bytes.byteLength, 4_096)).includes(0)) {
    throw Object.assign(new Error("Web response appears to be binary content."), {
      code: "web_binary_unsupported"
    });
  }
}

function safeLink(raw: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(raw, baseUrl);
    if (!matchesHttp(url) || url.username || url.password) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function matchesHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function pageLinks(document: ReturnType<typeof parseHTML>["document"], baseUrl: string): WebLink[] {
  const seen = new Set<string>();
  const links: WebLink[] = [];
  for (const anchor of document.querySelectorAll("a[href]")) {
    const url = safeLink(anchor.getAttribute("href") ?? "", baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = (anchor.textContent ?? "").replace(/\s+/gu, " ").trim() || url;
    links.push({ id: links.length + 1, title: title.slice(0, 240), url });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

function boundedUtf8(value: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_NORMALIZED_BYTES) return { text: value, truncated: false };
  let end = MAX_NORMALIZED_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: `${bytes.subarray(0, end).toString("utf8")}\n\n...[page normalized content truncated]...`,
    truncated: true
  };
}

function linksSection(links: readonly WebLink[]): string {
  if (links.length === 0) return "";
  return `\n\n## Links\n\n${links.map((link) =>
    `[${link.id}] ${link.title.replace(/\s+/gu, " ")} — ${link.url}`).join("\n")}`;
}

function htmlPage(text: string, url: string): NormalizedPage {
  const { document } = parseHTML(text);
  for (const element of document.querySelectorAll(ACTIVE_ELEMENTS)) element.remove();
  const links = pageLinks(document, url);
  const sourceTitle = document.title?.replace(/\s+/gu, " ").trim() || url;
  const article = new Readability(document as never, { keepClasses: false }).parse();
  const html = article?.content || document.body?.innerHTML || "";
  const turndown = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced"
  });
  turndown.remove(ACTIVE_ELEMENTS);
  const markdown = turndown.turndown(html).replace(/\n{3,}/gu, "\n\n").trim();
  const bounded = boundedUtf8(`${markdown}${linksSection(links)}`);
  return {
    title: (article?.title || sourceTitle).replace(/\s+/gu, " ").trim().slice(0, 500),
    markdown: bounded.text,
    links,
    truncated: bounded.truncated
  };
}

function plainPage(text: string, url: string, mediaType: string): NormalizedPage {
  let value = text;
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    try {
      value = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Preserve malformed JSON as objective text.
    }
  }
  const bounded = boundedUtf8(value.replace(/\r\n?/gu, "\n").trim());
  return { title: url, markdown: bounded.text, links: [], truncated: bounded.truncated };
}

export function normalizePage(
  bytes: Uint8Array,
  contentType: string,
  url: string
): NormalizedPage {
  const mediaType = normalizedType(contentType, bytes);
  assertText(mediaType, bytes);
  const text = decode(bytes, contentType);
  return mediaType === "text/html" || mediaType === "application/xhtml+xml"
    ? htmlPage(text, url) : plainPage(text, url, mediaType);
}
