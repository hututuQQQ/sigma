import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelResponse } from "../../packages/agent-protocol/src/index.js";
import { EffectToolRegistry } from "../../packages/agent-tools/src/index.js";

export interface FixtureFileCheck {
  path: string;
  expected?: string;
  absent?: boolean;
}

export function registerContentValidator(tools: EffectToolRegistry): EffectToolRegistry {
  tools.register({
    descriptor: {
      name: "verify_fixture_files",
      description: "Verify declared fixture file postconditions and return linked validation evidence.",
      inputSchema: { type: "object" },
      possibleEffects: ["filesystem.read", "validation"],
      executionMode: "parallel",
      resourceKeys: ["workspace:read"],
      approval: "auto",
      idempotent: true,
      timeoutMs: 5_000
    },
    async execute(request, context) {
      const startedAt = new Date().toISOString();
      const input = request.arguments as { checks?: Array<{ path?: unknown; expected?: unknown; absent?: unknown }> };
      const failures: string[] = [];
      for (const check of input.checks ?? []) {
        if (typeof check.path !== "string") {
          failures.push("validation path is missing");
          continue;
        }
        const target = path.resolve(context.workspacePath, check.path);
        try {
          const content = await readFile(target, "utf8");
          if (check.absent === true) failures.push(`${check.path} unexpectedly exists`);
          else if (typeof check.expected === "string" && content !== check.expected) {
            failures.push(`${check.path} content mismatch`);
          }
        } catch (error) {
          if (check.absent === true && (error as { code?: unknown }).code === "ENOENT") continue;
          failures.push(`${check.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const completedAt = new Date().toISOString();
      const ok = failures.length === 0;
      return {
        callId: request.callId,
        ok,
        output: ok ? "fixture file postconditions passed" : failures.join("\n"),
        observedEffects: ["filesystem.read", "validation"],
        actualEffects: ["filesystem.read", "validation"],
        artifacts: [],
        diagnostics: failures,
        evidence: [{
          evidenceId: `raw-validation:${request.callId}`,
          sessionId: context.sessionId,
          runId: context.runId,
          kind: "validation",
          status: ok ? "passed" : "failed",
          createdAt: completedAt,
          producer: { authority: "tool", id: request.callId },
          summary: ok ? "Fixture file postconditions passed." : "Fixture file postconditions failed.",
          data: {
            validator: "fixture_content_check",
            exitCode: ok ? 0 : 1,
            termination: {
              processStarted: true,
              state: "exited",
              exitCode: ok ? 0 : 1,
              signal: null,
              timedOut: false,
              idleTimedOut: false,
              cancelled: false
            },
            artifactIds: [],
            workspaceDeltaEvidenceIds: []
          }
        }],
        startedAt,
        completedAt
      };
    }
  });
  return tools;
}

export function validationTurn(id: string, checks: FixtureFileCheck[]): ModelResponse {
  return {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "verify_fixture_files", arguments: { checks } }]
    },
    finishReason: "tool_calls"
  };
}
