/**
 * 商品备货与物流的后台 runner。
 *
 * 只依赖注入的小接口（`runner-deps.ts`），**不 import React／Zustand／DOM**，
 * 因此 background 与单测共用同一份执行代码（结构要求见验收矩阵 S10）。
 *
 * 三阶段顺序按任务书：只读预检 → 目标预览 → 用户确认后才发生写。
 * 物流关闭刻意放在"商品批改之前、预检之后"：源先关物流再抓商品，
 * 预检失败也会让店铺停在"物流已关"；这里缩短店铺受影响时间。
 *
 * 四条不可退让的规则（返工 R1–R4 的落点）：
 * 1. **读不全就不写**：预检与开跑前检查都必须拿到完整的商品列表、特卖排除集合与 SKU 模式；
 *    任何一项不确定即零写入，不能"读失败当成没有"。
 * 2. **写结果未知不重发**：传输异常／响应无法解析可能已经写成功，先回读定案；
 *    只有**明确被拒绝的限流**才退避重试。
 * 3. **写前按任务锚核对身份**：店铺一致且**后端账号相等**（非空不等于原账号）；账号变化立即停写。
 * 4. **物流义务不丢**：关闭结果未知时保留快照与恢复义务，不被"已全部恢复"掩盖。
 */

import { countShippingItems, patchShippingTask, type ShippingTaskPatch } from './task';
import { redactSensitiveText, SHIPPING_ITEM_CODE } from './api';
import {
  buildBatchItem,
  classifyExclusion,
  filterByRange,
  isEditableForShipping,
  isNonHotDeterminable,
  parseExcludeIds,
  type ShippingBatchRequestItem,
} from './rules';
import { channelHasPendingRestore, mergeItemResults, upsertChannelRecord, type ShippingRunnerDeps, type ShippingRunnerOptions, type ShippingVerifiedContext } from './runner-deps';
import type {
  ShippingChannelRecord,
  ShippingDiagnostic,
  ShippingItemResult,
  ShippingLogisticsImpact,
  ShippingPreviewResult,
  ShippingPreviewSettings,
  ShippingProduct,
  ShippingTask,
  ShippingTaskStatus,
  ShippingTargetItem,
} from './types';

// 让调用方继续能从 runner 取到这个类型（它是预检入参；定义已移到 types 以免循环依赖）
export type { ShippingPreviewSettings };

/** 保存检查点失败：此时不得继续发新的写请求（与一键修复同一口径）。 */
export class ShippingCheckpointSaveError extends Error {
  constructor(cause: unknown) {
    super(`保存任务进度失败，已停止后续写请求：${redactSensitiveText(cause)}`, { cause });
    this.name = 'ShippingCheckpointSaveError';
  }
}

/** 归属/凭据不再匹配：任务级停止，不能被逐商品 catch 吞掉。 */
export class ShippingOwnershipError extends Error {
  readonly actualShopId: number | null;
  constructor(message: string, actualShopId: number | null) {
    super(redactSensitiveText(message));
    this.name = 'ShippingOwnershipError';
    this.actualShopId = actualShopId;
  }
}

/** 权威记录已被标记终态：本实例的迟到写入必须放弃。 */
export class ShippingStaleWriteError extends Error {
  constructor(status: ShippingTaskStatus) {
    super(`任务已被标记为 ${status}，本实例停止写入以避免状态回退`);
    this.name = 'ShippingStaleWriteError';
  }
}

/** 读不到必需信息（身份／列表／排除集合／SKU 模式）导致不能开始写。 */
export class ShippingPreflightError extends Error {
  constructor(message: string) {
    super(redactSensitiveText(message));
    this.name = 'ShippingPreflightError';
  }
}

/**
 * 写前核验失败（读取抛错、读不到、或与任务锚不一致）。
 *
 * 为什么单独一类：以前 `assertOwnership` 的异常会被逐商品 catch 吞掉
 * （只识别自定义错误类型，普通异常直接放过），于是"读身份报错"变成"继续改商品"（返工 14.2）。
 * 现在**任何**核验失败都是任务级停止，必须在业务写请求之前抛出并终止整批。
 */
export class ShippingVerificationError extends Error {
  readonly stage: string;
  readonly expectedShopId: number | null;
  readonly expectedUserId: number | null;
  readonly actualShopId: number | null;
  readonly actualUserId: number | null;
  readonly access: 'allowed' | 'denied' | 'read-failed' | 'not-checked';
  readonly writeSent: boolean;

  constructor(input: {
    message: string;
    stage: string;
    expectedShopId: number | null;
    expectedUserId: number | null;
    actualShopId: number | null;
    actualUserId: number | null;
    access: 'allowed' | 'denied' | 'read-failed' | 'not-checked';
    writeSent: boolean;
  }) {
    super(redactSensitiveText(input.message));
    this.name = 'ShippingVerificationError';
    this.stage = input.stage;
    this.expectedShopId = input.expectedShopId;
    this.expectedUserId = input.expectedUserId;
    this.actualShopId = input.actualShopId;
    this.actualUserId = input.actualUserId;
    this.access = input.access;
    this.writeSent = input.writeSent;
  }
}

function isTaskLevelError(e: unknown): boolean {
  return (
    e instanceof ShippingCheckpointSaveError ||
    e instanceof ShippingOwnershipError ||
    e instanceof ShippingStaleWriteError ||
    e instanceof ShippingPreflightError ||
    e instanceof ShippingVerificationError
  );
}

// ===== 读取与过滤（预检与开跑前检查共用同一套规则） =====

interface GatheredTargets {
  ok: true;
  credential: { spcCds: string; spcCdsVer: string };
  shopId: number;
  items: ShippingTargetItem[];
  scanned: number;
  excludedByManual: number;
  excludedByFlashSale: number;
  unsupported: number;
  nonhotDeterminable: boolean;
}

interface GatheredFailure {
  ok: false;
  error: string;
  shopId: number | null;
  nonhotDeterminable?: boolean;
}

/**
 * 只读预检：读取当前店铺、商品、特卖排除、SKU 模式与物流快照，产出「最终目标预览」。
 *
 * 全程**零写请求**。任何一步失败都返回 `ok: false`，由调用方阻止开始写。
 */
export async function previewShippingTargets(
  deps: ShippingRunnerDeps,
  settings: ShippingPreviewSettings,
): Promise<ShippingPreviewResult> {
  const prepared = await gatherTargets(deps, settings);
  if (!prepared.ok) {
    return {
      ok: false,
      error: prepared.error,
      shopId: prepared.shopId,
      scanned: 0,
      complete: false,
      items: [],
      excludedByManual: 0,
      excludedByFlashSale: 0,
      unsupported: 0,
      flashSaleExclusionOk: false,
      nonhotDeterminable: prepared.nonhotDeterminable ?? true,
      logistics: { requested: false, enabledChannels: [] },
    };
  }

  let logistics: ShippingLogisticsImpact = { requested: settings.toggleLogistics, enabledChannels: [] };
  if (settings.toggleLogistics) {
    // 勾选了物流管理时，取不到渠道状态就**不能确认影响范围**，
    // 而 runner 在预检失败后会停止整批、不打商品写。所以这里必须让预检失败，
    // 而不是"照常改天数"——否则界面说的和实际做的事不一致（返工 14.5）。
    const channels = await deps.fetchChannelList(prepared.credential).catch(() => null);
    if (!channels) {
      return {
        ok: false,
        error:
          '物流渠道读取失败，无法确认本次会关闭哪些渠道，已停止预检。'
          + '若只想修改备货天数，请在确认区取消勾选「自动管理店铺物流」后重新预检。',
        shopId: prepared.shopId,
        scanned: prepared.scanned,
        complete: false,
        items: [],
        excludedByManual: prepared.excludedByManual,
        excludedByFlashSale: prepared.excludedByFlashSale,
        unsupported: prepared.unsupported,
        flashSaleExclusionOk: true,
        nonhotDeterminable: prepared.nonhotDeterminable,
        logistics: { requested: true, enabledChannels: [], error: '物流渠道读取失败' },
      };
    }
    logistics = { requested: true, enabledChannels: channels.filter(c => c.enabled).map(c => c.channelId) };
  }

  return {
    ok: true,
    shopId: prepared.shopId,
    scanned: prepared.scanned,
    complete: true,
    items: prepared.items,
    excludedByManual: prepared.excludedByManual,
    excludedByFlashSale: prepared.excludedByFlashSale,
    unsupported: prepared.unsupported,
    flashSaleExclusionOk: true,
    nonhotDeterminable: prepared.nonhotDeterminable,
    logistics,
  };
}

/**
 * 读取并过滤出最终目标。
 *
 * 预检与开跑前检查**共用**这一段，避免"预检严格、开跑宽松"的两套规则漂移（R1）。
 */
async function gatherTargets(
  deps: ShippingRunnerDeps,
  settings: ShippingPreviewSettings,
): Promise<GatheredTargets | GatheredFailure> {
  const credential = await deps.getCredential();
  if (!credential.spcCds) {
    return { ok: false, error: '凭据已失效（Cookie 中找不到 SPC_CDS），请在 seller.shopee.tw 重新登录', shopId: null };
  }
  const identity = await deps.getShopIdentity();
  if (identity.shopId === null) {
    return { ok: false, error: '无法核实当前店铺身份，已停止（请打开卖家中心页面并保持登录）', shopId: null };
  }

  // 1) 商品列表：读不完整就不继续
  const listed = await deps.fetchAllProducts(credential);
  if (!listed.complete) {
    return {
      ok: false,
      error: `商品列表读取不完整，已停止：${redactSensitiveText(listed.error || '未知原因')}`,
      shopId: identity.shopId,
    };
  }
  const all = listed.products;

  // 2) 非热销范围必须先确认可判定，否则明确拒绝而不是偷换成全店
  const nonhotDeterminable = settings.range === 'nonhot' ? isNonHotDeterminable(all) : true;
  if (settings.range === 'nonhot' && !nonhotDeterminable) {
    return {
      ok: false,
      error: '非热销范围不可判定：平台未返回销量／浏览量字段，已停止（不会退化为全店）',
      shopId: identity.shopId,
      nonhotDeterminable: false,
    };
  }

  // 3) 特卖排除调查（只读）：**失败即停止**，不能当成"没有特卖"
  const flashSale = await deps.fetchFlashSaleExcludeIds(credential);
  if (!flashSale.ok) {
    return {
      ok: false,
      error: `特卖排除调查失败，已停止：${redactSensitiveText(flashSale.error || '未知原因')}`,
      shopId: identity.shopId,
      nonhotDeterminable,
    };
  }

  const ranged = filterByRange(all, settings.range);
  const editable = ranged.filter(isEditableForShipping);
  const manual = new Set(parseExcludeIds(settings.excludeIds));

  let excludedByManual = 0;
  let excludedByFlashSale = 0;
  let unsupported = 0;
  const items: ShippingTargetItem[] = [];

  for (const product of editable) {
    const itemId = String(product.id);
    const exclusion = classifyExclusion(itemId, manual, flashSale.itemIds);
    if (exclusion === 'manual') {
      excludedByManual += 1;
      continue;
    }
    if (exclusion === 'flash-sale') {
      excludedByFlashSale += 1;
      continue;
    }

    const skuLevel = await resolveSkuLevel(deps, credential, product);
    // 无法确认 SKU 模式 → 不进入写集合。既不能假定"不是 SKU 级"（那会静默关闭用户 SKU 结构），
    // 也不能假定"是"（那会莫名排除正常商品）。
    if (skuLevel === null || skuLevel) {
      unsupported += 1;
      continue;
    }

    items.push({
      itemId,
      name: String(product.name || ''),
      status: Number(product.status),
      categoryPath: String(product.category_path || ''),
    });
  }

  return {
    ok: true,
    credential,
    shopId: identity.shopId,
    items,
    scanned: all.length,
    excludedByManual,
    excludedByFlashSale,
    unsupported,
    nonhotDeterminable,
  };
}

/**
 * 判断商品是否按 SKU 设置备货。
 *
 * 列表字段明确时直接用它；**不明确（缺失／非布尔）时读详情确认**。
 * 返回 `null` 表示无法确认 —— 调用方必须把该商品排除出写集合。
 */
async function resolveSkuLevel(
  deps: ShippingRunnerDeps,
  credential: { spcCds: string; spcCdsVer: string },
  product: ShippingProduct,
): Promise<boolean | null> {
  if (typeof product.enable_model_level_dts === 'boolean') return product.enable_model_level_dts;
  let detail: Record<string, unknown> | null;
  try {
    detail = await deps.fetchProductDetail(credential, String(product.id));
  } catch {
    return null;
  }
  if (!detail) return null;
  if (typeof (detail as any).enable_model_level_dts === 'boolean') {
    return (detail as any).enable_model_level_dts as boolean;
  }
  // 详情也没给这个字段时，用"是否有 SKU 级备货信息"做保守判断：
  // 只要看到 model_list 里有 pre_order_info，就按 SKU 级处理（宁可少改，不可误改）。
  const models = (detail as any).model_list;
  if (Array.isArray(models) && models.length > 0) {
    const anyModelDays = models.some((m: any) => m?.pre_order_info?.days_to_ship !== undefined);
    if (anyModelDays) return true;
  }
  return null;
}

// ===== 执行 =====

export interface ShippingRunResult {
  task: ShippingTask;
  summary: {
    counts: ReturnType<typeof countShippingItems>;
    channels: ShippingChannelRecord[];
    batches: number;
    needsLogisticsRestore: boolean;
  };
}

interface RunContext {
  deps: ShippingRunnerDeps;
  save: (patch: Omit<ShippingTaskPatch, 'now'>) => Promise<void>;
  checkpoint: (
    step: string,
    writeSent: boolean,
    target?: string,
    outcome?: 'success' | 'failed' | 'unknown',
  ) => Promise<void>;
  /**
   * 写前完整核验（店铺 + 账号 + 现行后端权限），**任何读取失败都抛 `ShippingVerificationError`**。
   * `stage` 用于诊断，`writeSent` 表示该边界是否已经发过写请求。
   *
   * 返回**已核实的上下文**：业务请求必须用它，不得再自己去读凭据（返工 17.2）。
   */
  verifyBeforeWrite: (stage: string, writeSent: boolean) => Promise<ShippingVerifiedContext>;
  assertNotStale: () => Promise<void>;
  getTask: () => ShippingTask;
  /**
   * 本批**是否还允许发出"切 1 天"请求**（第 34.3 节 R2）。
   *
   * 为什么必须放在 runner 的写边界：调度决策只判断了"决策那一刻"在窗口内，
   * 而从决策到真正发请求之间还有预检、权限核验、物流快照等耗时步骤 ——
   * 实测能跨过截止，于是出现"决策正确、却执行了过时的现货操作"。
   * 单次组注入它，把截止落实到每一次真实发送之前；其余任务不注入即为无限制。
   */
  canSendSpotWrite?: () => boolean;
  /**
   * 本批写请求是否属于"切现货"阶段（只有单次组的 spot 阶段为 true）。
   * 非现货阶段（恢复常规天数）不受截止限制。
   */
  isSpotPhase?: () => boolean;
  /** 真的发出过一批现货写之后回调（供调用方切换截止约束，第 37.3 节） */
  onSpotBatchSent?: () => void;
}

/**
 * 读一份**已核实的卖家上下文**：同一份凭据 + 用它的核实出的身份（返工 17.2）。
 *
 * 注入 `verifiedContext` 时用它（生产路径：background 从 Cookie 读一次凭据，
 * 再用这同一份凭据去核实身份）。未注入时退回"分别读凭据与身份"，
 * 两条读之间可能变化 —— 仅供隔离单测与降级路径，生产不要走这条。
 */
async function readVerifiedContext(deps: ShippingRunnerDeps): Promise<ShippingVerifiedContext> {
  if (deps.verifiedContext) return await deps.verifiedContext();
  const credential = await deps.getCredential();
  const identity = await deps.getShopIdentity();
  const userId = deps.getAuthUserId ? await deps.getAuthUserId() : null;
  return { credential, shopId: identity.shopId, userId };
}

/**
 * 写前核验：店铺、后端账号、现行后端权限。
 *
 * **任何**读取失败都必须停写（返工 14.2）：
 * - 读身份抛错 → 抛 `ShippingVerificationError`（不再被逐商品 catch 吞掉）；
 * - 读到但与任务锚不一致 → 同样停；
 * - 现行后端权限被拒或读取失败 → 同样停（返工 14.3）。
 *
 * 独立成函数是为了让"执行任务"与"单独恢复物流"两条路径**共用同一套核验**，
 * 避免只修一处、另一处仍然放行。
 *
 * 返回的是**这一份已核实的上下文**：调用方必须用它去发写请求，
 * 不能再自己去读一次凭据（返工 17.2：核验用会话 A、发送用会话 B 会把
 * 别的会话的写入或结果算到本任务上）。
 */
export async function verifyWriteAnchor(
  deps: ShippingRunnerDeps,
  anchor: { taskId?: string; occurrenceId?: string; shopId: number | null; ownerUserId: number | null },
  stage: string,
  writeSent: boolean,
): Promise<ShippingVerifiedContext> {
  const expectedShopId = anchor.shopId;
  const expectedUserId = anchor.ownerUserId;
  const diagBase = {
    stage,
    taskId: anchor.taskId,
    occurrenceId: anchor.occurrenceId,
    expectedShopId,
    expectedUserId,
    writeSent,
  };

  let verified: ShippingVerifiedContext;
  let actualShopId: number | null;
  let actualUserId: number | null;
  try {
    verified = await readVerifiedContext(deps);
    actualShopId = verified.shopId;
    actualUserId = verified.userId;
  } catch (e: any) {
    await deps.recordDiagnostic?.({
      ...diagBase,
      actualShopId: null,
      actualUserId: null,
      access: 'not-checked',
      contextChange: 'blocked-write',
      blockedBy: 'identity-read-failed',
      reason: `身份读取失败：${redactSensitiveText(e)}`,
    });
    throw new ShippingVerificationError({
      message: `身份读取失败，已停止所有写操作：${redactSensitiveText(e)}`,
      stage,
      expectedShopId,
      expectedUserId,
      actualShopId: null,
      actualUserId: null,
      access: 'not-checked',
      writeSent,
    });
  }
  if (actualShopId === null) {
    await deps.recordDiagnostic?.({
      ...diagBase,
      actualShopId,
      actualUserId,
      access: 'not-checked',
      contextChange: 'blocked-write',
      blockedBy: 'identity-null',
      reason: '无法核实当前店铺身份',
    });
    throw new ShippingVerificationError({
      message: '无法核实当前店铺身份，已停止所有写操作',
      stage,
      expectedShopId,
      expectedUserId,
      actualShopId,
      actualUserId,
      access: 'not-checked',
      writeSent,
    });
  }
  if (expectedShopId !== null && actualShopId !== expectedShopId) {
    await deps.recordDiagnostic?.({
      ...diagBase,
      actualShopId,
      actualUserId,
      access: 'not-checked',
      contextChange: 'blocked-write',
      blockedBy: 'shop-changed',
      reason: '店铺与任务锚不一致',
    });
    throw new ShippingVerificationError({
      message: `当前店铺（${actualShopId}）与任务店铺（${expectedShopId}）不一致，已停止所有写操作`,
      stage,
      expectedShopId,
      expectedUserId,
      actualShopId,
      actualUserId,
      access: 'not-checked',
      writeSent,
    });
  }
  // 账号锚：非空不等于"还是原账号"，必须**相等**（返工 20.2：读不到也是停，不当同归属）
  if (deps.getAuthUserId && expectedUserId !== null && actualUserId !== expectedUserId) {
    const accountBlockedBy: ShippingDiagnostic['blockedBy'] =
      actualUserId === null ? 'identity-null' : 'account-changed';
    await deps.recordDiagnostic?.({
      ...diagBase,
      actualShopId,
      actualUserId,
      access: 'not-checked',
      contextChange: 'blocked-write',
      blockedBy: accountBlockedBy,
      reason: actualUserId === null ? '无法核实当前登录账号' : '账号与任务锚不一致',
    });
    throw new ShippingVerificationError({
      message:
        actualUserId === null
          ? `无法核实当前登录账号（期望 ${expectedUserId}），已停止所有写操作`
          : `当前登录账号（${actualUserId}）与任务账号（${expectedUserId}）不一致，已停止所有写操作`,
      stage,
      expectedShopId,
      expectedUserId,
      actualShopId,
      actualUserId,
      access: 'not-checked',
      writeSent,
    });
  }

  // 现行后端权限：接受任务时校验过不代表整个执行期都有效（返工 14.3）
  if (deps.validateAccess) {
    let access: { allowed: boolean; error?: string };
    try {
      // 用**核验阶段那一份**凭据去查权限，而不是再读一次（返工 17.2）
      access = await deps.validateAccess(verified.credential, actualShopId);
    } catch (e: any) {
      await deps.recordDiagnostic?.({
        ...diagBase,
        actualShopId,
        actualUserId,
        access: 'read-failed',
        contextChange: 'blocked-write',
        blockedBy: 'access-read-failed',
        reason: `权限核验失败：${redactSensitiveText(e)}`,
      });
      throw new ShippingVerificationError({
        message: `无法核验当前权限，已停止所有写操作：${redactSensitiveText(e)}`,
        stage,
        expectedShopId,
        expectedUserId,
        actualShopId,
        actualUserId,
        access: 'read-failed',
        writeSent,
      });
    }
    if (!access.allowed) {
      await deps.recordDiagnostic?.({
        ...diagBase,
        actualShopId,
        actualUserId,
        access: 'denied',
        contextChange: 'blocked-write',
        blockedBy: 'access-denied',
        reason: access.error || '权限被拒绝',
      });
      throw new ShippingVerificationError({
        message: `当前权限已不再允许该操作，已停止所有写操作：${access.error || '权限被拒绝'}`,
        stage,
        expectedShopId,
        expectedUserId,
        actualShopId,
        actualUserId,
        access: 'denied',
        writeSent,
      });
    }
  }

  // 归属相同即放行：Cookie 字符串刷新（SPC_CDS 轮换）但店铺／账号没变时**不能**误判成换店。
  // 本函数只比对 shopId／userId，从不比对凭据字符串 —— 这就是"刷新不算换店"的实现方式。
  return verified;
}

/**
 * 发送前的上下文稳定性检查（返工 17.2／20.2／23）。
 *
 * 核验与发送之间 Cookie 可能被换掉。快速比一次凭据字符串即可发现：
 * - 字符串没变 → 直接用核验那一份（无额外网络请求）；
 * - 字符串变了 → **重新核实归属**（不能凭字符串变化就断定换店：SPC_CDS 轮换很常见），
 *   只有归属确实不同才停；归属相同还要**用新凭据重新核验服务端权限**（返工 23），
 *   通过了才把它交给业务请求。早先漏了这一步：刷新后直接放行新凭据，
 *   于是"刷新前允许、刷新后已被撤权"的情况下照样发出写请求。
 *
 * 不做成"字符串一变就停"，否则用户正常刷新 Cookie 会被误判成换店。
 */
async function ensureContextStillVerified(
  deps: ShippingRunnerDeps,
  verified: ShippingVerifiedContext,
  anchor: { taskId?: string; occurrenceId?: string; shopId: number | null; ownerUserId: number | null },
  stage: string,
): Promise<ShippingVerifiedContext> {
  if (!deps.verifiedContext) return verified;
  let current: ShippingVerifiedContext;
  try {
    current = await deps.verifiedContext();
  } catch (e: any) {
    await deps.recordDiagnostic?.({
      stage,
      taskId: anchor.taskId,
      occurrenceId: anchor.occurrenceId,
      expectedShopId: anchor.shopId,
      expectedUserId: anchor.ownerUserId,
      actualShopId: null,
      actualUserId: null,
      access: 'not-checked',
      writeSent: false,
      contextChange: 'blocked-write',
      blockedBy: 'identity-read-failed',
      reason: `发送前无法重读上下文：${redactSensitiveText(e)}`,
    });
    throw new ShippingVerificationError({
      message: `发送前无法重读登录上下文，已停止该请求：${redactSensitiveText(e)}`,
      stage,
      expectedShopId: anchor.shopId,
      expectedUserId: anchor.ownerUserId,
      actualShopId: null,
      actualUserId: null,
      access: 'not-checked',
      writeSent: false,
    });
  }

  /**
   * 顺序很重要（返工 20.2）：**先逐项核对归属，再看凭据是否刷新**。
   *
   * 以前的写法是"凭据字符串相同就直接 return 先前那份" —— 卖家 Cookie 不变、
   * 后端账号却被切换时，这一步正好把账号变化**跳过**了；而且
   * `current.userId === null`（读不到）也被当成"与锚一致"。
   *
   * 现在的判定：
   * - 店铺读不到（null）→ 停（不把 null 当"没变"）；
   * - 任务锚有账号要求而当前账号读不到（null）→ 停；
   * - 店铺或账号与锚**不相等** → 停；
   * - 以上都通过，才认为归属未变；此时凭据刷不刷新都放行（刷新不算换店）。
   */
  const credentialChanged = current.credential.spcCds !== verified.credential.spcCds;
  const identityProblem: { blockedBy: ShippingDiagnostic['blockedBy']; message: string } | null = (() => {
    if (current.shopId === null) {
      return {
        blockedBy: 'identity-null' as const,
        message: '发送前无法核实当前店铺归属，已停止该请求（请重新预检）',
      };
    }
    if (anchor.shopId !== null && current.shopId !== anchor.shopId) {
      return {
        blockedBy: 'shop-changed' as const,
        message: `发送前店铺已变化（${anchor.shopId} → ${current.shopId}），已停止该请求`,
      };
    }
    if (anchor.ownerUserId !== null) {
      if (current.userId === null) {
        return {
          blockedBy: 'identity-null' as const,
          message: `发送前无法核实当前账号归属（期望 ${anchor.ownerUserId}），已停止该请求`,
        };
      }
      if (current.userId !== anchor.ownerUserId) {
        return {
          blockedBy: 'account-changed' as const,
          message: `发送前账号已变化（${anchor.ownerUserId} → ${current.userId}），已停止该请求`,
        };
      }
    }
    return null;
  })();

  if (identityProblem) {
    await deps.recordDiagnostic?.({
      stage,
      taskId: anchor.taskId,
      occurrenceId: anchor.occurrenceId,
      expectedShopId: anchor.shopId,
      expectedUserId: anchor.ownerUserId,
      actualShopId: current.shopId,
      actualUserId: current.userId,
      access: 'not-checked',
      writeSent: false,
      contextChange: 'blocked-write',
      credentialChanged,
      blockedBy: identityProblem.blockedBy,
      reason: identityProblem.message,
    });
    throw new ShippingVerificationError({
      message: identityProblem.message,
      stage,
      expectedShopId: anchor.shopId,
      expectedUserId: anchor.ownerUserId,
      actualShopId: current.shopId,
      actualUserId: current.userId,
      access: 'not-checked',
      writeSent: false,
    });
  }

  // 归属全部一致（含账号读得到且相等）：
  // - 凭据没变 → 沿用先前核验过的那一份，避免多发请求；
  // - 凭据刷新 → **必须用新凭据重新核验服务端权限**（返工 23），通过了才可以用它发写请求。
  if (!credentialChanged) return verified;

  // ===== 刷新后的服务端权限核验（返工 23）=====
  // 归属没变**不代表**权限还在。用户在 Cookie 轮换前后被撤权是完全可能的：
  // 旧上下文那次核验通过，只能证明"当时"允许。用**新凭据 + 新核实到的店铺**再查一次，
  // 拒绝或读取失败都按既有任务级错误停下（商品／渠道都不再写，物流保留待处理）。
  if (deps.validateAccess) {
    let refreshedAccess: { allowed: boolean; error?: string };
    try {
      refreshedAccess = await deps.validateAccess(current.credential, current.shopId);
    } catch (e: any) {
      await deps.recordDiagnostic?.({
        stage,
        taskId: anchor.taskId,
        occurrenceId: anchor.occurrenceId,
        expectedShopId: anchor.shopId,
        expectedUserId: anchor.ownerUserId,
        actualShopId: current.shopId,
        actualUserId: current.userId,
        access: 'read-failed',
        writeSent: false,
        contextChange: 'blocked-write',
        credentialChanged: true,
        blockedBy: 'access-read-failed',
        reason: `刷新后的权限核验失败：${redactSensitiveText(e)}`,
      });
      throw new ShippingVerificationError({
        message: `凭据已刷新但无法核验新上下文的权限，已停止该请求：${redactSensitiveText(e)}`,
        stage,
        expectedShopId: anchor.shopId,
        expectedUserId: anchor.ownerUserId,
        actualShopId: current.shopId,
        actualUserId: current.userId,
        access: 'read-failed',
        writeSent: false,
      });
    }
    if (!refreshedAccess.allowed) {
      const reason = refreshedAccess.error || '权限被拒绝';
      await deps.recordDiagnostic?.({
        stage,
        taskId: anchor.taskId,
        occurrenceId: anchor.occurrenceId,
        expectedShopId: anchor.shopId,
        expectedUserId: anchor.ownerUserId,
        actualShopId: current.shopId,
        actualUserId: current.userId,
        access: 'denied',
        writeSent: false,
        contextChange: 'blocked-write',
        credentialChanged: true,
        blockedBy: 'access-denied',
        reason: `刷新后的上下文已无权限：${reason}`,
      });
      throw new ShippingVerificationError({
        message: `凭据已刷新，但新上下文已不再允许该操作，已停止该请求：${reason}`,
        stage,
        expectedShopId: anchor.shopId,
        expectedUserId: anchor.ownerUserId,
        actualShopId: current.shopId,
        actualUserId: current.userId,
        access: 'denied',
        writeSent: false,
      });
    }
  }

  await deps.recordDiagnostic?.({
    stage,
    taskId: anchor.taskId,
    occurrenceId: anchor.occurrenceId,
    expectedShopId: anchor.shopId,
    expectedUserId: anchor.ownerUserId,
    actualShopId: current.shopId,
    actualUserId: current.userId,
    access: 'allowed',
    writeSent: false,
    contextChange: 'same-owner-refresh',
    credentialChanged: true,
    reason: '仅凭据刷新，归属未变且新上下文权限已核验通过',
  });
  return current;
}

/**
 * 执行一次备货修改任务。
 *
 * 顺序：核对归属 → 开跑前完整检查 → （可选）物流快照并关闭 → 分批改备货 → 回读 → （可选）恢复物流。
 * 停止语义：`isStopRequested()` 只阻止**后续**商品请求，不撤销已确认的修改；
 * 物流恢复属"必须继续"的收尾动作，按原对象执行，不受停止影响。
 */
export async function runShippingTask(
  initialTask: ShippingTask,
  items: ShippingTargetItem[],
  deps: ShippingRunnerDeps,
  options: ShippingRunnerOptions = {},
): Promise<ShippingRunResult> {
  const batchSizeOption = options.batchSize ?? 50;
  const concurrency = options.concurrency ?? 2;
  const maxRetryRounds = options.maxRetryRounds ?? 5;
  const readback = options.readback !== false;
  const requiredDays = initialTask.days;

  let current = initialTask;
  let batches = 0;

  const save = async (patch: Omit<ShippingTaskPatch, 'now'>) => {
    // 本实例的 `current` 是内存副本：用户点停止时后台是**另一条**路径把 `stopRequested`
    // 写进权威记录的。若这里不回读，就会用旧副本把 true 覆盖回 false —— 用户点了停止却继续写。
    const authoritative = await deps.loadTask?.().catch(() => null);
    if (authoritative && authoritative.taskId === current.taskId && authoritative.stopRequested) {
      current = { ...current, stopRequested: true };
    }
    const withNow: ShippingTaskPatch = {
      ...patch,
      // 所有落盘的文案／原因统一脱敏，避免底层异常带出凭据（R7）
      message: patch.message === undefined ? undefined : redactSensitiveText(patch.message),
      error: patch.error === undefined || patch.error === null ? patch.error : redactSensitiveText(patch.error),
      now: deps.now(),
    };
    try {
      current = patchShippingTask(current, withNow);
      await deps.saveTask(current, withNow);
    } catch (e) {
      throw new ShippingCheckpointSaveError(e);
    }
  };

  /**
   * 写前核验：店铺、后端账号、现行后端权限。
   *
   * **任何**读取失败都必须停写（返工 14.2）：
   * - 读身份抛错 → `ShippingVerificationError`（不再被逐商品 catch 吞掉）；
   * - 读到但与任务锚不一致 → 同样停；
   * - 现行后端权限被拒或读取失败 → 同样停（返工 14.3）。
   *
   * `stage` 用于最小脱敏诊断，写清是哪个边界失败的。
  /**
   * 写前核验：店铺、后端账号、现行后端权限。任何读取失败都抛 `ShippingVerificationError`（返工 14.2／14.3）。
   * 具体判断在共有的 `verifyWriteAnchor`，两条路径（执行任务 / 单独恢复物流）共用同一套规则。
   */
  const verifyBeforeWrite = (stage: string, writeSent: boolean) =>
    verifyWriteAnchor(deps, { taskId: current.taskId, occurrenceId: current.occurrenceId, shopId: current.shopId, ownerUserId: current.ownerUserId }, stage, writeSent);

  const assertNotStale = async () => {
    const stored = await deps.loadTask?.();
    if (stored && stored.taskId === initialTask.taskId && stored.status !== 'running') {
      throw new ShippingStaleWriteError(stored.status);
    }
  };

  const checkpoint: RunContext['checkpoint'] = async (step, writeSent, target, outcome) => {
    await save({ checkpoint: { step, writeSent, target, outcome, at: deps.now() } });
  };

  const ctx: RunContext = {
    deps,
    save,
    checkpoint,
    verifyBeforeWrite,
    assertNotStale,
    getTask: () => current,
    isSpotPhase: () => options.spotPhase === true,
    canSendSpotWrite: options.canSendSpotWrite,
    onSpotBatchSent: options.onSpotBatchSent,
  };
  let taskError: string | null = null;

  try {
    await deps.startKeepalive();
    await assertNotStale();
    await save({ phase: 'precheck', message: '正在核对当前店铺与目标商品' });

    // ===== 开跑前检查：与预检同一套规则，且只允许**减少**已确认的写集合 =====
    const confirmedIds = new Set(items.map(i => i.itemId));
    const fresh = await gatherTargets(deps, {
      mode: requiredDays > 1 ? 'preorder' : 'spot',
      days: requiredDays,
      range: current.range,
      excludeIds: current.excludeIds.join('\n'),
      toggleLogistics: current.logistics.requested,
    });
    if (!fresh.ok) {
      // 检查读不全 → 零商品写请求，不沿用旧快照
      await save({
        status: 'failed',
        phase: 'failed',
        message: `开跑前检查未通过，未发出任何商品写请求：${fresh.error}`,
        error: fresh.error,
      });
      return finalize(current, batches);
    }
    if (fresh.shopId !== current.shopId) {
      await save({
        status: 'failed',
        phase: 'failed',
        message: '开跑前核实到的店铺与任务锚不一致，未发出任何商品写请求',
        error: '店铺不一致',
      });
      return finalize(current, batches);
    }
    if (current.ownerUserId !== null && deps.getAuthUserId) {
      const userId = await deps.getAuthUserId();
      if (userId !== current.ownerUserId) {
        await save({
          status: 'failed',
          phase: 'failed',
          message: '开跑前核实到的账号与任务锚不一致，未发出任何商品写请求',
          error: '账号不一致',
        });
        return finalize(current, batches);
      }
    }

    const freshById = new Map(fresh.items.map(i => [i.itemId, i]));
    const stillWritable: ShippingTargetItem[] = [];
    const dropped: ShippingItemResult[] = [];
    for (const item of items) {
      // 只允许减少：必须是原确认集合里的商品
      if (!confirmedIds.has(item.itemId)) continue;
      const freshItem = freshById.get(item.itemId);
      if (!freshItem) {
        dropped.push({
          itemId: item.itemId,
          name: item.name,
          days: requiredDays,
          status: 'skipped',
          reason: '开跑前已被排除规则命中或状态不可编辑',
        });
        continue;
      }
      stillWritable.push({ ...freshItem, categoryPath: freshItem.categoryPath || item.categoryPath });
    }

    /**
     * ===== 恢复前核实"当前实际天数"（第 34.5 节 R4）=====
     *
     * 恢复对象来自组记录，但记录只说明"本轮曾把它切到 1 天"，**不代表现在还是 1 天**：
     * 用户可能在这之后自己改过。直接按记录 ID 覆盖写会抹掉用户后来的设置，
     * 还会把这种覆盖报成"已恢复"。
     *
     * 因此逐项读权威详情并分类，只把"确认仍需恢复"的项放进写集合：
     * - 仍是 1 天 → 需要恢复；
     * - 已是目标天数 → 记回读完成，不重复写；
     * - 其它（用户改成了第三种天数）→ 状态冲突，不写、留需处理；
     * - 读不到 → 无法确认，不写、留需处理。
     */
    let writable = stillWritable;
    if (options.verifyCurrentDays) {
      const { expectedCurrent, targetDays } = options.verifyCurrentDays;
      const keep: ShippingTargetItem[] = [];
      const settled: ShippingItemResult[] = [];
      for (const item of stillWritable) {
        const readCtx = await verifyBeforeWrite('verify-current-days', false);
        let actual: number | null = null;
        let skuLevel = false;
        try {
          const detail = await deps.fetchProductDetail(readCtx.credential, item.itemId);
          if (detail) {
            actual = extractDaysFromDetail(detail);
            skuLevel = (detail as any).enable_model_level_dts === true;
          }
        } catch {
          actual = null;
        }
        if (skuLevel) {
          settled.push({
            itemId: item.itemId,
            name: item.name,
            days: requiredDays,
            status: 'unknown',
            reason: '该商品按 SKU 设置备货天数，商品级天数无法确认，未发出写请求',
          });
          continue;
        }
        if (actual === null) {
          settled.push({
            itemId: item.itemId,
            name: item.name,
            days: requiredDays,
            status: 'unknown',
            reason: '恢复前无法确认当前备货天数，未发出写请求',
          });
          continue;
        }
        if (actual === targetDays) {
          settled.push({
            itemId: item.itemId,
            name: item.name,
            days: requiredDays,
            // 已确认是目标天数：按"已完成"归类，并带上结构化证据（组据此判定恢复完成）
            status: 'success',
            verifiedAlreadyTarget: true,
            reason: `回读确认当前已是目标 ${targetDays} 天，本次未发出写请求`,
          });
          continue;
        }
        if (actual === expectedCurrent) {
      // 仍是本次现货阶段设定的天数 → 确实需要恢复
      keep.push(item);
      continue;
        }
        /**
         * 既不是目标，也不是"本轮现货阶段设定的天数"。
         *
         * 两种情形都会走到这里：
         * - 用户在这之后自己改成了第三种天数（**不能覆盖**）；
         * - 该商品**预检时原本就已经是 X 天**、本轮没有被真正改动（X ≠ 1）。
         * 后者虽无覆盖风险，但我们也无法从记录区分它 —— 宁可**不写并标注**，
         * 也不能把用户当前的选择当成"当年那一次写入"来回滚（第 34.5 节 R4）。
         */
        settled.push({
          itemId: item.itemId,
          name: item.name,
          days: requiredDays,
          status: 'unknown',
          reason: `当前为 ${actual} 天，既不是目标 ${targetDays} 天也不是本轮现货阶段的 ${expectedCurrent} 天，未覆盖（可能已被手动修改）`,
        });
      }
      if (settled.length > 0) {
        await save({ items: mergeItemResults(current.items, settled) });
      }
      writable = keep;
      /**
       * R3 最小脱敏诊断（第 37.1 节）：把**恢复资格分类**落进 `_shippingDiagnostics`。
       *
       * 只记"决定了 needs-attention"不足以复查"为什么没救回来"；
       * 这里记下逐项读了多少次详情、各自被分到哪一类、最终谁真的会发出写请求。
       * 不含凭据、不含商品名以外的敏感信息。
       */
      await deps.recordDiagnostic?.({
        stage: 'verify-current-days',
        taskId: current.taskId,
        groupPhase: current.groupPhase,
        detail:
          `详情读取=${stillWritable.length} 次; 分类=` +
          JSON.stringify(
            settled.reduce<Record<string, number>>((acc, it) => {
              const key = it.verifiedAlreadyTarget
                ? 'already-target'
                : it.status === 'unknown'
                  ? 'unreadable-or-conflict'
                  : String(it.status);
              acc[key] = (acc[key] ?? 0) + 1;
              return acc;
            }, {}),
          ) +
          `; 仍需恢复=${writable.length}` +
          (writable.length > 0
            ? `[${writable.slice(0, 20).map(i => i.itemId).join(',')}${writable.length > 20 ? `,…共${writable.length}` : ''}]`
            : ''),
      }).catch(() => {});
      if (writable.length === 0) {
        await save({
          status: 'completed',
          phase: 'done',
          message: '恢复前核实：没有商品需要修改（已是目标天数或无法确认）',
        });
        return finalize(current, batches);
      }
    }

    // ===== 物流：先持久快照，再逐渠道关闭；任一关闭不能确认则先恢复并停止商品批改 =====
    const logisticsRecords: ShippingChannelRecord[] = [...current.logistics.records];
    let logisticsBlocked = false;

    if (current.logistics.requested) {
      // 核验返回的那一份上下文贯穿本段：快照读、关闭写、回读都用它（返工 17.2）
      const closeCtx = await verifyBeforeWrite('logistics-close-precheck', false);
      const channels = await deps.fetchChannelList(closeCtx.credential);
      if (!channels) {
        await save({
          status: 'failed',
          phase: 'logistics',
          message: '物流渠道读取失败，已停止（未发出任何物流写请求）',
          error: '物流渠道读取失败',
        });
        return finalize(current, batches);
      }
      for (const channel of channels) {
        if (logisticsRecords.some(r => r.channelId === channel.channelId)) continue;
        logisticsRecords.push({
          channelId: channel.channelId,
          originallyEnabled: channel.enabled,
          closed: channel.enabled ? 'pending' : 'skipped',
          restored: channel.enabled ? 'pending' : 'skipped',
        });
      }
      await save({
        logistics: { records: [...logisticsRecords], closeAttempted: true },
        phase: 'logistics',
        message: `已保存 ${logisticsRecords.filter(r => r.originallyEnabled).length} 个原启用渠道的快照`,
      });

      for (const record of logisticsRecords.filter(r => r.originallyEnabled && r.closed === 'pending')) {
        const channelCtx = await verifyBeforeWrite('close-channel', false);
        await checkpoint('close-channel', true, String(record.channelId));
        const sendCtx = await ensureContextStillVerified(
          deps,
          channelCtx,
          { taskId: current.taskId, shopId: current.shopId, ownerUserId: current.ownerUserId },
          'close-channel',
        );
        const result = await deps.updateChannelToggle(sendCtx.credential, record.channelId, false);
        let outcome: ShippingChannelRecord['closed'] = result.success ? 'success' : 'failed';
        if (!result.success) {
          // 结果未知时先回读确认；回读也失败 → 保留 unknown（可能已生效，所以必须留恢复义务）
          const recheck = await deps.fetchChannelList(sendCtx.credential).catch(() => null);
          const serverState = recheck?.find(c => c.channelId === record.channelId);
          if (serverState) outcome = serverState.enabled ? 'failed' : 'success';
          else outcome = 'unknown';
        }
        const merged = upsertChannelRecord(logisticsRecords, {
          ...record,
          closed: outcome,
          // 关闭未成功的渠道没有恢复义务：`restored` 不能停在 `pending`，
          // 否则界面会显示"关闭失败 · 恢复pending"，看起来像还有事要做。
          restored: outcome === 'success' ? record.restored : 'skipped',
          error: result.error,
        });
        logisticsRecords.length = 0;
        logisticsRecords.push(...merged);
        await save({ logistics: { records: [...logisticsRecords] } });
        await checkpoint('close-channel', true, String(record.channelId), outcome === 'success' ? 'success' : 'unknown');
        if (outcome !== 'success') {
          logisticsBlocked = true;
          taskError =
            outcome === 'unknown'
              ? `渠道 ${record.channelId} 关闭结果未知（可能已生效），已停止商品批改并开始恢复`
              : `渠道 ${record.channelId} 关闭未确认成功，已停止商品批改并开始恢复`;
          break;
        }
      }

      if (!logisticsBlocked) {
        await save({
          logistics: { records: [...logisticsRecords], closeCompleted: true },
          phase: 'logistics',
          message: '物流渠道已关闭，开始修改商品备货',
        });
      }
    }

    // ===== 商品批改 =====
    if (!logisticsBlocked) {
      await save({
        phase: 'writing',
        total: writable.length,
        message:
          writable.length === 0 ? '没有需要修改的商品' : `开始修改 ${writable.length} 个商品的备货天数`,
        items: mergeItemResults(current.items, dropped),
      });

      const writeResult = await writeBatches(writable, ctx, {
        batchSize: batchSizeOption,
        concurrency,
        maxRetryRounds,
        onBatch: () => {
          batches += 1;
        },
      });
      await save({
        items: mergeItemResults(current.items, writeResult.items),
        processed: mergeItemResults(current.items, writeResult.items).length,
        message: `商品批改完成：${writeResult.items.filter(i => i.status === 'success').length} 个成功`,
      });

      if (readback) {
        await save({ phase: 'readback', message: '正在回读商品状态' });
        const readbackItems = await readbackItemsFor(current, ctx);
        if (readbackItems.length > 0) {
          await save({ items: mergeItemResults(current.items, readbackItems) });
        }
      }
    }

    // ===== 物流恢复：无论成功／部分失败／停止，都必须走完 =====
    if (current.logistics.requested && current.logistics.records.some(r => needsLogisticsAction(r))) {
      const restoreResult = await restoreLogisticsForPending(current, ctx);
      if (!restoreResult.completed && !taskError) {
        taskError = '部分物流渠道未确认恢复，请查看待处理清单';
      }
    }

    const status: ShippingTaskStatus = current.stopRequested ? 'stopped' : taskError ? 'failed' : 'completed';
    await save({
      status,
      phase: status,
      error: taskError,
      message:
        status === 'stopped'
          ? '已按用户请求停止后续商品修改（已修改的备货天数保持）'
          : status === 'failed'
            ? taskError || '任务未完成'
            : '任务完成',
    });
  } catch (e: any) {
    if (e instanceof ShippingStaleWriteError) {
      // 权威记录已由别的实例标记终态：返回**权威那份**，本实例不写任何东西
      const authoritative = await deps.loadTask?.().catch(() => null);
      return finalize(authoritative && authoritative.taskId === initialTask.taskId ? authoritative : current, batches);
    }
    taskError = redactSensitiveText(e);
    // 异常也要把物流恢复做完，不能把店铺留在"物流已关"
    if (current.logistics.requested && current.logistics.records.some(r => needsLogisticsAction(r))) {
      try {
        await restoreLogisticsForPending(current, ctx);
      } catch {
        /* 恢复失败已在记录里体现，不让它盖掉原始错误 */
      }
    }
    try {
      await save({ status: 'failed', phase: 'failed', error: taskError, message: taskError ?? undefined });
    } catch {
      /* 连终态都写不进：保持原记录，由协调逻辑处理 */
    }
  } finally {
    deps.stopKeepalive();
  }

  return finalize(current, batches);
}

function finalize(task: ShippingTask, batches: number): ShippingRunResult {
  return {
    task,
    summary: {
      counts: countShippingItems(task.items),
      channels: task.logistics.records,
      batches,
      needsLogisticsRestore: channelHasPendingRestore(task.logistics.records),
    },
  };
}

// ===== 分批写 =====

interface WriteOptions {
  batchSize: number;
  concurrency: number;
  maxRetryRounds: number;
  onBatch: () => void;
}

/**
 * 分批提交商品备货。
 *
 * 批内并发上限 2、批次不超过 50（沿用源参数）。
 *
 * **只有明确被拒绝的限流才重试**：传输失败／响应无法解析的批次标 `unknown` 并**不重发**
 * （重发可能造成重复写），由回读阶段按实际状态定案（R2）。
 */
async function writeBatches(
  items: ShippingTargetItem[],
  ctx: RunContext,
  options: WriteOptions,
): Promise<{ items: ShippingItemResult[] }> {
  const results = new Map<string, ShippingItemResult>();
  let pending = [...items];
  let batchSize = options.batchSize;
  /** 因停止而中断时，未发出的商品保留 pending，不再被后面的"未定案"兜底改成 unknown */
  let stoppedEarly = false;

  /**
   * 停止判定同时看外部信号与**任务记录本身**：用户点停止时任务记录会即时落盘 `stopRequested`，
   * 但本实例可能还没重新读到外部信号。两者取或才不会漏停。
   */
  const stopped = async () => {
    if (await ctx.deps.isStopRequested()) return true;
    const stored = await ctx.deps.loadTask?.().catch(() => null);
    return stored?.taskId === ctx.getTask().taskId && stored.stopRequested === true;
  };

  /**
   * 是否已越过"还能发切现货"的截止（第 34.3 节 R2）。
   *
   * 与 `stopped()` 分开：越界不是用户停止，但同样**不得再发新的切 1 天请求**。
   * 已发出的批次先收敛核实，之后由恢复阶段接管 —— 不能并行恢复后又发迟到现货。
   */
  const pastWriteDeadline = () => {
    if (!ctx.isSpotPhase?.()) return false;
    const allowed = ctx.canSendSpotWrite?.();
    return allowed === false;
  };

  /**
   * 把"因截止／停止而未发送"的结论补到**所有还没有结论的目标商品**上。
   *
   * 为什么不能只补 `pending`：内层循环 `break` 时后面还没轮到的 chunk 根本不在 `pending` 里，
   * 那些商品会既没有结果、也没有 reason —— 界面上看不到它们，组结果里也漏项
   * （第 36.2 节第 4 条指出 125 商品只留下 100 条就是这个漏洞）。
   */
  const fillUnsent = (reason: string) => {
    for (const item of items) {
      if (results.has(item.itemId)) continue;
      results.set(item.itemId, {
        itemId: item.itemId,
        name: item.name,
        days: ctx.getTask().days,
        status: 'pending',
        reason,
      });
    }
  };

  for (let round = 0; round < options.maxRetryRounds && pending.length > 0; round++) {
    if (await stopped()) {
      await ctx.save({ stopRequested: true });
      stoppedEarly = true;
      for (const item of pending) {
        results.set(item.itemId, {
          itemId: item.itemId,
          name: item.name,
          days: ctx.getTask().days,
          status: 'pending',
          reason: '用户已停止，未发出写请求',
        });
      }
      fillUnsent('用户已停止，未发出写请求');
      break;
    }
    if (pastWriteDeadline()) {
      // 截止已过：不再发出任何新的切 1 天批次（不是"停止"，所以不置 stopRequested）
      stoppedEarly = true;
      await ctx.save({ phase: 'deadline-passed', message: '已到单次安排的截止时刻，未发出的现货批次一律不再发送' });
      for (const item of pending) {
        results.set(item.itemId, {
          itemId: item.itemId,
          name: item.name,
          days: ctx.getTask().days,
          status: 'pending',
          reason: '已到单次安排的截止时刻，未发出写请求',
        });
      }
      fillUnsent('已到单次安排的截止时刻，未发出写请求');
      break;
    }
    const chunks: ShippingTargetItem[][] = [];
    for (let i = 0; i < pending.length; i += batchSize) chunks.push(pending.slice(i, i + batchSize));

    const retry: ShippingTargetItem[] = [];
    let rateLimited = false;

    for (let i = 0; i < chunks.length; i += options.concurrency) {
      if (await stopped()) break;
      // 每批之前都要重新判截止：分批过程中可能刚好跨过恢复时刻（实测 125 商品第三批越界）
      if (pastWriteDeadline()) break;
      // 批次之间同样核验现行权限：接受任务时校验过不代表中途仍被允许（返工 14.3）。
      // 第一批之前由 submitChunk 自己核验，这里覆盖后续批次。
      if (i > 0) await ctx.verifyBeforeWrite('between-batches', true);
      const group = chunks.slice(i, i + options.concurrency);
      const groupOutcomes = await Promise.all(group.map(chunk => submitChunk(chunk, ctx)));
      let deadlineHit = false;
      for (const outcome of groupOutcomes) {
        options.onBatch();
        retry.push(...outcome.retry);
        for (const item of outcome.results) results.set(item.itemId, item);
        if (outcome.rateLimited) rateLimited = true;
        if (outcome.deadlineStopped) deadlineHit = true;
      }
      // 某一批因截止被拦下 → 本轮的后续批次同样不必再发
      if (deadlineHit) {
        stoppedEarly = true;
        break;
      }
    }

    if (await stopped()) break;
    const deadlineNow = pastWriteDeadline() || (options.hardStopAt != null && ctx.isSpotPhase?.() && Date.now() >= options.hardStopAt);
    if (deadlineNow) {
      stoppedEarly = true;
    }
    pending = retry;
    /**
     * `retry` 为空**不等于**"已经处理完所有商品"：因截止／停止 `break` 出来时，
     * 后面还没轮到的 chunk 不在 `retry` 里，那些商品仍没有任何结论。
     * 因此这里先按 `stoppedEarly` 补齐未发送结论，再看是否真的没有待处理项。
     */
    if (stoppedEarly) {
      fillUnsent(
        deadlineNow ? '已到单次安排的截止时刻，未发出写请求' : '用户已停止，未发出写请求',
      );
      break;
    }
    if (pending.length === 0) break;
    if (rateLimited) {
      batchSize = Math.max(1, Math.floor(batchSize / 2));
      await ctx.deps.sleep(1500 * (round + 1));
    } else {
      await ctx.deps.sleep(500);
    }
  }

  // 超出重试轮数仍没定案 → unknown，既不伪报失败也不伪报成功。
  // 因停止而未发出的商品不算 unknown：它们从没被尝试写，就是 pending。
  if (!stoppedEarly) {
    for (const item of pending) {
      if (results.has(item.itemId)) continue;
      results.set(item.itemId, {
        itemId: item.itemId,
        name: item.name,
        days: ctx.getTask().days,
        status: 'unknown',
        reason: `重试 ${options.maxRetryRounds} 轮后仍未确认结果，请人工核对`,
      });
    }
  }

  return { items: [...results.values()] };
}

interface ChunkOutcome {
  results: ShippingItemResult[];
  retry: ShippingTargetItem[];
  rateLimited: boolean;
  /** 本批因越过单次安排的截止而**完全未发送**（第 34.3 节 R2） */
  deadlineStopped?: boolean;
}

async function submitChunk(chunk: ShippingTargetItem[], ctx: RunContext): Promise<ChunkOutcome> {
  const results: ShippingItemResult[] = [];
  const retry: ShippingTargetItem[] = [];
  const days = ctx.getTask().days;

  // 写前核验：**任何**失败（含读取抛错）都必须终止整批，不能当"这件商品失败"继续写。
  // `Write-not-sent` 是这里的既定事实：核验通过之前不会发出任何业务请求（返工 14.2）。
  // 核验同时返回**这一份已核实的上下文**，下面的请求必须用它（返工 17.2）。
  const writeCtx = await ctx.verifyBeforeWrite('first-batch', false);
  await ctx.assertNotStale();

  /**
   * 截止复查：核验**之后、发请求之前**再判一次（第 34.3 节 R2）。
   *
   * 这一处是关键：核验（读身份、查权限）本身耗时，实测能跨过截止。
   * 若只在外层循环判一次，就会出现"决策时还在窗口内、请求却越过截止才发出去"。
   * 这里判定后**直接返回未发送**，不发请求、也不落"已发"检查点。
   */
  if (ctx.isSpotPhase?.() && ctx.canSendSpotWrite?.() === false) {
    return {
      results: chunk.map(item => ({
        itemId: item.itemId,
        name: item.name,
        days,
        status: 'pending' as const,
        reason: '已到单次安排的截止时刻，未发出写请求',
      })),
      retry: [],
      rateLimited: false,
      deadlineStopped: true,
    };
  }

  // 发请求前落检查点：中断时据此说明"哪些商品可能已被改动"
  for (const item of chunk) {
    await ctx.checkpoint('update-product-batch', true, item.itemId);
  }

  const payload: ShippingBatchRequestItem[] = chunk.map(item =>
    buildBatchItem(item.itemId, item.categoryPath, days),
  );

  let outcome;
  try {
    // 核验与发送之间若上下文变了，先停这个请求（返工 17.2）。
    // 只在真的换了归属时才停；Cookie 刷新且归属相同照常发。
    const sendCtx = await ensureContextStillVerified(
      ctx.deps,
      writeCtx,
      { taskId: ctx.getTask().taskId, shopId: ctx.getTask().shopId, ownerUserId: ctx.getTask().ownerUserId },
      'first-batch',
    );

    /**
     * **最终发写闸门**（第 37.3 节 R2）。
     *
     * 必须在**最后一段异步准备之后**再判一次：上面已经做过检查点落盘、
     * `ensureContextStillVerified`（读身份 + 查权限）。这些都可能跨过截止，
     * 而早先的判定放在它们**之前**，于是"判定通过 → 异步耗时 → 越过截止才真正发出去"
     * 依然会发生（第 36.2 节第 4 条，实测现货请求恰在 restoreAt 发出）。
     */
    if (ctx.isSpotPhase?.() && ctx.canSendSpotWrite?.() === false) {
      return {
        results: chunk.map(item => ({
          itemId: item.itemId,
          name: item.name,
          days,
          status: 'pending' as const,
          reason: '到达单次安排的截止时刻，本批在最后一步被拦下，未发出写请求',
        })),
        retry: [],
        rateLimited: false,
        deadlineStopped: true,
      };
    }

    /**
     * **发出即算开始**（第 40.4 节）。
     *
     * 在 `updateProductBatch` **被调用之前**通知：请求一旦真正发起，本阶段就算已开始，
     * 后续批次只受 `restoreAt` 硬截止约束。早先写在 `await` **之后**，
     * 于是首批响应慢时 `spotBatchSent` 仍是 false，其它并发批次继续受 5 分钟首写窗口限制：
     * 验收实测"第 4 分钟首批已发出、响应挂起跨过第 5 分钟"，125 件里只写了 50 件，其余 75 件被误截。
     *
     * 放在这**最后一道闸门之后**：此时检查点已落盘、`ensureContextStillVerified` 也已通过，
     * 前面对应的异步准备不会让"纯准备"被误当成"已开始"。
     */
    if (ctx.isSpotPhase?.()) ctx.onSpotBatchSent?.();
    outcome = await ctx.deps.updateProductBatch(sendCtx.credential, payload);
  } catch (e: any) {
    if (isTaskLevelError(e)) throw e;
    // 依赖没按契约返回结果对象时，视为"可能已写"：不重发，交回读定案
    return {
      results: chunk.map(item => ({
        itemId: item.itemId,
        name: item.name,
        days,
        status: 'unknown' as const,
        reason: `请求结果未知（${redactSensitiveText(e)}），需回读确认`,
      })),
      retry: [],
      rateLimited: false,
    };
  }

  // 传输结果未知：**不重发**，标 unknown 由回读定案（R2）
  if (outcome.transportUnknown) {
    return {
      results: chunk.map(item => ({
        itemId: item.itemId,
        name: item.name,
        days,
        status: 'unknown' as const,
        reason: `请求结果未知（${redactSensitiveText(outcome.error || '响应无法确认')}），需回读确认`,
      })),
      retry: [],
      rateLimited: false,
    };
  }

  // 明确限流：允许按原上限退避重试
  if (outcome.rateLimited) {
    return { results, retry: [...chunk], rateLimited: true };
  }

  // 顶层失败且完全没有逐项结果：整批无法解释 → 全部 unknown 交回读，不重发
  if (!outcome.topLevelSuccess && !outcome.hasItemResults) {
    return {
      results: chunk.map(item => ({
        itemId: item.itemId,
        name: item.name,
        days,
        status: 'unknown' as const,
        reason: `平台返回失败但无逐项结果（${redactSensitiveText(outcome.error || outcome.topCode || '未知')}），需回读确认`,
      })),
      retry: [],
      rateLimited: false,
    };
  }

  const perItem = new Map(outcome.itemResults.map(r => [r.id, r.code]));
  for (const item of chunk) {
    const hasEntry = perItem.has(item.itemId);
    const code = hasEntry ? perItem.get(item.itemId) : undefined;

    if (!hasEntry) {
      // 平台没给出该商品的条目：不能当成功（可能被忽略），也不能当失败 → 回读定案
      results.push({
        itemId: item.itemId,
        name: item.name,
        days,
        status: 'unknown',
        reason: '平台未返回该商品的逐项结果，需回读确认',
      });
      continue;
    }
    if (code === null || code === undefined) {
      // 条目在但**没有 code**：以前默认成 0（= 成功），这是本轮被复现的缺陷。
      // 缺 code 说明响应无法解释，按 unknown 处理并回读核实。
      results.push({
        itemId: item.itemId,
        name: item.name,
        days,
        status: 'unknown',
        reason: '平台逐项结果缺少 code，无法确认成功，需回读核实',
      });
      continue;
    }
    if (code === 0) {
      results.push({ itemId: item.itemId, name: item.name, days, status: 'success' });
      continue;
    }
    if (code === SHIPPING_ITEM_CODE.unsupportedDays) {
      // 物流不支持目标天数：单列跳过，不能算成功（源把它当成功的做法不照搬）
      results.push({
        itemId: item.itemId,
        name: item.name,
        days,
        status: 'skipped',
        reason: `物流不支持 ${days} 天备货（${code}）`,
      });
      continue;
    }
    if (code === SHIPPING_ITEM_CODE.shopeeRateLimit) {
      retry.push(item);
      continue;
    }
    results.push({
      itemId: item.itemId,
      name: item.name,
      days,
      status: 'failed',
      reason: `平台拒绝（${code}）`,
    });
  }

  return { results, retry, rateLimited: false };
}

// ===== 回读 =====

/**
 * 回读商品的实际备货天数，为"结果未知"的商品定案。
 *
 * 只回读**确实发出过写请求**但未定案的商品：已确认成功的不再读，
 * 「因停止而从未发出」的也不算 unknown（它们没被尝试写）。
 */
async function readbackItemsFor(task: ShippingTask, ctx: RunContext): Promise<ShippingItemResult[]> {
  const sentIds = new Set(task.checkpoints.filter(cp => cp.writeSent && cp.target).map(cp => String(cp.target)));
  const unresolved = task.items.filter(
    i => i.status === 'unknown' || (i.status === 'pending' && sentIds.has(i.itemId)),
  );
  if (unresolved.length === 0) return [];

  // 列表读取也要用**核验过的**凭据（返工 17.2）：核验通过后再读一次凭据去取平台数据，
  // 就会允许"按会话 A 核验、用会话 B 读"的情况发生。
  const listCtx = await ctx.verifyBeforeWrite('readback-list', false);
  const listed = await ctx.deps.fetchAllProducts(listCtx.credential);
  const byId = listed.complete
    ? new Map(listed.products.map(p => [String(p.id), p]))
    : new Map<string, ShippingProduct>();

  const out: ShippingItemResult[] = [];
  for (const item of unresolved) {
    // 回读也用**核验返回的同一份上下文**（返工 17.2）：不能用一份没核实过的凭据去读平台
    const readCtx = await ctx.verifyBeforeWrite('readback', false);
    await ctx.checkpoint('readback', false, item.itemId);

    // 先看列表字段；列表不返回备货天数时按需要读商品详情。
    // 详情可能揭示该商品是 SKU 级备货 —— 那种情况下商品级天数不作为最终结论。
    let actual = extractDaysFromProduct(byId.get(item.itemId));
    let skuLevel = false;
    if (actual === null) {
      const detail = await ctx.deps.fetchProductDetail(readCtx.credential, item.itemId).catch(() => null);
      if (detail) {
        actual = extractDaysFromDetail(detail);
        skuLevel = detail.enable_model_level_dts === true;
      }
    }

    if (skuLevel) {
      out.push({
        ...item,
        status: 'unknown',
        reason: '回读显示该商品按 SKU 设置备货天数，商品级结果需人工核对',
      });
    } else if (actual !== null && actual === task.days) {
      out.push({ ...item, status: 'success', reason: '回读确认已改为目标天数' });
    } else if (actual !== null) {
      out.push({ ...item, status: 'failed', reason: `回读显示实际为 ${actual} 天，与目标 ${task.days} 天不符` });
    } else {
      out.push({ ...item, status: 'unknown', reason: '回读未取到备货天数，无法确认结果' });
    }
  }
  return out;
}

/** 列表项里的备货天数；取不到返回 null（不把"没有这个字段"当成 0）。 */
function extractDaysFromProduct(product: ShippingProduct | undefined): number | null {
  if (!product) return null;
  const raw =
    (product as any).days_to_ship ?? (product as any).pre_order_days ?? (product as any).pre_order_info?.days_to_ship;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 商品详情里的备货天数（商品级 pre_order_info）。 */
function extractDaysFromDetail(detail: Record<string, unknown>): number | null {
  const info = (detail as any).pre_order_info;
  const n = Number(info?.days_to_ship);
  return Number.isFinite(n) ? n : null;
}

// ===== 物流义务与恢复 =====

/**
 * 需要物流动作的渠道 —— **唯一一处判断**，避免 task／runner／UI 各写一份而漂移（R4）。
 *
 * 覆盖两种情形：确实关闭过（`closed === 'success'`）与**关闭结果未知**
 * （`closed === 'unknown'`，请求已发出、可能已生效）。只针对原本启用的渠道；
 * 原先关闭的渠道不会被打开。
 */
export function needsLogisticsAction(record: ShippingChannelRecord): boolean {
  return (
    record.originallyEnabled &&
    record.restored !== 'success' &&
    (record.closed === 'success' || record.closed === 'unknown')
  );
}

/**
 * 恢复本任务影响过的原启用渠道。
 *
 * 对 `closed === 'unknown'` 的渠道先回读确认它当前状态：
 * - 已处于关闭 → 说明关闭其实生效了 → 走恢复；
 * - 仍处于开启 → 关闭没生效 → 记 `failed`/`skipped`，没有义务；
 * - 回读失败 → 保持待处理，不发恢复请求（不猜）。
 */
async function restoreLogisticsForPending(task: ShippingTask, ctx: RunContext): Promise<{ completed: boolean }> {
  const targets = task.logistics.records.filter(r => needsLogisticsAction(r));
  if (targets.length === 0) return { completed: true };

  await ctx.save({
    logistics: { restoreAttempted: true },
    phase: 'restore-logistics',
    message: `正在恢复 ${targets.length} 个原启用物流渠道`,
  });

  const records = [...task.logistics.records];
  let allRestored = true;

  for (const target of targets) {
    // 归属／权限未确认时不得恢复：直接停在待恢复状态，不发任何渠道写请求。
    // 核验返回的上下文贯穿"回读 → 开启 → 结果回读"三步，中间不再重读凭据（返工 17.2）：
    // 否则会出现"按会话 A 核验通过、用会话 B 打开渠道"，并把 B 的结果报成 A 已恢复完成。
    const restoreCtx = await ctx.verifyBeforeWrite('restore-channel', false);
    await ctx.checkpoint('restore-channel', true, String(target.channelId));

    if (target.closed === 'unknown') {
      const currentChannels = await ctx.deps.fetchChannelList(restoreCtx.credential).catch(() => null);
      const serverState = currentChannels?.find(c => c.channelId === target.channelId);
      const idx0 = records.findIndex(r => r.channelId === target.channelId);
      if (!serverState) {
        allRestored = false;
        if (idx0 >= 0) {
          records[idx0] = { ...records[idx0], restored: 'unknown', error: '回读失败，无法确认渠道当前状态' };
        }
        await ctx.save({ logistics: { records: [...records] } });
        continue;
      }
      if (serverState.enabled) {
        // 关闭其实没生效 → 没有恢复义务
        if (idx0 >= 0) records[idx0] = { ...records[idx0], closed: 'failed', restored: 'skipped' };
        await ctx.save({ logistics: { records: [...records] } });
        await ctx.checkpoint('restore-channel', false, String(target.channelId), 'failed');
        continue;
      }
      // 确实处于关闭状态 → 继续走恢复
    }

    // 核验与发送之间上下文变了就停在这里：抛 `ShippingVerificationError` 会向上传播，
    // 由 `restorePendingLogistics` 的 catch 保留快照并返回"未完成"，**不会**报成已恢复（返工 17.2）。
    const sendCtx = await ensureContextStillVerified(
      ctx.deps,
      restoreCtx,
      { taskId: ctx.getTask().taskId, shopId: ctx.getTask().shopId, ownerUserId: ctx.getTask().ownerUserId },
      'restore-channel',
    );
    const result = await ctx.deps.updateChannelToggle(sendCtx.credential, target.channelId, true);
    let outcome: ShippingChannelRecord['restored'] = result.success ? 'success' : 'failed';
    if (!result.success) {
      const channels = await ctx.deps.fetchChannelList(restoreCtx.credential).catch(() => null);
      const serverState = channels?.find(c => c.channelId === target.channelId);
      if (serverState) outcome = serverState.enabled ? 'success' : 'failed';
      else if (result.unknown) outcome = 'unknown';
    }
    const idx = records.findIndex(r => r.channelId === target.channelId);
    if (idx >= 0) records[idx] = { ...records[idx], restored: outcome, error: result.error };
    if (outcome !== 'success') allRestored = false;
    await ctx.save({ logistics: { records: [...records] } });
    await ctx.checkpoint(
      'restore-channel',
      true,
      String(target.channelId),
      outcome === 'success' ? 'success' : 'unknown',
    );
  }

  await ctx.save({
    logistics: { records, restoreCompleted: allRestored },
    message: allRestored ? '物流渠道已全部恢复' : '部分物流渠道未确认恢复，请查看待处理清单',
  });
  return { completed: allRestored };
}

/**
 * 单独执行一次"回到原店铺后恢复物流"。
 *
 * 与自动恢复分开是因为有这类真实场景：任务期间换店／登出，归属无法确认时必须停写并留下待恢复状态；
 * 用户重新登录原店铺后需要一个明确的恢复动作。
 */
export async function restorePendingLogistics(
  task: ShippingTask,
  deps: ShippingRunnerDeps,
): Promise<{ task: ShippingTask; completed: boolean; error?: string }> {
  let current = task;
  const save = async (patch: Omit<ShippingTaskPatch, 'now'>) => {
    const withNow: ShippingTaskPatch = {
      ...patch,
      message: patch.message === undefined ? undefined : redactSensitiveText(patch.message),
      error: patch.error === undefined || patch.error === null ? patch.error : redactSensitiveText(patch.error),
      now: deps.now(),
    };
    current = patchShippingTask(current, withNow);
    await deps.saveTask(current, withNow);
  };
  const checkpoint: RunContext['checkpoint'] = async (step, writeSent, target, outcome) => {
    await save({ checkpoint: { step, writeSent, target, outcome, at: deps.now() } });
  };

  if (task.logistics.records.filter(r => needsLogisticsAction(r)).length === 0) {
    return { task, completed: true };
  }

  await deps.startKeepalive();
  try {
    const ctx: RunContext = {
      deps,
      save,
      checkpoint,
      // 恢复同样走**共有**核验：归属 + 账号 + 现行权限，任一失败即停，不发渠道写请求（返工 14.3）
      verifyBeforeWrite: (stage, writeSent) =>
        verifyWriteAnchor(
          deps,
          { taskId: current.taskId, occurrenceId: current.occurrenceId, shopId: current.shopId, ownerUserId: current.ownerUserId },
          stage,
          writeSent,
        ),
      assertNotStale: async () => {},
      getTask: () => current,
    };
    const result = await restoreLogisticsForPending(current, ctx);
    if (result.completed) return { task: current, completed: true };
    // 恢复未完成：把真正原因交回界面（核验失败 / 回读失败 / 平台拒绝），不笼统说"失败"
    return { task: current, completed: false, error: current.error || current.message };
  } catch (e: any) {
    // 核验失败要留下可读原因并保留待恢复快照（不伪报完成）
    return { task: current, completed: false, error: redactSensitiveText(e) };
  } finally {
    deps.stopKeepalive();
  }
}