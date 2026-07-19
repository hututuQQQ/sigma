import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageHarborRuntime } from "../scripts/package-harbor-runtime.mjs";
import {
  portableAgentImportPath,
  removedHarborDirectoryName,
  removedHarborPackageName
} from "../scripts/bench-common.mjs";

describe("package-harbor-runtime", () => {
  it("creates a portable Harbor runtime with direct CLI configs", async () => {
    const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "sigma-harbor-runtime-"));
    const agentCliTarball = path.join(artifactsDir, "agent-cli-linux-x64.tgz");
    await writeFile(agentCliTarball, "fixture", "utf8");
    const result = await packageHarborRuntime({ artifactsDir, agentCliTarball });

    const runtimeSource = await readFile(path.join(result.harborRuntimeDir, "sigma_harbor_agent.py"), "utf8");
    const brokerSource = await readFile(result.brokerPath, "utf8");
    const sandboxCompose = await readFile(result.sandboxComposePath, "utf8");
    const containerCompose = await readFile(result.containerComposePath, "utf8");
    const k5Config = JSON.parse(await readFile(path.join(result.harborRuntimeDir, "jobconfig.deepseek.k5.json"), "utf8"));
    const readme = await readFile(path.join(result.harborRuntimeDir, "README.md"), "utf8");

    expect(runtimeSource).toContain("class SigmaCliHarborAgent(BaseAgent):");
    expect(runtimeSource).not.toContain(removedHarborPackageName);
    expect(k5Config.agents[0].name).toBe(portableAgentImportPath);
    expect(JSON.stringify(k5Config)).not.toContain(removedHarborPackageName);
    expect(k5Config.agents[0].kwargs.agent_cli_tarball).toBe(result.agentCliTarball);
    expect(k5Config.agents[0].kwargs.execution_mode).toBe("container");
    expect(k5Config.environment).toEqual({
      type: "docker",
      extra_docker_compose: [result.containerComposePath]
    });
    expect(sandboxCompose).toContain("SYS_ADMIN");
    expect(sandboxCompose).toContain("seccomp=unconfined");
    expect(sandboxCompose).not.toContain("sigma-control:");
    expect(sandboxCompose).not.toContain("sigma-oci-broker:");
    expect(sandboxCompose).not.toContain("/var/run/docker.sock");
    expect(sandboxCompose).not.toContain("__SIGMA_");
    expect(containerCompose).toContain("SYS_ADMIN");
    expect(containerCompose).toContain("seccomp=unconfined");
    expect(containerCompose).toContain("sigma-control:");
    expect(containerCompose).toContain("sigma-oci-broker:");
    const controlCompose = containerCompose.slice(
      containerCompose.indexOf("  sigma-control:"),
      containerCompose.lastIndexOf("\n  sigma-oci-broker:")
    );
    expect(controlCompose).toMatch(/source: sigma-oci-ipc[\s\S]*?target: \/run\/sigma-oci\s+read_only: true/u);
    expect(controlCompose).toMatch(/source: sigma-oci-artifacts[\s\S]*?target: \/run\/sigma-oci\/artifacts/u);
    expect(controlCompose).toMatch(/source: sigma-target-helper[\s\S]*?target: \/opt\/sigma-helper\s+read_only: true/u);
    expect(containerCompose).toContain("target: /var/run/docker.sock");
    expect(containerCompose.match(/target: \/var\/run\/docker\.sock/gu)).toHaveLength(1);
    expect(containerCompose).toContain("target: /run/sigma-oci");
    expect(containerCompose).toContain("nocopy: true");
    expect(containerCompose).not.toContain("__SIGMA_");
    expect(brokerSource).toContain("managed target selection resolved");
    expect(brokerSource).toContain("container_attestation_invalid");
    expect(brokerSource).toContain("assertManagedBoundaryTopology");
    expect(brokerSource).toContain("installTrustedHelper");
    expect(brokerSource).toMatch(/const EXPECTED_AGENT_CLI_SHA256 = "[a-f0-9]{64}";/u);
    expect(brokerSource).not.toContain("__SIGMA_AGENT_CLI_SHA256__");
    expect(brokerSource).toContain('User: "0:0"');
    expect(path.isAbsolute(k5Config.agents[0].kwargs.agent_cli_tarball)).toBe(true);
    expect(readme).not.toContain(removedHarborPackageName);
    expect(readme).not.toContain(removedHarborDirectoryName);
    expect(readme).toContain("pnpm package:agent-cli");
    expect(readme).toContain('PYTHONPATH="$PWD/.artifacts/harbor-runtime"');
    expect(readme).toContain("harbor run --config .artifacts/harbor-runtime/jobconfig.deepseek.k5.json");
  });
});
