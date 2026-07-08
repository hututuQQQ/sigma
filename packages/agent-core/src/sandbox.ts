import type { SandboxAdapter, SandboxExecDecision, SandboxExecRequest } from "./types.js";

export class PolicyOnlySandboxAdapter implements SandboxAdapter {
  async prepareExec(request: SandboxExecRequest): Promise<SandboxExecDecision> {
    if (request.sandbox?.filesystem === "read_only" && request.policy.mutatesWorkspace) {
      return {
        allowed: false,
        reason: "Sandbox policy is read-only, but the command appears to modify workspace state."
      };
    }
    if (request.sandbox?.network === "restricted" && request.policy.usesNetwork) {
      return {
        allowed: false,
        reason: "Sandbox policy restricts network access, but the command appears to use the network."
      };
    }
    return {
      allowed: true,
      metadata: {
        sandboxMode: request.sandbox?.mode ?? "policy_only",
        network: request.sandbox?.network ?? "default",
        filesystem: request.sandbox?.filesystem ?? "workspace_write"
      }
    };
  }
}

export function createPolicyOnlySandboxAdapter(): SandboxAdapter {
  return new PolicyOnlySandboxAdapter();
}
