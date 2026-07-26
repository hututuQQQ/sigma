import { createHash } from "node:crypto";
import type {
  ArtifactPage,
  WorkspaceFrontierPage
} from "agent-protocol";
import {
  currentFrontierValidationStatus,
  frontierValidationReadiness,
  sessionProcessSettlementEvidence
} from "./mutation-evidence.js";
import type { RuntimeControlServiceOptions } from "./runtime-control-contracts.js";
import type { RuntimeSession } from "./types.js";

export class RuntimeInspectionControl {
  constructor(private readonly options: RuntimeControlServiceOptions) {}

  private frontierDigest(session: RuntimeSession): string {
    const frontier = session.durable.state.mutationFrontier;
    return createHash("sha256").update(JSON.stringify({
      revision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      paths: [
        ...frontier.changedPaths,
        ...(frontier.environmentChangedPaths ?? [])
      ].sort()
    })).digest("hex");
  }

  private frontierCursor(digest: string, offset: number): string {
    return Buffer.from(JSON.stringify({ digest, offset }), "utf8").toString("base64url");
  }

  private cursorOffset(cursor: string | undefined, digest: string): number {
    if (!cursor) return 0;
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
        digest?: unknown; offset?: unknown;
      };
      if (value.digest !== digest || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0) {
        throw new Error("stale");
      }
      return Number(value.offset);
    } catch {
      throw Object.assign(new Error("Workspace frontier cursor is invalid or stale."), {
        code: "frontier_cursor_stale"
      });
    }
  }

  readWorkspaceFrontier(
    session: RuntimeSession,
    input: { cursor?: string; limit?: number } = {}
  ): WorkspaceFrontierPage {
    const frontier = session.durable.state.mutationFrontier;
    const workspacePaths = [...frontier.changedPaths].sort();
    const environmentPaths = [...(frontier.environmentChangedPaths ?? [])].sort();
    const paths = [...workspacePaths, ...environmentPaths];
    const digest = this.frontierDigest(session);
    const offset = this.cursorOffset(input.cursor, digest);
    const limit = input.limit === undefined
      ? 100 : Math.min(500, Math.max(1, Math.trunc(input.limit)));
    if (offset > paths.length) {
      throw Object.assign(new Error("Workspace frontier cursor is beyond the current frontier."), {
        code: "frontier_cursor_stale"
      });
    }
    const page = paths.slice(offset, offset + limit);
    const validation = currentFrontierValidationStatus(session);
    const readiness = frontierValidationReadiness(session);
    const status = paths.length === 0 ? "not_needed" as const
      : validation.passed ? "passed" as const
        : validation.latestFailed ? "failed" as const
          : validation.hasRecord ? "incomplete" as const : "unverified" as const;
    const nextOffset = offset + page.length;
    return {
      revision: frontier.revision,
      stateDigest: frontier.currentStateDigest,
      frontierDigest: digest,
      total: paths.length,
      offset,
      workspacePathCount: workspacePaths.length,
      environmentPathCount: environmentPaths.length,
      paths: page,
      ...(nextOffset < paths.length ? { nextCursor: this.frontierCursor(digest, nextOffset) } : {}),
      validation: {
        status,
        recordCount: validation.validations.length,
        missingPathCount: readiness.missingPaths.length,
        missingClaimCount: readiness.missingClaims.length
      }
    };
  }

  async readArtifact(
    session: RuntimeSession,
    input: { artifactId: string; offsetBytes?: number; maxBytes?: number }
  ): Promise<ArtifactPage> {
    const lifecycleArtifacts = sessionProcessSettlementEvidence(session).flatMap((item) => {
      const diagnostic = item.data.diagnostic;
      if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return [];
      const artifactIds = (diagnostic as Record<string, unknown>).outputArtifactIds;
      return Array.isArray(artifactIds)
        ? artifactIds.filter((value): value is string =>
            typeof value === "string" && value.length > 0)
        : [];
    });
    const receipts = [
      ...session.durable.state.receipts,
      ...session.durable.state.reviewReceipts.map((item) => item.receipt)
    ];
    const allowed = new Set(receipts.flatMap((receipt) => [
        ...receipt.artifacts,
        ...(receipt.artifactRefs ?? []).map((item) => item.artifactId)
      ]).concat(lifecycleArtifacts));
    if (!allowed.has(input.artifactId)) {
      throw Object.assign(
        new Error(
          "Artifact is not referenced by a receipt or runtime lifecycle evidence in the current session."
        ),
        { code: "artifact_not_in_session_receipts" }
      );
    }
    const raw = this.options.readArtifactBytes
      ? await this.options.readArtifactBytes(session.identity.sessionId, input.artifactId)
      : Buffer.from(await this.options.readArtifact(session.identity.sessionId, input.artifactId), "utf8");
    const external = receipts.some((receipt) =>
      receipt.contentTrust === "external_untrusted"
      && (receipt.artifacts.includes(input.artifactId)
        || (receipt.artifactRefs ?? []).some((item) => item.artifactId === input.artifactId)));
    return this.artifactPage(input, Buffer.from(raw), external);
  }

  private artifactPage(
    input: { artifactId: string; offsetBytes?: number; maxBytes?: number },
    bytes: Buffer,
    externalUntrusted = false
  ): ArtifactPage {
    const offset = input.offsetBytes === undefined ? 0 : Math.trunc(input.offsetBytes);
    const maximum = input.maxBytes === undefined
      ? 8 * 1_024 : Math.min(64 * 1_024, Math.max(1, Math.trunc(input.maxBytes)));
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) {
      throw Object.assign(new Error("Artifact offsetBytes is outside the artifact."), {
        code: "artifact_offset_invalid"
      });
    }
    let end = Math.min(bytes.length, offset + maximum);
    let encoding: ArtifactPage["encoding"] = "utf8";
    let content = "";
    for (let trim = 0; trim <= 3; trim += 1) {
      try {
        const page = bytes.subarray(offset, end - trim);
        content = new TextDecoder("utf-8", { fatal: true }).decode(page);
        end -= trim;
        break;
      } catch {
        if (trim === 3) {
          const page = bytes.subarray(offset, end);
          encoding = "base64";
          content = page.toString("base64");
        }
      }
    }
    if (end === offset && end < bytes.length) {
      end = Math.min(bytes.length, offset + maximum);
      encoding = "base64";
      content = bytes.subarray(offset, end).toString("base64");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      artifactId: input.artifactId,
      digest,
      totalBytes: bytes.length,
      offsetBytes: offset,
      endOffsetBytes: end,
      ...(end < bytes.length ? { nextOffset: end } : {}),
      eof: end >= bytes.length,
      encoding,
      content,
      ...(externalUntrusted ? { contentTrust: "external_untrusted" as const } : {})
    };
  }
}
