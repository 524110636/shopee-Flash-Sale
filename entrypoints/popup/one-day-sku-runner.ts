/**
 * 一键修复（1 天备货 SKU）的后台执行 runner。
 *
 * 为什么单独成模块：修复循环原先写在 popup store 里，关闭弹窗即被回收，进度消失且剩余商品不再处理。
 * 这里把循环与结果准备搬到与 popup 无关的地方，popup 只负责启动、读状态和编辑结果。
 *
 * 约束：
 * - 只依赖注入进来的 fetch/存储/保活函数，不 import Zustand、React 或 DOM，因此 background 与单测可共用；
 * - 业务步骤与旧 popup 循环逐条对应（已有 1 天备货 SKU 跳过、100 SKU 上限、2 秒等待、5 倍价格重试、
 *   最多 3 次重取商品、折扣恢复逐项检查），不新增算法；
 * - 修复结束只停在「待编辑」，不创建活动、不开启特卖、不消耗试用；
 * - 每个写请求「发出前」先落检查点并保存，保存失败即停止后续写请求。
 */

import {
  buildOneDaySkuProductInfo,
  buildDiscountRestoreList,
  extractSellerDiscounts,
  getDiscountRatio,
  getHighestModelPrice,
  hasAnyOneDayDeliverySku,
  hasDedicatedOneDaySku,
  isFiveTimesPriceError,
} from './one-day-sku';
import { patchRepairTask, isSameOwner, isTerminalRepairStatus, type RepairProgressInput } from './one-day-sku-task';
import type { OneDayRepairTask, OneDaySkuItemStatus, ShopeeProduct } from './types';

const GET_PRODUCT_INFO = 'https://seller.shopee.tw/api/v3/product/get_product_info';
const UPDATE_PRODUCT_INFO = 'https://seller.shopee.tw/api/v3/product/update_product_info';
const DISCOUNT_SEARCH = 'https://seller.shopee.tw/api/marketing/v3/public/discount/search/';
const DISCOUNT_REMOVE = 'https://seller.shopee.tw/api/marketing/v4/discount/delete_abnormal_seller_discount_items/';
const DISCOUNT_RESTORE = 'https://seller.shopee.tw/api/marketing/v4/discount/update_seller_discount_items/';

/** 关键写请求的检查点步骤名，用于中断后说明「哪些商品可能已被改动」 */
export const REPAIR_STEP = {
  publish: 'update_product_info',
  removeDiscount: 'delete_abnormal_seller_discount_items',
  restoreDiscount: 'update_seller_discount_items',
} as const;

/** 保存进度失败：此时不得继续发新的写请求 */
export class RepairCheckpointSaveError extends Error {
  constructor(cause: unknown) {
    super(`保存修复进度失败，已停止后续商品写请求：${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'RepairCheckpointSaveError';
  }
}

/**
 * 归属/凭据不再匹配：任务级停止，不能被逐商品 catch 吞掉。
 * 与「这件商品本身失败」不同，这是"不应该继续在同一批里写"的信号。
 *
 * 携带**实际核实到的**身份，供最小脱敏错误捕获记录"任务锚 vs 实际锚"。
 */
export class RepairOwnershipError extends Error {
  readonly actualShopId: number | null;
  readonly actualUserId: number | null;
  constructor(message: string, actual: { actualShopId: number | null; actualUserId: number | null }) {
    super(message);
    this.name = 'RepairOwnershipError';
    this.actualShopId = actual.actualShopId;
    this.actualUserId = actual.actualUserId;
  }
}

/**
 * 权威记录已被标记终态/中断：本实例的迟到写入必须放弃。
 * 这是「心跳/进度不能把终态拉回运行中」的落地检查（BR5）。
 */
export class RepairStaleWriteError extends Error {
  constructor(status: string) {
    super(`修复任务已被标记为 ${status}，本实例停止写入以避免状态回退`);
    this.name = 'RepairStaleWriteError';
  }
}

/** 任务级故障：必须中断整批，而不是记成单件商品失败 */
function isTaskLevelError(e: unknown): boolean {
  return e instanceof RepairCheckpointSaveError || e instanceof RepairOwnershipError || e instanceof RepairStaleWriteError;
}

/**
 * 由逐项状态反推「已确认产生的副作用」，用于最小脱敏诊断。
 *
 * 只描述**已确认**的动作（写请求已发出且已收到成功响应），不含任何凭据或活动正文。
 * 恢复失败/结果未知时明确标出，避免用户误以为"没改过"。
 */
export function describeConfirmedActions(item: OneDaySkuItemStatus): string[] {
  const actions: string[] = [];
  if (item.discountRemoved) actions.push('已从折扣活动移除商品');
  if (item.skuCreated) actions.push('已新增 1 天备货 SKU');
  if (item.publishStatus === 'success') actions.push('已发布商品');
  if (item.discountRestored) actions.push('已恢复折扣');
  else if (item.discountRemoved) actions.push('折扣未确认恢复');
  return actions;
}

export interface RepairRunnerDeps {
  /** 在 MAIN world 注入执行，不依赖 popup 的活跃标签页 */
  injectedFetch: <T>(url: string, method?: 'GET' | 'POST', body?: object) => Promise<T>;
  /** 当前 Cookie 中的凭据；每个商品开始前重新读取，不固定使用启动时的旧值 */
  getCredential: () => Promise<{ spcCds: string; spcCdsVer: string }>;
  /**
   * 当前实际登录的店铺与后端账号。
   * `shopId` 必须来自实际核实；核实不到要返回 null —— 调用方据此停止写请求，
   * 不允许把「查不到」当成「与任务一致」。
   */
  getShopIdentity: () => Promise<{ shopId: number | null; accountId: number | null }>;
  /**
   * 当前认证的后端账号 id（用于与任务 ownerUserId 比对；与虾皮 accountId 不同域）。
   * 取不到就返回 null；缺失时按「未知」处理，不影响店铺核对。
   * 返回 Promise：调用方必须现读当前认证，不能用启动时的快照（BR1）。
   */
  getAuthUserId?: () => Promise<number | null>;
  /** 按商品 ID 取回完整商品（含最新 SKU），用于准备可编辑结果 */
  fetchProductsByIds: (itemIds: string[]) => Promise<ShopeeProduct[]>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 持久保存任务；必须真正落盘，失败要抛错 */
  saveTask: (task: OneDayRepairTask) => Promise<void>;
  /** 读取当前权威记录；用于在写入前确认没有更新的状态（防迟到写入回退） */
  loadTask?: () => Promise<OneDayRepairTask | null>;
  /** 任务活动期间的有界保活 */
  startKeepalive: () => void;
  stopKeepalive: () => void;
  /**
   * 逐商品失败的回调（用于最小脱敏诊断；可选）。
   * 只上报定位所需字段，不得传凭据。
   */
  onItemFailed?: (info: { itemId: string; reason: string; confirmedActions: string[] }) => void;
}

export interface RunRepairOptions {
  /** 覆盖默认的 2 秒防抖等待，单测可设为 0 */
  debounceMs?: number;
}

export function buildInitialItems(products: ShopeeProduct[]): OneDaySkuItemStatus[] {
  return products.map(product => ({
    itemId: product.itemid,
    itemName: product.name,
    hasOneDaySku: hasDedicatedOneDaySku(product),
    skuCreated: false,
    publishStatus: 'idle',
    discountRemoved: false,
    discountRestored: false,
    flashSaleStatus: 'idle',
    highestPrice: getHighestModelPrice(product),
  }));
}

/** 与原 popup 循环一致：同值取该值，不同值取平均，四舍五入为百分比整数 */
export function resolveDiscountRate(ratios: number[]): number | null {
  if (ratios.length === 0) return null;
  const allSame = ratios.every(r => r === ratios[0]);
  if (allSame) return Math.round(ratios[0] * 100);
  const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return Math.round(avg * 100);
}

interface RepairedItem {
  item: OneDaySkuItemStatus;
  /** 本商品贡献的折扣率（用于完成后设置全局折扣率）；null 表示无折扣 */
  ratio: number | null;
}

/**
 * 执行一件商品的完整修复：取详情 → 构建 → 搜索并移除折扣 → 发布 → 恢复折扣。
 * 失败以 item.error 呈现并返回，保持「逐商品失败不影响其他商品」的旧行为；
 * 只有「保存进度失败」这类任务级故障才抛异常。
 */
async function repairOneProduct(
  product: ShopeeProduct,
  deps: RepairRunnerDeps,
  checkpoint: (patch: RepairProgressInput) => Promise<void>,
  assertOwnership: () => Promise<void>,
  debounceMs: number,
): Promise<RepairedItem> {
  const productId = Number(product.itemid);
  const base: OneDaySkuItemStatus = {
    itemId: product.itemid,
    itemName: product.name,
    hasOneDaySku: hasDedicatedOneDaySku(product),
    skuCreated: false,
    publishStatus: 'idle',
    discountRemoved: false,
    discountRestored: false,
    flashSaleStatus: 'idle',
    highestPrice: getHighestModelPrice(product),
  };
  const fail = (error: string, extra: Partial<OneDaySkuItemStatus> = {}): RepairedItem => ({
    item: { ...base, ...extra, publishStatus: 'failed', error },
    ratio: null,
  });

  const cred = await deps.getCredential();
  if (!cred.spcCds) return fail('凭据已失效（Cookie 中找不到 SPC_CDS），请重新连接店铺');
  const qs = `SPC_CDS=${cred.spcCds}&SPC_CDS_VER=${cred.spcCdsVer}`;

  // Step 1: 商品详情
  const getUrl = `${GET_PRODUCT_INFO}?${qs}&product_id=${productId}&is_draft=false`;
  const getResp = await deps.injectedFetch<any>(getUrl);
  const productInfo = getResp?.data?.product_info;
  if (!productInfo) throw new Error('获取商品详情返回数据为空');

  const originalModelList: Record<string, any>[] = Array.isArray(productInfo.model_list) ? productInfo.model_list : [];

  // 已有任意 1 天备货 SKU：不重复新增，直接进入后续编辑→限时特卖流程
  if (hasAnyOneDayDeliverySku(originalModelList)) {
    return {
      item: {
        ...base,
        hasOneDaySku: true,
        skuCreated: false,
        publishStatus: 'success',
        highestPrice: getHighestModelPrice(product, originalModelList),
      },
      ratio: getDiscountRatio(originalModelList),
    };
  }

  // Step 2: 构造更新请求
  let buildResult;
  try {
    buildResult = buildOneDaySkuProductInfo(product, productInfo);
  } catch (buildErr: any) {
    throw new Error(`构造更新请求失败: ${buildErr?.message || buildErr}`, { cause: buildErr });
  }

  // Step 3: 搜索折扣活动（发布前，确保后续可恢复）
  const searchBody = { discount_type: 0, time_status: 0, keyword: product.itemid, search_type: 2 };
  const search = async () =>
    extractSellerDiscounts(await deps.injectedFetch<any>(`${DISCOUNT_SEARCH}?${qs}`, 'POST', searchBody));
  let discounts = await search();

  /** 移除折扣；返回第一个未确认成功的活动信息，`null` 表示全部确认成功 */
  const removeFromDiscounts = async (
    list: typeof discounts,
  ): Promise<{
    failedName: string | null;
    failedStatus: 'failed' | 'unknown' | null;
    results: NonNullable<OneDaySkuItemStatus['discountRemovals']>;
  }> => {
    const removeUrl = `${DISCOUNT_REMOVE}?${qs}`;
    const results: NonNullable<OneDaySkuItemStatus['discountRemovals']> = [];
    for (let di = 0; di < list.length; di++) {
      if (di > 0) await deps.sleep(debounceMs);
      // 每个写请求前都核对归属：切店/换账号后绝不继续写
      await assertOwnership();
      // 写请求发出前先落检查点：中断时据此说明该商品可能已被改动
      await checkpoint({
        checkpoint: {
          itemId: product.itemid,
          step: REPAIR_STEP.removeDiscount,
          writeSent: true,
          promotionId: list[di].promotionId,
          promotionName: list[di].name,
          at: deps.now(),
        },
      });
      let resp: any;
      try {
        resp = await deps.injectedFetch<any>(removeUrl, 'POST', {
          promotion_id: list[di].promotionId,
          item_id_list: [productId],
        });
      } catch (e: any) {
        // 传输异常：这一份折扣"改没改成功"未知。
        // **未知不等于成功**：不能继续发布/恢复（那是拿不确定状态去改商品），
        // 必须停止本商品并保留"前面哪几份已确认移除、这一份未知"。
        if (isTaskLevelError(e)) throw e;
        results.push({ promotionId: list[di].promotionId, name: list[di].name, status: 'unknown' });
        await checkpoint({
          checkpoint: {
            itemId: product.itemid,
            step: REPAIR_STEP.removeDiscount,
            writeSent: true,
            promotionId: list[di].promotionId,
            promotionName: list[di].name,
            outcome: 'unknown',
            at: deps.now(),
          },
          workItem: {
            ...base,
            discounts,
            discountRemoved: results.some(r => r.status === 'success'),
            discountRemovals: [...results],
          },
        });
        return { failedName: list[di].name, failedStatus: 'unknown', results };
      }
      if (resp?.error !== 0) {
        results.push({ promotionId: list[di].promotionId, name: list[di].name, status: 'failed' });
        // 逐活动结果立即落盘：成功的部分不能被后面的失败盖掉
        await checkpoint({
          checkpoint: {
            itemId: product.itemid,
            step: REPAIR_STEP.removeDiscount,
            writeSent: true,
            promotionId: list[di].promotionId,
            promotionName: list[di].name,
            at: deps.now(),
          },
          // discountRemoved 只在"确有活动被确认移除"时才为真，避免第一份就失败却记成已移除
          workItem: {
            ...base,
            discounts,
            discountRemoved: results.some(r => r.status === 'success'),
            discountRemovals: [...results],
          },
        });
        return { failedName: list[di].name, failedStatus: 'failed', results };
      }
      results.push({ promotionId: list[di].promotionId, name: list[di].name, status: 'success' });
      // 每个成功副作用后立刻记录"哪个活动已确认改成功"
      await checkpoint({
        checkpoint: {
          itemId: product.itemid,
          step: REPAIR_STEP.removeDiscount,
          writeSent: true,
          promotionId: list[di].promotionId,
          promotionName: list[di].name,
          outcome: 'success',
          at: deps.now(),
        },
        workItem: { ...base, discounts, discountRemoved: true, discountRemovals: [...results] },
      });
    }
    return { failedName: null, failedStatus: null, results };
  };

  /** 移除未确认成功时的统一收尾：保留逐活动证据，说明要人工核对哪一份 */
  const removalFailure = (
    withDiscountsIn: OneDaySkuItemStatus,
    removal: { failedName: string; failedStatus: 'failed' | 'unknown'; results: NonNullable<OneDaySkuItemStatus['discountRemovals']> },
  ): RepairedItem => {
    const partial: OneDaySkuItemStatus = {
      ...withDiscountsIn,
      discountRemoved: removal.results.some(r => r.status === 'success'),
      discountRemovals: removal.results,
    };
    const prefix = removal.failedStatus === 'unknown'
      ? `折扣活动"${removal.failedName}"的移除结果未知（请求异常）`
      : `无法从折扣活动"${removal.failedName}"中移除商品`;
    const suffix = partial.discountRemoved ? '（另有折扣活动已确认移除成功，请一并核对）' : '';
    return {
      item: {
        ...partial,
        publishStatus: 'failed',
        error: `${prefix}，已停止本商品（未发布、未恢复折扣）。请到折扣活动页面人工核对后再重试。${suffix}`,
      },
      ratio: null,
    };
  };
  let withDiscounts: OneDaySkuItemStatus = base;
  let discountRemoved = false;

  if (discounts.length > 0) {
    withDiscounts = { ...base, discounts };
    // 先把「搜到哪些折扣」落盘：发布失败或中断时，用户仍能看到该商品的真实状态与活动信息
    await checkpoint({ workItem: withDiscounts });
    const removal = await removeFromDiscounts(discounts);
    if (removal.failedName && removal.failedStatus) {
      const result = removalFailure(withDiscounts, {
        failedName: removal.failedName,
        failedStatus: removal.failedStatus,
        results: removal.results,
      });
      await checkpoint({ workItem: result.item });
      return result;
    }
    discountRemoved = true;
    withDiscounts = { ...withDiscounts, discountRemoved: true, discountRemovals: removal.results };
    // 已移除的折扣信息必须保存，否则发布失败后无法恢复、也说不清改过什么
    await checkpoint({ workItem: withDiscounts });
    // 原行为：移除折扣后等 2 秒再发布，给平台侧处理时间
    await deps.sleep(debounceMs);
  }

  /** 把已发生的部分修改写进 item，避免异常路径回退成初始状态 */
  const withEvidence = (patch: Partial<OneDaySkuItemStatus> = {}): OneDaySkuItemStatus => ({
    ...withDiscounts,
    discountRemoved,
    ...patch,
  });

  // Step 4: 发布商品
  const updateUrl = `${UPDATE_PRODUCT_INFO}?${qs}`;
  const attemptPublish = async (): Promise<{ code: number; msg?: string }> => {
    await assertOwnership();
    await checkpoint({
      checkpoint: { itemId: product.itemid, step: REPAIR_STEP.publish, writeSent: true, at: deps.now() },
      workItem: withEvidence(),
    });
    const resp = await deps.injectedFetch<any>(updateUrl, 'POST', {
      product_id: productId,
      product_info: buildResult.productInfo,
      is_draft: false,
    });
    return { code: resp?.code ?? -1, msg: resp?.msg || resp?.user_message };
  };

  let publishResult: { code: number; msg?: string };
  try {
    publishResult = await attemptPublish();
  } catch (e: any) {
    // 传输层异常同样是「已经改过商品」的证据，不能回退成初始 item
    if (isTaskLevelError(e)) throw e;
    await checkpoint({ workItem: withEvidence() });
    return fail(e?.message || '发布请求失败', withEvidence());
  }

  // 5 倍价格差且发布前没搜到折扣：重新搜索并移除后重试一次（原行为）
  if (publishResult.code !== 0 && isFiveTimesPriceError(publishResult.msg) && discounts.length === 0) {
    discounts = await search();
    if (discounts.length === 0) {
      return fail(`价格差距过大（>5倍），但未搜索到该商品的折扣活动。${publishResult.msg || ''}`);
    }
    withDiscounts = { ...withDiscounts, discounts };
    await checkpoint({ workItem: withDiscounts });
    const retryRemoval = await removeFromDiscounts(discounts);
    if (retryRemoval.failedName && retryRemoval.failedStatus) {
      const result = removalFailure(withDiscounts, {
        failedName: retryRemoval.failedName,
        failedStatus: retryRemoval.failedStatus,
        results: retryRemoval.results,
      });
      await checkpoint({ workItem: result.item });
      return result;
    }
    discountRemoved = true;
    withDiscounts = { ...withDiscounts, discountRemoved: true, discountRemovals: retryRemoval.results };
    await checkpoint({ workItem: withEvidence() });
    await deps.sleep(debounceMs);
    try {
      publishResult = await attemptPublish();
    } catch (e: any) {
      if (isTaskLevelError(e)) throw e;
      await checkpoint({ workItem: withEvidence() });
      return fail(e?.message || '发布请求失败', withEvidence());
    }
  }

  const detectedRatio = getDiscountRatio(originalModelList);
  let discountRestored = false;
  let restoreError: string | null = null;

  // Step 5: 恢复折扣（发布成功才恢复；先重取商品以拿到新增 SKU 的 id）
  if (publishResult.code === 0 && discounts.length > 0) {
    let updatedModelList: Record<string, any>[] = originalModelList;
    for (let retry = 0; retry < 3; retry++) {
      if (retry > 0) await deps.sleep(1000);
      try {
        const resp = await deps.injectedFetch<any>(getUrl);
        const freshList = resp?.data?.product_info?.model_list;
        if (resp?.code === 0 && Array.isArray(freshList) && freshList.length > 0) {
          updatedModelList = freshList;
          break;
        }
      } catch {
        // 重取失败沿用上一次的 model 列表，与原行为一致
      }
    }

    const restoreEntries = buildDiscountRestoreList(updatedModelList, productId, detectedRatio ?? undefined);
    if (restoreEntries.length > 0) {
      await deps.sleep(debounceMs);
      const restoreUrl = `${DISCOUNT_RESTORE}?${qs}`;
      for (let di = 0; di < discounts.length; di++) {
        if (di > 0) await deps.sleep(debounceMs);
        try {
          await assertOwnership();
          // 恢复请求发出前落盘：此时商品**已发布成功**，这一事实必须留证据，
          // 否则恢复异常后记录会退回「还没发布」，用户无法判断要不要人工核对。
          await checkpoint({
            checkpoint: { itemId: product.itemid, step: REPAIR_STEP.restoreDiscount, writeSent: true, at: deps.now() },
            workItem: withEvidence({
              skuCreated: buildResult.skuCreated,
              publishStatus: 'success',
              discountRestored: false,
            }),
          });
          const resp = await deps.injectedFetch<any>(restoreUrl, 'POST', {
            promotion_id: discounts[di].promotionId,
            discount_model_list: restoreEntries,
          });
          if (resp?.error !== 0) {
            restoreError = `商品已发布，但折扣活动"${discounts[di].name}"恢复失败。请根据活动信息手动恢复。`;
            break;
          }
          const data = resp?.data;
          const failedItems = data?.failed_item_list;
          const errorList = data?.error_list;
          if ((Array.isArray(failedItems) && failedItems.length > 0) || (Array.isArray(errorList) && errorList.length > 0)) {
            restoreError = `商品已发布，但折扣活动"${discounts[di].name}"部分 SKU 恢复失败。请手动恢复。`;
            break;
          }
        } catch (restoreErr: any) {
          // 归属/保存失败是任务级故障，必须中断整批（不能被当成"恢复失败"吞掉）
          if (isTaskLevelError(restoreErr)) throw restoreErr;
          // 传输层异常：只代表「恢复结果未知」。商品已经发布成功这件事不能丢，
          // 已移除的折扣与活动名也要保留，供用户人工核对。
          restoreError = `商品已发布，但折扣活动"${discounts[di].name}"恢复结果未知（请求异常：${
            restoreErr?.message || restoreErr
          }）。请根据活动信息人工核对并恢复。`;
          break;
        }
      }
      discountRestored = restoreError === null;
    }
  }

  if (publishResult.code !== 0) {
    return fail(publishResult.msg || `发布失败 (code: ${publishResult.code})`, withEvidence());
  }

  return {
    item: {
      ...withEvidence({
        skuCreated: buildResult.skuCreated,
        publishStatus: 'success',
        discountRestored,
      }),
      hasOneDaySku: buildResult.hasOneDaySku,
      highestPrice: buildResult.highestPrice,
      // 折扣恢复失败时保留明确失败原因，不冒充「全部恢复成功」
      ...(restoreError ? { error: restoreError } : {}),
    },
    ratio: detectedRatio,
  };
}

/**
 * 按顺序修复任务中的全部商品，并把完成结果（含最新商品/SKU 与折扣率）写回任务记录。
 *
 * 抛出的异常只代表「任务级」故障（进度保存失败/归属变化）；单个商品失败按 items 里的 error 呈现，
 * 不中断其他商品。
 */
export async function runOneDaySkuRepairTask(
  task: OneDayRepairTask,
  products: ShopeeProduct[],
  deps: RepairRunnerDeps,
  options: RunRepairOptions = {},
): Promise<OneDayRepairTask> {
  const debounceMs = options.debounceMs ?? 2000;
  let current = task;

  const save = async (patch: RepairProgressInput) => {
    // 写入前先看权威记录：如果它已被标记终态/中断（例如另一个实例的启动协调），
    // 本实例的迟到写入必须放弃，否则会把中断回退成「运行中」并把结果清空（BR5）。
    if (deps.loadTask) {
      const authoritative = await deps.loadTask();
      if (authoritative && authoritative.taskId === current.taskId && isTerminalRepairStatus(authoritative.status)) {
        throw new RepairStaleWriteError(authoritative.status);
      }
    }
    const now = deps.now();
    const next = patchRepairTask(current, { ...patch, at: now });
    // 工作中商品同时镜像进 items：失败/中断时逐项列表里也能看到「已移除哪些折扣」，
    // 而不是只有 workItem 一处（用户看的是 items 列表）。
    if (patch.workItem) {
      const idx = next.items.findIndex(it => it.itemId === patch.workItem!.itemId);
      if (idx >= 0) {
        const items = [...next.items];
        items[idx] = {
          ...items[idx],
          discountRemoved: patch.workItem.discountRemoved,
          discountRestored: patch.workItem.discountRestored,
          ...(patch.workItem.discounts ? { discounts: patch.workItem.discounts } : {}),
          ...(patch.workItem.discountRemovals ? { discountRemovals: patch.workItem.discountRemovals } : {}),
          // 已发布成功这一事实必须镜像进来：恢复折扣异常时用户要在列表里看到
          // 「商品已发布、折扣待核对」，而不是退回「还没修」。
          ...(patch.workItem.skuCreated !== undefined ? { skuCreated: patch.workItem.skuCreated } : {}),
          ...(patch.workItem.publishStatus ? { publishStatus: patch.workItem.publishStatus } : {}),
        };
        next.items = items;
      }
    }
    current = { ...next, revision: next.revision + 1 };
    try {
      await deps.saveTask(current);
    } catch (e) {
      throw new RepairCheckpointSaveError(e);
    }
  };

  deps.startKeepalive();
  try {
    await save({ status: 'running', phase: 'preparing_sku', message: '正在优化商品...' });

    const items = [...current.items];
    const collectedRatios: number[] = [];

    /**
     * 写请求前的归属核对：凭据、实际店铺、认证账号都要与任务一致。
     * 未知（核实不到）= 不一致，直接任务级停止，不放行写请求。
     */
    const assertOwnership = async () => {
      const cred = await deps.getCredential();
      if (!cred.spcCds) {
        throw new RepairOwnershipError('凭据已失效（Cookie 中找不到 SPC_CDS），已停止后续商品修复', {
          actualShopId: null,
          actualUserId: null,
        });
      }
      const identity = await deps.getShopIdentity();
      const authUserId = deps.getAuthUserId ? await deps.getAuthUserId() : null;
      if (!isSameOwner(current, identity.shopId, authUserId, cred.spcCds)) {
        throw new RepairOwnershipError(
          `当前店铺或账号与任务归属不一致（任务店铺 ${current.shopId ?? '未记录'}／账号 ${
            current.ownerUserId ?? '未记录'
          }，实际 ${identity.shopId ?? '核实不到'}／${authUserId ?? '核实不到'}），已停止后续商品修复`,
          { actualShopId: identity.shopId, actualUserId: authUserId },
        );
      }
    };

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      await assertOwnership();

      await save({
        currentIndex: i + 1,
        message: `正在优化商品 (${i + 1}/${products.length})...`,
        phase: 'preparing_sku',
      });

      try {
        const repaired = await repairOneProduct(product, deps, save, () => assertOwnership(), debounceMs);
        items[i] = repaired.item;
        if (repaired.item.publishStatus === 'success' && repaired.ratio !== null) {
          collectedRatios.push(repaired.ratio);
        }
      } catch (e: any) {
        // 任务级故障（保存失败/归属变化）必须中断整批，不能被记成单件失败后继续写
        if (isTaskLevelError(e)) throw e;
        const reason = e?.message || '未知错误';
        items[i] = { ...items[i], publishStatus: 'failed', error: reason };
        // 最小脱敏诊断：这一件到底走到哪一步、哪些写请求已确认发出（不含凭据）
        deps.onItemFailed?.({
          itemId: product.itemid,
          reason,
          confirmedActions: describeConfirmedActions(items[i]),
        });
      }

      await save({ items: [...items], currentIndex: i + 1, workItem: null });
    }

    const successCount = items.filter(it => it.publishStatus === 'success').length;
    const failCount = items.filter(it => it.publishStatus === 'failed').length;

    // 后台完成必要的结果读取，避免 popup 关闭时丢掉完整商品/SKU
    let resultProducts: ShopeeProduct[] = [];
    if (successCount > 0) {
      const successIds = items.filter(it => it.publishStatus === 'success').map(it => it.itemId);
      try {
        resultProducts = await deps.fetchProductsByIds(successIds);
      } catch (e: any) {
        // 读不到不等于没修好：保留成功商品 ID 与逐项结果，popup 重开时可再取一次
        console.warn('[bg:repair] 修复完成但结果商品读取失败:', e?.message || e);
      }
    }

    const done = patchRepairTask(current, {
      status: successCount > 0 ? 'completed' : 'failed',
      phase: successCount > 0 ? 'editing_params' : 'failed',
      currentIndex: products.length,
      items: [...items],
      workItem: null,
      error: failCount > 0 ? `${failCount} 个商品处理失败，请查看详情。` : null,
      message:
        successCount > 0
          ? `修复完成：${successCount} 个可继续${failCount > 0 ? `，${failCount} 个失败` : ''}`
          : `处理完成：${failCount} 个失败`,
      at: deps.now(),
    });
    current = { ...done, resultProducts, discountRate: resolveDiscountRate(collectedRatios), revision: done.revision + 1 };
    await deps.saveTask(current);

    return current;
  } finally {
    deps.stopKeepalive();
  }
}
