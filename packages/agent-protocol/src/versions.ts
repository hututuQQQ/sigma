/**
 * Persisted/public protocol versions are intentionally independent. A change
 * to one surface must not force unrelated readers to pretend they understand
 * a new format.
 */
export const STORE_LAYOUT_VERSION = 5 as const;
export const EVENT_SCHEMA_VERSION = 5 as const;
export const SNAPSHOT_SCHEMA_VERSION = 6 as const;
export const KERNEL_STATE_VERSION = 6 as const;
export const CONFIG_SCHEMA_VERSION = 5 as const;
export const CLI_OUTPUT_SCHEMA_VERSION = 3 as const;

export const LEGACY_CONFIG_SCHEMA_VERSION_V2 = 2 as const;

/** @deprecated Use EVENT_SCHEMA_VERSION. */
export const AGENT_EVENT_SCHEMA_VERSION = EVENT_SCHEMA_VERSION;
