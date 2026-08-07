import { createConfiguredRuntime, type RuntimeFactoryDeps } from "agent-runtime";
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
  createRuntime?: typeof createConfiguredRuntime;
}

function help(stdout: NodeJS.WritableStream): void {
  stdout.write(
    "Usage: sigma harness inspect [--json] [--initial-mode analyze|change] [configuration options]\n"
  );
}

export async function runHarnessCommand(
  argv: string[],
  deps: HarnessCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const { flags, positionals } = parseArgs(argv);
  if (flags.help === true) {
    help(stdout);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "inspect") {
    stderr.write("Harness command requires the action 'inspect'.\n");
    help(stderr);
    return 1;
  }
  const config = loadCliConfig(flags);
  const trustMessage = workspaceMcpTrustMessage(config)
    ?? workspaceCustomizationTrustMessage(config);
  if (trustMessage) {
    stderr.write(`${trustMessage}\n`);
    return 2;
  }
  const configured = await (deps.createRuntime ?? createConfiguredRuntime)(
    config,
    deps.runtimeFactoryDeps,
    { surface: "cli" }
  );
  try {
    const build = configured.inspectHarness(config.initialMode);
    if (flags.json === true) {
      stdout.write(`${JSON.stringify(build)}\n`);
    } else {
      stdout.write([
        `compiler=${build.compilerVersion}`,
        `activation=${build.activation}`,
        `runtime_modified=${String(build.modifiesRuntime)}`,
        `subject=${build.subject.provider}/${build.subject.model}`,
        `mode=${build.subject.runMode}`,
        `profile=${build.subject.profileId}`,
        `policy_packs=${build.policyPackIds.join(",")}`,
        `initial_tools=${build.toolPolicy.initialTools.join(",")}`,
        `digest=${build.digest}`
      ].join("\n") + "\n");
    }
    return 0;
  } finally {
    await configured.close();
  }
}
