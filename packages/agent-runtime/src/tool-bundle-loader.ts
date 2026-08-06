import type { ActiveModelTurn } from "agent-kernel";
import type { JsonValue, ModelToolCall, ToolReceipt } from "agent-protocol";
import { turnPayload } from "./effect-runner-helpers.js";
import type { EffectRunnerOptions } from "./effect-runner.js";
import type { HarnessToolBundleId } from "./harness-compiler.js";
import { failed } from "./tool-receipt.js";
import type { ToolReceiptRecorder } from "./tool-receipt-recorder.js";
import type { RuntimeSession } from "./types.js";

function bundleArguments(value: JsonValue): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.bundleId === "string") return [value.bundleId];
  if (!Array.isArray(value.bundleIds)
    || value.bundleIds.length === 0
    || !value.bundleIds.every((item): item is string => typeof item === "string")) {
    return undefined;
  }
  return [...new Set(value.bundleIds)];
}

function completed(call: ModelToolCall, startedAt: string, output: string): ToolReceipt {
  return {
    callId: call.id,
    ok: true,
    output,
    result: JSON.parse(output) as JsonValue,
    outcome: { status: "succeeded", output, diagnosticCodes: [] },
    observedEffects: ["runtime.control"],
    actualEffects: ["runtime.control"],
    artifacts: [],
    diagnostics: [],
    evidence: [],
    startedAt,
    completedAt: new Date().toISOString()
  };
}

export class ToolBundleLoader {
  constructor(
    private readonly options: Pick<EffectRunnerOptions, "emit">,
    private readonly receipts: ToolReceiptRecorder
  ) {}

  async execute(
    session: RuntimeSession,
    call: ModelToolCall,
    modelTurn: ActiveModelTurn
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.options.emit(session, "tool.requested", "runtime", {
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
      ...turnPayload(modelTurn)
    });
    const build = session.durable.frozenHarness;
    const bundleIds = bundleArguments(call.arguments);
    const requested = bundleIds?.map((bundleId) =>
      build?.toolPolicy.bundles.find((item) => item.id === bundleId));
    if (!build || !bundleIds || !requested || requested.some((bundle) => !bundle)) {
      await this.receipts.record(session, failed(
        call,
        startedAt,
        "Every requested tool bundle must be part of the frozen Harness build.",
        "tool_bundle_unavailable"
      ), modelTurn, call.name);
      return;
    }
    const loaded = new Set(session.durable.state.loadedToolBundles ?? []);
    const results = [];
    for (const [index, bundleId] of bundleIds.entries()) {
      const bundle = requested[index]!;
      const alreadyLoaded = loaded.has(bundleId);
      if (!alreadyLoaded) {
        await this.options.emit(session, "tool_bundle.loaded", "runtime", {
          bundleId: bundleId as HarnessToolBundleId,
          harnessDigest: build.digest,
          toolCount: bundle.tools.length
        });
        loaded.add(bundleId);
      }
      results.push({
        bundleId,
        status: alreadyLoaded ? "already_loaded" : "loaded",
        tools: bundle.tools
      });
    }
    const newlyLoaded = results.some((result) => result.status === "loaded");
    const output = JSON.stringify({
      status: newlyLoaded ? "loaded" : "already_loaded",
      ...(bundleIds.length === 1 ? { bundleId: bundleIds[0] } : {}),
      bundleIds,
      bundles: results,
      tools: [...new Set(results.flatMap((result) => [...result.tools]))].sort()
    });
    await this.receipts.record(
      session,
      completed(call, startedAt, output),
      modelTurn,
      call.name
    );
  }
}
