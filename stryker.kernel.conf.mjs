export default {
  mutate: ["packages/agent-kernel/src/durable-reducers.ts"],
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  concurrency: 4,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: ".artifacts/mutation/kernel.json" },
  thresholds: { high: 80, low: 80, break: 80 },
  vitest: { configFile: "vitest.mutation.kernel.config.ts", related: false },
  tempDirName: ".stryker-tmp/kernel"
};
