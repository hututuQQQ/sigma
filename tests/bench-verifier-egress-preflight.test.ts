import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertVerifierEgressPreflightSelfSha256,
  buildVerifierEgressDockerArgs,
  parseVerifierEgressPreflightArgs,
  runVerifierEgressPreflight,
  verifierEgressPreflightSelfSha256
} from "../scripts/bench-verifier-egress-preflight.mjs";

describe("verifier egress preflight", () => {
  it("keeps the repository descriptor bound to the implementation", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const script = readFileSync(path.join(root, "scripts", "bench-verifier-egress-preflight.mjs"));
    const descriptor = JSON.parse(readFileSync(
      path.join(root, "scripts", "bench-verifier-egress-preflight.json"), "utf8"
    ));
    const expectedIndex = descriptor.args.indexOf("--expected-self-sha256") + 1;
    expect(expectedIndex).toBeGreaterThan(0);
    expect(descriptor.args[expectedIndex]).toBe(createHash("sha256").update(script).digest("hex"));
  });

  it("derives bounded parallelism from the verifier gate", () => {
    const options = parseVerifierEgressPreflightArgs([], {
      SIGMA_VERIFIER_CONCURRENCY: "4"
    });
    expect(options).toMatchObject({
      image: "ubuntu:24.04",
      httpsUrl: "https://example.com/",
      parallelism: 4,
      rounds: 1,
      maxAttempts: 2,
      attemptBackoffMs: 2_000
    });
    expect(() => parseVerifierEgressPreflightArgs([], {
      SIGMA_VERIFIER_CONCURRENCY: "5"
    })).toThrow(/between 1 and 4/iu);
  });

  it("passes only explicit proxy values into an ephemeral cached image", () => {
    const options = parseVerifierEgressPreflightArgs([
      "--parallelism", "2", "--rounds", "2"
    ], {});
    const args = buildVerifierEgressDockerArgs(options, {
      HTTP_PROXY: "http://host.docker.internal:7890",
      HTTPS_PROXY: "http://host.docker.internal:7890",
      NO_PROXY: "localhost,127.0.0.1,::1",
      UNRELATED_SECRET: "must-not-be-forwarded"
    });
    expect(args.slice(0, 5)).toEqual(["run", "--rm", "--pull=never", "--network", "bridge"]);
    expect(args).toContain("HTTP_PROXY=http://host.docker.internal:7890");
    expect(args).toContain("HTTPS_PROXY=http://host.docker.internal:7890");
    expect(args).not.toContain("UNRELATED_SECRET=must-not-be-forwarded");
    expect(args).toContain("ubuntu:24.04");
    expect(args.at(-2)).toBe("2");
    expect(args.at(-1)).toBe("https://example.com/");
  });

  it("runs one neutral bootstrap worker per verifier slot", async () => {
    const options = parseVerifierEgressPreflightArgs(["--parallelism", "3"], {});
    const workers: number[] = [];
    const result = await runVerifierEgressPreflight(options, {}, async (_command, _args, worker) => {
      workers.push(worker);
      return { worker, code: 0, signal: null, stdout: "", stderr: "" };
    });
    expect(workers).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ status: "passed", parallelism: 3, proxy_environment: "absent" });
    expect(result).toMatchObject({ attempts_used: 1, additional_attempts_used: 0 });
  });

  it("retries the complete cohort once without retrying any benchmark sample", async () => {
    const options = parseVerifierEgressPreflightArgs([
      "--parallelism", "2", "--max-attempts", "2", "--attempt-backoff-ms", "7"
    ], {});
    const workers: number[] = [];
    const delays: number[] = [];
    let calls = 0;
    const result = await runVerifierEgressPreflight(
      options,
      {},
      async (_command, _args, worker) => {
        workers.push(worker);
        calls += 1;
        const firstCohort = calls <= 2;
        return {
          worker,
          code: firstCohort && worker === 2 ? 1 : 0,
          signal: null,
          stdout: "",
          stderr: firstCohort && worker === 2 ? "temporary network failure" : ""
        };
      },
      async (milliseconds) => { delays.push(milliseconds); }
    );
    expect(workers).toEqual([1, 2, 1, 2]);
    expect(delays).toEqual([7]);
    expect(result).toMatchObject({
      status: "passed",
      max_attempts: 2,
      attempts_used: 2,
      additional_attempts_used: 1,
      attempt_results: [
        { attempt: 1, status: "failed", failed_workers: [{ worker: 2 }] },
        { attempt: 2, status: "passed", failed_workers: [] }
      ]
    });
  });

  it("stops after the bounded preflight attempt count", async () => {
    const options = parseVerifierEgressPreflightArgs([
      "--parallelism", "2", "--max-attempts", "2", "--attempt-backoff-ms", "0"
    ], {});
    let calls = 0;
    await expect(runVerifierEgressPreflight(
      options,
      {},
      async (_command, _args, worker) => {
        calls += 1;
        return { worker, code: 1, signal: null, stdout: "", stderr: "offline" };
      },
      async () => {}
    )).rejects.toThrow(/2\/2.+after 2 attempts/iu);
    expect(calls).toBe(4);
  });

  it("supports a descriptor-bound self digest", () => {
    const digest = verifierEgressPreflightSelfSha256();
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(assertVerifierEgressPreflightSelfSha256(digest)).toBe(digest);
    expect(() => assertVerifierEgressPreflightSelfSha256("f".repeat(64))).toThrow(/does not match/iu);
  });
});
