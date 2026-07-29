import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  CredentialStore,
  OAuthCredential
} from "@earendil-works/pi-ai";
import { FileCredentialStore } from "./credential-store.js";
import {
  createOpenAICodexModels,
  OPENAI_CODEX_PROVIDER_ID
} from "./models.js";

export type OpenAICodexLoginMethod = "browser" | "device-code";

export interface OpenAICodexAuthStatus {
  provider: typeof OPENAI_CODEX_PROVIDER_ID;
  status: "authenticated" | "unauthenticated";
  accountId?: string;
  email?: string;
  expiresAt?: number;
}

export interface OpenAICodexLoginInteraction {
  signal?: AbortSignal;
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

function decodedJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];
    if (!payload) return undefined;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function credentialMetadata(credential: OAuthCredential): Omit<OpenAICodexAuthStatus, "provider" | "status"> {
  const payload = decodedJwtPayload(credential.access);
  const profile = payload?.["https://api.openai.com/profile"];
  const email = typeof payload?.email === "string"
    ? payload.email
    : profile && typeof profile === "object"
      && typeof (profile as Record<string, unknown>).email === "string"
      ? (profile as Record<string, unknown>).email as string
      : undefined;
  const accountId = typeof credential.accountId === "string" ? credential.accountId : undefined;
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    expiresAt: credential.expires
  };
}

export async function openAICodexAuthStatus(
  credentials: CredentialStore = new FileCredentialStore()
): Promise<OpenAICodexAuthStatus> {
  const credential = await credentials.read(OPENAI_CODEX_PROVIDER_ID);
  if (credential?.type !== "oauth") {
    return { provider: OPENAI_CODEX_PROVIDER_ID, status: "unauthenticated" };
  }
  return {
    provider: OPENAI_CODEX_PROVIDER_ID,
    status: "authenticated",
    ...credentialMetadata(credential)
  };
}

function methodSelection(method: OpenAICodexLoginMethod): string {
  return method === "device-code" ? "device_code" : "browser";
}

export async function loginOpenAICodex(
  method: OpenAICodexLoginMethod,
  interaction: OpenAICodexLoginInteraction,
  credentials: CredentialStore = new FileCredentialStore()
): Promise<OpenAICodexAuthStatus> {
  let selected = false;
  const piInteraction: AuthInteraction = {
    signal: interaction.signal,
    notify: interaction.notify,
    prompt: async (prompt) => {
      if (!selected && prompt.type === "select"
        && prompt.options.some((option) => option.id === "browser")
        && prompt.options.some((option) => option.id === "device_code")) {
        selected = true;
        return methodSelection(method);
      }
      return await interaction.prompt(prompt);
    }
  };
  const lease = credentials instanceof FileCredentialStore
    ? await credentials.acquireLoginLease(interaction.signal)
    : undefined;
  try {
    const models = createOpenAICodexModels(credentials);
    const credential = await models.login(OPENAI_CODEX_PROVIDER_ID, "oauth", piInteraction);
    if (credential.type !== "oauth") throw new Error("OpenAI Codex login returned an invalid credential.");
    return {
      provider: OPENAI_CODEX_PROVIDER_ID,
      status: "authenticated",
      ...credentialMetadata(credential)
    };
  } finally {
    await lease?.release();
  }
}

export async function logoutOpenAICodex(
  credentials: CredentialStore = new FileCredentialStore()
): Promise<void> {
  const lease = credentials instanceof FileCredentialStore
    ? await credentials.acquireLoginLease()
    : undefined;
  try {
    await createOpenAICodexModels(credentials).logout(OPENAI_CODEX_PROVIDER_ID);
  } finally {
    await lease?.release();
  }
}
