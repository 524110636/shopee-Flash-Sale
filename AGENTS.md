# AGENTS.md

## 用户长期协作规则（2026-10-12 起必读）

开始规划、开发、验收、交接或恢复上下文时，先读根目录 [OWNER_WORKING_RULES.md](OWNER_WORKING_RULES.md) 和 [PROJECT_STATUS.md](PROJECT_STATUS.md)。前者是现行协作/交付/沟通/产物管理规则，后者是唯一当前进度表；同一会话已读且未变化可复用。
先复用已有能力，接通用户能实际操作的完整基本流程；可体验时主动安排用户手测。正常回复说清已能用、还不能用、下一步及责任人。授权用大白话说明实际影响。自己的临时测试产物由自己限量、隔离、清理并报告。
派给子代理时同时传递上述两份文件及当前任务边界。下文较早版本和状态描述属于历史线索，需核实后才能当作当前进度；技术正文保留，协作口径冲突以用户长期规则为准。

# 用户写入的文件
## 常用命令
# ===== PM2 进程管理 =====

查看状态
npx pm2 status

查看日志（最近 20 行）
npx pm2 logs limited-time-sale --lines 20

重启
npx pm2 restart limited-time-sale

停止
npx pm2 stop limited-time-sale

启动（首次或停止后）
npx pm2 start src/index.ts --name limited-time-sale --interpreter tsx

删除进程
npx pm2 delete limited-time-sale


# ===== 端口排查 =====

查看 5724 端口谁在占用
ss -tlnp | grep 5724

杀掉占用端口的进程
npx kill-port 5724


# ===== 健康检查 =====

服务器本地
curl http://localhost:5724/api/health

外部（测试防火墙是否放行）
curl http://43.99.86.228:5724/api/health


# ===== 构建扩展 =====

本地开发机执行
npm run build


This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 限时特卖助手 (Limited Time Sale Helper)

**版本:** 1.14.3
**状态:** 功能完善阶段 + 后端管理系统 + 防破解 Phase 2 + 一次性邀请码 + 试用限制(trialEnabled 永久关闭, validate/consume 分离) + 使用条款系统 + UI 文案脱敏 + ESLint 零错误 + 部署优化 + 401透传 + IP回退 + 悬浮面板增强 + storeBindingsLoaded门控 + 使用说明按钮 + 二维码联系弹窗 + consumeTrial 响应检查 + _consumeTrialLog 调试存储 + 自动模式 alarm 可靠性增强 + 持久化日志系统 + 心跳监控 + SW恢复nextTargetTime复用 + filterActiveProducts安全底线 + handleAutoModeEnable过滤Number类型转换
**最近更新:** 2026-05-23 — handleAutoModeEnable商品过滤修复: Number()类型转换兼容API返回字符串status + 安全底线防全部过滤清空 + 诊断日志(status原始值样本/try-catch/最终防线) + 域名DNS丢失故障排查(xp.aluvi.cc A记录缺失→198.18.1.123→改为IP直连)

## 相关文档
- `USER_MANUAL.md` — 用户使用手册 (飞书风格, 面向用户, 含常见问题排查)
- `SSH_CONNECT.md` — SSH 服务器连接指南
- `docs/shopee-flash-sale-api.md` — Shopee API endpoints and response formats
- `docs/superpowers/specs/2026-05-02-copy-flash-sale-design.md` — Copy flash sale design spec
- `docs/superpowers/plans/2026-05-02-copy-flash-sale-plan.md` — Copy flash sale implementation plan
- `docs/superpowers/plans/2026-05-05-ux-optimization-plan.md` — UX optimization plan (7 items)
- `docs/superpowers/specs/2026-05-05-ux-optimization-spec.md` — UX optimization dev blueprint
- `docs/superpowers/specs/2026-05-05-ux-optimization-checklist.md` — UX optimization verification checklist
- `docs/superpowers/specs/2026-05-06-auto-mode-spec.md` — Auto mode development blueprint
- `docs/superpowers/specs/2026-05-06-auto-mode-checklist.md` — Auto mode acceptance checklist
- `docs/superpowers/specs/2026-05-07-backend-system-spec.md` — Backend management system dev blueprint (if exists)
- `docs/superpowers/specs/2026-05-10-one-day-sku-har-analysis.md` — One-day SKU HAR analysis + Phase 1 implementation status

## 完整目录结构

```
limited-time-sale/
├── entrypoints/                  # WXT 入口点
│   ├── popup/                    # 弹窗 UI
│   │   ├── App.tsx               # 主应用组件 (布局 + 路由切换)
│   │   ├── main.tsx              # React 挂载入口
│   │   ├── index.html            # HTML 模板 (viewport=420px)
│   │   ├── store.ts              # Zustand 状态管理 + 全部业务逻辑
│   │   ├── api.ts                # GraphQL 商品查询 (fetchProducts)
│   │   ├── backend-api.ts        # 后端 REST API 客户端 (auth, stores, analytics)
│   │   ├── types.ts              # 全局 TypeScript 类型定义
│   │   ├── one-day-sku.ts        # 1 天备货 SKU 构建器 (buildOneDaySkuProductInfo, getDiscountRatio, buildDiscountRestoreList, extractSellableStock, generateTierCombinations, getHighestModelPrice [可选 productInfoModels], hasDedicatedOneDaySku, hasAnyOneDayDeliverySku, extractSellerDiscounts [过滤已结束折扣], isFiveTimesPriceError)
│   │   └── style.css             # Tailwind CSS 指令
│   ├── background.ts             # Service Worker (enable loop, copy flows, alarms, auto mode, analytics event reporting)
│   └── content.ts                # 内容脚本 (浮动进度 UI, 消息中继)
├── components/
│   ├── ui/                       # shadcn/ui 基础组件
│   │   ├── badge.tsx             # 标签/徽章
│   │   ├── button.tsx            # 按钮 (cva variants: default/destructive/outline/secondary/ghost/link)
│   │   ├── card.tsx              # 卡片容器 (Card, CardHeader, CardTitle, CardContent)
│   │   ├── input.tsx             # 输入框
│   │   ├── scroll-area.tsx       # 滚动区域
│   │   ├── separator.tsx         # 分隔线
│   │   └── table.tsx             # 表格 (Table, TableHeader, TableBody, TableRow, TableCell)
│   ├── lib/
│   │   └── utils.ts              # shadcn cn() 工具函数 (clsx + tailwind-merge)
│   └── product/                  # 业务组件
│       ├── AutoModePanel.tsx      # 自动模式面板 (模板选择, 场次选择, 参数配置, 日志)
│       ├── AuthPanel.tsx          # 登录/注册/验证码内联验证/设置 UI + 使用条款 Modal + 勾选协议
│       ├── StoreStatus.tsx        # 店铺绑定状态 + 绑定按钮
│       ├── AdminPanel.tsx         # 管理员面板 (用户列表, 限额调整, 统计)
│       ├── CopyConfirmPanel.tsx   # 复制确认面板 (时段选择, 模板选择, 查看/Demo 按钮)
│       ├── CopyResultPanel.tsx    # 复制结果面板
│       ├── ProductCard.tsx        # 单个商品卡片
│       ├── ProductList.tsx        # 商品列表 (含 SkuTable 弹窗)
│       ├── ProductViewModal.tsx   # 商品查看二级窗口 (自动模式)
│       ├── SkuTable.tsx           # SKU 参数表格 (折扣%, 限时价, 活动库存, 限购, 批量编辑)
│       ├── SpcStatus.tsx          # SPC_CDS 连接状态 + 流程引导
│       ├── TemplateEditDialog.tsx # 模板编辑弹窗 (分组折叠, 分页)
│       ├── TemplateManager.tsx    # 模板管理器 (保存/加载/导出/导入/编辑)
│       ├── TimeSlotModal.tsx      # 场次选择模态窗口 (调用 API 获取实时场次)
│       └── FirstUseModal.tsx      # 第一次使用: 分页获取店铺全部商品 + 搜索 + 勾选 + 触发一键修复
├── docs/
│   ├── shopee-flash-sale-api.md
│   └── superpowers/
│       ├── plans/
│       │   ├── 2026-05-02-copy-flash-sale-plan.md
│       │   └── 2026-05-05-ux-optimization-plan.md
│       └── specs/
│           ├── 2026-05-02-copy-flash-sale-design.md
│           ├── 2026-05-05-ux-optimization-spec.md
│           └── 2026-05-05-ux-optimization-checklist.md
├── public/                        # WXT 公共资源 (contact-qr.png 作者微信二维码)
├── USER_MANUAL.md                 # 用户使用手册 (飞书风格, 面向用户)
├── backup/                        # 项目备份 (gitignore 排除)
├── CLAUDE.md                      # Claude Code 项目指南
├── components.json                # shadcn/ui 配置 (baseColor=slate, cssVariables=true)
├── package.json                   # 依赖与脚本
├── package-lock.json
├── postcss.config.js              # PostCSS 配置
├── tailwind.config.ts             # Tailwind CSS 配置 (content: entrypoints/ + components/)
├── tsconfig.json                  # TypeScript 配置 (strict, paths: @/* → ./*)
├── wxt.config.ts                  # WXT + Vite 配置 (extensionApi=chrome, manifest, alias)
└── .gitignore
```

n```
backend/                      # 独立后端服务
├── src/
│   ├── index.ts              # 入口: Hono HTTP 服务 + CORS + 路由挂载
│   ├── db/
│   │   ├── schema.ts         # Drizzle ORM 表定义 (users, verification_codes, store_bindings, analytics_events, invite_codes)
│   │   └── index.ts          # SQLite 初始化 + 自动迁移
│   ├── routes/
│   │   ├── auth.ts           # 注册(邀请码)/验证/登录/管理员检查/自动模式权限检查
│   │   ├── stores.ts         # 店铺绑定/列表/校验/解绑 (shop_id 唯一性, 同用户自动续期 SPC_CDS, validate 防破解)
│   │   ├── analytics.ts      # 事件上报/个人摘要
│   │   └── admin.ts          # 管理员接口 (用户列表, 限额调整, 自动模式/试用管理, 用户删除, 全局统计, 绑定查询/解绑, 邀请码管理)
│   ├── middleware/
│   │   └── auth.ts           # JWT 验证 + admin 角色守卫
│   └── utils/
│       ├── jwt.ts            # 签发/验证 JWT (jose, HS256, 7天)
│       └── code.ts           # 6位验证码生成器 (5分钟过期)
│   ├── seed.ts                # 首次部署初始化: 从环境变量创建管理员 + 初始邀请码
├── package.json
└── tsconfig.json
```

## Project Overview
Chrome extension (MV3) for automating Shopee Taiwan seller center flash sale operations, plus a standalone backend (Node.js + Hono + Drizzle ORM + SQLite) for user auth/store binding/analytics.

Built with WXT + React 19 + TypeScript + Tailwind CSS + shadcn/ui + Zustand (extension).

## Development Commands
- `cp .env.example .env` — 创建本地环境变量配置（默认后端地址 `http://localhost:5724`）
- `cd backend && npm run dev` — Start backend server on port 5724
- `cd backend && npm run seed` — Initialize first admin + invite codes (first deployment only, idempotent)
- `cd backend && npx kill-port 5724` — Kill backend if port in use
- `npm run dev` — Start dev server with hot reload (WXT)
- `npm run build` — Production build
- `npm run zip` — Build + create zip for Chrome Web Store
- `npx tsc --noEmit` — TypeScript type checking only (no bundling)
- `npm run postinstall` — Run `wxt prepare` after install

## Tech Stack & Key Versions
### Backend
- **Hono** 4 — HTTP framework (lightweight, fast)
- **Drizzle ORM** — Type-safe SQLite queries
- **@libsql/client** — SQLite driver (WASM, no native compilation)
- **bcryptjs** — Password hashing
- **jose** — JWT sign/verify (HS256, 7-day expiry)
- **@hono/node-server** — Node.js adapter for Hono
- **WXT** 0.20.25 — Chrome MV3 extension framework (Vite 8 under the hood)
- **React** 19.2.5 + **TypeScript** 6.0
- **Zustand** 5.0.12 — State management (single store for all business logic)
- **Tailwind CSS** 3.4 + shadcn/ui (`components/ui/`) — UI
- **Radix UI** (@radix-ui/react-slot) — Button asChild pattern
- **class-variance-authority** + **clsx** + **tailwind-merge** — shadcn/ui styling utilities
- Extension API: `chrome` (configured in `wxt.config.ts` via `extensionApi: 'chrome'`)

## Architecture

### Entrypoints (WXT convention)
- **`entrypoints/popup/`** — Popup UI (viewport=420px). `main.tsx` mounts `<App />` into `index.html` root div. `style.css` contains Tailwind directives (`@tailwind base/components/utilities`). App.tsx renders layout with conditional panel switching (copyMode='confirm'/'result' vs default dashboard, CSS 3D flip animation to auto mode). `store.ts` is Zustand single store with all business logic including auto mode state. `api.ts` exports `fetchProducts()` GraphQL query fetcher. `types.ts` defines all shared TypeScript interfaces.
- **`entrypoints/background.ts`** — Service Worker: SPC_CDS cookie extraction, flash sale enable loop (`runEnableLoop` with `injectedFetch`), copy flash sale flows (EXECUTE_COPY/SCHEDULE_COPY/TRIGGER_SCHEDULED_COPY_NOW), auto mode (START_AUTO_MODE/STOP_AUTO_MODE/GET_AUTO_MODE_STATUS, alarms: auto_mode_create/auto_mode_enable/auto_mode_heartbeat), message relay
- **`entrypoints/content.ts`** — Content script: unified floating panel (`#__flash_sale_panel__`) merging enable progress, copy progress, and auto mode status. Listens for `ENABLE_PROGRESS`/`ENABLE_COMPLETE`/`COPY_SCHEDULED`/`COPY_PROGRESS`/`COPY_COMPLETE`/`AUTO_MODE_UPDATE` messages. Also watches `storage.onChanged` as backup path for `_enableProgress`, `_copyCountdown`, and `_autoModeStatus` when messages fail.

### Anti-Cracking Phase 1 — 后端验证 (v1.8.2)
- 所有关键操作（开限时特卖、复制活动、自动模式、定时复制）执行前，调用 `POST /api/stores/validate` 校验店铺绑定是否仍有效 + 用户账号是否激活 + **试用限制（只读检查）**。试用消耗通过 `POST /api/stores/consume-trial` 在操作成功后独立调用
- `validateShopAccess()` inline 函数在 background.ts 中，从 storage 读取 `backendAuth` + `backendUrl`，URL 不存在时自动回退默认值 `http://localhost:5724`
- 9 个注入点全覆盖: START_ENABLE, EXECUTE_COPY, executeScheduledCopyFlow, handleAutoModeEnable, SCHEDULE_COPY, SCHEDULE_ENABLE, SCHEDULE_WIZARD_FLOW, scheduled_copy_enable, scheduled_enable
- 验证失败时根据注入点分别处理: return error / throw / stop auto mode / log + return
- 无法通过修改前端代码绕过（验证在后端执行）
- `validateShopAccess()` 包含详细 `[bg:validate]` 日志：开始校验 → 请求 URL → 后端响应 → 通过/失败

### 邀请码系统 (v1.11.0)
- **一次性邀请码**: 替换全局 `REGISTER_KEY`，管理员在 AdminPanel「邀请码」标签页生成
- 格式 `INV-xxxxxxxx`（8 位随机 hex），生成数量可配置（1-20）
- 注册时校验：查 `invite_codes` 表，`is_used=0` 才有效，使用后标记 `is_used=1, used_by=<userId>, used_at=now`
- 同一邀请码不可重复使用，已使用的不可删除
- 管理员可查看所有邀请码及其使用状态（使用者邮箱、使用时间）
- 前端注册表单「注册密钥」→「邀请码」，placeholder 文字同步更新

### 试用限制 (v1.10.0 → v1.12.0 → v1.14.0)
- `users` 表 `trial_used` 字段（默认 0）
- **v1.14.0 读写分离**: `/validate` 仅做只读检查（trialUsed 状态），不再标记试用。`POST /api/stores/consume-trial` 由 `background.ts` `consumeTrial()` 在操作成功后独立调用 fire-and-forget，标记 `trialUsed=1`
- **`trialEnabled` 永久关闭试用 (v1.12.0)**: `users` 表新增 `trial_enabled` 字段（默认 1）。管理员在 AdminPanel 用户列表点击「关闭试用」→ `trialEnabled = 0`，该用户后续所有操作跳过试用检查，也不会自动标记 `trialUsed`。适用于已升级套餐的用户
- `trial_used >= 1` 且 `trialEnabled = 1` 的非管理员用户再次操作 → 403 `"试用已结束，请联系管理员升级套餐"`
- 管理员（role=admin）不受试用限制，`trial_used` 也不自动递增
- AdminPanel 显示试用状态 + 「重置试用/标记已用」按钮 + 「关闭试用/开启试用」按钮（红/绿）
- JWT payload 包含 `trialUsed` + `trialEnabled`，`checkAdmin()` 返回时自动同步到 storage
- **试用到期通知 (v1.12.0)**: 任何操作触发 403 试用错误时，`trialExpiredBanner` Zustand 状态设值，App.tsx 顶部渲染醒目红底横幅（图标 + 升级引导文案 + 关闭按钮）。5 个检测点：`checkBackgroundStatus`、`executeCopy` instant/scheduled 路径、`runOneDaySkuAndEnable` 异常、`scheduleEnableForFlashSale` 异常
- **Wizard 试用错误就地显示 (v1.12.0)**: `checkBackgroundStatus` 检测到试用错误且 `oneDaySkuFlow.phase === 'starting_flash_sale'` 时，同步更新 `oneDaySkuFlow` 为 failed 状态，错误直接显示在 wizard 界面中。`addToExistingFlashSale` 的 `waitForBoot` 失败后优先读取 `_enableProgress.error` 而非显示通用「Background Service Worker 未响应」
- **`consumeTrial()` 响应检查 (v1.14.0)**: 添加 `response.ok` 检查（fetch 不抛非 2xx 异常），失败时从 body 提取错误。所有结果写入 `_consumeTrialLog` storage key（status/consumed/error/ts），popup 控制台可读，解决指纹浏览器无法看 SW 日志的问题。4 个调用点均在 `runEnableLoop` 成功后：手动 enable、自动模式、即时复制、定时复制

### 安全加固 Phase 2 (v1.13.0)
- **P0 — 客户端宽容降级移除**: `backend-api.ts` `request()` 重构 — `!response.ok` 检查移到 `response.json()` 之前，Content-Type 守卫防止非 JSON 响应被误 parse，网络错误不再暴露 `_baseUrl`。所有错误路径均 `throw`，绝不返回假成功数据。
- **P0 — JWT 结构/过期校验**: `loadAuthFromStorage()` 加入 `isValidJwtStructure()` 检查（3段 base64url、payload 含 userId/email/role/exp/iat），校验失败清 storage。`isLoggedIn()` + `getAuthUser()` 加入 `isTokenExpired()` 检查（payload.exp * 1000 < Date.now()）。
- **P0 — 启动认证服务端确认**: `checkAuthOnStartup()` 使用 `checkAdmin()` 返回值作为 `autoModeEnabled`/`trialUsed`/`trialEnabled` 来源（非 storage 数据）。区分 401（清 auth）与网络错误（设 `backendUnreachable` 标志）。外层 catch 不再静默吞错。
- **P0 — Store 绑定加固**: `refreshStoreBindings()` 401 时同步清理 `isLoggedIn`/`authUser`/`storeBindings`。`bindCurrentStore()` 错误消息脱敏（不返回 raw `e.message`）。
- **P1 — 后台验证缺口闭合**: `wizard_create` alarm handler + `handleAutoModeCreate()` 加入 `validateShopAccess()` 调用。`SCHEDULE_COPY`/`scheduled_copy_enable`/`scheduled_enable` 中 spcCds 缺失时 abort 并返回错误（旧代码仅 `console.warn` 跳过）。`runEnableLoop()` 从 fire-and-forget `.catch()` 改为 `await`+try/catch，`_enableParams` 移除放到 await 之后。
- **P2 — 服务端加固**: `backend/src/routes/auth.ts` 中 `/check-admin` 的 `isAdmin` 改为从 DB 查询 `users.role`（不信任 JWT claim）。`backend/src/utils/jwt.ts` 启动时检查 `JWT_SECRET` 是否为 `.env.example` 硬编码值，匹配则拒绝启动。

### 使用条款及免责声明 (v1.13.0)
- 注册表单新增必勾选 checkbox：「我已阅读并同意《使用条款及免责声明》」
- 未勾选时注册按钮 disabled，点击验证码获取区域也会提示需先勾选
- 点击链接文字弹出 Modal，内含 ~1500 字完整使用条款（含标准 EULA 模板 + 虾皮特定免责：自动化操作风险、店铺降权、流量下降、API 时效等，混在通用条款中）
- 注册和验证均改为手动点击按钮触发（移除验证码自动提交），防止绕过条款

### 一键修复 UI 文案脱敏 (v1.13.0)
- `runOneDaySkuAndEnable` 所有用户可见的 `message` 字段改为通用「正在优化商品 (X/N)...」
- 原文案：`获取商品信息 X/N: 商品名` / `搜索折扣活动 X/N: 商品名` / `移除折扣活动 X/N: 商品名` / `发布商品 X/N: 商品名` / `恢复折扣活动 X/N: 商品名` → 统一为「正在优化商品」
- `App.tsx` phase 标签：`检查 SKU` / `发布商品` / `查询折扣` / `移除折扣` / `恢复折扣` → 统一为「优化中」
- `console.log` `[一键修复]` 日志保持不变（开发者调试用）

### SPC_CDS 校验修复 (v1.10.0)
- **问题**: `SCHEDULE_COPY` 和 `SCHEDULE_WIZARD_FLOW` 从 `browser.storage.local` 读取 `spcCds`，但 Zustand `setSpcCds` 只写内存不写 storage → 永远为空 → 校验被跳过
- **修复**: 改用 `getSpcCdsFromCookies()` 从浏览器 Cookie 直接读取 SPC_CDS，与 `EXECUTE_COPY`、`scheduled_copy_enable` 等 handler 一致
- **规则**: Background 中不依赖 popup 传参的 handler（alarm、定时任务）必须用 `getSpcCdsFromCookies()`，禁止从 `storage.local` 读 SPC_CDS

### 多店铺绑定修复 (v1.8.2)
- StoreStatus 组件原仅当 `activeBindings.length === 0` 时显示绑定按钮，绑定首个店铺后按钮消失
- 修复: 在绑定列表底部检测当前店铺是否已绑定 + 检查 `activeBindings.length < maxStores`，有剩余容量时显示 "绑定当前店铺" 按钮
- App.tsx 门禁从红色硬阻断改为琥珀色提示，引导用户去 StoreStatus 区域操作

### 已结束活动不可选 (v1.8.2)
- App.tsx 活动列表卡片的 `onClick` 在 `isEnded` 时直接 `return`，不再调用 `loadFlashSaleProducts`
- 已结束活动使用虚线边框 + `opacity-50` 视觉弱化，移除 `cursor-pointer`
- 复制按钮不受影响（独立 `onClick` + `stopPropagation`）

### 设置页安全加固 (v1.8.3)
- AuthPanel 设置视图中的后端服务地址输入框仅在 `authUser.role === 'admin'` 时显示
- 普通用户只看到"测试连接"按钮，点击调用 `healthCheck()` 检测连通性
- 成功显示绿色"后端连接正常"，失败显示红色错误详情
- 未登录状态下的设置视图同样隐藏地址输入框

### checkAuthOnStartup 竞态修复 (v1.8.3)
- `checkAuthOnStartup` 中原 `setTimeout(() => refreshStoreBindings(), 500)` 改用 `await refreshStoreBindings()`
- 消除 500ms 窗口期中 `isLoggedIn=true` 但 `storeBindings=[]` 的状态，防止用户快速点击"绑定当前店铺"造成重复绑定

### 强制刷新列表 + 缓存保护优化 (v1.8.3)
- `fetchFlashSaleList` 新增 `force` 参数，`force=true` 时跳过虾皮 API "返回数量减少"的缓存保护逻辑
- 用户点击"刷新"按钮时传入 `force=true`，删除活动后也能实时更新列表
- 复制流程确认新活动出现在列表后同样强制刷新
- 保护逻辑在非主动刷新时（`!force`）继续保持，防范服务端缓存不一致

### 复制活动后自动加载商品 (v1.8.3)
- `executeCopy` 复制流程在确认新活动 ID 出现在列表后，追加 `loadFlashSaleProducts(newId)` 调用
- 从 `_copiedSaleData` 读取复制时保存的商品数据（含 SKU 覆盖参数）
- 用户返回主界面时直接可见已加载的商品，不再出现"该活动中没有找到商品"

### 已结束活动内联提示 (v1.8.3)
- 在"开启限时特卖"按钮正下方新增已结束活动检查
- 如果 `now >= currentSale.end_time`，显示红色提示框：`该活动已结束无法开启，请点击「复制」复制此活动而不是选中此活动`
- 纯 UI 层判断，不依赖 `error` 状态，不干扰其他错误提示

### healthCheck API + admin 查询重构 (v1.8.3)
- `backend-api.ts` 新增 `healthCheck()` 函数，调用 `GET /api/health` 公共端点
- `admin.ts` 中 `/analytics/events` 两个 if-else 分支提取公共查询部分，消除代码重复

### Critical Design Decisions
1. **Enable loop runs in background Service Worker** — `runEnableLoop` is in `background.ts`, not popup. Popup builds items, saves params via `storage.local`, sends `START_ENABLE` message. Background sends `ENABLE_PROGRESS`/`ENABLE_COMPLETE` messages back. Loop continues after popup closes. Uses `_enableRunning` flag + try/finally to prevent concurrent loops.
2. **Data loading still in popup** — Uses `browser.scripting.executeScript({ world: 'MAIN' })` via `injectedFetch()`. Background's `injectedFetch` finds seller tab by URL (not active tab), allowing loop to run while user switches tabs.
3. **SPC_CDS cookie extraction** — `browser.cookies.get()` with multi-domain fallback chain: `seller.shopee.tw` → `shopee.tw` → `www.shopee.tw` → `cookies.getAll({ domain: '.shopee.tw' })`
4. **All business logic in Zustand store** — `store.ts` is the single source of truth; React components are thin wrappers
5. **Optimistic UI updates** — `isEnabling` set to true before START_ENABLE response, button changes immediately. On reopen, `checkBackgroundStatus` reads `_enableProgress` directly from `storage.local` instead of messaging.
6. **Storage-based communication** — `browser.runtime.sendMessage` responses in MV3 can return `undefined` even on success. For critical flows (EXECUTE_COPY) and status checks (GET_ENABLE_STATUS), use `browser.storage.onChanged` or direct storage reads instead of relying on `sendMessage` response. Content script also uses `storage.onChanged` as backup for `_enableProgress` and `_copyCountdown` when message delivery fails.
7. **Copy flow uses `get_shop_flash_sale_item/`** — Source item config is fetched via API, then applied to new flash sale via `set_shop_flash_sale_items/`. The `from` parameter via Referrer header approach (server-side auto-copy) is unreliable in fetch API context.
8. **Button pattern for inline actions** — All text-style links (`underline hover:underline`) are converted to `<Button variant="outline" size="sm">` with compact custom sizing (`h-5 px-1.5 text-[10px]` for inline, `h-6 px-2 text-xs` for normal). Color-coded variants: green for positive actions (应用, 保存), red for destructive (删除, 停止), blue/primary for navigation (复制, 查看), neutral for cancel/close. Custom classes override the `h-9` default from `size="sm"`. Selected/highlighted states use `border-l-4 border-l-blue-500 bg-blue-50/50` matching ProductCard's modified-item indicator style.
9. **Stale product state guard** — `loadFlashSaleProducts` clears `products`, `productIds`, `inputText` when the source flash sale has 0 items (early return), preventing stale data from previous queries. `handleOpenView` in CopyConfirmPanel always reloads source products regardless of current `products.length`.
10. **SKU 直定价格 (v1.4.0)** — `SkuOverride.promoPrice` 允许直接指定限时价（如 8 元），绕过整数折扣率的两次取整损失（`Math.round` + `Math.floor`）。`promoPrice` 优先级最高，构建 `EnableItem` 时 `override?.promoPrice ?? Math.floor(price * rate / 100)`。与 `discountRate` 互斥：设置折扣%时清空 `promoPrice`，反之亦然。
11. **模板编辑与分组折叠 (v1.5.0)** — `TemplateEditDialog` 按商品 ID 分组展示 SKU 覆盖参数，主商品行为可折叠行（▶/▼），展开后显示子 SKU 编辑行（折扣%、限时价、活动库存、限购数量）。支持全部展开/收起、行内快捷添加 SKU、底部全局新增。每页 8 个商品，超出时自动分页。`updateTemplate` store 方法支持部分更新模板（合并已有字段，自动设 `updatedAt`）。
12. **复制活动数据一致性 (v1.6.0)** — `loadFlashSaleProducts` 正常 API 路径新增 `get_shop_flash_sale_item/` 调用获取每个 SKU 的实际 flash sale 参数。`promoPrice` 直接用 `configItems[].promotion_price`（非 `model_info_str[].price`）。`fetchProducts` 完成后反推 `discountRate` 填入每个 SKU 覆盖参数，确保 SkuTable 所有列显示实际值。复制数据加载路径同理。
13. **enterCopyMode 不再自动选择模板 (v1.6.0)** — `selectedTemplate` 默认 `null`，避免首个模板的 `discountRate=60`/`flashSaleStock=200` 等默认值通过 `executeCopy` → `_copiedSaleData` 污染全局输入框显示。用户需手动选择模板。
14. **SkuTable key prop (v1.6.0)** — 三处 `<SkuTable>` 渲染点必须加 `key={product.itemid}`，确保切换商品时 React 销毁旧实例创建新实例，内部 `priceEditValues` 等状态归零。
15. **复制时段默认选择 (v1.6.1)** — CopyConfirmPanel 的 `useEffect` 默认选中 `slots[0]`（第一个可用时段），移除原来的 `当前时间+2小时` 最近时段启发式算法，该算法可能跳过第一场选到第二场。
16. **定时任务两阶段 alarm 分离 (v1.6.1)** — `scheduled_copy` alarm（活动开始前 5 分钟）仅创建空活动并保存 `_enableParams`，同时创建 `scheduled_copy_enable` alarm（活动开始后 5 分钟）执行 `runEnableLoop`。旧代码在创建空活动后立即调用 `runEnableLoop`，因活动未开始 API 拒绝提交导致全部 SKU 失败后终止。`TRIGGER_SCHEDULED_COPY_NOW` 手动触发路径同样遵守此逻辑：若活动已开始超过 5 分钟则立即执行 enable，否则安排定时 alarm。
17. **`_copiedSaleData` 缓存一致性验证 (v1.6.1)** — `loadFlashSaleProducts` 在找到 `_copiedSaleData` 后、使用前，先调用 `get_shop_flash_sale_item_id_list` API 获取当前活动实际商品 ID 列表，与缓存商品 ID 做 `Set` 双向对比。不一致则删除 `_copiedSaleData` 中该活动条目并重置 `copiedData=null`，自动回退到正常 API 路径获取最新数据。一致则继续使用缓存（保留 per-SKU 参数优势）。修复了用户手动替换商品 ID 后界面仍显示旧复制商品的 bug。
18. **SKU 覆盖提示与详情搜索 (v1.6.2)** — `App.tsx` 在“开启限时特卖”标题和全局折扣/库存/限购输入行之间显示覆盖提示：`已有 X 个商品 / Y 个 SKU 手动修改过，不会使用下列折扣`。统计仅基于当前 `products` 中实际存在且命中 `skuOverrides` 的 SKU，避免显示过期缓存。点击“查看”打开父弹窗，可按商品标题、商品 ID、SKU 名称、SKU ID 搜索。父弹窗保持打开，点击“查看 SKU”时只打开 `SkuTable` 子弹窗；父弹窗使用 `z-40`，`SkuTable` 保持 `z-50`，确保子弹窗浮在父弹窗之上。
19. **复制活动全量固化 SKU 覆盖 (v1.6.2)** — `executeCopy()` 在保存复制参数前会遍历当前 `products.modelList`，为没有显式覆盖的 SKU 也写入一条 `skuOverrides[key]`（包含 `discountRate`、按当前折扣计算的 `promoPrice`、`stock`、`purchaseLimit`）。因此复制限时特卖的源活动在新活动展示时视为所有 SKU 都已手动编辑，不会被后续全局折扣行覆盖。`loadFlashSaleProducts()` 读取旧 `_copiedSaleData` 时也会补齐缺失覆盖项，兼容旧缓存。
20. **UX 优化 — 异步按钮统一反馈 (v1.6.3)** — 所有触发异步操作的按钮统一规则：点击后 100ms 内文案切换为 loading 状态（如「加载中」「清除中」「执行中」），按钮 `disabled` 防止重复点击，请求完成后 `finally` 块恢复。涉及按钮：清除缓存、重新获取 SPC_CDS、停止、手动触发定时任务、应用模板、删除模板、保存模板。开启限时特卖通过按钮切换（🚀 开启 → ⏹ 停止）提供即时反馈。
21. **UX 优化 — 按钮颜色语义 (v1.6.3)** — 建立四色语义体系：蓝色 outline（普通操作：查看、刷新、复制、导入/加载模板）、绿色实心（主确认：开启限时特卖、创建复制任务、保存模板）、红色 outline（停止/危险：停止、清除缓存）、灰色（次要/取消）。hover 规则：`hover:bg-{color}-50 hover:text-{color}-600 hover:border-{color}-300`。危险操作禁止使用蓝色。
22. **UX 优化 — 高级操作折叠 (v1.6.3)** — 「清除缓存」从 header 移至底部折叠区、「手动触发定时任务」从启用区移至折叠区。使用 `<details>` + `<summary>` 标签实现，默认收起，摘要文字「高级操作」（`text-xs text-gray-400`）。仅在 `isConnected` 为 true 时渲染。常用操作（获取商品、刷新、复制、开启/停止）保留在主界面。
23. **UX 优化 — 当前活动上下文展示条 (v1.6.3)** — `Separator` 后新增蓝底上下文条（`bg-blue-50 border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-700`）：`当前活动：{name} · MM/DD HH:mm ~ HH:mm · {status} · N 个商品`。`name` 为空时回退 `活动 #{id}`，status 按时间判断为「即将开始/进行中/已结束」。仅在 `flashSaleId` 存在且非 `copyMode` 时显示，位于商品列表上方独立展示。
24. **UX 优化 — 编辑痕迹强化 (v1.6.3)** — 商品列表区域顶部新增蓝底汇总行（`bg-blue-50 border-blue-200`）：`已手动编辑 X 个商品 / Y 个 SKU` + 蓝色「查看详情」按钮（复用 `overrideDetailOpen` 弹窗）。仅当 `overrideSummary.skuCount > 0` 时显示。SKU 输入框 `placeholder` 显示全局默认值作为来源提示。
25. **UX 优化 — 复制流程步骤提示 (v1.6.3)** — `CopyConfirmPanel` 顶部新增三步提示：`● 选择源活动 → ● 选择目标时间 → ○ 创建复制任务`。前两步蓝色加粗（已完成），第三步灰色（待确认）。纯展示，不控制流程。
26. **UX 优化 — 错误提示就近化 (v1.6.3)** — `CopyConfirmPanel` 的「查看」按钮旁新增 `viewError` 状态，失败时红色文字紧邻按钮显示。其余操作已有 inline 提示（`applyMessage`、`saveSuccess`、`importMessage`、时间段选择错误 `slotsError`）。
27. **定时任务存活状态检测 (v1.6.4)** — 新增 `GET_SCHEDULED_STATUS` 消息类型，后台 handler 从 storage 读取 `_scheduledCopy` 参数并通过 `chrome.alarms.get('scheduled_copy')` 检查 alarm 是否仍然注册，返回 `ScheduledTaskStatus`（`exists`, `alarmActive`, `params`, `alarmScheduledTime`, `remainingSeconds`）。`checkScheduledCopy` store 方法增强为自动查询 alarm 状态，popup 通过琥珀色卡片展示：源活动名、目标时间、定时器存活/未注册状态、剩余时间倒计时、「刷新状态」按钮。触发时机：popup 打开、创建定时任务成功后、检测到 `_copyTaskStatus` 变化时。
28. **布局信息分层重组 (v1.6.4)** — 将主界面按信息优先级重组为「上下文→操作→低频」三层：
   - 首屏：当前活动上下文条（蓝底）+ 定时任务状态卡（琥珀底）作为信息群置于 Header 正下方，打开扩展第一眼可见
   - 中层：活动列表（紧凑折叠头）+ 商品列表 + 开启限时特卖参数区连为一体，删除无意义的 `Separator`
   - 底层：「更多」折叠区（`<details>`）收纳所有低频功能：商品 ID 输入、获取商品信息、加载列表、模板管理、手动触发定时任务、清除缓存
   - 删除原有的两个独立折叠区（高级操作 + 商品ID区），统一为一个「更多」入口
29. **自动模式 — CSS 3D 翻转动画 (v1.7.0)** — 主界面与自动模式面板通过 CSS 3D 翻转切换。使用 `perspective`, `transform-style: preserve-3d`, `rotateY(180deg)`, `backface-visibility: hidden` 实现整页翻转效果。`autoModeView` state 控制正反面切换。
30. **自动模式 — 模板活动沿用链 (v1.7.0)** — 启动时使用用户选择的模板活动，每轮完成后自动将 `sourceFlashSaleId` 更新为当轮刚创建的活动 ID。第 N+1 轮沿用第 N 轮活动的商品+库存，实现活动链式传递，确保库存数据随售出自动递减。
31. **自动模式 — 场次选择 (v1.7.0)** — `TimeSlotModal` 通过调用 Shopee API(`get_time_slot_id/`) 获取本月所有可用场次，按 `start_time` 升序排列，显示实时状态（未开始/进行中/已结束）。用户选择后在 `AutoModePanel` 蓝色信息条展示。启动时自动验证场次合法性（是否存在、开始时间是否变更、是否已开始），失败则拒绝启动。`scheduleNextRound` 第一轮优先使用用户选定场次。
32. **自动模式 — 两阶段 alarm (v1.7.0)** — `auto_mode_create` alarm 在目标时间前 N 分钟触发创建空活动 + 保存数据；`auto_mode_enable` alarm 在目标时间后 delay 分钟触发执行 `runEnableLoop`。`auto_mode_heartbeat` alarm 定期更新状态保证 popup 可见最新进度。
33. **自动模式 — 调试模式 (v1.7.0)** — 「⏩ 加速调试」checkbox，激活后 `scheduleNextRound` 跳过真实场次时间，伪造 `fakeTargetTime = now + advanceSec + 3`，使定时调度在数秒内触发而非等待真实时间段。底部调试状态条显示剩余秒数。
34. **跨轮次库存自动刷新 (v1.7.0)** — `handleAutoModeEnable` 每轮传递商品参数前通过 GraphQL 重新拉取最新 `normalStock`/`totalNormalStock`/`originPrice`，同步写回 `status.enableParams.products` 和 `_copiedSaleData`。确保每轮使用最新实际库存，而非轮次开始时的一次性快照。
35. **`_copiedSaleData` 缓存库存刷新 (v1.7.0)** — `loadFlashSaleProducts` 缓存路径（产品 ID 验证通过后）不再直接 `return`，而是追加 `await fetchProducts()` GraphQL 调用，将新鲜库存合并入缓存商品，再 `set({ products })`。确保两个「查看商品」入口都显示实时库存。
36. **SkuTable 批量编辑框 (v1.7.0)** — 表格上方新增浅蓝底批量编辑行：`折扣% | 活动库存 | 限时价 | 限购数量`。输入数值后 `onBlur` 或 `Enter` 自动将值应用到当前商品所有 SKU 对应参数。限时价批量编辑时同步清空折扣%字段（互斥设计）。适用于手动模式和自动模式。
37. **动态「已编辑」标记 (v1.7.0)** — `AutoModePanel` 维护 `editedProductIds: Set<string>` 状态，SkuTable 新增可选 `onEdit` prop。仅当用户点击商品并实际修改参数后，商品才显示蓝色左边框 + 「已编辑」badge。加载初始状态全部无标记，切换模板时清空。
38. **自动模式 — 红色日志信息栏 (v1.7.0)** — 日志卡片顶部红底信息栏（`bg-red-50 border-red-200`），运行中显示：选择场次、场次状态、模板商品数、当前轮次/总轮次、当前阶段。未启动时显示「自动模式未启动」。
39. **自动模式 — 错误参数重试阈值调整 (v1.7.0)** — 零进展僵局检测阈值从 5 轮提升到 10 轮，低失败僵局检测阈值从 3 个 SKU 提升到 5 个，以适配自动模式下参数传递的延迟。

### Data Flow
```
Data loading (popup):
  User Input → App.tsx → store.ts actions → injectedFetch() →
    scripting.executeScript(MAIN world) → fetch() →
    response → store state update → React re-render

Enable loop (background):
  Popup: build items → storage.local(params) → clear old _enableProgress → isEnabling=true → START_ENABLE fire-and-forget →
    waitForBoot (storage.onChanged('_enableProgress.running=true'), 5s timeout + 4s retry) →
    Background: retry-read params → runEnableLoop() → saveProgress(running=true immediately) →
      loop(injectedFetch on any seller tab) → storage.local(progress) →
      ENABLE_PROGRESS → runtime.sendMessage(popup) + tabs.sendMessage(content script)
  (Popup can close; loop continues; reopen: checkBackgroundStatus reads _enableProgress directly from storage)

Copy flash sale (background):
  Popup: executeCopy() → clear _copyTaskStatus → send EXECUTE_COPY message (fire-and-forget) →
    waitForStorage() listens for storage.onChanged('_copyTaskStatus')
  Background: EXECUTE_COPY handler → step1(close active) → step2(get time slots) →
    step3(create empty sale) → step4(save data locally) →
    save _copyTaskStatus to storage → storage.onChanged triggers popup resolve

Scheduled copy two-phase (background):
  Phase 1 - scheduled_copy alarm (start_time - 5min):
    getSpcCdsFromCookies() → executeScheduledCopyFlow() (close active → get slots → create empty sale → save data) →
    save _enableParams to storage → remove _scheduledCopy → create scheduled_copy_enable alarm (start_time + 5min)
  Phase 2 - scheduled_copy_enable alarm (start_time + 5min):
    read _enableParams from storage → refresh SPC_CDS via getSpcCdsFromCookies() →
    runEnableLoop() → ENABLE_PROGRESS/ENABLE_COMPLETE messages flow as normal

_copiedSaleData cache validation:
  loadFlashSaleProducts(fsId) → find _copiedSaleData entry →
    call get_shop_flash_sale_item_id_list API → compare IDs (Set intersection) →
    mismatch: delete entry + fallthrough to normal API path | match: use cached data →
    (v1.7.0) always call fetchProducts() GraphQL to refresh stock after cache load

Auto mode (background):
  START_AUTO_MODE: validate slot → clear residual state → build status with enableParams →
    logAutoMode → scheduleNextRound()
  scheduleNextRound():
    debug mode: fabricate fakeTargetTime | normal: find next slot (1st round prefers selectedSlotId) →
    set phase='waiting_create' → auto_mode_create alarm at targetTime - advanceMinutes
  auto_mode_create alarm: handleAutoModeCreate()
    close active sales → get time slots → find best slot near nextTargetTime →
    create empty flash sale → saveCopiedSaleData(new activity) → save status →
    logAutoMode → auto_mode_enable alarm at targetTime + delayMinutes
  auto_mode_enable alarm: handleAutoModeEnable()
    refresh product stock via GraphQL → sync to _copiedSaleData →
    build EnableParams → runEnableLoop() → logAutoMode →
    sourceFlashSaleId = currentFlashSaleId (chain) → scheduleNextRound()
  auto_mode_heartbeat alarm: sendAutoModeUpdate() → sync to popup/content
  STOP_AUTO_MODE: clear alarms + _enableParams + save stopped status + remove _autoModeStatus
```

### Message Protocol
- **Popup → Background:** `START_ENABLE`, `STOP_ENABLE`, `GET_ENABLE_STATUS`, `CLEAR_ENABLE_STATE`, `SPC_CDS_REQUEST`, `EXECUTE_COPY`, `SCHEDULE_COPY`, `TRIGGER_SCHEDULED_COPY_NOW`, `GET_TIME_SLOTS`, `GET_FLASH_SALE_ITEM_COUNT`, `CLOSE_FLASH_SALE`, `COPY_FLASH_SALE`, `APPLY_TEMPLATE_ITEMS`, `GET_SCHEDULED_STATUS`, `START_AUTO_MODE`, `STOP_AUTO_MODE`, `GET_AUTO_MODE_STATUS`
- **Background → Popup:** `ENABLE_PROGRESS`, `ENABLE_COMPLETE`, `AUTO_MODE_UPDATE`
- **Background → Content Script:** `ENABLE_PROGRESS`, `ENABLE_COMPLETE`, `COPY_SCHEDULED`, `COPY_PROGRESS`, `COPY_COMPLETE`, `AUTO_MODE_UPDATE`
- **Content Script → Background:** `STOP_ENABLE` (via stop button in progress UI)
- **Storage-based (reliable):** `_copyTaskStatus`, `_enableProgress`, `_enableParams`, `_copyCountdown`, `_copiedSaleData`, `_autoModeStatus`, `_autoModeLogs` — used when `sendMessage` response is unreliable (MV3 bug). Content script's `storage.onChanged` listener watches `_enableProgress`, `_copyCountdown`, and `_autoModeStatus` as backup for message delivery failures.

### Key API Endpoints
- **GraphQL:** `POST /api/marketing/v4/graphql/query/` — product/SKU details (query in `api.ts` PRODUCTS_QUERY)
- **Flash Sale:** `/api/marketing/v4/shop_flash_sale/{get_shop_flash_sale_list,get_shop_flash_sale_item_id_list,set_shop_flash_sale_items,set_shop_flash_sale,get_time_slot_id,get_shop_flash_sale_item}`
- **Required header:** `sc-fe-session` (CSRF token, extracted from page DOM/window)
- **Required body field:** `use_global_category: true` (missing this causes code 1001 error)
- **Price rules:** Must be integer, strictly less than origin price

### Backend API Endpoints
- **POST `/api/auth/register`** — Register with invite code (replaces `registerKey`, returns verification code)
- **POST `/api/auth/check-auto-mode`** — Check if user can use auto mode (JWT)
- **POST `/api/auth/verify`** — Activate account with code
- **POST `/api/auth/login`** — Login, returns JWT
- **POST `/api/auth/check-admin`** — Check admin role (JWT)
- **GET `/api/stores`** — List store bindings (JWT)
- **POST `/api/stores/bind`** — Bind store by SPC_CDS + shop_id/account_id/username (JWT)
- **POST `/api/stores/validate`** — Validate store binding + user is active + trial limit (JWT, anti-cracking, trial check is read-only)
- **POST `/api/stores/consume-trial`** — Mark trial used after first successful operation (JWT, v1.14.0)
- **DELETE `/api/stores/:id`** — Unbind store (JWT)
- **POST `/api/analytics/events`** — Report usage event (JWT)
- **GET `/api/analytics/summary`** — Personal usage summary (JWT)
- **GET `/api/admin/users`** — User list (admin)
- **PATCH `/api/admin/users/:id/store-limit`** — Adjust store limit (admin)
- **PATCH `/api/admin/users/:id/auto-mode`** — Toggle auto mode permission (admin)
- **PATCH `/api/admin/users/:id/trial`** — Reset/mark trial used status (admin)
- **PATCH `/api/admin/users/:id/trial-enabled`** — Toggle trial restriction 0=permanently bypass / 1=enabled (admin, v1.12.0)
- **DELETE `/api/admin/users/:id`** — Delete user with cascade (bindings, events, verification codes) (admin)
- **GET `/api/admin/analytics`** — Global analytics (admin)
- **GET `/api/admin/analytics/events`** — Event details (admin)
- **GET `/api/admin/bindings?userId=X`** — List store bindings with user info (admin)
- **DELETE `/api/admin/bindings/:id`** — Force-unbind any store (admin)
- **GET `/api/admin/invite-codes`** — List invite codes with usage status + user email (admin)
- **POST `/api/admin/invite-codes`** — Generate invite codes (`{ count }`, max 20) (admin)
- **DELETE `/api/admin/invite-codes/:id`** — Delete unused invite code (admin)
- **GET `/api/health`** — Health check

### Copy Flash Sale Flow
1. `enterCopyMode(flashSale)` — loads source item count and products into store
2. `CopyConfirmPanel` — 顶部三步提示（选择源活动 → 选择目标时间 → 创建复制任务），蓝底活动信息卡片 + 查看源活动商品（带 loading + 错误就近提示）
3. `executeCopy(targetTime)` — one-stop-shop execution (4 steps):
   - **Step 1:** Close any active flash sales (status=1)
   - **Step 2:** Fetch available time slots via `get_time_slot_id/`
   - **Step 3:** Create empty flash sale via `set_shop_flash_sale/` with `{ time_slot_id }`
   - **Step 4:** Save source product data locally via `saveCopiedSaleData()` (for popup display)
   - (Step 5 auto-submit removed in v1.5.0 — Demo button no longer submits products)
4. `SCHEDULE_COPY` — uses `chrome.alarms` for timed execution
   - Scheduled via `chrome.alarms.create('scheduled_copy', { delayInMinutes })`
   - On alarm, `scheduled_copy` creates empty activity and schedules `scheduled_copy_enable`
   - `scheduled_copy_enable` fires at `targetStartTime + 300` (5 min after activity starts) to run `runEnableLoop`
5. `TRIGGER_SCHEDULED_COPY_NOW` — manually trigger a scheduled copy immediately
   - Reads `_scheduledCopy` from storage, clears the alarm, calls `executeScheduledCopyFlow()` immediately
   - Popup button "手动触发定时任务" moved to 更多折叠区 (v1.6.4)
   - If `now >= targetStartTime + 300`: runs `runEnableLoop` immediately. Otherwise: creates `scheduled_copy_enable` alarm
   - **`executeScheduledCopyFlow` sets `infiniteRetry: true`** so the enable loop doesn't stop after 10 rounds
6. `GET_SCHEDULED_STATUS` (v1.6.4) — 查询定时任务存活状态
   - Store `checkScheduledCopy` 发送消息到后台，后台检查 `chrome.alarms.get('scheduled_copy')` 是否仍注册
   - 返回 `ScheduledTaskStatus` 包含 alarm 存活状态和剩余秒数
   - Popup 琥珀色卡片实时展示，支持手动刷新

### Auto Mode Flow (v1.7.0)
1. **进入自动模式** — 点击主界面「自动模式」按钮 → CSS 3D 翻转动画切换到 `AutoModePanel`
2. **配置参数**: 选择轮数/天数 → 设置提前/延迟分钟 → 可选「加速调试」
3. **选择模板活动**: 从列表点击活动 → `loadFlashSaleProducts` 加载商品 → 显示模板商品列表
4. **选择申报场次**: 点击「选择场次」→ `TimeSlotModal` 调用 API 获取场次 → 用户选择 → 蓝色信息条展示
5. **编辑商品参数** (可选): 点击商品 → `SkuTable` 弹窗 → 批量编辑框 / 逐 SKU 编辑 → 动态「已编辑」标记
6. **启动**: `validate()` → `startAutoMode(config, templateId, templateName, debug, slotId, slotTime)` → `START_AUTO_MODE` 消息
7. **后台执行循环**:
   - `scheduleNextRound()` → `auto_mode_create` alarm → `handleAutoModeCreate()` 创建空活动 + 保存数据
   - `auto_mode_enable` alarm → `handleAutoModeEnable()` 刷新库存 + `runEnableLoop()` 传递商品
   - 完成后 `sourceFlashSaleId` 指向当前活动 → 下一轮沿用 → 循环
8. **停止**: `stopAutoMode()` → `STOP_AUTO_MODE` → 清除 alarms + `_enableParams` + 移除 `_autoModeStatus`
9. **查看商品**: `ProductViewModal` 二级窗口，从 `_copiedSaleData` 加载（已刷新库存），支持搜索筛选

### `get_shop_flash_sale_item/` Response Format
The API returns two possible formats (check both):
- `data.items` — SKU-level array with `item_id`, `model_id`, `stock`, `purchase_limit`, `promotion_price`
- `data.item_info` — Product-level array with `itemid`, `price`, `stock`, `images`
- `data.model_info_str` — JSON string with per-SKU regular prices in array format: `{"itemId":[{"modelid":123,"price":99,...},...]}`
- If `model_info_str` is missing, use `item_info[].price` as fallback

### Caching
- 30-minute cache via `browser.storage.local` (`flashSaleCache` key, defined as `CacheData` in types.ts)
- Persists: products, flashSaleList, flashSaleId, enableProgress, skuOverrides, global params
- Auto-loads on popup open; auto-saves after fetch/enable operations
- Manual clear via "清除缓存" button (v1.6.4: 已移至底部「更多」折叠区): `clearCache()` + `reset()` + `extractSpcCds()`

### Flash Sale Enable Flow (background.ts `runEnableLoop`)
1. Build `EnableItem[]` from params, filtering out 0-stock SKUs
2. Save initial progress with `running: true` immediately (so popup reopen sees correct state)
3. POST to `set_shop_flash_sale_items` with `use_global_category: true`
4. Parse failed items from `response.data.failed_items`
5. Retry failures (with adaptive stock halving for `NOT_ENOUGH_STOCK` errors)
6. Run diagnosis query for small batches (≤10 failed items at a time)
7. Track progress via `EnableProgress` interface (round/success/failure counts)
8. Fatal errors (missing seller tab) auto-stop the loop

### Enable Loop Guards
- `_enableRunning` flag prevents concurrent loops (checked at function entry, always reset in finally)
- `_enableStopRequested` flag enables clean stop via STOP_ENABLE message
- **Zero-progress stall detection:** 5 consecutive rounds with 0 successful SKUs stops the loop (catches persistent API errors that don't resolve on retry)
- **Periodic SPC_CDS refresh:** Every 3 rounds, `runEnableLoop` re-reads SPC_CDS from cookies via `getSpcCdsFromCookies()` to prevent token expiry (`code 1001 spex common error`)
- **Low-failure stall detection:** ≤3 failing SKUs for 10 consecutive rounds without count change auto-stops
- Fatal errors (no seller tab) stop loop immediately
- Storage read retries (5 attempts) handle SW cold-start timing

### State Shape (Store)
- **SPC_CDS:** spcCds, spcCdsVer, isConnected, isExtracting
- **Shop Info (from login API):** shopId, accountId, shopUsername
- **Products:** productIds[], products[], inputText, isLoading, error
- **Flash Sales:** flashSaleList[], flashSaleId, flashSaleInfo, isLoadingFlashSales
- **Enable:** maxRetries, infiniteRetry, discountRate, flashSaleStock, purchaseLimit, isEnabling, enableProgress
- **Copy:** copySource (flashSale + itemCount), copyMode, copyTaskStatus, isCopying, savedTemplates[], selectedTemplate, hasScheduledCopy, scheduledTaskStatus
- **One-Day SKU:** oneDaySkuSelectedIds[], oneDaySkuFlow (phase/running/currentIndex/total/message/error/items[]/canStartFlashSale)
- **First Use:** firstUse (open/loading/products[]/selectedIds/searchKeyword/searchResults[]/fetchedTotal/hasMore/cursor)
- **SKU Overrides:** `Record<string, SkuOverride>` keyed by `${itemId}-${modelId}` (fields: `discountRate?`, `promoPrice?`, `stock?`, `purchaseLimit?`)
- **Auto Mode:** autoModeView, autoModeConfig, autoModeStatus, autoModeLogs, firstSelectedActivity

### SKU Override System
- Per-SKU discount rate, direct promo price, activity stock, or purchase limit
- Overrides stored in `skuOverrides` record keyed by `${itemId}-${modelId}`
- Empty fields = use global defaults
- **`promoPrice` has highest priority** — when set, item building uses it directly instead of calculating from `discountRate`. This avoids double rounding loss (e.g., 原价 230, 输入限时价 8 → 如果走折扣率 `Math.round(8/230*100)=3%` → `Math.floor(230*3/100)=6`，丢了 2 元)
- **`promoPrice` 与 `discountRate` 互斥** — 设置折扣%时清空 `promoPrice`, 设置限时价时仅保存 `promoPrice`（不反算折扣率），两个字段不同时存在于同一个 override 中
- **覆盖提示 UI (v1.6.2)** — `App.tsx` 的 `overrideSummary` 只统计当前商品列表中存在的覆盖 SKU；详情父弹窗支持搜索商品标题、商品 ID、SKU 名称、SKU ID。点击“查看 SKU”不得关闭父弹窗，否则用户返回详情时搜索上下文会丢失。
- **复制活动全量覆盖 (v1.6.2)** — 复制源活动时，所有 SKU 都必须固化为 `skuOverrides`。没有显式覆盖的 SKU 使用当前全局参数计算并写入覆盖项，确保加载新复制活动后提示为“全部手动修改过”，且全局折扣行不会影响这些 SKU。

### Template System
- Save/load full configuration (discount rate, stock, purchase limit, SKU overrides)
- Product diff on apply: warns about removed (yellow) and added (blue) products
- Templates stored in `browser.storage.local` under `flashSaleTemplates` key
- **Export**: Each template row has a blue "导出" button that downloads a JSON file (`{ version: 1, type: 'flash_sale_template', name, exportedAt, data: { discountRate, flashSaleStock, purchaseLimit, skuOverrides, productInfo } }`)
- **Import**: "导入模板" button in idle state opens a file picker, validates the JSON format (checks `version`, `type`, `data` fields), and saves via `importTemplate` store action. Supports `.json` files exported from any instance.
- **Edit (v1.5.0)**: Each template row has a sky-blue "编辑" button that opens `TemplateEditDialog`. The dialog displays global params (折扣率%, 活动库存, 限购数量) and SKU overrides grouped by Item ID. Parent rows show ▶/▼ toggle, product name, SKU count, and an inline "Model ID + +SKU" quick-add. Expanded child rows show editable inputs for 折扣%, 限时价, 活动库存, 限购数量 with a 移除 button. Supports "全部展开/收起" for the current page. Paginated at 8 Item IDs per page with ‹上一页/下一页› controls. Bottom bar shows total product + SKU counts. Save calls `updateTemplate` which merges changes into existing template and sets `updatedAt`.

### Content Script Progress UI
- **Unified floating panel (v1.13.2):** `createPanel()` builds three sections in a single container (`#__flash_sale_panel__`): `autoSectionEl` (auto mode status), `progressSectionEl` (enable progress, lazily built by `buildProgressSection()`), and `copySectionEl` (copy countdown/progress). The old competing `createProgressUI()` that destroyed other sections was removed. `showComplete()` auto-hides the progress section after 3s and only removes the full panel when no other sections are visible. All three flows (manual enable, wizard enable, auto mode) now share the same floating panel.
- Semi-transparent with backdrop-filter blur
- Enable panel: shows success/failed counts, round number, progress bar, stop button; auto-fades 3s after completion
- Copy panel: shows countdown when scheduled, step progress during execution, auto-fades 3s after completion
- **Storage backup:** On init, reads `_enableProgress` and `_copyCountdown` from storage to show UI without waiting for messages. `storage.onChanged` listener updates UI in real-time when messages are missed.
- **Stale DOM cleanup:** `createPanel()` removes leftover `#__flash_sale_panel__` before creating a new one.
- **Failed detail images (v1.5.0):** `renderFailedDetails()` uses `normalizeImageUrl()` to prepend `https://cf.shopee.tw/file/` to raw image IDs from the API. Checks for `http://`, `https://`, `data:` prefixes before prepending (supports mixed URL formats).

### Type Definitions (types.ts full catalog)
- **ShopeeModel** — SKU/Model data: modelid, name, originPrice, normalStock, totalNormalStock, enableShopFlashSaleNewStock, etc.
- **ShopeeProduct** — Product data: itemid, name, images[], originPrice, modelList[], normalStock, status, etc.
- **ProductsQueryVariables** — GraphQL input: productIds[], statusType
- **ProductsQueryResponse** — GraphQL output: products.items[]
- **ShopeeApiResponse\<T\>** — API wrapper: code, message, user_message, data
- **FlashSale** — Activity: flash_sale_id, name, start_time, end_time, status
- **FlashSaleListData** — List response: flash_sale_list[]
- **FlashSaleItemIdListData** — Item ID list: item_ids[]
- **SkuOverride** — Per-SKU params: discountRate?, promoPrice?, stock?, purchaseLimit?
- **EnableItem** — Submit item: item_id, model_id, input_promo_price, stock, purchase_limit, status=1
- **EnableResult** — Submit result: item_id, model_id, err_msg?, unqualified_conditions?
- **EnableResponse** — Submit response: code?, data? (EnableResult[] | EnableResult)
- **EnableProgress** — Loop progress: totalSkus, successSkus, failedSkus, currentRound, maxRetries, nextRetryItems, hardFailedSkus?, isComplete, lastResponsePreview?
- **MessagePayload** — Union type for popup↔content communication
- **InjectionPayload** — Content script injection messages
- **CacheData** — 30-min cache schema (products, flashSaleList, enableProgress, skuOverrides, etc.)
- **TimeSlot** — timeslot_id, start_time, end_time
- **ScheduledCopyParams** — Scheduled copy task parameters
- **CopyTaskStatus** — Task status: scheduled, executed, success, newFlashSaleId?, error?
- **ScheduledTaskStatus** (v1.6.4) — GET_SCHEDULED_STATUS 返回: exists, alarmActive, params?, alarmScheduledTime?, remainingSeconds?
- **AutoModeConfig** (v1.7.0) — 自动模式参数: mode ('rounds'|'days'), value, advanceMinutes, delayMinutes
- **AutoModePhase** (v1.7.0) — 自动模式阶段: 'idle' | 'waiting_create' | 'creating' | 'waiting_enable' | 'enabling' | 'completed' | 'stopped'
- **AutoModeStatus** (v1.7.0) — 自动模式状态: isRunning, sourceFlashSaleId, sourceFlashSaleName, config, currentRound, totalRounds, phase, nextTargetTime?, nextActionTime?, currentFlashSaleId?, lastError?, startedAt, debugMode?, selectedSlotId?, selectedSlotTime?, enableParams?
- **AutoModeLog** (v1.7.0) — 自动模式日志: id, type ('info'|'success'|'warning'|'error'), message, timestamp
- **OneDaySkuFlowPhase** — Phase enum: 'idle'|'preparing_sku'|'publishing_product'|'searching_discount'|'removing_discount'|'restoring_discount'|'starting_flash_sale'|'editing_params'|'selecting_flash_sale'|'success'|'failed'
- **OneDaySkuDiscountInfo** — Discount search result: promotionId, name, startTime?, endTime?, timeStatus?, raw
- **OneDaySkuItemStatus** — Per-item status in flow: itemId, itemName, hasOneDaySku, skuCreated, publishStatus ('idle'|'success'|'failed'), discountRemoved, discountRestored, flashSaleStatus, highestPrice?, error?, discounts?
- **OneDaySkuFlowState** — Flow state: phase, running, currentIndex, total, message, error, items[], canStartFlashSale
- **ShopProductListItem** (v1.8.7) — 店铺商品简要信息: id, name, status, coverImage, priceMin, priceMax, modelCount, soldCount
- **FirstUseState** (v1.8.7) — 第一次使用状态: open, loading, products[], selectedIds (Set<number>), searchKeyword, searchResults[], fetchedTotal, hasMore, cursor
- **CopiedSaleData** — `_copiedSaleData` storage schema (source info + products + skuOverrides)
- **FlashSaleTemplate** — Named template: name, createdAt, updatedAt, discountRate, flashSaleStock, purchaseLimit, skuOverrides, productInfo[]
- **TemplateProductInfo** — Template product reference: itemId, name

### Config Files Reference
- **`wxt.config.ts`**: `extensionApi: 'chrome'`, manifest permissions `['storage','cookies','scripting','alarms','unlimitedStorage']`, host_permissions `['https://*.shopee.tw/*']`, Vite alias `@ → .`
- **`components.json`**: shadcn/ui config: `baseColor=slate`, `cssVariables=true`, `tsx=true`, aliases for `components/`, `utils`, `ui`
- **`tsconfig.json`**: `target=ESNext`, `moduleResolution=Bundler`, `jsx=react-jsx`, `strict=true`, `baseUrl=.`, path alias `@/* → ./*`, includes `wxt.config.ts`
- **`tailwind.config.ts`**: Content paths: `entrypoints/**/*.{ts,tsx}`, `components/**/*.{ts,tsx}`; theme extends empty; no plugins
- **`postcss.config.js`**: Standard PostCSS with tailwindcss + autoprefixer plugins
- **`package.json`**: name=`limited-time-sale`, version=`1.7.0` (main), node scripts for dev/build/zip/postinstall

## Important Patterns & Gotchas
- **injectedFetch timeout:** 30s default (vs 10s for sc-fe-session, 15s in background)
- **Adaptive stock:** Failed SKUs with `NOT_ENOUGH_STOCK` get stock halved (min 1) on retry
- **Background injectedFetch:** Queries `tabs.query({ url: '*://seller.shopee.tw/*' })` — finds any seller tab, not just active one
- **Debug logging:** Uses `[bg:enable]`, `[bg:injectedFetch]`, `[START_ENABLE]`, `[enable]`, `[SPC_CDS]`, `[bg:executeCopy]`, `[bg:scheduled_copy]`, `[bg:scheduled_copy_enable]`, `[TRIGGER]`, `[loadFlashSaleProducts]`, `[fetchFlashSaleList]`, `[CopyConfirmPanel]`, `[bg:auto_mode]`, `[bg:START_AUTO_MODE]` tag prefixes
- **Price calculation:** `Math.floor(price * discountRate / 100)`
- **Component split:** `components/ui/` = generic shadcn/ui; `components/product/` = domain-specific (ProductCard, SkuTable, TemplateManager, TemplateEditDialog, CopyConfirmPanel, CopyResultPanel, SpcStatus)
- **Cache clearing:** `clearCache()` + `reset()` + `extractSpcCds()` chained on "清除缓存" button (moved to 更多折叠区 v1.6.4)
- **No test files** — testing is manual via Chrome extension reload
- **Copy flow debug button:** `CopyConfirmPanel.tsx` has a "🛠 立即创建 Demo" button (debug only, remove before release)
- **`enterCopyMode` loads products:** Always loads source flash sale's products into store for template path. Without this, `state.products` would be empty/stale and template application fails 100%.
- **`get_shop_flash_sale_item/` response format varies:** Sometimes returns `data.items` (SKU-level), sometimes `data.item_info` (product-level). Always handle both. `model_info_str` (per-SKU prices) is optional.
- **Referrer header approach unreliable:** The `from=sourceId` via Referrer header (server auto-copy) does NOT work with `fetch` API's `referrer` option in `executeScript` context. Always use manual copy (fetch items → apply via `set_shop_flash_sale_items/`).
- **Popup vs background `injectedFetch`:** Store's `injectedFetch` targets `tabs.query({ active: true, currentWindow: true })` (requires seller tab to be active). Background's version finds any seller tab via `tabs.query({ url: '*://seller.shopee.tw/*' })` (can run while user switches tabs).
- **Auto-submit removal (v1.5.0):** EXECUTE_COPY handler no longer auto-submits items as step 5. Demo button creates empty flash sale only. Submit happens manually when user clicks "开启限时特卖".
- **Shared scheduled copy flow:** `executeScheduledCopyFlow()` is used by both the `chrome.alarms` handler and `TRIGGER_SCHEDULED_COPY_NOW` to avoid duplication. Same flow (close → slots → create → save).
- **TRIGGER_SCHEDULED_COPY_NOW timeout:** Popup's `waitForStorage` for EXECUTE_COPY uses 120s timeout (vs 60s default) to accommodate auto-submit retries. If timeout fires, background continues and status can be checked by reopening popup.
- **SPC_CDS reading in background:** Background handlers that run without a popup message (alarm, TRIGGER_SCHEDULED_COPY_NOW) must use `getSpcCdsFromCookies()` to read SPC_CDS directly from cookies via `browser.cookies.get()`. Do NOT read `spcCds` from `storage.local` — the popup store only saves it in Zustand memory state, not persistent storage. Message-based handlers (EXECUTE_COPY, etc.) receive SPC_CDS in the message and only fall back to storage.
- **SPC_CDS expiry in enable loop:** `runEnableLoop` uses SPC_CDS from initial params as URL parameter. Long-running loops can hit token expiry, causing `code 1001 spex common error` on ALL items. Fix: periodic refresh from cookies every 3 rounds via `getSpcCdsFromCookies()`.
- **Zero-progress stall detection:** When ALL submitted items fail for 5 consecutive rounds, the enable loop stops. This prevents infinite retry on persistent errors (expired token, invalid flash sale state, rate limit) while allowing transient errors to resolve between rounds.
- **Content script message fallback:** Content script uses `storage.onChanged` as backup for `ENABLE_PROGRESS` messages. Both `_enableProgress` and `_copyCountdown` changes trigger UI updates in the content script regardless of message delivery success.
- **enableFlashSaleItems boot confirmation (v1.4.0):** Changed from relying on `sendMessage` return value (MV3 bug, returns `undefined`) to fire-and-forget + `storage.onChanged('_enableProgress')` listener pattern. On enable click: clears old `_enableProgress` → saves `_enableParams` → sends START_ENABLE (fire-and-forget) → waits for `_enableProgress.running = true` via `storage.onChanged`. Timeout 5s with one retry (4s), then direct storage read as last resort. Same pattern as `executeCopy`'s `waitForStorage`.
- **SkuTable 输入框字段保留规则 (v1.4.0):** 四个输入列编辑时，每个 `onChange`/`onBlur` 必须保留所有其他 override 字段。折扣%列清空 `promoPrice`（互斥设计）但保留 `stock` 和 `purchaseLimit`。活动库存和限购数量列须保留 `discountRate`、`promoPrice`。限时价列保留 `stock` 和 `purchaseLimit`。错误示例：在 `v1.3.0` 中，活动库存 `onChange` 缺少 `promoPrice` 保留，导致编辑库存后已设置的限时价丢失。
- **`setSkuOverride` 缓存持久化 (v1.4.0):** `setSkuOverride` 之前仅更新 Zustand 内存状态，关闭 popup 后编辑丢失（下次打开时 `loadCache` 加载旧缓存）。现在每次编辑后自动调用 `saveCache()` 将 `skuOverrides` 持久化到 `flashSaleCache`。
- **Content script 图片 URL 拼接 (v1.5.0):** Shopee API 返回的 `images[0]` 是原始图片 ID（如 `tw-11134207-820l6-mna42fatmeiqd7_tn`），不带域名前缀。`renderFailedDetails()` 渲染失败详情的缩略图时必须调用 `normalizeImageUrl()` 补全为 `https://cf.shopee.tw/file/` + ID。该函数兼容已有完整 URL（`http://`、`https://`、`data:` 开头则原样返回）。同样的问题在 `SkuTable.tsx` 也存在但已经通过 `_tn` 后缀拼接修复。
- **`updateTemplate` 部分更新模板 (v1.5.0):** 新增 store 方法，接受 `name` + `Partial<FlashSaleTemplate>`。内部读取 `flashSaleTemplates` → 查找已有模板 → 合并字段（保留 `name`/`createdAt`，自动设 `updatedAt`）→ 写回 storage。与 `importTemplate`（全量替换）不同，此方法只修改传入的字段。
- **TemplateEditDialog 数据分组与分页 (v1.5.0):** 数据加载时将 `skuOverrides` 按 `itemId` 分组为 `ItemGroup[]`（`itemId`, `productName`, `models[]`），排序后分页（`PAGE_SIZE=8`）。展开状态用 `Set<string>` 追踪，`useMemo` 计算当前页数据。新增 SKU 时自动加入展开集合并按 modelId 排序。删除最后一个 SKU 时自动移除整组。
- **`model_info_str` 格式 (v1.6.0):** API 返回格式是 `{ itemId: [{ modelid, price, stock, ... }, ...] }`（数组而非嵌套对象）。解析时先 `JSON.parse` 得到 `Record<string, Array<...>>`，再构建 `priceLookup: Record<string, Record<string, number>>` 用于后续查找。旧代码误当作 `{ itemId: { modelId: { price } } }` 导致全部 430 条 `promoPrice` 缺失。
- **`promoPrice` 来源 (v1.6.0):** `configItems[].promotion_price` 才是实际促销价，`model_info_str[].price` 是商品原价。`loadFlashSaleProducts` 正常 API 路径中直接用 `ci.promotion_price` 作为 `promoPrice`，不再从 `priceLookup` 取。430 条命中率从 0 → 430。
- **Per-SKU `discountRate` 补全 (v1.6.0):** `loadFlashSaleProducts` 在 `await fetchProducts()` 完成后，遍历 `loadedProducts` 中每个 SKU，用 `Math.round(promoPrice / originPrice * 100)` 反推 `discountRate` 并填入 `skuOverrides[key]`。复制数据加载路径（`_copiedSaleData`）也做同样处理。确保 SkuTable 的折扣%列和限时价列同时显示实际值。
- **SkuTable `key` prop (v1.6.0):** 三处渲染点（`ProductList.tsx`, `CopyConfirmPanel.tsx`, `App.tsx`）都需 `key={product.itemid}`。缺少 key 时切换商品 React 复用同一实例，内部 `priceEditValues` state 不重置，可能导致旧商品的编辑残留覆盖新商品字段。
- **`enterCopyMode` 不再自动选择模板 (v1.6.0):** 旧代码 `selectedTemplate: names[0]` 自动选第一个模板，其 `discountRate=60`、`flashSaleStock=200` 等默认值进入 `executeCopy` → 保存到 `_copiedSaleData`，导致加载复制活动时全局输入框显示模板默认值而非实际 flash sale 配置。改为 `selectedTemplate: null`，用户需手动选择模板。
- **`loadFlashSaleProducts` `fetchProducts` 改为 await (v1.6.0):** 正常 API 路径中 `fetchProducts()` 由 fire-and-forget 改为 `await`，确保产品详情加载完成后才能基于 originPrice 反推 `discountRate` 和全局显示值。
- **CopyConfirmPanel 时段默认选择 (v1.6.1):** 移除 `当前时间+2小时` 最近时段启发式算法，改为直接选中 `slots[0]`（第一个可用时段）。避免因 `now+2h` 更接近第二场时段而跳过第一场。
- **定时任务两阶段 alarm (v1.6.1):** `scheduled_copy` alarm 仅创建空活动并安排 `scheduled_copy_enable` alarm。后者在 `targetStartTime + 300`（活动开始后 5 分钟）触发并执行 `runEnableLoop`。避免活动未开始导致 API 拒绝提交全部 SKU 失败，触发零进展僵局检测后终止。
- **`_copiedSaleData` 缓存验证 (v1.6.1):** `loadFlashSaleProducts` 找到缓存后先调 API 验证商品 ID 一致性。不一致则自动清除过期缓存并回退到 API 路径。解决用户手动替换商品 ID 后仍显示旧复制商品的问题。
- **覆盖详情父/子弹窗层级 (v1.6.2):** 覆盖详情父弹窗使用 `z-40`，`SkuTable` 使用 `z-50`。点击父弹窗里的“查看 SKU”只调用 `setSelectedFailedProduct(product)`，不要关闭 `overrideDetailOpen`。若关闭父弹窗，会丢失搜索结果和当前查看上下文。
- **覆盖详情搜索 (v1.6.2):** 搜索实现沿用 `ProductList` 的 `includes` 思路，但范围扩展为商品标题、商品 ID、SKU 名称、SKU ID。商品命中时展示该商品全部已覆盖 SKU；仅 SKU 命中时展示匹配 SKU。空结果显示“无匹配商品或 SKU”。
- **复制活动 SKU 覆盖固化 (v1.6.2):** `executeCopy()` 必须在过滤当前商品前补齐每个 SKU 的 `skuOverrides[key]`。旧 `_copiedSaleData` 加载路径也要在 `copiedData.products` 遍历时补齐缺项。否则复制活动中未显式编辑过的 SKU 会继续吃全局折扣行，违背"复制源活动所有商品都等同手动编辑"的业务规则。
- **异步按钮统一范式 (v1.6.3):** 所有触发异步操作的按钮必须：点击后用局部 `useState` 切换 loading 文案（`setXxx(true)` → `await action()` → `finally { setXxx(false) }`）、`disabled={isLoading}` 防重复点击。`extractSpcCds` 按钮用 store 的 `isExtracting` 状态而非局部。开启限时特卖例外：按钮从「🚀 开启」切换到「⏹ 停止」即为反馈。禁止在 loading 期间允许点击。
- **按钮颜色四色体系 (v1.6.3):** 蓝色 outline（普通操作）、绿色实心（主确认）、红色 outline（停止/危险）、灰色（次要）。hover 规则：`hover:bg-{color}-50 hover:text-{color}-600 hover:border-{color}-300`。危险操作（停止、清除缓存）禁止用蓝色。
- **高级操作折叠 (v1.6.3):** 「清除缓存」和「手动触发定时任务」在 `</CardContent>` 闭标签前的 `<details><summary>高级操作</summary>...</details>` 中。仅在 `isConnected` 时渲染，默认收起（不含 `open` 属性）。常用操作（获取商品、刷新、复制、开启/停止、模板）仍留在主界面。
- **活动上下文展示条 (v1.6.3):** `Separator` 后、商品列表前渲染。显示条件：`flashSaleId && !copyMode`。从 `flashSaleList` 查找当前活动，`name` 为空时回退 `活动 #{id}`。样式：`bg-blue-50 border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-700`。
- **编辑痕迹强化 (v1.6.3):** 商品列表 `div.max-h-48` 内顶部渲染，条件：`overrideSummary.skuCount > 0`。显示 `已手动编辑 X 个商品 / Y 个 SKU` + 蓝色「查看详情」按钮（`onClick={() => setOverrideDetailOpen(true)}`）。SKU 来源通过输入框 `placeholder` 暗示（全局默认值 vs 手动输入值）。
- **复制步骤提示 (v1.6.3):** `CopyConfirmPanel` 返回按钮后、`Card` 前渲染。三步文字居中：`● 选择源活动 → ● 选择目标时间 → ○ 创建复制任务`。前两步 `text-blue-600 font-medium`，第三步 `text-gray-400`，箭头 `text-gray-300`。纯展示不控流程。
- **错误提示就近化 (v1.6.3):** `CopyConfirmPanel` 新增 `viewError` 局部状态，查看按钮旁显示红色文字 `<span className="text-[10px] text-red-500">{viewError}</span>`。其他 inline 提示已存在：`applyMessage`（应用模板）、`saveSuccess`（保存模板）、`importMessage`（导入模板）、`slotsError`（时间段选择）。
- **定时任务存活检测 (v1.6.4):** `checkScheduledCopy` 现在会自动调用后台 `GET_SCHEDULED_STATUS`。状态卡片仅在 `hasScheduledCopy && scheduledTaskStatus?.exists` 时渲染。若后台无响应（如 Service Worker 未就绪），catch 块会回退到仅设 `alarmActive: false`，不会清空 `_scheduledCopy` 数据。`checkCopyTaskStatus` 和 `executeCopy(SCHEDULE)` 成功路径都会触发 `checkScheduledCopy` 调用。
- **布局信息分层 (v1.6.4):** 活动上下文条和定时任务卡是 `CardContent` 最顶层元素，始终在错误提示和活动列表之前渲染。「更多」折叠区是唯一 `<details>` 入口，收纳了商品 ID 输入、获取商品信息、模板管理、手动触发、清除缓存。原有的独立「高级操作」`<details>` 已删除。模板管理从独立区域移至「更多」内，不再占用主视图。
- **自动模式 — `AutoModePanel` 状态重置 (v1.7.0):** `handleSelectTemplate` 切换模板活动时清空 `selectedSlot` 和 `editedProductIds`，防止新旧模板数据混淆。
- **自动模式 — 启动前场次验证 (v1.7.0):** `START_AUTO_MODE` handler 启动前通过 API 验证选定场次：是否存在、开始时间是否变更、是否已开始。任一条件不满足则返回 error 拒绝启动。
- **自动模式 — 停止彻底清理 (v1.7.0):** `STOP_AUTO_MODE` 在原有 alarms 清理基础上新增 `browser.storage.local.remove('_enableParams')`，防止重启后残留参数导致场次状态异常。
- **自动模式 — `scheduleNextRound` 场次优先 (v1.7.0):** 第一轮若存在 `selectedSlotId` 且验证通过，直接使用用户选定场次而非调用 `pickNextTargetTime`。验证失败时自动回退到自动选择并写 warning 日志。
- **`loadFlashSaleProducts` 缓存后刷新 (v1.7.0):** 缓存命中后追加 `await fetchProducts()` 调用，合并新鲜 `normalStock`/`totalNormalStock` 到缓存商品。两个「查看商品」入口 (`ProductViewModal`, `SkuTable`) 现在都显示实时库存。
- **SkuTable `onEdit` 回调 (v1.7.0):** 可选 prop，任何用户触发的 `onChange`/`onBlur` 修改均调用。用于 `AutoModePanel` 的动态「已编辑」标记机制。不影响手动模式现有行为。
- **Teal 主题色系统 (v1.8.0):** 主色调从 Shopee 橙 (#EE4D2D) 改为 Teal (#0D9488)。CSS 变量全部改为 teal HSL（hue 173），tailwind.config.ts 新增 `shopee-brand/brand-dark/brand-light` 色值。所有组件引用从 `orange` 改为 `brand`。
- **.env 配置系统 (v1.8.0):** 新增 `.env.example` + `.env` 管理后端地址。`import.meta.env.VITE_BACKEND_URL` 提供默认值，`backend-api.ts` 和 `store.ts` 读取。`setBackendUrl` 只在地址非默认时持久化到 storage，`checkAuthOnStartup` 清理 storage 中的旧默认值，避免代码默认值变更后被旧 storage 覆盖。
- **认证注册流程内联验证码 (v1.8.0):** 注册表单中验证码显示框和输入框与邮箱/密码同行展示，无需单独步骤。验证码显示区域可点击触发注册 API。输入 6 位验证码后自动调用 verify API 完成验证。成功页展示"前往登录"按钮。
- **pre-commit build 自检钩子 (v1.8.0):** `.githooks/pre-commit` 在 `git commit` 前自动运行 `npm run build`，构建失败则阻止提交。使用 `git config core.hooksPath .githooks` 启用。
- **1 天备货 SKU — `buildOneDaySkuProductInfo` 数据流:** 输入 `ShopeeProduct`（GraphQL camelCase）+ `ProductInfoPayload`（REST snake_case 来自 `get_product_info`）。在 `std_tier_variation_list` 第一层追加/查找"批發客戶下訂-請勿下單"选项，然后通过 `generateTierCombinations()` 生成新选项与其他所有层的笛卡尔积组合索引。cleanModel() 剥离响应格式字段，保留 id、tier_index、price、stock_setting_list、pre_order_info。
- **1 天备货 SKU — 多规格组合生成:** `generateTierCombinations(newTier0Idx, tierVariationList)` 遍历第 2~N 层的所有规格选项，生成 `newTier0Idx × count(tier2) × count(tier3) × ...` 个组合。例如第一层新增索引 4、第二层 8 个选项 → 生成 `[[4,0],[4,1],...,[4,7]]` 共 8 组索引。
- **1 天备货 SKU — 100 组上限保护:** Shopee 限制商品最多 100 个 model。创建前检查 `nextModelList.length + tierCombinations.length > 100`，超限时抛出清晰错误信息。
- **1 天备货 SKU — 库存提取:** `extractSellableStock()` 同时处理 `stock_setting_list`（请求格式）和 `stock_detail`（响应格式），从 `seller_stock_info[0].sellable_stock` 提取可售库存。
- **1 天备货 SKU — `getDiscountRatio(modelList)`:** 遍历现有 SKU 的 `price_info.input_promotion_price / input_normal_price`，返回最高比率（最轻折扣 = 最高折数，如 6.5折 > 5.4折 → 0.65）。用于为新增的 1 天备货 SKU 计算折扣价。
- **1 天备货 SKU — `buildDiscountRestoreList(modelList, productId, discountRatio?)`:** 将 model_list 转为 `discount_model_list`（`update_seller_discount_items` 请求体）。已有 `input_promotion_price` 的 SKU 直接用现有折扣价；没有的（新增 SKU）在提供 `discountRatio` 时用 `normalPrice * discountRatio` 计算。
- **1 天备货 SKU — runOneDaySkuAndEnable 完整流程 (Phase 2):** 在 popup store（非 background）中运行。全流程：`get_product_info` → 检测已有 1 天 SKU 则跳过 → `buildOneDaySkuProductInfo` → 搜索折扣活动（`discount/search`）→ 从折扣中移除（`delete_abnormal_seller_discount_items`，多折扣间隔 2s）→ **防抖 2s** → 发布商品（`update_product_info`）→ 5 倍价格检测&重试（重试路径同样防抖 2s）→ 重新获取商品信息（含 3 次重试、1 秒间隔）→ **防抖 2s** → 恢复折扣含新 SKU（`update_seller_discount_items`，多折扣间隔 2s，检查 `failed_item_list`/`error_list`）。全程 `[一键修复]` 控制台日志。
- **1 天备货 SKU — 4 节点防抖 (v1.8.6):** 为避免虾皮 API 处理延迟导致请求异常，在折扣移除→发布→恢复流程中加入 4 个防抖节点（各 2s）：① 移除全部折扣后等 2s 再发布；② 发布成功后等 2s 再恢复第一个折扣；③ 多个折扣活动操作之间各间隔 2s；④ 5 倍价格差重试路径同样在移除后等 2s 再重新发布。三个循环从 `for-of` 改为索引循环（`di > 0` 条件跳过首个请求的延迟）。
- **1 天备货 SKU — 折扣率自动检测 (v1.8.7):** `runOneDaySkuAndEnable` 在遍历商品时通过 `collectedRatios` 收集每个商品的实际折扣率（`getDiscountRatio(originalModelList)`），包括已有 1 天 SKU 的商品和修复后成功的商品。全部收集完成后计算全局 `discountRate`：所有商品折扣率一致时直接用该值，不一致时取平均值。确保修复完成后 Wizard 的 `editing_params` 阶段显示用户实际设定的折扣（如 5.4折→54%）而非默认值 60%。
- **1 天备货 SKU — 修复后 Wizard 三阶段 (v1.8.7):** `runOneDaySkuAndEnable` 完成后不再直接结束，而是进入 `editing_params` 阶段：展示修复成功的商品卡片（可点击编辑 SKU/全局参数），用户确认后进入 `selecting_flash_sale` 阶段：可选择已有限时特卖（调用 `addToExistingFlashSale`）或创建新场次（`createNewFlashSaleAndAdd`，先通过 `fetchTimeSlots` 获取可用时段）。`publishStatus` 移除 `skipped`，已有 1 天 SKU 的商品也标记为 `success` 并直接进入 Wizard 流程。
- **1 天备货 SKU — FirstUse 场景支持 (v1.8.7):** `getHighestModelPrice` 新增可选 `productInfoModels` 参数，`ShopeeProduct.modelList` 为空时（FirstUse 流程仅构造壳对象）从 `product_info.model_list` 取价格。`extractSellerDiscounts` 新增过滤逻辑：`timeStatus === 3` 或 `endTime < now` 的已结束折扣不再返回。
- **FirstUseModal — 第一次使用流程 (v1.8.7):** 新用户无需手动输入商品 ID。点击「第一次使用」按钮打开模态窗口，通过 `search_product_list` API (`fetchShopProductsPage`) 分页获取店铺全部商品（每页 12，按销量排序），支持关键词搜索。勾选最多 20 个商品后「开始修复」，`runFirstUseFlow` 构造骨架 `ShopeeProduct[]`（仅含 itemid/name/images/price），设置 `oneDaySkuSelectedIds` 后自动调用 `runOneDaySkuAndEnable`。每个商品处理时从 API 获取完整 `product_info` 后构建 1 天备货 SKU。
- **addToExistingFlashSale / createNewFlashSaleAndAdd / scheduleEnableForFlashSale (v1.9.0):** Wizard `selecting_flash_sale` 阶段的三个提交路径。`addToExistingFlashSale` 已重构：构建 enable items（含 `item_display_image` 从 `p.images?.[0]`、`stock` 上限 `Math.min`、零库存过滤、未打折 SKU 检测、活动结束检查）→ 保存 `_enableParams` → 发送 `START_ENABLE` → Background `runEnableLoop` 多轮重试+错误处理，与手动模式 `enableFlashSaleItems` 路径一致。`createNewFlashSaleAndAdd` 支持两阶段：`advanceMin > 0` 时发送 `SCHEDULE_WIZARD_FLOW` 给 background 定时创建空活动（`wizard_create` alarm），`delayMin` 控制活动开始后多久提交；`advanceMin=0` 时立即创建；空活动创建后设置 `_pendingFlashSaleData` / `_copiedSaleData` 确保 `loadFlashSaleProducts` 能找到商品数据。`scheduleEnableForFlashSale` 新增：定时加入已有活动，发送 `SCHEDULE_ENABLE` 给 background → `scheduled_enable` alarm。UI: `selecting_flash_sale` 阶段顶部显示两个时间输入框 (`wizardAdvanceMin`/`wizardDelayMin`)，slot 列表使用 radio 选中模式 + 统一「开始」按钮 + 调试按钮（传入 `now` 作为 slotStartTime 强制立即执行）。
- **邀请码系统 (v1.11.0):** 替换全局 `REGISTER_KEY` 为一次性邀请码。`invite_codes` 表字段：id, code(UNIQUE), is_used, used_by, created_at, used_at。注册时 `POST /register` 校验邀请码（查表 is_used=0），成功后标记 is_used=1。管理员在 AdminPanel「邀请码」标签页生成（格式 `INV-xxxxxxxx`，批量 1-20 个）、查看使用状态、删除未使用邀请码。前端注册表单「注册密钥」→「邀请码」。`.env.example` 移除 `REGISTER_KEY`。
- **定制开发弹窗 (v1.11.0):** 非管理员用户右上角显示渐变「定制开发」按钮（orange-400→amber-500），点击弹出模态窗口宣传虾皮定制开发服务。模态窗口使用渐变色头部 + 功能列表 + 琥珀色行动号召卡片。
- **tsconfig 修复 (v1.11.0):** `tsconfig.json` 排除列表中移除 `.wxt`，修复 VSCode 中 `browser` 全局类型找不到的问题（WXT 在 `.wxt/wxt.d.ts` 中生成类型声明）。
- **部署初始化脚本 (v1.11.1):** `backend/src/seed.ts` 解决首次部署无管理员死锁问题。从环境变量 `INIT_ADMIN_EMAIL`/`INIT_ADMIN_PASSWORD` 创建管理员账号，`INIT_INVITE_CODES` 控制初始邀请码数量。`npm run seed` 幂等执行，管理员已存在或邀请码已有时自动跳过。`.env.example` 新增相关配置项。
- **ESLint 全量修复 (v1.11.1):** 22 个问题清零。排除 `.agents/` 非项目目录；补充 `confirm`/`Response`/`URLSearchParams` 浏览器全局变量；修复 `preserve-caught-error`（`backend-api.ts`、`store.ts` 的 catch 块传入 `{ cause: e }`）；移除 `AutoModePanel.tsx` 未使用的 `flashSaleStock`/`purchaseLimit` 解构；`ScheduledTaskCard.tsx` 的 `now` 重命名为 `_now`；补全 `FirstUseModal.tsx` 两处 useEffect 依赖数组；`UndiscountedSkuModal.tsx` interval 模式的 useEffect 加 eslint-disable 注释（添加 `countdown` 依赖会每秒重建 interval 破坏倒计时）。
- **Background 后端地址 env 变量 (v1.13.1):** `background.ts:8` `DEFAULT_BACKEND_URL` 从硬编码 `'http://localhost:5724'` 改为 `import.meta.env.VITE_BACKEND_URL || 'http://localhost:5724'`。构建时 Vite 替换 env 变量为 `.env` 中的生产地址，避免 background 在无 storage 缓存时回退到 localhost。同项目 `backend-api.ts:10` 和 `store.ts:343` 已使用相同模式，无需修改。
- **Wizard 修复完成引导提示 (v1.13.1):** `App.tsx` `editing_params` 阶段，修复成功后（有 `publishStatus === 'success'` 的商品）在商品卡片列表下方、全局参数上方显示绿色提示："修复完成，请点击上方商品列表修改限时特卖商品价格，库存，限购等信息(默认参数是你的折扣信息。)，然后点击下一步：选择限时特卖。"。引导用户先编辑参数再进入下一阶段。
- **后端端口占用自动处理 (v1.13.1):** `backend/src/index.ts` server 监听 `error` 事件，`EADDRINUSE` 时自动执行 `npx kill-port <PORT>` 释放端口并重新监听，避免手动杀进程。
- **401 错误信息透传 (v1.13.2):** `backend-api.ts` `request()` 在 401 时先 `response.json()` 读取后端返回的 `error` 字段（如"邮箱或密码错误"），有则用后端消息，无则 fallback 到"认证已过期，请重新登录"。`clearAuth()` 在所有 401 路径均保留。
- **IP 回退 (v1.13.2):** `backend-api.ts` `tryFetch()` 包装主请求，网络错误时自动用 `_fallbackUrl`（来自 `VITE_BACKEND_FALLBACK_URL` env 变量，如 `http://43.99.86.228:5724`）重试。解决 VPN 用户 DNS 劫持导致域名不可达的问题。双地址均在 `.env.example` 中配置。
- **FirstUseModal 居中修复 (v1.13.2):** `FirstUseModal.tsx` 的 `items-end sm:items-center` → `items-center`，`rounded-t-xl sm:rounded-xl` + `sm:max-w-md` → `rounded-xl` + `max-w-md`，确保弹窗在 popup 中垂直居中而非底部对齐。
- **Wizard 试用校验补充 (v1.13.2):** `store.ts` `createNewFlashSaleAndAdd` 中「立即创建并提交（跳过等待）」调试按钮路径新增 `validateShopAccess(spcCds, 'wizard_flow')` 调用，在创建闪购前拦截试用到期用户，错误就地显示在 wizard 界面。
- **试用消耗修复 (v1.14.0):** `background.ts` `consumeTrial()` 原实现不检查 `response.ok`，fetch 在 4xx/5xx 不抛异常导致静默失败（log "已消耗"但后端未标记）。修复：添加 `response.ok` 检查 + 响应体错误提取 + 所有结果写入 `_consumeTrialLog` storage key 供 popup 调试。backend 新增 `POST /api/stores/consume-trial` 端点独立于 `/validate`（读写分离），`consumeTrial()` 在 `runEnableLoop` 成功后 fire-and-forget 调用。
- **悬浮面板 — 自动模式实时倒计时 (v1.13.3):** `content.ts` `renderAutoSection()` 渲染 `#__auto_countdown__` 倒计时元素，`updateAutoCountdown()` 每秒更新，显示距离 `nextActionTime`（操作触发时间）或 `nextTargetTime`（场次开始时间）的剩余分钟秒数。自动模式停止时自动清除计时器。
- **悬浮面板 — 最小化/恢复按钮 (v1.13.3):** 统一面板和复制 UI 均增加 `−` 最小化按钮（右上角）。`toggleMinimize()` / `toggleCopyMinimize()` 将面板收缩为右侧窄条，仅显示 `◀` 箭头 + 一行倒计时/状态摘要，实时更新。点击箭头还原完整面板。`panelMinimized` / `copyMinimized` 标志跟踪状态，`updateMinimizedContent()` / `updateCopyMinimizedContent()` 刷新收缩内容。
- **showComplete 初始化修复 (v1.13.3):** `showComplete()` 现在先调用 `createPanel()` + `buildProgressSection()` 再检查 `headerEl`，修复 `ENABLE_COMPLETE` 在 `ENABLE_PROGRESS` 之前到达（零项目或即时错误）时静默返回不显示面板的问题。
- **Wizard 重复点击防护 (v1.13.3):** `selecting_flash_sale` 阶段「立即加入」「定时」「开始」「调试」按钮增加 `disabled={isEnabling || oneDaySkuFlow.running || !!oneDaySkuFlow.message}`。Store 层 `addToExistingFlashSale`、`scheduleEnableForFlashSale`、`createNewFlashSaleAndAdd` 入口增加防重入守卫 `if (state.isEnabling || oneDaySkuFlow.running || oneDaySkuFlow.message) return`。`goToFlashSaleSelection` 清除 `message` 和 `error`，防止引导文案「请选择目标限时特卖场次」误触发按钮禁用。

## Known Issues / 待验证

- **即时复制后偶发仍显示源活动:** 复制创建新活动成功后，`flashSaleId` 已切换为新 ID（`set({ flashSaleId: newId })`），但在频繁创建/删除活动的场景下偶发仍显示源活动。怀疑是虾皮服务端缓存/CDN 不一致导致 `get_shop_flash_sale_list` API 短时间内返回不稳定结果。需等待虾皮系统稳定后重新测试复现。若确认是服务端问题，需考虑增加更激进的重试+去重策略（如合并本地 `_copiedSaleData` 到列表中）。

## Conventions
- Use `@/` path alias for all imports (maps to project root, configured in `tsconfig.json` paths and `wxt.config.ts` Vite alias)
- Use `browser.*` extension API (WXT shims to `chrome.*` under the hood)
- Zustand store pattern: `create<AppState>((set, get) => ({ ... }))` — all actions defined inline
- Async actions: `try/catch` with `console.log`/`console.error` prefix pattern for each action
- Component naming: PascalCase files, domain files in `components/product/`, generic UI in `components/ui/`
- shadcn/ui pattern: Components use `cva` + `cn()` + `React.forwardRef` + `VariantProps` for variants
- Storage keys: underscore-prefixed for internal state (`_enableProgress`, `_copiedSaleData`), non-prefixed for caches (`flashSaleCache`)
- Message passing: `browser.runtime.sendMessage()` for fire-and-forget, `browser.storage.onChanged` for critical status notifications
- Tailwind classes: Functional utility classes directly in JSX; no separate CSS modules
- Type definitions: All in `entrypoints/popup/types.ts`; shared between popup, background, and content script via WXT bundling

### Backend Auth Flow
- Registration accepts both email format and plain username (`/^[a-zA-Z0-9_.-]+$/`)
- Two-step activation: register (returns 6-digit code) → verify (activates account) → login (returns JWT)
- JWT stored in `chrome.storage.local` key `backendAuth`, auto-attached to `Authorization: Bearer` header
- 401 response triggers automatic auth clearing and redirects to login

### Login Gate (Extension)
- `checkAuthOnStartup()` loads saved auth from storage on popup open
- `isCheckingAuth` → loading spinner during startup validation
- `!isLoggedIn` → full-screen AuthPanel (login/register forms)
- Logged in + no store bindings → blocking "请先绑定店铺" message over main features
- Logged in + has bindings + current shop_id/SPC_CDS not in bindings → amber "当前店铺未绑定" hint (不再是硬阻断, 引导用户点击绑定按钮)
- Admin panel accessible without personal store bindings
- `isCurrentStoreBound` uses `shopId` match first, falls back to `spcCds` match for legacy data

### Store Binding
- **shop_id** is the stable binding anchor (from `GET /api/v2/login/`), SPC_CDS is only for API calls
- `storeBindings` table has `shop_id`, `account_id`, `shop_username` for stable identification
- Same shop_id + same user = auto-update SPC_CDS (session refresh, no re-binding needed)
- Different shop_id = shows "当前店铺未绑定" hint (amber) if capacity remains; "绑定当前店铺" button appears inline
- `isCurrentStoreBound` in App.tsx: **shop_id first, SPC_CDS fallback** for legacy records
- Each user has `users.max_stores` limit (default 1, admin-configurable)
- `StoreStatus` component shows current count vs limit, displays shop_id/shopUsername
- When current shop is not bound + `activeBindings.length < maxStores`: inline "绑定当前店铺" button shown below binding list
- Admin can force-unbind any user's store via AdminPanel "绑定管理" tab
- `GET /api/v2/login/?SPC_CDS=xx` is called after SPC_CDS extraction to get shop info

### Analytics Event Reporting
- Background SW uses `reportAnalyticsEvent()` helper (fire-and-forget `fetch()`)
- Reads `backendAuth` + `backendUrl` from `storage.local`, POSTs to `/api/analytics/events`
- Events: enable loop complete (`enable_loop`), copy flow (`copy_flow`), auto mode round (`auto_mode_round`), auto mode stop (`auto_mode_stop`)
- Errors silently ignored (fire-and-forget pattern)

### CORS Configuration
- Hono CORS middleware uses an `origin` function (not wildcards)
- Dynamically returns the exact `chrome-extension://<id>` origin
- Also allows `https://seller.shopee.tw`
- Static patterns like `chrome-extension://*` are NOT supported by Hono

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **limited-time-sale** (1779 symbols, 2799 relationships, 112 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/limited-time-sale/context` | Codebase overview, check index freshness |
| `gitnexus://repo/limited-time-sale/clusters` | All functional areas |
| `gitnexus://repo/limited-time-sale/processes` | All execution flows |
| `gitnexus://repo/limited-time-sale/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
| Work in the Popup area (98 symbols) | `.claude/skills/generated/popup/SKILL.md` |
| Work in the Product area (76 symbols) | `.claude/skills/generated/product/SKILL.md` |
| Work in the Entrypoints area (55 symbols) | `.claude/skills/generated/entrypoints/SKILL.md` |
| Work in the Ui area (16 symbols) | `.claude/skills/generated/ui/SKILL.md` |

<!-- gitnexus:end -->
