import type { RunStore, SnapshotEnvelope } from "agent-protocol";
import { jsonValue } from "./json.js";
import type { RuntimeSession } from "./types.js";

export async function persistRuntimeSnapshot(store: RunStore, session: RuntimeSession): Promise<void> {
  const snapshot: SnapshotEnvelope = {
    schemaVersion: 2,
    sessionId: session.sessionId,
    seq: session.seq,
    createdAt: new Date().toISOString(),
    state: jsonValue({ ...session.state, lastSeq: session.seq })
  };
  await store.writeSnapshot(snapshot);
}
