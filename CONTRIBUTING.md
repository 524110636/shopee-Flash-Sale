# Contributing

欢迎贡献！本项目是为 Shopee 台湾站卖家打造的限时特卖自动化工具（Chrome MV3 扩展 + Node/Hono 后端）。

## 快速开始

先按 README 的快速开始跑通本地开发：扩展 + 后端 + 数据库 seed。改代码前请先读 `AGENTS.md`、`OWNER_WORKING_RULES.md`、`PROJECT_STATUS.md`，以及 `docs/手册/` 里对应任务的那一份，不要一次读完。

## 提 PR 前

- 一个 PR 只做一件事，标题写清改了什么、为什么。
- 改了源码符号名 / 字段名 / 文件位置，同步更新相关手册，不要写死行号。
- 新增或修改现行约束，在手册里写清「要求 + 为什么」，只写要求不写原因视为未完成。
- 跑通相关测试：`npm run test:unit`，涉及后端跑 `backend` 相关测试，涉及扩展跑 E2E。
- 不要提交真实密钥、Cookie、店铺凭据、`.env`、后端 `data/`、测试产物（`playwright-report/`、`test-results/`、`vitest-report/`）。
- 不要提交 `SSH_CONNECT.md`、`harness/账号密码.md` 等明文凭据文件。

## Codex 在维护流程里的用法

本项目把 Codex 用在核心维护流程里，而不是只用来写代码：

- **PR review**：用 Codex 做独立复核，重点看红线（开卖循环必须在 background、SPC_CDS 必须从 Cookie 现读、状态比较、SKU override 字段、试用校验与消耗分离、权限查库不信 JWT claim）。
- **Triage**：用 Codex 归类 Issue / 复现步骤 / 影响范围，先给最小复现再动手修。
- **发版**：用 Codex 对照 `PROJECT_STATUS.md` 做发版检查、写 Release Notes、确认测试套件全通过再发。
- **维护自动化**：用 Codex 跑回归、整理 CHANGELOG、同步手册与代码。

## Issue 规范

标题写清现象 + 影响，内容包含：复现步骤、期望结果、实际结果、环境（扩展版本 / 后端版本 / 浏览器 / 店铺类型）、相关日志（脱敏，SPC_CDS 一律打码）。

## 行为准则

见 `CODE_OF_CONDUCT.md`。
