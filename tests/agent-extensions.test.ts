import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HookDispatcher,
  HookGateError,
  defaultProfileRoots,
  defaultSkillRoots,
  discoverAgentProfiles,
  discoverSkills,
  freezeAgentProfile,
  narrowAgentProfile,
  parseAgentProfileToml,
  restoreFrozenAgentProfile,
  restoreSkillExecutionManifest,
  type HookRunnerPort,
  type ResolvedAgentProfile
} from "../packages/agent-extensions/src/index.js";

const temporary: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-extensions-"));
  temporary.push(directory);
  return directory;
}

describe("agent profiles", () => {
  it("strictly parses profiles and freezes a stable digest", () => {
    const profile = parseAgentProfileToml(`
id = "safe"
description = "Safe coding profile"
permission_mode = "ask"
tool_allow = ["read_file", "apply_patch"]
tool_deny = ["shell"]
skills = ["home:review"]
hooks = ["policy"]
allowed_child_profiles = ["analyze"]

[routes]
orchestrator = "main"
reviewer = "review"

[budget]
max_input_tokens = 1000000
max_output_tokens = 100000
max_cost_micro_usd = 8000000
max_model_turns = 64
max_tool_calls = 512
max_children = 4
max_depth = 2
`);
    expect(profile).toMatchObject({ id: "safe", roleRoutes: { reviewer: "review" }, budget: { maxDepth: 2 } });
    const first = freezeAgentProfile(profile);
    const second = freezeAgentProfile({ ...profile, roleRoutes: { reviewer: "review", orchestrator: "main" } });
    expect(first.digest).toBe(second.digest);
    expect(Object.isFrozen(first.profile)).toBe(true);
    expect(() => parseAgentProfileToml('id = "x"\nunknown = true')).toThrow("Unknown agent profile key");
  });

  it("allows only capability-tightening child profiles", () => {
    const parent = profile({
      permissionMode: "ask",
      toolAllow: ["read", "write"],
      skills: ["review", "typescript"],
      hooks: ["audit"],
      allowedChildProfiles: ["analyze"]
    });
    const child = profile({
      id: "child",
      permissionMode: "deny",
      toolAllow: ["read"],
      skills: ["review"],
      hooks: ["audit", "stricter"],
      allowedChildProfiles: []
    });
    expect(narrowAgentProfile(parent, child)).toMatchObject({
      permissionMode: "deny",
      toolAllow: ["read"],
      toolDeny: ["shell"]
    });
    expect(() => narrowAgentProfile(parent, { ...child, permissionMode: "auto" })).toThrow("widen permission");
    expect(() => narrowAgentProfile(parent, { ...child, skills: ["network"] })).toThrow("cannot add skills");
  });

  it("discovers both roots and rejects duplicate ids", async () => {
    const root = await tempDirectory();
    const [home, workspace] = defaultProfileRoots(path.join(root, "home"), path.join(root, "workspace"));
    await mkdir(home.directory, { recursive: true });
    await mkdir(workspace.directory, { recursive: true });
    await writeFile(path.join(home.directory, "one.toml"), 'id = "same"');
    await writeFile(path.join(workspace.directory, "two.toml"), 'id = "same"');
    await expect(discoverAgentProfiles([home, workspace])).rejects.toThrow("Duplicate agent profile id 'same'");
  });

  it("restores only canonical digest-bound profile artifacts", () => {
    const frozen = freezeAgentProfile(profile());
    expect(restoreFrozenAgentProfile(frozen.canonicalJson, frozen.digest).profile.id).toBe("parent");
    expect(() => restoreFrozenAgentProfile(`${frozen.canonicalJson} `, frozen.digest)).toThrow("digest does not match");
    expect(() => restoreFrozenAgentProfile(frozen.canonicalJson, "0".repeat(64))).toThrow("digest does not match");
  });
});

describe("skills", () => {
  it("requires qualification on conflicts and contains resource reads", async () => {
    const root = await tempDirectory();
    const roots = defaultSkillRoots(path.join(root, "home"), path.join(root, "workspace"));
    await skill(roots[0].directory, "review-home", "review", "home instructions");
    const workspaceSkill = await skill(roots[1].directory, "review-workspace", "review", "workspace instructions");
    await writeFile(path.join(workspaceSkill, "reference.txt"), "contained");
    const catalog = await discoverSkills(roots);

    expect(() => catalog.resolve("review")).toThrow("Ambiguous skill");
    await expect(catalog.load("home:review")).resolves.toMatchObject({ instructions: "home instructions" });
    await expect(catalog.readResource("workspace:review", "reference.txt")).resolves.toMatchObject({ content: "contained" });
    await expect(catalog.readResource("workspace:review", "../outside.txt")).rejects.toThrow("escapes its skill root");

    await writeFile(path.join(workspaceSkill, "SKILL.md"), skillSource("review", "changed"));
    await expect(catalog.load("workspace:review")).rejects.toMatchObject({ code: "skill_changed" });
  });

  it("freezes home and workspace execution trees and rejects escapes or source changes", async () => {
    const root = await tempDirectory();
    const roots = defaultSkillRoots(path.join(root, "home"), path.join(root, "workspace"));
    const homeSkill = await skill(roots[0].directory, "runner", "runner", "Run the helper.");
    const workspaceSkill = await skill(roots[1].directory, "runner", "runner", "Run the helper.");
    await mkdir(path.join(homeSkill, "scripts"), { recursive: true });
    await mkdir(path.join(workspaceSkill, "scripts"), { recursive: true });
    await writeFile(path.join(homeSkill, "scripts", "run.mjs"), "console.log('home');\n");
    await writeFile(path.join(workspaceSkill, "scripts", "run.mjs"), "console.log('workspace');\n");
    const catalog = await discoverSkills(roots);

    const home = await catalog.snapshotExecutionManifest("home:runner");
    const workspace = await catalog.snapshotExecutionManifest("workspace:runner");
    expect(home.resources.map((item) => item.relativePath)).toEqual(["scripts/run.mjs", "SKILL.md"]);
    expect(workspace.digest).not.toBe(home.digest);
    expect(restoreSkillExecutionManifest(home.canonicalJson, home.digest)).toMatchObject({
      qualifiedName: "home:runner",
      skillDigest: catalog.resolve("home:runner").digest
    });
    await expect(catalog.resolveExecutionResource("home:runner", "scripts/run.mjs")).resolves.toMatchObject({
      rootPath: homeSkill,
      relativePath: "scripts/run.mjs"
    });
    await expect(catalog.resolveExecutionResource("home:runner", "../outside.mjs"))
      .rejects.toMatchObject({ code: "skill_resource_escape" });
    await expect(catalog.resolveExecutionResource("home:runner", "SKILL.md"))
      .rejects.toMatchObject({ code: "skill_resource_denied" });

    await writeFile(path.join(homeSkill, "scripts", "run.mjs"), "console.log('tampered');\n");
    expect((await catalog.snapshotExecutionManifest("home:runner")).digest).not.toBe(home.digest);
    expect(() => restoreSkillExecutionManifest(home.canonicalJson, "0".repeat(64)))
      .toThrow("digest does not match");
  });
});

describe("hook dispatcher", () => {
  it("adds provenance to pre-model context and fails closed on denial", async () => {
    const runner: HookRunnerPort = {
      run: vi.fn(async (request) => ({
        ok: true,
        output: request.hook.id === "deny"
          ? { decision: "deny", reason: "policy" }
          : { decision: "allow", context: ["trusted context"] },
        durationMs: 3
      }))
    };
    const allow = new HookDispatcher([commandHook("allow")], runner);
    await expect(allow.dispatch("pre_model", { prompt: "hello" }, new AbortController().signal)).resolves.toMatchObject({
      allowed: true,
      contextAdditions: [{ text: "trusted context", provenance: { kind: "hook", hookId: "allow", event: "pre_model" } }]
    });
    expect(runner.run).toHaveBeenCalledWith(expect.objectContaining({
      policy: { readOnly: true, network: "none", secrets: "stripped", maxOutputBytes: 1_048_576 }
    }), expect.any(AbortSignal));

    const deny = new HookDispatcher([commandHook("deny")], runner);
    await expect(deny.dispatch("pre_model", {}, new AbortController().signal)).rejects.toBeInstanceOf(HookGateError);
  });

  it("records optional observer failures but rejects required failures", async () => {
    const runner: HookRunnerPort = { run: async () => ({ ok: false, error: "broken", durationMs: 5 }) };
    const optional = new HookDispatcher([{ ...commandHook("post"), event: "post_model", required: false }], runner);
    await expect(optional.dispatch("post_model", {}, new AbortController().signal)).resolves.toMatchObject({
      outcomes: [{ status: "failed", reason: "broken" }]
    });
    const required = new HookDispatcher([{ ...commandHook("post"), event: "post_model", required: true }], runner);
    await expect(required.dispatch("post_model", {}, new AbortController().signal)).rejects.toBeInstanceOf(HookGateError);
  });

  it("enforces hook deadlines even when the port has not returned", async () => {
    const runner: HookRunnerPort = {
      run: async (_request, signal) => await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    };
    const dispatcher = new HookDispatcher([{ ...commandHook("slow"), timeoutMs: 5 }], runner);
    await expect(dispatcher.dispatch("pre_model", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "hook_gate_denied",
      outcome: expect.objectContaining({ reason: "Hook 'slow' timed out." })
    });
  });

  it("contains no direct process-spawn dependency", async () => {
    const source = await readFile(path.join(process.cwd(), "packages", "agent-extensions", "src", "hooks.ts"), "utf8");
    expect(source).not.toContain("node:child_process");
  });
});

function profile(overrides: Partial<ResolvedAgentProfile> = {}): ResolvedAgentProfile {
  return {
    id: "parent",
    roleRoutes: { orchestrator: "main" },
    toolAllow: null,
    toolDeny: ["shell"],
    skills: [],
    hooks: [],
    permissionMode: "ask",
    budget: {
      maxInputTokens: 8_000_000, maxOutputTokens: 1_000_000, maxCostMicroUsd: 50_000_000,
      maxModelTurns: 256, maxToolCalls: 2_048, maxChildren: 32, maxDepth: 4
    },
    mutationPolicy: {
      requirePlanBeforeMutation: true,
      checkpointBeforeMutation: true,
      reviewNonDocumentationChanges: true
    },
    allowedChildProfiles: [],
    ...overrides
  };
}

async function skill(root: string, directory: string, name: string, body: string): Promise<string> {
  const skillRoot = path.join(root, directory);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), skillSource(name, body));
  return skillRoot;
}

function skillSource(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Review source code\n---\n${body}`;
}

function commandHook(id: string) {
  return { id, event: "pre_model" as const, kind: "command" as const, command: "policy", args: [], required: true, timeoutMs: 1_000 };
}
