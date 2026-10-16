# 源项目限时特卖、备货与物流功能调查

调查对象：`D:\shopee_xm\虾皮插件-客户` 当前工作树；清单按主源 `manifest.json` 指向的 `background/main.js` 与根目录 `popup.html`、`dashboard.js`、`shipping-console.html/js` 核对。未把 `dist`、发布包或 `shopee-plugin(1)` 副本当作主源。仅静态读取；没有启动扩展/服务、浏览器、构建、测试或请求 Shopee。

## 先给迁移决策

本轮优先项应限定为 shipping-console 可见的“商品备货天数、物流与定时修改”，不把 Dashboard 的 FS_MODE 一日资格修复合并进 SKU shipping。建议把旧代码中可迁移行为拆成：批量备货主流程、商品级 SKU 备货修改、店铺物流开关维护、商品物流编辑、TW 全店次日、定时两任务、只读库存分类；其中自动定时强停旧任务、开始即标记 executed、以及物流恢复失败仍继续等语义需要改造，不宜照搬。

目标项目已有的复用能力以目标当前代码/手册为准：后台任务状态、进度、停止与恢复规则；SKU 表格编辑保留其它 override 字段；登录态/凭据从 seller tab 读取；已有的一日 SKU 修复流程是 Dashboard/后台独立功能，可复用 API 处理经验但不能等同 shipping 的 SKU tab。目标项目用户已通过既有一日修复流程手测；本调查没有改目标产品代码。

## 用户可见功能及区分

| 面向用户的入口 | 功能 | 写入性质与迁移备注 |
|---|---|---|
| 根 popup 限时特卖自动续期卡片 | 监控近期开启的活动、关闭旧场次、选新时段创建并设置商品 | 会改 Shopee 活动；后台 alarm/恢复。旧 popup 能力独立于 dashboard FS_MODE。 |
| Dashboard FS_MODE Step 1「资格伪造」 | 一日 SKU 资格修复，必要时备份/移除冲突折扣、改商品 SKU、恢复折扣 | 高影响商品与折扣写入；与 shipping-console SKU tab 完全不同。 |
| Dashboard FS_MODE 手动开卖/自动模式 | 手动选择场次和 SKU 参数开卖；或按时段自动建场/开卖 | 活动写入与 alarm 调度；是实际接通的用户功能。 |
| Dashboard 调试面板 | 查活动/商品并能关闭由调试流程创建的活动 | 查询加可写关闭操作，不是纯展示。 |
| shipping-console 四个 tab | 批量备货、SKU 备货、库存现货/预售查询、全店次日 | 前三种写入/只读区分见下文。 |
| shipping-console 商品物流弹窗 | 查询商品并修改单品物流渠道 | 写入商品物流配置，与店铺级 toggle 不同。 |
| shipping-console 定时任务1/任务2 | 两个日期时间/天数任务；自动模式下可每日循环 | 真实接通，但任务相互强停风险高。 |
| CLAUDE 文档声称的隐藏现货/预售每日循环 | 代码中未找到对应字段/调度入口 | `spotTime`、`restorePreorderTime`、`scheduledTask`、`checkMissedExecution` 等无命中；文档描述不能当作已接通能力。一般 `calculateNextExecution(schedule)` 属于无关配置更新调度。 |

## 一、shipping-console：批量备货、物流 toggle、定时任务（第一轮核心）

### 用户入口和消息链

`shipping-console.html` 的批量备货页提供现货/预售/自动模式、天数、范围（全部/在线/下线/非热销）、手动排除商品、礼品排除、是否 toggle 物流。现货界面固定 1 天，预售页面选项为 2–10 天；后台配置字段仍接受数值，SKU tab 单独提供 1–30 天。

启动由 `shipping-console.js` 的 `startBulkShippingUpdate(config)` 发送 `START_UPDATE`，`settings` 含 `mode`、`daysToShip`、`updateRange`、`excludeProductIds`、`giftItemIds`、`toggleLogistics`。消息经 `apiClient.handleStartShippingUpdate(settings)` 到 `shippingUpdateManager.handleStartShippingUpdate`。后台先确保卖家中心 tab、拒绝并发批次；若前端没传赠品 ID，则可查询 add-on deal；同时拉取限时特卖商品 ID，排除赠品、活动商品和手动排除项。保存运行状态/模式/天数/范围/toggle/progress/AbortController，再启动异步批次，消息返回只表示“已开始”，不是整批成功。

商品列表由 `/api/v3/product/search_product_list_v2/` 分页读取，常见查询字段为 `SPC_CDS`、`SPC_CDS_VER`、`page_size=50`、`source=attribute_tool`、`cursor`、`version=4.0.0`；读取 `data.list`、`data.page_info.total`、`data.page_info.cursor`。status 数值 1 是在线、8 是下线；非热销通过销量/浏览量前 500 的集合排除；spot/preorder 范围再基于商品的 `is_pre_order` 筛选。写入 item 的形态为 `{id,category_path,pre_order,days_to_ship}`。

实际写操作 POST `/api/v3/product/update_product/?version=3.1.0&source=attribute_tool`，body 是上述 item 数组。HTTP 200 且 `code===0` 视为批次成功；返回 `code=1000100007` 时检查 `data.result[]`，逐商品 `id/code` 分类，0 成功、`1000100252` 标为不支持物流并跳过，其它失败会重试。请求过频相关 409、`1000100006`、`requests too frequent` 会退避/缩批；HTTP 429 走并发/单商品 fallback 模式。最多 5 轮重试；进度和失败 ID/原因留在状态与日志中。停止通过停止消息设置 abort/运行标志；长分页和批次在检查状态后退出。细节以当前 `shippingUpdateManager` 实现为准。

### 店铺物流全局 toggle

启用 toggle 时，批次准备阶段读取 `/api/v3/logistics/get_channel_list`（SPC_CDS/VER），以 `data.list` 找到当前启用渠道；对每个已启用 channel POST `/api/v3/settings/update_channel_toggle`，payload 精确为 `{command:'set_enable', enabled:false, channel_id, proceed_with_mass_toggle_on_item_channels:false}`，逐个间隔约 1 秒。已启用 ID 保存到本次运行状态，商品更新结束后对原渠道逐个使用同一路径、`enabled:true` 恢复。关闭渠道失败时状态仍可能标为已关闭并继续商品流程；finally 恢复也可能部分失败，依靠日志呈现，没有事务回滚保证。因此迁移验收要逐项核实“失败是否阻止备货”“保存原始启用集”“中断/异常恢复”“恢复不全如何显式告警/重试”。这属于店铺级开关，不能与单品物流 payload 混为一谈。

### task1/task2 定时调度和危险边界

shipping-console 页面有 task1/task2 的 date、time、days；自动开关打开时显示 `loopDaily`，并有物流 toggle、排除商品。`SET_AUTO_SETTINGS` 传 `{autoMode,task1,task2,toggleLogistics,loopDaily,excludeProductIds}`，由 `automationManager.setAutoSettings()` 保存入 automation state；`automation-heartbeat` 每 2 分钟检查到期任务。到时分别调用批量备货 handler，范围是 all，并带天数/排除/物流开关。

关键实现风险：开始 task2 时若已有不同模式/天数的运行任务，会强制 stop 前一批、等待约 2 秒再启动；`handleStartShippingUpdate` 是 fire-and-forget，调度器一收到“已开始”就把 task 标为 executed，loopDaily 还会立即把日期推进一天，并不等整批处理完成。task2 因而可能截断 task1，日期状态也可能在批次失败前推进。迁移要以单队列、明确等待完成后才推进、任务锁/互斥、持久化可恢复状态来定义验收；不可复刻“强停前一批 + fire-and-forget 标记已执行”。

## 二、shipping-console：SKU 备货 tab

### UI 与范围

`shipping-console.html` 的 SKU tab 输入目标天数（1–30）、可选 SKU 名称子串、必填礼品排除来源/ID、额外排除 ID；也能选 add-on deal。`shipping-console.js` 选择 deal 后发送 `GET_EXCLUDE_ITEMS_FROM_DEALS`，响应 `excludeItemIds`（主商品）和 `giftItemIds`（赠品）；再发送 `skuShippingUpdate`，config 为 `{randomDaysToShip,targetSkuName,excludeGiftIds,excludeUpdateIds,spcCds,targetItemIds}`。后台 `apiClient` message router 转到 `skuUpdateManager.handleStartSkuUpdate` 一类入口；用户看到“已启动”后看独立进度/日志。

产品列表使用 `/api/v3/opt/mpsku/list/v2/search_product_list`，参数包括 SPC_CDS/VER、`page_size=48`、`list_type=live_all`、`request_attribute:""`、`operation_sort_by:"recommend_v2"`、`need_ads:true`、cursor。只处理 status=1 在线品；按礼品排除、指定主商品集合及额外排除 ID 过滤。流程按 phase 队列运行，批次最多 100、注入并发 chunk 15，阶段间隔/随机延迟；停止会检查 `isRunning`。

### SKU 字段和礼品行为

`generateSkuUpdateData(product,settings,isGiftProduct,allSkuMode)` 生成 POST `/api/v3/product/update_product_info` 的 `product_info`：`enable_model_level_dts:true`、`model_list:[{id,tier_index,pre_order_info:{days_to_ship,pre_order}}]`、`is_draft:false`。先将全部 SKU 设 1 天/非预售；选中 `targetSkuName` 子串命中的第一个 SKU，否则选择最后一条 SKU，把该条设 `randomDaysToShip`；`pre_order` 为天数大于 1。all-SKU 子流程会将商品每条 model 都设置目标天数。礼品相关 phase 会把赠品 SKU 设回 1 天。生成项额外携带 `targetSkuName`、`actualTargetSku`、`isGift`、`allSkuMode` 供进度/注入处理，非 Shopee 商品字段。

当前代码有礼品 phase 与主商品 phase 排程，新增迁移时需以实际队列生成条件和 UI deal 入口一起覆盖。提交失败/异常进入 failedItems、计数和日志；后续 retryFailedItems 会重试失败商品。SKU tab 与 Dashboard 一日资格修复的目的、调用层和写入数据均不同。

## 三、shipping-console：现货/预售库存查询 tab（只读）

用户点 `startStockQuery()`，发 `stockQuery`（SPC_CDS）；路由到 `apiClient.handleStartStockQuery()`，设置 `stockQueryState` 的 running、计数、两个 ID 数组、AbortController 和开始时间，然后异步分页读取。查询 GET `/api/v3/product/search_product_list_v2/`，参数 `SPC_CDS`、`SPC_CDS_VER=2`、`page_size=48`、`source=attribute_tool`、`version=4.0.0`、cursor。要求 HTTP ok 和 `data.code===0`，取 `data.list`（兼容 `products`）与 `page_info.total/cursor`，页间等待约 500ms；静态实现未见分页重试。失败会记录日志并结束运行，不写商品。

分类函数 `isSpotProduct`：有 model_list 时只要任一 model `estimated_days>1` 即判 preorder；否则 spot。无 model_list 时回退 `product.estimated_days || product.days_to_ship || 1`，等于 1 是 spot，其它按 preorder。状态 1/8 仅用于 online/offline 分组统计；最终 `spotIds` / `preorderIds` 汇总两种状态的 ID。`STOCK_QUERY_PROGRESS_UPDATE` 更新 UI，`STOCK_QUERY_COMPLETED` 返回两组数组；页面可复制换行分隔 ID。若商品 SKU 天数混杂，任一 SKU >1 会让整品归预售，应作为迁移验收边界。

## 四、shipping-console：全店次日 tab（TW 固定渠道）

全店页面先用 `FETCH_LOGISTICS_PRODUCTS` 按页拉全商品（page size 30，直到 has_next_page=false 或短页），并可获取 add-on deals 的主商品/赠品映射。该流程只适用于 Shopee 台湾卖家站；物流渠道 ID `30019` 是代码固定值，不是从用户店铺动态发现的通用 ID。

商品物流信息通过前述 `get_product_channel_info` 读取。若商品尚无 30019，添加 `{channelid:30019,enabled:true,sizeid,size,price:'0',cover_shipping_fee:false}`；若已有则保留其他字段并设 enabled=true。再调用 `UPDATE_SINGLE_SKU`，由 `shippingUpdateManager.updateSingleProductDays(productId,targetDays,skuNameFilter,modelList,allSkusSameDay)` 修改备货：读取商品信息 GET `/api/v3/product/get_product_info?product_id=...&is_draft=false`，除非调用方已传 modelList；POST `/api/v3/product/update_product_info`。`allSkusSameDay:true` 时 body 使用 `enable_model_level_dts:false` 和 `pre_order_info:{days_to_ship:targetDays,pre_order:targetDays>1}`；SKU 定向时使用 `enable_model_level_dts:true`、model_list 全量字段，对名称匹配 SKU 设置 targetDays，其余设置 1 天；没有过滤名时最后一条 SKU 为目标。成功要求 API code 0。

带 deal 的全店流程：查询 `GET_EXCLUDE_ITEMS_FROM_DEALS` 得 `mainItemIds`/`giftItemIds`；`BATCH_FETCH_PRODUCTS_INFO` 获取名称/model_list；礼品先统一临时设为 1 天（不改物流）；主商品启用 30019，再按 SKU filter 改备货天数；SKU 更新失败会尝试关闭再重新开启渠道并重试，最多三次后进延后队列另试一次；最终失败时尽量关闭 30019。结束后礼品重新启用 30019，并以 `allSkusSameDay:true` 恢复配置天数。另有“只改 SKU”子模式，会把 deal 主品改为 1 天而不修改物流。失败重试涉及物流副作用，不能只看最终 SKU 成功数；需分别验收渠道状态和所有 SKU 天数。

## 五、商品级物流管理弹窗

`shipping-console.js` 的商品物流管理会发送 `FETCH_LOGISTICS_PRODUCTS`（pageNumber/pageSize）读取产品分页，用户选商品后发送 `FETCH_LOGISTICS_CHANNELS`。后台 `apiClient.fetchLogisticsChannels(productId)` 使用卖家站 POST `/api/v3/listing-upload/component/get_product_channel_info?SPC_CDS=...&SPC_CDS_VER=2`，body `{product_id,is_draft:false,shop_id:null}`；读取 `data` 中渠道列表。

“统一渠道配置”用用户选择的渠道数组直接更新；“单独调整”先读该产品渠道，对指定 channel 做启用/禁用/运费/尺寸等局部 patch，保留其它渠道。渠道对象涉及 `channelid`、`enabled`、`sizeid`、`size`、`price`、`cover_shipping_fee`。用户确认后发 `UPDATE_PRODUCT_LOGISTICS` `{productId,logisticsChannels}`，background router 调 `apiClient.updateProductLogistics`，POST `/api/v3/product/update_product_info?SPC_CDS&SPC_CDS_VER=2`，body `{product_id,product_info:{logistics_channels:channels},is_draft:false}`；API code 0 作为成功。批量产品并发约 15、单品最多重试 3 次，重试间隔约 1 秒。此操作会直接覆盖请求中的渠道数组；迁移需区分整体配置和保留现状的单渠道 patch。

## 六、根 popup 限时特卖自动续期（基础旧入口）

根 `popup.html` 的 flash-sale 卡片由 `popup.js` 开关发 `startAutoTopup` / `stopAutoTopup`；状态和列表分别请求 `getFlashSaleStatus` / `getFlashSaleItems`。路由到 background `topupLoopManager.startFlashSaleAutoTopup`，写 `autoTopupEnabled` 并创建 6 分钟周期 `flashsale_autoTopup` alarm；另有 4 分钟 heartbeat alarm。启动后立即检查，初始化时根据 storage 恢复；关闭时停止 alarm 并更新持久状态。工作前检查授权、卖家 tab 和 `flashSaleModeManager` 占用。

`handleFlashSaleAutoTopup` 注入 seller 页请求活动列表 `get_shop_flash_sale_list/?...offset=0&limit=10&type=0`，找 status=1 活动；剩余时间低于约 10 分钟才续期。读取旧活动商品 `get_shop_flash_sale_item/?flash_sale_id&offset&limit=100`。在关闭旧活动前存 `flashSalePendingCreate_<id>`，POST `set_shop_flash_sale/` `{flash_sale_id,time_slot_id,status:2}` 关闭；关闭失败由 content script 重试并返回 `flashSaleCloseRetrySuccess`。随后 GET `get_time_slot_id/?start_time&end_time` 选未来场次，组装商品字段 `input_promo_price,item_display_image,item_id,model_id,purchase_limit,status:1,stock`；无有效项不建空场。POST `set_shop_flash_sale/` `{time_slot_id}` 创建空活动，等待后将带新 `flash_sale_id` 的 job 存储并设 alarm，再 POST `set_shop_flash_sale_items/` `{flash_sale_id:newId,items:newItems,use_global_category:true}`。设置商品失败会尝试 status=2 关闭空场。

恢复逻辑清理超过 1 小时的 `flashSaleRenewal_` / `flashSalePendingCreate_`，恢复未过期 pending；相关失败最多重试 10 次。可见状态/日志分别用 `FLASH_SALE_STATUS`、`FLASH_SALE_LOG`，列表可从缓存或 API 获取。迁移需避免空活动遗留、关旧场成功但新场创建失败的断档，并明确商品价/库存映射；这段逻辑与 dashboard 新的 FS_MODE 自动开卖并行存在。

## 七、Dashboard FS_MODE：分开的功能链

### Step 1 一日 SKU 资格修复

入口为 `dashboard.js` 的 `runForgeFlow()` → `forgeEligibility()`。直接借 seller tab 的 MAIN-world injected transport 调 Shopee API，并非 shipping-console 的 `skuShippingUpdate`。先 GET `/api/v3/product/get_product_info` `{product_id,is_draft:false}`，看 `data.product_info`；任一 model 已有 `pre_order_info.days_to_ship===1` 则跳过。否则 `buildOneDaySkuProductInfo` 注入专用 SKU（“批發客戶下訂-請勿下單”）并生成 SKU 组合（最多 100 models）。

先 POST `/api/marketing/v3/public/discount/search/` `{discount_type:0,time_status:0,keyword:productId,search_type:2}` 查冲突折扣；有活动时先备份到 `fsmodeForgeBackup_${id}`，逐个 POST `/api/marketing/v4/discount/delete_abnormal_seller_discount_items/` `{promotion_id,item_id_list:[id]}`，间隔约 2 秒；然后 POST `/api/v3/product/update_product_info` `{product_id,product_info,is_draft:false}`。再 refetch 商品，POST `/api/marketing/v4/discount/update_seller_discount_items/` `{promotion_id,discount_model_list}` 恢复折扣。检查顶层 error=0 与 `data.failed_item_list`/`error_list`；移除失败则不发布商品，恢复失败保留备份并提供人工重试，没有自动恢复任务。其副作用包含 SKU/折扣修改。

### 手动/自动开卖模式与诊断

手动开卖 UI 有场次、商品、SKU 价格/库存/购买限制 override 与跳过项；`fsmodeStartEnable()` 发 `START_FSMODE_ENABLE`，后台 `flashSaleModeManager` 运行设置商品、进度/日志走 storage/message，停止为 `STOP_FSMODE_ENABLE`。自动模式 `fsmodeAutoStart()` 发 `START_FSMODE_AUTO`，含 `{mode,value,advanceMinutes,delayMinutes}`、`selectedSlotId/selectedSlotTime` 以及 `enableParams:{products,skuOverrides,skipSkuKeys,discountRate,flashSaleStock,purchaseLimit}`；后台用 alarms 与持久状态调度。手动/自动状态可查/停；`GET/SET_FSMODE_ACTIVE_MODE` 用于和 popup 旧续期互斥。诊断面板能查询并关闭调试创建的活动。以上均不是隐藏断链 UI。

## 目标迁移时的验收清单

1. 批量范围分别验证 status 1 在线、8 下线、非热销、spot/preorder；注意不能把这些源商品状态等同 GraphQL 活动查询中 status=0。
2. 验证商品级单 SKU 选择：名称匹配、多重匹配取首个、空/未命中时取最后一个、非目标重置 1 天、目标 1 与 2–30 的预售布尔值；全 SKU 模式及礼品行为单独验收。
3. 对写 API 实施逐项/逐商品结果统计，保留部分成功；限流退避必须停得住，不能对已成功项重复危险写入；停止后明确哪些商品已改。
4. 物流全局 toggle 保存原启用渠道，失败不可静默进入/完成；异常、取消、扩展重启后有可恢复的恢复队列和用户可见结果。商品级编辑分别验整体覆盖与单渠道局部 patch。
5. 全店次日只允许 TW 站配置使用 30019；把该渠道 ID 放站点适配配置并做站点限制，避免误用于别的站点。
6. 定时任务同一时刻/任务冲突时队列串行；只有整批终态后标记 executed/推进 loopDaily；失败可恢复并避免旧任务被新任务强停。
7. stock-query 只读，验多 SKU 混合天数分类规则、在线/下线统计、分页终止、复制 ID 内容与失败提示。
8. 旧 popup 续期与 FS_MODE 保持互斥；关闭旧场/创建新场/写入商品三阶段均记录可恢复状态，不能留下无法解释的空活动。

## 文档、代码与未知项

- 源根找到 `CLAUDE.md`，未发现源项目 `AGENTS.md`。按实际 `manifest.json` 主入口调查，包/副本不纳入。
- CLAUDE 对隐藏现货/预售每日循环的描述与当前代码不符：所述 schedule 字段/函数无代码命中。与 shipping 相关的可见 task1/task2 是唯一确认的定时入口。通用 `calculateNextExecution(schedule)` 在 config update manager 里，不代表物流定时。
- 源工作树有未提交变更；本报告陈述当前磁盘树，不代表稳定发布版历史行为。应以当前符号实现复核迁移，不引用旧包推断。
- 后台代码为打包/压缩风格，但报告依据运行时路由、方法实现和 UI 调用追踪。具体限流错误 code、部分响应字段会随 Shopee API 变化；这里仅记源代码使用的字段，未发网络请求验证其当前有效性。
- 重要源文件/符号：`manifest.json`；`popup.html`、`popup.js`；`dashboard.js` 中 `runForgeFlow`、`forgeEligibility`、`buildOneDaySkuProductInfo`、`fsmodeStartEnable`、`fsmodeAutoStart`；`shipping-console.html/js` 中批量启动、SKU tab、库存查询和全店次日 UI；`background/main.js` 中 `topupLoopManager`、`handleFlashSaleAutoTopup`、`processFlashSaleRenewal`、`continueFlashSaleRenewal`、`shippingUpdateManager.handleStartShippingUpdate`、`updateSingleProductDays`、`generateSkuUpdateData`、`handleStartStockQuery`、`startStockQueryProcess`、`apiClient.fetchLogisticsChannels`、`apiClient.updateProductLogistics`、`automationManager.setAutoSettings` 与 `executeTask`。
