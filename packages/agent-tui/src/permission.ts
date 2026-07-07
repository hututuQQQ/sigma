import type { PermissionDecider, PermissionDecision, PermissionRequest } from "agent-core";

export type PermissionListener = () => void;

export class TuiPermissionController implements PermissionDecider {
  private readonly listeners = new Set<PermissionListener>();
  private pendingRequest: PermissionRequest | null = null;
  private resolveDecision: ((decision: PermissionDecision) => void) | null = null;

  onChange(listener: PermissionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get pending(): PermissionRequest | null {
    return this.pendingRequest;
  }

  async decide(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.pendingRequest) return "deny";
    this.pendingRequest = request;
    this.notify();
    return await new Promise<PermissionDecision>((resolve) => {
      this.resolveDecision = resolve;
    });
  }

  respond(decision: PermissionDecision): void {
    if (!this.resolveDecision) return;
    const resolve = this.resolveDecision;
    this.pendingRequest = null;
    this.resolveDecision = null;
    resolve(decision);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
