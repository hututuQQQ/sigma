import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runReplayCommand } from "../packages/agent-cli/src/commands/replay.js";

interface ReplayReport {
  tracePath: string;
  events: number;
  counts: Record<string, number>;
  timeline?: string[];
}

function captureProcessOutput(): { stdout(): string; stderr(): string; restore(): void } {
  let stdout = "";
  let stderr = "";
  const capture = (append: (text: string) => void) => ((
    chunk: string | Uint8Array,
    ...args: unknown[]
  ): boolean => {
    append(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
    callback?.();
    return true;
  }) as typeof process.stdout.write;
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(capture((text) => {
    stdout += text;
  }));
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(capture((text) => {
    stderr += text;
  }));
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };
}

async function writeTrace(records: unknown[]): Promise<string> {
  const dir = path.join(os.tmpdir(), `agent-cli-replay-${Date.now()}-${Math.random().toString(16).slice(2)}`, "token=supersecret123456");
  await mkdir(dir, { recursive: true });
  const tracePath = path.join(dir, "trace.jsonl");
  await writeFile(tracePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return tracePath;
}

describe("agent-cli replay", () => {
  it("prints JSON timeline summaries for normal trace JSONL events", async () => {
    const tracePath = await writeTrace([
      {
        id: "1",
        timestamp: "2026-07-07T00:00:00.000Z",
        type: "run_start",
        runId: "r1",
        provider: "deepseek",
        model: "fake",
        metadata: {}
      }
    ]);
    const output = captureProcessOutput();

    try {
      const code = await runReplayCommand(["--trace-jsonl", tracePath, "--json", "--timeline"]);

      expect(code).toBe(0);
      expect(output.stderr()).toBe("");
      const report = JSON.parse(output.stdout()) as ReplayReport;
      expect(report.events).toBe(1);
      expect(report.counts.run_start).toBe(1);
      expect(report.timeline).toEqual([expect.stringContaining("[sigma] run_start provider=deepseek model=fake")]);
      expect(output.stdout()).not.toContain("supersecret123456");
      expect(output.stdout()).toContain("[REDACTED]");
    } finally {
      output.restore();
    }
  });

  it("prints JSON timeline summaries for stream-json-wrapped trace events", async () => {
    const tracePath = await writeTrace([
      {
        type: "event",
        event: {
          id: "1",
          timestamp: "2026-07-07T00:00:00.000Z",
          type: "run_start",
          runId: "r1",
          provider: "deepseek",
          model: "fake",
          metadata: {}
        }
      }
    ]);
    const output = captureProcessOutput();

    try {
      const code = await runReplayCommand(["--trace-jsonl", tracePath, "--json", "--timeline"]);

      expect(code).toBe(0);
      expect(output.stderr()).toBe("");
      const report = JSON.parse(output.stdout()) as ReplayReport;
      expect(report.events).toBe(1);
      expect(report.counts.run_start).toBe(1);
      expect(report.timeline).toEqual([expect.stringContaining("[sigma] run_start provider=deepseek model=fake")]);
    } finally {
      output.restore();
    }
  });

  it("displays context compaction events in timeline replay", async () => {
    const tracePath = await writeTrace([
      {
        id: "1",
        timestamp: "2026-07-07T00:00:00.000Z",
        type: "context_compaction_end",
        runId: "r1",
        provider: "deepseek",
        model: "fake",
        metadata: {
          strategy: "model_sub_session",
          before_message_count: 30,
          after_message_count: 12,
          compacted_message_count: 18,
          fallback_used: true,
          duration_ms: 25
        }
      }
    ]);
    const output = captureProcessOutput();

    try {
      const code = await runReplayCommand(["--trace-jsonl", tracePath, "--json", "--timeline"]);

      expect(code).toBe(0);
      const report = JSON.parse(output.stdout()) as ReplayReport;
      expect(report.counts.context_compaction_end).toBe(1);
      expect(report.timeline).toEqual([expect.stringContaining("context_compaction_end strategy=model_sub_session")]);
    } finally {
      output.restore();
    }
  });

  it("displays validation plan events in timeline replay", async () => {
    const tracePath = await writeTrace([
      {
        id: "1",
        timestamp: "2026-07-07T00:00:00.000Z",
        type: "validation_plan_created",
        runId: "r1",
        provider: "deepseek",
        model: "fake",
        metadata: {
          validationPlan: {
            candidates: [{ command: "python -m py_compile app.py" }],
            skipped: []
          }
        }
      }
    ]);
    const output = captureProcessOutput();

    try {
      const code = await runReplayCommand(["--trace-jsonl", tracePath, "--json", "--timeline"]);

      expect(code).toBe(0);
      const report = JSON.parse(output.stdout()) as ReplayReport;
      expect(report.counts.validation_plan_created).toBe(1);
      expect(report.timeline).toEqual([expect.stringContaining("validation_plan_created candidates=1 skipped=0")]);
    } finally {
      output.restore();
    }
  });
});
