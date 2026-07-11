import { isSecretEnvironmentKey } from "./environment.js";
import { FramedJsonRpcRedactionStream } from "./framed-json-rpc-redaction.js";

const MINIMUM_SECRET_LENGTH = 4;
export type SecretRedactionMode = "default" | "length_preserving";

function replaceAllLiteral(input: string, search: string, replacement: string): string {
  return input.split(search).join(replacement);
}

export class SecretRedactor {
  private readonly values: Array<{ name: string; value: string }>;

  constructor(secrets: Record<string, string | undefined> = {}) {
    this.values = Object.entries(secrets)
      .filter((entry): entry is [string, string] => Boolean(entry[1]) && entry[1]!.length >= MINIMUM_SECRET_LENGTH)
      .map(([name, value]) => ({ name, value }))
      .sort((left, right) => right.value.length - left.value.length);
  }

  redactText(input: string, mode: SecretRedactionMode = "default"): string {
    let output = input;
    for (const secret of this.values) {
      const replacement = mode === "length_preserving"
        ? "*".repeat(Buffer.byteLength(secret.value, "utf8"))
        : `[REDACTED:${secret.name}]`;
      output = replaceAllLiteral(output, secret.value, replacement);
    }
    return output;
  }

  redactUnknown(input: unknown): unknown {
    if (typeof input === "string") return this.redactText(input);
    if (Array.isArray(input)) return input.map((value) => this.redactUnknown(value));
    if (!input || typeof input !== "object") return input;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      output[key] = isSecretEnvironmentKey(key) ? "[REDACTED]" : this.redactUnknown(value);
    }
    return output;
  }

  redactJsonValue(input: unknown): unknown {
    if (typeof input === "number" && Number.isFinite(input)) {
      const value = String(input);
      const redacted = this.redactText(value);
      return redacted === value ? input : redacted;
    }
    if (Array.isArray(input)) return input.map((value) => this.redactJsonValue(value));
    if (!input || typeof input !== "object") return this.redactUnknown(input);
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      output[key] = isSecretEnvironmentKey(key) ? "[REDACTED]" : this.redactJsonValue(value);
    }
    return output;
  }

  createStream(mode: SecretRedactionMode = "default"): SecretRedactionStream {
    return new SecretRedactionStream(this, mode);
  }

  createFramedJsonRpcStream(): FramedJsonRpcRedactionStream {
    return new FramedJsonRpcRedactionStream(this);
  }

  redactStreamValue(
    input: string,
    final: boolean,
    mode: SecretRedactionMode = "default"
  ): { output: string; pending: string } {
    const redacted = this.redactText(input, mode);
    const suffixLength = this.secretPrefixSuffixLength(redacted);
    if (suffixLength === 0) return { output: redacted, pending: "" };
    const safe = redacted.slice(0, -suffixLength);
    return final
      ? { output: `${safe}${mode === "length_preserving"
        ? "*".repeat(Buffer.byteLength(redacted.slice(-suffixLength), "utf8"))
        : "[REDACTED:partial]"}`, pending: "" }
      : { output: safe, pending: redacted.slice(-suffixLength) };
  }

  private secretPrefixSuffixLength(input: string): number {
    let maximum = 0;
    for (const secret of this.values) {
      const limit = Math.min(input.length, secret.value.length - 1);
      for (let length = limit; length > maximum; length -= 1) {
        if (secret.value.startsWith(input.slice(-length))) {
          maximum = length;
          break;
        }
      }
    }
    return maximum;
  }
}

export class SecretRedactionStream {
  private pending = "";

  constructor(
    private readonly redactor: SecretRedactor,
    private readonly mode: SecretRedactionMode = "default"
  ) {}

  push(input: string, options: { final?: boolean; discontinuity?: boolean } = {}): string {
    if (options.discontinuity) {
      this.pending = "";
      if (input.length > 0) {
        return this.mode === "length_preserving"
          ? "*".repeat(Buffer.byteLength(input, "utf8"))
          : "[REDACTED:truncated-output]";
      }
    }
    const value = this.redactor.redactStreamValue(
      `${this.pending}${input}`,
      options.final === true,
      this.mode
    );
    this.pending = value.pending;
    return value.output;
  }
}
