import type {
  Credential,
  CredentialInfo,
  CredentialStore
} from "@earendil-works/pi-ai";
import { FileCredentialStore, isCredential } from "./credential-store.js";

interface CredentialBridgeBootstrap {
  version: 1;
  nonce: string;
  provider: string;
  credential: Credential;
}

interface CredentialBridgeUpdate {
  version: 1;
  sequence: number;
  operation: "replace" | "delete";
  provider: string;
  credential?: Credential;
}

export const SIGMA_CREDENTIAL_BRIDGE_PROTOCOL = "stdio-v1";
export const SIGMA_CREDENTIAL_UPDATE_PREFIX = "@@SIGMA_CREDENTIAL_UPDATE_V1@@";
const MAX_CREDENTIAL_BRIDGE_BYTES = 1_048_576;
let processCredentialStore: CredentialStore | undefined;

function cloneCredential(credential: Credential): Credential {
  return JSON.parse(JSON.stringify(credential)) as Credential;
}

function parseCredentialBridgeBootstrap(value: unknown): CredentialBridgeBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential_bridge_invalid: bootstrap must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1
    || typeof candidate.nonce !== "string"
    || !/^[a-f0-9]{32,64}$/u.test(candidate.nonce)
    || typeof candidate.provider !== "string"
    || candidate.provider.length < 1
    || candidate.provider.length > 200
    || !isCredential(candidate.credential)) {
    throw new Error("credential_bridge_invalid: bootstrap does not match protocol 1");
  }
  return {
    version: 1,
    nonce: candidate.nonce,
    provider: candidate.provider,
    credential: cloneCredential(candidate.credential)
  };
}

/** Process-local store for a trusted launcher. The child never materializes the
 * credential in its filesystem or environment. A mutation becomes visible in
 * memory only after its framed update has been accepted by stdout. */
export class CredentialBridgeStore implements CredentialStore {
  private credential: Credential | undefined;
  private sequence = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly bootstrap: CredentialBridgeBootstrap,
    private readonly output: NodeJS.WritableStream = process.stdout
  ) {
    this.credential = cloneCredential(bootstrap.credential);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return providerId === this.bootstrap.provider && this.credential
      ? cloneCredential(this.credential)
      : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.credential
      ? [{ providerId: this.bootstrap.provider, type: this.credential.type }]
      : [];
  }

  private assertProvider(providerId: string): void {
    if (providerId !== this.bootstrap.provider) {
      throw new Error("credential_bridge_scope_violation: provider is outside the launcher grant");
    }
  }

  private async emit(update: Omit<CredentialBridgeUpdate, "version" | "sequence">): Promise<void> {
    const sequence = this.sequence + 1;
    const record: CredentialBridgeUpdate = { version: 1, sequence, ...update };
    const serialized = Buffer.from(JSON.stringify(record), "utf8");
    if (serialized.length > MAX_CREDENTIAL_BRIDGE_BYTES) {
      throw new Error("credential_bridge_invalid: update exceeds the size limit");
    }
    const payload = serialized.toString("base64url");
    const line = `${SIGMA_CREDENTIAL_UPDATE_PREFIX}${this.bootstrap.nonce}:${payload}\n`;
    await new Promise<void>((resolve, reject) => {
      this.output.write(line, (error?: Error | null) => error ? reject(error) : resolve());
    });
    this.sequence = sequence;
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    this.assertProvider(providerId);
    const operation = this.chain.then(async () => {
      const current = this.credential ? cloneCredential(this.credential) : undefined;
      const replacement = await fn(current);
      if (replacement === undefined) return current;
      if (!isCredential(replacement)) {
        throw new Error("credential_bridge_invalid: provider returned an invalid credential");
      }
      const next = cloneCredential(replacement);
      await this.emit({ operation: "replace", provider: providerId, credential: next });
      this.credential = next;
      return cloneCredential(next);
    });
    this.chain = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async delete(providerId: string): Promise<void> {
    this.assertProvider(providerId);
    const operation = this.chain.then(async () => {
      if (!this.credential) return;
      await this.emit({ operation: "delete", provider: providerId });
      this.credential = undefined;
    });
    this.chain = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

async function readCredentialBridgeInput(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of input as NodeJS.ReadableStream & AsyncIterable<Buffer | string>) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_CREDENTIAL_BRIDGE_BYTES) {
        throw new Error("credential_bridge_invalid: bootstrap exceeds the size limit");
      }
      chunks.push(bytes);
    }
  } finally {
    const destroy = (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy;
    if (typeof destroy === "function") destroy.call(input);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readCredentialBridgeStore(options: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
} = {}): Promise<CredentialBridgeStore> {
  const source = await readCredentialBridgeInput(options.input ?? process.stdin);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("credential_bridge_invalid: bootstrap is not valid JSON");
  }
  return new CredentialBridgeStore(
    parseCredentialBridgeBootstrap(value),
    options.output ?? process.stdout
  );
}

/** Install the launcher bridge once, before any model/runtime object is built. */
export async function configureCredentialBridgeFromEnvironment(options: {
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
} = {}): Promise<CredentialStore | undefined> {
  const env = options.env ?? process.env;
  if (env.SIGMA_CREDENTIAL_BRIDGE !== SIGMA_CREDENTIAL_BRIDGE_PROTOCOL) return undefined;
  if (processCredentialStore) return processCredentialStore;
  delete env.SIGMA_CREDENTIAL_BRIDGE;
  delete env.SIGMA_CREDENTIAL_FILE;
  processCredentialStore = await readCredentialBridgeStore({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout
  });
  return processCredentialStore;
}

export function defaultCredentialStore(): CredentialStore {
  return processCredentialStore ?? new FileCredentialStore();
}
