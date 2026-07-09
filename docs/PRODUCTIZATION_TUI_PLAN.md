# Sigma Code 产品化与 TUI 方案

## 产品定位

Sigma Code 是本地优先、可私有部署、带验证闭环的 coding agent runtime。它的核心价值不是 benchmark runner，而是把 coding agent 的执行过程变成可审计、可恢复、可验证的工程工作流。

产品叙事应该围绕三件事展开：

- 可靠执行：统一 runtime 负责 agent turn、工具调用、权限、sandbox、validation、final evidence、memory、MCP 和 subagent。
- 可审计证据：每次 run 都留下 summary、events、trace、session JSONL、checkpoint、changed files、validation/precheck 和 artifact manifest。
- 高质量终端工作台：TUI 是主要交互入口，CLI/CI/SDK 复用同一套 runtime contract。

## 调研依据

本方案参考了 `D:\software\agent-harness-research` 中的 Pi Agent/Harness/TUI 和 CodeWhale runtime/tool/subagent/profile 文档。

Pi 侧重点：

- `pi/packages/agent/README.md`：低层 agent loop、事件流、工具执行、steering 和 follow-up 队列。
- `pi/packages/agent/docs/agent-harness.md`：session 状态、操作阶段、snapshot、pending writes 和 save point。
- `pi/packages/agent/docs/durable-harness.md`：append-only session 作为事实源，支持半持久化恢复。
- `pi/packages/coding-agent/docs/tui.md`：TUI composer、输入队列、命令、session tree 和终端交互体验。

CodeWhale 侧重点：

- `CodeWhale/docs/AGENT_RUNTIME.md`：一套 runtime 支撑多个 launcher，并保持共享执行语义。
- `CodeWhale/docs/TOOL_SURFACE.md`：结构化工具优先，shell 作为 escape hatch，大输出沉淀为 artifact。
- `CodeWhale/docs/SUBAGENTS.md`：角色化 subagent、compact receipt 和 inspection handle。
- `CodeWhale/docs/rfcs/HARNESS_PROFILE_CUTLINE.md`：显式 policy profile，禁止静默自优化 profile mutation。

Sigma 可以吸收 Pi 在 runtime/TUI 操作模型上的清晰抽象，同时保留 Sigma 已经具备的 validation、permission、sandbox、MCP、memory、subagent 和 anti-gaming review gate。

## 架构路线

Sigma 应收敛成四层产品架构。

1. Runtime Core

   Runtime Core 负责 agent turn、工具执行、session 状态、validation、final evidence、memory、redaction、permission、sandbox、MCP 和 subagent。TUI、CLI、CI 和未来 SDK 都应观察同一套 runtime event，不应各自分叉执行语义。

2. Run Controller / Validation Controller / Evidence Store

   产品概念应强调执行和证据，而不是 benchmark。`RunController`、`ValidationController` 和 `EvidenceStore` 是产品路径；benchmark runner 只能作为外部 adapter 启动 Sigma，并在运行结束后收集输出。

3. Surface Layer

   - `agent tui`：主要交互式工作台。
   - `agent run`：面向脚本和 CI 的非交互执行入口。
   - `agent inspect` / `agent jobs` / `agent artifacts`：查看 session、trace、artifact 和验证证据。
   - 未来 SDK：复用同一套 runtime contract，不重新定义执行语义。

4. Extension Layer

   短期不做完整插件市场。先稳定 provider profile、tool registry entry、command registry entry、prompt/skill/resource resolver，以及后续 TUI widget 或 panel 的扩展边界。

## TUI 工作台设计

TUI 应该像一个工作台，而不是原始事件日志。

Top Bar：

- 正常高度终端中始终可见。
- 展示产品标识、provider/model、mode、permission mode、sandbox state 和 run state。
- 让用户不用打开 `/status` 也能看到关键运行状态。

Transcript：

- 展示用户消息、assistant 回复、重要工具摘要、审批请求、验证结果、变更文件和最终总结。
- 隐藏内部 telemetry，例如 raw `usage` event 和 `context_budget` event。
- 对 secret 做 redaction，并保证每一行不超过终端宽度。

Activity / Workbench：

- 展示文件、变更、近期工具、检查、token 使用量和验证证据。
- 长输出应沉淀为 artifact 或 handle，而不是直接刷满 transcript。
- 工作台 panel 覆盖 jobs、subagents、artifacts、MCP 和 permissions。

Composer：

- 空闲输入使用 `>`。
- 审批输入使用 `approval >`。
- 运行中输入使用 `queue >`，因为当前 Sigma 行为是把输入排队为下一轮 follow-up。
- 已排队指令继续显示在输入框下方。

Commands：

- 保持现有命令兼容。
- 产品化命令优先围绕 `/jobs`、`/artifacts`、`/permissions`、`/settings`、`/sessions` 和 `/session` 完善。

## 阶段路线

Phase 1：TUI polish

- 启用 top bar 和 notice。
- 从主 transcript 移除 usage/context budget 噪声。
- 明确运行中输入是 queued follow-up。
- 保持 public API 和 runtime 行为不变。

Phase 2：产品级状态模型

- 引入稳定的内部 TUI run state view model。
- 让 top bar、bottom status、composer、`/status` 和 `/jobs` 使用同一套状态语义。
- 继续拆分 transcript、activity、artifacts 和 validation evidence。

Phase 3：持久化工作台能力

- 增加更完整的 session tree、fork/compact workflow、jobs panel、artifacts panel 和 subagent receipt。
- 子 agent transcript 通过 handle 检查，不直接注入父 agent transcript。

Phase 4：打包与文档

- 完善 first-run docs、`agent init`、`agent doctor`、provider profile 文档、CI 示例和安装打包流程。
- 本轮 Public MVP 先以 Windows x64 bundle 作为发布主路径，Linux/macOS 后续补齐。
- 稳定自动化场景需要的 JSON 输出和 session inspection contract。

## 当前落地基线

当前仓库已落地：

- `docs/GETTING_STARTED.md`：首次使用、TUI、非交互运行、证据查看和产品 smoke。
- `docs/PRODUCT_READINESS_CHECKLIST.md`：产品门禁、bundle 验收、TUI 证据和公平性边界。
- `agent init`、`agent doctor`、`agent version`。
- `agent inspect`、`agent jobs`、`agent artifacts`。
- durable session `artifacts.json` manifest。
- `pnpm smoke:product` 和 `pnpm verify:product`。
- `pnpm smoke:tui-product`：自动启动 built TUI，验证 alternate screen、cursor/raw mode 生命周期、fake-model run、`/jobs` 和 `/artifacts`。
- `pnpm verify:package:agent-cli:windows`：生成并验收 `.artifacts/agent-cli-win32-x64.zip`，要求 `.\bin\agent.cmd version --json` 通过 bundled `node.exe` 真实启动。
- `pnpm verify:package:agent-cli`：保留 Linux tarball 路径，服务外部 adapter 和后续 Linux 发布验证。
- `pnpm product:readiness`：聚合 CLI smoke、TUI smoke 和 package verify，生成 `.artifacts/product-readiness.json` / `.artifacts/product-readiness.md`，区分 `internalReady` 与 Windows Public MVP 的 `releaseReady`。
- `pnpm smoke:provider`：可选真实 provider smoke，需要 API key 和网络；本轮 release gate 使用 DeepSeek，成功后生成 `.artifacts/smoke-provider/provider-smoke.json`，作为 `releaseReady` 的 live-provider 稳定性证据。
- TUI Phase 1 polish。
- TUI Phase 2 run-state 基线：`TuiRunState` 统一 idle/running/approval/cancelling/queued/completed/stopped/error、composer prompt、queued count 和 last result。

## Benchmark 公平性边界

Sigma 默认产品路径中不能包含 benchmark-directed behavior。

允许：

- 外部 benchmark runner 选择任务、启动 Sigma，并在运行结束后收集日志、trace、report、score 和 verifier result。
- 通用验证可以使用用户提供的命令、summary 声明的命令、变更文件语法检查，或广泛适用的项目约定。

禁止：

- 把 benchmark 名称、task ID、task hint、verifier failure、verifier trace、reward、score 或 hidden test 细节传给 solving agent。
- 使用 verifier feedback 或任何 post-verifier 信息重试 solving attempt。
- 基于 benchmark identity 分支 prompt、命令、安装、清理、重试或工具行为。
- 在默认 agent、CLI、TUI、harness 或 portable runtime 路径中保留 benchmark-specific shortcut。

拿不准时，Sigma 应宁愿接受更低的 benchmark 分数，也不要引入不公平、不可复用、非用户产品化的行为。
