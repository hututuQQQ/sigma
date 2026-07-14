import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonValue, ToolDescriptor } from "agent-protocol";

const TOOL_ARGUMENTS_INVALID = "tool_arguments_invalid" as const;
const TOOL_SCHEMA_INVALID = "tool_schema_invalid" as const;

type ToolSchema = ToolDescriptor["inputSchema"];
type SchemaValidator = ValidateFunction<Record<string, JsonValue>>;

const validators = new WeakMap<ToolSchema, SchemaValidator>();
const ajv = new Ajv2020({
  addUsedSchema: false,
  allErrors: false,
  allowMatchingProperties: true,
  allowUnionTypes: true,
  coerceTypes: false,
  ownProperties: true,
  removeAdditional: false,
  strictSchema: true,
  strictTuples: false,
  strictTypes: false,
  useDefaults: false,
  validateFormats: false
});

function invalidArguments(label: string): TypeError & { code: typeof TOOL_ARGUMENTS_INVALID } {
  return Object.assign(new TypeError(
    `${label} arguments must be passed directly as a JSON object matching its schema; `
      + "do not pass a JSON-encoded string."
  ), { code: TOOL_ARGUMENTS_INVALID });
}

function argumentErrorText(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "arguments do not satisfy the declared schema.";
  const visible = errors.slice(0, 5).map((error) => {
    const location = error.instancePath ? `$${error.instancePath}` : "$";
    return `${location} ${error.message ?? `violates '${error.keyword}'`}`;
  });
  if (errors.length > visible.length) visible.push(`${errors.length - visible.length} more schema errors`);
  return visible.join("; ");
}

function invalidSchemaArguments(
  label: string,
  errors: ErrorObject[] | null | undefined
): TypeError & { code: typeof TOOL_ARGUMENTS_INVALID } {
  return Object.assign(new TypeError(
    `${label} arguments do not match its declared schema: ${argumentErrorText(errors)}`
  ), { code: TOOL_ARGUMENTS_INVALID });
}

function invalidToolSchema(
  descriptor: ToolDescriptor,
  error: unknown
): TypeError & { code: typeof TOOL_SCHEMA_INVALID } {
  const detail = error instanceof Error ? error.message : String(error);
  return Object.assign(new TypeError(
    `Tool '${descriptor.name}' has an invalid input schema: ${detail}`,
    { cause: error }
  ), { code: TOOL_SCHEMA_INVALID });
}

function assertLocalReference(reference: JsonValue | undefined, keyword: "$ref" | "$dynamicRef"): void {
  if (reference === undefined || typeof reference !== "string") return;
  if (!reference.startsWith("#")) {
    throw new TypeError(`${keyword} must be a local fragment reference, not '${reference}'.`);
  }
}

function schemaRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function inspectSchemaMap(value: JsonValue | undefined): void {
  const entries = schemaRecord(value);
  if (!entries) return;
  for (const schema of Object.values(entries)) inspectSchema(schema);
}

function inspectSchemaArray(value: JsonValue | undefined): void {
  if (!Array.isArray(value)) return;
  for (const schema of value) inspectSchema(schema);
}

/** Inspect only schema-bearing keywords. Annotation payloads such as default,
 * examples, and const are instance data and must not be mistaken for schemas. */
function inspectSchema(value: JsonValue | undefined): void {
  const schema = schemaRecord(value);
  if (!schema) return;
  assertLocalReference(schema.$ref, "$ref");
  assertLocalReference(schema.$dynamicRef, "$dynamicRef");

  for (const keyword of [
    "additionalProperties", "contains", "contentSchema", "else", "if", "items",
    "not", "propertyNames", "then", "unevaluatedItems", "unevaluatedProperties"
  ]) inspectSchema(schema[keyword]);
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    inspectSchemaArray(schema[keyword]);
  }
  for (const keyword of [
    "$defs", "definitions", "dependentSchemas", "patternProperties", "properties"
  ]) inspectSchemaMap(schema[keyword]);

  const dependencies = schemaRecord(schema.dependencies);
  if (dependencies) {
    for (const dependency of Object.values(dependencies)) {
      if (!Array.isArray(dependency)) inspectSchema(dependency);
    }
  }
}

function compiledValidator(descriptor: ToolDescriptor): SchemaValidator {
  const cached = validators.get(descriptor.inputSchema);
  if (cached) return cached;
  try {
    inspectSchema(descriptor.inputSchema);
    const validate = ajv.compile<Record<string, JsonValue>>(descriptor.inputSchema);
    if ("$async" in validate && validate.$async === true) {
      throw new TypeError("asynchronous input schemas are not supported.");
    }
    validators.set(descriptor.inputSchema, validate);
    return validate;
  } catch (error) {
    throw invalidToolSchema(descriptor, error);
  }
}

/** Compile and cache a descriptor schema before the tool becomes visible. */
export function compileDescriptorArguments(descriptor: ToolDescriptor): void {
  compiledValidator(descriptor);
}

export function assertObjectArguments(
  value: JsonValue,
  label: string
): asserts value is Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArguments(label);
  }
}

/** Validate the exact model-provided object without coercion, defaults, or
 * property removal. Compilation is normally completed during registration;
 * direct callers retain a fail-closed lazy compilation path. */
export function assertDescriptorArguments(descriptor: ToolDescriptor, value: JsonValue): void {
  const validate = compiledValidator(descriptor);
  assertObjectArguments(value, `Tool '${descriptor.name}'`);
  if (!validate(value)) {
    throw invalidSchemaArguments(`Tool '${descriptor.name}'`, validate.errors);
  }
}
