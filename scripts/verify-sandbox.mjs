#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const requireOsSandbox = process.argv.includes("--require-os-sandbox");
const requireWindowsNative = process.argv.includes("--require-windows-native");
const root = process.cwd();
const coreDist = path.join(root, "packages", "agent-core", "dist", "index.js");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`FAIL ${message}\n`);
  process.exitCode = 1;
}

function ok(message) {
  log(`OK   ${message}`);
}

function skip(message) {
  log(`SKIP ${message}`);
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  return !result.error && result.status === 0;
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function aclSddl(target) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Acl -LiteralPath ${psSingleQuote(target)}).Sddl`],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `Get-Acl failed for ${target}`);
  }
  return result.stdout.trim();
}

function baseContext(workspacePath, sandbox) {
  return {
    workspacePath,
    permissionMode: "yolo",
    commandTimeoutSec: 8,
    maxToolOutputChars: 4000,
    runState: { todos: [], nextTodoId: 1, changedFiles: new Set() },
    alwaysAllowTools: new Set(),
    sandbox
  };
}

async function expectTool(name, result, predicate, details) {
  if (predicate(result)) {
    ok(name);
    return;
  }
  fail(`${name}: ${details(result)}`);
}

function windowsEscapeCommand(fileName) {
  return `echo bad>..\\${fileName}`;
}

async function verifyWindowsNative(core, workspace) {
  const {
    executeBashTool,
    executeServiceTool,
    executeShellSessionTool
  } = core;
  if (process.platform !== "win32") {
    const message = "not running on Windows; Windows native sandbox checks skipped.";
    if (requireWindowsNative) fail(message);
    else skip(message);
    return;
  }

  const sandbox = { mode: "workspace-write", backend: "windows", required: true, network: { mode: "default" } };
  const readOnlySandbox = { mode: "read-only", backend: "windows", required: true, network: { mode: "default" } };
  const workspaceAclBefore = aclSddl(workspace);

  await expectTool(
    "windows native workspace-write allows workspace writes",
    await executeBashTool({ command: "echo ok>inside-windows.txt" }, baseContext(workspace, sandbox)),
    (result) => result.ok && existsSync(path.join(workspace, "inside-windows.txt")),
    (result) => result.content
  );
  if (aclSddl(workspace) === workspaceAclBefore) {
    ok("windows native restores workspace ACL after execution");
  } else {
    fail("windows native left workspace ACL changed after execution");
  }

  const protectedFile = path.join(workspace, "protected-acl.txt");
  const protectedDir = path.join(workspace, "protected-acl-dir");
  await writeFile(protectedFile, "protected", "utf8");
  await mkdir(protectedDir, { recursive: true });
  const protectedFileAcl = aclSddl(protectedFile);
  const protectedDirAcl = aclSddl(protectedDir);
  const aclSandbox = {
    mode: "workspace-write",
    backend: "windows",
    required: true,
    network: { mode: "default" },
    filesystem: { denyWrite: ["protected-acl.txt", "protected-acl-dir"] }
  };
  await executeBashTool({ command: "type protected-acl.txt>NUL" }, baseContext(workspace, aclSandbox));
  if (aclSddl(protectedFile) === protectedFileAcl && aclSddl(protectedDir) === protectedDirAcl) {
    ok("windows native restores protected path ACLs after deny rules");
  } else {
    fail("windows native left protected path ACL changed after deny rules");
  }

  const escape = path.join(path.dirname(workspace), "windows-escape.txt");
  await rm(escape, { force: true });
  await expectTool(
    "windows native blocks workspace escape writes",
    await executeBashTool({ command: windowsEscapeCommand("windows-escape.txt") }, baseContext(workspace, sandbox)),
    () => !existsSync(escape),
    (result) => result.content
  );

  await expectTool(
    "windows native read-only blocks workspace writes",
    await executeBashTool({ command: "echo bad>readonly-windows.txt" }, baseContext(workspace, readOnlySandbox)),
    (result) => !result.ok && !existsSync(path.join(workspace, "readonly-windows.txt")),
    (result) => result.content
  );

  await rm(path.join(workspace, ".agent"), { recursive: true, force: true });
  await expectTool(
    "windows native blocks missing protected agent paths",
    await executeBashTool(
      { command: "if not exist .agent mkdir .agent & echo bad>.agent\\config.toml & echo bad>.agent\\mcp.json & if not exist .agent\\skills mkdir .agent\\skills & echo bad>.agent\\skills\\foo" },
      baseContext(workspace, sandbox)
    ),
    () => (
      !existsSync(path.join(workspace, ".agent", "config.toml")) &&
      !existsSync(path.join(workspace, ".agent", "mcp.json")) &&
      !existsSync(path.join(workspace, ".agent", "skills", "foo"))
    ),
    (result) => result.content
  );

  const serviceEscape = path.join(path.dirname(workspace), "windows-service-escape.txt");
  await rm(serviceEscape, { force: true });
  await executeServiceTool(
    {
      action: "start",
      name: "windows-sandbox-escape",
      command: windowsEscapeCommand("windows-service-escape.txt"),
      keepAliveAfterRun: false,
      readinessTimeoutSec: 1
    },
    baseContext(workspace, sandbox)
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (existsSync(serviceEscape)) {
    fail("windows service.start escaped workspace sandbox");
  } else {
    ok("windows service.start cannot write outside workspace");
  }

  const sessionEscape = path.join(path.dirname(workspace), "windows-session-escape.txt");
  await rm(sessionEscape, { force: true });
  const sessionContext = baseContext(workspace, sandbox);
  const start = await executeShellSessionTool({ action: "start", sessionId: "verify-windows-sandbox" }, sessionContext);
  if (!start.ok) {
    fail(`windows shell_session start failed: ${start.content}`);
  } else {
    await executeShellSessionTool(
      { action: "send", sessionId: "verify-windows-sandbox", input: windowsEscapeCommand("windows-session-escape.txt"), timeoutSec: 3 },
      sessionContext
    );
    if (existsSync(sessionEscape)) {
      fail("windows shell_session escaped workspace sandbox");
    } else {
      ok("windows shell_session cannot write outside workspace");
    }
  }
}

async function main() {
  if (!existsSync(coreDist)) {
    fail("packages/agent-core/dist/index.js not found. Run pnpm build before scripts/verify-sandbox.mjs.");
    return;
  }

  const core = await import(pathToFileURL(coreDist).href);
  const {
    executeBashTool,
    executeServiceTool,
    executeShellSessionTool,
    closeShellSessions
  } = core;

  const workspace = await mkdtemp(path.join(os.tmpdir(), "sigma-sandbox-"));
  const outside = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside.txt`);
  const outsideSecret = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside-secret.txt`);
  const readRoot = await mkdtemp(path.join(os.tmpdir(), "sigma-sandbox-readroot-"));
  const policySandbox = { mode: "policy-only", network: "restricted" };

  try {
    await expectTool(
      "policy-only compatibility",
      await executeBashTool({ command: "echo sigma-sandbox" }, baseContext(workspace, policySandbox)),
      (result) => result.ok && result.content.includes("sigma-sandbox"),
      (result) => result.content
    );

    await expectTool(
      "windows required restricted network fails closed",
      await executeBashTool(
        { command: "echo should-not-run" },
        baseContext(workspace, { mode: "workspace-write", backend: "windows", required: true })
      ),
      (result) => !result.ok && (
        result.content.includes("Windows native sandbox v1 does not implement WFP network isolation")
        || result.content.includes("Windows sandbox backend is only available on Windows")
      ),
      (result) => result.content
    );

    await verifyWindowsNative(core, workspace);

    const bwrapReady = process.platform === "linux" && commandAvailable("bwrap") && commandAvailable("unshare", ["-Ur", "true"]);
    if (!bwrapReady) {
      const message = process.platform === "linux"
        ? "bubblewrap/user namespaces unavailable; install bwrap or enable unprivileged user namespaces."
        : "not running on Linux/WSL2; bubblewrap OS sandbox checks skipped.";
      if (requireOsSandbox) fail(message);
      else skip(message);
      return;
    }

    const sandbox = { mode: "workspace-write", backend: "bubblewrap", required: true, network: { mode: "restricted" } };
    const readOnlySandbox = { mode: "read-only", backend: "bubblewrap", required: true, network: { mode: "restricted" } };
    const dangerSandbox = { mode: "danger-full-access", backend: "auto", network: { mode: "default" } };
    const runtime = commandAvailable("python3")
      ? { command: "python3", snippet: "open('../escape.txt','w').write('bad')" }
      : { command: "node", snippet: "require('fs').writeFileSync('../escape.txt','bad')" };

    await expectTool(
      "bubblewrap workspace-write allows workspace writes",
      await executeBashTool({ command: "printf ok > inside.txt" }, baseContext(workspace, sandbox)),
      (result) => result.ok && existsSync(path.join(workspace, "inside.txt")),
      (result) => result.content
    );

    await writeFile(outsideSecret, "OUTSIDE_SECRET", "utf8");
    await expectTool(
      "bubblewrap blocks reads outside workspace/readRoots",
      await executeBashTool({ command: `cat ../${path.basename(outsideSecret)}` }, baseContext(workspace, sandbox)),
      (result) => !result.content.includes("OUTSIDE_SECRET"),
      (result) => result.content
    );

    const readRootFile = path.join(readRoot, "allowed.txt");
    await writeFile(readRootFile, "READ_ROOT_SECRET", "utf8");
    await expectTool(
      "bubblewrap allows explicit readRoots",
      await executeBashTool(
        { command: `cat ${JSON.stringify(readRootFile)}` },
        baseContext(workspace, { ...sandbox, filesystem: { readRoots: [readRoot] } })
      ),
      (result) => result.ok && result.content.includes("READ_ROOT_SECRET"),
      (result) => result.content
    );

    await writeFile(path.join(workspace, "deny-secret.txt"), "DENY_READ_SECRET", "utf8");
    await expectTool(
      "bubblewrap blocks denyRead paths",
      await executeBashTool(
        { command: "cat deny-secret.txt" },
        baseContext(workspace, { ...sandbox, filesystem: { denyRead: ["deny-secret.txt"] } })
      ),
      (result) => !result.content.includes("DENY_READ_SECRET"),
      (result) => result.content
    );

    await expectTool(
      "bubblewrap blocks workspace escape writes",
      await executeBashTool({ command: `${runtime.command} -c ${JSON.stringify(runtime.snippet)}` }, baseContext(workspace, sandbox)),
      () => !existsSync(path.join(path.dirname(workspace), "escape.txt")),
      (result) => result.content
    );

    await mkdir(path.join(workspace, "writable"), { recursive: true });
    const narrowSandbox = { ...sandbox, filesystem: { writeRoots: ["writable"] } };
    await expectTool(
      "bubblewrap blocks writes outside explicit writeRoots",
      await executeBashTool({ command: "printf bad > blocked-root.txt" }, baseContext(workspace, narrowSandbox)),
      () => !existsSync(path.join(workspace, "blocked-root.txt")),
      (result) => result.content
    );
    await expectTool(
      "bubblewrap allows writes inside explicit writeRoots",
      await executeBashTool({ command: "printf ok > writable/ok.txt" }, baseContext(workspace, narrowSandbox)),
      () => existsSync(path.join(workspace, "writable", "ok.txt")),
      (result) => result.content
    );

    await rm(path.join(workspace, ".agent"), { recursive: true, force: true });
    await expectTool(
      "bubblewrap blocks missing protected agent paths",
      await executeBashTool(
        { command: "mkdir -p .agent/skills; printf bad > .agent/config.toml; printf bad > .agent/mcp.json; printf bad > .agent/skills/foo" },
        baseContext(workspace, sandbox)
      ),
      () => (
        !existsSync(path.join(workspace, ".agent", "config.toml")) &&
        !existsSync(path.join(workspace, ".agent", "mcp.json")) &&
        !existsSync(path.join(workspace, ".agent", "skills", "foo"))
      ),
      (result) => result.content
    );

    await expectTool(
      "bubblewrap read-only blocks workspace writes",
      await executeBashTool({ command: "printf bad > readonly.txt" }, baseContext(workspace, readOnlySandbox)),
      (result) => !result.ok && !existsSync(path.join(workspace, "readonly.txt")),
      (result) => result.content
    );

    const networkCommand = commandAvailable("curl")
      ? "curl --max-time 3 https://example.com"
      : "node -e \"require('https').get('https://example.com',()=>process.exit(0)).on('error',()=>process.exit(1)); setTimeout(()=>process.exit(2),3000)\"";
    await expectTool(
      "bubblewrap restricted network blocks external access",
      await executeBashTool({ command: networkCommand, timeoutSec: 6 }, baseContext(workspace, sandbox)),
      (result) => !result.ok,
      (result) => result.content
    );

    await rm(outside, { force: true });
    await expectTool(
      "danger-full-access explicitly bypasses isolation",
      await executeBashTool({ command: `printf ok > ${JSON.stringify(outside)}` }, baseContext(workspace, dangerSandbox)),
      (result) => result.ok && existsSync(outside),
      (result) => result.content
    );

    await rm(path.join(path.dirname(workspace), "service-escape.txt"), { force: true });
    await executeServiceTool(
      {
        action: "start",
        name: "sandbox-escape",
        command: "node -e \"require('fs').writeFileSync('../service-escape.txt','bad')\"",
        keepAliveAfterRun: false,
        readinessTimeoutSec: 1
      },
      baseContext(workspace, sandbox)
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (existsSync(path.join(path.dirname(workspace), "service-escape.txt"))) {
      fail("service.start escaped workspace sandbox");
    } else {
      ok("service.start cannot write outside workspace");
    }

    await rm(path.join(path.dirname(workspace), "session-escape.txt"), { force: true });
    const sessionContext = baseContext(workspace, sandbox);
    const start = await executeShellSessionTool({ action: "start", sessionId: "verify-sandbox" }, sessionContext);
    if (!start.ok) {
      fail(`shell_session start failed: ${start.content}`);
    } else {
      await executeShellSessionTool(
        { action: "send", sessionId: "verify-sandbox", input: "node -e \"require('fs').writeFileSync('../session-escape.txt','bad')\"", timeoutSec: 3 },
        sessionContext
      );
      if (existsSync(path.join(path.dirname(workspace), "session-escape.txt"))) {
        fail("shell_session escaped workspace sandbox");
      } else {
        ok("shell_session cannot write outside workspace");
      }
    }
  } finally {
    await closeShellSessions().catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { force: true }).catch(() => {});
    await rm(outsideSecret, { force: true }).catch(() => {});
    await rm(readRoot, { recursive: true, force: true }).catch(() => {});
    await rm(path.join(path.dirname(workspace), "windows-escape.txt"), { force: true }).catch(() => {});
    await rm(path.join(path.dirname(workspace), "windows-service-escape.txt"), { force: true }).catch(() => {});
    await rm(path.join(path.dirname(workspace), "windows-session-escape.txt"), { force: true }).catch(() => {});
  }
}

await main();
