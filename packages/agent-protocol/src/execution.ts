/** Semantic execution request produced by an agent-facing command tool. The
 * model describes what it intends to do; trusted runtime adapters resolve the
 * host-specific roots needed to do it. */
export interface ExecutionIntent {
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

export interface ResolvedExecutionCapability {
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

export interface SandboxLease {
  leaseId: string;
  workspaceIdentity: string;
  generation: number;
  principalId: string;
  access: "read" | "write";
  roots: string[];
  state: "preparing" | "active" | "revoking" | "retired" | "tainted";
}

export type SandboxCapabilityFailure =
  | "filesystem_acl_unsupported"
  | "external_read_required"
  | "write_scope_invalid"
  | "network_capability_unavailable"
  | "toolchain_unavailable"
  | "container_unavailable"
  | "sandbox_recovery_required";

export type ValidationClaimKind =
  | "probe"
  | "syntax"
  | "typecheck"
  | "lint"
  | "unit"
  | "integration"
  | "acceptance";

export interface ValidationClaim {
  kind: ValidationClaimKind;
  commandDigest: string;
  subject: {
    projectId?: string;
    configPaths: string[];
    selectedTests: string[];
    exactFiles: string[];
  };
  status: "passed" | "failed" | "unavailable";
}

export interface AssuranceRequirement {
  risk: "read_only" | "low" | "medium" | "high";
  requiredClaims: ValidationClaimKind[];
  review: "off" | "advisory" | "required";
}

export interface RepositoryTopology {
  kind: "worktree" | "linked_worktree" | "submodule" | "bare";
  worktreeRoot: string | null;
  gitDir: string;
  commonDir: string;
  objectDirs: string[];
  trust: "workspace" | "external_trusted" | "external_untrusted";
}
