import {
  createConfiguredRuntime,
  type ConfiguredRuntime,
  type RuntimeFactoryDeps
} from "agent-runtime";
import {
  loadCliConfig,
  parseArgs,
  workspaceCustomizationTrustMessage,
  workspaceMcpTrustMessage
} from "../config.js";

interface HarnessCommandDeps {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  runtimeFactoryDeps?: RuntimeFactoryDeps;
  createConfiguredRuntime?: typeof createConfiguredRuntime;
}

function inspection(
  build: ReturnType<ConfiguredRuntime["inspectHarness"]>,
  tokens: Awaited<ReturnType<ConfiguredRuntime["inspectHarnessTokens"]>>
) {
  return {
    schemaVersion: 1,
    compilerVersion: build.compilerVersion,
    policyPackIds: build.policyPackIds,
    digest: build.digest,
    subject: build.subject,
    prompt: {
      variant: build.promptPolicy.variant,
      targetTokens: build.promptPolicy.targetTokens
    },
    tools: {
      initial: build.toolPolicy.initialTools,
      potential: build.toolPolicy.potentialTools,
      stateActivated: build.toolPolicy.stateActivatedTools,
      mcp: build.toolPolicy.mcpTools,
      bundles: build.toolPolicy.bundles
    },
    context: build.contextPolicy,
    observations: build.observationPolicy,
    tokens,
    assurance: build.assurancePolicy,
    constraintSources: build.constraintSources
  };
}

export async function runHarnessCommand(
  argv: string[],
  deps: HarnessCommandDeps = {}
): Promise<number> {
  const json = argv.includes("--json");
  const cleaned = argv.filter((argument) => argument !== "--json");
  const { flags, positionals } = parseArgs(cleaned);
  if (positionals.length !== 1 || positionals[0] !== "inspect") {
    throw new Error("Usage: sigma harness inspect --json");
  }
  const config = loadCliConfig(flags);
  const trustMessage = workspaceMcpTrustMessage(config)
    ?? workspaceCustomizationTrustMessage(config);
  if (trustMessage) {
    (deps.stderr ?? process.stderr).write(`${trustMessage}\n`);
    return 2;
  }
  const configured = await (deps.createConfiguredRuntime ?? createConfiguredRuntime)(
    config,
    deps.runtimeFactoryDeps,
    { surface: "cli" }
  );
  try {
    const report = inspection(
      configured.inspectHarness(config.initialMode),
      await configured.inspectHarnessTokens(config.initialMode)
    );
    const stdout = deps.stdout ?? process.stdout;
    if (json) stdout.write(`${JSON.stringify(report)}\n`);
    else {
      stdout.write(`compiler=${report.compilerVersion} digest=${report.digest}\n`);
      stdout.write(`policy_packs=${report.policyPackIds.join(",")}\n`);
      stdout.write(`initial_tools=${report.tools.initial.join(",")}\n`);
      stdout.write(`potential_tools=${report.tools.potential.join(",")}\n`);
      stdout.write(`history_tokens=${report.context.historyTokenLimit}\n`);
      stdout.write(`initial_prompt_and_tools_tokens=${report.tokens.combinedTokens}\n`);
    }
    return 0;
  } finally {
    await configured.close();
  }
}
