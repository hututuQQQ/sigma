import type { RuntimeSession } from "./types.js";

export function toolRuntimeContext(session: RuntimeSession) {
  const frontier = session.durable.state.mutationFrontier;
  return {
    goalEpoch: session.durable.state.messages.filter((message) => message.role === "user").length,
    mutationFrontierRevision: frontier.revision,
    mutationFrontierStateDigest: frontier.currentStateDigest
  };
}
