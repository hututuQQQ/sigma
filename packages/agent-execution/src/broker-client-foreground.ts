import { verifiedShellExecutables, verifiedTargetExecutableEnvironment } from "./broker-doctor-projection.js";
import {
  assertRequestSandbox,
  containPostDispatchFailure,
  decodedExecutionResult,
  outputDecodingError,
  rejectUndecodableExecution,
  requestExecutionValue,
  runPostResponseOperation,
  type BrokerPostResponseOperations
} from "./broker-client-support.js";
import type { BrokerTransport } from "./broker-transport.js";
import type { BrokerOutputArtifactImporter } from "./output-artifact-import.js";
import { positiveInteger, requestParams } from "./broker-request-policy.js";
import type { SecretRedactor } from "./redaction.js";
import type { NormalizedTrustedToolchain } from "./trusted-toolchains.js";
import type {
  BrokerDoctorReport,
  BrokerRequestOptions,
  ExecutionRequest,
  ExecutionResult,
  SigmaExecBrokerClientOptions
} from "./types.js";

export interface BrokerForegroundContext {
  transport: BrokerTransport;
  options: SigmaExecBrokerClientOptions;
  trustedToolchains: NormalizedTrustedToolchain[];
  doctorValue?: BrokerDoctorReport;
  postResponseOperations: BrokerPostResponseOperations;
  outputArtifacts: BrokerOutputArtifactImporter;
  redactor: SecretRedactor;
  closeForActiveOperation(): Promise<void>;
  close(): Promise<void>;
}

export async function executeBrokerForeground(
  context: BrokerForegroundContext,
  request: ExecutionRequest,
  options: BrokerRequestOptions
): Promise<ExecutionResult> {
  assertRequestSandbox(request.policy, context.doctorValue);
  const timeoutMs = positiveInteger(request.timeoutMs, 120_000, "timeoutMs");
  const params = {
    ...requestParams(
      request, context.options, context.trustedToolchains,
      verifiedShellExecutables(context.doctorValue),
      verifiedTargetExecutableEnvironment(context.options.executionBackend, context.doctorValue)
    ),
    timeoutMs,
    ...(request.idleTimeoutMs === undefined ? {} : {
      idleTimeoutMs: positiveInteger(request.idleTimeoutMs, 30_000, "idleTimeoutMs")
    })
  };
  return await runPostResponseOperation(context.postResponseOperations, async () => {
    const value = await requestExecutionValue(
      context.transport, params, options, timeoutMs, context.closeForActiveOperation
    );
    const decodingError = outputDecodingError(value);
    if (decodingError) {
      await rejectUndecodableExecution(
        context.transport, value, decodingError, context.closeForActiveOperation
      );
    }
    const outputArtifacts = await context.outputArtifacts.consume(value.outputArtifacts).catch(
      async (error: unknown) => await containPostDispatchFailure(
        error, context.closeForActiveOperation
      )
    );
    return decodedExecutionResult(value, context.redactor, outputArtifacts);
  }, context.close);
}
