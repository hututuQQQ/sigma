import type { KernelState } from "agent-kernel";
import {
  DEFAULT_ASSURANCE_RESOURCE_POLICY,
  isAssuranceResourcePolicyV1,
  type AssuranceResourcePolicyV1
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export function normalizedAssurancePolicy(
  policy: unknown
): AssuranceResourcePolicyV1 {
  return isAssuranceResourcePolicyV1(policy)
    ? { ...policy }
    : { ...DEFAULT_ASSURANCE_RESOURCE_POLICY };
}

export function assurancePolicyFromState(
  state: KernelState
): AssuranceResourcePolicyV1 {
  const assurance = state.longHorizon.assurance;
  return {
    budgetPercent: assurance.budgetPercent,
    reviewRounds: assurance.reviewRounds,
    repairRounds: assurance.repairRounds,
    reviewerMaxTurns: assurance.reviewerMaxTurns,
    reviewerMaxToolCalls: assurance.reviewerMaxToolCalls,
    repairMaxTurns: assurance.repairMaxTurns,
    repairMaxToolCalls: assurance.repairMaxToolCalls,
    strategistMode: assurance.strategistMode,
    duplicateThreshold: assurance.duplicateThreshold,
    strategyRemainingPercent: assurance.strategyRemainingPercent
  };
}

export function sessionAssurancePolicy(
  session: RuntimeSession
): AssuranceResourcePolicyV1 {
  const profilePolicy = session.services.profile?.profile.assurancePolicy;
  return isAssuranceResourcePolicyV1(profilePolicy)
    ? { ...profilePolicy }
    : assurancePolicyFromState(session.durable.state);
}
