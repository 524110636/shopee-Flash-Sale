/**
 * runner 的依赖接口。
 *
 * 为什么单独一份：runner 必须能在 background 与单测里跑同一份代码。
 * 把"它能用到什么"显式列出来（请求、Cookie、实际身份、存储、时钟、停止、保活），
 * 就能一眼看出它**不依赖** React／Zustand／DOM —— 这是验收矩阵 S10 的结构要求。
 * 具体实现（页面注入请求、chrome.storage 读写、alarms）只出现在 background 的接线处。
 */

import type {
  ShippingChannel,
  ShippingChannelRecord,
  ShippingDiagnostic,
  ShippingItemResult,
  ShippingProduct,
  ShippingTask,
} from './types';
import type { ShippingTaskPatch } from './task';
import type { ShippingBatchRequestItem } from './rules';

export interface ShippingCredential {
  spcCds: string;
  spcCdsVer: string;
}

/**
 * **一次已核实的卖家上下文**（返工 17.2）。
 *
 * 为什么要有这个类型：核验（读身份、查权限）与紧随的业务请求必须用**同一份**凭据。
 * 早先的实现是"核验时读一次 `getCredential()`，发请求时再读一次"，
 * 两次读之间 Cookie 可能已经换成另一个会话 —— 于是出现"按会话 A 核验通过、
 * 实际用会话 B 发写请求"，甚至把 B 的结果报成 A 已恢复完成。
 *
 * 因此：核验阶段把凭据与核实到的身份**一起**返回；业务请求只接受这份上下文，
 * 不再自己去读凭据。
 */
export interface ShippingVerifiedContext {
  credential: ShippingCredential;
  /** 由**同一份**凭据核实出的店铺；`null` 表示核实不到（调用方必须停写） */
  shopId: number | null;
  /** 由同一份凭据核实出的后端账号 id；无法取得为 null */
  userId: number | null;
}

export interface ShippingIdentity {
  /** 必须来自实际核实；核实不到返回 null，调用方据此停止写 */
  shopId: number | null;
  accountId: number | null;
}

export interface ShippingBatchOutcome {
  topLevelSuccess: boolean;
  /**
   * 逐项结果。`code: null` 表示平台没给这一项的 code ——
   * 调用方必须按"无法解释"处理（先回读核实，不能当成功）。
   */
  itemResults: Array<{ id: string; code: number | null }>;
  error?: string;
  /** 顶层业务错误码（用于区分限流与其他拒绝） */
  topCode?: number;
  /** 响应里带了逐项结果数组 */
  hasItemResults?: boolean;
  /** 明确限流（可退避重试） */
  rateLimited?: boolean;
  /** 传输结果未知：请求可能已到平台，**不得重发**，交回读定案 */
  transportUnknown?: boolean;
}

export interface ShippingChannelToggleOutcome {
  success: boolean;
  error?: string;
  /** 结果未知（发送成功但响应不可解析）：需要回读确认 */
  unknown?: boolean;
}

export interface ShippingRunnerDeps {
  /** 在 MAIN world 注入执行；由 background 提供，不依赖 popup 活跃标签页 */
  getCredential: () => Promise<ShippingCredential>;
  /**
   * 一次已核实的卖家上下文：**同一份凭据** + 用它的核实出的身份（返工 17.2）。
   *
   * 注入时优先使用它；未注入时退回 `getCredential()` + `getShopIdentity()`
   * （两条读之间可能变化，仅供隔离单测与降级路径）。
   */
  verifiedContext?: () => Promise<ShippingVerifiedContext>;
  /** 当前实际登录的店铺与虾皮账号；`shopId === null` 表示核实不到 */
  getShopIdentity: () => Promise<ShippingIdentity>;
  /** 当前认证的后端账号 id（与虾皮 accountId 不同域）；取不到返回 null */
  getAuthUserId?: () => Promise<number | null>;

  fetchAllProducts: (
    credential: ShippingCredential,
  ) => Promise<{ products: ShippingProduct[]; complete: boolean; error?: string }>;
  fetchFlashSaleExcludeIds: (
    credential: ShippingCredential,
  ) => Promise<{ ok: boolean; itemIds: Set<string>; error?: string }>;
  fetchChannelList: (credential: ShippingCredential) => Promise<ShippingChannel[] | null>;
  /**
   * 商品详情（按需）。用于回读：列表端点不一定返回备货天数字段时，
   * 靠详情确认实际天数与 SKU 级结构。
   */
  fetchProductDetail: (credential: ShippingCredential, itemId: string) => Promise<Record<string, unknown> | null>;
  updateChannelToggle: (
    credential: ShippingCredential,
    channelId: number,
    enabled: boolean,
  ) => Promise<ShippingChannelToggleOutcome>;
  updateProductBatch: (
    credential: ShippingCredential,
    payload: ShippingBatchRequestItem[],
  ) => Promise<ShippingBatchOutcome>;

  /** 持久保存任务；必须真正落盘，失败要抛错 */
  saveTask: (task: ShippingTask, patch: ShippingTaskPatch) => Promise<void>;
  /** 读取当前权威记录；用于写入前确认没有更新的状态（防迟到写入回退） */
  loadTask?: () => Promise<ShippingTask | null>;

  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 任务活动期间的有界保活 */
  startKeepalive: () => void;
  stopKeepalive: () => void;

  /** 是否已请求停止（只阻止后续商品写，不撤销已确认修改） */
  isStopRequested: () => boolean | Promise<boolean>;
  /**
   * 现行后端权限核验（返工 14.3）。写前每个边界都要现读现验：
   * 接受任务时校验过不代表整个执行期仍被允许。
   * 未注入时跳过权限检查（仅用于隔离单测）。
   */
  validateAccess?: (
    credential: ShippingCredential,
    shopId: number | null,
  ) => Promise<{ allowed: boolean; error?: string }>;
  /** 运行期日志（脱敏；不得传凭据） */
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /**
   * 最小脱敏诊断（返工 14.3 要求）：核验失败时记录阶段、锚、权限结果与是否已发写请求。
   * 由调用方负责脱敏与限量；实现不得保存 Cookie／token／原请求地址。
   */
  recordDiagnostic?: (entry: Omit<ShippingDiagnostic, 'at'>) => Promise<void>;
}

export interface ShippingRunnerOptions {
  batchSize?: number;
  concurrency?: number;
  maxRetryRounds?: number;
  /** 是否做回读（单测可关闭） */
  readback?: boolean;
  /**
   * 本任务是否属于"切现货"阶段（第 34.3 节 R2）。
   *
   * 只有单次组的 `spot` 阶段为 true：它的写请求受启动窗口截止约束；
   * 手动修改与恢复常规天数不受该截止约束。
   */
  spotPhase?: boolean;
  /**
   * 现在是否仍允许发出"切 1 天"请求（返回 false 即停止发新批次）。
   *
   * 由调用方（单次组）按 `startAt ≤ now < min(startAt+5分钟, restoreAt)` 判定，
   * 在**每个写边界之前**重新求值，把截止落实到真实发送而不是调度决策。
   */
  canSendSpotWrite?: () => boolean;
  /** 本批写请求的绝对截止时刻；请求不得在它之后发出（第 34.3 节 R2） */
  writeDeadlineAt?: number | null;
  /**
   * 本阶段的**全程截止**（单次组即为 `restoreAt`）。
   *
   * 与 `writeDeadlineAt`（首写窗口）分开：已经正常开始的分批允许超过 5 分钟容差，
   * 但到 `restoreAt` 必须停止发送新的切 1 天批次（第 37.3 节）。
   */
  hardStopAt?: number | null;
  /**
   * 真的发出过一批现货写之后回调。
   *
   * 调用方据此把约束从"首写窗口"切换为"仅 restoreAt"——
   * 用持久检查点／本次已发事实判定开始，而不是靠"已认领"。
   */
  onSpotBatchSent?: () => void;
  /**
   * 写前核实"当前实际备货天数"（第 34.5 节 R4）。
   *
   * 为什么要有：恢复阶段的原始对象来自组记录（"本轮曾把它切到 1 天"），
   * 但**那之后用户可能又自己改过**。若直接按记录里的 ID 覆盖写，
   * 就会把用户后来的设置抹掉，还会把这种覆盖报成"已恢复"。
   *
   * 因此恢复前逐项读权威详情并分类：
   * - 仍是 `expectedCurrent`（1 天）→ 确实需要恢复，进入写集合；
   * - 已是 `targetDays` → 记回读完成（`alreadyAtTarget`），**不重复写**；
   * - 两者都不是 → 状态冲突，**不写**，留需处理；
   * - 读不到 → 无法确认，**不写**，留需处理。
   */
  verifyCurrentDays?: { expectedCurrent: number; targetDays: number };
}

/** 是否还有需要用户处理的物流恢复义务。 */
export function channelHasPendingRestore(records: ShippingChannelRecord[]): boolean {
  return records.some(
    r =>
      r.originallyEnabled &&
      r.restored !== 'success' &&
      (r.closed === 'success' || r.closed === 'unknown'),
  );
}

/**
 * 商品结果合并：同一商品只保留一条最终状态。
 * 重试过程中不累加失败次数 —— 验收矩阵明确要求"不重复计算失败商品"。
 */
export function mergeItemResults(
  existing: ShippingItemResult[],
  incoming: ShippingItemResult[],
): ShippingItemResult[] {
  const map = new Map<string, ShippingItemResult>();
  for (const item of existing) map.set(item.itemId, item);
  for (const item of incoming) map.set(item.itemId, item);
  return [...map.values()];
}

/** 按渠道号合并物流记录。 */
export function upsertChannelRecord(
  records: ShippingChannelRecord[],
  update: ShippingChannelRecord,
): ShippingChannelRecord[] {
  const idx = records.findIndex(r => r.channelId === update.channelId);
  if (idx < 0) return [...records, update];
  const next = [...records];
  next[idx] = { ...next[idx], ...update };
  return next;
}
