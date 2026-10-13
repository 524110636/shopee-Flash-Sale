import { describe, it, expect } from 'vitest';
import {
  ONE_DAY_REPAIR_TASK_KEY,
  ONE_DAY_REPAIR_HEARTBEAT_KEY,
  ONE_DAY_REPAIR_APPLIED_KEY,
  ONE_DAY_REPAIR_REQUEST_KEY,
  buildRepairSummary,
  canAdvanceTask,
  createRepairTask,
  fingerprintCredential,
  isRepairResultReady,
  isRepairTaskActive,
  isSameOwner,
  verifyRepairOwner,
  buildRepairDiagnostic,
  redactDiagnosticReason,
  isTerminalRepairStatus,
  itemsWithSentWrites,
  patchRepairTask,
  resolveOrphanedTask,
  shouldApplyRepairResult,
} from '@/entrypoints/popup/one-day-sku-task';
import { buildInitialItems, resolveDiscountRate } from '@/entrypoints/popup/one-day-sku-runner';
import type { OneDayRepairTask, OneDaySkuItemStatus, ShopeeProduct } from '@/entrypoints/popup/types';

function makeProduct(itemid: string, name = `商品 ${itemid}`): ShopeeProduct {
  return {
    itemid,
    name,
    images: [],
    variationImages: [],
    transparentBackgroundImage: '',
    status: 0,
    inputOriginPrice: '100',
    originPrice: '100',
    normalStock: 10,
    localPrice: '0',
    pffTag: false,
    normalSellerStock: 10,
    normalWmsStock: 0,
    minPurchaseLimit: 1,
    itemSellerSellableStock: 10,
    itemWmsSellableStock: 0,
    itemTotalReservedStock: 0,
    itemNormalStock: 10,
    modelList: [],
  };
}

function makeTask(products: ShopeeProduct[], now = 1_700_000_000_000): OneDayRepairTask {
  return createRepairTask({
    taskId: 'odr-1',
    requestId: 'odr-1',
    source: 'manual-selection',
    shopId: 12345,
    ownerUserId: 7,
    spcCds: 'spc-secret-value',
    products,
    initialItems: buildInitialItems(products),
    now,
  });
}

describe('repair task 持久契约', () => {
  it('接受记录先于写请求，初始状态不是终态', () => {
    const task = makeTask([makeProduct('1'), makeProduct('2')]);
    expect(task.status).toBe('accepted');
    expect(task.writeStarted).toBe(false);
    expect(isTerminalRepairStatus(task.status)).toBe(false);
    expect(isRepairTaskActive(task)).toBe(true);
    expect(task.checkpoints).toEqual([]);
  });

  it('只用专用键保存一份当前/最近任务，心跳与已应用标记各自独立', () => {
    expect(ONE_DAY_REPAIR_TASK_KEY).toBe('_oneDaySkuRepairTask');
    expect(ONE_DAY_REPAIR_HEARTBEAT_KEY).toBe('_oneDaySkuRepairHeartbeat');
    expect(ONE_DAY_REPAIR_APPLIED_KEY).toBe('_oneDaySkuRepairApplied');
    expect(ONE_DAY_REPAIR_REQUEST_KEY).toBe('_oneDaySkuRepairRequest');
    // 心跳与标记不能和任务记录同键，否则会互相覆盖
    expect(new Set([
      ONE_DAY_REPAIR_TASK_KEY,
      ONE_DAY_REPAIR_HEARTBEAT_KEY,
      ONE_DAY_REPAIR_APPLIED_KEY,
      ONE_DAY_REPAIR_REQUEST_KEY,
    ]).size).toBe(4);
  });

  it('记录里不出现原始凭据', () => {
    const task = makeTask([makeProduct('1')]);
    const serialized = JSON.stringify(task);
    expect(serialized).not.toContain('spc-secret-value');
    expect(task.spcCdsFingerprint).toBe(fingerprintCredential('spc-secret-value'));
    expect(task.spcCdsFingerprint.length).toBe(8);
  });

  it('写请求发出前先落检查点，并永久标记 writeStarted', () => {
    let task = makeTask([makeProduct('1')]);
    task = patchRepairTask(task, {
      checkpoint: { itemId: '1', step: 'delete_abnormal_seller_discount_items', writeSent: true, at: 1 },
      at: 1,
    });
    expect(task.writeStarted).toBe(true);
    expect(itemsWithSentWrites(task)).toEqual(['1']);
    // 之后只更新进度不会把 writeStarted 回退
    task = patchRepairTask(task, { currentIndex: 1, at: 2 });
    expect(task.writeStarted).toBe(true);
    expect(task.checkpoints).toHaveLength(1);
  });

  it('检查点序号单调递增，便于判断新旧', () => {
    let task = makeTask([makeProduct('1')]);
    task = patchRepairTask(task, { checkpoint: { itemId: '1', step: 'a', writeSent: true, at: 1 }, at: 1 });
    task = patchRepairTask(task, { checkpoint: { itemId: '1', step: 'b', writeSent: false, at: 2 }, at: 2 });
    expect(task.checkpoints.map(c => c.seq)).toEqual([1, 2]);
    // 未发出的请求不算「可能已改动」
    expect(itemsWithSentWrites(task)).toEqual(['1']);
  });
});

describe('孤儿任务协调（worker 意外重启）', () => {
  it('无执行者且没有心跳时标记为真实中断', () => {
    const task = patchRepairTask(makeTask([makeProduct('1')]), { status: 'running', at: 2 });
    const resolved = resolveOrphanedTask(task, false, null);
    expect(resolved?.status).toBe('interrupted');
    expect(resolved?.phase).toBe('interrupted');
  });

  it('BR5 即使心跳新鲜，只要本实例没有执行者就判定中断（不依赖等心跳过期）', () => {
    const now = 1_800_000_000_000;
    const task = patchRepairTask(makeTask([makeProduct('1')], now), { status: 'running', at: now });
    // 心跳刚写过，但没有任何活跃执行者 —— 必须立刻判中断，否则等待依赖的 timer 会被 worker 回收
    const resolved = resolveOrphanedTask(task, false, { taskId: task.taskId, at: now }, now);
    expect(resolved?.status).toBe('interrupted');
    // 心跳作为证据保留，便于用户核对
    expect(resolved?.heartbeatAt).toBe(now);
  });

  it('BR5 心跳属于别的任务时不影响判定', () => {
    const now = 1_800_000_000_000;
    const task = patchRepairTask(makeTask([makeProduct('1')], now), { status: 'running', at: now });
    const resolved = resolveOrphanedTask(task, false, { taskId: 'odr-other-task', at: now }, now);
    expect(resolved?.status).toBe('interrupted');
    expect(resolved?.heartbeatAt).toBeNull();
  });

  it('有执行者的记录保持原样，不误报中断', () => {
    const task = patchRepairTask(makeTask([makeProduct('1')]), { status: 'running', at: 2 });
    expect(resolveOrphanedTask(task, true, null)?.status).toBe('running');
  });

  it('终态记录不被改写', () => {
    const task = patchRepairTask(makeTask([makeProduct('1')]), { status: 'completed', at: 2 });
    expect(resolveOrphanedTask(task, false, null)?.status).toBe('completed');
  });

  it('未发出写请求的中断说明「可安全重跑」，已发出的提示需核对', () => {
    const clean = resolveOrphanedTask(
      patchRepairTask(makeTask([makeProduct('1')]), { status: 'running', at: 2 }),
      false,
      null,
    );
    expect(clean?.message).toContain('尚未发出任何商品写请求');

    let dirty = patchRepairTask(makeTask([makeProduct('1')]), { status: 'running', at: 2 });
    dirty = patchRepairTask(dirty, {
      checkpoint: { itemId: '1', step: 'update_product_info', writeSent: true, at: 3 },
      at: 3,
    });
    const resolved = resolveOrphanedTask(dirty, false, null);
    expect(resolved?.message).toContain('可能已被修改');
    // 不自动重放：状态只能是 interrupted，不会回到 running
    expect(resolved?.status).toBe('interrupted');
  });
});

describe('BR5 状态防回退', () => {
  it('终态记录不会被非终态写入拉回', () => {
    const done = patchRepairTask(makeTask([makeProduct('1')]), { status: 'completed', at: 2 });
    const stale = { ...done, status: 'running' as const, revision: done.revision + 1 };
    expect(canAdvanceTask(done, stale)).toBe(false);
  });

  it('版本号更旧的写入被拒绝', () => {
    const task = { ...patchRepairTask(makeTask([makeProduct('1')]), { status: 'running', at: 2 }), revision: 5 };
    const older = { ...task, revision: 4 };
    expect(canAdvanceTask(task, older)).toBe(false);
    const newer = { ...task, revision: 6 };
    expect(canAdvanceTask(task, newer)).toBe(true);
  });
});

describe('结果幂等应用', () => {
  const completedTask = (withModels: boolean) => {
    const items = buildInitialItems([makeProduct('1')]).map(i => ({ ...i, publishStatus: 'success' as const }));
    const task = patchRepairTask(makeTask([makeProduct('1')]), {
      status: 'completed',
      phase: 'editing_params',
      items,
      at: 2,
    });
    const product = makeProduct('1');
    return {
      ...task,
      resultProducts: withModels
        ? [{ ...product, modelList: [{ modelid: '5001', name: '默认' } as any] }]
        : [],
    };
  };

  it('未应用过、归属一致且结果就绪时才套用', () => {
    const task = completedTask(true);
    expect(
      shouldApplyRepairResult({ task, appliedMarker: null, ownerMatches: true, resultReady: true }),
    ).toBe(true);
  });

  it('BR3 已应用标记存在时不再套用（标记来自独立键，不依赖 popup 内存 taskId）', () => {
    const task = completedTask(true);
    expect(
      shouldApplyRepairResult({ task, appliedMarker: { taskId: task.taskId, at: 1 }, ownerMatches: true, resultReady: true }),
    ).toBe(false);
  });

  it('BR3 归属不符时不套用（外店/外账号结果不得覆盖本店编辑）', () => {
    const task = completedTask(true);
    expect(
      shouldApplyRepairResult({ task, appliedMarker: null, ownerMatches: false, resultReady: true }),
    ).toBe(false);
  });

  it('BR3 结果未就绪时不套用，也不放行下一步', () => {
    const task = completedTask(false);
    expect(
      shouldApplyRepairResult({ task, appliedMarker: null, ownerMatches: true, resultReady: false }),
    ).toBe(false);
    expect(isRepairResultReady(task)).toBe(false);
    expect(isRepairResultReady(completedTask(true))).toBe(true);
  });

  it('未完成的任务不套用结果', () => {
    const task = patchRepairTask(makeTask([makeProduct('1')]), { status: 'running', at: 2 });
    expect(
      shouldApplyRepairResult({ task, appliedMarker: null, ownerMatches: true, resultReady: true }),
    ).toBe(false);
  });
});

describe('归属核对（切店/切账号即停止新写请求）', () => {
  it('店铺或账号不一致时判为不同归属', () => {
    const task = makeTask([makeProduct('1')]);
    expect(isSameOwner(task, 12345, 7, 'spc-secret-value')).toBe(true);
    expect(isSameOwner(task, 999, 7, 'spc-secret-value')).toBe(false);
    expect(isSameOwner(task, 12345, 8, 'spc-secret-value')).toBe(false);
    expect(isSameOwner(task, 12345, 7, 'another-credential')).toBe(false);
  });

  it('BR1 核实不到实际店铺（null）时不得当作一致', () => {
    const task = makeTask([makeProduct('1')]);
    expect(isSameOwner(task, null, 7, 'spc-secret-value')).toBe(false);
  });

  // BR1 第二轮：任务记了账号而当前取不到（登出/切换中）也必须是"不一致"。
  it('BR1 任务记了账号但当前读不到账号时不得当作一致', () => {
    const task = { ...makeTask([makeProduct('1')]), ownerUserId: 7 };
    expect(isSameOwner(task, 777, null, 'spc-secret-value')).toBe(false);
  });

  it('BR1 任务未记账号时不因读取不到账号判不一致', () => {
    const task = { ...makeTask([makeProduct('1')]), ownerUserId: null };
    expect(isSameOwner(task, 12345, null, 'spc-secret-value')).toBe(true);
  });
});

describe('结果就绪判定（BR3 复验：旧模型不得冒充修复结果）', () => {
  const withDedicatedSku = (itemId: string) => ({
    ...makeProduct(itemId),
    modelList: [
      { modelid: '5001', name: '默认', originPrice: '1000', normalStock: 10, totalNormalStock: 10 },
      { modelid: '5002', name: '批發客戶下訂-請勿下單', originPrice: '1000', normalStock: 10, totalNormalStock: 10 },
    ],
  });
  const oldOnlyModels = (itemId: string) => ({
    ...makeProduct(itemId),
    modelList: [{ modelid: '5001', name: '默认', originPrice: '1000', normalStock: 10, totalNormalStock: 10 }],
  });

  function completedTask(items: OneDaySkuItemStatus[], resultProducts: ShopeeProduct[] = []): OneDayRepairTask {
    const base = makeTask([makeProduct('1001')]);
    return { ...base, status: 'completed', phase: 'editing_params', items, resultProducts } as OneDayRepairTask;
  }
  const newSkuItem = (over: Partial<OneDaySkuItemStatus> = {}): OneDaySkuItemStatus => ({
    itemId: '1001',
    itemName: '商品',
    hasOneDaySku: false,
    skuCreated: true,
    publishStatus: 'success',
    discountRemoved: false,
    discountRestored: false,
    flashSaleStatus: 'idle',
    ...over,
  });

  it('本次新建 SKU 但读到的仍是修复前的旧模型 → 不就绪', () => {
    const task = completedTask([newSkuItem()]);
    expect(isRepairResultReady(task, [oldOnlyModels('1001')] as ShopeeProduct[])).toBe(false);
  });

  it('本次新建 SKU 且读到了新增的专用 SKU → 就绪', () => {
    const task = completedTask([newSkuItem()]);
    expect(isRepairResultReady(task, [withDedicatedSku('1001')] as ShopeeProduct[])).toBe(true);
  });

  it('任务结果里已带新增 SKU 时也视为就绪（无需 popup 再取）', () => {
    const task = completedTask([newSkuItem()], [withDedicatedSku('1001')] as ShopeeProduct[]);
    expect(isRepairResultReady(task)).toBe(true);
  });

  it('修复前本来就有 1 天 SKU：有模型即就绪，不因没有"新建"标记被挡', () => {
    const task = completedTask([newSkuItem({ skuCreated: false, hasOneDaySku: true })]);
    expect(isRepairResultReady(task, [oldOnlyModels('1001')] as ShopeeProduct[])).toBe(true);
  });

  it('两处都读不到模型 → 不就绪，且不提前放行', () => {
    const task = completedTask([newSkuItem()]);
    expect(isRepairResultReady(task, [])).toBe(false);
  });

  it('BR1 任务未记录店铺时才不因店铺判不一致', () => {
    const task = { ...makeTask([makeProduct('1')]), shopId: null };
    expect(isSameOwner(task, null, 7, 'spc-secret-value')).toBe(true);
    expect(isSameOwner(task, 777, 7, 'spc-secret-value')).toBe(true);
  });
});

describe('界面归属判定（区分"确认不一致"与"还没核实到"）', () => {
  it('身份已就绪且一致 → match', () => {
    const task = makeTask([makeProduct('1')]);
    expect(verifyRepairOwner(task, 12345, 7, 'spc-secret-value')).toBe('match');
  });

  it('店铺身份还没取到 → unknown（冷打开时不能当成不一致）', () => {
    const task = makeTask([makeProduct('1')]);
    expect(verifyRepairOwner(task, null, null, 'spc-secret-value')).toBe('unknown');
  });

  it('确认是别的店铺/账号/凭据 → mismatch', () => {
    const task = makeTask([makeProduct('1')]);
    expect(verifyRepairOwner(task, 999, 7, 'spc-secret-value')).toBe('mismatch');
    expect(verifyRepairOwner(task, 12345, 8, 'spc-secret-value')).toBe('mismatch');
    expect(verifyRepairOwner(task, 12345, 7, 'another-credential')).toBe('mismatch');
  });

  it('任务未记录店铺时，身份未知也不影响界面套用', () => {
    const task = { ...makeTask([makeProduct('1')]), shopId: null };
    expect(verifyRepairOwner(task, null, 7, 'spc-secret-value')).toBe('match');
  });

  // 界面判定也要区分「账号还没读回来」和「确认是别人」
  it('账号还没取到时是 unknown，不是 mismatch', () => {
    const task = { ...makeTask([makeProduct('1')]), ownerUserId: 7 };
    expect(verifyRepairOwner(task, 12345, null, 'spc-secret-value')).toBe('unknown');
    expect(verifyRepairOwner(task, 12345, 8, 'spc-secret-value')).toBe('mismatch');
  });
});

describe('诊断记录脱敏（BR 第二轮要求的最小错误捕获）', () => {
  it('原因里的凭据一律打码', () => {
    const redacted = redactDiagnosticReason(
      '请求 https://seller.shopee.tw/api/x?SPC_CDS=abc123def&SPC_CDS_VER=2 失败 token=secret-token',
    );
    expect(redacted).not.toContain('abc123def');
    expect(redacted).not.toContain('secret-token');
    expect(redacted).toContain('SPC_CDS=***');
  });

  it('Bearer 与 JSON 里的凭据字段同样打码', () => {
    expect(redactDiagnosticReason('Authorization: Bearer eyJhbGciOi.abc.def')).not.toContain('eyJhbGciOi');
    expect(redactDiagnosticReason('{"spcCds":"realvalue","token":"t0ken"}')).not.toContain('realvalue');
    expect(redactDiagnosticReason('{"spcCds":"realvalue","token":"t0ken"}')).not.toContain('t0ken');
  });

  it('不含凭据的文案原样保留，且长度有界', () => {
    expect(redactDiagnosticReason('当前店铺或账号与任务归属不一致')).toBe('当前店铺或账号与任务归属不一致');
    expect(redactDiagnosticReason('x'.repeat(2000)).length).toBe(500);
  });

  it('诊断记录只含定位字段，不含凭据', () => {
    const diag = buildRepairDiagnostic({
      kind: 'ownership-stopped',
      taskId: 't1',
      requestId: 'r1',
      phase: 'publishing_product',
      taskShopId: 777,
      taskOwnerUserId: 1,
      actualShopId: 888,
      actualUserId: 2,
      reason: '账号变更 SPC_CDS=abcd1234',
      confirmedActions: ['1001: 已从折扣活动移除商品'],
      unknownActions: [],
      at: 1,
    });
    expect(JSON.stringify(diag)).not.toContain('abcd1234');
    expect(diag.actualShopId).toBe(888);
    expect(diag.actualUserId).toBe(2);
    expect(diag.taskShopId).toBe(777);
  });
});

describe('首页修复摘要', () => {
  it('运行中显示进度且可查看', () => {
    const task = patchRepairTask(makeTask([makeProduct('1'), makeProduct('2')]), {
      status: 'running',
      currentIndex: 1,
      message: '正在优化商品 (1/2)...',
      at: 2,
    });
    const summary = buildRepairSummary(task);
    expect(summary?.title).toBe('商品修复中');
    expect(summary?.detail).toContain('1/2');
    expect(summary?.tone).toBe('running');
  });

  it('中断显示「可能已被修改」，不谎称成功', () => {
    let task = patchRepairTask(makeTask([makeProduct('1')]), { status: 'running', at: 2 });
    task = patchRepairTask(task, {
      checkpoint: { itemId: '1', step: 'update_product_info', writeSent: true, at: 3 },
      at: 3,
    });
    const summary = buildRepairSummary(resolveOrphanedTask(task, false, null));
    expect(summary?.title).toBe('商品修复已中断');
    expect(summary?.detail).toContain('可能已被修改');
    expect(summary?.tone).toBe('interrupted');
  });

  it('完成待编辑时给出继续编辑入口', () => {
    const items = buildInitialItems([makeProduct('1')]).map(i => ({ ...i, publishStatus: 'success' as const }));
    const task = patchRepairTask(makeTask([makeProduct('1')]), {
      status: 'completed',
      phase: 'editing_params',
      items,
      at: 2,
    });
    const summary = buildRepairSummary(task);
    expect(summary?.title).toBe('修复完成，待编辑参数');
    expect(summary?.actionLabel).toBe('继续编辑');
    expect(summary?.tone).toBe('done');
  });

  it('没有任务时不编造摘要', () => {
    expect(buildRepairSummary(null)).toBeNull();
  });
});

describe('折扣率计算与旧行为一致', () => {
  it('同值直接取，不同值取平均后四舍五入', () => {
    expect(resolveDiscountRate([0.6, 0.6])).toBe(60);
    expect(resolveDiscountRate([0.5, 0.6])).toBe(55);
    expect(resolveDiscountRate([])).toBeNull();
  });
});
