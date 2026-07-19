import { describe, expect, it } from "vitest";
import type { ActiveModelTurn } from "../packages/agent-kernel/src/index.js";
import type { ToolReceipt } from "../packages/agent-protocol/src/index.js";
import {
  EffectRunner,
  type EffectRunnerOptions
} from "../packages/agent-runtime/src/effect-runner.js";
import type { RuntimeSession } from "../packages/agent-runtime/src/types.js";
import { runtimeSessionFixture } from "./testkit/runtime-session-fixture.js";

interface EffectRunnerInternals {
  reviews: {
    maybeReview(session: RuntimeSession, signal: AbortSignal, explicitlyRequested?: boolean): Promise<void>;
  };
  transactions: {
    settleBudgetsAfterReceipt(session: RuntimeSession): Promise<void>;
  };
  emitReceipt(session: RuntimeSession, receipt: ToolReceipt, modelTurn: ActiveModelTurn): Promise<void>;
}

describe("runtime terminal review ordering", () => {
  it("durably finishes review before emitting a successful runtime_finalize receipt", async () => {
    const order: string[] = [];
    const options = {
      runtime: {},
      maxParallelTools: 1,
      permissionMode: "auto",
      emit: async (_session: RuntimeSession, type: string) => {
        order.push(type);
        return {};
      },
      finish: async () => true,
      createArtifact: async () => "artifact",
      control: {},
      budgets: {},
      reviewer: {},
      hooks: {
        dispatch: async (_session: RuntimeSession, hook: string) => {
          order.push(`hook:${hook}`);
        }
      }
    } as unknown as EffectRunnerOptions;
    const runner = new EffectRunner(options) as unknown as EffectRunnerInternals;
    runner.reviews = {
      maybeReview: async () => {
        order.push("review.completed");
      }
    };
    runner.transactions = {
      settleBudgetsAfterReceipt: async () => {
        order.push("budgets.settled");
      }
    };

    const session = runtimeSessionFixture();
    session.services.profile = {
      profile: { mutationPolicy: { reviewMode: "advisory" } }
    } as RuntimeSession["services"]["profile"];
    const modelTurn = { turnId: 1, effectRevision: session.durable.state.revision };
    session.durable.state.pendingTools = [{
      request: {
        callId: "finalize",
        name: "runtime_finalize",
        arguments: { summary: "done" }
      },
      modelTurn,
      approval: "not_required",
      started: true,
      origin: "runtime"
    }];
    const receipt: ToolReceipt = {
      callId: "finalize",
      ok: true,
      output: JSON.stringify({ summary: "done" }),
      observedEffects: ["outcome.propose"],
      artifacts: [],
      diagnostics: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z"
    };

    await runner.emitReceipt(session, receipt, modelTurn);

    expect(order).toEqual([
      "review.completed",
      "tool.completed",
      "hook:post_tool",
      "budgets.settled"
    ]);
  });
});
