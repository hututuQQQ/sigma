import { readFile } from "node:fs/promises";

export const EVAL_SCHEMA_VERSION = 1;

export const EVAL_BUDGETS_V1 = Object.freeze({
  tiny: Object.freeze({ wallTimeSec: 120, modelTurns: 8, toolCalls: 12, costUsd: 0.1 }),
  small: Object.freeze({ wallTimeSec: 300, modelTurns: 16, toolCalls: 30, costUsd: 0.25 }),
  medium: Object.freeze({ wallTimeSec: 600, modelTurns: 40, toolCalls: 120, costUsd: 0.8 }),
  complex: Object.freeze({ wallTimeSec: 900, modelTurns: 80, toolCalls: 250, costUsd: 1.5 })
});

export const EVAL_SURFACES_V1 = Object.freeze(["cli", "tui"]);
export const EVAL_PERMISSION_POLICIES_V1 = Object.freeze(["auto", "allow_once"]);
export const EVAL_TERMINALS_V1 = Object.freeze(["completed", "needs_input", "cancelled", "error"]);
export const EVAL_SUITES_V1 = Object.freeze(["quick", "experience"]);

/**
 * @typedef {"tiny" | "small" | "medium" | "complex"} EvalBudgetV1
 * @typedef {"cli" | "tui"} EvalSurfaceV1
 * @typedef {"auto" | "allow_once"} EvalPermissionPolicyV1
 * @typedef {"completed" | "needs_input" | "cancelled" | "error"} EvalTerminalV1
 *
 * @typedef {{kind: "elapsed_ms", value: number} | {kind: "event_count", count: number, eventType?: string} | {kind: "first_mutation"}} EvalAtomicTriggerV1
 * @typedef {{triggers: EvalAtomicTriggerV1[], action: "submit" | "steer" | "follow_up", text: string}} EvalInteractionV1
 *
 * @typedef {{type: "write" | "append", path: string, content: string} | {type: "delete", path: string}} EvalSetupOperationV1
 * @typedef {{workspace: string, setupAfterCommit?: EvalSetupOperationV1[]}} EvalFixtureV1
 *
 * @typedef {{type: "command", argv: string[], expectedExitCode?: number, timeoutMs?: number}} EvalCommandCheckV1
 * @typedef {{type: "file", path: string, exists?: boolean, equals?: string, contains?: string, notContains?: string}} EvalFileCheckV1
 * @typedef {{type: "answer", pattern: string, flags?: string, minMatches?: number, maxMatches?: number}} EvalAnswerCheckV1
 * @typedef {{type: "event_count", eventType: string, toolName?: string, minCount?: number, maxCount?: number}} EvalEventCountCheckV1
 * @typedef {{type: "git_diff", allowedPaths?: string[], requireClean?: boolean, preserveInitial?: boolean}} EvalGitDiffCheckV1
 * @typedef {EvalCommandCheckV1 | EvalFileCheckV1 | EvalAnswerCheckV1 | EvalEventCountCheckV1 | EvalGitDiffCheckV1} EvalVerifierCheckV1
 *
 * @typedef {object} EvalScenarioV1
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} title
 * @property {("quick" | "experience")[]} suites
 * @property {EvalFixtureV1} fixture
 * @property {string[]} userMessages
 * @property {EvalSurfaceV1} surface
 * @property {EvalPermissionPolicyV1} permissionPolicy
 * @property {EvalTerminalV1} expectedTerminal
 * @property {EvalBudgetV1} budget
 * @property {string[]} allowedChanges
 * @property {EvalInteractionV1[]} interactions
 * @property {{checks: EvalVerifierCheckV1[]}} verifier
 *
 * @typedef {{schemaVersion: 1, scenarios: EvalScenarioV1[]}} EvalScenarioManifestV1
 */

const scenarioKeys = new Set([
  "schemaVersion", "id", "title", "suites", "fixture", "userMessages", "surface",
  "permissionPolicy", "expectedTerminal", "budget", "allowedChanges", "interactions", "verifier"
]);

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
  rejectUnknownKeys(fixture, new Set(["workspace", "setupAfterCommit"]), label);
  requireRelativePath(fixture.workspace, `${label}.workspace`);
  if (!own(fixture, "setupAfterCommit")) return;
  if (!Array.isArray(fixture.setupAfterCommit)) throw new TypeError(`${label}.setupAfterCommit must be an array`);
  fixture.setupAfterCommit.forEach((rawOperation, index) => {
    const operationLabel = `${label}.setupAfterCommit[${index}]`;
    const operation = requireRecord(rawOperation, operationLabel);
    requireEnum(operation.type, ["write", "append", "delete"], `${operationLabel}.type`);
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
  if (argv[0] !== "node") throw new TypeError(`${label}.argv[0] must be node in EvalScenarioV1`);
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

export function assertEvalScenarioV1(value, label = "scenario") {
  const scenario = requireRecord(value, label);
  rejectUnknownKeys(scenario, scenarioKeys, label);
  if (scenario.schemaVersion !== EVAL_SCHEMA_VERSION) throw new TypeError(`${label}.schemaVersion must equal ${EVAL_SCHEMA_VERSION}`);
  const id = requireString(scenario.id, `${label}.id`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new TypeError(`${label}.id must use lowercase kebab-case`);
  requireString(scenario.title, `${label}.title`);
  const suites = requireStringArray(scenario.suites, `${label}.suites`);
  if (suites.length === 0 || new Set(suites).size !== suites.length) throw new TypeError(`${label}.suites must be non-empty and unique`);
  suites.forEach((suite, index) => requireEnum(suite, EVAL_SUITES_V1, `${label}.suites[${index}]`));
  if (!suites.includes("experience")) throw new TypeError(`${label}.suites must include experience`);
  validateFixture(scenario.fixture, `${label}.fixture`);
  const messages = requireStringArray(scenario.userMessages, `${label}.userMessages`);
  if (messages.length !== 1) throw new TypeError(`${label}.userMessages must contain exactly one initial user message; later messages belong in interactions`);
  requireEnum(scenario.surface, EVAL_SURFACES_V1, `${label}.surface`);
  requireEnum(scenario.permissionPolicy, EVAL_PERMISSION_POLICIES_V1, `${label}.permissionPolicy`);
  requireEnum(scenario.expectedTerminal, EVAL_TERMINALS_V1, `${label}.expectedTerminal`);
  requireEnum(scenario.budget, Object.keys(EVAL_BUDGETS_V1), `${label}.budget`);
  requireStringArray(scenario.allowedChanges, `${label}.allowedChanges`, { path: true, allowGlob: true });
  validateInteractions(scenario.interactions, `${label}.interactions`);
  if (scenario.surface === "cli" && (scenario.permissionPolicy !== "auto" || scenario.interactions.length > 0)) {
    throw new TypeError(`${label} CLI scenarios require permissionPolicy "auto" and no interactions`);
  }
  validateVerifier(scenario.verifier, `${label}.verifier`);
  return scenario;
}

export function parseEvalScenarioV1(value, label = "scenario") {
  return assertEvalScenarioV1(structuredClone(value), label);
}

export function assertEvalManifestV1(value, label = "manifest") {
  const manifest = requireRecord(value, label);
  rejectUnknownKeys(manifest, new Set(["schemaVersion", "scenarios"]), label);
  if (manifest.schemaVersion !== EVAL_SCHEMA_VERSION) throw new TypeError(`${label}.schemaVersion must equal ${EVAL_SCHEMA_VERSION}`);
  if (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) throw new TypeError(`${label}.scenarios must be non-empty`);
  manifest.scenarios.forEach((scenario, index) => assertEvalScenarioV1(scenario, `${label}.scenarios[${index}]`));
  const ids = manifest.scenarios.map((scenario) => scenario.id);
  if (new Set(ids).size !== ids.length) throw new TypeError(`${label}.scenarios must have unique ids`);
  return manifest;
}

export function parseEvalManifestV1(value, label = "manifest") {
  return assertEvalManifestV1(structuredClone(value), label);
}

export async function loadEvalManifestV1(manifestPath) {
  const raw = await readFile(manifestPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`Could not parse evaluation manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return parseEvalManifestV1(parsed, `manifest(${manifestPath})`);
}

// This is the only projection intended to reach the subject-driving layer. In
// particular, it excludes scenario identity, budgets, terminal expectations,
// allowed paths, and every verifier detail.
export function toSubjectDriverSpecV1(value) {
  const scenario = assertEvalScenarioV1(value);
  return structuredClone({
    surface: scenario.surface,
    permissionPolicy: scenario.permissionPolicy,
    userMessages: scenario.userMessages,
    interactions: scenario.interactions
  });
}
