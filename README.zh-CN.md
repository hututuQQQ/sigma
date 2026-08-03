<p align="center">
  <img src="assets/sigma-code-mark.png" alt="Sigma Code 标志" width="170">
</p>

<h1 align="center">Sigma Code</h1>

<p align="center">
  一个能越过中断、并用证据证明改动的开源 Coding Agent。<br>
  在原生沙箱中执行长任务，随时恢复，验证完成后再交付。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/hututuQQQ/sigma/releases/tag/v0.1.5"><img alt="状态：0.1.5 稳定版" src="https://img.shields.io/badge/status-0.1.5%20stable-2ea44f"></a>
  <img alt="发布目标：Linux 稳定版与 Windows 未签名预览版" src="https://img.shields.io/badge/release%20targets-Linux%20stable%20%2B%20Windows%20unsigned%20preview-0078d4">
  <img alt="正式评测：已预注册" src="https://img.shields.io/badge/formal%20evaluation-preregistered-4cc9c0">
</p>

<p align="center">
  <a href="https://sigmacode.biz"><strong>官方网站</strong></a>
  · <a href="https://sigmacode.biz/docs/getting-started"><strong>使用文档</strong></a>
  · <a href="https://github.com/hututuQQQ/sigma/releases/tag/v0.1.5"><strong>下载 v0.1.5</strong></a>
  · <a href="SECURITY.md">安全策略</a>
</p>

<p align="center">
  <img src="assets/sigma-code-desktop.png" alt="Sigma Code 桌面端通过 Sigma Runtime 分析代码仓库" width="1200">
</p>

Sigma Code 面向不能丢失现场、也不能过早宣布完成的真实代码任务。命令必须在原生沙箱中运行，完整工作会话会持久化以支持恢复；发生改动后，只有当前验证和必要审查都满足，任务才会完成。

本仓库维护 Sigma Runtime、CLI、TUI 与 ACP v1 服务。独立维护的 [Sigma Code 桌面、Web 与移动客户端](https://github.com/hututuQQQ/sigma-code) 是 [T3 Code](https://github.com/pingdotgg/t3code) 的下游项目，通过 ACP v1 连接本运行时。

> [!IMPORTANT]
> **0.1.5 是当前支持基线。** Linux x64 为稳定版；Windows x64 为未签名预览版，可能触发 Windows 安全警告。安装前请核对发布的 SHA-256 侧文件与签名来源证明。

## 为什么选择 Sigma Code

| 能力 | 意义 |
| --- | --- |
| 原生沙箱执行 | 命令必须在操作系统级隔离中运行；沙箱异常时，Sigma 会拒绝执行。 |
| 耐久会话 | 计划、模型回合、工具回执、检查点和结果不会随终端关闭或进程重启而消失。 |
| 证据式完成 | 模型的一段总结不能关闭已发生改动的任务；必须具备当前验证和必要审查证据。 |
| 一套运行时，多种界面 | 桌面端、TUI、单次 CLI 与自动化共用同一事件驱动运行时。 |

## 快速开始

### Windows 桌面端

从 [v0.1.5 发布页](https://github.com/hututuQQQ/sigma/releases/tag/v0.1.5)下载 `Sigma-Code-0.1.5-x64.exe`。安装包已经包含桌面 UI 与经过验证的 Sigma Runtime，不需要单独安装 Node.js 或 Agent CLI。

Windows 产物目前仍是未签名预览版。运行前请阅读[安装与验证说明](https://sigmacode.biz/docs/getting-started)。

### Linux CLI 与 TUI

下载并核对 Linux x64 发布包，然后初始化目标仓库：

```sh
SIGMA="$HOME/.local/share/sigma-code"
WORKSPACE="/path/to/your/repository"

export DEEPSEEK_API_KEY="your-api-key"

"$SIGMA/bin/agent" init --workspace "$WORKSPACE" --provider deepseek
"$SIGMA/bin/agent" doctor --workspace "$WORKSPACE" --check-api
"$SIGMA/bin/agent" tui --workspace "$WORKSPACE"
```

不要把密钥写入 `.agent/config.toml` 或版本控制。Windows 终端包、其他 Provider、权限、会话命令和 reasoning level 请查阅 [CLI 与配置参考](https://sigmacode.biz/docs/cli-and-configuration)。

## 能做什么

- 通过桌面客户端、支持 CJK/IME 的 TUI、单次 `run` 或只读 `inspect` 工作。
- 在进程中断后恢复、重放、steer、取消和审计耐久会话。
- 读取和修改仓库、运行命令、使用 LSP 代码智能，并连接显式信任的 MCP Server。
- 在 Windows AppContainer 或 Linux namespace 中执行，并声明文件、进程和网络影响。
- 通过明确的 writer 隔离和集成流程协调有边界的子 Agent。
- 在类型化证据账本中记录测试、验证、审查、工作区变化和检查点。
- 通过固定版本的 Pi 网关连接多个模型 Provider，包括实验性的 ChatGPT/Codex 订阅连接。

## 文档

完整产品与技术文档放在官网：

| 指南 | 内容 |
| --- | --- |
| [快速入门](https://sigmacode.biz/docs/getting-started) | 发行包、验证、Linux 与 Windows 设置、第一个任务 |
| [CLI、配置与 Provider](https://sigmacode.biz/docs/cli-and-configuration) | 命令、TUI 控制、权限、认证与 reasoning level |
| [Runtime 架构](https://sigmacode.biz/docs/architecture) | 组合根、事件循环、包边界与 ACP v1 |
| [安全、权限与恢复](https://sigmacode.biz/docs/security-and-recovery) | 原生沙箱、路径和网络边界、耐久状态与完成协议 |
| [耐久会话](https://sigmacode.biz/features/durable-sessions) | 事件流、检查点、重放与恢复 |
| [原生沙箱](https://sigmacode.biz/features/native-sandbox) | Windows AppContainer 与 Linux namespace |
| [证据式完成](https://sigmacode.biz/features/evidence-backed-completion) | 验证、审查与当前状态证据 |
| [评测方法](https://sigmacode.biz/docs/evaluation) | 预注册、公平边界、结果与限制 |

仓库维护者资料继续与代码放在一起：

- [CONTRIBUTING.md](CONTRIBUTING.md) — 开发流程与贡献要求
- [VALIDATION.md](VALIDATION.md) — 测试层级、覆盖率、原生检查与发布证据
- [RELEASING.md](RELEASING.md) — 打包和发布流程
- [SECURITY.md](SECURITY.md) — 支持版本、信任边界与漏洞报告

## 透明评测

2026 年 7 月 27–28 日的分阶段 Terminal-Bench 2.1 诊断使用 DeepSeek `deepseek-v4-pro`、相同的 89 个任务、Sigma 每任务一次尝试、零重试、无验证器反馈。Sigma Code 完成 **51/89（57.303%）**，OpenCode 完成 **49/89（55.056%）**。

这是混合源码的工程诊断，不是“全面优于其他工具”的结论，也不是最终源码 Head 的单一得分。比较数字前请先阅读[方法、公平规则与限制](https://sigmacode.biz/docs/evaluation)。

## 开发

仓库固定使用 Node.js `26.4.0`、pnpm `11.7.0` 与 Rust `1.96.0`。

```powershell
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm test:coverage
```

修改 Runtime、沙箱、持久化或评测行为前，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [VALIDATION.md](VALIDATION.md)。

## 许可证

Sigma Code 采用 [MIT License](LICENSE)。
