/**
 * 后台一键修复 runner 的隔离单测：用注入的假 deps 覆盖真实执行路径。
 *
 * 不联网、不碰 storage、不开浏览器，因此可以稳定地验证：
 * - 逐商品失败不中断其他商品；
 * - 保存进度失败即停止后续写请求（B9）；
 * - 已有 1 天 SKU 跳过发布、100 SKU 上限、5 倍价格重试分支（B6）；
 * - 折扣部分恢复失败仍保留失败详情，不冒充全部成功（B6）；
 * - 每个关键写请求前都落了检查点（B8 的基础）。
 */
import { describe, it, expect } from 'vitest';
import {
  RepairCheckpointSaveError,
  RepairOwnershipError,
  RepairStaleWriteError,
  buildInitialItems,
  runOneDaySkuRepairTask,
} from '@/entrypoints/popup/one-day-sku-runner';
import { createRepairTask } from '@/entrypoints/popup/one-day-sku-task';
import type { OneDayRepairTask, ShopeeProduct } from '@/entrypoints/popup/types';

function makeProduct(itemid: string, models = 1): ShopeeProduct {
  return {
    itemid,
    name: `商品 ${itemid}`,
    images: [],
    variationImages: [],
    transparentBackgroundImage: '',
    status: 0,
    inputOriginPrice: '1000',
    originPrice: '1000',
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
    modelList: Array.from({ length: models }, (_, i) => ({
      modelid: String(5000 + i),
      name: `规格${i}`,
      inputOriginPrice: '1000',
      originPrice: '1000',
      normalStock: 10,
      localPrice: '0',
      pffTag: false,
      normalSellerStock: 10,
      normalWmsStock: 0,
      modelNormalStock: 10,
      modelSellerSellableStock: 10,
      modelWmsSellableStock: 0,
      modelTotalReservedStock: 0,
      enableShopFlashSaleNewStock: false,
      totalNormalStock: 10,
    })),
  };
}

/** 无规格商品的 product_info（无 tier 规格，走 name 匹配分支） */
function noTierProductInfo(existingOneDay = false) {
  return {
    code: 0,
    data: {
      product_info: {
        model_list: [
          {
            id: 5001,
            name: existingOneDay ? '批發客戶下訂-請勿下單' : '默认规格',
            price_info: { input_normal_price: 1000, input_promotion_price: 800 },
            stock_setting_list: [{ sellable_stock: 10 }],
            ...(existingOneDay ? { pre_order_info: { days_to_ship: 1, pre_order: false } } : {}),
          },
        ],
      },
    },
  };
}

function makeTask(products: ShopeeProduct[]): OneDayRepairTask {
  return createRepairTask({
    taskId: 'odr-unit',
    requestId: 'odr-unit',
    source: 'manual-selection',
    shopId: 777,
    ownerUserId: 1,
    spcCds: 'iso-credential',
    products,
    initialItems: buildInitialItems(products),
    now: 1_700_000_000_000,
  });
}

/**
 * 造一套假 deps。
 * `calls` 记录所有店铺写请求，用来断言副作用次数与是否被提前停止。
 */
function makeDeps(options: {
  productInfos: Record<string, any>;
  discounts?: Record<string, any>;
  publishResult?: (itemId: number, attempt: number) => { code: number; msg?: string };
  restoreResult?: Record<string, any>;
  failSaveAfter?: number;
  /** 模拟实际核实到的店铺；null 表示核实不到 */
  actualShopId?: number | null;
  /** 模拟当前认证的后端账号 */
  authUserId?: number | null;
  /**
   * 按顺序返回的认证账号：用于模拟「修复进行中换号/登出」。
   * 最后一次之后一直返回最后一项（null 表示登出）。
   */
  authUserIdSequence?: (number | null)[];
  /** 每次写请求前改一次店铺，用于模拟同一商品处理期间切店 */
  switchShopAfterRemove?: number;
  /** 模拟权威记录被别的实例标记为终态/中断（BR5 迟到写入） */
  authoritativeStatus?: OneDayRepairTask['status'];
}) {
  const calls: string[] = [];
  const saved: OneDayRepairTask[] = [];
  const publishAttempts: Record<string, number> = {};
  /** 记录所有副作用发生的顺序（含等待），用于核对业务顺序 */
  const order: string[] = [];
  let actualShopId = options.actualShopId === undefined ? 777 : options.actualShopId;
  let authSeqIndex = 0;

  const deps = {
    injectedFetch: async (url: string, _method: string = 'GET', body?: any) => {
      if (url.includes('/product/get_product_info')) {
        const id = new URL(url).searchParams.get('product_id') ?? '';
        return options.productInfos[id];
      }
      if (url.includes('/discount/search/')) {
        const keyword = String(body?.keyword);
        return options.discounts?.[keyword] ?? { code: 0, data: { discounts: [] } };
      }
      if (url.includes('/discount/delete_abnormal_seller_discount_items/')) {
        const itemId = String(body.item_id_list?.[0]);
        calls.push(`removeDiscount:${itemId}`);
        order.push('remove');
        if (options.switchShopAfterRemove !== undefined) {
          actualShopId = options.switchShopAfterRemove;
        }
        return { error: 0 };
      }
      if (url.includes('/discount/update_seller_discount_items/')) {
        calls.push(`restoreDiscount`);
        order.push('restore');
        const itemId = String(body.discount_model_list?.[0]?.item_id);
        return options.restoreResult?.[itemId] ?? { error: 0, data: { total_count: 1, success_count: 1, failed_item_list: [], error_list: [] } };
      }
      if (url.includes('/product/update_product_info')) {
        const itemId = String(body.product_id);
        calls.push(`publish:${itemId}`);
        order.push('publish');
        publishAttempts[itemId] = (publishAttempts[itemId] ?? 0) + 1;
        return options.publishResult?.(Number(itemId), publishAttempts[itemId]) ?? { code: 0 };
      }
      return { code: 0, data: {} };
    },
    getCredential: async () => ({ spcCds: 'iso-credential', spcCdsVer: '2' }),
    getShopIdentity: async () => ({ shopId: actualShopId, accountId: 1 }),
    getAuthUserId: async () => {
      if (options.authUserIdSequence?.length) {
        const idx = authSeqIndex < options.authUserIdSequence.length ? authSeqIndex : options.authUserIdSequence.length - 1;
        authSeqIndex += 1;
        return options.authUserIdSequence[idx];
      }
      return options.authUserId === undefined ? 1 : options.authUserId;
    },
    fetchProductsByIds: async (ids: string[]) => ids.map(id => makeProduct(id)),
    now: () => 1_700_000_000_000,
    sleep: async (ms: number) => {
      order.push(`sleep:${ms}`);
    },
    saveTask: async (task: OneDayRepairTask) => {
      saved.push(task);
      if (options.failSaveAfter !== undefined && saved.length > options.failSaveAfter) {
        throw new Error('storage quota exceeded');
      }
    },
    startKeepalive: () => {},
    stopKeepalive: () => {},
  };
  if (options.authoritativeStatus) {
    // 权威记录已经是终态：runner 的任何后续写入都必须放弃
    (deps as any).loadTask = async () => ({
      ...makeTask([makeProduct('1001')]),
      status: options.authoritativeStatus!,
      phase: options.authoritativeStatus === 'interrupted' ? 'interrupted' : 'completed',
    });
  }
  return { deps, calls, saved, order, publishAttempts: () => publishAttempts };
}

const DISCOUNT_OK = { code: 0, data: { discounts: [{ seller_discount: { discount_id: 99, name: '折扣A', time_status: 2, end_time: 4102444800 } }] } };

describe('runner 基本行为', () => {
  it('无规格商品：新增 SKU 成功并停在待编辑，不创建活动', async () => {
    const product = makeProduct('1001');
    const { deps, calls } = makeDeps({ productInfos: { 1001: noTierProductInfo() } });
    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.status).toBe('completed');
    expect(final.phase).toBe('editing_params');
    expect(final.items[0].publishStatus).toBe('success');
    expect(final.items[0].skuCreated).toBe(true);
    expect(calls).toEqual(['publish:1001']);
    // 未创建/开启活动
    expect(calls.some(c => c.includes('set_shop_flash_sale'))).toBe(false);
  });

  it('已有 1 天备货 SKU：跳过发布，仍算可继续', async () => {
    const product = makeProduct('1002');
    const { deps, calls } = makeDeps({ productInfos: { 1002: noTierProductInfo(true) } });
    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('success');
    expect(final.items[0].hasOneDaySku).toBe(true);
    expect(final.items[0].skuCreated).toBe(false);
    expect(calls).toEqual([]);
  });

  it('100 SKU 上限：超限时报错且不发布', async () => {
    const product = makeProduct('1003');
    // 构造 100 个已有 SKU 且有规格分层的详情，迫使新增后超限
    const models = Array.from({ length: 100 }, (_, i) => ({
      id: 6000 + i,
      price_info: { input_normal_price: 1000 },
      stock_setting_list: [{ sellable_stock: 5 }],
      tier_index: [0],
    }));
    const { deps, calls } = makeDeps({
      productInfos: {
        1003: {
          code: 0,
          data: {
            product_info: {
              model_list: models,
              std_tier_variation_list: [{ value_list: [{ custom_value: 'A' }, { custom_value: 'B' }] }],
            },
          },
        },
      },
    });
    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('failed');
    expect(final.items[0].error).toContain('100');
    expect(calls).toEqual([]);
  });
});

describe('折扣移除与恢复', () => {
  it('有折扣时按「移除 → 发布 → 恢复」顺序执行，并在写请求前落检查点', async () => {
    const product = makeProduct('1001');
    const { deps, calls, saved } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
    });
    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(calls).toEqual(['removeDiscount:1001', 'publish:1001', 'restoreDiscount']);
    expect(final.items[0].discountRemoved).toBe(true);
    expect(final.items[0].discountRestored).toBe(true);
    expect(final.discountRate).toBe(80);
    // 三个关键写请求各自在发出前落过检查点
    const steps = final.checkpoints.map(c => c.step);
    expect(steps).toContain('delete_abnormal_seller_discount_items');
    expect(steps).toContain('update_product_info');
    expect(steps).toContain('update_seller_discount_items');
    expect(final.checkpoints.every(c => c.writeSent)).toBe(true);
    expect(final.writeStarted).toBe(true);
    // 检查点在保存里也出现过（不是只在终态对象上）
    expect(saved.some(t => t.checkpoints.length > 0)).toBe(true);
  });

  it('折扣部分恢复失败：保留失败详情，不冒充全部恢复成功', async () => {    const product = makeProduct('1001');
    const { deps } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
      restoreResult: {
        1001: { error: 0, data: { total_count: 2, success_count: 1, failed_item_list: [{ model_id: 5002 }], error_list: [] } },
      },
    });
    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('success');
    expect(final.items[0].discountRestored).toBe(false);
    expect(final.items[0].error).toContain('部分 SKU 恢复失败');
  });

  it('折扣恢复顶层失败：保留活动名与人工恢复提示', async () => {
    const product = makeProduct('1001');
    const { deps } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
      restoreResult: { 1001: { error: 3, data: {} } },
    });
    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('success');
    expect(final.items[0].discountRestored).toBe(false);
    expect(final.items[0].error).toContain('折扣A');
  });

  it('5 倍价格差且发布前无折扣：重新搜索→移除→重发一次', async () => {
    const product = makeProduct('1001');
    let searched = 0;
    const { deps, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      publishResult: (_id, attempt) => (attempt === 1 ? { code: 1001, msg: '价格差距超过5倍' } : { code: 0 }),
    });
    // 首次搜索返回空，重试搜索才有折扣
    const originalFetch = deps.injectedFetch;
    deps.injectedFetch = async (url: string, method?: string, body?: any) => {
      if (url.includes('/discount/search/')) {
        searched += 1;
        return searched === 1 ? { code: 0, data: { discounts: [] } } : DISCOUNT_OK;
      }
      return originalFetch(url, method, body);
    };

    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(calls).toEqual(['publish:1001', 'removeDiscount:1001', 'publish:1001', 'restoreDiscount']);
    expect(final.items[0].publishStatus).toBe('success');
    expect(final.items[0].discountRemoved).toBe(true);
    expect(final.items[0].discountRestored).toBe(true);
  });

  it('5 倍价格差但重试搜索仍无折扣：失败并说明原因', async () => {
    const product = makeProduct('1001');
    const { deps, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      publishResult: () => ({ code: 1001, msg: '价格差距超过5倍' }),
    });
    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(calls).toEqual(['publish:1001']);
    expect(final.items[0].publishStatus).toBe('failed');
    expect(final.items[0].error).toContain('5倍');
  });

  it('移除折扣失败：不发布商品，失败原因指明活动名', async () => {
    const product = makeProduct('1001');
    const { deps, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
    });
    const originalFetch = deps.injectedFetch;
    deps.injectedFetch = async (url: string, method?: string, body?: any) => {
      if (url.includes('/discount/delete_abnormal_seller_discount_items/')) {
        calls.push(`removeDiscount:${body.item_id_list[0]}`);
        return { error: 5 };
      }
      return originalFetch(url, method, body);
    };

    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(calls).toEqual(['removeDiscount:1001']);
    expect(final.items[0].publishStatus).toBe('failed');
    expect(final.items[0].error).toContain('折扣A');
  });

  // BR4 复验：多折扣商品上「活动 99 移除成功、活动 100 失败」不能统一写成"都没移除"。
  it('多折扣部分成功后失败：保留逐活动结果，不把已成功的活动抹成未移除', async () => {
    const product = makeProduct('1001');
    const twoDiscounts = {
      code: 0,
      data: {
        discounts: [
          { seller_discount: { discount_id: 99, name: '折扣A', time_status: 2, end_time: 4102444800 } },
          { seller_discount: { discount_id: 100, name: '折扣B', time_status: 0, end_time: 4102444800 } },
        ],
      },
    };
    const { deps, saved } = makeDeps({ productInfos: { 1001: noTierProductInfo() }, discounts: { 1001: twoDiscounts } });
    const originalFetch = deps.injectedFetch;
    deps.injectedFetch = async (url: string, method?: string, body?: any) => {
      if (url.includes('/discount/delete_abnormal_seller_discount_items/')) {
        // 活动 99 成功、活动 100 被平台拒绝
        return body.promotion_id === 99 ? { error: 0 } : { error: 5 };
      }
      return originalFetch(url, method, body);
    };

    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    const removals = final.items[0].discountRemovals ?? [];
    expect(removals).toEqual([
      { promotionId: 99, name: '折扣A', status: 'success' },
      { promotionId: 100, name: '折扣B', status: 'failed' },
    ]);
    // 已有活动被确认移除 → 不能统一写成"没移除"
    expect(final.items[0].discountRemoved).toBe(true);
    expect(final.items[0].error).toContain('折扣B');
    // 逐活动结果必须真的落盘，而不是只留在内存
    const persisted = saved.some(t => t.items[0]?.discountRemovals?.some(r => r.promotionId === 99 && r.status === 'success'));
    expect(persisted).toBe(true);
  });

  it('移除请求传输异常：该活动标为未知，之前已成功的活动仍保留', async () => {
    const product = makeProduct('1001');
    const twoDiscounts = {
      code: 0,
      data: {
        discounts: [
          { seller_discount: { discount_id: 99, name: '折扣A', time_status: 2, end_time: 4102444800 } },
          { seller_discount: { discount_id: 100, name: '折扣B', time_status: 0, end_time: 4102444800 } },
        ],
      },
    };
    const { deps, calls } = makeDeps({ productInfos: { 1001: noTierProductInfo() }, discounts: { 1001: twoDiscounts } });
    const originalFetch = deps.injectedFetch;
    deps.injectedFetch = async (url: string, method?: string, body?: any) => {
      if (url.includes('/discount/delete_abnormal_seller_discount_items/')) {
        if (body.promotion_id === 99) return { error: 0 };
        throw new Error('isolated remove transport failure');
      }
      return originalFetch(url, method, body);
    };

    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    const removals = final.items[0].discountRemovals ?? [];
    expect(removals[0]).toEqual({ promotionId: 99, name: '折扣A', status: 'success' });
    expect(removals[1]).toEqual({ promotionId: 100, name: '折扣B', status: 'unknown' });
    expect(final.items[0].discountRemoved).toBe(true);
    // 未知不等于成功：不得继续发布或恢复折扣
    expect(calls.some(c => c.startsWith('publish:'))).toBe(false);
    expect(calls).not.toContain('restoreDiscount');
    expect(final.items[0].publishStatus).toBe('failed');
    expect(final.items[0].error).toContain('未知');
  });

  it('检查点带活动标识与结果，可区分哪个折扣真的被改过', async () => {
    const product = makeProduct('1001');
    const { deps, saved } = makeDeps({ productInfos: { 1001: noTierProductInfo() }, discounts: { 1001: DISCOUNT_OK } });
    await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    const cp = saved.flatMap(t => t.checkpoints).find(c => c.step === 'delete_abnormal_seller_discount_items' && c.outcome === 'success');
    expect(cp?.promotionId).toBe(99);
    expect(cp?.promotionName).toBe('折扣A');
  });

  // 单折扣 + 移除请求网络错误：必须停止本商品，不能当作"已移除"继续发布
  it('单折扣移除请求网络错误：停止本商品，不发发布也不发恢复', async () => {
    const product = makeProduct('1001');
    const { deps, calls, saved } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
    });
    const originalFetch = deps.injectedFetch;
    deps.injectedFetch = async (url: string, method?: string, body?: any) => {
      if (url.includes('/discount/delete_abnormal_seller_discount_items/')) {
        throw new Error('isolated remove transport failure');
      }
      return originalFetch(url, method, body);
    };

    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('failed');
    expect(final.items[0].discountRemoved).toBe(false);
    expect(final.items[0].discountRemovals?.[0]).toEqual({ promotionId: 99, name: '折扣A', status: 'unknown' });
    expect(calls.some(c => c.startsWith('publish:'))).toBe(false);
    expect(calls).not.toContain('restoreDiscount');
    expect(final.items[0].error).toContain('未知');
    // 未知状态必须落盘，用户能看到要核对哪一份折扣
    const persisted = saved.some(t => t.items[0]?.discountRemovals?.some(r => r.status === 'unknown'));
    expect(persisted).toBe(true);
  });
});

describe('BR1 身份与凭据边界', () => {
  it('核实不到实际店铺时不得完成任何写请求', async () => {
    const product = makeProduct('1001');
    const { deps, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
      actualShopId: null,
    });
    await expect(
      runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 }),
    ).rejects.toBeInstanceOf(RepairOwnershipError);
    expect(calls).toEqual([]);
  });

  it('同一商品移除折扣后切店，后续发布/恢复必须停止', async () => {
    const product = makeProduct('1001');
    const { deps, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
      switchShopAfterRemove: 888,
    });
    await expect(
      runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 }),
    ).rejects.toBeInstanceOf(RepairOwnershipError);
    // 移除已发生（无法撤销），但发布与恢复绝不能再发
    expect(calls).toEqual(['removeDiscount:1001']);
  });

  it('认证账号与任务 owner 不一致时停止', async () => {
    const product = makeProduct('1001');
    const { deps, calls } = makeDeps({ productInfos: { 1001: noTierProductInfo() }, authUserId: 2 });
    await expect(
      runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 }),
    ).rejects.toBeInstanceOf(RepairOwnershipError);
    expect(calls).toEqual([]);
  });

  it('归属变化不被逐商品 catch 吞成"单件失败"', async () => {
    const a = makeProduct('1001');
    const b = makeProduct('1002');
    const { deps, calls } = makeDeps({ productInfos: { 1001: noTierProductInfo(), 1002: noTierProductInfo() }, authUserId: 2 });
    await expect(runOneDaySkuRepairTask(makeTask([a, b]), [a, b], deps, { debounceMs: 0 })).rejects.toThrow(
      /归属不一致/,
    );
    expect(calls).toEqual([]);
  });

  // BR1 第二轮：修复进行中登出/换号必须停写。
  // 原来只比对启动时缓存的账号快照，账号变了也照样写。
  it('修复进行中把认证账号换成另一个账号 → 停止后续写请求', async () => {
    const product = makeProduct('1001');
    const { deps, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
      // 启动时是账号 1，移除折扣后变成账号 2
      authUserIdSequence: [1, 1, 2],
    });
    await expect(
      runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 }),
    ).rejects.toBeInstanceOf(RepairOwnershipError);
    // 移除已发生（无法撤销），但发布与恢复绝不能再发
    expect(calls).toEqual(['removeDiscount:1001']);
  });

  it('修复进行中登出（读不到账号）→ 停止后续写请求', async () => {
    const product = makeProduct('1001');
    const { deps, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
      authUserIdSequence: [1, 1, null],
    });
    await expect(
      runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 }),
    ).rejects.toBeInstanceOf(RepairOwnershipError);
    expect(calls).toEqual(['removeDiscount:1001']);
  });

  it('归属停止错误带上实际锚，供最小脱敏诊断记录', async () => {
    const product = makeProduct('1001');
    const { deps } = makeDeps({ productInfos: { 1001: noTierProductInfo() }, actualShopId: 888 });
    await expect(
      runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 }),
    ).rejects.toMatchObject({ name: 'RepairOwnershipError', actualShopId: 888 });
  });
});

describe('BR4 业务等待与部分修改证据', () => {
  it('移除折扣后、发布前仍有 2 秒等待（与原行为一致）', async () => {
    const product = makeProduct('1001');
    const { deps, order } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
    });
    await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 2000 });

    const removeIdx = order.indexOf('remove');
    const publishIdx = order.indexOf('publish');
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(publishIdx).toBeGreaterThan(removeIdx);
    // 移除与发布之间必须出现 2000ms 等待
    expect(order.slice(removeIdx + 1, publishIdx)).toContain('sleep:2000');
  });

  it('发布传输失败时保留已移除的折扣与活动信息（不回退成初始 item）', async () => {
    const product = makeProduct('1001');
    const { deps, saved } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
    });
    const original = deps.injectedFetch;
    deps.injectedFetch = async (url: string, method?: string, body?: any) => {
      if (url.includes('/product/update_product_info')) throw new Error('isolated publish transport failure');
      return original(url, method, body);
    };

    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('failed');
    // 关键：折扣移除证据不能丢
    expect(final.items[0].discountRemoved).toBe(true);
    expect(final.items[0].discounts?.[0]?.promotionId).toBe(99);
    // 发布前就已把「移除折扣」的检查点与工作中商品落盘
    const beforePublish = saved.filter(t => t.writeStarted && t.workItem?.discountRemoved);
    expect(beforePublish.length).toBeGreaterThan(0);
    expect(beforePublish[0].workItem?.discounts?.length).toBe(1);
  });

  it('检查点保存了活动标识与恢复资料，供中断后核对', async () => {
    const product = makeProduct('1001');
    const { deps, saved } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
    });
    await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    // 取「已经移除折扣」且带活动资料的那份快照：它同时应含移除步骤的检查点
    const withEvidence = saved.filter(t => t.workItem?.discountRemoved).pop();
    expect(withEvidence).toBeTruthy();
    const discounts = withEvidence!.workItem!.discounts!;
    expect(discounts[0].promotionId).toBe(99);
    expect(discounts[0].name).toBe('折扣A');
    const steps = withEvidence!.checkpoints.map(c => c.step);
    expect(steps).toContain('delete_abnormal_seller_discount_items');
  });

  // BR4 第二轮：恢复折扣请求异常时，不能把记录退回「还没发布」。
  // 原来这条路径丢掉了「商品已发布」「折扣已移除」两项事实，用户无法判断要核对什么。
  it('恢复折扣传输异常：保留已发布与已移除折扣的证据，并把恢复标为待核对', async () => {
    const product = makeProduct('1001');
    const { deps, saved } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
    });
    const original = deps.injectedFetch;
    deps.injectedFetch = async (url: string, method?: string, body?: any) => {
      if (url.includes('/discount/update_seller_discount_items/')) {
        throw new Error('isolated restore transport failure');
      }
      return original(url, method, body);
    };

    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('success');
    expect(final.items[0].skuCreated).toBe(true);
    expect(final.items[0].discountRemoved).toBe(true);
    expect(final.items[0].discountRestored).toBe(false);
    expect(final.items[0].discounts?.[0]?.promotionId).toBe(99);
    expect(final.items[0].discounts?.[0]?.name).toBe('折扣A');
    expect(final.items[0].error).toContain('恢复结果未知');

    // 恢复请求发出前就已把「商品已发布」这一事实落盘（不能只留在内存里）
    const publishedBeforeRestore = saved.filter(t => t.workItem?.publishStatus === 'success');
    expect(publishedBeforeRestore.length).toBeGreaterThan(0);
    expect(publishedBeforeRestore[0].workItem?.discounts?.length).toBe(1);
  });

  it('恢复折扣返回业务失败时同样保留已发布证据', async () => {
    const product = makeProduct('1001');
    const { deps } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      discounts: { 1001: DISCOUNT_OK },
      restoreResult: { 1001: { error: 1, msg: '广告活动已结束' } },
    });

    const final = await runOneDaySkuRepairTask(makeTask([product]), [product], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('success');
    expect(final.items[0].discountRemoved).toBe(true);
    expect(final.items[0].discountRestored).toBe(false);
    expect(final.items[0].error).toContain('恢复失败');
  });
});

describe('失败隔离与保存失败即停', () => {
  it('一件商品失败不阻断其他商品', async () => {
    const a = makeProduct('1001');
    const b = makeProduct('1002');
    const { deps } = makeDeps({
      productInfos: { 1001: { code: 0, data: {} }, 1002: noTierProductInfo() },
    });
    const final = await runOneDaySkuRepairTask(makeTask([a, b]), [a, b], deps, { debounceMs: 0 });

    expect(final.items[0].publishStatus).toBe('failed');
    expect(final.items[0].error).toContain('获取商品详情返回数据为空');
    expect(final.items[1].publishStatus).toBe('success');
    expect(final.status).toBe('completed');
  });

  it('全部失败时状态为 failed，不伪称可继续', async () => {
    const a = makeProduct('1001');
    const { deps } = makeDeps({ productInfos: { 1001: { code: 0, data: {} } } });
    const final = await runOneDaySkuRepairTask(makeTask([a]), [a], deps, { debounceMs: 0 });

    expect(final.status).toBe('failed');
    expect(final.phase).toBe('failed');
    expect(final.resultProducts).toEqual([]);
  });

  it('保存进度失败即停止后续商品写请求（B9）', async () => {
    const a = makeProduct('1001');
    const b = makeProduct('1002');
    // 只允许前 3 次保存成功，之后失败 —— 第一件商品刚开始写就触发
    const { deps, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo(), 1002: noTierProductInfo() },
      failSaveAfter: 3,
    });

    await expect(runOneDaySkuRepairTask(makeTask([a, b]), [a, b], deps, { debounceMs: 0 })).rejects.toBeInstanceOf(
      RepairCheckpointSaveError,
    );
    // 第一件商品最多走到移除折扣前的检查点，第二件商品绝不应被处理
    expect(calls.some(c => c === 'publish:1002')).toBe(false);
  });

  it('切店时停止后续写请求', async () => {
    const a = makeProduct('1001');
    const b = makeProduct('1002');
    const { deps, calls } = makeDeps({ productInfos: { 1001: noTierProductInfo(), 1002: noTierProductInfo() } });
    let callsToShop = 0;
    deps.getShopIdentity = async () => {
      callsToShop += 1;
      return { shopId: callsToShop > 1 ? 999 : 777, accountId: 1 };
    };

    await expect(runOneDaySkuRepairTask(makeTask([a, b]), [a, b], deps, { debounceMs: 0 })).rejects.toThrow(
      /店铺.*不一致/,
    );
    expect(calls.some(c => c === 'publish:1002')).toBe(false);
  });

  it('凭据失效时停止后续写请求', async () => {
    const a = makeProduct('1001');
    const b = makeProduct('1002');
    const { deps, calls } = makeDeps({ productInfos: { 1001: noTierProductInfo(), 1002: noTierProductInfo() } });
    let credCalls = 0;
    deps.getCredential = async () => {
      credCalls += 1;
      return credCalls > 1 ? { spcCds: '', spcCdsVer: '2' } : { spcCds: 'iso-credential', spcCdsVer: '2' };
    };

    await expect(runOneDaySkuRepairTask(makeTask([a, b]), [a, b], deps, { debounceMs: 0 })).rejects.toThrow(
      /凭据已失效/,
    );
    expect(calls.some(c => c === 'publish:1002')).toBe(false);
  });
});

describe('完成结果准备', () => {
  it('成功商品的结果在后台读取并写入任务记录；失败商品不进入结果', async () => {
    const a = makeProduct('1001');
    const b = makeProduct('1002');
    const { deps } = makeDeps({
      productInfos: { 1001: noTierProductInfo(), 1002: { code: 0, data: {} } },
    });
    const final = await runOneDaySkuRepairTask(makeTask([a, b]), [a, b], deps, { debounceMs: 0 });

    expect(final.resultProducts.map(p => p.itemid)).toEqual(['1001']);
  });

  it('无折扣商品不贡献折扣率', async () => {
    const a = makeProduct('1001');
    const { deps } = makeDeps({ productInfos: { 1001: { code: 0, data: {} } } });
    const final = await runOneDaySkuRepairTask(makeTask([a]), [a], deps, { debounceMs: 0 });

    expect(final.discountRate).toBeNull();
  });

  it('结果读取失败不影响"修复成功"这一事实', async () => {
    const a = makeProduct('1001');
    const { deps } = makeDeps({ productInfos: { 1001: noTierProductInfo() } });
    deps.fetchProductsByIds = async () => {
      throw new Error('图未就绪');
    };
    const final = await runOneDaySkuRepairTask(makeTask([a]), [a], deps, { debounceMs: 0 });

    expect(final.status).toBe('completed');
    expect(final.items[0].publishStatus).toBe('success');
    expect(final.resultProducts).toEqual([]);
  });

  it('记录里始终不含原始凭据', async () => {
    const a = makeProduct('1001');
    const { deps, saved } = makeDeps({ productInfos: { 1001: noTierProductInfo() } });
    await runOneDaySkuRepairTask(makeTask([a]), [a], deps, { debounceMs: 0 });

    for (const task of saved) {
      expect(JSON.stringify(task)).not.toContain('iso-credential');
    }
  });
});

describe('BR5 迟到写入不得回退终态', () => {
  it('权威记录已标记中断：本实例不再写任何记录，也不继续发写请求', async () => {
    const a = makeProduct('1001');
    const { deps, saved, calls } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      authoritativeStatus: 'interrupted',
    });

    await expect(
      runOneDaySkuRepairTask(makeTask([a]), [a], deps, { debounceMs: 0 }),
    ).rejects.toThrow(RepairStaleWriteError);

    expect(saved).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('权威记录已完成：迟到实例同样放弃写入', async () => {
    const a = makeProduct('1001');
    const { deps, saved } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      authoritativeStatus: 'completed',
    });

    await expect(
      runOneDaySkuRepairTask(makeTask([a]), [a], deps, { debounceMs: 0 }),
    ).rejects.toThrow(RepairStaleWriteError);

    expect(saved).toEqual([]);
  });

  it('权威记录仍是本任务的进行中状态：正常写入不被拦', async () => {
    const a = makeProduct('1001');
    const { deps, saved } = makeDeps({
      productInfos: { 1001: noTierProductInfo() },
      authoritativeStatus: 'running',
    });
    (deps as any).loadTask = async () => ({ ...makeTask([a]), status: 'running', phase: 'publishing' });

    const final = await runOneDaySkuRepairTask(makeTask([a]), [a], deps, { debounceMs: 0 });

    expect(final.status).toBe('completed');
    expect(saved.length).toBeGreaterThan(0);
  });
});
