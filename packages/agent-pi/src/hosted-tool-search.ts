import type {
  ModelToolDefinition,
  ModelToolNamespace,
  ModelToolPresentation
} from "agent-protocol";

const MIN_DEFERRED_FUNCTIONS = 12;
const MAX_NAMESPACE_FUNCTIONS = 9;
const MAX_INITIAL_VISIBLE_RATIO = 0.75;

interface ResponsesTool {
  type?: unknown;
  name?: unknown;
  [key: string]: unknown;
}

interface ClassifiedFunction {
  tool: ResponsesTool;
  name: string;
  presentation: ModelToolPresentation;
}

const DEFAULT_NAMESPACE = Object.freeze({
  name: "additional_capabilities",
  description: "Additional runtime capabilities available for deferred discovery."
}) satisfies ModelToolNamespace;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function functionName(tool: unknown): string | undefined {
  const candidate = record(tool) as ResponsesTool | undefined;
  return candidate?.type === "function" && typeof candidate.name === "string"
    ? candidate.name : undefined;
}

function validNamespace(namespace: ModelToolNamespace | undefined): ModelToolNamespace {
  if (!namespace
    || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(namespace.name)
    || namespace.description.trim().length === 0) {
    return DEFAULT_NAMESPACE;
  }
  return namespace;
}

function policyByName(
  definitions: readonly ModelToolDefinition[]
): ReadonlyMap<string, ModelToolPresentation> {
  return new Map(definitions.map((definition) => [
    definition.name,
    {
      exposure: definition.presentation?.exposure ?? "direct",
      namespace: validNamespace(definition.presentation?.namespace)
    }
  ]));
}

function classifyFunctions(
  tools: readonly unknown[],
  definitions: readonly ModelToolDefinition[]
): ClassifiedFunction[] {
  const policies = policyByName(definitions);
  return tools.flatMap((tool) => {
    const name = functionName(tool);
    if (!name) return [];
    const candidate = tool as ResponsesTool;
    const configured = policies.get(name);
    const explicitlyDeferred = candidate.defer_loading === true;
    return [{
      tool: candidate,
      name,
      presentation: {
        exposure: explicitlyDeferred ? "deferred" : configured?.exposure ?? "direct",
        namespace: validNamespace(configured?.namespace)
      }
    }];
  });
}

function chunkedNamespaces(
  functions: readonly ClassifiedFunction[]
): Array<Record<string, unknown>> {
  const grouped = new Map<string, {
    definition: ModelToolNamespace;
    tools: ClassifiedFunction[];
  }>();
  for (const item of functions) {
    const definition = validNamespace(item.presentation.namespace);
    const group = grouped.get(definition.name) ?? { definition, tools: [] };
    group.tools.push(item);
    grouped.set(definition.name, group);
  }

  const result: Array<Record<string, unknown>> = [];
  for (const { definition, tools } of [...grouped.values()]
    .sort((left, right) => left.definition.name.localeCompare(right.definition.name))) {
    const ordered = [...tools].sort((left, right) => left.name.localeCompare(right.name));
    for (let offset = 0; offset < ordered.length; offset += MAX_NAMESPACE_FUNCTIONS) {
      const chunk = ordered.slice(offset, offset + MAX_NAMESPACE_FUNCTIONS);
      const part = Math.floor(offset / MAX_NAMESPACE_FUNCTIONS) + 1;
      const split = ordered.length > MAX_NAMESPACE_FUNCTIONS;
      result.push({
        type: "namespace",
        name: split ? `${definition.name}_${part}` : definition.name,
        description: split
          ? `${definition.description} Capability group ${part}.`
          : definition.description,
        tools: chunk.map(({ tool }) => ({ ...tool, defer_loading: true }))
      });
    }
  }
  return result;
}

function replayWithNamespaces(
  input: unknown,
  namespaceByFunction: ReadonlyMap<string, string>
): unknown {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    const call = record(item);
    if (call?.type !== "function_call" || typeof call.name !== "string") return item;
    const namespace = namespaceByFunction.get(call.name);
    return namespace ? { ...call, namespace } : item;
  });
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function visibleNamespace(namespace: Record<string, unknown>): Record<string, unknown> {
  return {
    type: namespace.type,
    name: namespace.name,
    description: namespace.description
  };
}

/**
 * Keep the small, stable harness core immediately callable and move only the
 * explicitly deferred long tail into provider-hosted namespaces. Presentation
 * policy comes from tool metadata rather than provider, model, or tool names.
 */
export function hostedToolSearchPayload(
  payload: unknown,
  enabled: boolean,
  definitions: readonly ModelToolDefinition[] = []
): unknown {
  if (!enabled) return payload;
  const body = record(payload);
  if (!body || body.tool_choice === "none" || !Array.isArray(body.tools)) return payload;
  if (body.tools.some((tool) => {
    const candidate = record(tool);
    return candidate?.type === "namespace" || candidate?.type === "tool_search";
  })) return payload;

  const classified = classifyFunctions(body.tools, definitions);
  const deferred = classified.filter((item) => item.presentation.exposure === "deferred");
  if (deferred.length < MIN_DEFERRED_FUNCTIONS) return payload;

  const namespaces = chunkedNamespaces(deferred);
  const deferredTools = new Set(deferred.map((item) => item.tool));
  const immediate = body.tools.filter((tool) => !deferredTools.has(tool as ResponsesTool));
  const initialVisibleTools = [
    ...immediate,
    ...namespaces.map(visibleNamespace),
    { type: "tool_search" }
  ];
  if (serializedLength(initialVisibleTools) / serializedLength(body.tools)
    > MAX_INITIAL_VISIBLE_RATIO) return payload;

  const namespaceByFunction = new Map<string, string>();
  for (const namespace of namespaces) {
    if (typeof namespace.name !== "string" || !Array.isArray(namespace.tools)) continue;
    for (const tool of namespace.tools) {
      const name = functionName(tool);
      if (name) namespaceByFunction.set(name, namespace.name);
    }
  }
  return {
    ...body,
    input: replayWithNamespaces(body.input, namespaceByFunction),
    tools: [
      ...immediate,
      ...namespaces,
      { type: "tool_search" }
    ]
  };
}

export const hostedToolSearchPolicy = Object.freeze({
  minimumDeferredFunctions: MIN_DEFERRED_FUNCTIONS,
  maximumFunctionsPerNamespace: MAX_NAMESPACE_FUNCTIONS,
  maximumInitialVisibleRatio: MAX_INITIAL_VISIBLE_RATIO
});
