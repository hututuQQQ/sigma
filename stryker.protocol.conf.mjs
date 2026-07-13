export default {
  mutate: [
    "packages/agent-protocol/src/domain-schemas.ts",
    "packages/agent-protocol/src/event-payload-schemas-*.ts"
  ],
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  concurrency: 4,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: ".artifacts/mutation/protocol.json" },
  thresholds: { high: 90, low: 90, break: 90 },
  vitest: { configFile: "vitest.mutation.protocol.config.ts", related: false },
  tempDirName: ".stryker-tmp/protocol"
};
