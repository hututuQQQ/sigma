export class WorkspaceTransactionRootError extends Error {
  readonly code = "workspace_transaction_root_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceTransactionRootError";
  }
}
