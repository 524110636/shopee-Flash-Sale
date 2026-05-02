# 复制限时特卖功能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现"复制限时特卖"核心功能——用户选择一个已有活动，设置目标时间，系统在开始前自动完成关闭旧活动、复制、应用模板、启用商品的全流程。

**Architecture:** 在 Popup 中通过 copyMode 状态切换独立面板（列表→确认→结果），后台通过 message handlers 执行 API 调用，使用 chrome.alarms 实现定时触发。

**Tech Stack:** WXT + React 19 + TypeScript + Zustand + Tailwind CSS + shadcn/ui

---

## 文件结构

| 文件 | 变更类型 | 职责 |
|------|---------|------|
| `entrypoints/popup/types.ts` | 修改 | 新增 `TimeSlot`、`CopyTaskStatus`、`ScheduledCopyParams` 类型 |
| `entrypoints/background.ts` | 修改 | 新增 `GET_TIME_SLOTS`、`CLOSE_FLASH_SALE`、`COPY_FLASH_SALE`、`APPLY_TEMPLATE_ITEMS` 消息处理 + alarm 定时执行 |
| `entrypoints/popup/store.ts` | 修改 | 新增 `copyMode`、`copySource`、`copyTaskStatus` 等状态和 actions |
| `components/product/CopyConfirmPanel.tsx` | **新建** | 复制确认面板（源活动信息、目标时间、模板选择） |
| `components/product/CopyResultPanel.tsx` | **新建** | 复制结果面板（成功/失败展示） |
| `entrypoints/popup/App.tsx` | 修改 | 新增复制模式的视图切换逻辑 |

---

### Task 1: 新增复制相关类型

**文件:** `entrypoints/popup/types.ts`

在文件末尾新增以下类型：

```typescript
// ===== 复制限时特卖相关类型 =====

export interface TimeSlot {
  timeslot_id: number;
  start_time: number;
  end_time: number;
}

export interface ScheduledCopyParams {
  sourceFlashSaleId: number;
  sourceFlashSaleName: string;
  targetStartTime: number;       // 用户选择的目标活动开始时间（Unix 秒）
  templateName: string | null;   // null = 不使用模板
  templateItems: EnableItem[] | null;
}

export interface CopyTaskStatus {
  scheduled: boolean;            // 是否有已调度的任务
  executed: boolean;             // 是否已执行
  success: boolean | null;       // null=待执行, true=成功, false=失败
  newFlashSaleId?: number;
  error?: string;
}
```

---

### Task 2: 新增 Background 消息处理

**文件:** `entrypoints/background.ts`

#### 2a. 在 `FLASH_SALE_API` 常量附近新增时间计算工具函数

```typescript
function getMonthEnd(): number {
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
  return Math.floor(endOfMonth.getTime() / 1000) - 1;
}
```

#### 2b. 在 `runtime.onMessage` 中新增以下 handlers（在 CLEAR_ENABLE_STATE 之前）：

```typescript
// ===== GET_TIME_SLOTS: 获取可用时间段 =====
if (type === 'GET_TIME_SLOTS') {
  try {
    const now = Math.floor(Date.now() / 1000);
    const startTime = now - 1800;
    const endTime = getMonthEnd();
    const data = await injectedFetch<any>(
      `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&start_time=${startTime}&end_time=${endTime}`
    );
    const list = Array.isArray(data?.data) ? data.data : [];
    return { success: true, timeSlots: list };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ===== CLOSE_FLASH_SALE: 关闭活动 =====
if (type === 'CLOSE_FLASH_SALE') {
  try {
    const { flashSaleId, timeSlotId } = msg;
    await injectedFetch(
      `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
      'POST',
      { flash_sale_id: flashSaleId, time_slot_id: timeSlotId, status: 2 }
    );
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ===== COPY_FLASH_SALE: 创建新活动 =====
if (type === 'COPY_FLASH_SALE') {
  try {
    const { timeSlotId } = msg;
    const data = await injectedFetch<any>(
      `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
      'POST',
      { time_slot_id: timeSlotId }
    );
    return { success: true, flashSaleId: data?.data?.flash_sale_id };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ===== APPLY_TEMPLATE_ITEMS: 应用模板并启用商品 =====
if (type === 'APPLY_TEMPLATE_ITEMS') {
  try {
    const { flashSaleId, items } = msg;
    const data = await injectedFetch<any>(
      `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
      'POST',
      { flash_sale_id: flashSaleId, items, use_global_category: true }
    );
    return { success: true, failedItems: data?.data?.failed_items || [] };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
```

**注意:** 所有 handler 都需要从 `msg` 中拿到 `spcCds` 和 `spcCdsVer`，或者通过 `browser.storage.local.get` 读取。

#### 2c. 新增 `chrome.alarms.onAlarm` 监听（用于定时执行复制）

```typescript
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'scheduled_copy') {
    console.log('[bg:scheduled_copy] 定时复制任务触发');
    try {
      const result = await browser.storage.local.get('_scheduledCopy');
      const params = result._scheduledCopy as ScheduledCopyParams | undefined;
      if (!params) return;

      // 步骤 1: 检查并关闭进行中的活动
      console.log('[bg:scheduled_copy] 步骤1: 检查进行中的活动');
      // ... 调用 get_shop_flash_sale_list/ 并关闭 status=1 的活动

      // 步骤 2: 获取时间段并创建新活动
      console.log('[bg:scheduled_copy] 步骤2: 创建新活动');
      // ... 调用 get_time_slot_id/ + set_shop_flash_sale/

      // 步骤 3: 应用模板（如有）
      if (params.templateItems?.length) {
        console.log('[bg:scheduled_copy] 步骤3: 应用模板');
        // ... 调用 set_shop_flash_sale_items/
      }

      // 保存执行结果
      await browser.storage.local.set({
        _copyTaskStatus: {
          scheduled: true,
          executed: true,
          success: true,
          newFlashSaleId: newId,
        },
      });

      // 清理定时参数
      await browser.storage.local.remove('_scheduledCopy');
    } catch (e: any) {
      console.error('[bg:scheduled_copy] 执行失败:', e);
      await browser.storage.local.set({
        _copyTaskStatus: {
          scheduled: true,
          executed: true,
          success: false,
          error: e.message,
        },
      });
    }
  }
});
```

---

### Task 3: 新增 Store 状态和 Actions

**文件:** `entrypoints/popup/store.ts`

#### 3a. 新增 state 字段

```typescript
interface AppState {
  // ...现有字段不变...

  // 复制功能状态
  copyMode: null | 'confirm' | 'result';
  copySource: { flashSale: FlashSale; itemCount: number } | null;
  copyTaskStatus: CopyTaskStatus | null;
  isCopying: boolean;
  savedTemplates: string[];
  selectedTemplate: string | null;
}
```

#### 3b. 新增初始值

```typescript
// 在 create<AppState> 的初始值中追加
copyMode: null,
copySource: null,
copyTaskStatus: null,
isCopying: false,
savedTemplates: [],
selectedTemplate: null,
```

#### 3c. 新增 actions

```typescript
// 进入复制模式
enterCopyMode: async (flashSale: FlashSale) => {
  const state = get();
  set({ copyMode: 'confirm', copySource: { flashSale, itemCount: 0 } });

  // 获取该活动的商品数量
  try {
    const resp = await browser.runtime.sendMessage({
      type: 'GET_FLASH_SALE_ITEM_COUNT',
      flashSaleId: flashSale.flash_sale_id,
    });
    if (resp?.itemCount !== undefined) {
      set({ copySource: { flashSale, itemCount: resp.itemCount } });
    }
  } catch {}

  // 加载模板列表
  const names = await get().getTemplateNames();
  set({ savedTemplates: names, selectedTemplate: names.length > 0 ? names[0] : null });
},

// 执行复制（一站式完成关闭+复制+模板）
executeCopy: async (targetTime: number, templateName: string | null) => {
  const state = get();
  if (!state.copySource) return;

  set({ isCopying: true, error: null });

  try {
    // 在 background 执行完整流程
    const resp = await browser.runtime.sendMessage({
      type: 'EXECUTE_COPY',
      sourceFlashSale: state.copySource.flashSale,
      targetTime,
      templateName,
    });

    if (resp?.success) {
      set({
        copyMode: 'result',
        isCopying: false,
        copyTaskStatus: {
          scheduled: true,
          executed: true,
          success: true,
          newFlashSaleId: resp.flashSaleId,
        },
      });
    } else {
      set({
        copyMode: 'result',
        isCopying: false,
        copyTaskStatus: {
          scheduled: true,
          executed: true,
          success: false,
          error: resp?.error || '执行失败',
        },
      });
    }
  } catch (e: any) {
    set({
      copyMode: 'result',
      isCopying: false,
      copyTaskStatus: {
        scheduled: true,
        executed: true,
        success: false,
        error: e.message,
      },
    });
  }

  // 刷新活动列表
  get().fetchFlashSaleList();
  get().saveCache();
},

// 退出复制模式
exitCopyMode: () => {
  set({
    copyMode: null,
    copySource: null,
    copyTaskStatus: null,
    isCopying: false,
  });
},

// 检查已有的复制任务状态
checkCopyTaskStatus: async () => {
  try {
    const result = await browser.storage.local.get('_copyTaskStatus');
    const status = result._copyTaskStatus as CopyTaskStatus | undefined;
    if (status) {
      set({ copyTaskStatus: status });
    }
  } catch {}
},

// 选择模板
setSelectedTemplate: (templateName: string | null) => {
  set({ selectedTemplate: templateName });
},
```

---

### Task 4: 创建 CopyConfirmPanel 组件

**文件:** `components/product/CopyConfirmPanel.tsx`

```tsx
import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FlashSale } from '@/entrypoints/popup/types';

interface CopyConfirmPanelProps {
  source: { flashSale: FlashSale; itemCount: number };
  savedTemplates: string[];
  selectedTemplate: string | null;
  isCopying: boolean;
  onConfirm: (targetTime: number, templateName: string | null) => void;
  onCancel: () => void;
  onSelectTemplate: (name: string | null) => void;
}

export function CopyConfirmPanel({
  source, savedTemplates, selectedTemplate,
  isCopying, onConfirm, onCancel, onSelectTemplate,
}: CopyConfirmPanelProps) {
  // 默认目标时间为当前下一个整点时间
  const defaultTime = (() => {
    const d = new Date();
    d.setHours(d.getHours() + 2, 0, 0, 0);
    return d.toISOString().slice(0, 16);
  })();
  const [targetDate, setTargetDate] = useState(defaultTime);

  const fmtTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const handleConfirm = () => {
    const t = new Date(targetDate);
    const unixTime = Math.floor(t.getTime() / 1000);
    if (unixTime <= Math.floor(Date.now() / 1000)) {
      alert('目标时间必须晚于当前时间');
      return;
    }
    onConfirm(unixTime, selectedTemplate);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <button className="text-primary hover:underline" onClick={onCancel}>← 返回活动列表</button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">复制限时特卖</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 源活动信息 */}
          <div className="text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">源活动:</span>
              <span className="font-medium">{source.flashSale.name || `活动 #${source.flashSale.flash_sale_id}`}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">活动时间:</span>
              <span>{fmtTime(source.flashSale.start_time)} ~ {fmtTime(source.flashSale.end_time)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">商品数量:</span>
              <span>{source.itemCount > 0 ? `${source.itemCount} 个` : '加载中...'}</span>
            </div>
          </div>

          {/* 目标时间 */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">目标活动时间</label>
            <Input
              type="datetime-local"
              value={targetDate}
              onChange={e => setTargetDate(e.target.value)}
              disabled={isCopying}
            />
            <p className="text-xs text-muted-foreground">系统将在开始前 5 分钟自动执行复制</p>
          </div>

          {/* 模板选择 */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">使用模板（可选）</label>
            {savedTemplates.length > 0 ? (
              <select
                className="w-full px-2 py-1.5 text-sm border rounded-md"
                value={selectedTemplate || ''}
                onChange={e => onSelectTemplate(e.target.value || null)}
                disabled={isCopying}
              >
                <option value="">不使用模板（沿用原活动配置）</option>
                {savedTemplates.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">暂无已保存的模板，将沿用源活动配置</p>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-2 pt-2">
            <Button variant="outline" className="flex-1" onClick={onCancel} disabled={isCopying}>
              取消
            </Button>
            <Button className="flex-1 bg-green-600 hover:bg-green-700" onClick={handleConfirm} disabled={isCopying}>
              {isCopying ? '⏳ 正在复制...' : '确认复制'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

---

### Task 5: 创建 CopyResultPanel 组件

**文件:** `components/product/CopyResultPanel.tsx`

```tsx
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { CopyTaskStatus } from '@/entrypoints/popup/types';

interface CopyResultPanelProps {
  status: CopyTaskStatus;
  onBack: () => void;
  onRetry?: () => void;
}

export function CopyResultPanel({ status, onBack, onRetry }: CopyResultPanelProps) {
  if (status.success) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-green-700">✅ 复制成功！</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            <p>新活动 ID: {status.newFlashSaleId}</p>
            <p className="mt-1">提示: 活动开始后，可手动点击「开启限时特卖」处理失败 SKU</p>
          </div>
          <Button className="w-full" onClick={onBack}>返回活动列表</Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-red-700">❌ 复制失败</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">
          {status.error || '未知错误'}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onBack}>返回</Button>
          {onRetry && <Button className="flex-1" onClick={onRetry}>重试</Button>}
        </div>
      </CardContent>
    </Card>
  );
}
```

---

### Task 6: 修改 App.tsx 集成复制面板

**文件:** `entrypoints/popup/App.tsx`

在现有 App.tsx 中，在 `flashSaleList` 的每个活动项按钮内新增「复制」按钮，并增加视图切换逻辑。

关键变更点：

1. 从 store 获取新增状态：
```typescript
const {
  copyMode, copySource, copyTaskStatus, isCopying,
  savedTemplates, selectedTemplate,
  enterCopyMode, executeCopy, exitCopyMode, checkCopyTaskStatus, setSelectedTemplate,
  // ...现有
} = useAppStore();
```

2. 在 `useEffect` 中增加 `checkCopyTaskStatus()` 调用

3. 在 `flashSaleList` 的每个活动项中增加「复制」按钮：
```tsx
<button
  className="text-xs text-primary hover:underline shrink-0"
  onClick={e => {
    e.stopPropagation();
    enterCopyMode(sale);
  }}
>
  复制
</button>
```

4. 在 JSX 底部（或 CardContent 内）增加视图切换：
```tsx
{/* 复制模式视图切换 */}
{copyMode === 'confirm' && copySource && (
  <CopyConfirmPanel
    source={copySource}
    savedTemplates={savedTemplates}
    selectedTemplate={selectedTemplate}
    isCopying={isCopying}
    onConfirm={(time, template) => executeCopy(time, template)}
    onCancel={exitCopyMode}
    onSelectTemplate={setSelectedTemplate}
  />
)}

{copyMode === 'result' && copyTaskStatus && (
  <CopyResultPanel
    status={copyTaskStatus}
    onBack={exitCopyMode}
    onRetry={() => {/* 重新执行 */}}
  />
)}
```

5. 在需要隐藏现有内容的区域增加条件判断：`{copyMode === null && (...现有内容...)}` 或根据 `copyMode` 显示不同的内容区块。

---

### Task 7: 实现 Background 端一站式复制执行

**文件:** `entrypoints/background.ts`

新增 `EXECUTE_COPY` 消息 handler，整合关闭旧活动、获取时间段、创建新活动、应用模板的完整流程：

```typescript
// ===== EXECUTE_COPY: 一站式复制执行 =====
if (type === 'EXECUTE_COPY') {
  try {
    const { sourceFlashSale, targetTime, templateName, products, spcCds, spcCdsVer, skuOverrides, discountRate, flashSaleStock, purchaseLimit } = msg;

    // 步骤 1: 获取 SPC_CDS
    const cds = spcCds || (await getSpcCds());
    const cdsVer = spcCdsVer || '2';

    // 步骤 2: 检查并关闭进行中的活动
    const listData = await injectedFetch<any>(
      `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}&offset=0&limit=50&type=0`
    );
    const activeSales = (listData?.data?.flash_sale_list || []).filter((s: any) => s.status === 1);
    for (const sale of activeSales) {
      console.log(`[bg:executeCopy] 关闭进行中活动: ${sale.flash_sale_id}`);
      await injectedFetch(
        `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}`,
        'POST',
        { flash_sale_id: sale.flash_sale_id, time_slot_id: sale.timeslot_id, status: 2 }
      );
    }

    // 步骤 3: 获取可用时间段（目标时间前 30min 容差）
    const startTime = targetTime - 1800;
    const endTime = getMonthEnd();
    const tsData = await injectedFetch<any>(
      `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}&start_time=${startTime}&end_time=${endTime}`
    );
    const timeSlots = Array.isArray(tsData?.data) ? tsData.data : [];
    // 找到最接近目标时间的时段
    let bestSlot = timeSlots[0];
    for (const slot of timeSlots) {
      if (!bestSlot || Math.abs(slot.start_time - targetTime) < Math.abs(bestSlot.start_time - targetTime)) {
        bestSlot = slot;
      }
    }
    if (!bestSlot) throw new Error('没有可用的时间段');

    // 步骤 4: 创建新活动
    const createData = await injectedFetch<any>(
      `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}`,
      'POST',
      { time_slot_id: bestSlot.timeslot_id }
    );
    const newFlashSaleId = createData?.data?.flash_sale_id;
    if (!newFlashSaleId) throw new Error('创建活动失败');

    // 步骤 5: 应用模板（如有）
    if (templateName && products?.length) {
      // 从 storage 读取模板
      const tResult = await browser.storage.local.get('flashSaleTemplates');
      const templates = tResult.flashSaleTemplates || {};
      const template = templates[templateName];
      if (template) {
        const items = products.flatMap((p: any) =>
          (p.modelList || []).filter((sku: any) => (sku.normalStock || 0) > 0).map((sku: any) => {
            const key = `${p.itemid}-${sku.modelid}`;
            const override = skuOverrides?.[key];
            const usedDiscount = override?.discountRate ?? template.discountRate;
            const usedStock = Math.min(override?.stock ?? template.flashSaleStock, sku.normalStock || template.flashSaleStock);
            const usedPurchaseLimit = override?.purchaseLimit ?? template.purchaseLimit;
            const promoPrice = Math.floor(Number(sku.originPrice || p.originPrice || 0) * usedDiscount / 100);
            return {
              item_id: Number(p.itemid),
              status: 1,
              model_id: Number(sku.modelid),
              item_display_image: p.images?.[0] || '',
              input_promo_price: promoPrice,
              stock: usedStock,
              purchase_limit: usedPurchaseLimit,
            };
          })
        );

        if (items.length > 0) {
          await injectedFetch(
            `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}`,
            'POST',
            { flash_sale_id: newFlashSaleId, items, use_global_category: true }
          );
        }
      }
    }

    console.log(`[bg:executeCopy] ✅ 复制完成: ${newFlashSaleId}`);
    return { success: true, flashSaleId: newFlashSaleId };
  } catch (e: any) {
    console.error('[bg:executeCopy] ❌ 复制失败:', e);
    return { success: false, error: e.message };
  }
}
```

需要新增工具函数 `getSpcCds()` 或从 `msg` 中直接传入（由 popup store 传递）。

---

## 执行顺序建议

建议按以下顺序逐步实现：

```
Task 1 (types) → Task 2 (background handlers)
              → Task 3 (store actions)
              → Task 4 + Task 5 (components, 可并行)
              → Task 6 (App.tsx 集成)
              → Task 7 (一站式执行)

每个 Task 完成后验证 build 通过 (npm run build)
```

---

## 验证方式

1. `npm run build` — 编译通过
2. 加载扩展到 Chrome
3. 打开 seller.shopee.tw → 打开扩展 Popup
4. 点击活动列表中的「复制」→ 进入确认面板
5. 设置目标时间 → 选择模板 → 点击确认复制
6. 观察是否成功创建新活动
7. 检查新活动中的商品是否正确复制
