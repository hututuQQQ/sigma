import {
  DEFAULT_PROFILE_ASSURANCE,
  DEFAULT_PROFILE_BUDGET,
  freezeAgentProfile
} from "../../packages/agent-extensions/src/index.js";

export function strictReviewProfileFixture() {
  return freezeAgentProfile({
    id: "strict-test",
    roleRoutes: {
      orchestrator: "default",
      planner: "default",
      reviewer: "default",
      child_analyze: "default",
      child_write: "default",
      summarizer: "default"
    },
    toolAllow: null,
    toolDeny: [],
    skills: [],
    hooks: [],
    permissionMode: "auto",
    budget: { ...DEFAULT_PROFILE_BUDGET },
    mutationPolicy: {
      requirePlanBeforeMutation: false,
      checkpointBeforeMutation: true,
      reviewMode: "required"
    },
    assurancePolicy: { ...DEFAULT_PROFILE_ASSURANCE },
    allowedChildProfiles: []
  });
}
