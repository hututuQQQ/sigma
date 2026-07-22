import path from "node:path";
import { BrokerTransport } from "./broker-transport.js";
import { BrokerPolicyError } from "./errors.js";
import type {
  BrokerRequestOptions,
  RepositoryMetadataLeaseRequestV1,
  RepositoryMetadataLeaseV1
} from "./types.js";
import { parseRepositoryMetadataLease } from "./values.js";

export async function requestRepositoryMetadataLease(
  transport: BrokerTransport,
  request: RepositoryMetadataLeaseRequestV1,
  options: BrokerRequestOptions
): Promise<RepositoryMetadataLeaseV1> {
  if (request.protocolVersion !== 1 || request.network !== "none") {
    throw new BrokerPolicyError("Repository metadata lease requests must be protocol V1 and local-only.");
  }
  for (const [name, value] of Object.entries({
    repositoryRoot: request.repositoryRoot,
    gitDir: request.gitDir,
    commonDir: request.commonDir
  })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new BrokerPolicyError(`Repository metadata ${name} must be absolute.`);
    }
  }
  return parseRepositoryMetadataLease(await transport.request("repositoryMetadata.acquire", {
    repositoryRoot: path.resolve(request.repositoryRoot),
    gitDir: path.resolve(request.gitDir),
    commonDir: path.resolve(request.commonDir),
    executable: request.executable,
    network: "none"
  }, options));
}


