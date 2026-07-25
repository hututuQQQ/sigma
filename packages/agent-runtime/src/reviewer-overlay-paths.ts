import path from "node:path";
import type {
  JsonValue,
  ModelToolCall,
  ToolDescriptor
} from "agent-protocol";
import { isInside } from "agent-platform";

const PROCESS_PATH_FIELDS = new Set([
  "args",
  "command",
  "cwd",
  "env",
  "executable",
  "expectedChanges",
  "readRoots",
  "writeRoots"
]);

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value : {};
}

function directPath(
  value: string,
  logicalWorkspace: string,
  overlayWorkspace: string
): string | undefined {
  if (!path.isAbsolute(value)) return undefined;
  const logical = path.resolve(logicalWorkspace);
  const target = path.resolve(value);
  if (!isInside(logical, target)) return undefined;
  const relative = path.relative(logical, target);
  return relative ? path.join(overlayWorkspace, relative) : path.resolve(overlayWorkspace);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function textualPath(
  value: string,
  logicalWorkspace: string,
  overlayWorkspace: string
): string {
  const exact = directPath(value, logicalWorkspace, overlayWorkspace);
  if (exact) return exact;
  const forms = [...new Set([
    logicalWorkspace,
    path.resolve(logicalWorkspace),
    logicalWorkspace.replaceAll("\\", "/"),
    path.resolve(logicalWorkspace).replaceAll("\\", "/")
  ])].filter(Boolean).sort((left, right) => right.length - left.length);
  let result = value;
  for (const logical of forms) {
    const slashStyle = logical.includes("/") && !logical.includes("\\");
    const physical = slashStyle
      ? path.resolve(overlayWorkspace).replaceAll("\\", "/")
      : path.resolve(overlayWorkspace);
    const expression = new RegExp(
      `(?<![A-Za-z0-9_.-])${escapeRegex(logical)}(?=$|[\\\\/\\s'"\`=:;,.)\\]])`,
      process.platform === "win32" ? "giu" : "gu"
    );
    result = result.replace(expression, () => physical);
  }
  return result;
}

function mappedValue(
  value: JsonValue,
  logicalWorkspace: string,
  overlayWorkspace: string,
  textual: boolean
): JsonValue {
  if (typeof value === "string") {
    return textual
      ? textualPath(value, logicalWorkspace, overlayWorkspace)
      : directPath(value, logicalWorkspace, overlayWorkspace) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      mappedValue(item, logicalWorkspace, overlayWorkspace, textual));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      mappedValue(item, logicalWorkspace, overlayWorkspace, textual)
    ]));
  }
  return value;
}

/**
 * The reviewer sees the parent's stable logical workspace path, while process
 * tools execute in a private physical overlay. This deterministic projection
 * translates only declared path arguments and process invocation fields. It
 * never classifies command meaning or changes the requested operation.
 */
export function projectReviewerCallToOverlay(
  call: ModelToolCall,
  descriptor: ToolDescriptor,
  logicalWorkspace: string,
  overlayWorkspace: string
): ModelToolCall {
  const input = jsonObject(call.arguments);
  const contextPaths = new Set(descriptor.contextPathArguments ?? []);
  const processTool = ["exec", "shell", "validate"].includes(descriptor.name);
  const projected = Object.fromEntries(Object.entries(input).map(([key, value]) => {
    const declaredPath = contextPaths.has(key);
    const processPath = processTool && PROCESS_PATH_FIELDS.has(key);
    if (!declaredPath && !processPath) return [key, value];
    return [
      key,
      mappedValue(
        value,
        logicalWorkspace,
        overlayWorkspace,
        processPath
      )
    ];
  }));
  return { ...call, arguments: projected };
}
