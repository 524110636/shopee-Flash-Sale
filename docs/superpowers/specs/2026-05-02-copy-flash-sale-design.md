# 复制限时特卖功能设计文档

> **日期:** 2026-05-02
> **状态:** 设计稿（待审）
> **版本:** v2（补充全自动化流程）

---

## 1. 概述

### 1.1 目标

在现有限时特卖助手扩展中增加**全自动化复制限时特卖**功能——在活动开始前自动关闭旧活动、复制源活动配置、应用模板覆盖价格/库存/限购、启用商品，并在活动开始后运行开启循环。

### 1.2 背景

当前扩展已实现：
- 商品查询（GraphQL）
- 限时特卖活动列表加载
- 手动开启限时特卖（含 SKU 覆盖、模板、进度显示、失败重试）
- 后台 Service Worker 持续运行循环

用户目前需要手动操作：新建活动 → 添加商品 → 勾选 → 启用 → 扩展开启剩余。复制功能将这一系列操作降至**一键完成**。

### 1.3 API 总览（已通过抓包确认）

| API | 方法 | 用途 |
|-----|------|------|
| `get_shop_flash_sale_list/` | GET | 获取活动列表 |
| `get_shop_flash_sale/` | GET | 获取单个活动详情 |
| `get_shop_flash_sale_item_id_list/` | GET | 获取活动中的商品 ID |
| `get_shop_flash_sale_item/` | GET | **获取商品完整配置（价格/库存/限购）** |
| `get_abnormal_items/` | GET | 检查异常商品 |
| `get_item_criteria/` | GET | 获取上架规则 |
| `get_time_slot_id/` | GET | **获取可用时间段** |
| `set_shop_flash_sale/` | POST | **创建/关闭活动** |
| `set_shop_flash_sale_items/` | POST | **设置并启用活动商品** |
| GraphQL `query/` | POST | 查询商品详细信息 |

---

## 2. 功能流程

### 2.1 完整自动化流程

```
定时触发（活动开始前 5 分钟）:
  ─────────────────────────────────────────────────────
  步骤 1: 检查并关闭已有活动
          GET get_shop_flash_sale_list/
          → 遍历，过滤 status=1（进行中）
          有 → POST set_shop_flash_sale/ {flash_sale_id, time_slot_id, status:2}
               逐个关闭
          无 → 跳过

  步骤 2: 复制源活动
          GET get_time_slot_id/?start_time={now-30min}&end_time={月底}
          → 取 data[0] 的 timeslot_id（最近可用时间段）
          POST set_shop_flash_sale/ {time_slot_id}
          → 得到新活动的 flash_sale_id
          （服务端自动复制源活动商品）

  步骤 3: 应用模板覆盖价格/库存/限购
          检查是否有已保存的模板:
          有 → 用模板的 discountRate / flashSaleStock / purchaseLimit
               计算每个 SKU 的值
                POST set_shop_flash_sale_items/ {items: [...], use_global_category: true}
          无 → 跳过（直接用源活动的原始值）

  步骤 4: 启用商品
          （与步骤 3 合并——set_shop_flash_sale_items/ 的 status:1 已启用）
  ─────────────────────────────────────────────────────

活动开始后 5-10 分钟:
  步骤 5: 手动触发「开启限时特卖」
          用户点击 Popup 中的开启按钮
          运行现有 runEnableLoop（处理失败重试）
          （后期改为全自动）
```

### 2.2 用户操作流程

```
1. 配置源活动 + 模板
   ├─ 在活动列表中点击「复制」
   ├─ 确认面板选择源活动和模板
   └─ 系统将在活动开始前 5 分钟自动执行

2. 系统自动执行（无需用户干预）
   ├─ 检查并关闭已有活动
   ├─ 复制源活动到新时间段
   ├─ 应用模板覆盖（如有）
   └─ 启用所有商品

3. 活动开始后
   ├─ 用户手动点击「开启限时特卖」
   └─ 扩展处理失败重试
```

### 2.3 关于模板检测

```typescript
// 执行复制时的模板策略
const templateNames = await getTemplateNames();
if (templateNames.length > 0) {
  // 使用默认模板（第一个）或用户选择的模板覆盖价格/库存/限购
  // 调用 set_shop_flash_sale_items/
} else {
  // 不覆盖，使用源活动的原始值
  // 不调用 set_shop_flash_sale_items/（服务端已自动复制）
}
```

**为什么用模板：** 虾皮的 `set_shop_flash_sale_items/` API 可以设置我们需要的所有字段：
- `input_promo_price` — 促销价（用模板折扣率 × 原价计算）
- `stock` — 活动库存（用模板值或 SKU 覆盖值）
- `purchase_limit` — 限购数量（用模板值或 SKU 覆盖值）
- `status: 1` — 启用

---

## 3. 定时触发机制

### 3.1 定时策略

| 参数 | 值 | 说明 |
|------|----|------|
| 触发时间 | 活动开始前 **5 分钟** | `start_time - 300` 秒 |
| 执行内容 | 关闭旧活动 → 复制 → 应用模板 → 启用 | 步骤 1-4 |
| 活动开始后 | 5-10 分钟后手动开启循环 | 步骤 5（后期自动化） |

### 3.2 定时实现

使用 Chrome Alarms API（与 existing 定时机制一致）：

```typescript
// 设置复制任务定时器
chrome.alarms.create('copy_flash_sale', {
  delayInMinutes: delayFromNow,  // 活动开始前 5 分钟
});

// Alarm 触发时执行
if (alarm.name === 'copy_flash_sale') {
  await executeCopyProcess(params);
}
```

也可使用 `setTimeout`（如果 SW 不频繁休眠），但因 MV3 Service Worker 可能被终止，**推荐使用 `chrome.alarms`**。

### 3.3 用户配置定时任务

在确认面板中可设置：

```
┌─────────────────────────────────┐
│  定时执行计划                    │
│  ────────────────               │
│                                 │
│  源活动: 活动A                  │
│  目标时间: 2026-05-03 00:00     │
│  ⏰ 系统将在 23:55 自动执行      │
│                                 │
│  使用模板: 默认模板 ✓           │
│                                 │
│  ┌──────┐  ┌──────────────┐    │
│  │ 取消 │  │  确认创建任务 │    │
│  └──────┘  └──────────────┘    │
└─────────────────────────────────┘
```

---

## 4. UI 设计

### 4.1 布局方案

采用**独立面板**模式，在 Popup 中通过 `copyMode` 状态切换视图：

| 视图 | 触发条件 | 说明 |
|------|---------|------|
| 默认视图 | `copyMode === null` | 现有活动列表 + 每行新增「复制」按钮 |
| 确认面板 | `copyMode === 'confirm'` | 展示复制信息 + 定时计划 + 确认/取消 |
| 结果面板 | `copyMode === 'result'` | 展示任务创建成功/失败结果 |

### 4.2 活动列表 —— 新增「复制」按钮

在现有 `flashSaleList` 的每个活动项中新增「复制」按钮：

**按钮规则:**
- 所有状态的活动均显示「复制」按钮
- 点击时加载源活动的商品数量展示在确认面板
- 如果该活动是进行中（status=1），系统会自动先关闭再复制

### 4.3 复制确认面板

```
┌─────────────────────────────────┐
│  ← 返回活动列表                  │
│                                 │
│  复制限时特卖                    │
│  ────────────────               │
│                                 │
│  源活动: 活动A                  │
│  活动时间: 05/02 18:00~00:00    │
│  商品数量: 14 个                │
│                                 │
│  定时执行计划:                  │
│  📅 目标活动时间:               │
│     ┌──────────────────────┐   │
│     │ 2026-05-03 00:00    │   │
│     └──────────────────────┘   │
│  ⏰ 系统将在开始前 5 分钟执行   │
│                                 │
│  使用模板:  [默认模板 ▼]       │
│  或:  [不使用模板]              │
│                                 │
│  ┌──────┐  ┌──────────────┐    │
│  │ 取消 │  │  创建复制任务 │    │
│  └──────┘  └──────────────┘    │
└─────────────────────────────────┘
```

### 4.4 结果面板

**成功状态：**

```
┌─────────────────────────────────┐
│  ✅ 复制任务已创建！             │
│                                 │
│  源活动: 活动A                  │
│  目标时间: 05/03 00:00          │
│  执行时间: 05/02 23:55          │
│  使用模板: 默认模板             │
│                                 │
│  ⏳ 等待定时执行...             │
│                                 │
│  [返回活动列表]                 │
└─────────────────────────────────┘
```

**执行完成后（用户重新打开 Popup）：**

```
┌─────────────────────────────────┐
│  ✅ 复制执行成功！               │
│                                 │
│  新活动: 活动A (05/03 副本)     │
│  商品: 14 个                    │
│  状态: 已启用                   │
│                                 │
│  提示: 活动开始后可点击          │
│  「开启限时特卖」处理失败 SKU   │
│                                 │
│  [返回活动列表]                 │
└─────────────────────────────────┘
```

**失败状态：**

```
┌─────────────────────────────────┐
│  ❌ 复制执行失败                 │
│                                 │
│  错误: 关闭已有活动失败          │
│  详情: ...                      │
│                                 │
│  [返回]  [重试]                 │
└─────────────────────────────────┘
```

### 4.5 简化加载状态

「创建复制任务」按钮点击后变为 `⏳ 正在创建...` 并禁用。

---

## 5. 后台逻辑（Background 变更）

### 5.1 新增消息处理

```typescript
// ===== GET_TIME_SLOTS: 获取可用时间段 =====
if (type === 'GET_TIME_SLOTS') {
  const startTime = Math.floor(Date.now() / 1000) - 1800; // 当前-30min
  const endTime = getMonthEnd();                           // 月底
  const data = await injectedFetch(
    `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=...&SPC_CDS_VER=...&start_time=${startTime}&end_time=${endTime}`
  );
  return { timeSlots: data?.data || [] };
}

// ===== CLOSE_FLASH_SALE: 关闭活动 =====
if (type === 'CLOSE_FLASH_SALE') {
  const { flashSaleId, timeSlotId } = msg;
  await injectedFetch(
    `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=...&SPC_CDS_VER=...`,
    'POST',
    { flash_sale_id: flashSaleId, time_slot_id: timeSlotId, status: 2 }
  );
  return { success: true };
}

// ===== COPY_FLASH_SALE: 创建新活动 =====
if (type === 'COPY_FLASH_SALE') {
  const { timeSlotId } = msg;
  const data = await injectedFetch(
    `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=...&SPC_CDS_VER=...`,
    'POST',
    { time_slot_id: timeSlotId }
  );
  return { success: true, flashSaleId: data?.data?.flash_sale_id };
}

// ===== APPLY_TEMPLATE_ITEMS: 应用模板并启用商品 =====
if (type === 'APPLY_TEMPLATE_ITEMS') {
  const { flashSaleId, items } = msg;
  const data = await injectedFetch(
    `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=...&SPC_CDS_VER=...`,
    'POST',
    { flash_sale_id: flashSaleId, items, use_global_category: true }
  );
  return { success: true, failedItems: data?.data?.failed_items || [] };
}
```

### 5.2 全自动执行流程（Alarm 触发）

```typescript
async function executeScheduledCopy(params: ScheduledCopyParams) {
  try {
    // 步骤 1: 关闭已有活动
    const listData = await injectedFetch<{data: {flash_sale_list: FlashSale[]}}>(
      `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=...&SPC_CDS_VER=...&offset=0&limit=50&type=0`
    );
    const activeSales = (listData?.data?.flash_sale_list || []).filter(s => s.status === 1);
    for (const sale of activeSales) {
      await injectedFetch(
        `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=...&SPC_CDS_VER=...`,
        'POST',
        { flash_sale_id: sale.flash_sale_id, time_slot_id: sale.timeslot_id, status: 2 }
      );
    }

    // 步骤 2: 复制源活动
    const timeSlotData = await injectedFetch<{data: any[]}>(
      `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=...&SPC_CDS_VER=...&start_time=${startTime}&end_time=${endTime}`
    );
    const timeSlotId = timeSlotData?.data?.[0]?.timeslot_id;
    if (!timeSlotId) throw new Error('没有可用时间段');

    const createData = await injectedFetch<{data: {flash_sale_id: number}}>(
      `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=...&SPC_CDS_VER=...`,
      'POST',
      { time_slot_id: timeSlotId }
    );
    const newFlashSaleId = createData?.data?.flash_sale_id;

    // 步骤 3: 应用模板（如有）
    if (params.templateItems && params.templateItems.length > 0) {
      await injectedFetch(
        `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=...&SPC_CDS_VER=...`,
        'POST',
        { flash_sale_id: newFlashSaleId, items: params.templateItems, use_global_category: true }
      );
    }

    // 保存结果
    await saveCopyResult({ success: true, newFlashSaleId });
  } catch (e: any) {
    await saveCopyResult({ success: false, error: e.message });
  }
}
```

### 5.3 定时任务管理

```typescript
// 设置定时任务
async function scheduleCopy(params: ScheduledCopyParams) {
  const targetTime = params.targetStartTime - 300; // 提前 5 分钟
  const delayMs = targetTime * 1000 - Date.now();
  if (delayMs <= 0) throw new Error('目标时间已过');

  // 保存参数到 storage
  await browser.storage.local.set({ _scheduledCopy: params });

  // 设置 alarm
  chrome.alarms.create('scheduled_copy', { delayInMinutes: Math.ceil(delayMs / 60000) });
}

// 取消定时任务
async function cancelScheduledCopy() {
  chrome.alarms.clear('scheduled_copy');
  await browser.storage.local.remove('_scheduledCopy');
}
```

---

## 6. 状态管理（Store 变更）

### 6.1 新增类型

```typescript
// types.ts 新增

export interface TimeSlot {
  timeslot_id: number;
  start_time: number;
  end_time: number;
}

export interface ScheduledCopyParams {
  sourceFlashSaleId: number;
  targetStartTime: number;       // 目标活动开始时间（用户选择）
  templateName: string | null;   // 使用的模板名（null=不使用）
  templateItems: EnableItem[] | null;  // 预计算的模板 items
}

export interface CopyTaskStatus {
  scheduled: boolean;
  targetTime: number;
  executed: boolean;
  success: boolean | null;   // null=待执行, true=成功, false=失败
  newFlashSaleId?: number;
  error?: string;
}
```

### 6.2 新增状态

```typescript
interface AppState {
  // ...现有状态...

  // 复制功能
  copyMode: null | 'confirm' | 'result';
  copySource: { flashSale: FlashSale; itemCount: number } | null;
  copyTaskStatus: CopyTaskStatus | null;
  isCopying: boolean;
  savedTemplates: string[];     // 已保存的模板名称列表
  selectedTemplate: string | null;
}
```

### 6.3 新增 Action

```typescript
interface AppState {
  // 进入复制模式（点击「复制」按钮时触发）
  enterCopyMode: (flashSale: FlashSale) => Promise<void>;

  // 创建复制任务（点击「创建复制任务」时触发）
  createCopyTask: (targetTime: number, templateName: string | null) => Promise<void>;

  // 取消复制任务
  cancelCopyTask: () => Promise<void>;

  // 检查已有的复制任务（打开 Popup 时调用）
  checkCopyTaskStatus: () => Promise<void>;

  // 退出复制模式（返回列表）
  exitCopyMode: () => void;
}
```

---

## 7. 错误处理

| 场景 | 错误信息 | 处理方式 |
|------|---------|---------|
| 没有可用时间段 | 当前没有可用限时特卖时段 | 提示用户选择其他日期 |
| 关闭活动失败 | 关闭已有的限时特卖失败: {错误详情} | 显示错误 + 重试按钮 |
| 创建活动失败 | 创建限时特卖活动失败: {错误详情} | 显示错误 + 重试按钮 |
| 模板应用失败 | 启用商品失败: {失败详情} | 显示失败项，提供重试 |
| 网络断连 | 没有找到 seller.shopee.tw 标签页 | 提示保持卖家中心页面打开 |
| SPC_CDS 过期 | 认证已过期，请重新获取 SPC_CDS | 引导用户重新连接 |
| 定时时间已过 | 目标时间已过，请重新设置 | 提示用户检查时间 |

---

## 8. 定时触发和自动执行总结

### 8.1 时间线

```
活动开始前 5 分钟                   活动开始后 5-10 分钟
    │                                      │
    ├─ 关闭已有活动                        │
    ├─ 获取可用时间段                      │
    ├─ 创建新活动                          │
    ├─ 应用模板覆盖（如有）                │
    └─ 启用所有商品                        └─ 手动开启循环
```

### 8.2 后续自动化扩展

- 在 `runEnableLoop` 基础上增加自动触发机制
- 活动开始后自动调用 START_ENABLE
- 实现完全无人值守的全自动流程

---

## 9. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `entrypoints/popup/types.ts` | 修改 | 新增 `TimeSlot`、`ScheduledCopyParams`、`CopyTaskStatus` 类型 |
| `entrypoints/popup/store.ts` | 修改 | 新增复制相关状态和 actions |
| `entrypoints/popup/App.tsx` | 修改 | 新增复制面板视图切换 |
| `entrypoints/background.ts` | 修改 | 新增 `GET_TIME_SLOTS`、`CLOSE_FLASH_SALE`、`COPY_FLASH_SALE`、`APPLY_TEMPLATE_ITEMS`、Alarm 处理 |
| `components/product/CopyFlashSale.tsx` | **新建** | 复制确认面板组件 |
| `components/product/CopyResult.tsx` | **新建** | 复制结果面板组件 |
| `docs/shopee-flash-sale-api.md` | 修改 | 补充已验证的复制流程和关闭流程 |

---

## 10. 不做的事情（明确不包含在当前阶段）

- ❌ 活动开始后自动触发开启循环（当前保留手动触发，便于调试）
- ❌ 在 content script 中增加 UI
- ❌ 批量复制多个活动
- ❌ 修改已有活动的功能（只复制新建）
- ❌ 时间段选择界面（自动选择最近时间段）
