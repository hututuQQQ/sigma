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
