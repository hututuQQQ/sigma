export interface RepositoryMetadataLeaseRequest {
  protocolVersion: 1;
  repositoryRoot: string;
  gitDir: string;
  commonDir: string;
  executable: string;
  network: "none";
}

export interface RepositoryMetadataLease extends RepositoryMetadataLeaseRequest {
  leaseId: string;
  /** SHA-256 of the exact executable object pinned when the broker issued the lease. */
  executableSha256: string;
  /** Capabilities are deliberately single-use and are burned before launch. */
  uses: 1;
}
