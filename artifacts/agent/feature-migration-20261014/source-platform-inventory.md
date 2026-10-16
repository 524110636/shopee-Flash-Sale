# 源平台功能覆盖审计（只读）

日期：2026-10-14。调查源：`D:\shopee_xm\虾皮插件-客户` 根目录源码；目标：`D:\shopee_xm\虾皮限时特卖-更新迭代`。只读静态源码追踪；没有打开浏览器、启动服务、访问网络、构建或测试，也没有读取 `.env`、数据库内容、账号或凭据。`CLAUDE.md` 中出现的示例管理员凭据未引用或复述。

## 结论先行

源代码是一个 Chrome MV3 扩展，产品面由 popup 主入口、dashboard 广告控制台、shipping 物流控制台、topup 预算控制台、Shopee 页面 content 浮动利润计算器组成；background/service worker 既路由扩展消息，也直接调用 Shopee 接口。另有 Express + Prisma + SQLite 授权后台与 Vue 管理站。`CLAUDE.md` 把源描述为九站点产品，但当前 popup 仅露出台湾站，启动时还会把站点写回 `tw`；`site-config.js` 仍保留九站点配置且 background 限定 `saveSiteConfig` 只接受 `tw`。因此九站点是残留底层配置/权限，不能当作当前可切换功能。

源说明“Local mode”是当前扩展已被改成完全跳过服务端授权，但当前根 `background/main.js` 同时留有真实登录、注册、token、设备和店铺绑定的可调用流程：当缓存里存在真实授权与 token，走服务端登录态；当没有真实 token 时 `isLocalMode()` 为真，认证读取会回退为仅内存合成的本地授权信息。需要将它理解为**本地默认可用 + 后端接通遗留/可触发分支并存**，不能将后台绑定和授权限制视为本地模式生效的可靠保护。

目标项目不是源产品的直接副本：目标是面向虾皮台湾站的限时特卖、SKU/物流操作和用户管理工具。目标扩展现有功能首页、特卖助手、后台修复/改天数链路、模板与浮动进度；目标没有源广告投放/批量广告管理、利润计算器、预算水位线/广告预算自动补量、多站点配置 UI。目标管理端是自有管理站，不等同源 license 后台。以目标 `PROJECT_STATUS.md` 已验收和明确列出的能力为映射依据，迁移审计不代表这些功能获准开发。

## 全模块入口覆盖清单

| 源用户入口/模块 | 页面实际功能面 | 消息/处理脉络 | 本轮覆盖/判断 |
|---|---|---|---|
| Popup `popup.html` | 登录/注册、本地主视图；店铺管理/运营工具分类；特卖开关与状态、商品改天数、广告控制台、预算水位线、利润计算器入口；店铺绑定条、通知弹层、浮动计算器开关 | `popup.js` → `chrome.runtime.sendMessage` → `background/main.js` action/type switch；子窗口用 `createWindowSafely` 打开 | 已追踪主要入口、登录/绑定、站点、窗口与计算器；HTML 有控件不等于所有服务保护会启用 |
| Dashboard `dashboard.html` | 12 个 tab：全店广告、CPC 监控、批量删广告、批量操作、指定商品广告、ROI 编辑、快速加速、重开广告、过滤广告、健康检查、标题修改、限时特卖模式 | `dashboard.js` 发送广告/商品/标题/特卖 mode 消息，background 直接调 Shopee API；失败显示日志/进度 | 页面入口完整盘点；重点查看导出和状态存储。产品逻辑太大，其他子代理若已覆盖特卖/广告操作路径，本报告不重复替代其业务逐接口清单 |
| Shipping `shipping-console.html` | 4 tab：批量改发货天数、SKU 改天数、库存/现货预售查询、全店隔日达+赠品恢复；还含自动定时任务与商品/物流渠道弹窗 | `shipping-console.js` → `START_UPDATE`、`skuShippingUpdate`、`stockQuery`、`SET/GET_AUTO_SETTINGS`、`FETCH_LOGISTICS_*`、`UPDATE_*` 等 → background 的 shipping/sku/automation handler → Shopee | 四个 tab 和主要 action 均已盘点；目标已有修复/物流/自动模式，但业务定义不同，不能直接等价移植 |
| Topup `topup.html` | 规则列表、商品选择、预算水位线开/停、定时窗口、次日恢复与 ROI 恢复、监控面板/商品操作 | `topup.js` → `START/STOP_BUDGET_TOPUP_RULES_LOOP`、`REQ_TOPUP_PANEL_DATA`、`QUERY_AD_ITEMS`、商品开关/重开等 → background TopupManager/alarms → Shopee 广告 API | 已盘入口与消息主干；目标没有同类广告预算水位线后台，目前无对应 UI/API |
| Shopee 页面浮窗 `content.js` | 店铺页的可拖动浮动利润按钮/计算器面板，显示成本、利润率、ROI；本地记面板位置、输入与显示状态 | `manifest.content_scripts` 注入 content.js；`chrome.storage.sync` 控制 `floatingEnabled`，结果由 content 内公式即时计算；background 另有 `CALCULATOR_*` 消息用于 popup 计算器 | 已追踪实现和是否真正启用；目标没有利润 calculator 内容脚本入口 |
| `site-config.js` | 九站点 domain/API、货币/时区/地区基础配置（非当前 popup 可切换入口） | `getSiteConfig` / `saveSiteConfig` → background storage selectedSite；实际保存分支接受 `tw` | 只配置层；当前入口收缩台湾站 |
| Popup 子视图 | 特卖、计算器由 popup 内视图切换；广告/物流/预算控制台打开扩展独立小窗 | `navigateTo` 或 `chrome.windows.create`；失败回退 `chrome.tabs.create` | 窗口行为与视图路径已核实 |
| 后端/管理员站 | 用户/授权密钥/店铺/系统设置/通知/登录日志/管理员操作日志 | Vue `admin/src/views` → API client → `/api/admin/*` 与其他 `/api`；Express routers → services/Prisma/SQLite | 真实端点按路由盘点于下节；与目标 Hono 后端及目标 admin-web 是不同实现 |

入口交叉检查：根 popup 五张卡均已对照 HTML/action；Dashboard 导航的每个 `data-bs-target` 都有 pane；Shipping 四个导航项各有 pane；Topup 主体和 modal 控件已对照消息调用。源根目录 `manifest.json` 才是审计主源；`发布包/扩展文件`、`shopee-plugin(1)` 是副本，本轮没有拿副本覆盖根源码。未覆盖源码以外的部署现况、商店实际上架状态、服务器数据和真正用户登录行为；这类结论不能从静态文件推出。

## 重点链路和边界

### 1. Popup、登录、真实后台店铺绑定与本地模式

- UI：`popup.html:30-83` 有登录/注册表单；`popup.html:108-199` 主导航、固定 TW 站与五个功能卡；`popup.html:400-410` 当前店铺绑定条；`popup.html:210-246` 通知弹层；`popup.html:265-312` 特卖详情/日志。
- 本地显示：`popup.js:395-452` 请求 `getAuthInfo` 后更新授权状态；`popup.js:428` 本地 fallback 对 `isAuthorized` 设为 true。`popup.js:727-728` 查询公开注册设置；登录提交在 `popup.js:760-850`，注册在 `popup.js:890-925`。内容表单有效不代表服务端可达。
- 真实 API handler：`background/main.js:3049` API base 指向 `http://127.0.0.1:3000/api`。注册 `registerUser()` (`3219+`) POST `/auth/register`，字段 `{email: account, password, licenseKey: key}`；成功后会尝试 POST `/devices/bind`（deviceId/fingerprint），写入 `authInfo`，拉 `/notifications/active`。登录 `loginUser()` (`3292+`) POST `/auth/login`，字段 `{email,password}`，成功同样尝试绑定设备、持久化真实 token 并拉通知；网络或后端错误会返回失败（设备绑定/通知错误则非致命）。
- 本地回退：`isLocalMode()` (`3766+`) 以缓存中是否同时存在 `isAuthorized` 与 token 判定；没有时为本地模式。`getLocalModeAuthInfo()` / `getLicenseInfo()` (`3770+`) 合成本地授权对象（token=null、权限默认值）且注释声明仅内存、不存入 storage。真实 `getAuthInfo` 可用时优先保留真实用户数据；因此不是“任何情况下都绝不调用服务端”。后台 login/register/bind/getShops/getShopAccount 路由确实存在，见 `background/main.js:18024-18104`。
- 店铺绑定：`popup.js:492-520` 检测卖家页店铺并加载绑定列表；`popup.js:598-604`/`1746-1774` 按钮提交 `bindShop`（shopAccount、site、shopName）。`background/main.js:3914+` POST `/shops/bind`，带 Bearer token，字段 `shopAccount/site/shopName`；`3972+` GET `/shops`；`3950+` DELETE `/shops/:id`。失败时返回失败对象；popup 以绑定上限/当前店铺未绑定显示拦截。
- 实际门控：源 CLAUDE 称绑定 UI 在 maxShops>0 时挡功能；本地默认 maxShops=0 不开门控。未登录本地回退仍可显示假 `isAuthorized`。所以店铺绑定 UI/后端 CRUD 是隐藏接通的旧 SaaS 路径，local mode 下绑定数量限制不是产品保护边界。
- 注册 UI/后台端真实存在，但 `Local mode` 注释 `CLAUDE.md:407-411` 把整体设计标为旁路授权；本地模式是否完全隐藏表单需看页面运行状态，源码对登录/注册仍保留，不应一概说“无登录功能”。

### 2. 多站点

- `manifest.json:1-100`（重点 host_permissions/content matches）列 TW、MY、TH、ID、VN、SG、PH、BR、MX，并有通用 http/https 权限；`site-config.js:8-100` 为九组域名和 API 基地址；`site-config.js:103-163` 暴露 storage key、读取/保存 helper。
- 当前 popup `popup.html:112-117` 实际为固定 TW 标签，没有选择菜单；`popup.js:48-53` 启动即 `saveSiteConfig('tw')`；`popup.js:68-112` 留有通用的选择函数，但页面没有站点选项可触发。后台 `saveSiteConfig` 路由约 `18403-18420` 将输入限制为 `['tw']`。结论：其他八站点配置、manifest 域名权限、各处 domain 选择代码为潜在/遗留，不构成当前可用站点切换。
- `site-config.js:1-6` 文件最前有键盘快捷键、右键、debugger 阻断代码，与 CLAUDE 某段“禁用反调试”的泛称不一致；popup/dashboard/topup/shipping 中相应片段多数是注释。站点脚本是否被页面加载应看各 HTML script 顺序/manifest 注入；不得复制这些反调试/许可绕过内容到目标。

### 3. 利润计算器与浮动面板

- popup 卡片 `popup.html:196-208`，视图 `popup.js:984-986` 切换到 calculator view；浮动开关控件 `popup.js:1463-1485` 读写 `chrome.storage.sync.floatingEnabled`，发送 `updateFloatingMode`。浮动面板仅随 content.js 注入 Shopee 页面，`content.js:14+` 按钮、`187+` 面板、`353-410` 计算公式、`439-459` 根据 floatingEnabled 决定是否显示；面板位置存 sync storage。数据只在浏览器本地交互，无后台业务写入，但公式输出会用于商业决策。
- `background/main.js:9952-10075` Calculator handler；`calculateProfit` 计算平台费率、服务费、进货/运费/标签等成本、利润、利润率、ROI，结果异常回零并返回失败；`18275-18287` 路由 `CALCULATOR_TOGGLE/CALCULATE/SETTINGS`。不代表源外部许可 API 提供该计算器。
- 目标仓库当前 `entrypoints/content.ts` 与 popup feature card（`entrypoints/popup`）没有利润计算器及可拖动浮窗计算器；目标已有的“悬浮进度”属于特卖/任务进度反馈，不可视为利润浮窗的映射。

### 4. 导入导出、窗口、打包

- 源 UI 未见 popup/topup/shipping 的配置 JSON 导入导出入口；Topup 规则自身以 `chrome.storage.local` 快照自动保存/恢复（`topup.js:812-838`），应视为本机持久化，不是可迁移文件导出。
- Dashboard 存在业务结果 Excel 导出：商品/广告筛选结果等 HTML 按钮（`dashboard.html:770-797,1907-1913`），`dashboard.js` 有 XLSX export；这是报表导出，不是设置导入/恢复。由于没有文件 input/import handler，未发现配置导入 UI。
- Popup 的 `createWindowSafely` `popup.js:1527+` 优先 `chrome.windows.create`，异常时用 `chrome.tabs.create`；入口 `1571-1614` 打开 dashboard.html/topup.html/shipping-console.html 独立窗口。独立 popup view 不同于 Chrome popup 窗口尺寸。
- 根 `manifest.json` 的 service worker=`background/main.js`，popup=`popup.html`，content 注入 `content.js`；`build-extension.cjs:1+`（打包逻辑）、`CLAUDE.md:20-35` 指出 obfuscator+archiver 输出 `dist-extension/`。该构建没有执行，也不把 `发布包`/插件副本认作主源或当前安装包证据。

## Express / Prisma 后端与 Vue 管理站功能/API

`server/src/index.js:40-51` 挂载路由。`server/src/routes` 具体 endpoint：

| 页面/能力 | 后端 path method | 关键字段/状态/影响 |
|---|---|---|
| 扩展注册、登录、改密、身份、心跳 | `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/change-password`、`GET /api/auth/me`、`POST /api/auth/heartbeat` (`auth.js:53,114,167,198,211`) | 注册 `email/password/licenseKey`；登录返回 token/user/license；改密 old/new password；心跳更新设备活跃/授权有效性并回传通知。登录/注册/改密写用户、设备或密码/日志；错误含禁用、密钥无效/过期/设备限制等业务失败。仅登录/注册是扩展主 UI 明确入口。 |
| 设备 | `GET /api/devices`、`POST /api/devices/bind`、`POST /api/devices/unbind` (`devices.js:9,22,41`) | deviceId/fingerprint；注册/登录后 bind；变更设备绑定状态。 |
| 用户店铺 | `GET /api/shops`、`POST /api/shops/bind`、`DELETE /api/shops/:id` (`shops.js:9,22,41`) | shopAccount/site/shopName；受 license maxShops 约束；新增或删除店铺绑定记录。 |
| 管理用户 | `GET /api/admin/users/next-account`、`GET /api/admin/users/:id/profile`、`GET /api/admin/users`、`POST /api/admin/users`、`PUT /api/admin/users/:id`、`DELETE /api/admin/users/:id` (`admin.js:15-266`) | 账号、角色、停用状态及 license limits/duration/permissions；创建/编辑/删除用户及关联 license。 |
| 授权密钥 | `GET /api/admin/licenses`、`POST /api/admin/licenses/generate`、`PUT /api/admin/licenses/:id` (`admin.js:291-360`) | 密钥、到期/强制过期、设备店铺额度、功能权限；写 license 状态与权限。 |
| 后台店铺管理 | `GET /api/admin/shops`、`DELETE /api/admin/shops/:id` (`admin.js:362-415`) | 店铺列表/删除绑定。 |
| 仪表盘 | `GET /api/admin/stats` (`admin.js:417+`) | 总用户/授权、活跃设备、店铺、即将过期等统计；只读统计。 |
| 通知 | `GET /api/notifications/active`、`POST /api/notifications/:id/dismiss`；管理员 GET/POST `/api/admin/notifications`、PUT/DELETE `/api/admin/notifications/:id` (`notifications.js`; `admin.js:508-635`) | title/content/type/minVersion/downloadUrl/目标用户；admin CRUD 写公告，dismiss 更新用户阅读状态，扩展拉取通知。 |
| 系统设置 | `GET/PUT /api/admin/settings`、`GET /api/settings/public/registration` (`settings.js:14,32,59`) | key/value，当前主要 registrationEnabled；后台写设置，公开端只查注册开关。 |
| 登录与管理员操作日志 | `GET /api/admin/login-logs`、`GET .../stats`；`GET /api/admin/admin-logs`、`GET .../stats`（各 routes） | 分页/筛选、登录事件及管理员 before/after 变更审计；读查询。 |

Vue 页面由 `admin/src/views` 中 Login、Dashboard、Users、Licenses、Shops、Notifications、FeatureToggles、LoginLogs 覆盖，Axios `admin/src/api/index.js` 加 Bearer token、401 回登录。admin CRUD 与扩展 Local mode 是两条不同执行面：后台功能代码存在不能证明源扩展正在依赖它，server/API 源码存在也不能证明 API 服务器正在运行。

## 目标项目映射与未覆盖项

- 目标入口是 MV3 + WXT 的 React popup/background/content（目标 `AGENTS.md`、`docs/手册/02-架构总览.md`、`03-代码地图.md`）；不同于源的 popup/dashboard/shipping/topup 四套独立 HTML 页面。
- 可对应但业务不等价：源特卖模式/商品改天数与目标特卖助手/SKU 修复/物流编辑；源 popup 的状态卡与目标 feature home；源店铺/license 后台与目标独立管理员站的通知/用户体验功能只有部分表层同类，数据/API 不兼容。
- 目标当前已确认：特卖扩展弹窗、首页导航、一键修复后台执行与规格保留；完整真实开卖尚未用户验收；复制特卖/定时加入/自动模式/模板存在但真实业务未逐项确认；管理端在本地已验证可用、生产未部署（目标 `PROJECT_STATUS.md` 当前状态/核心功能表）。
- 未映射到目标的源能力：广告投放全家桶（ROI/关键词/CPC/批删/快速加速/健康检查/标题）、利润计算器浮窗、预算水位线及广告重开、全店隔日达与 source-specific 各站功能。这些不应因本次审计自动进入目标“开发中”。
- 本轮要求的所有主要源 HTML 入口、三个子窗口导航、站点/账号/浮窗、server route 和 admin views 已交叉盘点。尚未逐项还原 dashboard 每个业务按钮的所有 payload/失败/实际写入影响（其规模独立于本任务覆盖审计）；如迁移到目标，应由主规划方另开明确的小范围逐功能审计，不要把这里的总览当成完整广告实施规格。

## 源代码证据索引

- 主 manifest 与版本：`manifest.json:1-110`。
- 源 Local mode 文档：`CLAUDE.md:407-411`（该描述与现码并存，须以前述调用条件解释）。
- Popup HTML：`popup.html:30-83,108-199,210-246,265-312,400-426`；site 固定 TW `112-117`。
- popup site helper/启动固定 TW：`popup.js:25-112`；认证/绑定/login `395-850,890-925,1633-1774`；window open `1527-1614`。
- 九站点 config 与当前可保存限制：`site-config.js:8-163`；background action `18403-18420`。
- 本地/后端授权、API handlers：`background/main.js:3049,3219-3360,3766-3800,3914-4002,18024-18104`。
- 利润计算器：`popup.js:1463-1485`；`content.js:14-459`；`background/main.js:9952-10075,18275-18287`。
- Dashboard 导航：`dashboard.html:43-100`；Shipping 导航：`shipping-console.html:46-62`；Topup action 参考 `topup.js:947-963`。
- 服务器 routers：`server/src/index.js:40-51`；routes 行号见上一节。
- Source Vue 管理页：`admin/src/views/{Login,Dashboard,Users,Licenses,Shops,Notifications,FeatureToggles,LoginLogs}.vue`，接口包装 `admin/src/api/index.js`。
- 目标映射事实：`PROJECT_STATUS.md` 当前状态/核心功能表；`AGENTS.md` 技术映射；`entrypoints/popup/App.tsx` popup cards，`entrypoints/content.ts` 内容脚本；目标后端为 `backend/`，管理站 `admin-web/`。
