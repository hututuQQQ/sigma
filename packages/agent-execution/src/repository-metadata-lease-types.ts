export interface RepositoryMetadataLeaseRequestV1 {
  protocolVersion: 1;
  repositoryRoot: string;
  gitDir: string;
  commonDir: string;
  executable: string;
  network: "none";
}

export interface RepositoryMetadataLeaseV1 extends RepositoryMetadataLeaseRequestV1 {
  leaseId: string;
  /** SHA-256 of the exact executable object pinned when the broker issued the lease. */
  executableSha256: string;
  /** Capabilities are deliberately single-use and are burned before launch. */
  uses: 1;
}
