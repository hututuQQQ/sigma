/** Versioned, product-wide infrastructure failure taxonomy. */
export const FAILURE_TAXONOMY_VERSION = 1 as const;

/** A fourth same-family failure means the eligible fail-fast boundary was missed. */
export const INFRASTRUCTURE_FAILURE_LIMIT = 3 as const;

export type InfrastructureFailureFamilyV1 =
  | "workspace_transaction"
  | "checkpoint_recovery"
  | "execution_broker"
  | "execution_sandbox"
  | "execution_capability"
  | "execution_output_encoding"
  | "execution_timeout";

export interface InfrastructureFailureClassificationV1 {
  taxonomyVersion: typeof FAILURE_TAXONOMY_VERSION;
  family: InfrastructureFailureFamilyV1;
  /** Normalized stable codes belonging to the selected family, in input order. */
  codes: string[];
}

const CODE_FAMILY_V1: Readonly<Record<string, InfrastructureFailureFamilyV1>> = {
  workspace_transaction_root_unavailable: "workspace_transaction",
  workspace_transaction_cleanup_failed: "workspace_transaction",

  checkpoint_recovery_failed: "checkpoint_recovery",
  recovery_retry_denied: "checkpoint_recovery",
  recovery_result_lost_no_replay: "checkpoint_recovery",

  broker_connection_error: "execution_broker",
  broker_protocol_error: "execution_broker",
  broker_io_error: "execution_broker",
  broker_state_error: "execution_broker",
  process_lost: "execution_broker",

  sandbox_unavailable: "execution_sandbox",
  sandbox_denied: "execution_sandbox",
  sandbox_setup_failed: "execution_sandbox",
  sandbox_self_test_failed: "execution_sandbox",
  sandbox_setup_required: "execution_sandbox",
  sandbox_recovery_failed: "execution_sandbox",
  sandbox_reparse_target_unresolvable: "execution_sandbox",

  process_spawn_failed: "execution_capability",
  spawn_failed: "execution_capability",
  executable_not_found: "execution_capability",
  executable_unavailable: "execution_capability",
  shell_unavailable: "execution_capability",
  runtime_unavailable: "execution_capability",
  toolchain_unavailable: "execution_capability",

  invalid_output_encoding: "execution_output_encoding",
  output_decode_error: "execution_output_encoding",
  output_encoding_unsupported: "execution_output_encoding",

  broker_timeout: "execution_timeout",
  process_idle_timeout: "execution_timeout",
  process_deadline: "execution_timeout",
  process_timed_out: "execution_timeout"
};

export function normalizeInfrastructureFailureCodeV1(value: string): string {
  return value.trim().toLowerCase().split(":", 1)[0] ?? "";
}

/**
 * Classify stable diagnostic codes without inferring infrastructure failure
 * from generic policy denials, exit statuses, messages, paths, or task data.
 */
export function classifyInfrastructureFailureCodesV1(
  values: readonly string[]
): InfrastructureFailureClassificationV1 | undefined {
  const classified = [...new Set(values.map(normalizeInfrastructureFailureCodeV1).filter(Boolean))]
    .flatMap((code) => {
      const family = CODE_FAMILY_V1[code];
      return family ? [{ code, family }] : [];
    });
  const family = classified[0]?.family;
  if (!family) return undefined;
  return {
    taxonomyVersion: FAILURE_TAXONOMY_VERSION,
    family,
    codes: classified.filter((item) => item.family === family).map((item) => item.code)
  };
}
