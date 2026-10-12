# 限时特卖助手 (Limited Time Sale Helper)

Chrome 扩展（MV3），专为 Shopee 台湾站卖家打造的限时特卖自动化工具。支持批量修复商品、一键开启特卖、定时复制、自动模式循环监控等功能。

## 技术栈

| 层 | 技术 |
|---|------|
| 扩展框架 | [WXT](https://wxt.dev/) (MV3) |
| 前端 UI | React 19 + TypeScript 6 + Tailwind CSS 3.4 + [shadcn/ui](https://ui.shadcn.com/) |
| 状态管理 | [Zustand 5](https://zustand.docs.pmnd.rs/) |
| 后端服务 | Node.js + [Hono](https://hono.dev/) + Drizzle ORM + SQLite (libSQL) |
| 测试 | Vitest (单元) + Playwright (E2E) |

## 功能概览

- **一键修复并开启特卖** — 自动为商品添加 1 天备货 SKU、处理折扣、提交到限时特卖
- **复制限时特卖** — 将已有活动的商品配置完整复制到新时间段，支持定时执行
- **自动模式** — 循环监控新场次 → 自动创建活动 → 自动提交商品，无需人工干预
- **模板管理** — 保存/加载/导出/导入 SKU 参数配置
- **定时任务** — 支持定时复制 + 定时开启，Service Worker 后台调度
- **悬浮进度面板** — 操作过程中在卖家中心页面显示实时进度
- **首次使用引导** — 向导式批量选择商品并修复
- **后端管理系统** — 用户认证、店铺绑定、使用统计、邀请码、试用限制、防破解

## 前置条件

- [Node.js](https://nodejs.org/) >= 18
- Chrome 浏览器
- 一个 Shopee 台湾站卖家账号

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/524110636/shopee-Flash-Sale.git
cd shopee-Flash-Sale

# 2. 安装依赖（根目录 + backend）
npm install
cd backend && npm install && cd ..

# 3. 配置环境变量
cp .env.example .env
cp backend/.env.example backend/.env
# 编辑 backend/.env，修改 JWT_SECRET（见下方说明）

# 4. 初始化数据库（首次部署）
cd backend && npm run seed && cd ..

# 5. 启动开发
# 终端 1 — 后端
cd backend && npm run dev

# 终端 2 — 扩展
npm run dev
```

### 环境变量配置

**根目录 `.env`**（扩展前端）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_BACKEND_URL` | 后端服务地址 | `http://localhost:5724` |
| `VITE_BACKEND_FALLBACK_URL` | IP 直连兜底（DNS 故障时） | 可选 |
| `VITE_DEBUG_LOGS` | 调试日志开关 | `false` |

**`backend/.env`**（后端服务）：

| 变量 | 说明 |
|------|------|
| `PORT` | 服务端口（默认 5724） |
| `JWT_SECRET` | JWT 签名密钥 — **必须修改**，使用示例值将拒绝启动 |
| `INIT_ADMIN_EMAIL` | 首次 seed 创建的管理员邮箱 |
| `INIT_ADMIN_PASSWORD` | 首次 seed 创建的管理员密码 |

> ⚠️ **安全提醒**：部署前务必修改 `JWT_SECRET`。可使用 `openssl rand -base64 32` 生成。

### 首次部署初始化

新部署没有管理员账号或邀请码（注册需要邀请码，只有管理员能生成）。运行 seed 脚本一次：

```bash
cd backend
# 编辑 .env 设置 INIT_ADMIN_EMAIL、INIT_ADMIN_PASSWORD、JWT_SECRET
npm run seed
```

这会创建管理员用户并生成初始邀请码。seed 脚本幂等，可安全重复运行。完成后可从 `.env` 删除 `INIT_ADMIN_*` 行。

## 开发命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动 WXT 开发服务器（热重载） |
| `npm run build` | 生产构建 |
| `npm run zip` | 构建 + 打包为 zip（Chrome Web Store） |
| `npm run lint` | ESLint 检查 |
| `npm run lint:fix` | ESLint 自动修复 |
| `npm run format` | Prettier 格式化 |
| `npm run format:check` | 检查格式化 |
| `npx tsc --noEmit` | TypeScript 类型检查 |
| `npm run test` | 全部测试（单元 + E2E） |
| `npm run test:unit` | 仅单元测试（Vitest） |
| `npm run test:e2e` | 仅 E2E 测试（Playwright） |
| `npm run test:ci` | 完整 CI：构建 + harness + 单元 + E2E |

### 后端命令

| 命令 | 说明 |
|------|------|
| `cd backend && npm run dev` | 启动后端（端口 5724，watch 模式） |
| `cd backend && npm run start` | 启动后端（单次运行） |
| `cd backend && npm run seed` | 初始化管理员 + 邀请码 |
| `cd backend && npm run build` | TypeScript 编译 |
| `cd backend && npm run db:push` | 推送 schema 到 SQLite |

### 后端部署（PM2）

```bash
npx pm2 start backend/src/index.ts --name limited-time-sale --interpreter tsx
npx pm2 status
npx pm2 logs limited-time-sale --lines 20
npx pm2 restart limited-time-sale
npx pm2 stop limited-time-sale
```

## 项目结构

```
├── entrypoints/                  # WXT 入口
│   ├── popup/                    # 弹窗 UI（React）
│   │   ├── App.tsx               # 主组件（布局 + 面板切换）
│   │   ├── store.ts              # Zustand 状态 + 业务逻辑
│   │   ├── api.ts                # GraphQL 商品查询
│   │   ├── backend-api.ts        # 后端 REST API 客户端
│   │   ├── one-day-sku.ts        # 1 天备货 SKU 构建器
│   │   └── types.ts              # TypeScript 类型定义
│   ├── background.ts             # Service Worker（循环、复制、定时、自动模式）
│   └── content.ts                # Content Script（悬浮进度面板）
├── components/
│   ├── ui/                       # shadcn/ui 基础组件
│   └── product/                  # 业务组件（AuthPanel、AutoModePanel、SkuTable 等）
├── backend/
│   └── src/
│       ├── index.ts              # Hono 入口（CORS、路由挂载、健康检查）
│       ├── db/schema.ts          # Drizzle ORM schema
│       ├── routes/               # API 路由（auth、stores、analytics、admin）
│       ├── middleware/auth.ts    # JWT 认证 + 管理员守卫
│       ├── utils/                # JWT 工具、验证码生成
│       └── seed.ts               # 首次部署初始化脚本
├── docs/                         # API 文档、设计文档
├── USER_MANUAL.md                # 用户操作手册（飞书风格）
└── CLAUDE.md                     # AI 辅助开发说明
```

## 架构概览

```
┌──────────────────────────────┐     ┌─────────────────────┐
│     Chrome Extension (MV3)   │     │    Backend Server   │
│                              │     │    (Hono + SQLite)  │
│  ┌──────────────────────┐    │     │                     │
│  │   Popup (React 19)   │    │     │  Auth (JWT)         │
│  │   Zustand Store      │    │     │  Store Bindings     │
│  │   GraphQL API Client │    │◄───►│  Analytics          │
│  └──────────┬───────────┘    │     │  Admin Management   │
│             │                │     │  Invite Codes       │
│  ┌──────────▼───────────┐    │     │  Trial Enforcement  │
│  │  Service Worker      │    │     └─────────────────────┘
│  │  Alarms + Messaging  │    │
│  └──────────┬───────────┘    │
│             │                │
│  ┌──────────▼───────────┐    │
│  │  Content Script      │    │
│  │  Floating Panel UI   │    │
│  └──────────────────────┘    │
└──────────┬───────────────────┘
           │ CSP bypass via scripting.executeScript
           ▼
┌──────────────────────┐
│  Shopee Seller API   │
│  (shopee.tw)         │
└──────────────────────┘
```

- **Popup** — 用户交互界面，启动操作、管理配置
- **Service Worker** — 后台执行：定时任务、自动模式循环、API 调用、进度广播
- **Content Script** — 在 `seller.shopee.tw` 注入悬浮进度面板，显示实时状态
- **Backend** — 用户认证（JWT）、店铺绑定、试用限制、使用统计（管理界面为独立网站 `admin-web/`）
- **安全** — 每次关键操作前通过后端 `/validate` 验证，防止篡改前端绕过限制

## API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/auth/register` | 公开 | 注册（需要邀请码） |
| POST | `/api/auth/verify` | 公开 | 验证码激活 |
| POST | `/api/auth/login` | 公开 | 登录获取 JWT |
| POST | `/api/auth/check-admin` | JWT | 检查管理员权限 |
| POST | `/api/auth/check-auto-mode` | JWT | 检查自动模式权限 |
| GET | `/api/stores` | JWT | 用户店铺绑定列表 |
| POST | `/api/stores/bind` | JWT | 绑定店铺 |
| POST | `/api/stores/validate` | JWT | 操作前验证（防破解） |
| POST | `/api/stores/consume-trial` | JWT | 消耗试用次数 |
| DELETE | `/api/stores/:id` | JWT | 解绑店铺 |
| POST | `/api/analytics/events` | JWT | 上报使用事件 |
| GET | `/api/analytics/summary` | JWT | 个人使用统计 |
| GET | `/api/admin/users` | 管理员 | 用户列表 |
| PATCH | `/api/admin/users/:id/store-limit` | 管理员 | 调整绑定限额 |
| PATCH | `/api/admin/users/:id/auto-mode` | 管理员 | 切换自动模式权限 |
| PATCH | `/api/admin/users/:id/trial` | 管理员 | 试用状态管理 |
| PATCH | `/api/admin/users/:id/trial-enabled` | 管理员 | 永久关闭试用 |
| DELETE | `/api/admin/users/:id` | 管理员 | 删除用户 |
| GET | `/api/admin/invite-codes` | 管理员 | 邀请码列表 |
| POST | `/api/admin/invite-codes` | 管理员 | 生成邀请码 |
| DELETE | `/api/admin/invite-codes/:id` | 管理员 | 删除邀请码 |
| GET | `/api/health` | 公开 | 健康检查 |

## 扩展权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 登录状态与本地配置 |
| `cookies` | Shopee 卖家中心认证信息 |
| `scripting` | 调用 Shopee API（绕过 CSP） |
| `alarms` | 定时任务调度 |
| `unlimitedStorage` | 模板数据存储 |
| 访问 `*.shopee.tw` | SP 认证 Cookie + 卖家中心 API |

## 构建生产版本

```bash
# 构建
npm run build

# 打包为 zip（可分发）
npm run zip
```

构建产物在 `.output/chrome-mv3/`，zip 文件在项目根目录。

在 Chrome 中加载：`chrome://extensions/` → 开启「开发者模式」→ 「加载已解压的扩展」→ 选择 `.output/chrome-mv3/` 目录。

## 许可证

ISC

---

> **声明：** 本插件仅供 Shopee 台湾站卖家辅助运营使用。请遵守虾皮平台相关规则，合理使用自动化工具。因违反平台规则导致的店铺处罚，开发者不承担相关责任。
