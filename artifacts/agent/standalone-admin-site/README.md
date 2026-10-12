# 独立管理网站 — 验收证据（脱敏）

**变更**：`openspec/changes/archive/2026-10-12-standalone-admin-site/`（已归档；正式规范见 `openspec/specs/standalone-admin/spec.md`）
**日期**：2026-10-12
**环境**：本地隔离后端 + 隔离 SQLite 库，未连生产、未访问虾皮

---

## 1. 怎么复跑

### 方式 A：用现成脚本启动隔离后端（推荐）

```powershell
# 在仓库根目录执行；首次会提示安装依赖（backend 已装好则直接启动）
powershell -ExecutionPolicy Bypass -File artifacts/agent/standalone-admin-site/start-iso-backend.ps1
```

脚本做的事：把 `PORT=5725`、`DB_PATH` 指向 `.agent-tmp\standalone-admin-site\data\sale.db`、设置隔离用 `JWT_SECRET`，然后启动后端。启动前会检查 5725 是否被占用。

启动后浏览器访问 **http://localhost:5725/admin/**。

> **注意**：脚本是 UTF-8 **带 BOM** 保存的。用记事本或编辑器改它时若存成「UTF-8 无 BOM」，PowerShell 5.1 会把中文读乱导致语法报错。

### 方式 B：手动启动

```powershell
# 1) 建一个空的隔离库目录
#    .agent-tmp/standalone-admin-site/data/sale.db
# 2) 用隔离配置启动后端（5725 避开常规 5724）
cd backend
$env:PORT='5725'
$env:JWT_SECRET='<任意随机串>'
$env:DB_PATH='<仓库>\.agent-tmp\standalone-admin-site\data\sale.db'
npx tsx src/index.ts

# 3) 另开终端跑验收脚本
cd .agent-tmp\standalone-admin-site
#    与 backend 同样的三个环境变量
npx --prefix <仓库>\backend tsx verify-admin-api.ts
```

**注意**：验收脚本会写入测试数据，必须在**空库**上跑；重复跑会因唯一约束冲突报错（预期行为）。

### 浏览器手测用的测试账号

用 `seed-fixture.ts` 在空库上灌入：

```powershell
cd .agent-tmp\standalone-admin-site
# 与后端相同的 DB_PATH
npx --prefix <仓库>\backend tsx seed-fixture.ts
```

灌入后可用：

| 账号 | 密码 | 用途 |
| --- | --- | --- |
| `admin@test.local` | `AdminPass123!` | 管理员，用于登录手测 |
| `demo@test.local` | `DemoPass123!` | 普通用户，用于验证「非管理员被拒」 |
| `pending@test.local` | `PendingPass123!` | 未激活账号 |

同时会灌入 2 条店铺绑定、3 个邀请码、若干统计事件。**全部是虚构测试数据，只存在于隔离库。**

---

## 2. 验收结果：35 项，全部通过（原 33 项 + 脱敏与继承成员名回归）

### 认证与权限（10 项）

| 场景 | 结果 |
| --- | --- |
| 管理员登录返回 token | PASS |
| 未激活账号登录被拒 | PASS |
| 密码错误被拒 | PASS |
| 无 token 访问管理接口 → 401 | PASS |
| 普通用户 token → 403 | PASS |
| **普通用户伪造 `role=admin` 的 token → 403** | PASS（服务端按 userId 查库，不看 token 里的 role） |
| 未激活账号 token → 403 | PASS |
| **已删除账号旧 token → 403** | PASS |
| **撤权后的旧 admin token → 403** | PASS |
| 无效 token → 401 | PASS |

### 用户管理（7 项）

用户列表含 `maxStores` 与 `bindingCount`、不含已删除账号、限额调整回读一致、非法限额 400、自动权限开关生效、试用标记/重置生效、试用限制开关生效且非法值 400 — 全部 PASS。

### 绑定管理（3 项）

| 场景 | 结果 |
| --- | --- |
| 绑定列表不返回 SPC_CDS | PASS（响应正文既无凭据值也无 `spcCds` 字段） |
| 按 userId 查询可看到已解绑记录 | PASS（解绑后默认列表移除、按 userId 可查且 `isActive=0`） |
| 缺 shopId 的记录仍可辨识 | PASS |

### 邀请码（5 项）

生成上限截断为 20、列表含使用状态字段、删除未使用码成功、**删除已使用码被服务端拒绝 400**、删除不存在 404 — 全部 PASS。

### 统计（4 项）

真实计数（用户数/绑定数/事件分类）、**事件明细上限 100 条**且按类型过滤、**事件明细按类型白名单脱敏**（含虚构 `token`/`spcCds`/`Cookie` 与未知嵌套字段的事件，响应正文不含任何虚构值，白名单字段完整保留，未知类型返回 `null`）、**继承成员名事件不使接口报错**（`constructor`/`__proto__`/`toString`/`hasOwnProperty`/`valueOf` 逐个返回 200 且 `eventData=null`，不带类型过滤的整页查询仍返回 200） — 全部 PASS。

### 删除级联与自删保护（3 项）

**管理员不能删除自身**（`userId` 校验生效，账号仍在）、删除用户级联清理绑定与事件、删除不存在用户 404 — 全部 PASS。

### 时间戳真实性（3 项，本轮发现的缺陷）

| 场景 | 结果 |
| --- | --- |
| 邀请码 `created_at` 是真实时间而非字面量 | PASS |
| 事件与绑定的 `created_at` 是真实时间（走真实插入路径） | PASS |
| 注册路径的用户与验证码 `created_at` 是真实时间 | PASS |

### 健康检查（1 项）

`/api/health` 正常 — PASS。

---

## 3. 浏览器实测（实际点击，非仅构建）

入口：`http://localhost:5725/admin/`

| 项 | 结果 |
| --- | --- |
| 登录 → 四菜单 → 退出 | 通过，列表渲染真实数据 |
| 自动模式开关 | 通过，提示「用户 demo@test.local 的自动模式权限已关闭」，开关状态同步变化 |
| 自删保护 | 通过，提示「不能删除自己的账号」，账号仍在 |
| 绑定脱敏 | 通过，页面与网络响应均无 SPC_CDS；缺 shopId 显示「店铺信息待补全」 |
| 统计与类型过滤 | 通过，计数 3 类真实事件；按「复制活动」过滤后精确剩 2 条 |
| 事件明细脱敏 | 通过，页面文本与 HTML 均无虚构凭据值；白名单字段正常显示，未知类型显示「无可展示明细」 |
| 继承成员名事件 | 通过，`constructor`/`__proto__`/`toString` 等原样显示为事件名，页面不崩、整页可读 |
| 统计失败与真实零值 | 通过，首次失败显示「无法读取」且不显示 0；真实空数据仍显示「暂无事件记录」 |
| 刷新即退出登录 | 通过，刷新后回到登录页 |
| 普通用户登录 | 通过，提示「该账号不是管理员，无法访问管理后台」 |
| 历史脏值兼容 | 通过，`CURRENT_TIMESTAMP` 在用户/绑定/邀请码三页均显示为「时间待补全」 |
| 浏览器存储 | **0 项 localStorage / sessionStorage / Cookie** |
| 控制台 | **0 错误 0 警告** |

### 主机托管

| 路径 | 结果 |
| --- | --- |
| `/admin` | 302 → `/admin/` |
| `/admin/` | 200，`text/html`，引用 `/admin/assets/*` |
| `/admin/assets/*.js` | 200，`text/javascript` |
| `/admin/nope` | 404 |
| `/api/auth/login`（既有接口） | 401（未受影响） |
| `/api/health` | 200 |

---

## 4. 构建与回归

| 检查 | 结果 |
| --- | --- |
| `admin-web` 类型检查 | 通过 |
| `admin-web` 构建 | 通过（约 1.09 MB JS / 345 KB gzip） |
| `backend` 类型检查 | 通过 |
| 扩展构建 | 通过（776 KB） |
| **扩展包内是否含 Ant Design / ProComponents** | **无**（全文检索确认） |
| 根目录单元测试 | **2 项失败，属既有问题**（见下） |

### 关于 2 项失败的单元测试

失败项位于 `tests/unit/utils.test.ts`（一日备货 SKU 的折扣记录提取），依赖 `entrypoints/popup/one-day-sku.ts` —— **本轮未修改该文件**。

已用 `git stash` 在**干净基线**上复跑，失败项与失败计数**完全相同**（2 failed | 15 passed），确认为**既有问题**，与本次变更无关，未在本轮修复。

---

## 5. 本轮发现并修复的真实缺陷

**`backend/src/db/schema.ts` 时间戳默认值渲染错误**（改动前已存在，已用 `git show HEAD:` 确认基线一致）。

**根因**：Drizzle 的 `.default('CURRENT_TIMESTAMP')` 把字符串当**字面量**写入 SQL，该列永远存字符串 `"CURRENT_TIMESTAMP"`。

**实测影响**（本地开发库）：`invite_codes` 4/4、`analytics_events` 85/85、`store_bindings` 18/18、`verification_codes` 3/3、`users` 3/4 全部为字面量。

**修法**：6 处改为 `.default(sql\`(datetime('now'))\`)`。

**已验证**：新建库上 33 项含专项时间戳断言全部通过。

**遗留**：历史数据中的字面量未回填（属数据修改，需用户授权）；前端已将其显示为「时间待补全」。

---

## 6. 未做（不要当成已完成）

1. 第 6 阶段（移除旧面板）未执行 —— 需用户确认验收。
2. 历史时间戳未回填。
3. 未提交、未推送。
4. 未部署、未配域名、未开 HTTPS。

---

## 7. 本目录文件

| 文件 | 用途 |
| --- | --- |
| `verify-admin-api.ts` | **35 项**隔离接口验收脚本（与 `.agent-tmp` 中运行版本一致） |
| `seed-fixture.ts` | 浏览器手测用的隔离测试数据种子（账号、绑定、邀请码、事件） |
| `start-iso-backend.ps1` | 一键启动本地隔离后端（5725 端口 + 隔离 DB）。**UTF-8 带 BOM**，改动时别丢 BOM |
| `browser-regression.ts` | **7 项**浏览器回归（脱敏、统计失败与真实零值区分、继承成员名不崩页），需已灌入 `seed-fixture.ts` + `seed-redaction-cases.ts` |
| `seed-redaction-cases.ts` | 复核用一次性种子：灌入含虚构凭据的事件（运行版在 `.agent-tmp`） |
| `repro-inherited-names.mjs` | 继承成员名缺陷的最小复现脚本 |
| `regression/*.png` | 本轮返工的脱敏截图证据 |

**注意**：这三份脚本都依赖 `backend/node_modules`。它们在 `.agent-tmp/standalone-admin-site/` 下运行时，该目录内有一个指向 `backend/node_modules` 的目录联接（junction），供脚本解析依赖；`start-iso-backend.ps1` 直接切到 `backend/` 运行，不需要该联接。
