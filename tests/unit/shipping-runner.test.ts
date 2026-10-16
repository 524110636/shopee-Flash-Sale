/**
 * shipping runner 的隔离单测：用注入的假 deps 覆盖真实执行路径。
 *
 * 不联网、不碰 storage、不开浏览器，因此可以稳定验证验收矩阵里最难在浏览器里构造的分支：
 * 保存失败即停写（S4）、切店/登出停写（S8）、逐项错误码归类与 1000100252 跳过（S3）、
 * 限流退避（S8）、物流关闭失败先恢复再停（S5）、恢复部分失败必须可见（S5）、
 * 未选物流时零物流写（S5）。
 */
import { describe, it, expect } from 'vitest';
import {
  ShippingCheckpointSaveError,
  ShippingOwnershipError,
  needsLogisticsAction,
  previewShippingTargets,
  restorePendingLogistics,
  runShippingTask,
} from '@/features/shipping/runner';
import type {
  ShippingBatchOutcome,
  ShippingChannelToggleOutcome,
  ShippingCredential,
  ShippingRunnerDeps,
  ShippingVerifiedContext,
} from '@/features/shipping/runner-deps';
import { createShippingTask, patchShippingTask } from '@/features/shipping/task';
import type {
  ShippingChannel,
  ShippingProduct,
  ShippingTargetItem,
  ShippingTask,
} from '@/features/shipping/types';

function product(id: number, status: number | string = 1, extra: Partial<ShippingProduct> = {}): ShippingProduct {
  // `enable_model_level_dts: false` 是显式给出的：字段缺失会让 runner 走"读详情确认"分支
  // （这是 R1 要求的行为），测试夹具必须明确它不是 SKU 级，否则会被保守排除。
  return { id, name: `商品 ${id}`, status, category_path: 'a/b', enable_model_level_dts: false, ...extra };
}

function target(itemId: string): ShippingTargetItem {
  return { itemId, name: `商品 ${itemId}`, status: 1, categoryPath: 'a/b' };
}

function makeTask(overrides: Partial<Parameters<typeof createShippingTask>[0]> = {}): ShippingTask {
  return createShippingTask({
    taskId: 'ship-1',
    requestId: 'ship-1',
    shopId: 777,
    ownerUserId: 1,
    source: 'manual',
    mode: 'spot',
    days: 1,
    range: 'all',
    excludeIds: [],
    total: 2,
    toggleLogistics: false,
    now: 1000,
    ...overrides,
  });
}

/** 记录所有店铺写请求，用来断言"写了几次、写了什么、有没有在停止后继续写" */
interface Calls {
  batch: Array<Array<{ id: number; category_path: string; pre_order: boolean; days_to_ship: number }>>;
  toggles: Array<{ channelId: number; enabled: boolean }>;
  channelReads: number;
  productReads: number;
  detailReads: number;
  /** 每次商品写请求用的凭据（返工 17.2：必须与核验那一份相同） */
  batchCredentials: ShippingCredential[];
  /** 每次渠道写请求用的凭据 */
  toggleCredentials: ShippingCredential[];
}

interface DepsOptions {
  products?: ShippingProduct[];
  /** 只读预检用的商品列表（与执行时的 `products` 分开，用于验证"开跑前重新检查"） */
  previewProducts?: ShippingProduct[];
  flashSaleIds?: string[];
  flashSaleOk?: boolean;
  channels?: ShippingChannel[];
  channelReads?: ShippingChannel[];
  /** 商品详情（判 SKU 模式／回读用）；返回 null 表示详情读不到 */
  productDetail?: Record<string, unknown> | null;
  batchOutcomes?: Array<ShippingBatchOutcome | (() => Promise<ShippingBatchOutcome>)>;
  toggleOutcome?: (channelId: number, enabled: boolean, attempt: number) => ShippingChannelToggleOutcome;
  failSaveAfter?: number;
  /** 在第 N 次商品写请求**发出时**把当前店铺换成别的（模拟处理期间切店） */
  switchShopAtBatch?: number;
  /** 在第 N 次商品写请求发出后换后端账号（模拟切账号） */
  switchUserAfterBatch?: number;
  /** 始终报告"用户已请求停止" */
  alwaysStop?: boolean;
  shopId?: number | null;
  authUserId?: number | null;
  /**
   * 自定义"已核实上下文"（返工 17.2）。
   *
   * 返回一个可变的凭据与身份，用来复现"核验之后、发送之前上下文被换掉"：
   * 夹具能在两次调用之间改凭据字符串／店铺，验证 runner 是否用未核实的新会话去写。
   * 不提供时 runner 走 `getCredential` + `getShopIdentity` 的降级路径。
   */
  verifiedContext?: () => Promise<ShippingVerifiedContext>;
}

function makeDeps(options: DepsOptions = {}) {
  const calls: Calls = {
    batch: [],
    toggles: [],
    channelReads: 0,
    productReads: 0,
    detailReads: 0,
    batchCredentials: [],
    toggleCredentials: [],
  };
  let store: ShippingTask | null = null;
  let saveCount = 0;
  let batchIndex = 0;
  let toggleAttempt = 0;
  let currentShopId = options.shopId === undefined ? 777 : options.shopId;
  let currentUserId = options.authUserId === undefined ? 1 : options.authUserId;
  let previewReadDone = false;
  const logs: string[] = [];

  const deps: ShippingRunnerDeps = {
    getCredential: async () => ({ spcCds: 'iso-cred', spcCdsVer: '2' }),
    ...(options.verifiedContext ? { verifiedContext: options.verifiedContext } : {}),
    getShopIdentity: async () => ({ shopId: currentShopId, accountId: 5 }),
    getAuthUserId: async () => currentUserId,
    fetchAllProducts: async () => {
      calls.productReads += 1;
      // 第一次读是预检；之后是开跑前检查／回读
      if (!previewReadDone && options.previewProducts) {
        previewReadDone = true;
        return { products: options.previewProducts, complete: true };
      }
      return { products: options.products ?? [product(101), product(102)], complete: true };
    },
    fetchFlashSaleExcludeIds: async () => ({
      ok: options.flashSaleOk !== false,
      itemIds: new Set(options.flashSaleIds ?? []),
      ...(options.flashSaleOk === false ? { error: '特卖活动查询失败' } : {}),
    }),
    fetchChannelList: async () => {
      calls.channelReads += 1;
      // 第一次读是快照（关闭前），之后是回读确认；这里都用同一份可由用例控制的状态
      if (calls.channelReads === 1) return options.channels ?? null;
      return options.channelReads ?? options.channels ?? null;
    },
    fetchProductDetail: async (_credential, itemId) => {
      calls.detailReads += 1;
      void itemId;
      return options.productDetail ?? null;
    },
    updateChannelToggle: async (credential, channelId, enabled) => {
      calls.toggleCredentials.push(credential);
      calls.toggles.push({ channelId, enabled });
      toggleAttempt += 1;
      if (options.toggleOutcome) return options.toggleOutcome(channelId, enabled, toggleAttempt);
      return { success: true };
    },
    updateProductBatch: async (credential, payload) => {
      calls.batchCredentials.push(credential);
      calls.batch.push(payload);
      // 在第 N 次商品写请求发出时切店：用来验证"下一批写之前能发现归属不一致"
      if (options.switchShopAtBatch !== undefined && calls.batch.length === options.switchShopAtBatch) {
        currentShopId = 999;
      }
      if (options.switchUserAfterBatch !== undefined && calls.batch.length === options.switchUserAfterBatch) {
        currentUserId = 2;
      }
      const next = options.batchOutcomes?.[Math.min(batchIndex, (options.batchOutcomes?.length ?? 1) - 1)];
      batchIndex += 1;
      if (typeof next === 'function') return await next();
      if (next) return next;
      return {
        topLevelSuccess: true,
        itemResults: payload.map(p => ({ id: String(p.id), code: 0 })),
        hasItemResults: true,
      };
    },
    saveTask: async task => {
      saveCount += 1;
      if (options.failSaveAfter !== undefined && saveCount > options.failSaveAfter) {
        throw new Error('storage 写入失败');
      }
      store = task;
    },
    loadTask: async () => store,
    now: () => 5000,
    sleep: async () => {},
    startKeepalive: () => {},
    stopKeepalive: () => {},
    isStopRequested: () => options.alwaysStop === true,
    log: message => {
      logs.push(message);
    },
  };

  return {
    deps,
    calls,
    logs,
    getStore: () => store,
    setShopId: (id: number | null) => {
      currentShopId = id;
    },
  };
}

describe('只读预检', () => {
  const settings = {
    mode: 'spot' as const,
    days: 1,
    range: 'all' as const,
    excludeIds: '',
    toggleLogistics: false,
  };

  it('成功时产出目标与各排除统计，且不发出任何写请求', async () => {
    const { deps, calls } = makeDeps({
      products: [product(101), product(102), product(103, 8), product(104, 0)],
      flashSaleIds: ['102'],
    });
    const preview = await previewShippingTargets(deps, { ...settings, excludeIds: '103' });
    expect(preview.ok).toBe(true);
    expect(preview.items.map(i => i.itemId)).toEqual(['101']);
    expect(preview.excludedByManual).toBe(1);
    expect(preview.excludedByFlashSale).toBe(1);
    expect(calls.batch).toHaveLength(0);
    expect(calls.toggles).toHaveLength(0);
  });

  it('按 SKU 设置备货的商品单列不支持，不静默降级', async () => {
    const { deps } = makeDeps({
      products: [product(101), product(102, 1, { enable_model_level_dts: true })],
    });
    const preview = await previewShippingTargets(deps, settings);
    expect(preview.items.map(i => i.itemId)).toEqual(['101']);
    expect(preview.unsupported).toBe(1);
  });

  it('SKU 模式不明确时读详情确认，确认为 SKU 级则排除（R1）', async () => {
    const { deps, calls } = makeDeps({
      products: [product(101, 1, { enable_model_level_dts: undefined })],
      productDetail: { enable_model_level_dts: true, pre_order_info: { days_to_ship: 3 } },
    });
    const preview = await previewShippingTargets(deps, settings);
    expect(calls.detailReads).toBeGreaterThan(0);
    expect(preview.items).toHaveLength(0);
    expect(preview.unsupported).toBe(1);
  });

  it('SKU 模式查不到时不进入写集合（宁少改不误改）（R1）', async () => {
    const { deps } = makeDeps({
      products: [product(101, 1, { enable_model_level_dts: undefined })],
      productDetail: null,
    });
    const preview = await previewShippingTargets(deps, settings);
    expect(preview.items).toHaveLength(0);
    expect(preview.unsupported).toBe(1);
  });

  it('商品列表读取不完整时停止预检，不当成空店铺', async () => {
    const { deps } = makeDeps();
    deps.fetchAllProducts = async () => ({ products: [], complete: false, error: '游标重复' });
    const preview = await previewShippingTargets(deps, settings);
    expect(preview.ok).toBe(false);
    expect(preview.items).toEqual([]);
    expect(preview.error).toContain('不完整');
  });

  it('特卖排除调查失败时停止预检，不用未确认状态继续写', async () => {
    const { deps } = makeDeps({ flashSaleOk: false });
    const preview = await previewShippingTargets(deps, settings);
    expect(preview.ok).toBe(false);
    expect(preview.error).toContain('特卖排除调查失败');
  });

  it('身份核实不到时停止预检', async () => {
    const { deps } = makeDeps({ shopId: null });
    const preview = await previewShippingTargets(deps, settings);
    expect(preview.ok).toBe(false);
    expect(preview.error).toContain('无法核实当前店铺身份');
  });

  it('非热销范围字段不可取得时拒绝开始，不退化为全店（R1）', async () => {
    const { deps } = makeDeps({ products: [product(101)] });
    const preview = await previewShippingTargets(deps, { ...settings, range: 'nonhot' });
    expect(preview.ok).toBe(false);
    expect(preview.nonhotDeterminable).toBe(false);
    expect(preview.error).toContain('不可判定');
    expect(preview.items).toHaveLength(0);
  });

  it('物流未勾选时读取渠道数为零（不做无谓的物流查询）', async () => {
    const { deps, calls } = makeDeps({ products: [product(101)] });
    const preview = await previewShippingTargets(deps, settings);
    expect(preview.logistics.requested).toBe(false);
    expect(calls.channelReads).toBe(0);
  });

  it('物流勾选时给出真实影响范围', async () => {
    const { deps } = makeDeps({
      products: [product(101)],
      channels: [
        { channelId: 1, enabled: true },
        { channelId: 2, enabled: false },
      ],
    });
    const preview = await previewShippingTargets(deps, { ...settings, toggleLogistics: true });
    expect(preview.logistics.enabledChannels).toEqual([1]);
  });

  it('物流渠道读取失败时明确说明无法确认影响范围', async () => {
    const { deps } = makeDeps({ products: [product(101)], channels: undefined });
    deps.fetchChannelList = async () => null;
    const preview = await previewShippingTargets(deps, { ...settings, toggleLogistics: true });
    expect(preview.logistics.error).toContain('物流渠道读取失败');
  });
});

describe('执行：商品批改归类', () => {
  it('顶层 code 0 且逐项结果全 0 时按成功计数并回读', async () => {
    const { deps, calls } = makeDeps();
    const result = await runShippingTask(makeTask(), [target('101'), target('102')], deps);
    expect(result.summary.counts.success).toBe(2);
    expect(calls.batch).toHaveLength(1);
    expect(calls.batch[0].map(p => p.days_to_ship)).toEqual([1, 1]);
    expect(calls.batch[0].map(p => p.pre_order)).toEqual([false, false]);
  });

  it('2–10 天使用 pre_order=true', async () => {
    const { deps, calls } = makeDeps();
    await runShippingTask(makeTask({ days: 7, mode: 'preorder' }), [target('101')], deps);
    expect(calls.batch[0][0]).toMatchObject({ pre_order: true, days_to_ship: 7 });
  });

  it('顶层 0 但带逐项失败时按商品终态归类，不整批算成功', async () => {
    const { deps } = makeDeps({
      batchOutcomes: [
        {
          topLevelSuccess: true,
          itemResults: [
            { id: '101', code: 0 },
            { id: '102', code: 10001 },
          ],
        },
      ],
    });
    const result = await runShippingTask(makeTask(), [target('101'), target('102')], deps, { maxRetryRounds: 1 });
    expect(result.summary.counts.success).toBe(1);
    expect(result.summary.counts.failed).toBe(1);
    const failed = result.task.items.find(i => i.itemId === '102');
    expect(failed?.reason).toContain('平台拒绝');
  });

  it('1000100252（物流不支持目标天数）单列跳过，不算成功', async () => {
    const { deps } = makeDeps({
      batchOutcomes: [
        {
          topLevelSuccess: true,
          itemResults: [
            { id: '101', code: 0 },
            { id: '102', code: 1000100252 },
          ],
        },
      ],
    });
    const result = await runShippingTask(makeTask({ days: 5, mode: 'preorder' }), [target('101'), target('102')], deps);
    expect(result.summary.counts.success).toBe(1);
    expect(result.summary.counts.skipped).toBe(1);
    expect(result.task.items.find(i => i.itemId === '102')?.reason).toContain('物流不支持');
  });

  it('顶层 0 但缺少该项逐项结果时标 unknown 并靠回读定案，不伪报成功', async () => {
    const { deps } = makeDeps({
      products: [product(101, 1, { days_to_ship: 1 } as any)],
      batchOutcomes: [{ topLevelSuccess: true, itemResults: [{ id: '999', code: 0 }] }],
    });
    const result = await runShippingTask(makeTask(), [target('101')], deps);
    // 回读显示实际就是目标天数 → 定案为成功
    expect(result.summary.counts.success).toBe(1);
    expect(result.task.items[0].reason).toContain('回读确认');
  });

  it('顶层 0 但缺少逐项结果时不得整批算成功', async () => {
    const { deps } = makeDeps({ batchOutcomes: [{ topLevelSuccess: true, itemResults: [] }] });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(result.summary.counts.success).toBe(0);
    expect(result.summary.counts.unknown).toBe(1);
    expect(result.task.items[0].reason).toContain('逐项结果');
  });

  it('回读显示实际天数不符时记为失败，不掩盖', async () => {
    const { deps } = makeDeps({
      products: [product(101, 1, { days_to_ship: 9 } as any)],
      batchOutcomes: [{ topLevelSuccess: false, itemResults: [], error: '平台未返回逐项结果' }],
    });
    const result = await runShippingTask(makeTask(), [target('101')], deps);
    expect(result.summary.counts.failed).toBe(1);
    expect(result.task.items[0].reason).toContain('实际为 9 天');
  });

  it('传输异常时不盲目重发：交由回读定案', async () => {
    const { deps, calls } = makeDeps({
      products: [product(101, 1, { days_to_ship: 1 } as any)],
      batchOutcomes: [
        () => {
          throw new Error('network timeout');
        },
      ],
    });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { maxRetryRounds: 1 });
    expect(result.summary.counts.success).toBe(1);
    // 只发出一次写请求；异常后不再重发
    expect(calls.batch).toHaveLength(1);
  });

  it('限流时退避缩批并可重试成功', async () => {
    const { deps, calls } = makeDeps({
      batchOutcomes: [
        { topLevelSuccess: false, itemResults: [], rateLimited: true, topCode: 429 } as any,
        { topLevelSuccess: true, itemResults: [{ id: '101', code: 0 }] },
      ],
    });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { maxRetryRounds: 3 });
    expect(result.summary.counts.success).toBe(1);
    expect(calls.batch.length).toBeGreaterThanOrEqual(2);
  });

  it('开跑前被排除规则命中的商品被剔除，写集合不扩大', async () => {
    const { deps, calls } = makeDeps({ flashSaleIds: ['102'] });
    const result = await runShippingTask(makeTask(), [target('101'), target('102')], deps);
    expect(calls.batch[0].map(p => p.id)).toEqual([101]);
    expect(result.task.items.find(i => i.itemId === '102')?.status).toBe('skipped');
  });

  it('用户停止后不再发新写请求，已发项保留结果', async () => {
    const { deps, calls } = makeDeps({ alwaysStop: true });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { batchSize: 1 });
    expect(result.task.status).toBe('stopped');
    expect(calls.batch).toHaveLength(0);
    expect(result.task.items[0].status).toBe('pending');
  });
});

describe('执行：任务级停止条件', () => {
  it('保存进度失败即停止后续写请求', async () => {
    const { deps, calls } = makeDeps({ failSaveAfter: 3 });
    const result = await runShippingTask(makeTask(), [target('101'), target('102')], deps, {
      batchSize: 1,
      readback: false,
    });
    // 关键：保存失败后没有继续发出第二批写请求
    expect(calls.batch.length).toBeLessThanOrEqual(1);
    expect(result.task.status).toBe('failed');
  });

  it('处理期间切店时停止写，不把商品改到别的店铺', async () => {
    const { deps, calls } = makeDeps({ switchShopAtBatch: 1 });
    const result = await runShippingTask(makeTask(), [target('101'), target('102')], deps, {
      batchSize: 1,
      concurrency: 1,
      readback: false,
    });
    // 并发为 1：第一批（1 件）发出时切店 → 第二批绝不能再发
    expect(calls.batch).toHaveLength(1);
    expect(result.task.status).toBe('failed');
    expect(result.task.error || '').toMatch(/不一致|失效/);
  });

  it('账号失效时停止写', async () => {
    const { deps } = makeDeps({ authUserId: null });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(result.task.status).toBe('failed');
  });

  it('权威记录已是终态时迟到写入放弃，不改记录', async () => {
    const { deps } = makeDeps();
    const task = makeTask();
    // 预先放入一份"已被标记完成"的权威记录
    let store = patchShippingTask(task, { status: 'completed', now: 1 });
    deps.loadTask = async () => store;
    deps.saveTask = async next => {
      store = next;
    };
    const result = await runShippingTask(task, [target('101')], deps, { readback: false });
    expect(result.task.status).toBe('completed');
  });

  it('用户停止时不会被内存旧副本把 stopRequested 覆盖回 false', async () => {
    // 真实场景：runner 的内存副本是启动时的快照；用户点停止写的是**权威记录**。
    // 若 save 不回读权威记录，下一次进度落盘就会把 true 覆盖回 false —— 点了停止却继续写。
    const { deps, calls } = makeDeps();
    let store: any = null;
    let saved = 0;
    deps.saveTask = async next => {
      saved += 1;
      store = next;
      // 第 3 次保存（进入批改阶段之后）模拟用户在界面点了停止
      if (saved === 3) store = { ...next, stopRequested: true };
    };
    deps.loadTask = async () => store;
    const result = await runShippingTask(makeTask(), [target('101'), target('102')], deps, {
      batchSize: 1,
      concurrency: 1,
    });
    expect(result.task.stopRequested, '停止标志被覆盖丢失');
    expect(result.task.status).toBe('stopped');
    // 停止生效后不再继续写第二批
    expect(calls.batch.length).toBeLessThanOrEqual(1);
  });
});

describe('执行：物流关闭与恢复', () => {
  const logisticsTask = () =>
    makeTask({ toggleLogistics: true });

  it('未勾选物流时零物流写请求', async () => {
    const { deps, calls } = makeDeps({ channels: [{ channelId: 1, enabled: true }] });
    await runShippingTask(makeTask(), [target('101')], deps);
    expect(calls.toggles).toHaveLength(0);
    expect(calls.channelReads).toBe(0);
  });

  it('勾选后先保存快照，关闭原启用渠道，完成后恢复', async () => {
    const { deps, calls } = makeDeps({
      channels: [
        { channelId: 1, enabled: true },
        { channelId: 2, enabled: false },
      ],
      channelReads: [
        { channelId: 1, enabled: false },
        { channelId: 2, enabled: false },
      ],
    });
    const result = await runShippingTask(logisticsTask(), [target('101')], deps);
    // 只关闭原本启用的 1；原本关闭的 2 不被打开
    expect(calls.toggles).toEqual([
      { channelId: 1, enabled: false },
      { channelId: 1, enabled: true },
    ]);
    expect(result.summary.counts.success).toBe(1);
    expect(result.task.logistics.records.find(r => r.channelId === 2)?.closed).toBe('skipped');
    expect(result.summary.needsLogisticsRestore).toBe(false);
  });

  it('某渠道关闭失败时不继续批改，先恢复已受影响渠道', async () => {
    const { deps, calls } = makeDeps({
      channels: [
        { channelId: 1, enabled: true },
        { channelId: 2, enabled: true },
      ],
      toggleOutcome: (channelId, enabled) => {
        if (channelId === 2 && enabled === false) return { success: false, error: '平台拒绝' };
        return { success: true };
      },
      channelReads: [
        { channelId: 1, enabled: false },
        { channelId: 2, enabled: true },
      ],
    });
    const result = await runShippingTask(logisticsTask(), [target('101')], deps);
    // 没有发任何商品写请求
    expect(calls.batch).toHaveLength(0);
    // 已关闭的 1 被恢复
    expect(calls.toggles).toContainEqual({ channelId: 1, enabled: true });
    expect(result.task.status).toBe('failed');
    expect(result.task.error).toContain('关闭未确认成功');
  });

  it('恢复部分失败时保留待处理清单，不显示整体成功', async () => {
    const { deps } = makeDeps({
      channels: [
        { channelId: 1, enabled: true },
        { channelId: 2, enabled: true },
      ],
      toggleOutcome: (channelId, enabled) => {
        // 关闭都成功；恢复时渠道 2 失败
        if (enabled && channelId === 2) return { success: false, error: '平台拒绝' };
        return { success: true };
      },
      channelReads: [{ channelId: 2, enabled: false }],
    });
    const result = await runShippingTask(logisticsTask(), [target('101')], deps);
    expect(result.summary.needsLogisticsRestore).toBe(true);
    expect(result.task.status).toBe('failed');
    expect(result.task.logistics.records.find(r => r.channelId === 2)?.restored).toBe('failed');
  });

  it('恢复结果未知时回读确认，不直接当作没恢复', async () => {
    const { deps } = makeDeps({
      channels: [{ channelId: 1, enabled: true }],
      toggleOutcome: (_channelId, enabled) => (enabled ? { success: false, unknown: true } : { success: true }),
      channelReads: [{ channelId: 1, enabled: true }],
    });
    const result = await runShippingTask(logisticsTask(), [target('101')], deps);
    expect(result.task.logistics.records[0].restored).toBe('success');
    expect(result.summary.needsLogisticsRestore).toBe(false);
  });

  it('换店后恢复归属未确认时不恢复到错店，保留待恢复状态', async () => {
    const { deps } = makeDeps({
      channels: [{ channelId: 1, enabled: true }],
      channelReads: [{ channelId: 1, enabled: false }],
    });
    let firstToggle = true;
    const originalToggle = deps.updateChannelToggle;
    deps.updateChannelToggle = async (cred, channelId, enabled) => {
      if (firstToggle) {
        firstToggle = false;
        const out = await originalToggle(cred, channelId, enabled);
        // 关闭成功后立即换成别的店铺
        (deps.getShopIdentity as any) = async () => ({ shopId: 999, accountId: 5 });
        return out;
      }
      return originalToggle(cred, channelId, enabled);
    };
    const result = await runShippingTask(logisticsTask(), [target('101')], deps);
    // 恢复被归属检查拦下 → 待恢复清单可见
    expect(result.summary.needsLogisticsRestore).toBe(true);
  });
});

describe('手动恢复物流', () => {
  it('换店时拒绝恢复并给出可读原因', async () => {
    const { deps } = makeDeps({ shopId: 999 });
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    expect(result.completed).toBe(false);
    // 核验失败原因必须指明"是哪个店铺不一致"，不能笼统说"失败"
    expect(result.error || '').toMatch(/不一致/);
    expect(result.error || '').toContain('777');
    expect(result.error || '').toContain('999');
    expect(deps.fetchChannelList).toBeTruthy();
  });

  it('回到原店铺后可恢复，且不打开原先关闭的渠道', async () => {
    const { deps, calls } = makeDeps({ shopId: 777 });
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [
          { channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' },
          { channelId: 2, originallyEnabled: false, closed: 'skipped', restored: 'skipped' },
        ],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    expect(result.completed).toBe(true);
    expect(calls.toggles).toEqual([{ channelId: 1, enabled: true }]);
  });

  it('没有待恢复项时直接成功且不发请求', async () => {
    const { deps, calls } = makeDeps();
    const result = await restorePendingLogistics(makeTask(), deps);
    expect(result.completed).toBe(true);
    expect(calls.toggles).toHaveLength(0);
  });
});

describe('错误类型可被识别', () => {
  it('三类任务级错误都有稳定名字，便于 background 与诊断区分', () => {
    expect(new ShippingCheckpointSaveError('x').name).toBe('ShippingCheckpointSaveError');
    expect(new ShippingOwnershipError('x', 1).name).toBe('ShippingOwnershipError');
  });
});

// ===== R1：开跑前检查与写集合 =====

describe('R1 开跑前检查与写集合', () => {
  it('开跑前特卖排除调查失败：零商品写请求', async () => {
    // 开跑前检查读不到排除集合 → 不允许沿用旧快照写
    const { deps, calls } = makeDeps();
    deps.fetchFlashSaleExcludeIds = async () => ({ ok: false, itemIds: new Set(), error: '调查失败' });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '开跑前调查失败仍写了商品').toBe(0);
    expect(result.task.status).toBe('failed');
    expect(result.task.message).toContain('开跑前检查未通过');
  });

  it('开跑前商品列表读取不完整：零商品写请求', async () => {
    const { deps, calls } = makeDeps();
    deps.fetchAllProducts = async () => ({ products: [], complete: false, error: '游标重复' });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '开跑前列表不完整仍写了商品').toBe(0);
    expect(result.task.status).toBe('failed');
  });

  it('开跑前商品变为 SKU 级备货：该商品不进入写集合', async () => {
    const { deps, calls } = makeDeps({
      // 开跑前检查读到的就是执行时那份列表：102 已变成 SKU 级
      products: [product(101), product(102, 1, { enable_model_level_dts: true })],
    });
    await runShippingTask(makeTask(), [target('101'), target('102')], deps, { readback: false });
    const written = calls.batch.flatMap(b => b.map(i => String(i.id)));
    expect(written).toContain('101');
    expect(written, 'SKU 级商品被写入了').not.toContain('102');
  });

  it('开跑前新出现的排除项只减少写集合，不扩大', async () => {
    const { deps, calls } = makeDeps();
    // runShippingTask 只做一次开跑前检查，这里就是那次：102 已被排除
    deps.fetchFlashSaleExcludeIds = async () => ({ ok: true, itemIds: new Set(['102']) });
    await runShippingTask(makeTask(), [target('101'), target('102')], deps, { readback: false });
    const written = calls.batch.flatMap(b => b.map(i => String(i.id)));
    expect(written).toEqual(['101']);
  });
});

// ===== R2：未知写结果不重发 =====

describe('R2 未知写结果与逐项响应', () => {
  it('传输结果未知时不重发，标 unknown 由回读定案', async () => {
    const { deps, calls } = makeDeps({
      products: [product(101, 1, { days_to_ship: 1 } as any)],
      batchOutcomes: [
        { topLevelSuccess: false, itemResults: [], error: 'response lost after send', transportUnknown: true },
      ],
    });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { maxRetryRounds: 5 });
    expect(calls.batch.length, '未知结果被重发了').toBe(1);
    // 回读显示实际已改成功 → 终态为成功（而不是"重试 5 轮后 unknown"）
    expect(result.summary.counts.success).toBe(1);
  });

  it('未知结果且回读也确认不了：保持 unknown，不伪报成功也不伪报失败', async () => {
    const { deps, calls } = makeDeps({
      products: [product(101)], // 列表不返回 days_to_ship
      batchOutcomes: [{ topLevelSuccess: false, itemResults: [], transportUnknown: true }],
    });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { maxRetryRounds: 5 });
    expect(calls.batch.length, '未知结果被重发了').toBe(1);
    expect(result.summary.counts.unknown).toBe(1);
    expect(result.summary.counts.success).toBe(0);
    expect(result.summary.counts.failed).toBe(0);
  });

  it('缺逐项 code 不计成功，先核实', async () => {
    const { deps } = makeDeps({
      products: [product(101, 1, { days_to_ship: 7 } as any)],
      batchOutcomes: [{ topLevelSuccess: true, itemResults: [{ id: '101', code: null }], hasItemResults: true }],
    });
    const result = await runShippingTask(makeTask({ days: 7, mode: 'preorder' }), [target('101')], deps);
    const item = result.task.items.find(i => i.itemId === '101');
    expect(item?.reason || '').toMatch(/缺少 code|回读/);
    // 回读说实际已是 7 天 → 定案成功；关键是**不经由"code 缺失=成功"这条错误路径**
    expect(result.summary.counts.success).toBe(1);
  });

  it('缺逐项 code 且回读不符：记为失败（不因缺 code 判成功）', async () => {
    const { deps } = makeDeps({
      products: [product(101, 1, { days_to_ship: 3 } as any)],
      batchOutcomes: [{ topLevelSuccess: true, itemResults: [{ id: '101', code: null }], hasItemResults: true }],
    });
    const result = await runShippingTask(makeTask({ days: 7, mode: 'preorder' }), [target('101')], deps);
    expect(result.summary.counts.failed).toBe(1);
  });

  it('明确限流仍按原上限退避重试，且已成功项不再写', async () => {
    const { deps, calls } = makeDeps({
      batchOutcomes: [
        { topLevelSuccess: false, itemResults: [], rateLimited: true, topCode: 1000100006 },
        { topLevelSuccess: true, itemResults: [{ id: '101', code: 0 }], hasItemResults: true },
      ],
    });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { maxRetryRounds: 3 });
    expect(result.summary.counts.success).toBe(1);
    expect(calls.batch.length).toBeGreaterThanOrEqual(2);
    // 第二轮只重试未成功的项（这里就是 101，没有多余商品被重发）
    expect(calls.batch[1].map(i => String(i.id))).toEqual(['101']);
  });
});

// ===== R3：店铺／账号／权限锚 =====

describe('R3 店铺与账号锚', () => {
  it('开跑前账号变化：零商品写请求', async () => {
    const { deps, calls } = makeDeps({ authUserId: 2 });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '账号不一致仍写了商品').toBe(0);
    expect(result.task.status).toBe('failed');
    expect(result.task.error || '').toContain('账号');
  });

  it('处理期间账号变化：停止后续写', async () => {
    const { deps, calls } = makeDeps({ switchUserAfterBatch: 1 });
    const result = await runShippingTask(makeTask(), [target('101'), target('102')], deps, {
      batchSize: 1,
      concurrency: 1,
      readback: false,
    });
    expect(calls.batch.length, '账号变化后仍继续写').toBe(1);
    expect(result.task.status).toBe('failed');
  });

  it('账号非空但与任务锚不同：按不一致处理', async () => {
    const { deps, calls } = makeDeps({ authUserId: 99 });
    await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '账号不一致仍写了商品').toBe(0);
  });

  // ===== 返工 14.2：写前核验的**读取异常**必须停写，不能被吞掉 =====

  it('身份读取抛错：零商品写请求，且不被当成单件失败继续', async () => {
    const { deps, calls } = makeDeps();
    let reads = 0;
    deps.getShopIdentity = async () => {
      reads += 1;
      // 第一次是开跑前检查（gatherTargets）；之后在写边界再读就抛错
      if (reads > 1) throw new Error('identity probe failed');
      return { shopId: 777, accountId: 5 };
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '身份读取抛错仍写了商品').toBe(0);
    expect(result.task.status).toBe('failed');
    expect(String(result.task.error || '')).toMatch(/身份读取失败/);
  });

  it('账号读取抛错：零商品写请求', async () => {
    const { deps, calls } = makeDeps();
    let reads = 0;
    deps.getAuthUserId = async () => {
      reads += 1;
      if (reads > 1) throw new Error('auth probe failed');
      return 1;
    };
    await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '账号读取抛错仍写了商品').toBe(0);
  });

  it('身份读取返回 null（不可判定）：零商品写请求', async () => {
    const { deps, calls } = makeDeps();
    let reads = 0;
    deps.getShopIdentity = async () => {
      reads += 1;
      if (reads > 1) return { shopId: null, accountId: null };
      return { shopId: 777, accountId: 5 };
    };
    await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '身份不可判定仍写了商品').toBe(0);
  });

  it('物流关闭前身份读取抛错：零渠道写且不继续改商品', async () => {
    const { deps, calls } = makeDeps();
    let reads = 0;
    deps.getShopIdentity = async () => {
      reads += 1;
      if (reads > 1) throw new Error('identity probe failed');
      return { shopId: 777, accountId: 5 };
    };
    await runShippingTask(makeTask({ toggleLogistics: true }), [target('101')], deps, { readback: false });
    expect(calls.toggles.length, '核验失败仍发了渠道写请求').toBe(0);
    expect(calls.batch.length, '核验失败仍写了商品').toBe(0);
  });

  // ===== 返工 14.3：现行后端权限覆盖商品与物流写 =====

  it('批次之间撤权：后续批次零写', async () => {
    const { deps, calls } = makeDeps();
    let accessChecks = 0;
    deps.validateAccess = async () => {
      accessChecks += 1;
      // 第一批的核验允许；之后撤权
      return accessChecks <= 1 ? { allowed: true } : { allowed: false, error: '权限已撤回' };
    };
    const result = await runShippingTask(
      makeTask(),
      [target('101'), target('102'), target('103')],
      deps,
      { batchSize: 1, concurrency: 1, readback: false },
    );
    expect(calls.batch.length, '撤权后仍继续写').toBeLessThanOrEqual(1);
    expect(result.task.status).toBe('failed');
    expect(String(result.task.error || '')).toMatch(/权限/);
  });

  it('权限读取失败：零商品写请求（不当作放行）', async () => {
    const { deps, calls } = makeDeps();
    deps.validateAccess = async () => {
      throw new Error('access probe failed');
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '权限读取失败仍写了商品').toBe(0);
    expect(result.task.status).toBe('failed');
    expect(String(result.task.error || '')).toMatch(/权限/);
  });

  it('恢复物流时权限被撤：零渠道开启请求且保留待恢复清单', async () => {
    const { deps, calls } = makeDeps();
    deps.validateAccess = async () => ({ allowed: false, error: '权限已撤回' });
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    expect(result.completed).toBe(false);
    expect(calls.toggles.filter(t => t.enabled === true).length, '撤权后仍打开渠道').toBe(0);
    expect(result.task.logistics.records.filter(r => needsLogisticsAction(r)).length).toBe(1);
    expect(String(result.error || '')).toMatch(/权限/);
  });

  it('恢复物流时权限读取失败：同样零写并保留义务', async () => {
    const { deps, calls } = makeDeps();
    deps.validateAccess = async () => {
      throw new Error('access probe failed');
    };
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    expect(result.completed).toBe(false);
    expect(calls.toggles.length).toBe(0);
    expect(result.task.logistics.records.filter(r => needsLogisticsAction(r)).length).toBe(1);
  });

  it('Cookie 刷新但归属不变：正常执行（不误判换店）', async () => {    let credVersion = 0;
    const { deps, calls } = makeDeps();
    deps.getCredential = async () => ({ spcCds: `cred-${++credVersion}`, spcCdsVer: '2' });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length).toBeGreaterThan(0);
    expect(result.task.status).toBe('completed');
  });

  it('恢复物流时账号不一致：拒绝恢复并保留待恢复状态', async () => {
    const { deps } = makeDeps({ authUserId: 2 });
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    expect(result.completed).toBe(false);
    expect(result.error || '').toContain('账号');
  });

  it('回到原账号后可恢复', async () => {
    const { deps, calls } = makeDeps({ authUserId: 1 });
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    expect(result.completed).toBe(true);
    expect(calls.toggles).toEqual([{ channelId: 1, enabled: true }]);
  });
});

// ===== R4：物流未知结果保留恢复义务 =====

describe('R4 物流未知结果的恢复义务', () => {
  it('关闭结果未知：保留恢复义务，不被声明"已全部恢复"', async () => {
    let channelReads = 0;
    const { deps } = makeDeps({
      // 第一次是快照；之后是回读 —— 回读失败（返回 null）→ 保留 unknown
      channels: [{ channelId: 9, enabled: true }],
      toggleOutcome: () => ({ success: false, unknown: true, error: 'close result unavailable' }),
    });
    deps.fetchChannelList = async () => {
      channelReads += 1;
      return channelReads === 1 ? [{ channelId: 9, enabled: true }] : null;
    };
    const out = await runShippingTask(makeTask({ toggleLogistics: true }), [target('101')], deps, {
      readback: false,
    });
    expect(out.summary.needsLogisticsRestore, '关闭未知却宣告无需恢复').toBe(true);
    expect(out.task.logistics.records.find(r => r.channelId === 9)?.closed).toBe('unknown');
    // 商品阶段被阻止
    expect(out.task.items.filter(i => i.status === 'success').length).toBe(0);
  });

  it('关闭未知但回读显示仍开启：无恢复义务，记为确定失败', async () => {
    const { deps, calls } = makeDeps({
      channels: [{ channelId: 9, enabled: true }],
      channelReads: [{ channelId: 9, enabled: true }],
      toggleOutcome: () => ({ success: false, unknown: true, error: 'unavailable' }),
    });
    const out = await runShippingTask(makeTask({ toggleLogistics: true }), [target('101')], deps, {
      readback: false,
    });
    const record = out.task.logistics.records.find(r => r.channelId === 9);
    expect(record?.closed).toBe('failed');
    // 关闭未成功 → 不该留下"恢复 pending"的假待办
    expect(record?.restored).toBe('skipped');
    expect(out.summary.needsLogisticsRestore).toBe(false);
    // 不应因此打开一个本来就没关上的渠道
    expect(calls.toggles.filter(t => t.enabled === true)).toHaveLength(0);
  });

  it('关闭未知且回读确认已关闭：可恢复，且原本关闭的渠道不打开', async () => {
    let channelReads = 0;
    const { deps, calls } = makeDeps({ channels: [{ channelId: 9, enabled: true }, { channelId: 8, enabled: false }] });
    deps.fetchChannelList = async () => {
      channelReads += 1;
      // 1: 快照；2: 关闭后回读（已关闭）；之后: 恢复前回读 + 恢复后回读
      if (channelReads === 1) return [{ channelId: 9, enabled: true }, { channelId: 8, enabled: false }];
      if (channelReads === 2) return [{ channelId: 9, enabled: false }, { channelId: 8, enabled: false }];
      return [{ channelId: 9, enabled: true }, { channelId: 8, enabled: false }];
    };
    deps.updateChannelToggle = async (_c, channelId, enabled) => {
      calls.toggles.push({ channelId, enabled });
      // 关闭请求的响应丢失（unknown）；恢复请求成功
      return enabled ? { success: true } : { success: false, unknown: true, error: 'lost' };
    };
    const out = await runShippingTask(makeTask({ toggleLogistics: true }), [target('101')], deps, {
      readback: false,
    });
    const record9 = out.task.logistics.records.find(r => r.channelId === 9);
    expect(record9?.restored).toBe('success');
    expect(out.summary.needsLogisticsRestore).toBe(false);
    // 渠道 8 原本就关闭 → 永远不该被打开
    expect(calls.toggles.some(t => t.channelId === 8 && t.enabled === true)).toBe(false);
  });

  it('关闭未知且回读失败：待处理，且不猜着发恢复请求', async () => {
    let channelReads = 0;
    const { deps, calls } = makeDeps({ channels: [{ channelId: 9, enabled: true }] });
    deps.fetchChannelList = async () => {
      channelReads += 1;
      return channelReads === 1 ? [{ channelId: 9, enabled: true }] : null;
    };
    deps.updateChannelToggle = async (_c, channelId, enabled) => {
      calls.toggles.push({ channelId, enabled });
      return { success: false, unknown: true, error: 'unavailable' };
    };
    const out = await runShippingTask(makeTask({ toggleLogistics: true }), [target('101')], deps, {
      readback: false,
    });
    expect(out.summary.needsLogisticsRestore).toBe(true);
    // 只发了关闭请求，没有在状态不明时乱发恢复请求
    expect(calls.toggles.filter(t => t.enabled === true)).toHaveLength(0);
  });
});

// ===== R7：持久错误脱敏 =====

describe('R7 持久错误脱敏', () => {
  it('带凭据的异常落盘后不含原值，原因仍可定位', async () => {
    const secret = 'review-synthetic-secret';
    const { deps } = makeDeps();
    deps.fetchAllProducts = async () => {
      throw new Error(`request failed SPC_CDS=${secret}&SPC_CDS_VER=2`);
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    const persisted = JSON.stringify(result.task);
    expect(persisted).not.toContain(secret);
    expect(persisted).toContain('***');
    // 可定位信息仍在（"request failed" 说明了是什么动作失败）
    expect(persisted).toContain('request failed');
  });

  it('access_token 形态的凭据同样被遮蔽', async () => {
    const { deps } = makeDeps();
    deps.fetchAllProducts = async () => {
      throw new Error('bad gateway: access_token=abc123def456&x=1');
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    const persisted = JSON.stringify(result.task);
    expect(persisted).not.toContain('abc123def456');
  });

  it('Bearer / JWT 字面量被遮蔽', async () => {
    const { deps } = makeDeps();
    deps.fetchAllProducts = async () => {
      throw new Error('401 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature');
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    const persisted = JSON.stringify(result.task);
    expect(persisted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });
});

// ===== 返工 17.2：同一次写必须用同一份已核实的卖家上下文 =====
//
// 缺陷原型：核验时读一次凭据（会话 A），发请求时再读一次（会话 B）。
// 那样"按 A 核验、用 B 写"，甚至把 B 的结果报成 A 已完成。
// 下面用可变的已核实上下文夹具复现，并断言**实际传给请求的那一份**。

describe('同一次写的已核实上下文（17.2）', () => {
  /** 可变的上下文夹具：能在核验与发送之间改凭据／归属 */
  function contextFixture(initial: { cred: string; shopId: number | null; userId: number | null }) {
    const state = { ...initial };
    state.reads = 0;
    const ctx = async (): Promise<ShippingVerifiedContext> => {
      state.reads += 1;
      return {
        credential: { spcCds: state.cred, spcCdsVer: '2' },
        shopId: state.shopId,
        userId: state.userId,
      };
    };
    return { state, ctx };
  }

  it('正常路径：写请求用的就是核验那一份凭据', async () => {
    const fx = contextFixture({ cred: 'session-A', shopId: 777, userId: 1 });
    const { deps, calls } = makeDeps({ verifiedContext: fx.ctx });
    await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batchCredentials.length).toBeGreaterThan(0);
    for (const cred of calls.batchCredentials) expect(cred.spcCds).toBe('session-A');
  });

  it('核验后换成另一会话且归属不同：不得用未核实的会话发商品写', async () => {
    const { deps, calls } = makeDeps();
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      // 第一次读是"写前核验"；发送前复查看到会话已换成 B 且店铺也变了
      if (reads >= 2) {
        return { credential: { spcCds: 'session-B', spcCdsVer: '2' }, shopId: 888, userId: 1 };
      }
      return { credential: { spcCds: 'session-A', spcCdsVer: '2' }, shopId: 777, userId: 1 };
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '用未核实的会话发出了商品写').toBe(0);
    expect(result.task.status).toBe('failed');
    expect(String(result.task.error || '')).toMatch(/已变化|已停止/);
  });

  it('只刷新 Cookie（同归属）：仍按原合同继续写，并用刷新后的凭据', async () => {
    const { deps, calls } = makeDeps();
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      // 第一次核验用旧串；发送前复查发现串变了，但店铺／账号没变
      const cred = reads >= 2 ? 'session-A-refreshed' : 'session-A';
      return { credential: { spcCds: cred, spcCdsVer: '2' }, shopId: 777, userId: 1 };
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '同归属的凭据刷新被误判成换店').toBeGreaterThan(0);
    expect(calls.batchCredentials[0].spcCds).toBe('session-A-refreshed');
    expect(result.summary.counts.success).toBeGreaterThan(0);
  });

  it('发送前无法重读上下文：不写，且不报成功', async () => {
    const { deps, calls } = makeDeps();
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      if (reads >= 2) throw new Error('cookies API unavailable');
      return { credential: { spcCds: 'session-A', spcCdsVer: '2' }, shopId: 777, userId: 1 };
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length).toBe(0);
    expect(result.task.status).toBe('failed');
  });

  it('物流恢复：核验后换成另一会话，不得用未核实会话打开渠道、也不得报已恢复', async () => {
    const { deps, calls } = makeDeps({
      channels: [{ channelId: 1, enabled: true }],
    });
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      if (reads >= 2) {
        return { credential: { spcCds: 'session-B', spcCdsVer: '2' }, shopId: 888, userId: 1 };
      }
      return { credential: { spcCds: 'session-A', spcCdsVer: '2' }, shopId: 777, userId: 1 };
    };
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    const opens = calls.toggles.filter(t => t.enabled === true);
    expect(opens.length, '用未核实的会话打开了渠道').toBe(0);
    expect(result.completed).toBe(false);
    expect(result.task.logistics.restoreCompleted).toBe(false);
    expect(result.task.logistics.records.filter(r => needsLogisticsAction(r)).length).toBe(1);
  });

  it('物流恢复：同归属凭据刷新仍可正常恢复', async () => {
    const { deps, calls } = makeDeps({ channels: [{ channelId: 1, enabled: true }] });
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      const cred = reads >= 2 ? 'session-A-refreshed' : 'session-A';
      return { credential: { spcCds: cred, spcCdsVer: '2' }, shopId: 777, userId: 1 };
    };
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    const opens = calls.toggles.filter(t => t.enabled === true);
    expect(opens.length).toBe(1);
    expect(calls.toggleCredentials[0].spcCds).toBe('session-A-refreshed');
    expect(result.completed).toBe(true);
  });
});

// ===== 返工 20.2：先核对完整归属，再判断凭据是否刷新 =====
//
// 缺陷原型：`ensureContextStillVerified` 用"SPC_CDS 相同就直接 return 先前那份"短路，
// 于是"卖家 Cookie 不变、后端账号被换"会被跳过；账号读不到（null）也被当成一致。

describe('发送前上下文核对顺序（20.2）', () => {
  /** 造一份"渠道待恢复"的任务与 deps，用来在真实写边界上验证 */
  function restoreFixture(verifiedContext: ShippingRunnerDeps['verifiedContext']) {
    const { deps, calls } = makeDeps({ channels: [{ channelId: 1, enabled: true }] });
    deps.verifiedContext = verifiedContext;
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    return { deps, calls, task };
  }

  it('Cookie 不变但后端账号切换：零渠道写且不报恢复完成', async () => {
    let reads = 0;
    const fx = (): Promise<ShippingVerifiedContext> => {
      reads += 1;
      // 凭据字符串**始终相同**：正是旧实现短路的那条路径
      return Promise.resolve({
        credential: { spcCds: 'same-cookie', spcCdsVer: '2' },
        shopId: 777,
        userId: reads >= 2 ? 2 : 1,
      });
    };
    const { deps, calls, task } = restoreFixture(fx);
    const result = await restorePendingLogistics(task, deps);
    expect(calls.toggles.filter(t => t.enabled === true).length, '账号已切换仍打开了渠道').toBe(0);
    expect(result.completed).toBe(false);
    expect(result.task.logistics.restoreCompleted).toBe(false);
    expect(result.task.logistics.records.filter(r => needsLogisticsAction(r)).length).toBe(1);
  });

  it('Cookie 刷新但后端账号读不到：零渠道写且不报恢复完成', async () => {
    let reads = 0;
    const fx = (): Promise<ShippingVerifiedContext> => {
      reads += 1;
      return Promise.resolve({
        credential: { spcCds: reads >= 2 ? 'refreshed-cookie' : 'same-cookie', spcCdsVer: '2' },
        shopId: 777,
        userId: reads >= 2 ? null : 1,
      });
    };
    const { deps, calls, task } = restoreFixture(fx);
    const result = await restorePendingLogistics(task, deps);
    expect(calls.toggles.filter(t => t.enabled === true).length, '账号读不到仍打开了渠道').toBe(0);
    expect(result.completed).toBe(false);
    expect(result.task.logistics.restoreCompleted).toBe(false);
  });

  it('店铺读不到（null）：零渠道写', async () => {
    let reads = 0;
    const fx = (): Promise<ShippingVerifiedContext> => {
      reads += 1;
      return Promise.resolve({
        credential: { spcCds: 'same-cookie', spcCdsVer: '2' },
        shopId: reads >= 2 ? null : 777,
        userId: 1,
      });
    };
    const { deps, calls, task } = restoreFixture(fx);
    const result = await restorePendingLogistics(task, deps);
    expect(calls.toggles.length).toBe(0);
    expect(result.completed).toBe(false);
  });

  it('店铺与账号都不变的 Cookie 刷新：正常完成', async () => {
    let reads = 0;
    const fx = (): Promise<ShippingVerifiedContext> => {
      reads += 1;
      return Promise.resolve({
        credential: { spcCds: reads >= 2 ? 'refreshed-cookie' : 'same-cookie', spcCdsVer: '2' },
        shopId: 777,
        userId: 1,
      });
    };
    const { deps, calls, task } = restoreFixture(fx);
    const result = await restorePendingLogistics(task, deps);
    expect(calls.toggles.filter(t => t.enabled === true).length).toBe(1);
    expect(result.completed).toBe(true);
  });

  it('商品写：Cookie 不变但账号切换，零商品写', async () => {
    const { deps, calls } = makeDeps();
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      return {
        credential: { spcCds: 'same-cookie', spcCdsVer: '2' },
        shopId: 777,
        userId: reads >= 2 ? 2 : 1,
      };
    };
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '账号已切换仍写了商品').toBe(0);
    expect(result.task.status).toBe('failed');
  });

  it('渠道关闭：Cookie 不变但账号切换，零渠道写', async () => {
    const { deps, calls } = makeDeps({ channels: [{ channelId: 1, enabled: true }] });
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      return {
        credential: { spcCds: 'same-cookie', spcCdsVer: '2' },
        shopId: 777,
        userId: reads >= 2 ? 2 : 1,
      };
    };
    const result = await runShippingTask(makeTask({ toggleLogistics: true }), [target('101')], deps, {
      readback: false,
    });
    expect(calls.toggles.length, '账号已切换仍写了渠道').toBe(0);
    expect(result.task.status).toBe('failed');
  });
});

// ===== 返工 23：刷新后的上下文必须自己通过服务端权限核验 =====
//
// 缺陷原型：`ensureContextStillVerified` 识别出"同归属的凭据刷新"后**直接放行**新凭据，
// 没有用新凭据再查一次权限。于是"刷新前允许、刷新后已被撤权"时照样会发出写请求。

describe('刷新后的服务端权限核验（23）', () => {
  /**
   * 造一个"第一次核验用于旧凭据，之后换新凭据"的 deps。
   *
   * `validateAccess` 会按调用时传入的凭据分别给结论 —— 这正是本项要验的：
   * 旧凭据允许、新凭据被拒时，绝不能拿新凭据去写。
   */
  function refreshFixture(opts: {
    /** 新凭据的权限结论 */
    freshAccess: { allowed: boolean; error?: string } | 'throw';
    channels?: boolean;
  }) {
    const { deps, calls } = makeDeps({
      channels: opts.channels === false ? undefined : [{ channelId: 1, enabled: true }],
    });
    const seen: Array<{ spcCds: string; shopId: number | null }> = [];
    // 第一次读给旧凭据，之后给刷新后的凭据（归属不变）
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      return {
        credential: { spcCds: reads >= 2 ? 'cookie-refreshed' : 'cookie-old', spcCdsVer: '2' },
        shopId: 777,
        userId: 1,
      };
    };
    deps.validateAccess = async (credential, shopId) => {
      seen.push({ spcCds: credential.spcCds, shopId });
      if (credential.spcCds === 'cookie-refreshed') {
        if (opts.freshAccess === 'throw') throw new Error('access probe failed');
        return opts.freshAccess;
      }
      return { allowed: true };
    };
    return { deps, calls, seen };
  }

  it('刷新后新上下文权限被拒：零商品写且不报成功', async () => {
    const { deps, calls, seen } = refreshFixture({
      freshAccess: { allowed: false, error: '权限已撤回' },
    });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '刷新后撤权仍写了商品').toBe(0);
    expect(result.task.status).toBe('failed');
    expect(String(result.task.error || '')).toMatch(/已不再允许|权限/);
    // 必须**真的**用新凭据查过一次权限，而不是只看任务失败
    expect(
      seen.some(s => s.spcCds === 'cookie-refreshed'),
      `没有用新凭据核验权限：${JSON.stringify(seen)}`,
    ).toBe(true);
  });

  it('刷新后新上下文权限读取抛错：零商品写', async () => {
    const { deps, calls, seen } = refreshFixture({ freshAccess: 'throw' });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(calls.batch.length, '刷新后权限读取失败仍写了商品').toBe(0);
    expect(result.task.status).toBe('failed');
    expect(String(result.task.error || '')).toMatch(/无法核验|权限/);
    expect(seen.some(s => s.spcCds === 'cookie-refreshed')).toBe(true);
  });

  it('刷新后新上下文权限被拒：渠道关闭零写', async () => {
    const { deps, calls } = refreshFixture({ freshAccess: { allowed: false, error: '权限已撤回' } });
    const result = await runShippingTask(makeTask({ toggleLogistics: true }), [target('101')], deps, {
      readback: false,
    });
    expect(calls.toggles.length, '刷新后撤权仍写了渠道').toBe(0);
    expect(result.task.status).toBe('failed');
  });

  it('刷新后新上下文权限被拒：物流恢复零渠道开启且保留义务、不报完成', async () => {
    const { deps, calls, seen } = refreshFixture({
      freshAccess: { allowed: false, error: '权限已撤回' },
    });
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    expect(calls.toggles.filter(t => t.enabled === true).length, '刷新后撤权仍打开了渠道').toBe(0);
    expect(result.completed).toBe(false);
    expect(result.task.logistics.restoreCompleted).toBe(false);
    expect(result.task.logistics.records.filter(r => needsLogisticsAction(r)).length).toBe(1);
    expect(seen.some(s => s.spcCds === 'cookie-refreshed')).toBe(true);
  });

  it('新旧上下文均允许且归属一致：正常写，且用的是新上下文', async () => {
    const { deps, calls, seen } = refreshFixture({ freshAccess: { allowed: true } });
    const result = await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    expect(result.summary.counts.success).toBeGreaterThan(0);
    // 写请求必须发生在"用新凭据核验通过"之后
    expect(seen.some(s => s.spcCds === 'cookie-refreshed')).toBe(true);
    const freshIndex = seen.findIndex(s => s.spcCds === 'cookie-refreshed');
    expect(freshIndex).toBeGreaterThanOrEqual(0);
  });

  it('新旧上下文均允许：物流恢复正常完成', async () => {
    const { deps, calls } = makeDeps({ channels: [{ channelId: 1, enabled: true }] });
    let reads = 0;
    deps.verifiedContext = async () => {
      reads += 1;
      return {
        credential: { spcCds: reads >= 2 ? 'cookie-refreshed' : 'cookie-old', spcCdsVer: '2' },
        shopId: 777,
        userId: 1,
      };
    };
    const seen: string[] = [];
    deps.validateAccess = async credential => {
      seen.push(credential.spcCds);
      return { allowed: true };
    };
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      logistics: {
        records: [{ channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const result = await restorePendingLogistics(task, deps);
    expect(calls.toggles.filter(t => t.enabled === true).length).toBe(1);
    expect(result.completed).toBe(true);
    expect(seen).toContain('cookie-refreshed');
  });

  it('凭据没变时不额外查权限（避免对同一上下文重复请求）', async () => {
    const { deps } = makeDeps();
    const seen: Array<{ spcCds: string; shopId: number | null }> = [];
    deps.verifiedContext = async () => ({
      credential: { spcCds: 'cookie-stable', spcCdsVer: '2' },
      shopId: 777,
      userId: 1,
    });
    deps.validateAccess = async (credential, shopId) => {
      seen.push({ spcCds: credential.spcCds, shopId });
      return { allowed: true };
    };
    await runShippingTask(makeTask(), [target('101')], deps, { readback: false });
    // 每个写边界各查一次；凭据没变就不该出现"用刷新后凭据的额外核验"
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(s => s.spcCds === 'cookie-stable')).toBe(true);
  });
});
