import { SNAPSHOT_SCHEMA_VERSION, STORE_LAYOUT_VERSION, type RunStore, type SnapshotEnvelope } from "agent-protocol";
import { jsonValue } from "./json.js";
import type { RuntimeSession } from "./types.js";

export async function persistRuntimeSnapshot(store: RunStore, session: RuntimeSession): Promise<void> {
  const snapshot: SnapshotEnvelope = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    storeLayoutVersion: STORE_LAYOUT_VERSION,
    sessionId: session.identity.sessionId,
    seq: session.durable.seq,
    createdAt: new Date().toISOString(),
    state: jsonValue({ ...session.durable.state, lastSeq: session.durable.seq })
  };
  await store.writeSnapshot(snapshot);
}
