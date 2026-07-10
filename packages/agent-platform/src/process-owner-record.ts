export interface ProcessOwnerRecord {
  pid: number;
  instanceId: string;
  startedAt: string;
  processMarker?: string;
}

export function validOwner(value: unknown): ProcessOwnerRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ProcessOwnerRecord>;
  if (!Number.isInteger(candidate.pid) || Number(candidate.pid) <= 0) return undefined;
  if (typeof candidate.instanceId !== "string" || candidate.instanceId.length === 0) return undefined;
  if (typeof candidate.startedAt !== "string" || !Number.isFinite(Date.parse(candidate.startedAt))) return undefined;
  if (candidate.processMarker !== undefined
    && (typeof candidate.processMarker !== "string" || candidate.processMarker.length === 0)) return undefined;
  return candidate as ProcessOwnerRecord;
}

export function legacyOwner(source: string): ProcessOwnerRecord | undefined {
  const match = /^(\d+)(?:\s+(\S+))?\s*$/u.exec(source);
  if (!match?.[1]) return undefined;
  const pid = Number.parseInt(match[1], 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const startedAt = match[2] && Number.isFinite(Date.parse(match[2])) ? match[2] : new Date(0).toISOString();
  return { pid, instanceId: "legacy-pid-lock", startedAt };
}
