import type { KernelState } from "agent-kernel";
import {
  DEFAULT_ASSURANCE_RESOURCE_POLICY,
  isAssuranceResourcePolicy,
  type AssuranceResourcePolicy
} from "agent-protocol";
import type { RuntimeSession } from "./types.js";

export function normalizedAssurancePolicy(
  policy: unknown
): AssuranceResourcePolicy {
  return isAssuranceResourcePolicy(policy)
    ? { ...policy }
    : { ...DEFAULT_ASSURANCE_RESOURCE_POLICY };
}

export function assurancePolicyFromState(
  state: KernelState
): AssuranceResourcePolicy {
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
): AssuranceResourcePolicy {
  const harnessPolicy = session.durable.frozenHarness?.assurancePolicy.resourcePolicy;
  if (isAssuranceResourcePolicy(harnessPolicy)) return { ...harnessPolicy };
  const profilePolicy = session.services.profile?.profile.assurancePolicy;
  return isAssuranceResourcePolicy(profilePolicy)
    ? { ...profilePolicy }
    : assurancePolicyFromState(session.durable.state);
}
