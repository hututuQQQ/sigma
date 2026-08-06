import { readFile } from "node:fs/promises";
import { assertRepoScaleGenerator } from "./fixture-generator.mjs";

export const EVAL_SCHEMA_VERSION = 1;

export const EVAL_BUDGETS = Object.freeze({
  tiny: Object.freeze({ wallTimeSec: 120, modelTurns: 8, toolCalls: 12, costUsd: 0.1 }),
  small: Object.freeze({ wallTimeSec: 300, modelTurns: 16, toolCalls: 30, costUsd: 0.25 }),
  medium: Object.freeze({ wallTimeSec: 600, modelTurns: 40, toolCalls: 120, costUsd: 0.8 }),
  complex: Object.freeze({ wallTimeSec: 900, modelTurns: 80, toolCalls: 250, costUsd: 1.5 })
});

export const EVAL_SURFACES = Object.freeze(["cli", "tui"]);
export const EVAL_PERMISSION_POLICIES = Object.freeze(["auto", "allow_once"]);
export const EVAL_TERMINALS = Object.freeze(["completed", "needs_input", "cancelled", "error"]);
export const EVAL_PLATFORMS = Object.freeze(["win32-x64", "linux-x64", "darwin-arm64"]);
export const EVAL_RISK_CLASSES = Object.freeze(["read_only", "workspace_write", "interactive"]);
export const EVAL_SCHEDULE_STRATEGIES = Object.freeze(["seeded_round_robin"]);
export const EVAL_AB_ORDERS = Object.freeze(["interleaved_baseline_first", "interleaved_candidate_first"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unknown field ${JSON.stringify(key)}`);
  }
}

function assertSchemaVersion(value, label) {
  if (value !== EVAL_SCHEMA_VERSION) {
    throw new TypeError(
      `unsupported_schema_version: path=${label} expected=${EVAL_SCHEMA_VERSION} actual=${String(value)}`
    );
  }
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new TypeError(`${label} must be one of ${allowed.join(", ")}`);
  return value;
}

function requireRelativePath(value, label, { allowGlob = false } = {}) {
  const candidate = requireString(value, label);
  if (candidate.includes("\\") || candidate.startsWith("/") || /^[A-Za-z]:/.test(candidate)) {
    throw new TypeError(`${label} must be a portable relative path using forward slashes`);
  }
  if (candidate.split("/").some((part) => part === ".." || part === "" || part === ".")) {
    throw new TypeError(`${label} must not escape or ambiguously address its root`);
  }
  if (!allowGlob && /[*?[\]{}]/.test(candidate)) throw new TypeError(`${label} must not contain glob syntax`);
  if (allowGlob && /[[\]{}]/u.test(candidate)) {
    throw new TypeError(`${label} only supports *, **, and ? glob syntax`);
  }
  return candidate;
}

function requireStringArray(value, label, { path = false, allowGlob = false } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => path
    ? requireRelativePath(entry, `${label}[${index}]`, { allowGlob })
    : requireString(entry, `${label}[${index}]`));
}

function validateFixture(value, label) {
  const fixture = requireRecord(value, label);
  rejectUnknownKeys(fixture, new Set(["workspace", "setupAfterCommit", "generator"]), label);
  requireRelativePath(fixture.workspace, `${label}.workspace`);
  if (own(fixture, "generator")) assertRepoScaleGenerator(fixture.generator, `${label}.generator`);
  if (!own(fixture, "setupAfterCommit")) return;
  if (!Array.isArray(fixture.setupAfterCommit)) throw new TypeError(`${label}.setupAfterCommit must be an array`);
  fixture.setupAfterCommit.forEach((rawOperation, index) => {
    const operationLabel = `${label}.setupAfterCommit[${index}]`;
    const operation = requireRecord(rawOperation, operationLabel);
    requireEnum(operation.type, ["write", "append", "delete", "link"], `${operationLabel}.type`);
    if (operation.type === "link") {
      rejectUnknownKeys(operation, new Set([
        "type", "path", "target", "linkKind", "targetScope", "targetExists"
      ]), operationLabel);
      requireRelativePath(operation.path, `${operationLabel}.path`);
      requireRelativePath(operation.target, `${operationLabel}.target`);
      requireEnum(operation.linkKind, ["directory", "file"], `${operationLabel}.linkKind`);
      if (own(operation, "targetScope")) {
        requireEnum(operation.targetScope, ["workspace", "outside_workspace"], `${operationLabel}.targetScope`);
      }
      if (own(operation, "targetExists")) requireBoolean(operation.targetExists, `${operationLabel}.targetExists`);
      if (operation.targetScope === "outside_workspace" && !own(operation, "targetExists")) {
        throw new TypeError(`${operationLabel}.targetExists is required for outside_workspace links`);
      }
      return;
    }
    const allowedKeys = operation.type === "delete" ? new Set(["type", "path"]) : new Set(["type", "path", "content"]);
    rejectUnknownKeys(operation, allowedKeys, operationLabel);
    requireRelativePath(operation.path, `${operationLabel}.path`);
    if (operation.type !== "delete" && typeof operation.content !== "string") {
      throw new TypeError(`${operationLabel}.content must be a string`);
    }
  });
}

function validateTrigger(value, label) {
  const trigger = requireRecord(value, label);
  requireEnum(trigger.kind, ["elapsed_ms", "event_count", "first_mutation"], `${label}.kind`);
  if (trigger.kind === "elapsed_ms") {
    rejectUnknownKeys(trigger, new Set(["kind", "value"]), label);
    requireInteger(trigger.value, `${label}.value`, 1);
  } else if (trigger.kind === "event_count") {
    rejectUnknownKeys(trigger, new Set(["kind", "count", "eventType"]), label);
    requireInteger(trigger.count, `${label}.count`, 1);
    if (own(trigger, "eventType")) requireString(trigger.eventType, `${label}.eventType`);
  } else rejectUnknownKeys(trigger, new Set(["kind"]), label);
}

function validateInteractions(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  value.forEach((rawInteraction, index) => {
    const interactionLabel = `${label}[${index}]`;
    const interaction = requireRecord(rawInteraction, interactionLabel);
    rejectUnknownKeys(interaction, new Set(["triggers", "action", "text"]), interactionLabel);
    if (!Array.isArray(interaction.triggers) || interaction.triggers.length === 0) {
      throw new TypeError(`${interactionLabel}.triggers must be a non-empty OR trigger list`);
    }
    interaction.triggers.forEach((trigger, triggerIndex) => validateTrigger(trigger, `${interactionLabel}.triggers[${triggerIndex}]`));
    requireEnum(interaction.action, ["submit", "steer", "follow_up"], `${interactionLabel}.action`);
    requireString(interaction.text, `${interactionLabel}.text`);
  });
}

function validateCommandCheck(check, label) {
  rejectUnknownKeys(check, new Set(["type", "argv", "expectedExitCode", "timeoutMs"]), label);
  const argv = requireStringArray(check.argv, `${label}.argv`);
  if (argv.length === 0) throw new TypeError(`${label}.argv must be non-empty`);
  if (argv[0] !== "node") throw new TypeError(`${label}.argv[0] must be node in EvalScenario`);
  for (const [index, argument] of argv.entries()) {
    const variables = argument.match(/\$[A-Z_][A-Z0-9_]*/g) ?? [];
    if (variables.some((variable) => variable !== "$WORKSPACE" && variable !== "$MANIFEST_DIR")) {
      throw new TypeError(`${label}.argv[${index}] contains an unsupported variable`);
    }
  }
  if (own(check, "expectedExitCode")) requireInteger(check.expectedExitCode, `${label}.expectedExitCode`);
  if (own(check, "timeoutMs")) requireInteger(check.timeoutMs, `${label}.timeoutMs`, 1);
}

function validateFileCheck(check, label) {
  rejectUnknownKeys(check, new Set(["type", "path", "exists", "equals", "contains", "notContains"]), label);
  requireRelativePath(check.path, `${label}.path`);
  const assertions = ["exists", "equals", "contains", "notContains"].filter((key) => own(check, key));
  if (assertions.length === 0) throw new TypeError(`${label} must declare at least one assertion`);
  if (own(check, "exists")) requireBoolean(check.exists, `${label}.exists`);
  for (const key of ["equals", "contains", "notContains"]) {
    if (own(check, key) && typeof check[key] !== "string") throw new TypeError(`${label}.${key} must be a string`);
  }
}

function validateAnswerCheck(check, label) {
  rejectUnknownKeys(check, new Set(["type", "pattern", "flags", "minMatches", "maxMatches"]), label);
  const pattern = requireString(check.pattern, `${label}.pattern`);
  const flags = own(check, "flags") ? check.flags : "iu";
  if (typeof flags !== "string" || /[^dgimsuvy]/.test(flags)) throw new TypeError(`${label}.flags contains unsupported regular-expression flags`);
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    throw new TypeError(`${label}.pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const minimum = own(check, "minMatches") ? requireInteger(check.minMatches, `${label}.minMatches`) : 1;
  const maximum = own(check, "maxMatches") ? requireInteger(check.maxMatches, `${label}.maxMatches`) : undefined;
  if (maximum !== undefined && maximum < minimum) throw new TypeError(`${label}.maxMatches must be >= minMatches`);
}

function validateEventCountCheck(check, label) {
  rejectUnknownKeys(check, new Set(["type", "eventType", "toolName", "minCount", "maxCount"]), label);
  requireString(check.eventType, `${label}.eventType`);
  if (own(check, "toolName")) requireString(check.toolName, `${label}.toolName`);
  const minimum = own(check, "minCount") ? requireInteger(check.minCount, `${label}.minCount`) : 1;
  const maximum = own(check, "maxCount") ? requireInteger(check.maxCount, `${label}.maxCount`) : undefined;
  if (maximum !== undefined && maximum < minimum) throw new TypeError(`${label}.maxCount must be >= minCount`);
}

function validateGitDiffCheck(check, label) {
  rejectUnknownKeys(check, new Set(["type", "allowedPaths", "requireClean", "preserveInitial"]), label);
  const assertions = ["allowedPaths", "requireClean", "preserveInitial"].filter((key) => own(check, key));
  if (assertions.length === 0) throw new TypeError(`${label} must declare at least one assertion`);
  if (own(check, "allowedPaths")) requireStringArray(check.allowedPaths, `${label}.allowedPaths`, { path: true, allowGlob: true });
  if (own(check, "requireClean")) requireBoolean(check.requireClean, `${label}.requireClean`);
  if (own(check, "preserveInitial")) requireBoolean(check.preserveInitial, `${label}.preserveInitial`);
}

function validateVerifier(value, label) {
  const verifier = requireRecord(value, label);
  rejectUnknownKeys(verifier, new Set(["checks"]), label);
  if (!Array.isArray(verifier.checks) || verifier.checks.length === 0) throw new TypeError(`${label}.checks must be non-empty`);
  verifier.checks.forEach((rawCheck, index) => {
    const checkLabel = `${label}.checks[${index}]`;
    const check = requireRecord(rawCheck, checkLabel);
    requireEnum(check.type, ["command", "file", "answer", "event_count", "git_diff"], `${checkLabel}.type`);
    if (check.type === "command") validateCommandCheck(check, checkLabel);
    else if (check.type === "file") validateFileCheck(check, checkLabel);
    else if (check.type === "answer") validateAnswerCheck(check, checkLabel);
    else if (check.type === "event_count") validateEventCountCheck(check, checkLabel);
    else validateGitDiffCheck(check, checkLabel);
  });
}

const scenarioKeys = new Set([
  "schemaVersion", "id", "title", "suites", "fixture", "userMessages", "surface",
  "permissionPolicy", "expectedTerminal", "allowedChanges", "interactions", "verifier",
  "capabilities", "repoScale", "riskClass", "platforms", "toolchainDigest"
]);
const WRITE_CAPABILITY = /(?:^|[._-])(?:write|edit|create|delete|remove|rename|move|copy|mutate|patch|append|truncate|chmod|chown)(?:$|[._-])/u;

function validateCapability(value, label) {
  const capability = requireString(value, label);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(capability)) {
    throw new TypeError(`${label} must be a stable lowercase capability name`);
  }
  return capability;
}

function validateRepoScale(value, label) {
  const scale = requireRecord(value, label);
  rejectUnknownKeys(scale, new Set(["profile", "fixtureFamily", "fileCount", "lineCount"]), label);
  requireEnum(scale.profile, ["tiny", "repo_scale"], `${label}.profile`);
  const family = requireString(scale.fixtureFamily, `${label}.fixtureFamily`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(family)) throw new TypeError(`${label}.fixtureFamily must use lowercase kebab-case`);
  requireInteger(scale.fileCount, `${label}.fileCount`, 1);
  requireInteger(scale.lineCount, `${label}.lineCount`, 1);
}

function validateFrozenBudget(value, label) {
  const budget = requireRecord(value, label);
  rejectUnknownKeys(budget, new Set(["wallTimeSec", "modelTurns", "toolCalls", "costUsd"]), label);
  requireInteger(budget.wallTimeSec, `${label}.wallTimeSec`, 1);
  requireInteger(budget.modelTurns, `${label}.modelTurns`, 1);
  requireInteger(budget.toolCalls, `${label}.toolCalls`, 1);
  if (typeof budget.costUsd !== "number" || !Number.isFinite(budget.costUsd) || budget.costUsd <= 0) {
    throw new TypeError(`${label}.costUsd must be a finite number > 0`);
  }
}

export function assertFrozenRunPolicy(value, label = "frozenRunPolicy") {
  const policy = requireRecord(value, label);
  rejectUnknownKeys(policy, new Set(["schemaVersion", "seed", "repeat", "budget", "schedule", "abOrder"]), label);
  assertSchemaVersion(policy.schemaVersion, label);
  requireInteger(policy.seed, `${label}.seed`);
  requireInteger(policy.repeat, `${label}.repeat`, 1);
  validateFrozenBudget(policy.budget, `${label}.budget`);
  requireEnum(policy.schedule, EVAL_SCHEDULE_STRATEGIES, `${label}.schedule`);
  requireEnum(policy.abOrder, EVAL_AB_ORDERS, `${label}.abOrder`);
  return policy;
}

export function parseFrozenRunPolicy(value, label = "frozenRunPolicy") {
  return assertFrozenRunPolicy(structuredClone(value), label);
}

function validateScenarioSuites(value, label, suiteNames) {
  const suites = requireStringArray(value, label);
  if (suites.length === 0 || new Set(suites).size !== suites.length) throw new TypeError(`${label} must be non-empty and unique`);
  for (const [index, suite] of suites.entries()) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(suite)) throw new TypeError(`${label}[${index}] must use lowercase kebab-case`);
    if (suiteNames && !suiteNames.has(suite)) throw new TypeError(`${label}[${index}] has no frozen run policy`);
  }
}

function validateScenarioDriverFields(scenario, label) {
  const messages = requireStringArray(scenario.userMessages, `${label}.userMessages`);
  if (messages.length !== 1) throw new TypeError(`${label}.userMessages must contain exactly one initial user message; later messages belong in interactions`);
  requireEnum(scenario.surface, EVAL_SURFACES, `${label}.surface`);
  requireEnum(scenario.permissionPolicy, EVAL_PERMISSION_POLICIES, `${label}.permissionPolicy`);
  validateInteractions(scenario.interactions, `${label}.interactions`);
  if (scenario.surface === "cli" && (scenario.permissionPolicy !== "auto" || scenario.interactions.length > 0)) {
    throw new TypeError(`${label} CLI scenarios require permissionPolicy "auto" and no interactions`);
  }
}

function validateScenarioMetadata(scenario, label) {
  if (!Array.isArray(scenario.capabilities) || scenario.capabilities.length === 0) {
    throw new TypeError(`${label}.capabilities must be a non-empty array`);
  }
  scenario.capabilities.forEach((capability, index) => validateCapability(capability, `${label}.capabilities[${index}]`));
  if (new Set(scenario.capabilities).size !== scenario.capabilities.length) throw new TypeError(`${label}.capabilities must be unique`);
  validateRepoScale(scenario.repoScale, `${label}.repoScale`);
  requireEnum(scenario.riskClass, EVAL_RISK_CLASSES, `${label}.riskClass`);
  if (scenario.riskClass === "read_only") {
    if (scenario.allowedChanges.length !== 0) {
      throw new TypeError(`${label} read_only scenarios may not declare allowedChanges`);
    }
    if (scenario.capabilities.some((capability) => WRITE_CAPABILITY.test(capability))) {
      throw new TypeError(`${label} read_only scenarios may not declare write capabilities`);
    }
  }
  if (!Array.isArray(scenario.platforms) || scenario.platforms.length === 0) throw new TypeError(`${label}.platforms must be a non-empty array`);
  scenario.platforms.forEach((platform, index) => requireEnum(platform, EVAL_PLATFORMS, `${label}.platforms[${index}]`));
  if (new Set(scenario.platforms).size !== scenario.platforms.length) throw new TypeError(`${label}.platforms must be unique`);
  const toolchainDigest = requireString(scenario.toolchainDigest, `${label}.toolchainDigest`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(toolchainDigest)) throw new TypeError(`${label}.toolchainDigest must be a sha256 digest`);
}

export function assertEvalScenario(value, label = "scenario", suiteNames) {
  const scenario = requireRecord(value, label);
  rejectUnknownKeys(scenario, scenarioKeys, label);
  assertSchemaVersion(scenario.schemaVersion, label);
  const id = requireString(scenario.id, `${label}.id`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) throw new TypeError(`${label}.id must use lowercase kebab-case`);
  requireString(scenario.title, `${label}.title`);
  validateScenarioSuites(scenario.suites, `${label}.suites`, suiteNames);
  validateFixture(scenario.fixture, `${label}.fixture`);
  validateScenarioDriverFields(scenario, label);
  requireEnum(scenario.expectedTerminal, EVAL_TERMINALS, `${label}.expectedTerminal`);
  requireStringArray(scenario.allowedChanges, `${label}.allowedChanges`, { path: true, allowGlob: true });
  validateVerifier(scenario.verifier, `${label}.verifier`);
  validateScenarioMetadata(scenario, label);
  return scenario;
}

export function parseEvalScenario(value, label = "scenario") {
  return assertEvalScenario(structuredClone(value), label);
}

export function assertEvalManifest(value, label = "manifest") {
  const manifest = requireRecord(value, label);
  rejectUnknownKeys(manifest, new Set(["schemaVersion", "frozenRunPolicies", "scenarios"]), label);
  assertSchemaVersion(manifest.schemaVersion, label);
  const policies = requireRecord(manifest.frozenRunPolicies, `${label}.frozenRunPolicies`);
  const suites = new Set(Object.keys(policies));
  if (suites.size === 0) throw new TypeError(`${label}.frozenRunPolicies must be non-empty`);
  for (const [suite, policy] of Object.entries(policies)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(suite)) throw new TypeError(`${label}.frozenRunPolicies keys must use lowercase kebab-case`);
    assertFrozenRunPolicy(policy, `${label}.frozenRunPolicies.${suite}`);
  }
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) throw new TypeError(`${label}.scenarios must be non-empty`);
  manifest.scenarios.forEach((scenario, index) => assertEvalScenario(scenario, `${label}.scenarios[${index}]`, suites));
  const ids = manifest.scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label}.scenarios must have unique ids`);
  return manifest;
}

export function parseEvalManifest(value, label = "manifest") {
  return assertEvalManifest(structuredClone(value), label);
}

export async function loadEvalManifest(manifestPath) {
  const raw = await readFile(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`Could not parse evaluation manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return parseEvalManifest(parsed, `manifest(${manifestPath})`);
}

// This projection is the mandatory scenario-data boundary. The evaluator may
// add opaque runtime handles around it, but no scenario identity, run policy,
// paths, fixture, verifier, expected result, or budget is represented here.
export function toSubjectDriverSpec(value) {
  const scenario = assertEvalScenario(value);
  return structuredClone({
    messages: scenario.userMessages,
    surface: scenario.surface,
    permissions: { policy: scenario.permissionPolicy },
    interactions: scenario.interactions
  });
}
