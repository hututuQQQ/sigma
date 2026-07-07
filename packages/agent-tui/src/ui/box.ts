import { accent, danger, glyphs, padRight, success, truncateToWidth, visibleWidth } from "./theme.js";

export type BoxVariant = "normal" | "accent" | "danger" | "success";

export interface BoxOptions {
  title: string;
  lines: string[];
  width: number;
  height?: number;
  variant?: BoxVariant;
  color?: boolean;
}

function colorByVariant(value: string, variant: BoxVariant, enabled: boolean): string {
  if (variant === "accent") return accent(value, enabled);
  if (variant === "danger") return danger(value, enabled);
  if (variant === "success") return success(value, enabled);
  return value;
}

function borderLine(title: string, width: number, top: boolean, variant: BoxVariant, enabled: boolean): string {
  const g = glyphs();
  if (width <= 1) return "";
  if (!top) return colorByVariant(`${g.bottomLeft}${g.horizontal.repeat(Math.max(0, width - 2))}${g.bottomRight}`, variant, enabled);

  const plainTitle = title.trim();
  const label = plainTitle ? ` ${plainTitle} ` : "";
  const available = Math.max(0, width - 2);
  const safeLabel = truncateToWidth(label, available);
  const left = g.horizontal;
  const used = visibleWidth(left) + visibleWidth(safeLabel);
  const rightCount = Math.max(0, available - used);
  return colorByVariant(`${g.topLeft}${left}${safeLabel}${g.horizontal.repeat(rightCount)}${g.topRight}`, variant, enabled);
}

export function box(options: BoxOptions): string {
  const width = Math.max(4, Math.floor(options.width));
  const height = options.height ? Math.max(3, Math.floor(options.height)) : undefined;
  const variant = options.variant ?? "normal";
  const enabled = options.color ?? false;
  const g = glyphs();
  const innerWidth = Math.max(0, width - 2);
  const bodyHeight = height ? Math.max(0, height - 2) : options.lines.length;
  const source = options.lines.length > bodyHeight && bodyHeight > 0
    ? [
        ...options.lines.slice(0, Math.max(0, bodyHeight - 1)),
        `${g.ellipsis} ${options.lines.length - bodyHeight + 1} more`
      ]
    : options.lines.slice(0, bodyHeight);
  const body = source.map((line) => {
    const fitted = padRight(truncateToWidth(line, innerWidth), innerWidth);
    return `${g.vertical}${fitted}${g.vertical}`;
  });
  while (body.length < bodyHeight) body.push(`${g.vertical}${" ".repeat(innerWidth)}${g.vertical}`);
  return [
    borderLine(options.title, width, true, variant, enabled),
    ...body,
    borderLine(options.title, width, false, variant, enabled)
  ].join("\n");
}

export function unboxed(lines: string[], width: number, height?: number): string {
  const maxLines = height ? Math.max(0, height) : lines.length;
  const output = lines.slice(0, maxLines).map((line) => padRight(truncateToWidth(line, width), width));
  while (height && output.length < maxLines) output.push(" ".repeat(width));
  return output.join("\n");
}
