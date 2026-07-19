/** Semantic execution request produced by an agent-facing command tool. The
 * model describes what it intends to do; trusted runtime adapters resolve the
 * host-specific roots needed to do it. */
export interface ExecutionIntentV1 {
  invocation: {
    executable: string;
    args: string[];
    cwd: string;
  };
  access: "readonly" | "write";
  expectedChanges?: string[];
  network?: "none" | "loopback" | "full";
  purpose: "probe" | "build" | "lint" | "test" | "serve" | "custom";
}

export interface ResolvedExecutionCapabilityV1 {
  profileId: string;
  traversalRoots: string[];
  workspaceReadRoots: string[];
  dependencyRoots: string[];
  runtimeRoots: string[];
  writeRoots: string[];
  tempRoots: string[];
  network: "none" | "loopback" | "full";
  backend: "native" | "oci";
}

export interface SandboxLeaseV1 {
  leaseId: string;
  workspaceIdentity: string;
  generation: number;
  principalId: string;
  access: "read" | "write";
  roots: string[];
  state: "preparing" | "active" | "revoking" | "retired" | "tainted";
}

export type SandboxCapabilityFailureV1 =
  | "filesystem_acl_unsupported"
  | "external_read_required"
  | "write_scope_invalid"
  | "network_capability_unavailable"
  | "toolchain_unavailable"
  | "container_unavailable"
  | "sandbox_recovery_required";

export type ValidationClaimKindV1 =
  | "probe"
  | "syntax"
  | "typecheck"
  | "lint"
  | "unit"
  | "integration"
  | "acceptance";

export type ValidationEvidenceStrengthV1 =
  | "structural"
  | "self_consistency"
  | "behavioral"
  | "source_grounded";

export type ValidationEvidenceIndependenceV1 =
  | "same_method"
  | "cross_method"
  | "external_reference";

export type ValidationAssertionModeV1 = "explicit" | "exit_code_only";

export interface ValidationClaimV1 {
  kind: ValidationClaimKindV1;
  commandDigest: string;
  /** Runtime-derived evidence quality. Optional only for durable V5 records
   * written before this field existed. */
  strength?: ValidationEvidenceStrengthV1;
  independence?: ValidationEvidenceIndependenceV1;
  assertionMode?: ValidationAssertionModeV1;
  subject: {
    projectId?: string;
    configPaths: string[];
    selectedTests: string[];
    exactFiles: string[];
  };
  status: "passed" | "failed" | "unavailable";
}

export interface AssuranceRequirementV1 {
  risk: "read_only" | "low" | "medium" | "high";
  requiredClaims: ValidationClaimKindV1[];
  review: "off" | "advisory" | "required";
}

export interface RepositoryTopologyV1 {
  kind: "worktree" | "linked_worktree" | "submodule" | "bare";
  worktreeRoot: string | null;
  gitDir: string;
  commonDir: string;
  objectDirs: string[];
  trust: "workspace" | "external_trusted" | "external_untrusted";
}
