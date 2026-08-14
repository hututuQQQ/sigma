#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPairedExperiment } from "./bench-paired-preregistration.mjs";

function required(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
  return value.trim();
}

function cliOptions(argv) {
  const flags = {};
  const values = new Set([
    "preregistration-file", "expected-preregistration-sha256", "experiment-output", "output"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--allow-partial") {
      flags.allowPartial = true;
      continue;
    }
    if (!token.startsWith("--") || !values.has(token.slice(2))) {
      throw new Error(`Unsupported analysis option: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    flags[token.slice(2)] = value;
    index += 1;
  }
  return {
    preregistrationFile: path.resolve(required(flags["preregistration-file"], "--preregistration-file")),
    expectedSha256: required(flags["expected-preregistration-sha256"], "--expected-preregistration-sha256"),
    experimentOutput: path.resolve(required(flags["experiment-output"], "--experiment-output")),
    output: path.resolve(required(flags.output, "--output")),
    allowPartial: flags.allowPartial === true
  };
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.floor(probability * ordered.length)));
  return ordered[index];
}

function wilson(successes, total, z = 1.959963984540054) {
  if (total === 0) return { low: null, high: null };
  const rate = successes / total;
  const denominator = 1 + z * z / total;
  const center = (rate + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function binomialCoefficient(n, k) {
  let value = 1;
  for (let index = 1; index <= Math.min(k, n - k); index += 1) {
    value = value * (n - index + 1) / index;
  }
  return value;
}

function mcnemarExact(wins, losses) {
  const discordant = wins + losses;
  if (discordant === 0) return 1;
  const tail = Math.min(wins, losses);
  let probability = 0;
  for (let index = 0; index <= tail; index += 1) {
    probability += binomialCoefficient(discordant, index) / 2 ** discordant;
  }
  return Math.min(1, 2 * probability);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function semanticToolCategory(name) {
  const normalized = String(name ?? "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_");
  if (["exec", "shell"].includes(normalized)) return "command";
  if ([
    "read", "grep", "list", "repository_inspect", "repository_stats", "git_status", "git_diff",
    "web_run", "inspect_image"
  ].includes(normalized)) return "inspect";
  if (["edit", "write", "apply_patch"].includes(normalized)) return "edit";
  if (["update_plan", "request_strategy"].includes(normalized)) return "plan";
  if (normalized === "spawn_agent") return "delegate";
  if (["wait", "join_agent"].includes(normalized)) return "wait";
  return `other:${normalized || "unknown"}`;
}

function sigmaTrace(records) {
  let modelTurns = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let validationEvents = 0;
  const tools = {};
  const sequence = [];
  const signatures = [];
  for (const wrapper of records) {
    const event = wrapper?.sigma_event ?? wrapper ?? {};
    const type = wrapper?.type ?? event.type;
    const durableType = event.type ?? wrapper?.metadata?.event_type;
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const metadata = wrapper?.metadata && typeof wrapper.metadata === "object" ? wrapper.metadata : {};
    if (type === "model_end" || durableType === "model.completed") modelTurns += 1;
    if (type === "tool_start" || durableType === "tool.started") {
      toolCalls += 1;
      const name = String(metadata.toolName ?? payload.toolName ?? payload.name ?? "unknown");
      tools[name] = (tools[name] ?? 0) + 1;
      sequence.push(semanticToolCategory(name));
      signatures.push(`${name}\0${canonical(payload.args ?? payload.input ?? metadata.args ?? {})}`);
    }
    if ((type === "tool_end" || durableType === "tool.completed")
      && (metadata.error || payload.error || Number(payload.exitCode ?? metadata.exitCode ?? 0) !== 0)) {
      toolFailures += 1;
    }
    if (String(durableType ?? "").startsWith("validation.")) validationEvents += 1;
  }
  return traceSummary({ modelTurns, toolCalls, toolFailures, validationEvents, tools, sequence, signatures });
}

function atifTrace(trajectory) {
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
  let modelTurns = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  const tools = {};
  const sequence = [];
  const signatures = [];
  for (const step of steps) {
    if (step?.source === "agent") modelTurns += Number(step.llm_call_count ?? 1);
    const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : [];
    const results = Array.isArray(step?.observation?.results) ? step.observation.results : [];
    for (const call of calls) {
      toolCalls += 1;
      const name = String(call?.function_name ?? "unknown");
      tools[name] = (tools[name] ?? 0) + 1;
      sequence.push(semanticToolCategory(name));
      signatures.push(`${name}\0${canonical(call?.arguments ?? {})}`);
      const result = results.find((item) => item?.source_call_id === call?.tool_call_id);
      if (result?.is_error === true) toolFailures += 1;
    }
  }
  return traceSummary({
    modelTurns,
    toolCalls,
    toolFailures,
    validationEvents: 0,
    tools,
    sequence,
    signatures
  });
}

function traceSummary(input) {
  const counts = new Map();
  for (const signature of input.signatures) counts.set(signature, (counts.get(signature) ?? 0) + 1);
  return {
    model_turns: input.modelTurns,
    tool_calls: input.toolCalls,
    tool_failures: input.toolFailures,
    validation_events: input.validationEvents,
    repeated_tool_calls: [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    unique_tools: Object.keys(input.tools).length,
    tool_histogram: Object.fromEntries(Object.entries(input.tools).sort(([left], [right]) => left.localeCompare(right))),
    tool_sequence: input.sequence
  };
}

async function loadTrace(record, experimentOutput) {
  const evidence = record.trace?.evidence_path;
  if (!evidence) return { available: false };
  const filePath = path.resolve(experimentOutput, evidence);
  try {
    const text = await readFile(filePath, "utf8");
    if (record.trace.format === "atif-json" || path.extname(filePath) === ".json") {
      return { available: true, format: "atif-json", ...atifTrace(JSON.parse(text)) };
    }
    const records = text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    return { available: true, format: "sigma-jsonl", ...sigmaTrace(records) };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function sequenceDistance(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length] / Math.max(left.length, right.length);
}

async function attemptRecords(manifest, experimentOutput, allowPartial) {
  const records = [];
  const missing = [];
  for (const stage of manifest.execution.stages) {
    for (const pair of stage.pairs) {
      const label = `r${String(pair.repetition).padStart(2, "0")}-t${String(pair.task_index).padStart(3, "0")}`;
      for (const arm of pair.arms) {
        const filePath = path.join(
          experimentOutput, "receipts", stage.id, label, `${arm}.completed.json`
        );
        try {
          const record = await json(filePath);
          records.push({ ...record, trace_summary: await loadTrace(record, experimentOutput) });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          missing.push({ stage: stage.id, task_index: pair.task_index, repetition: pair.repetition, arm });
        }
      }
    }
  }
  if (missing.length > 0 && !allowPartial) {
    throw new Error(`Paired analysis is missing ${missing.length} preregistered attempts.`);
  }
  return { records, missing };
}

function armSummary(records, arm, repetitions) {
  const items = records.filter((record) => record.arm === arm);
  const valid = items.filter((record) => record.valid);
  const passes = valid.filter((record) => record.passed).length;
  const byTask = new Map();
  for (const item of valid) {
    const task = byTask.get(item.task_index) ?? [];
    task.push(item);
    byTask.set(item.task_index, task);
  }
  const completeTasks = [...byTask.values()].filter((itemsForTask) => itemsForTask.length === repetitions);
  const metrics = (name) => valid.map((record) => record.metrics?.[name]).filter(Number.isFinite);
  const traceMetrics = (name) => valid.map((record) => record.trace_summary?.[name]).filter(Number.isFinite);
  const cost = metrics("cost_usd");
  const totalCost = cost.length === valid.length && cost.length > 0
    ? cost.reduce((sum, value) => sum + value, 0) : null;
  return {
    attempts: items.length,
    valid_attempts: valid.length,
    passes,
    pass_rate: valid.length > 0 ? passes / valid.length : null,
    pass_rate_wilson_95: wilson(passes, valid.length),
    tasks_with_any_pass: completeTasks.filter((task) => task.some((item) => item.passed)).length,
    task_pass_at_least_once_rate: completeTasks.length > 0
      ? completeTasks.filter((task) => task.some((item) => item.passed)).length / completeTasks.length : null,
    failure_categories: Object.fromEntries([...new Set(items.map((item) => item.failure_category ?? "none"))]
      .sort().map((category) => [category, items.filter((item) => (item.failure_category ?? "none") === category).length])),
    efficiency: {
      duration_ms: distribution(metrics("duration_ms")),
      uncached_tokens: distribution(metrics("uncached_tokens")),
      input_tokens: distribution(metrics("input_tokens")),
      cache_read_tokens: distribution(metrics("cache_read_tokens")),
      output_tokens: distribution(metrics("output_tokens")),
      reasoning_tokens: distribution(metrics("reasoning_tokens")),
      commands_executed: distribution(metrics("commands_executed")),
      cost_usd: distribution(cost),
      total_cost_usd: totalCost,
      cost_per_pass_usd: totalCost !== null && passes > 0 ? totalCost / passes : null,
      uncached_tokens_per_pass: passes > 0
        ? metrics("uncached_tokens").reduce((sum, value) => sum + value, 0) / passes : null
    },
    trace: {
      available: items.filter((item) => item.trace_summary?.available).length,
      model_turns: distribution(traceMetrics("model_turns")),
      tool_calls: distribution(traceMetrics("tool_calls")),
      tool_failures: distribution(traceMetrics("tool_failures")),
      repeated_tool_calls: distribution(traceMetrics("repeated_tool_calls")),
      validation_events: distribution(traceMetrics("validation_events")),
      tool_histogram: aggregateHistogram(items.map((item) => item.trace_summary?.tool_histogram))
    }
  };
}

function distribution(values) {
  return {
    samples: values.length,
    mean: mean(values),
    median: median(values),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null
  };
}

function aggregateHistogram(histograms) {
  const result = {};
  for (const histogram of histograms) {
    for (const [key, value] of Object.entries(histogram ?? {})) {
      result[key] = (result[key] ?? 0) + Number(value ?? 0);
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([, left], [, right]) => right - left));
}

function pairedRows(records, arms) {
  const map = new Map();
  for (const record of records) {
    const key = `${record.task_index}\0${record.repetition}`;
    const pair = map.get(key) ?? { task_index: record.task_index, repetition: record.repetition };
    pair[record.arm] = record;
    map.set(key, pair);
  }
  return [...map.values()].filter((pair) => pair[arms[0]] && pair[arms[1]]);
}

export function bootstrapByTask(rows, accessor, seedText) {
  const taskIds = [...new Set(rows.map((row) => row.task_index))].sort((a, b) => a - b);
  if (taskIds.length === 0) return null;
  const byTask = new Map(taskIds.map((task) => [task, rows.filter((row) => row.task_index === task)]));
  let state = Number.parseInt(createHash("sha256").update(seedText).digest("hex").slice(0, 8), 16) >>> 0;
  const medians = [];
  for (let iteration = 0; iteration < 4_000; iteration += 1) {
    const values = [];
    for (let index = 0; index < taskIds.length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      const selected = taskIds[Math.floor((state / 0x1_0000_0000) * taskIds.length)];
      values.push(...byTask.get(selected).map(accessor).filter(Number.isFinite));
    }
    if (values.length > 0) medians.push(median(values));
  }
  return { low: quantile(medians, 0.025), high: quantile(medians, 0.975), samples: medians.length };
}

function pairedMetric(rows, reference, comparison, key, requireJointSuccess) {
  const selected = rows.filter((row) => {
    const left = row[reference];
    const right = row[comparison];
    return left.valid && right.valid
      && (!requireJointSuccess || (left.passed && right.passed))
      && Number.isFinite(left.metrics?.[key]) && Number.isFinite(right.metrics?.[key]);
  });
  const deltas = selected.map((row) => row[comparison].metrics[key] - row[reference].metrics[key]);
  const ratios = selected.flatMap((row) => {
    const before = row[reference].metrics[key];
    const after = row[comparison].metrics[key];
    return before === 0 ? after === 0 ? [1] : [] : [after / before];
  });
  return {
    pairs: selected.length,
    median_delta: median(deltas),
    mean_delta: mean(deltas),
    median_ratio: median(ratios),
    better: deltas.filter((value) => value < 0).length,
    tied: deltas.filter((value) => value === 0).length,
    worse: deltas.filter((value) => value > 0).length,
    cluster_bootstrap_median_delta_95: bootstrapByTask(
      selected,
      (row) => row[comparison].metrics[key] - row[reference].metrics[key],
      `${reference}:${comparison}:${key}:delta`
    ),
    cluster_bootstrap_median_ratio_95: bootstrapByTask(
      selected,
      (row) => {
        const before = row[reference].metrics[key];
        return before === 0 ? NaN : row[comparison].metrics[key] / before;
      },
      `${reference}:${comparison}:${key}:ratio`
    )
  };
}

function pairedTraceMetric(rows, reference, comparison, key) {
  const selected = rows.filter((row) => row[reference].trace_summary?.available
    && row[comparison].trace_summary?.available
    && Number.isFinite(row[reference].trace_summary[key])
    && Number.isFinite(row[comparison].trace_summary[key]));
  const deltas = selected.map((row) => row[comparison].trace_summary[key] - row[reference].trace_summary[key]);
  return {
    pairs: selected.length,
    median_delta: median(deltas),
    median_ratio: median(selected.flatMap((row) => {
      const before = row[reference].trace_summary[key];
      const after = row[comparison].trace_summary[key];
      return before === 0 ? after === 0 ? [1] : [] : [after / before];
    })),
    better: deltas.filter((value) => value < 0).length,
    tied: deltas.filter((value) => value === 0).length,
    worse: deltas.filter((value) => value > 0).length
  };
}

function pairedAnalysis(records, reference, comparison) {
  const rows = pairedRows(records, [reference, comparison]);
  let wins = 0;
  let losses = 0;
  for (const row of rows) {
    if (row[comparison].passed && !row[reference].passed) wins += 1;
    if (row[reference].passed && !row[comparison].passed) losses += 1;
  }
  const sequenceDistances = rows.flatMap((row) => {
    const left = row[reference].trace_summary;
    const right = row[comparison].trace_summary;
    return left?.available && right?.available
      ? [sequenceDistance(left.tool_sequence ?? [], right.tool_sequence ?? [])] : [];
  });
  const metrics = {};
  for (const key of [
    "duration_ms", "uncached_tokens", "input_tokens", "cache_read_tokens",
    "output_tokens", "reasoning_tokens", "commands_executed", "cost_usd"
  ]) {
    metrics[key] = {
      joint_valid: pairedMetric(rows, reference, comparison, key, false),
      joint_success: pairedMetric(rows, reference, comparison, key, true)
    };
  }
  const trace = {};
  for (const key of [
    "model_turns", "tool_calls", "tool_failures", "repeated_tool_calls", "validation_events"
  ]) trace[key] = pairedTraceMetric(rows, reference, comparison, key);
  return {
    complete_pairs: rows.length,
    correctness: {
      comparison_only_passes: wins,
      reference_only_passes: losses,
      ties: rows.length - wins - losses,
      mcnemar_exact_two_sided_p: rows.length > 0 ? mcnemarExact(wins, losses) : null
    },
    efficiency: metrics,
    trace: {
      ...trace,
      tool_sequence_normalized_edit_distance: distribution(sequenceDistances)
    },
    order_strata: {
      comparison_first: correctnessForRows(rows.filter((row) => row[comparison].order === 1), reference, comparison),
      reference_first: correctnessForRows(rows.filter((row) => row[reference].order === 1), reference, comparison)
    }
  };
}

function correctnessForRows(rows, reference, comparison) {
  let wins = 0;
  let losses = 0;
  for (const row of rows) {
    if (row[comparison].passed && !row[reference].passed) wins += 1;
    if (row[reference].passed && !row[comparison].passed) losses += 1;
  }
  return { pairs: rows.length, comparison_only_passes: wins, reference_only_passes: losses };
}

function formatPercent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function markdown(report) {
  const [reference, comparison] = report.arm_order;
  const left = report.arms[reference];
  const right = report.arms[comparison];
  const lines = [
    "# Paired Harness Experiment",
    "",
    `- Status: ${report.status}`,
    `- Experiment: ${report.experiment_id}`,
    `- Model: ${report.model.provider}/${report.model.name} (${report.model.reasoning_effort})`,
    `- Attempts observed: ${report.observed_attempts}/${report.expected_attempts}`,
    `- Complete pairs: ${report.paired.complete_pairs}`,
    "",
    "## Outcome and efficiency",
    "",
    `| metric | ${reference} | ${comparison} |`,
    "|---|---:|---:|",
    `| attempt pass rate | ${formatPercent(left.pass_rate)} | ${formatPercent(right.pass_rate)} |`,
    `| passed attempts | ${left.passes}/${left.valid_attempts} | ${right.passes}/${right.valid_attempts} |`,
    `| task pass at least once | ${formatPercent(left.task_pass_at_least_once_rate)} | ${formatPercent(right.task_pass_at_least_once_rate)} |`,
    `| median wall time (ms) | ${left.efficiency.duration_ms.median ?? "n/a"} | ${right.efficiency.duration_ms.median ?? "n/a"} |`,
    `| median uncached tokens | ${left.efficiency.uncached_tokens.median ?? "n/a"} | ${right.efficiency.uncached_tokens.median ?? "n/a"} |`,
    `| median model turns | ${left.trace.model_turns.median ?? "n/a"} | ${right.trace.model_turns.median ?? "n/a"} |`,
    `| median tool calls | ${left.trace.tool_calls.median ?? "n/a"} | ${right.trace.tool_calls.median ?? "n/a"} |`,
    "",
    "## Paired correctness",
    "",
    `- ${comparison}-only passes: ${report.paired.correctness.comparison_only_passes}`,
    `- ${reference}-only passes: ${report.paired.correctness.reference_only_passes}`,
    `- Exact McNemar p-value: ${report.paired.correctness.mcnemar_exact_two_sided_p ?? "n/a"}`,
    "",
    "## Paired efficiency (comparison / reference)",
    "",
    "| metric | joint-success pairs | median ratio | bootstrap 95% interval | better/tied/worse |",
    "|---|---:|---:|---:|---:|"
  ];
  for (const key of ["duration_ms", "uncached_tokens", "input_tokens", "output_tokens", "reasoning_tokens", "commands_executed"]) {
    const metric = report.paired.efficiency[key].joint_success;
    const interval = metric.cluster_bootstrap_median_ratio_95;
    lines.push(`| ${key} | ${metric.pairs} | ${metric.median_ratio ?? "n/a"} | ${interval ? `${interval.low}–${interval.high}` : "n/a"} | ${metric.better}/${metric.tied}/${metric.worse} |`);
  }
  lines.push(
    "",
    "## Trace coverage",
    "",
    `- ${reference}: ${left.trace.available}/${left.attempts}`,
    `- ${comparison}: ${right.trace.available}/${right.attempts}`,
    `- Median normalized semantic tool-category sequence distance: ${report.paired.trace.tool_sequence_normalized_edit_distance.median ?? "n/a"}`,
    "",
    "Ratios below 1 favor the comparison arm for cost-like metrics. Confidence intervals cluster-resample tasks, retaining all repetitions within each sampled task.",
    ""
  );
  return lines.join("\n");
}

export async function analyzePairedExperiment(input) {
  const bundle = await loadPairedExperiment(input.preregistrationFile, input.expectedSha256);
  const { manifest } = bundle;
  const { records, missing } = await attemptRecords(
    manifest, input.experimentOutput, input.allowPartial === true
  );
  const [reference, comparison] = manifest.arms.map((arm) => arm.id);
  return {
    schemaVersion: 1,
    kind: "PairedHarnessAnalysis",
    experiment_id: manifest.experiment_id,
    consumption_identity_sha256: manifest.consumption_identity_sha256,
    status: missing.length === 0 ? "complete" : "partial",
    model: manifest.model,
    task_selection: {
      dataset: manifest.task_catalog.dataset,
      sample_size: manifest.selection.sample_size,
      repetitions: manifest.execution.repetitions,
      selection_method: manifest.selection.method,
      selection_seed: manifest.selection.seed,
      selected_task_identity_sha256: manifest.selection.selected_task_identity_sha256
    },
    expected_attempts: manifest.execution.expected_attempts,
    observed_attempts: records.length,
    missing_attempts: missing,
    arm_order: [reference, comparison],
    arms: Object.fromEntries(manifest.arms.map((arm) => [
      arm.id, armSummary(records, arm.id, manifest.execution.repetitions)
    ])),
    paired: pairedAnalysis(records, reference, comparison)
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = cliOptions(process.argv.slice(2));
  analyzePairedExperiment(input).then(async (report) => {
    await mkdir(input.output, { recursive: true });
    await Promise.all([
      writeFile(path.join(input.output, "analysis.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
      writeFile(path.join(input.output, "analysis.md"), markdown(report), "utf8")
    ]);
    process.stdout.write(`${JSON.stringify({
      status: report.status,
      output: input.output,
      observed_attempts: report.observed_attempts,
      complete_pairs: report.paired.complete_pairs
    })}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
