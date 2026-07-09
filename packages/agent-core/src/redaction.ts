const SECRET_KEY_PATTERN = /(api[_-]?key|secret|password|passwd|authorization|credential|(?:^|[_-])token(?:$|[_-])|(?:^|[_-])access[_-]?token(?:$|[_-])|(?:^|[_-])auth[_-]?token(?:$|[_-]))/i;
const STATIC_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]"],
  [/((?:api[_-]?key|token|secret|password|passwd|credential)\s*[:=]\s*["']?)[^"'\s,;]+/gi, "$1[REDACTED]"],
  [/\b(sk-[A-Za-z0-9_-]{10,})\b/g, "[REDACTED]"]
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function envSecretValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => SECRET_KEY_PATTERN.test(key) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
}

export function redactSecretText(value: string): string {
  let redacted = value;
  for (const secret of envSecretValues()) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }
  for (const [pattern, replacement] of STATIC_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function redactSecrets<T>(value: T): T {
  const active = new WeakSet<object>();

  function visit(item: unknown): unknown {
    if (typeof item === "string") return redactSecretText(item);
    if (typeof item !== "object" || item === null) return item;
    if (active.has(item)) return "[Circular]";
    active.add(item);
    try {
      if (Array.isArray(item)) return item.map(visit);
      const result: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(item)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          result[key] = "[REDACTED]";
        } else {
          result[key] = visit(nested);
        }
      }
      return result;
    } finally {
      active.delete(item);
    }
  }

  return visit(value) as T;
}
