# 源项目广告控制台、标题与预算功能调查

调查范围：只读核对源项目 `D:\shopee_xm\虾皮插件-客户` 根目录下的 `manifest.json`、`popup.js`、`dashboard.html/js`、`topup.html/js`、`background/main.js` 与 `CLAUDE.md`、`docs/shopee-integration-guide.md`。未启动服务/浏览器，未发业务请求，未构建或测试，未读凭据或真实账号数据。行号按本次读取的源文件。

## 总体调用结构

- 扩展入口由根 `manifest.json` 指向 `popup.html` 与 service worker `background/main.js`（版本 1.0.2）。popup 的预算控制台按钮打开 `topup.html`；popup/dashboard/topup 均通过 `chrome.runtime.sendMessage({type,...})` 调用后台。`popup.js:990,1591`、`dashboard.html:43-100`、`background/main.js:17772-17775,17949-17950`。
- 广告、商品标题的后台请求通过 `adApiClient`/`titleUpdater` 在后台执行；广告 API 依赖当前选中站点的 seller 域名、SPC_CDS，并注入到活跃卖家中心 tab 的页面上下文 fetch（`adApiClient.injectedPageFetchJSON` 等）。站点 base URL 由 `getApiBaseUrl` 基于站点配置拼接（`background/main.js:10085-10130`）。
- 根 `CLAUDE.md` 把 `dashboard.html/js` 描述为广告、关键词、商品操作、ROI、健康检查、标题与广告加速推广控制台；功能说明与 API 概览见 `docs/shopee-integration-guide.md:174-184,694-815`。该文档主要是摘要，不能代替源码契约；以下以源码为准。

## 用户可见功能与链路

### 全店开广告、指定商品开广告与 ROI

- 入口：dashboard 导航“全店开启广告”“指定商品开广告”“批量修改 ROI”（`dashboard.html:43-68,110-170,375-470`）。全店有手动ROI/系统ROI两个按钮、预算、延迟、排除商品ID及可选加速；指定商品可从商品选择器选择 ID，分别输入预算与手动ROI/系统ROI（同文件约 375-425；选择器映射见 `CLAUDE.md:50-61`）。
- 消息：`START_BATCH_PROCESS` / `START_BATCH_PROCESS_SYSTEM_ROI`；指定商品使用 `START_MANUAL_ROI_FOR_IDS` / `START_AUTO_ROI_FOR_IDS`；ROI 修改使用 `EDIT_ROI_ALL`、`EDIT_ROI_BY_ITEM_IDS` 或分批 `EDIT_ROI_BY_ITEM_IDS_BATCH`。页面发送处见 `dashboard.js:1757,1797,2009,2043`；后台分发与参数拆解见 `background/main.js:10853-10995,17949-17950`。实现按商品列表筛除已投放广告、按批次创建并报告成功/失败ID；指定商品直接调 `batchCreateAdsWithRetry` 且去重，失败明细另发 `OPERATION_COMPLETED`（`background/main.js:11100-11146,11148-11199,12583-12670`）。
- 真实写入：POST `/api/pas/v1/product/mass_create/?SPC_CDS=...&SPC_CDS_VER=2`；请求由 Shopee 页面上下文发出。全店/指定商品批量创建最多每批30个，内部重试。ROI 修改走 POST `/api/pas/v1/product/edit/`，`type:"change_roi_two_target"`，不是 homepage/mass_edit；`target=0` 切系统ROI，正数为手动目标值；mass_create 成功需检查顶层 code、result_list 及逐商品 campaign_id；ROI helper 的返回/重试见后文。
- 成功标准：后台消息应检查返回 `ok/successCount/failCount/failedIds`，不是单看 sendMessage 已发出；前端会显示逐项进度及失败 ID。停止/取消通过 `CANCEL_OPERATION`，下次操作重置取消标志。

### 搜索广告、关键词筛选、删除、暂停/恢复与健康检查

- dashboard 导航含“批量筛选广告”“广告健康检查”“批量删除广告”（`dashboard.html:53-93,312-370,608+`）。列表/筛选 UI 支持指标预览、仅指定ID/排除ID、按广告状态查询；健康检查按活动获取 trait 并用于识别异常/停止原因，源文档详述分批 40 个活动 ID（`docs/shopee-integration-guide.md:767-775`）。
- 广告列表查询为 POST `/api/pas/v1/homepage/query/`，核心 body 含 `start_time/end_time/sorting/filter_list/offset/limit`，默认 `campaign_type:new_cpc_homepage,state:ongoing`；响应从 `data.entry_list` 等候选字段取列表（`background/main.js:10612-10679`）。暂停/恢复/删除/改预算统一 POST `/api/pas/v1/homepage/mass_edit/`；删除/暂停/恢复的精确 `type` 和 body 由 `deleteCampaignsByIds*`、`massEditPauseResume` 方法生成（`background/main.js:11610-11683,13887-13929`; `docs/shopee-integration-guide.md:178-180`）。
- 删除用户动作包括全量带排除、按商品ID、按 campaign ID；消息 `DELETE_ALL_ADS`、`DELETE_ADS_BY_ITEM_IDS`、`DELETE_ADS_BY_CAMPAIGN_IDS`（页面 `dashboard.js:1954,2071,2100`; 后台 `background/main.js:11268-11311`）。全量流程默认只处理进行中的活动（页面提示 `dashboard.html:319`）。指标预览 `PREVIEW_DELETE_BY_METRICS` 可切换预览/下载，不本身等同删除（后台 `background/main.js:10584-10610`）。
- 健康检查有导航入口，但本次只读范围未取得其全部 UI 到 handler 的独立逐行链路和每个 trait 请求响应契约；需要将其视为源码待进一步逐项确认，不能仅抄文档当作已验证。广告“搜索”至少包括商品列表关键词搜索（标题模块下文），广告页按商品/指标筛选，是否另有 Shopee 搜索广告关键词投放入口：本次检查未确认，未发现应迁移的独立关键词广告投放 API。

### 广告加速推广

- dashboard 有手动 ROI 创建、批量 ROI 修改、ROI 重开中的可选“加速推广”，并有单独批量开/关入口（`dashboard.html:128-131,400-403,442-447,478-495`）。只对手动 ROI 有效，自动 ROI 不支持。
- 消息 `TOGGLE_RAPID_BOOST_BULK`，后台按 item ID 查询 campaign 再逐个切换（`dashboard.js:1677,1714`; `background/main.js:11200-11213,13673+`）。底层 POST `/api/pas/v1/product/edit/`，body `{reference_id,campaign_id,type:"rapid_boost_toggle_on"|"rapid_boost_toggle_off",header:{}}`；response 经注入 fetch 解析，操作有重试（`background/main.js:12923-12942`）。这是 Shopee 广告状态写入，不是商品置顶。

### 标题、推荐词与关键词提示/搜索

- 入口 dashboard“修改标题”页，商品选择器填商品ID、自动加载商品信息/关键词，支持改标题、删除广告后改标题、复制删除重新上架等动作（`dashboard.html:93-94`；`dashboard.js` 的 title updater 事件区）。
- 后台消息：`GET_PRODUCT_LIST`、`SEARCH_PRODUCTS`、`UPDATE_PRODUCT_TITLE`、`GET_RECOMMENDED_KEYWORDS`、`GET_KEYWORD_HINTS`、`SEARCH_KEYWORD`、`DELETE_AD_AND_UPDATE_TITLE`、`COPY_DELETE_RELIST_PRODUCT`（`background/main.js:17815-17900`）。商品列表 GET `/api/v3/opt/mpsku/list/v2/get_product_list`；关键字搜商品 GET `/api/v3/opt/mpsku/list/v2/search_product_list`，按 sort 可改 offset 参数（`background/main.js:14490-14538`）。标题保存 POST `/api/v3/product/update_product_info`，body `{product_id,product_info:{name:newTitle},is_draft:false}`；用站点 seller 域名并要求 active seller tab 与 SPC_CDS，需 HTTP 成功及业务 code 0（`background/main.js:14574-14615`）。
- 推荐关键词 POST `/api/pas/v1/setup_helper/list_recommended_keyword/`，body含 `campaign_type:"product",item_id,suggest_log_data`（`background/main.js:14668-`）；关键词提示 POST `/api/pas/v1/setup_helper/list_keyword_hint/`，body含 `keyword,campaign_type,item_id,suggest_log_data`，成功条件 HTTP OK 且 `data.code===0`（`background/main.js:15012-15067`）。`SEARCH_KEYWORD` 方法存在于 `background/main.js:15075` 后，但其完整请求 body/响应字段本次未逐行采集，需后续回源核验。
- 标题改动直接更改 Shopee 商品名；`DELETE_AD_AND_UPDATE_TITLE` 会先删广告再改标题；复制删除重新上架涉及复制商品、下架/删除原商品和创建新商品，是高影响复合写入。不能将页面显示“成功”当作全链路无损保证；需要核对每步返回与部分失败补偿。

### 预算水位、自动加预算、暂停/恢复与日重置

- popup 预算控制台入口 `popup.js:990,1591` 打开 `topup.html`；页面允许配置每商品规则（加额、水位/缺口范围、最高预算、默认预算、延迟、循环、状态过滤、时间窗、ROI提升/恢复、暂停/恢复时间等），也有监控列表和移除规则按钮（`topup.html:32-208,273-295`; `topup.js:947-963,1219+,1544-1546`）。规则不是一次性单独动作，而是启动持续轮询。
- 启停消息 `START_BUDGET_TOPUP_RULES_LOOP` / `STOP_BUDGET_TOPUP_RULES_LOOP`，请求面板 `REQ_TOPUP_PANEL_DATA`，删除监控规则 `REMOVE_MONITOR_ITEM`；路由到 `TopupManager.handleMessage`（`topup.js:947-963,1229,1544`; `background/main.js:1939-1954,17772-17775`）。
- 后台规则轮询约每分钟 alarm 执行，但单项按 `check_interval_min` 节流；预算加额用 Shopee 广告查询和 `massEditBudget`。写请求 POST `/api/pas/v1/homepage/mass_edit/` body `{campaign_id_list,type:"change_budget",change_budget:{daily_budget: TWD*100000,budget_log_key:UUID}}`。成功以接口无错误返回（`massEditBudget`没有本段展示显式业务 code 检查，实际需避免把 HTTP/JSON 返回当成功）；达水位后创建 `BUDGET_TOPUP_ITEM::<itemId>` 闹钟，执行前重查广告、最高预算/时间窗/封禁期/花费等条件（`background/main.js:1101,1249-1313,1644+,13904-13929`）。
- 23:30 站点本地日重置 alarm `RESET_DEFAULT_BUDGETS`：按每条规则的 `default_budget_twd` 找当前 campaign 并分预算分组批量改回；群组失败时逐条降级重试（`background/main.js:1301-1305,15656-15706`）。日重置还可能依规则执行暂停、恢复投放、ROI提高及定时恢复；alarm handler 中 `RESET_DEFAULT_BUDGETS` 分支调用 `handleDailyReset`（`background/main.js:15372-15374,1880-1903+`）。`topup.html` 展示 ROI 提高/恢复时间/恢复值的控件（约 141-173）。
- 状态：`topupLoopJobCache`、`topupLoopJob`、`topupPanelData` 存在 storage/local 状态与恢复路径；启动创建 `BUDGET_TOPUP_LOOP` 定期 alarm，停止会清循环与单项 alarm 并清 job/panel cache（`background/main.js:1501,2096-2136,15877-15905`）。Service Worker 初始化恢复缓存 job 并重建缺失轮询 alarm；Chrome alarms 在浏览器重启后不保证保留，因此源码显式重建。每日 reset alarm 与单项 alarm依赖任务运行时创建；逐一重建逻辑尚未整体验证。
- 真正影响：提高广告日预算会增加 Shopee 可消耗上限；ROI、暂停/恢复、删除同样改变线上广告投放。停止预算轮询只停止未来规则执行，不撤销已改预算或已投放广告。

## 域名、接口和可确认边界

- 广告接口（`adApiClient.getApiBaseUrl`）按 `selectedSite`/站点配置生成 seller 域名，不是固定台湾域；多个 API path 则是 Shopee seller API 路径。标题代码用 `SITE_DOMAINS[siteCode].seller` 拼域名，可随当前站点，但无站点时 fallback 到 `seller.shopee.tw`（`background/main.js:14577-14583,14671-14677,15015-15020`）。manifest 声明多个 seller 区域。
- 源 `CLAUDE.md` 的关键点：背景 monolith、TopupManager/adApiClient/titleUpdater，预算 cache/alarm 及 recovery、权限入口；与源代码大体一致。其“dashboard 有广告/关键词/ROI/健康检查/标题/boost”与页面一致，但对每个 action、payload、响应校验没有足够细节。
- `docs/shopee-integration-guide.md` 的 API表说明 mass_edit 可删除/暂停/恢复/预算修改，mass_create 创建广告，homepage/query 查广告；源码确认了这些 path。但暂停/恢复/删除请求 payload 的具体字段应以源方法逐项提取，不应据这张高层表重建。源码中未确认一个单独命名的“搜索广告”投放功能；检索到的 `SEARCH_KEYWORD` 属标题/广告创建辅助关键词，不可推断成独立关键词竞价系统。
- 未确认：所有 Shopee 接口在当前账号/站点上的可用性或实时响应、某些分支的完整业务字段/重试保证、健康检查所有状态判定、`SEARCH_KEYWORD`完整返回结构、23:30相关各类 alarm 在关闭浏览器/重启后的最终行为。本调查按请求限定未启动环境、未发业务请求。

## 迁移模块建议（只读源与目标核查）

建议以用户能力切分，避免迁移整份 1MB monolith：

1. `ad-campaigns`：店铺广告创建（全店/指定、自动/手动 ROI）、查询、暂停/恢复/删除、ROI修改、rapid boost；共享 site/session/API transport 与逐项结果模型。
2. `ad-insights`：广告指标筛选/预览、健康检查和关键词辅助。先厘清“关键词搜索”究竟是推荐/提示，还是单独投放功能。
3. `product-title`：商品搜索/选择、标题更新、删除广告后改标题；复制删除重上架应独立列为高影响工作流。
4. `budget-automation`：规则 UI/schema、持久化、poller、每商品 one-shot alarm、每日 reset、ROI/暂停恢复计划、任务恢复；单独设运行状态与结果审计。

目标项目目前是 1.15.2 Chrome MV3 + Node/Hono；本调查没有检索目标产品代码或手册来判定其已有何种广告/预算业务模块。仅据目标 `PROJECT_STATUS.md` 的现行任务是已结案的扩展首页/后台修复/弹窗，不能据此断言不存在相关能力。因此“目标是否已有”标记为**本子任务未核实**；主代理应在目标仓库按对应目录/消息 action 再核对，不把旧项目的后台模块名直接当作目标已有能力。

## 补充：dashboard 其余控制台逐项源码链

> 源码命名把 `rapid boost` 叫“加速推广”，本报告统一采用“广告加速推广”这一名称。
>
> `adApiClient.getApiBaseUrl(endpoint)` 返回 `https://${seller}/api${endpoint}`（`background/main.js:10088-10092`）。所以传入 `/pas/...` 的最终路径完整是 `/api/pas/...`，下文统一按最终完整路径写。`seller` 由当前站点选择，非台湾固定域；标题模块也按站点域名拼接，但有台湾 fallback。

### 11 个相关 dashboard 页面（排除限时特卖页）

| 页签 | 入口与行为 | 消息/后台 | 实际写入或结果 |
|---|---|---|---|
| 全店开广告 | `all-shop-ads`，预算、手动ROI/自动ROI、延迟、排除ID、可选加速推广；同时可查询无广告商品及暂停广告 | `START_BATCH_PROCESS` / `START_BATCH_PROCESS_SYSTEM_ROI`；查询按钮查商品或 paused campaign（`dashboard.js:1757,1797`） | 调 `/api/pas/v1/product/mass_create/` 创建商品广告；暂停广告查询走 `/api/pas/v1/homepage/query/`，结果可将暂停 campaign ID 批量删除 |
| CPC 监控 | 配置阈值、商品范围/排除、ROI种类、预算、手动ROI值、加速推广、立即/延迟重开；开始有确认框，停止可中止 | `START_CPC_MONITOR` / `STOP_CPC_MONITOR`，payload 含 `spcCds,cpcThreshold,budget,roiType,roiTarget,rapidBoost,targetIds,excludeIds,delayMinutes`（`dashboard.js:2179-2237`；后台 `background/main.js:11216-11259`） | 启动后先查询广告及报告数据，循环间隔 30 秒；超过阈值立即调用按商品ID删除，再立即新建或安排延迟重建（`background/main.js:14175-14320`）。删除实际通过 `/api/pas/v1/homepage/mass_edit/` `type:"delete"`；重建用 mass_create。监控配置是 service worker 内存字段与 `setTimeout`，没有找到持久化配置/Chrome alarm 恢复；Service Worker 被终止后不可据源码保证持续运行。延迟任务有保存状态，但计时调用 `setTimeout`，其跨 SW 重启恢复未确认。
| 批量删除广告 | 可按商品 ID 删除/排除删除；可查询并删除暂停广告（页内警示不可撤销） | `DELETE_ADS_BY_ITEM_IDS`、`DELETE_ALL_ADS`、`DELETE_ADS_BY_CAMPAIGN_IDS`（`dashboard.js:1921-1954,2071,2100`; handler `background/main.js:11268-11330`） | 仅 ongoing 活动（页面标注）。mass_edit 每批 50，payload `{campaign_id_list,type:"delete"}`；接受业务 `code===0` 或 `ok`，失败重试/汇总（`background/main.js:11662-11715`）。暂停广告流程先 query state paused 取 campaign IDs 后再删除。
| 商品批量操作 | 下拉包括删全部商品、删下架商品、上架下架（`dashboard.html:338-370`） | `DELETE_ALL_PRODUCTS` / `DELETE_DELISTED_PRODUCTS` / `LIST_UNLISTED_PRODUCTS` / `UNLIST_LIVE_PRODUCTS`；同一个产品消息 handler（`dashboard.js:1031-1055`; `background/main.js:11522-11555`） | 商品的上架/下架/删除是商品编辑 API 写入，和广告 campaign 删除不同。代码分别分页选商品及调用 relist/unlist/delete 方法；存在 showProgress、指定/排除 ID 支持。精确 API body需沿产品 helper 方法核对；本任务焦点报告只确认消息与方法，未把商品 API 字段冒充广告 API。
| 指定商品开广告 | 商品选择器输入 ID，手动ROI（预算、目标ROI、可选加速）或自动ROI（预算） | `START_MANUAL_ROI_FOR_IDS` / `START_AUTO_ROI_FOR_IDS`（`dashboard.js:2009,2043`; handler `background/main.js:10913-10962`） | 同 mass_create，指定 IDs 去重，最多每批30；自动 ROI target 为 0、rapid boost false。批次结果包括 success/fail IDs 并发 `OPERATION_COMPLETED`。
| 批量改 ROI | 全部进行中或指定 item ID；排除列表；target 0 系统ROI、正数手动 ROI；手动模式可加速 | `EDIT_ROI_ALL` / `EDIT_ROI_BY_ITEM_IDS(_BATCH)`（`background/main.js:10963-11011`） | 查询 ongoing 列表后逐活动编辑（通常每批10并发）；每活动调用 `/api/pas/v1/product/edit/` ROI编辑 payload，源码 helper `productEditChangeROI`。若正ROI且选加速，再另发 rapid boost 开启请求。逐活动收集 success/fail，不是原子批量事务。
| 加速推广控制 | 商品ID输入后批量开启/关闭；明确“仅手动ROI支持” | `TOGGLE_RAPID_BOOST_BULK`，payload `{spcCds,ids,enable}`（`dashboard.js:1677,1714`; handler `background/main.js:11200-11213`） | 每商品定位 campaign 并调用 `/api/pas/v1/product/edit/`，`type` 为 `rapid_boost_toggle_on/off`，更新广告加速推广 trait。
| 重开广告 | 手动/自动 ROI；排除或仅指定 IDs；先立即删除，按延时新建 | `REOPEN_MANUAL_ROI_ADS` / `REOPEN_AUTO_ROI_ADS`；延迟完成用 `CREATE_MANUAL_ROI_ADS_DIRECT` / `CREATE_AUTO_ROI_ADS_DIRECT`（`dashboard.js:4895-4980`; handler `background/main.js:11044-11093,11094-11199`） | 不是先编辑原 campaign，而是删旧广告再重新创建；延迟方案把商品ID及参数写到 delayed task。普通 timer/service worker 重启的可靠恢复需单独核验。真实后果包括广告先暂停投放的窗口和新 campaign 创建失败风险。
| 广告指标筛选 | 选时间段、ongoing/全部、曝光/点击/花费等条件、任一/全部匹配、仅指定/排除ID；可预览、导出、确认删除 | 预览 `PREVIEW_DELETE_BY_METRICS`；确认删除 `DELETE_ADS_BY_CAMPAIGN_IDS`；CSV/XLSX 下载走页面导出/`DOWNLOAD_XLSX`（`dashboard.js:4063-4095,4415-4469,4470-4509,4550+`） | 预览分页 query homepage，按指标本地匹配并把命中 pair 存进 state metrics cache；用户确认后删除 campaign。下载匹配结果只导出，不写 Shopee。页面确认框说明删除不可撤销。未发现从该筛选页发起“暂停”动作，暂停是 query paused/其他功能链；报告应避免把暂停误列为指标筛选动作。
| 广告健康检查 | `health-check` 页面按钮直接绑定 dashboard IIFE，按状态拉取今天广告列表、取 campaign IDs，再查 trait 并显示异常 | **没有 runtime message action**：`dashboard.js:2454-2586` 在页面直接用 cookies、fetch 发请求；这条链不经 `background/main.js` handler。 | query POST `/api/pas/v1/homepage/query/`，body `{start_time,end_time,sorting:{key:"cost",direction:"desc"},filter_list:[{campaign_type:"new_cpc_homepage",state,search_term:""}],offset,limit}`；随后每批40 campaign POST `/api/pas/v1/homepage/list_additional_trait/` body `{campaign_id_list,reference_id,required_trait_list:["enhance_roas","anti_fraud_notification","ad_is_stopped_by_roi_two_migration"]}`。命中 `anti_fraud_notification` 或 `ad_is_stopped_by_roi_two_migration` 为异常。源码另有可后台批量取 traits 的方法 `listAdditionalTraitBatch`（每批50；`background/main.js:13977-14012`）及 TopupManager 每日 `AD_TRAIT_HEALTH_CHECK` alarm，但按钮没有调用该后台 method。健康检查只读。
| 标题/关键词 | 商品选择/搜索/列表，标题直接修改、删除广告后改标题、复制删除重上架；推荐关键词/提示/搜索 | `GET_PRODUCT_LIST`,`SEARCH_PRODUCTS`,`UPDATE_PRODUCT_TITLE`,`GET_RECOMMENDED_KEYWORDS`,`GET_KEYWORD_HINTS`,`SEARCH_KEYWORD`,`DELETE_AD_AND_UPDATE_TITLE`,`COPY_DELETE_RELIST_PRODUCT`（后台 `17815-17900`）。 | `SEARCH_KEYWORD` 实际 POST `/api/pas/v1/setup_helper/search_keyword/`，body `{keyword,campaign_type:"product",item_id,suggest_log_data:{campaign_id:null,page:"suggest_creation"}}`；HTTP OK 且 `data.code===0` 返回 `{success:true,keywords:data.data||[]}`（`background/main.js:15075-15135`）。此处是创建广告用关键词辅助搜索，不是关键词竞价投放。

### 商品批量操作的边界与消息路由

`dashboard.js` 的操作选择器明确有四项：`delete-all`、`delete-delisted`、`list-unlisted`、`unlist-live`（`dashboard.js:1031-1055`）。统一 `executeProductOperation` 发消息 payload `{spcCds,ids,excludeIds}`，空 IDs 表示后台自动拉取商品，`dashboard.js:1004-1029`。后台产品分支进一步调用 `deleteAllProductsWithProgress`、`deleteDelistedProductsWithProgress`、`relistProductsWithProgress`、`unlistProductsWithProgress`（`background/main.js:11522-11555,11956-12010`）。下面补记删除/上架/下架 API 的最小请求体；列表枚举与目标商品筛选由 helper 处理。

补足产品写 API（根 `getApiBaseUrl` 会把 `/api` 前缀拼上，后台请求在 Shopee 页面上下文中执行）：

- 删除商品：POST `/api/v3/product/delete_product/?version=3.1.0&SPC_CDS=...&SPC_CDS_VER=2`，最小 body `{product_id_list:[商品ID,...]}`，每批最多48，最多重试3次；要求顶层 `code===0`，并按 `data.result[]` 逐项计成败（`background/main.js:12010-12047`）。
- 上架/下架商品：POST `/api/v3/product/update_product/?version=3.1.0&source=seller_center&SPC_CDS=...&SPC_CDS_VER=2`，body 是数组 `[{id:商品ID,unlisted:false}]` 上架，`[{id:商品ID,unlisted:true}]` 下架，每批最多48（`background/main.js:12088-12125,14112-14151`）。上架 helper 的结果条件检查 `message/error`；下架要求顶层 code 0 且存在 result 数组，并逐项判断 `result.code===0`。这两项都是商品 listing 状态写入，非广告活动启停。

### mass_create 请求字段与逐项成功标准

全店和指定商品复用 `batchPublishProductsMassCreate`（`background/main.js:12703-12828`）。完整关键 body 如下（值经过 TWD raw-unit 转换；`start_time` 是本次重新计算时间）：

```js
{
  reference_id: UUID,
  campaign_list: ids.map(item_id => ({
    item_id,
    daily_budget: twdToRaw(dailyBudgetTwd),
    product_selection: "manual",
    start_time: retryStartTime,
    bidding_strategy: "roi_two",
    end_time: 0,
    roi_two_target: { target_value: twdToRaw(roiTwoTargetTwd || 0), log_key },
    creative: false,
    new_product_boost_toggle: false,
    potential_product: { is_good_potential: false, is_low_price: false },
    rapid_boost: Boolean(rapidBoost)
  })),
  header: {}
}
```

自动ROI由 `roiTwoTargetTwd=0` 进入同一 mass_create body，并不是另一 API；源码仍把 `bidding_strategy` 置为 `roi_two`，`target_value` raw 0。整体最多三轮只重试失败商品。成功需顶层 `code===0` 且有 `data.result_list`，并且逐项 `result.code===0 && result.campaign_id`；只看顶层 code 不足以判整批成功（`12791-12827`）。

### 广告编辑类型、搜索助手与暂停恢复接口

- 删除：POST `/api/pas/v1/homepage/mass_edit/`，`{campaign_id_list,type:"delete"}`，按50个一批；方法识别 `response.code===0 || response.ok`（`background/main.js:11662-11715`）。
- 暂停/恢复：同 URL，body `{campaign_id_list,type:"pause"}` 或 `{campaign_id_list,type:"resume"}`；后台常规 helper 原样返回响应，`pauseAdCampaign/resumeAdCampaign` 独立 helper 明确要求 HTTP OK 且业务 `code===0`（`background/main.js:13887-13902,15577-15610`）。
- 改日预算：同 URL，body `{campaign_id_list,type:"change_budget",change_budget:{daily_budget:twdToRaw(targetBudgetTwd),budget_log_key:UUID}}`（`background/main.js:13904-13929`）。
- ROI：先从 `/api/pas/v1/homepage/query/` 取活动，再逐 campaign POST `/api/pas/v1/product/edit/`，body `{reference_id,campaign_id,change_roi_two_target:{log_key,target_value:twdToRaw(roiTargetTwd)},type:"change_roi_two_target"}`。`productEditChangeROI` 通过 `retryUntilSuccess` 重试最多5次，但 helper 本身没有显式断言响应 code；`editRoiAll/editRoiByItemIds` 再按该调用是否抛错汇总结果（`background/main.js:12899-12922,12944-13035`）。
- 关键词搜索字段和响应如上；推荐词及 hint 也使用同 setup_helper family，响应包装分别 `keywords`/`hints`，都是 `code===0` 才 success。

### 非后台 message 路由、疑似未接通项与代码真值

- 发现健康检查按钮是 dashboard 页面直接 `fetch`，不发消息；这与 README/架构概览中“所有组件通过 sendMessage、后台为中心”的概括不完全相符，应在迁移书标记为真实例外。
- `STOP_CPC_MONITOR` 路由存在；`background/main.js` 通过 `setTimeout` 每30秒自调度，当前配置不是 storage/Chrome alarm 持久 job。故属于能在存活 service worker 中工作的自动任务，不能把它写成重启后必续跑。
- source `CLAUDE.md` 说 `boost control`，页面提示和 endpoint 都指广告加速推广。
- dashboard 有 `data-permission` 标记，但这些权限是 UI 许可标签；本报告没有对服务器 license 的每个功能 key 和后台 gated action 做完整权限一致性验证。
- `dashboard.html` 当前可见 11 个相关页签均有对应 pane：全店、CPC、批删广告、商品批操作、指定商品、ROI、加速推广、重开、指标筛选、健康检查、标题；另一个第12页为 fsmode，按委托范围排除。
- 本次核对未发现这些 11 页里“按钮视觉存在但完全没有事件绑定”的确证项。筛选页 download matched 有 JS 点击处理并输出本地文件；健康检查是页面直连而非缺路由；广告/API 和商品/API 两类删除入口不同。运行可用性仍需实机验证，纯静态链路不能证明当前 Shopee endpoint/账号接受请求。
