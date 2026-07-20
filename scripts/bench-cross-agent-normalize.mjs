#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pairedRunCohortScheduleSha256,
  pairedRunTaskIdentity,
  pairedRunTaskIdentitySha256,
  pairedRunTaskKey,
  pairedRunTaskSetSnapshot,
  repositorySourceIdentity
} from "./bench-common.mjs";

const PLAN_KIND = "sigma.benchmark-paired-run-plan";
const INSTALLED_SUBJECT_KIND = "sigma.benchmark-installed-agent-subject";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;

function validArmSourcePin(arm) {
  if (arm?.sourceProvenanceKind === "installed-adapter") {
    return arm.executionSubjectKind === "installed-agent"
      && SHA256_PATTERN.test(String(arm.installedAdapterSha256 ?? ""));
  }
  return REVISION_PATTERN.test(String(arm?.sourceRevision ?? ""))
    && typeof arm?.sourceDirty === "boolean"
    && SHA256_PATTERN.test(String(arm?.sourceDiffSha256 ?? ""));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function installedAgentSubjectAttestation(agent, version) {
  if (typeof agent !== "string" || !agent || typeof version !== "string" || !version) {
    throw new Error("Installed-agent subject attestation requires non-empty agent and version values.");
  }
  return `${JSON.stringify({
    schemaVersion: 1,
    kind: INSTALLED_SUBJECT_KIND,
    agent,
    version
  })}\n`;
}

async function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  const output = [];
  const pending = [path.resolve(directory)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) output.push(target);
    }
  }
  return output.sort();
}

function planControls(plan) {
  return plan?.controls ?? {};
}

function validatePlan(plan, expectedPlanSha256, observedPlanSha256, arm) {
  const controls = planControls(plan);
  const selectedArm = plan?.arms?.[arm];
  const taskSet = pairedRunTaskSetSnapshot(plan?.tasks);
  const schedule = controls.cohortSchedule;
  if (plan?.kind !== PLAN_KIND || plan?.schemaVersion !== 1 || !taskSet.valid
    || !Array.isArray(plan?.tasks) || plan.tasks.some((task) => !pairedRunTaskIdentity(task))
    || plan.taskCount !== taskSet.taskCount || !["baseline", "candidate"].includes(arm)
    || !selectedArm || typeof selectedArm.agent !== "string" || !selectedArm.agent
    || !validArmSourcePin(selectedArm)
    || !["archive", "installed-agent"].includes(selectedArm.executionSubjectKind)
    || !SHA256_PATTERN.test(String(selectedArm.executionSubjectSha256 ?? ""))
    || typeof controls.model !== "string" || !controls.model
    || !REVISION_PATTERN.test(String(controls.taskRevision ?? ""))
    || !["none", "loopback", "full"].includes(controls.networkMode)
    || !Number.isSafeInteger(controls.concurrency) || controls.concurrency <= 0
    || controls.attemptsPerArm !== 1 || controls.retries !== 0
    || !Array.isArray(schedule) || schedule.length === 0
    || pairedRunCohortScheduleSha256(schedule) !== controls.cohortScheduleSha256
    || expectedPlanSha256 !== observedPlanSha256) {
    throw new Error("Cross-agent normalization requires a complete externally pinned paired-run plan.");
  }
  const scheduled = schedule.flatMap((cohort, index) => {
    if (cohort?.order !== index || !Number.isFinite(Number(cohort.effective_solver_timeout_sec))
      || Number(cohort.effective_solver_timeout_sec) <= 0 || !Array.isArray(cohort.task_keys)) {
      throw new Error("Paired-run cohort schedule is incomplete or out of order.");
    }
    return cohort.task_keys;
  });
  if (new Set(scheduled).size !== scheduled.length
    || JSON.stringify([...scheduled].sort()) !== JSON.stringify(taskSet.taskKeys)) {
    throw new Error("Paired-run cohort schedule does not cover the frozen task set exactly once.");
  }
  return { controls, selectedArm, taskSet, schedule };
}

function installedSubjectAttestation(bytes) {
  let record;
  try {
    record = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (record?.kind !== INSTALLED_SUBJECT_KIND) return null;
  if (record?.schemaVersion !== 1 || typeof record.agent !== "string" || !record.agent
    || typeof record.version !== "string" || !record.version) {
    throw new Error("Installed-agent subject attestation must use the strict canonical schema.");
  }
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["agent", "kind", "schemaVersion", "version"])
    || bytes.toString("utf8") !== installedAgentSubjectAttestation(record.agent, record.version)) {
    throw new Error("Installed-agent subject attestation must use the strict canonical schema.");
  }
  return { kind: "installed-agent", agent: record.agent, version: record.version };
}

function configAgent(record) {
  return Array.isArray(record?.agents) && record.agents.length === 1 ? record.agents[0] : null;
}

function agentModel(agent) {
  const model = agent?.model_name ?? agent?.kwargs?.model;
  const provider = agent?.kwargs?.provider;
  if (typeof model !== "string" || !model) return null;
  return model.includes("/") || !provider ? model : `${provider}/${model}`;
}

function agentVersion(agent) {
  return agent?.kwargs?.version ?? agent?.version ?? null;
}

function effectiveNetwork(record, agent) {
  const value = agent?.kwargs?.network_mode ?? agent?.network_mode
    ?? record?.environment?.network_mode ?? record?.network_mode;
  if (value === "public") return "full";
  if (value === "no-network") return "none";
  return ["none", "loopback", "full"].includes(value) ? value : null;
}

function taskEvidence(record) {
  const taskId = record?.task_id ?? {};
  const configured = record?.config?.task ?? {};
  return {
    pairing_key: record?.pairing_key ?? record?.pairingKey,
    git_url: record?.git_url ?? record?.gitUrl ?? taskId?.git_url ?? configured?.git_url,
    source: record?.source ?? taskId?.source ?? configured?.source,
    path: record?.path ?? taskId?.path ?? configured?.path,
    git_commit_id: record?.git_commit_id ?? record?.gitCommitId
      ?? taskId?.git_commit_id ?? configured?.git_commit_id
  };
}

function plannedTaskMatch(record, planTasks) {
  const evidence = taskEvidence(record);
  const matches = planTasks.filter((planned) => {
    const pairingKey = pairedRunTaskKey(planned);
    const observed = pairedRunTaskIdentitySha256({
      ...evidence,
      pairing_key: pairingKey,
      task_identity_sha256: undefined
    });
    return observed !== null && observed === pairedRunTaskIdentitySha256(planned);
  });
  return matches.length === 1 ? matches[0] : null;
}

function exactTaskSet(records, planTasks) {
  const matches = records.map((record) => plannedTaskMatch(record, planTasks));
  if (matches.some((match) => !match)) return null;
  const keys = matches.map(pairedRunTaskKey).sort();
  return new Set(keys).size === keys.length ? keys : null;
}

function expectedTaskKeys(cohort) {
  return [...cohort.task_keys].sort();
}

function explicitDeadline(agent, subjectKind) {
  const value = subjectKind === "installed-agent"
    ? agent?.override_timeout_sec : agent?.kwargs?.max_wall_time_sec;
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) && number > 0
    ? number : null;
}

function resolvedNetwork(value) {
  if (value === "public" || value === "full") return "full";
  if (value === "no-network" || value === "none") return "none";
  return value === "loopback" ? "loopback" : null;
}

function validateResolvedTaskAttestation(record, configSha256, cohort, plan) {
  const issues = [];
  const tasks = Array.isArray(record?.tasks) ? record.tasks : [];
  const taskRecords = tasks.map((task) => task?.task_identity);
  const taskKeys = exactTaskSet(taskRecords, plan.tasks);
  if (record?.kind !== "sigma.harbor-resolved-task-attestation" || record?.schemaVersion !== 1) {
    issues.push("resolved_task_attestation_invalid");
  }
  if (record?.job_config_sha256 !== configSha256) issues.push("resolved_task_config_digest_mismatch");
  if (!taskKeys || JSON.stringify(taskKeys) !== JSON.stringify(expectedTaskKeys(cohort))) {
    issues.push("resolved_task_identity_mismatch");
  }
  for (const task of tasks) {
    if (!SHA256_PATTERN.test(String(task?.task_config_sha256 ?? ""))) {
      issues.push("resolved_task_config_missing");
    }
    const network = resolvedNetwork(task?.effective_agent_network_mode);
    if (network === null) issues.push("resolved_network_missing");
    else if (network !== planControls(plan).networkMode) issues.push("resolved_network_mismatch");
    const timeout = Number(task?.agent_timeout_sec);
    if (!Number.isFinite(timeout) || timeout <= 0) issues.push("resolved_timeout_missing");
    else if (timeout !== Number(cohort.effective_solver_timeout_sec)) {
      issues.push("resolved_timeout_mismatch");
    }
  }
  return issues;
}

function configuredSubject(agent) {
  const archivePath = agent?.kwargs?.agent_cli_tarball ?? agent?.kwargs?.archive_path;
  if (typeof archivePath === "string" && archivePath.trim().length > 0) {
    try {
      return { kind: "archive", path: realpathSync(path.resolve(archivePath)) };
    } catch {
      return null;
    }
  }
  const version = agentVersion(agent);
  if (typeof agent?.name === "string" && agent.name && typeof version === "string" && version) {
    return { kind: "installed-agent", agent: agent.name, version };
  }
  return null;
}

function validateSubject(agent, subject) {
  const configured = configuredSubject(agent);
  if (!configured) return "execution_subject_missing";
  if (configured.kind !== subject.kind) return "execution_subject_mismatch";
  if (configured.kind === "archive") {
    return configured.path === subject.path ? null : "execution_subject_mismatch";
  }
  return configured.agent === subject.agent && configured.version === subject.version
    ? null : "execution_subject_mismatch";
}

function validateConfig(record, cohort, plan, armRecord, subject, resolvedTasks) {
  const controls = planControls(plan);
  const agent = configAgent(record);
  const expectedAgentName = armRecord.configAgentName ?? armRecord.agent;
  const tasks = Array.isArray(record?.tasks) ? record.tasks : [];
  const taskKeys = exactTaskSet(tasks, plan.tasks);
  const issues = [];
  if (record?.n_attempts !== 1) issues.push("attempts_not_one");
  if (record?.retry?.max_retries !== 0) issues.push("retries_not_zero");
  if (record?.timeout_multiplier !== 1) issues.push("timeout_multiplier_not_one");
  if (record?.n_concurrent_trials !== controls.concurrency) issues.push("concurrency_mismatch");
  if (!agent || agent.name !== expectedAgentName) issues.push("agent_identity_mismatch");
  if (agentModel(agent) !== controls.model) issues.push("model_mismatch");
  if (subject.kind === "archive") {
    const network = effectiveNetwork(record, agent);
    if (network === null) issues.push("network_missing");
    else if (network !== controls.networkMode) issues.push("network_mismatch");
  }
  if (armRecord.version !== undefined && agentVersion(agent) !== armRecord.version) {
    issues.push("version_mismatch");
  }
  if (!taskKeys || JSON.stringify(taskKeys) !== JSON.stringify(expectedTaskKeys(cohort))) {
    issues.push("cohort_membership_mismatch");
  }
  if (tasks.some((task) => taskEvidence(task).git_commit_id !== controls.taskRevision)) {
    issues.push("task_revision_mismatch");
  }
  const deadline = explicitDeadline(agent, subject.kind);
  if (deadline === null) issues.push("solver_timeout_missing");
  else if (deadline !== Number(cohort.effective_solver_timeout_sec)) issues.push("solver_timeout_mismatch");
  const subjectIssue = validateSubject(agent, subject);
  if (subjectIssue) issues.push(subjectIssue);
  issues.push(...resolvedTasks);
  return issues;
}

function lockCohort(lock, schedule, planTasks) {
  if (!Array.isArray(lock?.trials)) return null;
  const taskKeys = exactTaskSet(lock.trials.map((trial) => trial?.task), planTasks);
  if (!taskKeys) return null;
  return schedule.find((cohort) =>
    JSON.stringify(expectedTaskKeys(cohort)) === JSON.stringify(taskKeys)) ?? null;
}

function validateLock(lock, cohort, plan, armRecord, subject) {
  const controls = planControls(plan);
  const issues = [];
  if (lock?.retry?.max_retries !== 0) issues.push("lock_retries_not_zero");
  if (lock?.n_concurrent_trials !== controls.concurrency) issues.push("lock_concurrency_mismatch");
  if (!Array.isArray(lock?.trials) || lock.trials.length !== cohort.task_keys.length) {
    issues.push("lock_trial_count_mismatch");
    return issues;
  }
  const expectedAgentName = armRecord.configAgentName ?? armRecord.agent;
  for (const trial of lock.trials) {
    const agent = trial?.agent;
    if (trial?.timeout_multiplier !== 1) issues.push("lock_timeout_multiplier_not_one");
    if (agent?.name !== expectedAgentName) issues.push("lock_agent_identity_mismatch");
    if (agentModel(agent) !== controls.model) issues.push("lock_model_mismatch");
    if (subject.kind === "archive") {
      const network = effectiveNetwork({}, agent);
      if (network === null) issues.push("lock_network_missing");
      else if (network !== controls.networkMode) issues.push("lock_network_mismatch");
    }
    if (armRecord.version !== undefined && agentVersion(agent) !== armRecord.version) {
      issues.push("lock_version_mismatch");
    }
    const deadline = explicitDeadline(agent, subject.kind);
    if (deadline === null) issues.push("lock_solver_timeout_missing");
    else if (deadline !== Number(cohort.effective_solver_timeout_sec)) {
      issues.push("lock_solver_timeout_mismatch");
    }
    const subjectIssue = validateSubject(agent, subject);
    if (subjectIssue) issues.push(`lock_${subjectIssue}`);
  }
  return issues;
}

function pairedKeyForResult(result, planTasks) {
  const match = plannedTaskMatch(result, planTasks);
  return match ? {
    pairingKey: pairedRunTaskKey(match),
    taskIdentitySha256: pairedRunTaskIdentitySha256(match)
  } : null;
}

function resultClass(result) {
  const metadata = result?.agent_result?.metadata ?? {};
  const terminationSource = metadata.termination_source ?? metadata.terminationSource;
  if (terminationSource === "manual_stop" || Number(metadata.manual_stop_count) > 0) {
    return "manual_stop";
  }
  const agentOutcome = metadata.agent_outcome ?? metadata.agentOutcome
    ?? metadata.status ?? result?.agent_outcome;
  const failureKind = metadata.failure_kind ?? metadata.failureKind;
  if (["blocked", "needs_input"].includes(agentOutcome) || failureKind === "needs_input") {
    return "structured_blocker";
  }
  const reward = Number(result?.verifier_result?.rewards?.reward);
  if (Number.isFinite(reward)) return reward >= 1 ? "verifier_passed" : "verifier_failed";
  if (result?.exception_info) return "infrastructure_failure";
  return "unknown";
}

function isTrialResult(record) {
  return typeof record?.trial_name === "string" && typeof record?.task_name === "string"
    && (record.verifier_result !== undefined || record.exception_info !== undefined);
}

function parseTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export async function normalizeCrossAgentRun(options) {
  const planPath = path.resolve(options.planPath);
  const planBytes = await readFile(planPath);
  const observedPlanSha256 = sha256(planBytes);
  const plan = JSON.parse(planBytes.toString("utf8"));
  const { controls, selectedArm, taskSet, schedule } = validatePlan(
    plan, options.expectedPlanSha256, observedPlanSha256, options.arm
  );
  let sourceIdentity = null;
  let installedAdapterSha256 = null;
  if (selectedArm.sourceProvenanceKind === "installed-adapter") {
    const adapterPath = realpathSync(path.resolve(options.adapterPath));
    if (!(await stat(adapterPath)).isFile()) throw new Error("Installed adapter must be a regular file.");
    installedAdapterSha256 = sha256(await readFile(adapterPath));
    if (installedAdapterSha256 !== selectedArm.installedAdapterSha256) {
      throw new Error("Observed installed adapter does not match the frozen SHA-256.");
    }
  } else {
    sourceIdentity = repositorySourceIdentity(path.resolve(options.sourceRoot));
    if (sourceIdentity.revision !== selectedArm.sourceRevision
      || sourceIdentity.dirty !== selectedArm.sourceDirty
      || sourceIdentity.dirtyDiffSha256 !== selectedArm.sourceDiffSha256) {
      throw new Error("Observed source revision, dirty state, or source-diff digest does not match the arm pin.");
    }
  }
  const archivePath = realpathSync(path.resolve(options.archivePath));
  if (!(await stat(archivePath)).isFile()) throw new Error("Arm archive must be a regular file.");
  const archiveBytes = await readFile(archivePath);
  const archiveSha256 = sha256(archiveBytes);
  if (archiveSha256 !== selectedArm.executionSubjectSha256) {
    throw new Error("Observed execution subject does not match the frozen SHA-256.");
  }
  const subject = installedSubjectAttestation(archiveBytes)
    ?? { kind: "archive", path: archivePath };
  if (subject.kind !== selectedArm.executionSubjectKind) {
    throw new Error("Observed execution subject kind does not match the frozen arm identity.");
  }
  if (subject.kind === "installed-agent"
    && (subject.agent !== (selectedArm.configAgentName ?? selectedArm.agent)
      || subject.version !== selectedArm.version)) {
    throw new Error("Installed-agent subject attestation does not match the frozen arm identity.");
  }
  const configPaths = options.configPaths.map((value) => path.resolve(value));
  const resolvedTaskPaths = (Array.isArray(options.resolvedTaskPaths)
    ? options.resolvedTaskPaths : []).map((value) => path.resolve(value));
  if (configPaths.length !== schedule.length || resolvedTaskPaths.length !== schedule.length) {
    throw new Error(
      "Exactly one ordered JobConfig and resolved-task attestation are required for every frozen cohort."
    );
  }
  const issues = [];
  const inputConfigSha256s = [];
  const resolvedTaskAttestationSha256s = [];
  for (let index = 0; index < configPaths.length; index += 1) {
    const bytes = await readFile(configPaths[index]);
    const configSha256 = sha256(bytes);
    inputConfigSha256s.push({ order: index, sha256: configSha256 });
    const resolvedBytes = await readFile(resolvedTaskPaths[index]);
    resolvedTaskAttestationSha256s.push({ order: index, sha256: sha256(resolvedBytes) });
    const resolvedIssues = validateResolvedTaskAttestation(
      JSON.parse(resolvedBytes.toString("utf8")), configSha256, schedule[index], plan
    );
    issues.push(...validateConfig(
      JSON.parse(bytes.toString("utf8")), schedule[index], plan, selectedArm, subject,
      resolvedIssues
    ));
  }

  const lockRecords = [];
  const trialResults = [];
  if (options.phase === "result") {
    const files = (await Promise.all(options.jobsDirs.map(jsonFiles))).flat();
    for (const filePath of [...new Set(files)]) {
      const bytes = await readFile(filePath);
      const record = JSON.parse(bytes.toString("utf8"));
      if (path.basename(filePath) === "lock.json" && Array.isArray(record?.trials)) {
        lockRecords.push({ bytes, record });
      } else if (path.basename(filePath) === "result.json" && isTrialResult(record)) {
        trialResults.push(record);
      }
    }
    if (lockRecords.length !== schedule.length) issues.push("lock_count_mismatch");
    const matchedLocks = lockRecords.map(({ bytes, record }) => ({
      bytes,
      record,
      cohort: lockCohort(record, schedule, plan.tasks),
      createdAt: parseTimestamp(record?.created_at)
    }));
    if (matchedLocks.some((item) => !item.cohort)) issues.push("lock_cohort_membership_mismatch");
    for (const item of matchedLocks) {
      if (item.cohort) {
        issues.push(...validateLock(item.record, item.cohort, plan, selectedArm, subject));
      }
    }
    const orderedLocks = [...matchedLocks].sort((left, right) =>
      (left.createdAt ?? Number.POSITIVE_INFINITY) - (right.createdAt ?? Number.POSITIVE_INFINITY));
    if (orderedLocks.some((item) => item.createdAt === null)
      || orderedLocks.some((item, index) => item.cohort?.order !== index)) {
      issues.push("lock_cohort_order_mismatch");
    }
  }
  const lockSha256s = lockRecords.map(({ bytes }) => sha256(bytes)).sort();
  const trials = [];
  if (options.phase === "result") {
    for (const result of trialResults) {
      const identity = pairedKeyForResult(result, plan.tasks);
      if (!identity) {
        issues.push("trial_task_identity_mismatch");
        continue;
      }
      trials.push({
        pairing_key: identity.pairingKey,
        task_identity_sha256: identity.taskIdentitySha256,
        paired_outcome: resultClass(result)
      });
    }
    const outcomeSet = pairedRunTaskSetSnapshot(trials);
    if (!outcomeSet.valid || outcomeSet.taskSetSha256 !== taskSet.taskSetSha256
      || trials.length !== plan.taskCount) issues.push("trial_task_set_mismatch");
  }
  const uniqueIssues = [...new Set(issues)].sort();
  const attestation = {
    schemaVersion: 1,
    phase: options.phase,
    valid: uniqueIssues.length === 0,
    executionSubjectSha256: archiveSha256,
    executionSubjectKind: subject.kind,
    configSha256s: inputConfigSha256s,
    resolvedTaskAttestationSha256s,
    lockSha256s,
    issues: uniqueIssues
  };
  return {
    schemaVersion: 1,
    kind: "sigma.benchmark-cross-agent-arm",
    agent: selectedArm.agent,
    ...(selectedArm.version === undefined ? {} : { version: selectedArm.version }),
    source_provenance_kind: selectedArm.sourceProvenanceKind ?? "git-worktree",
    source_revision: sourceIdentity?.revision ?? null,
    source_dirty: sourceIdentity?.dirty ?? null,
    source_diff_sha256: sourceIdentity?.dirtyDiffSha256 ?? null,
    ...(installedAdapterSha256 ? { installed_adapter_sha256: installedAdapterSha256 } : {}),
    executionSubjectSha256: archiveSha256,
    executionSubjectKind: subject.kind,
    ...(subject.kind === "archive" ? { archiveSha256 } : {}),
    preregistration_sha256: observedPlanSha256,
    paired_run_controls: {
      agent: selectedArm.agent,
      ...(selectedArm.version === undefined ? {} : { version: selectedArm.version }),
      source_provenance_kind: selectedArm.sourceProvenanceKind ?? "git-worktree",
      source_revision: sourceIdentity?.revision ?? null,
      source_dirty: sourceIdentity?.dirty ?? null,
      source_diff_sha256: sourceIdentity?.dirtyDiffSha256 ?? null,
      ...(installedAdapterSha256 ? { installed_adapter_sha256: installedAdapterSha256 } : {}),
      execution_subject_sha256: archiveSha256,
      execution_subject_kind: subject.kind,
      ...(subject.kind === "archive" ? { archiveSha256 } : {}),
      model_identity: controls.model,
      terminal_bench_revision: controls.taskRevision,
      network_mode: controls.networkMode,
      n_concurrent_trials: controls.concurrency,
      attempts_per_arm: controls.attemptsPerArm,
      retries: controls.retries,
      preregistration_sha256: observedPlanSha256,
      tasks: plan.tasks,
      cohort_schedule: schedule,
      cohort_schedule_sha256: controls.cohortScheduleSha256,
      input_config_sha256s: inputConfigSha256s,
      resolved_task_attestation_sha256s: resolvedTaskAttestationSha256s,
      lock_sha256s: lockSha256s
    },
    run_input_attestation: attestation,
    ...(options.phase === "result" ? { trials } : {})
  };
}

function parseArgs(argv) {
  const values = { configPaths: [], resolvedTaskPaths: [], jobsDirs: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Every option requires a value.");
    if (key === "--config") values.configPaths.push(value);
    else if (key === "--resolved-task-attestation") values.resolvedTaskPaths.push(value);
    else if (key === "--jobs-dir") values.jobsDirs.push(value);
    else values[key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
  }
  for (const key of ["arm", "phase", "plan", "expectedPlanSha256", "archive", "output"]) {
    if (!values[key]) throw new Error(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required.`);
  }
  if (!["baseline", "candidate"].includes(values.arm)) throw new Error("--arm must be baseline or candidate.");
  if (!["preflight", "result"].includes(values.phase)) throw new Error("--phase must be preflight or result.");
  if (!SHA256_PATTERN.test(values.expectedPlanSha256)) {
    throw new Error("--expected-plan-sha256 must be a SHA-256 digest.");
  }
  if (values.configPaths.length === 0) throw new Error("At least one --config is required.");
  if (values.resolvedTaskPaths.length === 0) {
    throw new Error("At least one --resolved-task-attestation is required.");
  }
  if (!values.sourceRoot && !values.adapter) {
    throw new Error("Either --source-root or --adapter is required.");
  }
  if (values.phase === "result" && values.jobsDirs.length === 0) {
    throw new Error("Result normalization requires at least one --jobs-dir.");
  }
  return {
    arm: values.arm,
    phase: values.phase,
    planPath: values.plan,
    expectedPlanSha256: values.expectedPlanSha256,
    sourceRoot: values.sourceRoot,
    adapterPath: values.adapter,
    archivePath: values.archive,
    outputPath: values.output,
    configPaths: values.configPaths,
    resolvedTaskPaths: values.resolvedTaskPaths,
    jobsDirs: values.jobsDirs
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  const result = await normalizeCrossAgentRun(options);
  await writeFile(path.resolve(options.outputPath), `${JSON.stringify(result, null, 2)}\n`, {
    encoding: "utf8", flag: "wx"
  });
  process.stdout.write(`Cross-agent ${options.arm} ${options.phase} attestation: ${result.run_input_attestation.valid ? "valid" : "invalid"}\n`);
  if (!result.run_input_attestation.valid) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
