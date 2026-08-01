import type {
  ApiKeyCredential,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  AuthType,
  Credential,
  CredentialStore,
  OAuthCredential
} from "@earendil-works/pi-ai";
import { defaultCredentialStore } from "./credential-bridge.js";
import { FileCredentialStore } from "./credential-store.js";
import {
  createPiModels,
  getPiProvider,
  listPiProviders,
  OPENAI_CODEX_PROVIDER_ID,
  refreshPiProviderModels,
  type PiAuthMethodDescriptor
} from "./models.js";

export interface PiAuthStatus {
  provider: string;
  status: "authenticated" | "unauthenticated";
  authType?: AuthType;
  source?: string;
  accountId?: string;
  email?: string;
  expiresAt?: number;
}

export interface PiLoginInteraction {
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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function oauthMetadata(
  credential: OAuthCredential
): Omit<PiAuthStatus, "provider" | "status" | "authType" | "source"> {
  const payload = decodedJwtPayload(credential.access);
  const profile = payload?.["https://api.openai.com/profile"];
  const profileEmail = profile && typeof profile === "object"
    ? text((profile as Record<string, unknown>).email)
    : undefined;
  const email = text(payload?.email)
    ?? profileEmail
    ?? text(credential.email);
  const accountId = text(credential.accountId)
    ?? text(credential.userId)
    ?? text(credential.subject);
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    expiresAt: credential.expires
  };
}

function storedStatus(providerId: string, credential: Credential): PiAuthStatus {
  if (credential.type === "oauth") {
    return {
      provider: providerId,
      status: "authenticated",
      authType: "oauth",
      source: "Sigma credential store",
      ...oauthMetadata(credential)
    };
  }
  return {
    provider: providerId,
    status: "authenticated",
    authType: "api_key",
    source: "Sigma credential store"
  };
}

export async function piAuthStatus(
  providerId: string,
  credentials: CredentialStore = defaultCredentialStore()
): Promise<PiAuthStatus> {
  if (!getPiProvider(providerId)) {
    throw new Error(`Unknown Pi provider '${providerId}'.`);
  }
  const stored = await credentials.read(providerId);
  if (stored) return storedStatus(providerId, stored);
  const configured = await createPiModels(credentials).checkAuth(providerId);
  return configured
    ? {
        provider: providerId,
        status: "authenticated",
        authType: configured.type,
        ...(configured.source ? { source: configured.source } : {})
      }
    : { provider: providerId, status: "unauthenticated" };
}

export async function listPiAuthStatuses(
  credentials: CredentialStore = defaultCredentialStore()
): Promise<readonly PiAuthStatus[]> {
  return await Promise.all(listPiProviders().map((provider) =>
    piAuthStatus(provider.id, credentials)));
}

function loginMethod(providerId: string, methodId: string): PiAuthMethodDescriptor {
  const provider = listPiProviders().find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`Unknown Pi provider '${providerId}'.`);
  const method = provider.authMethods.find((candidate) => candidate.id === methodId);
  if (!method) {
    throw new Error(`Provider '${providerId}' does not support login method '${methodId}'.`);
  }
  return method;
}

function selectedOpenAIMethod(methodId: string): string {
  return methodId === "device-code" ? "device_code" : "browser";
}

function piInteractionFor(
  providerId: string,
  methodId: string,
  interaction: PiLoginInteraction
): AuthInteraction {
  let selected = false;
  return {
    signal: interaction.signal,
    notify: interaction.notify,
    prompt: async (prompt) => {
      if (providerId === OPENAI_CODEX_PROVIDER_ID
        && !selected
        && prompt.type === "select"
        && prompt.options.some((option) => option.id === "browser")
        && prompt.options.some((option) => option.id === "device_code")) {
        selected = true;
        return selectedOpenAIMethod(methodId);
      }
      return await interaction.prompt(prompt);
    }
  };
}

export async function loginPiProvider(
  providerId: string,
  methodId: string,
  interaction: PiLoginInteraction,
  credentials: CredentialStore = defaultCredentialStore()
): Promise<PiAuthStatus> {
  const method = loginMethod(providerId, methodId);
  const lease = credentials instanceof FileCredentialStore
    ? await credentials.acquireLoginLease(interaction.signal)
    : undefined;
  try {
    const models = createPiModels(credentials);
    const credential = await models.login(
      providerId,
      method.kind,
      piInteractionFor(providerId, methodId, interaction)
    );
    if (credential.type !== method.kind) {
      throw new Error(`Provider '${providerId}' returned an invalid credential type.`);
    }
    if (models.getProvider(providerId)?.refreshModels) {
      interaction.notify({ type: "progress", message: "Refreshing the provider model catalog." });
      try {
        await refreshPiProviderModels(models, providerId, {
          force: true,
          credentials,
          ...(interaction.signal ? { signal: interaction.signal } : {})
        });
      } catch {
        interaction.notify({
          type: "info",
          message: "Authentication succeeded. The cached model catalog remains available; refresh it explicitly to retry."
        });
      }
    }
    return storedStatus(providerId, credential);
  } finally {
    await lease?.release();
  }
}

export async function logoutPiProvider(
  providerId: string,
  credentials: CredentialStore = defaultCredentialStore()
): Promise<PiAuthStatus> {
  if (!getPiProvider(providerId)) {
    throw new Error(`Unknown Pi provider '${providerId}'.`);
  }
  const lease = credentials instanceof FileCredentialStore
    ? await credentials.acquireLoginLease()
    : undefined;
  try {
    await createPiModels(credentials).logout(providerId);
  } finally {
    await lease?.release();
  }
  return await piAuthStatus(providerId, credentials);
}

export type OpenAICodexLoginMethod = "browser" | "device-code";
export type OpenAICodexAuthStatus = PiAuthStatus & {
  provider: typeof OPENAI_CODEX_PROVIDER_ID;
};
export type OpenAICodexLoginInteraction = PiLoginInteraction;

export async function openAICodexAuthStatus(
  credentials: CredentialStore = defaultCredentialStore()
): Promise<OpenAICodexAuthStatus> {
  return await piAuthStatus(
    OPENAI_CODEX_PROVIDER_ID,
    credentials
  ) as OpenAICodexAuthStatus;
}

export async function loginOpenAICodex(
  method: OpenAICodexLoginMethod,
  interaction: OpenAICodexLoginInteraction,
  credentials: CredentialStore = defaultCredentialStore()
): Promise<OpenAICodexAuthStatus> {
  return await loginPiProvider(
    OPENAI_CODEX_PROVIDER_ID,
    method,
    interaction,
    credentials
  ) as OpenAICodexAuthStatus;
}

export async function logoutOpenAICodex(
  credentials: CredentialStore = defaultCredentialStore()
): Promise<void> {
  await logoutPiProvider(OPENAI_CODEX_PROVIDER_ID, credentials);
}

export type { ApiKeyCredential };
