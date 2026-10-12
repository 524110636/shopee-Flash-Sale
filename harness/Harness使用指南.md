# CLAUDE.md — 限时特卖助手项目说明

## 1. 项目概览

Chrome MV3 扩展 "限时特卖助手"，用于虾皮卖家后台（seller.shopee.tw）限时特卖活动的自动创建与商品参数批量提交。适用于手动复制活动、定时调度、以及全自动多轮循环场景。

**技术栈:**
- WXT 0.20.25 — Chrome MV3 扩展框架 (Vite 底层)
- React 19 + TypeScript 6.0 — UI 层
- Zustand 5 — 单一状态管理
- Tailwind CSS 3.4 + shadcn/ui — 样式
- Playwright 1.59 — 扩展测试与诊断
- 构建产物: `.output/chrome-mv3/`

**源码入口 (entrypoints/):**
- `popup/` — 弹窗 UI (App.tsx, store.ts, api.ts, types.ts)
- `background.ts` — Service Worker (限时特卖循环、复制流程、自动模式)
- `content.ts` — 内容脚本 (浮动进度 UI、消息中继)

---

## 2. 可用命令

```bash
npm run dev              # 开发模式 (WXT hot reload)
npm run build            # 生产构建 → .output/chrome-mv3/
npm run harness          # 运行扩展测试诊断工具
npm run mcp-server       # 启动 MCP stdio 服务器
npm run repair           # 运行 AI 修复循环
npm run compare          # 对比两份诊断报告
```

---

## 3. Harness 使用指南

Harness 是 Playwright 驱动的扩展自动测试工具，位于 `harness/` 目录。

### 基本用法

```bash
npm run harness -- --extension .output/chrome-mv3 --target https://seller.shopee.tw
```

### 参数说明

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--extension` | string | **必填** | 扩展构建目录路径 |
| `--target` | string | **必填** | 目标页面 URL |
| `--headed` | boolean | `true` | 是否显示浏览器窗口 |
| `--timeout` | number | `30000` | 全局超时 (ms) |
| `--popup-wait` | number | `10000` | Popup 观察时长 (ms) |
| `--out` | string | `.harness` | 输出目录 |

### 输出文件

所有输出位于 `.harness/` 目录：

| 文件 | 说明 |
|------|------|
| `latest-report.json` | 完整的诊断报告 JSON |
| `popup-screenshot-*.png` | Popup 页面截图 |
| `target-screenshot-*.png` | 目标页面截图 |
| `popup-console.log` | Popup 控制台日志 |
| `target-console.log` | 目标页面控制台日志 |
| `sw-console.log` | Service Worker 控制台日志 |
| `network-requests.log` | 全部网络请求日志 |
| `baseline/` | 视觉回归基线截图目录 (首次运行生成) |
| `diff-*.png` | 视觉差异对比图 (与基线不一致时生成) |

### 注意事项

- **虾皮页面需要登录状态**: Playwright 使用默认 Chromium 用户数据，如需登录态请先手动登录或配置 Cookie
- **无头模式**: 设置 `--headed false` 可在 CI 或后台运行
- **调试建议**: 首次诊断先跑 headed 模式观察浏览器行为

---

## 4. AI Repair Loop 使用

修复循环是 "构建 → 测试 → 分析 → 修复" 的自动化闭环。

### 完整循环 (构建 + 测试 + 分析)

```bash
npm run repair -- --run --extension .output/chrome-mv3 --target https://seller.shopee.tw
```

可选参数:
- `--no-build` — 跳过构建步骤 (适合仅重测)
- `--headed false` — 无头模式
- `--timeout` / `--popup-wait` — 同 harness

### 仅分析已有报告

```bash
npm run repair -- --report .harness/latest-report.json
```

### 对比两份报告

```bash
npm run compare -- .harness/report-old.json .harness/latest-report.json
```

### 修复循环工作流

1. 读取报告 → 分析器 (`observers/report-analyzer.ts`) 生成 `FixSuggestion[]`
2. 每个建议包含: 源文件路径、行号、问题描述、修复建议、优先级、类型
3. `canAutoFix=true` 时，非网络/依赖类型的问题可自动修复
4. 修复后循环回到第 1 步，直到 `diagnostics.status === 'pass'`

---

## 5. 解读报告

诊断报告在 `.harness/latest-report.json`，结构如下:

### 诊断状态 (diagnostics.status)

| 状态 | 含义 |
|------|------|
| `pass` | 所有检查通过 |
| `warning` | 发现低/中优先级问题（如视觉差异、网络请求失败） |
| `error` | 发现高优先级问题（如 Popup 空白、Service Worker 未注册、401 认证错误） |
| `harness-error` | Harness 工具自身错误（如目标页面打不开、浏览器崩溃） |

### 常见诊断

1. **Service Worker 未检测到** — `wxt.config.ts` 中 background 入口配置可能缺失
2. **Popup 渲染失败/空白** — 检查 `entrypoints/popup/App.tsx` 或 `main.tsx` 的挂载逻辑
3. **Popup JS 运行时错误** — 根据 `pageErrors` 内容定位具体源码文件
4. **Content Script 未注入** — `wxt.config.ts` 中 `matches` 可能未覆盖 seller.shopee.tw
5. **401/403 认证错误** — SPC_CDS Cookie 读取失败或 `host_permissions` 不完整
6. **CORS 拦截** — fetch 请求应从 Background Service Worker 发起，而非 Content Script
7. **SPC_CDS Cookie 问题** — Cookie 名称/域名不匹配，检查 `background.ts` 的读取逻辑
8. **5xx 服务器错误** — 虾皮服务器问题，非扩展代码问题
9. **视觉差异** — 与基线截图不一致，有意变更请更新基线

### visualRegression 字段

```json
{
  "checked": true,
  "baselineCreated": false,   // 首次运行=true，后续=false
  "hasDiff": false,            // 是否与基线有差异
  "diffPercent": 0.5,          // 差异百分比
  "diffPath": ".harness/diff-popup-xxx.png"  // 差异对比图路径
}
```

- 首次运行自动创建基线，不会报告差异
- 后续运行与基线对比，`diffPercent > 0` 表示有变化
- 基线可通过 MCP 工具 `delete_baseline` 删除

---

## 6. MCP Server

可通过 Claude Desktop 连接 (stdio 协议):

```bash
npm run mcp-server
```

提供 7 个工具:

| 工具名 | 功能 |
|--------|------|
| `run_harness` | 执行扩展测试 (参数: extension, target, headed, timeout, popupWait) |
| `read_report` | 读取诊断报告 JSON |
| `compare_reports` | 对比新旧两份报告 |
| `build_extension` | 执行 `npm run build` |
| `run_repair_loop` | 执行完整修复循环 (可选 build/headed/timeout/popupWait) |
| `list_outputs` | 列出 `.harness/` 目录所有输出文件 |
| `delete_baseline` | 删除视觉回归基线目录 |

---

## 7. 开发约束 (重要)

1. **不要修改扩展源代码** — 不要修改 `entrypoints/` 下的任何文件 (`popup/`, `background.ts`, `content.ts`)，也不修改 `components/` 目录。这些是扩展业务代码，应通过正常开发流程修改。

2. **诊断必须有报告证据支持** — 所有诊断结论必须来源于 `.harness/latest-report.json` 中的数据 (popup.pageErrors, network.badResponses, serviceWorker.detected, visualRegression 等字段)。不能凭猜测或假设下结论。

3. **诊断应指向具体文件和行号** — `report-analyzer.ts` 已实现 10 条诊断→源码映射规则。阅读报告时应找到 `probableCauses` 和 `suggestedNextChecks` 中的具体文件/行号建议。

4. **虾皮测试需要登录状态** — seller.shopee.tw 需要有效的卖家登录会话。Harness 使用 Playwright 系统浏览器，如需登录态请通过 headed 模式手动登录，或预先配置 Cookie。

5. **修复循环范围收敛** — 一次修复循环只处理一个核心问题。多次循环逐步解决所有发现的问题。不要在一次循环中尝试修复所有东西。

6. **视觉回归基线管理** — 非有意的 UI 变化应修复源码；有意的 UI 变化应删除旧基线重新生成。
