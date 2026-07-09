# Sigma Code 快速开始

这份文档面向第一次使用 Sigma Code 的用户，目标是在一个真实 workspace 里完成初始化、自检、首次运行和交付证据查看。

## 1. 初始化 Workspace

在项目根目录运行：

```bash
agent version --json
agent init --workspace .
```

这会生成 `.agent/config.toml`。默认 profile 是 `local`，适合本地交互式开发：

- provider 默认 `deepseek`
- permission mode 默认 `ask`
- sandbox 默认 `workspace-write`
- validation 默认 `auto`
- TUI stream UI 默认开启

团队或 CI 可以使用更严格的 profile：

```bash
agent init --workspace . --profile team
agent init --workspace . --profile ci
```

`team` 和 `ci` 会启用 `sandbox.required=true`，让 sandbox 不可用时 fail closed。

## 2. 配置 Provider Key

DeepSeek：

```powershell
$env:DEEPSEEK_API_KEY="..."
```

GLM / Z.ai：

```powershell
$env:ZAI_API_KEY="..."
```

也可以使用 `GLM_API_KEY` 或 `BIGMODEL_API_KEY`。

## 3. 自检

先检查本地配置、workspace、provider key 和 sandbox：

```bash
agent doctor --workspace .
```

需要连通模型 API 时再加：

```bash
agent doctor --workspace . --check-api
```

CI 或发布前 readiness gate 可以使用结构化输出：

```bash
agent doctor --workspace . --json --strict
```

如果 doctor 提示 OS sandbox 不可用，而你又需要 fail closed，请使用：

```bash
agent init --workspace . --profile team --force
```

或手动设置 `.agent/config.toml`：

```toml
[sandbox]
required = true
```

## 4. 进入 TUI

```bash
agent tui --workspace .
```

TUI 是主要产品入口。当前工作台包含：

- 顶部状态栏：provider/model、mode、permission、sandbox、run state。
- Transcript：用户消息、assistant 回复、重要工具摘要、验证结果。
- Workbench：文件、变更、activity、checks、token usage。
- Composer：空闲时 `>`，运行中 `queue >`，审批时 `approval >`。

常用命令：

- `/status` 查看当前运行设置。
- `/files` 打开 workbench。
- `/tools` 查看 recent activity。
- `/context` 查看 context 和 skills 状态。
- `/tokens` 查看 token usage。
- `/sessions` 查看 durable sessions。
- `/session <id>` 查看 session 摘要。
- `/jobs` 查看当前 run、queued input、activity 和 validation/precheck 摘要。
- `/artifacts` 查看 `artifacts.json` manifest、changed files、evidence 和 CLI inspect/artifacts 命令。

## 5. 非交互运行

```bash
agent run "修复失败测试" --workspace .
```

CI 或脚本里建议输出 JSON：

```bash
agent run "修复失败测试" --workspace . --output-format json
```

## 6. 查看交付证据

运行结束后，可以直接查看最近一次 session 的交付状态、产物路径和验证证据：

```bash
agent session show --latest --workspace .
```

重点关注：

- `artifacts`：`artifacts.json` manifest、summary、events、trace、session JSONL、run summary 和 checkpoint 路径。
- `changed`：本次 run 修改过的文件。
- `evidence`：final gate、validation、precheck、attempts 和 evidence records。

需要机器可读输出时：

```bash
agent session show --latest --workspace . --json
```

更短的入口是：

```bash
agent inspect --workspace .
agent inspect --workspace . --json
agent jobs --workspace .
agent artifacts --workspace .
```

也可以先列出历史 session，再查看指定 session：

```bash
agent sessions --workspace .
agent session show <session-id> --workspace .
```

## 产品边界

Sigma Code 的默认产品路径不是 benchmark runner。Benchmark 只能作为外部 adapter 启动 Sigma 并在运行后收集结果；不能把 task id、verifier output、score、hidden test 等信息传给 solving agent，也不能基于 verifier feedback 重试。

## 产品 Smoke

发布或打包前可以跑一条不依赖外部 API key 的产品路径 smoke：

```bash
pnpm verify:product
pnpm smoke:product
pnpm smoke:tui-product
pnpm verify:package:agent-cli:windows
pnpm product:readiness
```

本轮 Public MVP 的发布包目标是 Windows x64。打包后会生成 `.artifacts/agent-cli-win32-x64.zip`，解压后可以在 PowerShell 或 Windows Terminal 中运行：

```powershell
.\bin\agent.cmd version --json
.\bin\agent.cmd init --workspace D:\path\to\repo
.\bin\agent.cmd doctor --workspace D:\path\to\repo --json --strict
.\bin\agent.cmd tui --workspace D:\path\to\repo --provider deepseek
```

详细验收清单见 `docs/PRODUCT_READINESS_CHECKLIST.md`。

`smoke:product` 会在 `.artifacts/smoke-product` 下创建临时 workspace，并验证：

```text
agent version -> agent init -> agent doctor -> agent run(fake model) -> agent inspect -> agent jobs -> agent artifacts
```

这个 smoke 使用通用 fake model 验证产品入口和 session/evidence/artifact inspection，不使用 benchmark task identity、verifier output 或 hidden test 信息。

`smoke:tui-product` 会在 `.artifacts/smoke-tui-product` 下启动 built TUI，验证 alternate screen、cursor/raw mode 生命周期、一次 fake-model run，以及 `/jobs`、`/artifacts` 面板的关键产品信息。

`product:readiness` 会聚合上述证据，写入 `.artifacts/product-readiness.json` 和 `.artifacts/product-readiness.md`。默认用于内部试用/排障基线；正式发布可运行 `pnpm verify:release:windows`，要求 Windows wrapper 和 DeepSeek live provider smoke 都真实通过。

真实 provider 稳定性 smoke 需要 API key 和网络，因此不在默认 `verify:product` 中。发布前可单独运行：

```bash
pnpm smoke:provider -- --provider deepseek
```

它会生成 `.artifacts/smoke-provider/provider-smoke.json`，供 `product:readiness` 聚合为 release-hardening 证据。

Windows TUI 发布验收还需要一次人工 signoff：在 Windows Terminal 下运行解压后的 `.\bin\agent.cmd tui`，确认启动、输入、运行中 `queue >`、`/jobs`、`/artifacts` 和退出恢复都正常。
