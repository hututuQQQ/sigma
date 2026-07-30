import { createInterface } from "node:readline";
import {
  listPiAuthStatuses,
  listPiProviders,
  loginPiProvider,
  logoutPiProvider,
  piAuthStatus,
  sanitizePiModelError,
  type AuthEvent,
  type AuthPrompt,
  type PiAuthStatus,
  type PiLoginInteraction
} from "agent-pi";

type StatusFn = (provider: string) => Promise<PiAuthStatus>;
type LoginFn = (
  provider: string,
  method: string,
  interaction: PiLoginInteraction
) => Promise<PiAuthStatus>;
type LogoutFn = (provider: string) => Promise<PiAuthStatus | void>;

interface AuthCommandDeps {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  status?: StatusFn;
  statuses?: typeof listPiAuthStatuses;
  login?: LoginFn;
  logout?: LogoutFn;
}

interface PendingPrompt {
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface AuthInputMessage {
  type: "input_response" | "cancel";
  promptId?: string;
  value?: string;
}

interface ParsedAuthArgs {
  positionals: string[];
  json: boolean;
  method?: string;
}

function parseAuthArgs(argv: readonly string[]): ParsedAuthArgs {
  const positionals: string[] = [];
  let json = false;
  let method: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--method") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--method requires a value.");
      method = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--method=")) {
      method = argument.slice("--method=".length);
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown auth option '${argument}'.`);
    positionals.push(argument);
  }
  return { positionals, json, ...(method === undefined ? {} : { method }) };
}

function writeJson(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function safeProtocolText(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/\bhttps?:\/\/[^\s]+/giu, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, "Bearer [redacted-token]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted-token]")
    .slice(0, 2_000);
}

function parseInput(line: string): AuthInputMessage | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    if (value.type === "cancel") return { type: "cancel" };
    if (value.type === "input_response" && typeof value.promptId === "string"
      && typeof value.value === "string") {
      return { type: "input_response", promptId: value.promptId, value: value.value };
    }
  } catch {
    // Invalid protocol input is ignored; stdout must remain valid JSONL.
  }
  return undefined;
}

class AuthPromptBroker {
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly input;
  private cancelled = false;

  constructor(
    stdin: NodeJS.ReadableStream,
    private readonly stdout: NodeJS.WritableStream,
    private readonly controller: AbortController
  ) {
    this.input = createInterface({ input: stdin });
    this.input.on("line", (line) => this.accept(line));
    this.input.on("close", () => this.cancel(new Error("Authentication input closed.")));
  }

  private accept(line: string): void {
    const message = parseInput(line);
    if (!message) return;
    if (message.type === "cancel") {
      this.cancel(new Error("Authentication cancelled."));
      return;
    }
    const pending = message.promptId ? this.pending.get(message.promptId) : undefined;
    if (!pending) return;
    pending.cleanup();
    this.pending.delete(message.promptId!);
    pending.resolve(message.value ?? "");
  }

  private cancel(error: Error): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort(error);
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }

  async prompt(prompt: AuthPrompt): Promise<string> {
    this.controller.signal.throwIfAborted();
    const promptId = crypto.randomUUID();
    writeJson(this.stdout, {
      type: "input_required",
      promptId,
      inputType: prompt.type,
      message: safeProtocolText(prompt.message),
      ...("placeholder" in prompt && prompt.placeholder
        ? { placeholder: safeProtocolText(prompt.placeholder) }
        : {}),
      ...(prompt.type === "select" ? { options: prompt.options } : {})
    });
    return await new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        this.pending.delete(promptId);
        reject(prompt.signal?.reason ?? this.controller.signal.reason ?? new Error("Authentication cancelled."));
      };
      const cleanup = (): void => {
        prompt.signal?.removeEventListener("abort", onAbort);
        this.controller.signal.removeEventListener("abort", onAbort);
      };
      this.pending.set(promptId, { resolve, reject, cleanup });
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (prompt.signal?.aborted || this.controller.signal.aborted) onAbort();
    });
  }

  close(): void {
    this.input.close();
    for (const pending of this.pending.values()) pending.cleanup();
    this.pending.clear();
  }
}

function authEvent(stdout: NodeJS.WritableStream, event: AuthEvent): void {
  if (event.type === "auth_url") {
    writeJson(stdout, {
      type: "auth_url",
      url: event.url,
      instructions: safeProtocolText(event.instructions)
    });
  } else if (event.type === "device_code") {
    writeJson(stdout, {
      type: "device_code",
      userCode: event.userCode,
      verificationUri: event.verificationUri,
      intervalSeconds: event.intervalSeconds,
      expiresInSeconds: event.expiresInSeconds
    });
  } else if (event.type === "info") {
    writeJson(stdout, {
      type: "progress",
      message: safeProtocolText(event.message),
      links: event.links?.map((link) => ({
        label: safeProtocolText(link.label),
        url: link.url
      }))
    });
  } else {
    writeJson(stdout, { type: "progress", message: safeProtocolText(event.message) });
  }
}

function providerDescriptor(providerId: string) {
  const provider = listPiProviders().find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`Unknown Pi provider '${providerId}'.`);
  return provider;
}

function loginMethod(providerId: string, requested: string | undefined): string {
  const provider = providerDescriptor(providerId);
  const method = requested
    ?? (providerId === "openai-codex" ? "browser" : provider.authMethods[0]?.id);
  if (!method || !provider.authMethods.some((candidate) => candidate.id === method)) {
    throw new Error(
      `Provider '${providerId}' supports: ${
        provider.authMethods.map((item) => item.id).join(", ") || "no interactive login"
      }.`
    );
  }
  return method;
}

function statusOutput(
  stdout: NodeJS.WritableStream,
  status: PiAuthStatus,
  json: boolean
): void {
  if (json) writeJson(stdout, status);
  else {
    const account = status.email ?? status.accountId;
    stdout.write(`${status.provider}=${status.status}${account ? ` account=${account}` : ""}`
      + `${status.source ? ` source=${status.source}` : ""}\n`);
  }
}

async function listCommand(
  parsed: ParsedAuthArgs,
  deps: AuthCommandDeps,
  stdout: NodeJS.WritableStream
): Promise<number> {
  if (parsed.positionals.length !== 1) throw new Error("auth list does not accept a provider.");
  const statuses = await (deps.statuses ?? listPiAuthStatuses)();
  const statusByProvider = new Map(statuses.map((status) => [status.provider, status]));
  const connections = listPiProviders().map((provider) => ({
    ...provider,
    status: statusByProvider.get(provider.id)?.status ?? "unauthenticated",
    ...(statusByProvider.get(provider.id)?.authType
      ? { authType: statusByProvider.get(provider.id)!.authType }
      : {}),
    ...(statusByProvider.get(provider.id)?.source
      ? { source: statusByProvider.get(provider.id)!.source }
      : {}),
    ...(statusByProvider.get(provider.id)?.email
      ? { email: statusByProvider.get(provider.id)!.email }
      : {})
  }));
  if (parsed.json) writeJson(stdout, { schemaVersion: 1, connections });
  else {
    for (const connection of connections) {
      stdout.write(`${connection.id}=${connection.status}`
        + `${connection.source ? ` source=${connection.source}` : ""}\n`);
    }
  }
  return 0;
}

async function executeAuthAction(
  parsed: ParsedAuthArgs,
  deps: AuthCommandDeps,
  stdout: NodeJS.WritableStream
): Promise<number> {
  const [action, provider] = parsed.positionals;
  if (action === "list") return await listCommand(parsed, deps, stdout);
  if (parsed.positionals.length > 2) {
    throw new Error(`Unexpected auth argument '${parsed.positionals[2]}'.`);
  }
  if (!provider) throw new Error("Auth provider is required.");
  providerDescriptor(provider);
  if (action === "status") {
    statusOutput(stdout, await (deps.status ?? piAuthStatus)(provider), parsed.json);
    return 0;
  }
  if (action === "login") {
    return await loginCommand(provider, loginMethod(provider, parsed.method), parsed.json, {
      ...deps,
      stdin: deps.stdin ?? process.stdin,
      stdout
    });
  }
  if (action === "logout") {
    const status = await (deps.logout ?? logoutPiProvider)(provider)
      ?? { provider, status: "unauthenticated" as const };
    if (parsed.json) writeJson(stdout, { type: "completed", ...status });
    else {
      stdout.write(status.status === "authenticated"
        ? `Removed Sigma credential for ${provider}; ambient authentication remains configured.\n`
        : `Signed out of ${provider}.\n`);
    }
    return 0;
  }
  throw new Error("Auth action must be list, status, login, or logout.");
}

async function loginCommand(
  provider: string,
  method: string,
  json: boolean,
  deps: Required<Pick<AuthCommandDeps, "stdin" | "stdout">> & AuthCommandDeps
): Promise<number> {
  if (!json) {
    deps.stderr?.write("Interactive provider login requires --json so prompts can be handled safely.\n");
    return 2;
  }
  const controller = new AbortController();
  const broker = new AuthPromptBroker(deps.stdin, deps.stdout, controller);
  const interaction: PiLoginInteraction = {
    signal: controller.signal,
    prompt: (prompt) => broker.prompt(prompt),
    notify: (event) => authEvent(deps.stdout, event)
  };
  try {
    const result = await (deps.login ?? loginPiProvider)(provider, method, interaction);
    writeJson(deps.stdout, { type: "completed", ...result });
    return 0;
  } catch (error) {
    const cancelled = controller.signal.aborted;
    const safe = sanitizePiModelError(error);
    writeJson(deps.stdout, {
      type: "error",
      code: cancelled ? "cancelled" : safe.code,
      message: cancelled ? "Authentication was cancelled." : safe.message,
      retryable: !cancelled && ["network", "timeout", "server", "rate_limited"].includes(safe.code)
    });
    return cancelled ? 130 : 1;
  } finally {
    broker.close();
  }
}

export async function runAuthCommand(argv: string[], deps: AuthCommandDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(`sigma auth list --json
sigma auth status <provider> --json
sigma auth login <provider> --method <method-id> --json
sigma auth logout <provider> --json
`);
    return 0;
  }
  try {
    const parsed = parseAuthArgs(argv);
    return await executeAuthAction(parsed, deps, stdout);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
