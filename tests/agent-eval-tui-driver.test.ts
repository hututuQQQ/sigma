import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("evaluation TUI event tail", () => {
  it("retains a torn JSONL suffix and reads long Windows event paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-tail-"));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const identity = process.platform === "win32" ? path.resolve(workspace).toLowerCase() : path.resolve(workspace);
    const workspaceHash = createHash("sha256").update(identity).digest("hex");
    const stateHome = path.join(root, "state", "long-segment-".repeat(5));
    const eventFile = path.join(stateHome, "workspaces", workspaceHash, "stores", "v3", "sessions", "session", "events", "000001.jsonl");
    await mkdir(path.dirname(eventFile), { recursive: true });
    const event = {
      eventId: "event-1", sessionId: "session", runId: "run", seq: 1,
      occurredAt: "2026-01-01T00:00:00.000Z", type: "run.completed", payload: {}
    };
    const record = JSON.stringify({ checksum: "not-used-by-tail", event });
    const split = Math.floor(record.length / 2);
    await writeFile(eventFile, record.slice(0, split), "utf8");
    const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const source = [
      "import importlib.util,sys",
      "from pathlib import Path",
      "spec=importlib.util.spec_from_file_location('driver',sys.argv[1])",
      "driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)",
      "tail=driver.EventTail(Path(sys.argv[2]),Path(sys.argv[3]))",
      "print(len(tail.read()))",
      "handle=open(driver.long_path(Path(sys.argv[4])),'ab');handle.write(sys.argv[5].encode('utf-8')+b'\\n');handle.close()",
      "events=tail.read();print(len(events),events[-1]['type'] if events else 'none')"
    ].join(";");
    const result = spawnSync(python, ["-c", source, path.resolve("scripts/eval/tui-driver.py"), stateHome, workspace, eventFile, record.slice(split)], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual(["0", "1 run.completed"]);
  });

  it("settles an unanswered suspension only after interactions and approvals are resolved", () => {
    const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const source = [
      "import importlib.util,sys,time",
      "spec=importlib.util.spec_from_file_location('driver',sys.argv[1])",
      "driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)",
      "now=time.monotonic()",
      "s=[{'eventId':'s','seq':2,'type':'run.suspended','payload':{}}]",
      "print(driver.quit_boundary(s,set(),0,None,now)['type'])",
      "p=[{'eventId':'a','seq':1,'type':'tool.approval_requested','payload':{'requestId':'r'}},*s]",
      "print(driver.quit_boundary(p,set(),0,None,now))",
      "r=[*p,{'eventId':'r','seq':3,'type':'tool.approval_resolved','payload':{'requestId':'r'}},{'eventId':'s2','seq':4,'type':'run.suspended','payload':{}}]",
      "print(driver.quit_boundary(r,set(),0,None,now)['type'])",
      "c=[*p,{'eventId':'r','seq':3,'type':'tool.approval_resolved','payload':{'requestId':'r'}},{'eventId':'m','seq':4,'type':'model.started','payload':{}}]",
      "print(driver.quit_boundary(c,set(),0,None,now))",
      "print(driver.quit_boundary(s,set(),1,None,now))"
    ].join(";");
    const result = spawnSync(python, ["-c", source, path.resolve("scripts/eval/tui-driver.py")], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual(["run.suspended", "None", "run.suspended", "None", "None"]);
  });

  it("drives initial input, one-shot approval, steering, and graceful exit through the terminal loop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-tui-loop-"));
    temporary.push(root);
    const harness = path.join(root, "harness.py");
    await writeFile(harness, `
import importlib.util, json, sys, time
from pathlib import Path

spec = importlib.util.spec_from_file_location("driver", sys.argv[1])
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

class FakeTerminal:
    backend = "fake-conpty"
    def __init__(self):
        self.chunks = ["New session. Type a request and press Enter."]
        self.writes = []
        self.running = True
    def read(self):
        if self.chunks:
            return self.chunks.pop(0)
        time.sleep(0.01)
        return ""
    def write(self, value):
        self.writes.append(value)
        if value == "/quit\\r":
            self.running = False
    def alive(self): return self.running
    def wait(self): return 0
    def terminate(self): self.running = False
    def close(self): pass

terminal = FakeTerminal()
driver.terminal_for = lambda command, cwd, env: terminal

events = [
    {"eventId":"a","seq":1,"type":"tool.approval_requested","payload":{"requestId":"approval"}},
    {"eventId":"b","seq":2,"type":"tool.approval_resolved","payload":{"requestId":"approval"}},
    {"eventId":"c","seq":3,"type":"tool.completed","payload":{"workspaceDelta":{"added":["draft.md"],"modified":[],"deleted":[]}}},
    {"eventId":"d","seq":4,"type":"run.completed","payload":{}},
]
class FakeTail:
    def __init__(self, state_home, workspace): self.pending = list(events)
    def read(self):
        result, self.pending = self.pending, []
        return result
driver.EventTail = FakeTail

root = Path(sys.argv[2])
workspace = root / "workspace"
workspace.mkdir()
result = driver.run({
    "command":["unused"], "workspace":str(workspace), "stateHome":str(root / "state"),
    "transcriptPath":str(root / "transcript.log"), "initialMessage":"initial request",
    "permissionPolicy":"allow_once",
    "interactions":[{"triggers":[{"kind":"first_mutation"}],"action":"steer","text":"stop now"}],
    "budget":{"wallTimeSec":5,"modelTurns":8,"toolCalls":12,"costUsd":0.1},
})
print(json.dumps({"writes":terminal.writes,"result":result}))
`, "utf8");
    const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const result = spawnSync(python, [harness, path.resolve("scripts/eval/tui-driver.py"), root], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true
    });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.writes).toEqual(expect.arrayContaining(["initial request\r", "y", "stop now\r", "/quit\r"]));
    expect(output.result).toMatchObject({
      backend: "fake-conpty",
      approvalCount: 1,
      interactionsDelivered: 1,
      settledTerminalType: "run.completed"
    });
  });

  it("carries input, approval, steer, and quit through a real PTY or ConPTY process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sigma-eval-real-terminal-"));
    temporary.push(root);
    const workspace = path.join(root, "workspace");
    const stateHome = path.join(root, "state");
    const transcriptPath = path.join(root, "transcript.log");
    const childPath = path.join(root, "interactive_tui.py");
    const configPath = path.join(root, "config.json");
    await mkdir(workspace);
    await writeFile(childPath, `
import hashlib, json, os, sys
from pathlib import Path

workspace = Path(sys.argv[1]).resolve()
state_home = Path(sys.argv[2]).resolve()
identity = str(workspace).lower() if os.name == "nt" else str(workspace)
session = "real-terminal-session"
events = state_home / "workspaces" / hashlib.sha256(identity.encode()).hexdigest() / "stores" / "v3" / "sessions" / session / "events" / "000001.jsonl"
events.parent.mkdir(parents=True)
sequence = 0

def emit(kind, payload):
    global sequence
    sequence += 1
    event = {"eventId": f"event-{sequence}", "sessionId": session, "runId": "run", "seq": sequence, "type": kind, "payload": payload}
    with events.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": event}) + "\\n")

if os.name == "nt":
    import msvcrt
    def character(): return msvcrt.getwch()
    restore = lambda: None
else:
    import termios, tty
    descriptor = sys.stdin.fileno()
    previous = termios.tcgetattr(descriptor)
    tty.setraw(descriptor)
    def character(): return os.read(descriptor, 1).decode("utf-8", errors="replace")
    restore = lambda: termios.tcsetattr(descriptor, termios.TCSADRAIN, previous)

def line():
    result = []
    while True:
        value = character()
        if value in ("\\r", "\\n"): return "".join(result)
        result.append(value)

try:
    print("New session. Type a request and press Enter.", flush=True)
    initial = line()
    emit("tool.approval_requested", {"requestId": "approval", "callId": "write", "toolName": "write"})
    decision = character()
    emit("tool.approval_resolved", {"requestId": "approval", "decision": "allow"})
    draft = workspace / "draft.md"
    draft.write_text("temporary", encoding="utf-8")
    emit("tool.completed", {"callId": "write", "name": "write", "workspaceDelta": {"added": ["draft.md"], "modified": [], "deleted": []}})
    steer = line()
    emit("user.steer", {"text": steer})
    draft.unlink()
    emit("tool.completed", {"callId": "cleanup", "name": "delete", "workspaceDelta": {"added": [], "modified": [], "deleted": ["draft.md"]}})
    emit("run.completed", {"message": "stopped and cleaned"})
    quit_command = line()
    (workspace / "received.json").write_text(json.dumps({"initial": initial, "decision": decision, "steer": steer, "quit": quit_command}), encoding="utf-8")
finally:
    restore()
`, "utf8");
    const python = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: 1,
      command: [python, childPath, workspace, stateHome],
      workspace,
      stateHome,
      transcriptPath,
      initialMessage: "create a draft",
      permissionPolicy: "allow_once",
      interactions: [{ triggers: [{ kind: "first_mutation" }], action: "steer", text: "stop and clean" }],
      budget: { wallTimeSec: 10, modelTurns: 8, toolCalls: 12, costUsd: 0.1 }
    })}\n`, "utf8");

    const result = spawnSync(python, [path.resolve("scripts/eval/tui-driver.py"), configPath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 30_000
    });

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary).toMatchObject({
      backend: process.platform === "win32" ? "windows-conpty" : "posix-pty",
      approvalCount: 1,
      interactionsDelivered: 1,
      settledTerminalType: "run.completed"
    });
    const received = JSON.parse(await readFile(path.join(workspace, "received.json"), "utf8"));
    expect(received).toEqual({ initial: "create a draft", decision: "y", steer: "stop and clean", quit: "/quit" });
  }, 35_000);
});
