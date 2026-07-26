import type { JsonValue } from "agent-protocol";
import type {
  WebClickInput,
  WebFindInput,
  WebOpenInput,
  WebRunInput,
  WebSearchInput
} from "./types.js";

const DIRECT_URL = /^https?:\/\//iu;
const WEB_REF = /^web:[a-f0-9]{64}:\d+$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`${label} contains unknown property '${unknown}'.`);
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters.`);
  }
  return value.trim();
}

function boundedArray<T>(
  value: unknown,
  label: string,
  parse: (item: unknown, index: number) => T
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4) {
    throw new TypeError(`${label} must contain at most four items.`);
  }
  return value.map(parse);
}

function searchInput(value: unknown, index: number): WebSearchInput {
  const item = record(value, `search_query[${index}]`);
  keys(item, ["q", "domains", "recency"], `search_query[${index}]`);
  const domains = item.domains === undefined ? undefined : (() => {
    if (!Array.isArray(item.domains) || item.domains.length === 0 || item.domains.length > 16) {
      throw new TypeError(`search_query[${index}].domains must contain 1..16 domains.`);
    }
    return item.domains.map((domain, domainIndex) => {
      const value = boundedString(domain, `search_query[${index}].domains[${domainIndex}]`, 253)
        .toLowerCase();
      if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value)) {
        throw new TypeError(`search_query[${index}].domains[${domainIndex}] is invalid.`);
      }
      return value;
    });
  })();
  const recency = item.recency === undefined ? undefined : Number(item.recency);
  if (recency !== undefined && (!Number.isInteger(recency) || recency < 1 || recency > 3_650)) {
    throw new TypeError(`search_query[${index}].recency must be an integer from 1 to 3650.`);
  }
  return {
    q: boundedString(item.q, `search_query[${index}].q`, 2_000),
    ...(domains ? { domains: [...new Set(domains)] } : {}),
    ...(recency === undefined ? {} : { recency })
  };
}

function reference(value: unknown, label: string): string {
  const ref = boundedString(value, label, 4_096);
  if (!DIRECT_URL.test(ref) && !WEB_REF.test(ref)) {
    throw new TypeError(`${label} must be an HTTP(S) URL or a Web reference.`);
  }
  return ref;
}

function openInput(value: unknown, index: number): WebOpenInput {
  const item = record(value, `open[${index}]`);
  keys(item, ["ref_id", "lineno"], `open[${index}]`);
  const lineno = item.lineno === undefined ? undefined : Number(item.lineno);
  if (lineno !== undefined && (!Number.isInteger(lineno) || lineno < 1)) {
    throw new TypeError(`open[${index}].lineno must be a positive integer.`);
  }
  return {
    ref_id: reference(item.ref_id, `open[${index}].ref_id`),
    ...(lineno === undefined ? {} : { lineno })
  };
}

function clickInput(value: unknown, index: number): WebClickInput {
  const item = record(value, `click[${index}]`);
  keys(item, ["ref_id", "id"], `click[${index}]`);
  const id = Number(item.id);
  if (!Number.isInteger(id) || id < 1 || id > 200) {
    throw new TypeError(`click[${index}].id must be an integer from 1 to 200.`);
  }
  return { ref_id: reference(item.ref_id, `click[${index}].ref_id`), id };
}

function findInput(value: unknown, index: number): WebFindInput {
  const item = record(value, `find[${index}]`);
  keys(item, ["ref_id", "pattern"], `find[${index}]`);
  return {
    ref_id: reference(item.ref_id, `find[${index}].ref_id`),
    pattern: boundedString(item.pattern, `find[${index}].pattern`, 1_000)
  };
}

export function parseWebRunInput(value: JsonValue): WebRunInput {
  const input = record(value, "web_run arguments");
  keys(input, ["search_query", "open", "click", "find", "response_length"], "web_run arguments");
  const output: WebRunInput = {
    search_query: boundedArray(input.search_query, "search_query", searchInput),
    open: boundedArray(input.open, "open", openInput),
    click: boundedArray(input.click, "click", clickInput),
    find: boundedArray(input.find, "find", findInput)
  };
  const total = Object.values(output).reduce(
    (sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0
  );
  if (total < 1 || total > 8) {
    throw new TypeError("web_run requires 1..8 operations in total.");
  }
  if (input.response_length !== undefined
    && !["short", "medium", "long"].includes(String(input.response_length))) {
    throw new TypeError("response_length must be short, medium, or long.");
  }
  return {
    ...output,
    ...(input.response_length
      ? { response_length: input.response_length as WebRunInput["response_length"] } : {})
  };
}
