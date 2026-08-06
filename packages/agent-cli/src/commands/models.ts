import {
  createPiModels,
  hydratePiModelCache,
  listPiAuthStatuses,
  listPiModels,
  listPiProviders,
  PI_AI_VERSION,
  refreshPiProviderModels,
  sanitizePiModelError
} from "agent-pi";

interface ModelsCommandDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  catalog?: () => Promise<Awaited<ReturnType<typeof modelCatalog>>>;
  refresh?: (providerId: string) => Promise<number>;
}

interface ParsedModelsArgs {
  positionals: string[];
  json: boolean;
}

function parseArgs(argv: readonly string[]): ParsedModelsArgs {
  const positionals: string[] = [];
  let json = false;
  for (const argument of argv) {
    if (argument === "--json") json = true;
    else if (argument.startsWith("-")) throw new Error(`Unknown models option '${argument}'.`);
    else positionals.push(argument);
  }
  return { positionals, json };
}

function writeJson(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

async function modelCatalog() {
  const models = createPiModels();
  await hydratePiModelCache(models);
  const [statuses] = await Promise.all([listPiAuthStatuses()]);
  const statusByProvider = new Map(statuses.map((status) => [status.provider, status]));
  const providers = listPiProviders(models).map((provider) => ({
    ...provider,
    status: statusByProvider.get(provider.id)?.status ?? "unauthenticated",
    ...(statusByProvider.get(provider.id)?.authType
      ? { authType: statusByProvider.get(provider.id)!.authType }
      : {}),
    ...(statusByProvider.get(provider.id)?.source
      ? { source: statusByProvider.get(provider.id)!.source }
      : {})
  }));
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const entries = listPiModels(models).map((model) => {
    const provider = providerById.get(model.providerId);
    const activeAuth = provider?.authType;
    const activeMethod = activeAuth
      ? provider?.authMethods.find((method) => method.kind === activeAuth)
      : undefined;
    return {
      provider: model.providerId,
      id: model.id,
      slug: `${model.providerId}/${model.id}`,
      name: model.name,
      api: model.api,
      contextWindowTokens: model.contextWindowTokens,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning,
      imageInput: model.imageInput,
      billingModes: model.billingModes,
      activeBillingMode: activeMethod?.billingMode ?? null,
      isRecommended: model.recommended,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      ...(model.defaultReasoningEffort
        ? { defaultReasoningEffort: model.defaultReasoningEffort }
        : {})
    };
  });
  return {
    schemaVersion: 1,
    piVersion: PI_AI_VERSION,
    providers,
    models: entries
  };
}

async function execute(
  parsed: ParsedModelsArgs,
  stdout: NodeJS.WritableStream,
  deps: ModelsCommandDeps
): Promise<number> {
  const [action, providerId] = parsed.positionals;
  if (action === "list") {
    if (parsed.positionals.length !== 1) throw new Error("models list does not accept a provider.");
    const catalog = await (deps.catalog ?? modelCatalog)();
    if (parsed.json) writeJson(stdout, catalog);
    else {
      for (const model of catalog.models) {
        stdout.write(`${model.slug}`
          + `${model.activeBillingMode ? ` billing=${model.activeBillingMode}` : ""}`
          + `${model.isRecommended ? " recommended" : ""}\n`);
      }
    }
    return 0;
  }
  if (action === "refresh") {
    if (!providerId || parsed.positionals.length !== 2) {
      throw new Error("models refresh requires exactly one provider.");
    }
    let count: number;
    try {
      count = deps.refresh
        ? await deps.refresh(providerId)
        : await (async () => {
            const models = createPiModels();
            await hydratePiModelCache(models);
            await refreshPiProviderModels(models, providerId);
            return listPiModels(models).filter((model) => model.providerId === providerId).length;
          })();
    } catch (error) {
      throw sanitizePiModelError(error);
    }
    if (parsed.json) {
      writeJson(stdout, { type: "completed", provider: providerId, modelCount: count });
    } else {
      stdout.write(`Refreshed ${providerId}: ${count} models.\n`);
    }
    return 0;
  }
  throw new Error("Models action must be list or refresh.");
}

export async function runModelsCommand(
  argv: string[],
  deps: ModelsCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(`sigma models list --json
sigma models refresh <provider> --json
`);
    return 0;
  }
  try {
    return await execute(parseArgs(argv), stdout, deps);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
