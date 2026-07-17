import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultHookRoots,
  discoverHooks,
  freezeSessionCustomization,
  freezeWorkspaceHookTrust,
  parseHookToml,
  verifyFrozenWorkspaceHookTrust,
  workspaceCustomizationManifest
} from "../packages/agent-extensions/src/index.js";
import {
  loadCliConfig,
  workspaceCustomizationTrustMessage
} from "../packages/agent-cli/src/config.js";
import {
  resolveRuntimeCustomization,
  verifyWorkspaceCustomizationTrust
} from "../packages/agent-runtime/src/testing.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-hook-customization-"));
  temporary.push(root);
  return root;
}

const commandHook = `
id = "policy"
event = "pre_tool"
kind = "command"
command = "policy-check"
args = ["--json"]
required = true
timeout_ms = 5000
`;

const executableWorkspaceHook = `
id = "policy"
event = "pre_tool"
kind = "command"
command = "node"
args = ["scripts/policy.js"]
trust_paths = ["scripts/policy.js"]
required = true
timeout_ms = 5000
`;

describe("hook catalog", () => {
  it("strictly parses and discovers home/workspace hooks", async () => {
    const root = await tempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const roots = defaultHookRoots(home, workspace);
    await mkdir(roots[0]!.directory, { recursive: true });
    await mkdir(roots[1]!.directory, { recursive: true });
    await writeFile(path.join(roots[0]!.directory, "policy.toml"), commandHook);
    const homeCommand = path.join(roots[0]!.directory, "policy-check");
    await writeFile(homeCommand, "home policy asset\n");
    await writeFile(path.join(roots[1]!.directory, "review.toml"), `
id = "review"
event = "post_model"
kind = "agent_profile"
profile_id = "audit"
prompt = "Review the model response without tools."
`);
    await expect(discoverHooks(roots)).resolves.toMatchObject([
      { source: "home", definition: { id: "policy", kind: "command", event: "pre_tool", command: homeCommand } },
      { source: "workspace", definition: { id: "review", kind: "agent_profile", event: "post_model" } }
    ]);
    expect(() => parseHookToml(`${commandHook}\nunknown = true`)).toThrow("Unknown hook key");
    await writeFile(path.join(roots[1]!.directory, "duplicate.toml"), commandHook);
    await expect(discoverHooks(roots)).rejects.toThrow("Duplicate hook id 'policy'");
  });

  it("requires workspace executable assets to be declared in trust_paths", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    const hookRoot = defaultHookRoots(path.join(root, "home"), workspace)[1]!;
    await mkdir(hookRoot.directory, { recursive: true });
    await mkdir(path.join(workspace, "scripts"), { recursive: true });
    await writeFile(path.join(workspace, "scripts", "policy.js"), "process.stdout.write('{}');\n");
    await writeFile(path.join(hookRoot.directory, "policy.toml"), executableWorkspaceHook.replace(
      'trust_paths = ["scripts/policy.js"]\n', ""
    ));
    await expect(discoverHooks([hookRoot])).rejects.toThrow("must be declared in trust_paths");
  });

  it("forbids inline interpreter code in workspace hooks", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    const hookRoot = defaultHookRoots(path.join(root, "home"), workspace)[1]!;
    await mkdir(hookRoot.directory, { recursive: true });
    await writeFile(path.join(hookRoot.directory, "inline.toml"), `
id = "inline"
event = "pre_tool"
kind = "command"
command = "node"
args = ["-e", "require('./scripts/policy.js')"]
required = true
`);
    await expect(discoverHooks([hookRoot])).rejects.toThrow("cannot use inline interpreter code");
  });

  it.each([
    ["npm", '["run", "policy"]'],
    ["make", '["policy"]'],
    ["python", '["-m", "policy"]']
  ])("forbids workspace loaders that implicitly execute mutable cwd assets (%s)", async (command, args) => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    const hookRoot = defaultHookRoots(path.join(root, "home"), workspace)[1]!;
    await mkdir(hookRoot.directory, { recursive: true });
    await writeFile(path.join(hookRoot.directory, "implicit.toml"), `
id = "implicit"
event = "pre_tool"
kind = "command"
command = "${command}"
args = ${args}
required = true
`);
    await expect(discoverHooks([hookRoot])).rejects.toThrow("implicitly loads executable code or configuration from cwd");
  });

  it("binds a frozen workspace command hook to its trusted assets even after the live hook is deleted", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    const hookRoot = defaultHookRoots(path.join(root, "home"), workspace)[1]!;
    await mkdir(hookRoot.directory, { recursive: true });
    await mkdir(path.join(workspace, "scripts"), { recursive: true });
    await writeFile(path.join(workspace, "scripts", "policy.js"), "process.stdout.write('{}');\n");
    const hookPath = path.join(hookRoot.directory, "policy.toml");
    await writeFile(hookPath, executableWorkspaceHook);
    const [discovered] = await discoverHooks([hookRoot]);
    const manifest = workspaceCustomizationManifest(workspace);
    const frozen = await freezeSessionCustomization({
      hooks: [discovered!.definition],
      hookArtifacts: [{
        definition: discovered!.definition,
        source: "workspace",
        digest: discovered!.digest,
        trust: freezeWorkspaceHookTrust(manifest)
      }]
    });
    expect(() => verifyFrozenWorkspaceHookTrust(workspace, frozen.hooks[0]!)).not.toThrow();
    await rm(hookPath);
    expect(() => verifyFrozenWorkspaceHookTrust(workspace, frozen.hooks[0]!))
      .toThrow("changed after explicit trust");
  });
});

describe("workspace customization trust", () => {
  it("rejects profiles that disable mandatory mutation gates", async () => {
    const root = await tempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(home, ".sigma", "profiles"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(home, ".sigma", "profiles", "unsafe.toml"), `
id = "unsafe"
[mutation]
require_plan_before_mutation = false
`);
    await expect(resolveRuntimeCustomization({
      agentProfile: "unsafe", permissionMode: "ask"
    }, workspace, home)).rejects.toThrow("cannot disable mandatory mutation policy");
  });

  it("binds executable hooks to one canonical profile/hook/skill digest", async () => {
    const root = await tempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const trustStore = path.join(home, ".sigma", "customization-trust.json");
    await mkdir(path.join(workspace, ".agent", "hooks"), { recursive: true });
    await mkdir(path.join(workspace, ".agent", "profiles"), { recursive: true });
    await mkdir(path.join(workspace, ".agent", "skills", "review"), { recursive: true });
    await mkdir(path.join(workspace, "scripts"), { recursive: true });
    const scriptPath = path.join(workspace, "scripts", "policy.js");
    await writeFile(scriptPath, "process.stdout.write('{}');\n");
    const hookPath = path.join(workspace, ".agent", "hooks", "policy.toml");
    await writeFile(hookPath, executableWorkspaceHook);
    const profilePath = path.join(workspace, ".agent", "profiles", "safe.toml");
    await writeFile(profilePath, 'id = "safe"\nhooks = ["policy"]\nskills = ["review"]\n');
    const skillPath = path.join(workspace, ".agent", "skills", "review", "SKILL.md");
    await writeFile(skillPath, "---\nname: review\ndescription: Review code\n---\nReview carefully.\n");

    const options = { env: {}, homeDir: home, customizationTrustStorePath: trustStore };
    const untrusted = loadCliConfig({ workspace }, options);
    expect(untrusted.workspaceCustomizationTrust).toMatchObject({ required: true, trusted: false });
    expect(workspaceCustomizationTrustMessage(untrusted)).toContain("--trust-workspace-customization");

    const granted = loadCliConfig({ workspace, "trust-workspace-customization": true }, options);
    expect(granted.workspaceCustomizationTrust).toMatchObject({ trusted: true });
    const customization = await resolveRuntimeCustomization({
      agentProfile: "safe", permissionMode: "ask"
    }, workspace, home);
    expect(customization.profile.profile.skills).toEqual(["workspace:review"]);
    expect(customization.hookDefinitions).toMatchObject([{ id: "policy", kind: "command" }]);
    expect(customization.workspaceExecutableHookIds).toEqual(["policy"]);
    expect(() => verifyWorkspaceCustomizationTrust(
      workspace,
      customization.workspaceExecutableHookIds,
      granted.workspaceCustomizationTrust,
      customization.workspaceExecutableHookArtifacts
    )).not.toThrow();
    expect(() => verifyWorkspaceCustomizationTrust(workspace, ["policy"], undefined))
      .toThrow("require an explicit customization trust");

    const originalDigest = workspaceCustomizationManifest(workspace).customizationDigest;
    await writeFile(hookPath, executableWorkspaceHook.replace("timeout_ms = 5000", "timeout_ms = 6000"));
    expect(loadCliConfig({ workspace }, options).workspaceCustomizationTrust?.trusted).toBe(false);

    loadCliConfig({ workspace, "trust-workspace-customization": true }, options);
    await writeFile(profilePath, 'id = "safe"\ndescription = "changed"\nhooks = ["policy"]\nskills = ["review"]\n');
    expect(workspaceCustomizationManifest(workspace).customizationDigest).not.toBe(originalDigest);
    expect(loadCliConfig({ workspace }, options).workspaceCustomizationTrust?.trusted).toBe(false);
    expect(() => verifyWorkspaceCustomizationTrust(workspace, ["policy"], granted.workspaceCustomizationTrust))
      .toThrow("changed after trust");

    loadCliConfig({ workspace, "trust-workspace-customization": true }, options);
    await writeFile(skillPath, "---\nname: review\ndescription: Review code\n---\nChanged instructions.\n");
    expect(loadCliConfig({ workspace }, options).workspaceCustomizationTrust?.trusted).toBe(false);

    loadCliConfig({ workspace, "trust-workspace-customization": true }, options);
    await writeFile(scriptPath, "process.stdout.write('{\"changed\":true}');\n");
    expect(loadCliConfig({ workspace }, options).workspaceCustomizationTrust?.trusted).toBe(false);
  });

  it("rejects meaningless trust grants when no workspace hook exists", async () => {
    const root = await tempRoot();
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    await mkdir(workspace, { recursive: true });
    expect(() => loadCliConfig({ workspace, "trust-workspace-customization": true }, {
      env: {}, homeDir: home, customizationTrustStorePath: path.join(home, "trust.json")
    })).toThrow("requires at least one workspace hook");
  });
});
