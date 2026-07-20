#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import {
  copyFile, mkdir, readFile, readdir, stat, writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentCliArchiveSourceIdentity,
  buildHarborJobConfig,
  computeHarborTimeoutPlan,
  harborPythonCommand,
  loadDotEnv,
  pairedRunCohortSchedule,
  pairedRunCohortScheduleSha256,
  pairedRunTaskIdentity,
  pairedRunTaskIdentitySha256,
  pairedRunTaskKey,
  parseHarborTimeoutProbe,
  portableAgentImportPath,
  repositorySourceIdentity,
  resolveHarborCommand,
  rootDir,
  runProcess
} from "./bench-common.mjs";
import {
  installedAgentSubjectAttestation,
  normalizeCrossAgentRun
} from "./bench-cross-agent-normalize.mjs";
import {
  benchmarkPlanFileSha256,
  evaluateCrossAgentBenchmarkPair,
  evaluateCrossAgentPreflight
} from "./bench-paired-gate.mjs";

const SPEC_KIND = "sigma.benchmark-cross-agent-prepare-spec";
const PLAN_KIND = "sigma.benchmark-paired-run-plan";
const MANIFEST_KIND = "sigma.benchmark-paired-preparation";
const SOURCE_KIND = "sigma.benchmark-source-attestation";
const SUBJECT_KIND = "sigma.benchmark-execution-subject-attestation";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{40}$/u;

function executionAlreadyStarted(message = "Prepared paired execution already started; retries are prohibited.") {
  return Object.assign(new Error(message), { code: "paired_execution_already_started" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeExclusive(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, typeof value === "string" ? value : prettyJson(value), {
    encoding: "utf8", flag: "wx", mode: 0o600
  });
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

function sameSourceIdentity(left, right) {
  return left?.revision === right?.revision && left?.dirty === right?.dirty
    && left?.dirtyDiffSha256 === right?.dirtyDiffSha256;
}

function normalizeNetwork(value) {
  if (value === "public" || value === "full") return "full";
  if (value === "no-network" || value === "none") return "none";
  return value === "loopback" ? "loopback" : null;
}

function assertStrictObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function validatePrepareSpec(spec) {
  const controls = assertStrictObject(spec?.controls, "prepare spec controls");
  const arms = assertStrictObject(spec?.arms, "prepare spec arms");
  const tasks = Array.isArray(spec?.tasks) ? spec.tasks : [];
  if (spec?.schemaVersion !== 1 || spec?.kind !== SPEC_KIND || tasks.length === 0) {
    throw new Error(`Prepare input must be a non-empty ${SPEC_KIND}.`);
  }
  if (typeof controls.model !== "string" || !controls.model.includes("/")) {
    throw new Error("Prepare controls.model must be a provider-qualified model identity.");
  }
  if (!REVISION_PATTERN.test(String(controls.taskRevision ?? ""))) {
    throw new Error("Prepare controls.taskRevision must be a full Git commit.");
  }
  if (!["none", "loopback", "full"].includes(controls.networkMode)
    || !Number.isSafeInteger(controls.concurrency) || controls.concurrency <= 0
    || controls.attemptsPerArm !== 1 || controls.retries !== 0) {
    throw new Error("Prepare controls must freeze network, positive concurrency, one attempt, and zero retries.");
  }
  if (JSON.stringify(spec.armOrder) !== JSON.stringify(["baseline", "candidate"])) {
    throw new Error("Prepare armOrder must be baseline followed by candidate.");
  }
  const identities = tasks.map((task) => pairedRunTaskIdentity(task));
  if (identities.some((identity) => !identity)
    || identities.some((identity) => identity.revision !== controls.taskRevision)
    || tasks.some((task) => typeof task.git_url !== "string" || !task.git_url)) {
    throw new Error("Every externally selected task needs complete source/path/repository/commit identity.");
  }
  const taskKeys = tasks.map(pairedRunTaskKey);
  if (new Set(taskKeys).size !== tasks.length) {
    throw new Error("Externally selected task identities must be unique.");
  }
  const baseline = assertStrictObject(arms.baseline, "baseline arm");
  const candidate = assertStrictObject(arms.candidate, "candidate arm");
  if (baseline.executionSubjectKind !== "installed-agent"
    || typeof baseline.agent !== "string" || !baseline.agent
    || typeof baseline.version !== "string" || !baseline.version
    || typeof baseline.adapterPath !== "string" || !baseline.adapterPath) {
    throw new Error("Baseline must declare an installed-agent name, version, and adapterPath.");
  }
  if (candidate.executionSubjectKind !== "archive"
    || typeof candidate.agent !== "string" || !candidate.agent
    || typeof candidate.sourceRoot !== "string" || !candidate.sourceRoot
    || typeof candidate.archivePath !== "string" || !candidate.archivePath) {
    throw new Error("Candidate must declare an archive, agent name, and sourceRoot.");
  }
  return { controls, arms: { baseline, candidate }, tasks };
}

function resolveExecutable(command) {
  const direct = path.resolve(command);
  if (existsSync(direct)) return realpathSync(direct);
  const lookup = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], {
    encoding: "utf8", windowsHide: true
  });
  const first = lookup.status === 0
    ? lookup.stdout.split(/\r?\n/u).map((item) => item.trim()).find(Boolean) : null;
  if (!first || !existsSync(first)) throw new Error(`Harbor executable could not be resolved: ${command}`);
  return realpathSync(first);
}

async function inspectHarbor(deps, outputDir) {
  if (deps.harborInspection) return await deps.harborInspection();
  const selected = resolveHarborCommand(process.env);
  const commandPath = resolveExecutable(selected.command);
  const versionResult = await (deps.runProcess ?? runProcess)(commandPath, ["--version"], {
    cwd: rootDir,
    env: process.env,
    stdoutPath: path.join(outputDir, "control", "harbor-version.stdout.log"),
    stderrPath: path.join(outputDir, "control", "harbor-version.stderr.log"),
    rawPath: path.join(outputDir, "control", "harbor-version.raw.log")
  });
  if (versionResult.exitCode !== 0) throw new Error("Harbor --version failed during preparation.");
  const helpResult = await (deps.runProcess ?? runProcess)(commandPath, ["run", "--help"], {
    cwd: rootDir,
    env: process.env,
    stdoutPath: path.join(outputDir, "control", "harbor-help.stdout.log"),
    stderrPath: path.join(outputDir, "control", "harbor-help.stderr.log"),
    rawPath: path.join(outputDir, "control", "harbor-help.raw.log")
  });
  if (helpResult.exitCode !== 0) throw new Error("Harbor run --help failed during preparation.");
  const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
  return {
    commandPath,
    commandSha256: await fileSha256(commandPath),
    version: `${versionResult.stdout}\n${versionResult.stderr}`.trim(),
    helpSha256: sha256(helpText),
    yesFlag: /--yes\b/u.test(helpText) ? "--yes" : null
  };
}

async function probeJobConfig(configPath, outputStem, deps) {
  if (deps.probeJobConfig) return await deps.probeJobConfig(configPath);
  const result = await (deps.runProcess ?? runProcess)(
    harborPythonCommand(process.env),
    [path.join(rootDir, "scripts", "probe-harbor-timeouts.py"), configPath],
    {
      cwd: rootDir,
      env: process.env,
      stdoutPath: `${outputStem}.stdout.log`,
      stderrPath: `${outputStem}.stderr.log`,
      rawPath: `${outputStem}.raw.log`
    }
  );
  if (result.exitCode !== 0) throw new Error(`Harbor task probe failed for ${path.basename(configPath)}.`);
  return parseHarborTimeoutProbe(result.stdout);
}

function installedArmConfig(arm, controls, tasks, jobsDir, timeout = null) {
  return {
    jobs_dir: jobsDir,
    n_attempts: 1,
    timeout_multiplier: 1,
    n_concurrent_trials: controls.concurrency,
    retry: { max_retries: 0 },
    agents: [{
      name: arm.configAgentName ?? arm.agent,
      model_name: controls.model,
      ...(timeout === null ? {} : { override_timeout_sec: timeout }),
      kwargs: { version: arm.version }
    }],
    tasks: tasks.map((task) => ({
      path: task.path,
      git_url: task.git_url,
      git_commit_id: task.git_commit_id,
      source: task.source
    }))
  };
}

function candidateArmConfig(arm, controls, tasks, jobsDir, archivePath, timeoutProbe) {
  const timeoutPlan = computeHarborTimeoutPlan({
    benchmarkClass: "standard",
    agentTimeoutGraceSec: Number.isSafeInteger(controls.cleanupGraceSec)
      ? controls.cleanupGraceSec : 120
  }, timeoutProbe);
  const [provider] = controls.model.split("/", 1);
  return buildHarborJobConfig({
    mode: "batch",
    tasks,
    provider,
    model: controls.model,
    agentProfile: arm.agentProfile ?? "standard",
    networkMode: controls.networkMode,
    executionMode: arm.executionMode ?? "sandboxed",
    managedProvenance: arm.managedProvenance === true,
    containerEngine: arm.containerEngine ?? "docker",
    nConcurrentTrials: controls.concurrency,
    attemptsPerArm: 1,
    retries: 0,
    maxTurns: arm.maxTurns ?? 200,
    commandTimeoutSec: arm.commandTimeoutSec ?? 180,
    agentCliTarball: archivePath,
    agentImportPath: arm.configAgentName ?? portableAgentImportPath
  }, jobsDir, timeoutPlan, timeoutProbe);
}

function validateSelectionProbe(probe, tasks, controls) {
  const records = Array.isArray(probe?.tasks) ? probe.tasks : [];
  if (records.length !== tasks.length) {
    throw new Error("Harbor resolved a different task count than the frozen external selection.");
  }
  return records.map((record, index) => {
    const expectedDigest = pairedRunTaskIdentitySha256(tasks[index]);
    const observedDigest = pairedRunTaskIdentitySha256(record?.task_identity);
    const timeout = Number(record?.agent_timeout_sec);
    const network = normalizeNetwork(record?.effective_agent_network_mode);
    if (!expectedDigest || observedDigest !== expectedDigest
      || !Number.isFinite(timeout) || timeout <= 0
      || network !== controls.networkMode
      || !SHA256_PATTERN.test(String(record?.task_config_sha256 ?? ""))) {
      throw new Error(`Resolved task control evidence is incomplete or drifted at index ${index}.`);
    }
    const controlled = {
      ...tasks[index],
      pairing_key: pairedRunTaskKey(tasks[index]),
      effective_solver_timeout_sec: timeout,
      network_mode_effective: network
    };
    return { ...controlled, task_identity_sha256: pairedRunTaskIdentitySha256(controlled) };
  });
}

function sourceAttestation(role, sourceRoot, identity) {
  return {
    schemaVersion: 1,
    kind: SOURCE_KIND,
    role,
    sourceRoot,
    revision: identity.revision,
    dirty: identity.dirty,
    dirtyDiffSha256: identity.dirtyDiffSha256
  };
}

function installedAdapterSourceAttestation(role, canonicalPath, adapterSha256, arm) {
  return {
    schemaVersion: 1,
    kind: SOURCE_KIND,
    role,
    sourceProvenanceKind: "installed-adapter",
    agent: arm.configAgentName ?? arm.agent,
    version: arm.version,
    canonicalPath,
    installedAdapterSha256: adapterSha256
  };
}

function subjectAttestation(role, kind, subjectSha256, relativePath, extra = {}) {
  return {
    schemaVersion: 1,
    kind: SUBJECT_KIND,
    role,
    executionSubjectKind: kind,
    executionSubjectSha256: subjectSha256,
    subjectPath: relativePath,
    ...extra
  };
}

function relativeArtifact(root, target) {
  const relative = path.relative(root, target).replaceAll("\\", "/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error("Prepared artifacts must remain inside the preparation directory.");
  }
  return relative;
}

async function artifactRecord(root, target) {
  return { path: relativeArtifact(root, target), sha256: await fileSha256(target) };
}

function planArm(arm, source, subjectKind, subjectSha256) {
  const sourceFields = source.sourceProvenanceKind === "installed-adapter"
    ? {
        sourceProvenanceKind: "installed-adapter",
        installedAdapterSha256: source.installedAdapterSha256
      }
    : {
        sourceRevision: source.revision,
        sourceDirty: source.dirty,
        sourceDiffSha256: source.dirtyDiffSha256
      };
  return {
    agent: arm.agent,
    ...(arm.version ? { version: arm.version } : {}),
    ...(arm.configAgentName ? { configAgentName: arm.configAgentName } : {}),
    ...sourceFields,
    executionSubjectKind: subjectKind,
    executionSubjectSha256: subjectSha256
  };
}

function sealManifest(payload) {
  return {
    ...payload,
    seal: { algorithm: "sha256", payloadSha256: sha256(canonical(payload)) }
  };
}

function verifyManifestSeal(manifest) {
  const { seal, ...payload } = manifest ?? {};
  if (seal?.algorithm !== "sha256" || !SHA256_PATTERN.test(String(seal.payloadSha256 ?? ""))
    || sha256(canonical(payload)) !== seal.payloadSha256) {
    throw new Error("Preparation manifest content seal is invalid.");
  }
}

export async function prepareCrossAgentPair(specInput, outputDirectory, deps = {}) {
  const specBytes = Buffer.isBuffer(specInput)
    ? specInput : typeof specInput === "string"
      ? await readFile(path.resolve(specInput)) : Buffer.from(prettyJson(specInput), "utf8");
  const spec = JSON.parse(specBytes.toString("utf8"));
  const { controls, arms, tasks } = validatePrepareSpec(spec);
  const outputDir = path.resolve(outputDirectory);
  await mkdir(path.dirname(outputDir), { recursive: true });
  await mkdir(outputDir, { recursive: false, mode: 0o700 });

  const baselineAdapterCanonicalPath = realpathSync(path.resolve(arms.baseline.adapterPath));
  if (!(await stat(baselineAdapterCanonicalPath)).isFile()) {
    throw new Error("Baseline installed adapter is not a regular file.");
  }
  const baselineAdapterSha256 = await fileSha256(baselineAdapterCanonicalPath);
  const baselineSource = {
    sourceProvenanceKind: "installed-adapter",
    installedAdapterSha256: baselineAdapterSha256
  };
  const candidateSourceRoot = realpathSync(path.resolve(arms.candidate.sourceRoot));
  const sourceIdentity = deps.repositorySourceIdentity ?? repositorySourceIdentity;
  const candidateSource = sourceIdentity(candidateSourceRoot);
  if (!REVISION_PATTERN.test(String(candidateSource?.revision ?? ""))
    || typeof candidateSource?.dirty !== "boolean"
    || !SHA256_PATTERN.test(String(candidateSource?.dirtyDiffSha256 ?? ""))) {
    throw new Error("Candidate source identity is incomplete.");
  }

  const harbor = await inspectHarbor(deps, outputDir);
  const harborCommandPath = realpathSync(path.resolve(harbor.commandPath));
  const observedHarborSha256 = await fileSha256(harborCommandPath);
  if (observedHarborSha256 !== harbor.commandSha256) {
    throw new Error("Harbor executable changed while preparation was in progress.");
  }

  const baselineDir = path.join(outputDir, "arms", "baseline");
  const candidateDir = path.join(outputDir, "arms", "candidate");
  const baselineAdapterPath = path.join(
    baselineDir, "installed-adapter", path.basename(baselineAdapterCanonicalPath)
  );
  await mkdir(path.dirname(baselineAdapterPath), { recursive: true });
  await copyFile(
    baselineAdapterCanonicalPath, baselineAdapterPath, fsConstants.COPYFILE_EXCL
  );
  if (await fileSha256(baselineAdapterPath) !== baselineAdapterSha256) {
    throw new Error("Baseline installed adapter changed while being copied.");
  }
  const baselineSubjectPath = path.join(baselineDir, "installed-agent-subject.json");
  await writeExclusive(
    baselineSubjectPath,
    installedAgentSubjectAttestation(arms.baseline.configAgentName ?? arms.baseline.agent, arms.baseline.version)
  );
  const baselineSubjectSha256 = await fileSha256(baselineSubjectPath);

  const candidateArchiveSource = realpathSync(path.resolve(arms.candidate.archivePath));
  if (!(await stat(candidateArchiveSource)).isFile()) throw new Error("Candidate archive is not a regular file.");
  const candidateArchivePath = path.join(candidateDir, path.basename(candidateArchiveSource));
  await mkdir(candidateDir, { recursive: true });
  await copyFile(candidateArchiveSource, candidateArchivePath, fsConstants.COPYFILE_EXCL);
  const candidateSubjectSha256 = await fileSha256(candidateArchivePath);
  const embeddedSource = (deps.agentCliArchiveSourceIdentity ?? agentCliArchiveSourceIdentity)(candidateArchivePath);
  if (embeddedSource && (embeddedSource.revision !== candidateSource.revision
    || embeddedSource.dirty !== candidateSource.dirty)) {
    throw new Error("Candidate archive source provenance does not match candidate sourceRoot.");
  }

  const baselineSourcePath = path.join(baselineDir, "source-attestation.json");
  const candidateSourcePath = path.join(candidateDir, "source-attestation.json");
  await writeExclusive(
    baselineSourcePath, installedAdapterSourceAttestation(
      "baseline", baselineAdapterCanonicalPath, baselineAdapterSha256, arms.baseline
    )
  );
  await writeExclusive(
    candidateSourcePath, sourceAttestation("candidate", candidateSourceRoot, candidateSource)
  );
  const baselineSubjectAttestationPath = path.join(baselineDir, "subject-attestation.json");
  const candidateSubjectAttestationPath = path.join(candidateDir, "subject-attestation.json");
  await writeExclusive(baselineSubjectAttestationPath, subjectAttestation(
    "baseline", "installed-agent", baselineSubjectSha256,
    relativeArtifact(outputDir, baselineSubjectPath),
    { agent: arms.baseline.configAgentName ?? arms.baseline.agent, version: arms.baseline.version }
  ));
  await writeExclusive(candidateSubjectAttestationPath, subjectAttestation(
    "candidate", "archive", candidateSubjectSha256,
    relativeArtifact(outputDir, candidateArchivePath)
  ));

  const selectionConfigPath = path.join(outputDir, "control", "task-selection-probe.config.json");
  await writeExclusive(selectionConfigPath, installedArmConfig(
    arms.baseline, controls, tasks,
    path.join(outputDir, "control", "task-selection-probe-jobs")
  ));
  const selectionProbe = await probeJobConfig(
    selectionConfigPath, path.join(outputDir, "control", "task-selection-probe"), deps
  );
  const selectionAttestationPath = path.join(outputDir, "control", "task-selection-attestation.json");
  await writeExclusive(selectionAttestationPath, selectionProbe);
  const controlledTasks = validateSelectionProbe(selectionProbe, tasks, controls);
  const cohortSchedule = pairedRunCohortSchedule(controlledTasks);
  const plan = {
    schemaVersion: 1,
    kind: PLAN_KIND,
    taskCount: controlledTasks.length,
    tasks: controlledTasks,
    controls: {
      model: controls.model,
      taskRevision: controls.taskRevision,
      networkMode: controls.networkMode,
      concurrency: controls.concurrency,
      attemptsPerArm: 1,
      retries: 0,
      cohortSchedule,
      cohortScheduleSha256: pairedRunCohortScheduleSha256(cohortSchedule)
    },
    arms: {
      baseline: planArm(arms.baseline, baselineSource, "installed-agent", baselineSubjectSha256),
      candidate: planArm(arms.candidate, candidateSource, "archive", candidateSubjectSha256)
    },
    armOrder: ["baseline", "candidate"]
  };
  const planPath = path.join(outputDir, "paired-run-plan.json");
  await writeExclusive(planPath, plan);
  const planSha256 = benchmarkPlanFileSha256(plan);
  if (await fileSha256(planPath) !== planSha256) throw new Error("Paired plan serialization is unstable.");

  const taskByKey = new Map(tasks.map((task) => [pairedRunTaskKey(task), task]));
  const probeByKey = new Map(controlledTasks.map((task, index) => [
    pairedRunTaskKey(task), selectionProbe.tasks[index]
  ]));
  const preparedArms = {};
  for (const role of ["baseline", "candidate"]) {
    const arm = arms[role];
    const armDir = role === "baseline" ? baselineDir : candidateDir;
    const configPaths = [];
    const resolvedTaskPaths = [];
    const cohorts = [];
    for (const cohort of cohortSchedule) {
      const cohortName = `cohort-${String(cohort.order).padStart(3, "0")}`;
      const cohortTasks = cohort.task_keys.map((key) => taskByKey.get(key));
      const cohortProbe = {
        tasks: cohort.task_keys.map((key) => probeByKey.get(key)),
        resolved_tasks: cohortTasks,
        max_agent_timeout_sec: cohort.effective_solver_timeout_sec
      };
      const jobsDir = path.join(armDir, "jobs", cohortName);
      const configPath = path.join(armDir, "configs", `${cohortName}.json`);
      const config = role === "baseline"
        ? installedArmConfig(
            arm, controls, cohortTasks, jobsDir, cohort.effective_solver_timeout_sec
          )
        : candidateArmConfig(
            arm, controls, cohortTasks, jobsDir, candidateArchivePath, cohortProbe
          );
      await writeExclusive(configPath, config);
      const resolved = await probeJobConfig(
        configPath, path.join(armDir, "probes", cohortName), deps
      );
      const resolvedPath = path.join(armDir, "resolved-tasks", `${cohortName}.json`);
      await writeExclusive(resolvedPath, resolved);
      configPaths.push(configPath);
      resolvedTaskPaths.push(resolvedPath);
      cohorts.push({
        order: cohort.order,
        effectiveSolverTimeoutSec: cohort.effective_solver_timeout_sec,
        config: await artifactRecord(outputDir, configPath),
        resolvedTaskAttestation: await artifactRecord(outputDir, resolvedPath),
        jobsDir: relativeArtifact(outputDir, jobsDir),
        harborArgs: ["run", "--config", configPath, ...(harbor.yesFlag ? [harbor.yesFlag] : [])]
      });
    }
    const normalized = await normalizeCrossAgentRun({
      arm: role,
      phase: "preflight",
      planPath,
      expectedPlanSha256: planSha256,
      ...(role === "baseline"
        ? { adapterPath: baselineAdapterCanonicalPath }
        : { sourceRoot: candidateSourceRoot }),
      archivePath: role === "baseline" ? baselineSubjectPath : candidateArchivePath,
      configPaths,
      resolvedTaskPaths,
      jobsDirs: []
    });
    if (!normalized.run_input_attestation.valid) {
      throw new Error(`${role} preflight normalization failed: ${normalized.run_input_attestation.issues.join(", ")}.`);
    }
    const normalizedPath = path.join(armDir, "preflight-normalized.json");
    await writeExclusive(normalizedPath, normalized);
    preparedArms[role] = {
      agent: arm.agent,
      sourceProvenanceKind: role === "baseline" ? "installed-adapter" : "git-worktree",
      ...(role === "baseline"
        ? {
            installedAdapterCanonicalPath: baselineAdapterCanonicalPath,
            installedAdapter: await artifactRecord(outputDir, baselineAdapterPath)
          }
        : { sourceRoot: candidateSourceRoot }),
      sourceAttestation: await artifactRecord(
        outputDir, role === "baseline" ? baselineSourcePath : candidateSourcePath
      ),
      subject: await artifactRecord(
        outputDir, role === "baseline" ? baselineSubjectPath : candidateArchivePath
      ),
      subjectAttestation: await artifactRecord(
        outputDir, role === "baseline"
          ? baselineSubjectAttestationPath : candidateSubjectAttestationPath
      ),
      normalizedPreflight: await artifactRecord(outputDir, normalizedPath),
      cohorts
    };
  }

  const baselineNormalized = JSON.parse(await readFile(
    path.join(baselineDir, "preflight-normalized.json"), "utf8"
  ));
  const candidateNormalized = JSON.parse(await readFile(
    path.join(candidateDir, "preflight-normalized.json"), "utf8"
  ));
  const gate = evaluateCrossAgentPreflight(
    baselineNormalized, candidateNormalized, plan, planSha256
  );
  if (!gate.comparable) {
    throw new Error(`Paired preflight rejected the prepared inputs: ${gate.mismatchReasons.join(", ")}.`);
  }
  const gatePath = path.join(outputDir, "paired-preflight.json");
  await writeExclusive(gatePath, gate);
  const manifestPayload = {
    schemaVersion: 1,
    kind: MANIFEST_KIND,
    status: "prepared",
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
    specSha256: sha256(specBytes),
    plan: await artifactRecord(outputDir, planPath),
    taskSelectionConfig: await artifactRecord(outputDir, selectionConfigPath),
    taskSelectionAttestation: await artifactRecord(outputDir, selectionAttestationPath),
    harbor: {
      commandPath: harborCommandPath,
      commandSha256: observedHarborSha256,
      version: harbor.version,
      helpSha256: harbor.helpSha256,
      yesFlag: harbor.yesFlag
    },
    armOrder: ["baseline", "candidate"],
    executionPolicy: {
      attemptsPerConfig: 1,
      retries: 0,
      continueAfterCohortFailure: true,
      resultNormalization: "after_all_arms"
    },
    arms: preparedArms,
    pairedPreflight: await artifactRecord(outputDir, gatePath)
  };
  const manifest = sealManifest(manifestPayload);
  const manifestPath = path.join(outputDir, "preparation-manifest.json");
  await writeExclusive(manifestPath, manifest);

  const currentCandidate = sourceIdentity(candidateSourceRoot);
  if (await fileSha256(baselineAdapterCanonicalPath) !== baselineAdapterSha256
    || !sameSourceIdentity(candidateSource, currentCandidate)) {
    throw new Error("An installed adapter or source tree changed during paired preparation.");
  }
  return { outputDir, manifestPath, manifestSha256: await fileSha256(manifestPath), manifest };
}

function resolvePreparedPath(root, record) {
  const relative = record?.path;
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)) {
    throw new Error("Preparation manifest contains an invalid artifact path.");
  }
  const target = path.resolve(root, relative);
  const within = path.relative(root, target);
  if (within.startsWith("..") || path.isAbsolute(within)) {
    throw new Error("Preparation manifest artifact escapes its preparation directory.");
  }
  return target;
}

async function verifyArtifact(root, record) {
  if (!SHA256_PATTERN.test(String(record?.sha256 ?? ""))) {
    throw new Error("Preparation manifest contains an invalid artifact digest.");
  }
  const target = resolvePreparedPath(root, record);
  if (await fileSha256(target) !== record.sha256) {
    throw new Error(`Prepared artifact digest mismatch: ${record.path}`);
  }
  return target;
}

async function containsRunEvidence(directory) {
  if (!existsSync(directory)) return false;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else if (entry.name === "lock.json" || entry.name === "result.json") return true;
    }
  }
  return false;
}

async function validatePreparedExecution(manifestPath, expectedManifestSha256) {
  if (!SHA256_PATTERN.test(String(expectedManifestSha256 ?? ""))) {
    throw new Error("execute-existing requires an externally pinned manifest SHA-256.");
  }
  const resolvedManifestPath = path.resolve(manifestPath);
  const bytes = await readFile(resolvedManifestPath);
  if (sha256(bytes) !== expectedManifestSha256) {
    throw new Error("Preparation manifest does not match the externally pinned SHA-256.");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  verifyManifestSeal(manifest);
  if (manifest.schemaVersion !== 1 || manifest.kind !== MANIFEST_KIND
    || manifest.status !== "prepared"
    || JSON.stringify(manifest.armOrder) !== JSON.stringify(["baseline", "candidate"])) {
    throw new Error("execute-existing requires a complete paired preparation manifest.");
  }
  const root = path.dirname(resolvedManifestPath);
  if (existsSync(path.join(root, "execution", "started.json"))) {
    throw executionAlreadyStarted();
  }
  const planPath = await verifyArtifact(root, manifest.plan);
  const gatePath = await verifyArtifact(root, manifest.pairedPreflight);
  await verifyArtifact(root, manifest.taskSelectionConfig);
  await verifyArtifact(root, manifest.taskSelectionAttestation);
  if (await fileSha256(realpathSync(manifest.harbor.commandPath)) !== manifest.harbor.commandSha256) {
    throw new Error("Prepared Harbor executable digest no longer matches.");
  }
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  if (benchmarkPlanFileSha256(plan) !== manifest.plan.sha256) {
    throw new Error("Prepared paired plan digest is invalid.");
  }
  const normalized = {};
  for (const role of manifest.armOrder) {
    const arm = manifest.arms?.[role];
    if (!arm || !Array.isArray(arm.cohorts) || arm.cohorts.length === 0) {
      throw new Error(`Prepared ${role} arm is incomplete.`);
    }
    const sourcePath = await verifyArtifact(root, arm.sourceAttestation);
    const subjectPath = await verifyArtifact(root, arm.subject);
    await verifyArtifact(root, arm.subjectAttestation);
    const normalizedPath = await verifyArtifact(root, arm.normalizedPreflight);
    const source = JSON.parse(await readFile(sourcePath, "utf8"));
    if (arm.sourceProvenanceKind === "installed-adapter") {
      const frozenAdapterPath = await verifyArtifact(root, arm.installedAdapter);
      const activeAdapterPath = realpathSync(arm.installedAdapterCanonicalPath);
      const activeDigest = await fileSha256(activeAdapterPath);
      if (source.kind !== SOURCE_KIND || source.role !== role
        || source.sourceProvenanceKind !== "installed-adapter"
        || source.canonicalPath !== activeAdapterPath
        || source.installedAdapterSha256 !== activeDigest
        || await fileSha256(frozenAdapterPath) !== activeDigest) {
        throw new Error(`Prepared ${role} installed adapter identity changed.`);
      }
    } else {
      const current = repositorySourceIdentity(realpathSync(arm.sourceRoot));
      if (source.kind !== SOURCE_KIND || source.role !== role
        || source.sourceRoot !== realpathSync(arm.sourceRoot)
        || !sameSourceIdentity({
          revision: source.revision,
          dirty: source.dirty,
          dirtyDiffSha256: source.dirtyDiffSha256
        }, current)) {
        throw new Error(`Prepared ${role} source identity changed.`);
      }
    }
    const configPaths = [];
    const resolvedTaskPaths = [];
    for (let index = 0; index < arm.cohorts.length; index += 1) {
      const cohort = arm.cohorts[index];
      if (cohort.order !== index) throw new Error(`${role} cohort order changed.`);
      configPaths.push(await verifyArtifact(root, cohort.config));
      resolvedTaskPaths.push(await verifyArtifact(root, cohort.resolvedTaskAttestation));
      const jobsDir = resolvePreparedPath(root, { path: cohort.jobsDir });
      if (await containsRunEvidence(jobsDir)) {
        throw executionAlreadyStarted(
          `${role} cohort already contains Harbor run evidence; retries are prohibited.`
        );
      }
    }
    normalized[role] = await normalizeCrossAgentRun({
      arm: role,
      phase: "preflight",
      planPath,
      expectedPlanSha256: manifest.plan.sha256,
      ...(arm.sourceProvenanceKind === "installed-adapter"
        ? { adapterPath: arm.installedAdapterCanonicalPath }
        : { sourceRoot: arm.sourceRoot }),
      archivePath: subjectPath,
      configPaths,
      resolvedTaskPaths,
      jobsDirs: []
    });
    const frozenNormalized = JSON.parse(await readFile(normalizedPath, "utf8"));
    if (canonical(normalized[role]) !== canonical(frozenNormalized)) {
      throw new Error(`${role} normalized preflight no longer matches the frozen record.`);
    }
  }
  const gate = evaluateCrossAgentPreflight(
    normalized.baseline, normalized.candidate, plan, manifest.plan.sha256
  );
  const frozenGate = JSON.parse(await readFile(gatePath, "utf8"));
  if (!gate.comparable || canonical(gate) !== canonical(frozenGate)) {
    throw new Error("Paired preflight is no longer comparable to the frozen gate.");
  }
  return { root, manifest, manifestSha256: expectedManifestSha256 };
}

async function writePostRunPairReport(prepared) {
  const planPath = resolvePreparedPath(prepared.root, prepared.manifest.plan);
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const normalized = {};
  const artifacts = {};
  for (const role of prepared.manifest.armOrder) {
    const arm = prepared.manifest.arms[role];
    const configPaths = arm.cohorts.map((cohort) =>
      resolvePreparedPath(prepared.root, cohort.config));
    const resolvedTaskPaths = arm.cohorts.map((cohort) =>
      resolvePreparedPath(prepared.root, cohort.resolvedTaskAttestation));
    const jobsDirs = arm.cohorts.map((cohort) =>
      resolvePreparedPath(prepared.root, { path: cohort.jobsDir }));
    normalized[role] = await normalizeCrossAgentRun({
      arm: role,
      phase: "result",
      planPath,
      expectedPlanSha256: prepared.manifest.plan.sha256,
      ...(arm.sourceProvenanceKind === "installed-adapter"
        ? { adapterPath: arm.installedAdapterCanonicalPath }
        : { sourceRoot: arm.sourceRoot }),
      archivePath: resolvePreparedPath(prepared.root, arm.subject),
      configPaths,
      resolvedTaskPaths,
      jobsDirs
    });
    const target = path.join(prepared.root, "execution", `${role}-result-normalized.json`);
    await writeExclusive(target, normalized[role]);
    artifacts[role] = await artifactRecord(prepared.root, target);
  }
  const report = evaluateCrossAgentBenchmarkPair(
    normalized.baseline,
    normalized.candidate,
    plan,
    prepared.manifest.plan.sha256
  );
  const serialized = prettyJson(report);
  if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
    throw new Error("Final paired scalar report exceeded its 1 MiB control-plane bound.");
  }
  const reportPath = path.join(prepared.root, "execution", "paired-result.json");
  await writeExclusive(reportPath, serialized);
  return {
    report,
    reportArtifact: await artifactRecord(prepared.root, reportPath),
    normalizedArtifacts: artifacts
  };
}

export async function executePreparedCrossAgentPair(
  manifestPath, expectedManifestSha256, deps = {}
) {
  const prepared = await validatePreparedExecution(manifestPath, expectedManifestSha256);
  const executionDir = path.join(prepared.root, "execution");
  await mkdir(executionDir, { recursive: true });
  const startedPath = path.join(executionDir, "started.json");
  try {
    await writeExclusive(startedPath, {
      schemaVersion: 1,
      kind: "sigma.benchmark-paired-execution-started",
      manifestSha256: expectedManifestSha256,
      startedAt: (deps.now ?? (() => new Date()))().toISOString()
    });
  } catch (error) {
    if (error?.code === "EEXIST") throw executionAlreadyStarted();
    throw error;
  }
  const runner = deps.runProcess ?? runProcess;
  const results = [];
  for (const role of prepared.manifest.armOrder) {
    const arm = prepared.manifest.arms[role];
    for (const cohort of arm.cohorts) {
      let result;
      try {
        const configPath = await verifyArtifact(prepared.root, cohort.config);
        const args = [
          "run", "--config", configPath,
          ...(prepared.manifest.harbor.yesFlag ? [prepared.manifest.harbor.yesFlag] : [])
        ];
        const stem = path.join(
          executionDir, `${role}-${String(cohort.order).padStart(3, "0")}`
        );
        result = await runner(prepared.manifest.harbor.commandPath, args, {
          cwd: rootDir,
          env: process.env,
          stdoutPath: `${stem}.stdout.log`,
          stderrPath: `${stem}.stderr.log`,
          rawPath: `${stem}.raw.log`
        });
        results.push({
          role, cohort: cohort.order, attempted: true,
          exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : 1,
          error: null
        });
      } catch (error) {
        results.push({
          role,
          cohort: cohort.order,
          attempted: true,
          exitCode: 1,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1000)
        });
      }
    }
  }
  let pairedResult;
  let postRunError = null;
  try {
    pairedResult = await writePostRunPairReport(prepared);
  } catch (error) {
    postRunError = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const fallback = {
      schemaVersion: 1,
      kind: "sigma.benchmark-cross-agent-pair",
      status: "not_comparable",
      comparable: false,
      outcomeStatus: "incomplete",
      mismatchReasons: ["post_run_normalization_failed"],
      preregistrationSha256: prepared.manifest.plan.sha256,
      error: postRunError
    };
    const fallbackPath = path.join(executionDir, "paired-result.json");
    await writeExclusive(fallbackPath, fallback);
    pairedResult = {
      report: fallback,
      reportArtifact: await artifactRecord(prepared.root, fallbackPath),
      normalizedArtifacts: {}
    };
  }
  const commandFailure = results.some((result) => result.exitCode !== 0 || result.error);
  const finished = {
    schemaVersion: 1,
    kind: "sigma.benchmark-paired-execution-finished",
    manifestSha256: expectedManifestSha256,
    finishedAt: (deps.now ?? (() => new Date()))().toISOString(),
    status: commandFailure || postRunError ? "failed" : "completed",
    executionPolicy: prepared.manifest.executionPolicy,
    results,
    pairedReport: pairedResult.reportArtifact,
    normalizedResults: pairedResult.normalizedArtifacts,
    pairedStatus: pairedResult.report.status,
    comparable: pairedResult.report.comparable,
    outcomeStatus: pairedResult.report.outcomeStatus,
    postRunError
  };
  await writeExclusive(path.join(executionDir, "finished.json"), finished);
  return { ...finished, executionDir };
}

function parseCli(argv) {
  const mode = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Every option requires a value.");
    values[key.slice(2)] = value;
  }
  if (mode === "prepare-only") {
    if (!values.spec || !values.output) {
      throw new Error("Usage: bench-cross-agent-paired.mjs prepare-only --spec spec.json --output directory");
    }
  } else if (mode === "execute-existing") {
    if (!values.manifest || !values["expected-manifest-sha256"]) {
      throw new Error("Usage: bench-cross-agent-paired.mjs execute-existing --manifest manifest.json --expected-manifest-sha256 <sha256>");
    }
  } else {
    throw new Error("Mode must be prepare-only or execute-existing.");
  }
  return { mode, values };
}

async function main(argv) {
  loadDotEnv();
  const { mode, values } = parseCli(argv);
  if (mode === "prepare-only") {
    const result = await prepareCrossAgentPair(values.spec, values.output);
    process.stdout.write(`Prepared paired run: ${result.manifestPath}\n`);
    process.stdout.write(`Manifest SHA-256: ${result.manifestSha256}\n`);
    return;
  }
  const result = await executePreparedCrossAgentPair(
    values.manifest, values["expected-manifest-sha256"]
  );
  process.stdout.write(`Paired execution: ${result.status}\n`);
  if (result.status !== "completed") process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
