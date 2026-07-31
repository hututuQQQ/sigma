import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { SIGMA_PROJECT_FACTS } from "agent-config";
import {
  BUILTIN_MODEL_SPECS,
  defaultModel,
  loadPiRuntimeModelCatalog,
  type ModelReasoningEffort,
  type ModelSpec
} from "agent-model";
import type { RuntimeClient } from "agent-protocol";
import {
  createConfiguredRuntime,
  type RuntimeFactoryDeps
} from "agent-runtime";
import {
  loadCliConfig,
  parseArgs,
  workspaceCustomizationTrustMessage,
  workspaceMcpTrustMessage
} from "../config.js";
import {
  SigmaAcpAgent,
  type SigmaAcpModelCatalog,
  type SigmaAcpRuntimeHandle
} from "../acp/sigma-acp-agent.js";

export interface AcpCommandDeps {
  runtimeFactoryDeps?: RuntimeFactoryDeps;
  runtime?: RuntimeClient;
  stderr?: NodeJS.WritableStream;
  stdin?: Readable;
  stdout?: Writable;
}

interface SelectedModel {
  provider: string;
  model: string;
}

function modelId(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function selectedModel(value: string, catalog: SigmaAcpModelCatalog): SelectedModel {
  const separator = value.indexOf("/");
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (separator < 1 || !model || !catalog.options.some((option) => option.id === value)) {
    throw new Error(`Invalid Sigma ACP model identifier '${value}'.`);
  }
  return { provider, model };
}

function catalogFor(
  flags: Record<string, unknown>,
  cwd: string,
  catalogSpecs: readonly ModelSpec[]
): SigmaAcpModelCatalog {
  const config = loadCliConfig({ ...flags, workspace: cwd });
  let currentModel = config.model;
  if (currentModel === "auto") {
    try {
      currentModel = defaultModel(config.provider);
    } catch (error) {
      const cached = catalogSpecs.find((spec) => spec.providerId === config.provider);
      if (!cached) throw error;
      currentModel = cached.upstreamModel;
    }
  }
  const options = [
    ...catalogSpecs.map((spec) => ({
      id: modelId(spec.providerId, spec.upstreamModel),
      name: spec.upstreamModel,
      description: `${spec.providerId} · ${
        spec.billingMode === "subscription"
          ? "subscription"
          : spec.billingMode === "unpriced"
            ? "price unknown"
            : spec.capabilities.reasoning
            ? "reasoning"
            : "standard"
      }`,
      ...(spec.supportedReasoningEfforts
        ? { supportedReasoningEfforts: spec.supportedReasoningEfforts }
        : {}),
      ...(spec.defaultReasoningEffort
        ? { defaultReasoningEffort: spec.defaultReasoningEffort }
        : {})
    })),
    ...config.modelSpecs.map((spec) => ({
      id: modelId(spec.providerId, spec.upstreamModel),
      name: spec.upstreamModel,
      description: `${spec.providerId} · custom model`
    }))
  ];
  return {
    currentModelId: modelId(config.provider, currentModel),
    options: [...new Map(options.map((option) => [option.id, option])).values()]
  };
}

function trustFailure(flags: Record<string, unknown>, cwd: string): string | undefined {
  const config = loadCliConfig({ ...flags, workspace: cwd });
  return workspaceMcpTrustMessage(config) ?? workspaceCustomizationTrustMessage(config);
}

export async function runAcpCommand(
  argv: string[],
  deps: AcpCommandDeps = {}
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    (deps.stdout ?? process.stdout).write(
      "Usage: sigma acp [configuration options]\n\n"
      + "Serves stable ACP v1 as newline-delimited JSON-RPC over stdin/stdout.\n"
      + "Protocol output is written only to stdout; diagnostics are written to stderr.\n"
    );
    return 0;
  }
  const parsed = parseArgs(argv);
  if (parsed.positionals.length > 0) {
    throw new Error(`Unexpected sigma acp argument '${parsed.positionals[0]}'.`);
  }
  const baseFlags = parsed.flags;
  const catalogSpecs = deps.runtime || deps.runtimeFactoryDeps?.gatewayFactory
    ? BUILTIN_MODEL_SPECS
    : (await loadPiRuntimeModelCatalog()).specs;
  const runtimeFactory = async (
    cwd: string,
    selectedId: string,
    reasoningEffort?: ModelReasoningEffort
  ): Promise<SigmaAcpRuntimeHandle> => {
    const trustMessage = trustFailure(baseFlags, cwd);
    if (trustMessage) throw new Error(trustMessage);
    if (deps.runtime) {
      return {
        runtime: deps.runtime,
        workspace: path.resolve(cwd),
        storeRootDir: deps.runtimeFactoryDeps?.stateRootDir
          ?? path.join(os.tmpdir(), "sigma-acp-injected-runtime"),
        close: async () => undefined
      };
    }
    const selection = selectedModel(selectedId, catalogFor(baseFlags, cwd, catalogSpecs));
    const config = loadCliConfig({
      ...baseFlags,
      workspace: cwd,
      provider: selection.provider,
      model: selection.model
    });
    return await createConfiguredRuntime({
      ...config,
      ...(reasoningEffort ? { reasoningEffort } : {})
    }, deps.runtimeFactoryDeps, {
      surface: "acp",
      interactiveApprovals: true
    });
  };
  const sigma = new SigmaAcpAgent({
    agentVersion: SIGMA_PROJECT_FACTS.productVersion,
    runtimeFactory,
    modelCatalog: async (cwd) => catalogFor(baseFlags, cwd, catalogSpecs),
    stderr: deps.stderr
  });
  const input = deps.stdin ?? process.stdin;
  const output = deps.stdout ?? process.stdout;
  const stream = acp.ndJsonStream(
    Writable.toWeb(output),
    Readable.toWeb(input)
  );
  const connection = sigma.app().connect(stream);
  try {
    await connection.closed;
  } finally {
    await sigma.close();
  }
  return 0;
}
