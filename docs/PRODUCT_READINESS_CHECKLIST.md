# Sigma Code 产品化验收清单

这份清单用于判断当前 Sigma Code 是否达到“可内部交付、可继续试用、可排障”的产品化状态，并记录本轮 Windows Public MVP 发布门禁。它不是 benchmark 适配器说明，也不是分数优化指南。

## 总门禁

默认产品门禁是：

```bash
pnpm verify:product
```

它必须覆盖：

- `pnpm lint`
- `pnpm test`
- `pnpm smoke:product`
- `pnpm smoke:tui-product`
- `pnpm verify:package:agent-cli:windows`
- `pnpm product:readiness`

`verify:product` 必须保持 benchmark-neutral，不应调用 `bench:*`、Harbor runner 或任何会把 benchmark identity / verifier output 注入 solving agent 的路径。

成功后还必须生成统一证据：

- `.artifacts/product-readiness.json`
- `.artifacts/product-readiness.md`

`product-readiness.json` 会聚合 CLI smoke、TUI smoke、package verify 和可选 live provider smoke。默认 `internalReady: true` 即代表达到内部试用/排障基线；本轮 `releaseReady: true` 还要求 Windows package 的 `targetPlatform: "win32"`、`targetWrapper.status: "passed"`，并且 DeepSeek live provider smoke 已通过。正式发布环境可以使用：

```bash
node scripts/product-readiness-report.mjs --require-release-ready --require-provider-smoke
```

真实 provider smoke 不在默认 `verify:product` 中，因为它需要 API key 和网络。发布前可以单独执行：

```bash
pnpm smoke:provider -- --provider deepseek
```

成功后会生成 `.artifacts/smoke-provider/provider-smoke.json`。如果只想在没有 key 的机器上记录 skipped 证据，可使用：

```bash
pnpm smoke:provider -- --allow-skip
```

## 产品 Smoke 证据

`pnpm smoke:product` 验证的路径是：

1. `agent version --json`
2. `agent init`
3. `agent doctor --json`
4. `agent run`，使用通用 fake model 写入 `hello.txt`
5. `agent inspect --json`
6. `agent jobs --json`
7. `agent artifacts --json`

成功后必须生成：

- `.artifacts/smoke-product/product-smoke.json`
- `.artifacts/smoke-product/workspace/.agent/sessions/<session-id>/artifacts.json`

`product-smoke.json` 至少要证明：

- `version` 来自 `agent-cli`
- `doctorStatus` 是 `ok` 或 `warning`
- `changedFiles` 包含 `hello.txt`
- `jobSummary.completed >= 1`
- `artifacts.manifest` 指向 session 的 `artifacts.json`

## TUI Smoke 证据

`pnpm smoke:tui-product` 验证的路径是：

1. 启动 built `TuiApp`，进入 alternate screen 并隐藏 cursor。
2. 使用通用 fake model 通过 TUI 提交一次真实 run。
3. 验证 run 完成并写入 `hello.txt`。
4. 打开 `/jobs`，验证 run state、session id 和 manifest 可见。
5. 打开 `/artifacts`，验证 changed files、final gate 和 `agent artifacts` 命令可见。
6. 退出 TUI，验证 raw mode、cursor 和 alternate screen 生命周期恢复。

成功后必须生成：

- `.artifacts/smoke-tui-product/tui-smoke.json`
- `.artifacts/smoke-tui-product/initial.txt`
- `.artifacts/smoke-tui-product/after-run.txt`
- `.artifacts/smoke-tui-product/jobs.txt`
- `.artifacts/smoke-tui-product/artifacts.txt`

`tui-smoke.json` 至少要证明：

- `ok: true`
- `checks.alternateScreen: true`
- `checks.cursorLifecycle: true`
- `checks.rawModeLifecycle: true`
- `checks.runCompleted: true`
- `checks.jobsPanel: true`
- `checks.artifactsPanel: true`
- `sessionId` 非空

## Windows CLI Bundle 证据

本轮 Public MVP 的发布包目标是 Windows x64：

```bash
pnpm package:agent-cli:windows
pnpm verify:package:agent-cli:windows
```

`pnpm verify:package:agent-cli:windows` 会先执行 Windows package，再检查 `.artifacts/agent-cli-win32-x64.zip`，并要求 `agent.cmd` 通过 bundled `node.exe` 真实启动。

成功后必须生成：

- `.artifacts/agent-cli-win32-x64.zip`
- `.artifacts/agent-cli-package-verify.json`

`agent-cli-package-verify.json` 必须包含：

- `ok: true`
- `targetPlatform: "win32"`
- `archive` 指向 `.artifacts/agent-cli-win32-x64.zip`
- `checks.requiredEntries`
- `checks.readme: true`
- `checks.wrapper: true`
- `checks.metadata: true`
- `checks.hostCli: true`
- `checks.targetWrapper`
- `hostCli.product: "Sigma Code"`
- `hostCli.package.name: "agent-cli"`
- `targetWrapper.status`

`checks.hostCli` 代表验收脚本已解包 zip，并用当前 host Node 执行了解包后的：

```text
packages/agent-cli/dist/index.js version --json
```

这证明 bundle 内 JS CLI 入口和 `node_modules` 布局可以启动。`checks.targetWrapper` 代表是否真实执行了解包后的：

```text
.\bin\agent.cmd version --json
```

在 Windows x64 发布验收环境中，verifier 会尝试真实执行 bundled `node.exe` wrapper。在非 Windows 或架构不匹配环境中，`targetWrapper.status` 可以是 `skipped`，并在 `targetWrapper.reason` 中说明原因。

一条命令跑完整 Windows release gate：

```bash
pnpm verify:release:windows
```

Linux tarball 路径仍保留给外部 adapter 和后续 Linux 发布验证：

```bash
pnpm package:agent-cli
pnpm verify:package:agent-cli
```

## TUI 工作台证据

TUI 应至少满足：

- 顶部状态栏显示 provider/model、mode、permission、run state。
- 主 transcript 不显示 raw `usage` 和 `context_budget` 噪声。
- 运行中 composer 使用 `queue >`。
- `/jobs` 显示 session id、manifest、queued input、validation/precheck 和 activity。
- `/artifacts` 显示 `artifacts.json` manifest、changed files、evidence、final gate，以及 `agent inspect` / `agent artifacts --json` 命令。

对应测试至少覆盖：

```bash
pnpm vitest run tests/agent-tui.app.test.ts tests/agent-tui.render.test.ts tests/agent-tui.formatters.test.ts
```

## 公平性边界

默认产品路径必须保持 benchmark-neutral：

- 不把 benchmark identity、task id、task name、dataset name、verifier output、verifier trace、reward、score 或 hidden test 传给 solving agent。
- 不使用 verifier feedback 或任何 post-verifier 信息重试 solving attempt。
- 不根据 benchmark 名称、任务名、fixture、package 名称、已知输出或隐藏测试细节调整 prompt、命令、清理、安装、重试或工具行为。
- benchmark 只能作为外部 adapter 启动 Sigma，并在运行结束后收集日志、trace、summary、report 和 score。

当公平性和分数冲突时，选择公平、可复用的产品路径。

## 尚未完全证明的事项

当前 `pnpm verify:product` 还不能证明：

- 如果 `.artifacts/agent-cli-package-verify.json` 中 `targetPlatform` 不是 `win32`，或 `targetWrapper.status` 不是 `passed`，当前机器还没有证明 Windows Public MVP 的 `.\bin\agent.cmd` 使用 bundled `node.exe` 真实执行成功。发布环境应补跑 `pnpm verify:package:agent-cli:windows`。
- Windows Terminal 下 TUI 的交互细节都经过人工端到端验收：启动、输入、运行中 `queue >`、`/jobs`、`/artifacts` 和退出恢复。
- 真实 provider API key 下的长任务稳定性、限流恢复和网络错误体验已经充分压测。
- 外部 SDK 入口已经稳定。

这些事项应作为后续 release hardening，而不是通过 benchmark shortcut 绕过。
