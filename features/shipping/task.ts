/**
 * shipping 任务的持久契约与纯决策：创建、打补丁、归类、计数、终态判定、孤儿协调。
 *
 * 为什么与 runner 分开：这些决策（"什么算完成""中断后能不能重放""哪些写请求已发出"）
 * 是验收矩阵 S3／S4／S5 直接检查的对象，必须能在没有浏览器的情况下单测。
 * 与既有 `one-day-sku-task.ts` 的分工一致，不把两套任务的判定混在一起。
 */

import {
  SHIPPING_TERMINAL_STATUSES,
  type ShippingChannelRecord,
  type ShippingItemResult,
  type ShippingItemStatus,
  type ShippingTask,
  type ShippingTaskCounts,
  type ShippingTaskStatus,
} from './types';

export interface CreateShippingTaskInput {
  taskId: string;
  requestId: string;
  shopId: number | null;
  ownerUserId: number | null;
  source: 'manual' | 'plan' | 'group';
  planId?: string;
  occurrenceId?: string;
  /** 所属单次组（`source === 'group'` 时有值），组阶段据此回写（第 31 节） */
  groupId?: string;
  /** 本任务属于组里哪一阶段 */
  groupPhase?: 'spot' | 'restore';
  mode: ShippingTask['mode'];
  days: number;
  range: ShippingTask['range'];
  excludeIds: string[];
  total: number;
  toggleLogistics: boolean;
  now: number;
}

export function createShippingTask(input: CreateShippingTaskInput): ShippingTask {
  return {
    taskId: input.taskId,
    requestId: input.requestId,
    shopId: input.shopId,
    ownerUserId: input.ownerUserId,
    source: input.source,
    planId: input.planId,
    occurrenceId: input.occurrenceId,
    groupId: input.groupId,
    groupPhase: input.groupPhase,
    mode: input.mode,
    days: input.days,
    range: input.range,
    excludeIds: [...input.excludeIds],
    status: 'running',
    phase: 'accepted',
    total: input.total,
    processed: 0,
    items: [],
    logistics: {
      requested: input.toggleLogistics,
      closeAttempted: false,
      closeCompleted: false,
      restoreAttempted: false,
      restoreCompleted: false,
      records: [],
    },
    checkpoints: [],
    message: '任务已被后台接受',
    error: null,
    startedAt: input.now,
    updatedAt: input.now,
    stopRequested: false,
  };
}

export function isTerminalShippingStatus(status: ShippingTaskStatus): boolean {
  return SHIPPING_TERMINAL_STATUSES.includes(status);
}

/** 任务是否仍在推进（含"结果未知"）。终态一律为 false。 */
export function isShippingTaskActive(task: ShippingTask | null | undefined): boolean {
  return !!task && !isTerminalShippingStatus(task.status);
}

export interface ShippingTaskPatch {
  status?: ShippingTaskStatus;
  phase?: string;
  total?: number;
  processed?: number;
  items?: ShippingItemResult[];
  logistics?: Partial<ShippingTask['logistics']>;
  checkpoint?: ShippingTask['checkpoints'][number];
  message?: string;
  error?: string | null;
  stopRequested?: boolean;
  now: number;
}

/**
 * 把补丁应用到任务记录。
 *
 * 两条不可回退的规则：
 * 1. 已经是终态的记录不能被补丁拉回运行中（迟到心跳／迟到写入）；
 * 2. 检查点只追加、不替换，否则中断后会丢失"哪些写请求已发出"的证据。
 */
export function patchShippingTask(task: ShippingTask, patch: ShippingTaskPatch): ShippingTask {
  if (isTerminalShippingStatus(task.status) && patch.status && !isTerminalShippingStatus(patch.status)) {
    return { ...task, updatedAt: patch.now };
  }
  const nextStatus = patch.status ?? task.status;
  const next: ShippingTask = {
    ...task,
    status: nextStatus,
    // 进入终态时 phase 跟随状态，避免出现"状态已完成、阶段仍写着 writing"的错位显示；
    // 显式传入的 phase 优先，方便运行期阶段推进。
    phase: patch.phase ?? (isTerminalShippingStatus(nextStatus) ? nextStatus : task.phase),
    total: patch.total ?? task.total,
    processed: patch.processed ?? task.processed,
    items: patch.items ?? task.items,
    message: patch.message ?? task.message,
    error: patch.error !== undefined ? patch.error : task.error,
    stopRequested: patch.stopRequested ?? task.stopRequested,
    updatedAt: patch.now,
  };
  if (patch.logistics) next.logistics = { ...task.logistics, ...patch.logistics };
  if (patch.checkpoint) next.checkpoints = [...task.checkpoints, patch.checkpoint];
  if (isTerminalShippingStatus(next.status) && next.finishedAt === undefined) {
    next.finishedAt = patch.now;
  }
  return next;
}

/** 按 ID 合并逐商品结果：同一商品只保留一条最终状态，不累加重试次数。 */
export function mergeItemResults(
  existing: ShippingItemResult[],
  incoming: ShippingItemResult[],
): ShippingItemResult[] {
  const map = new Map<string, ShippingItemResult>();
  for (const item of existing) map.set(item.itemId, item);
  for (const item of incoming) map.set(item.itemId, item);
  return [...map.values()];
}

export function countShippingItems(items: ShippingItemResult[]): ShippingTaskCounts {
  const counts: ShippingTaskCounts = { success: 0, failed: 0, skipped: 0, unknown: 0, pending: 0 };
  for (const item of items) {
    counts[item.status] += 1;
  }
  return counts;
}

/**
 * 由逐项结果推导任务终态。
 *
 * `unknown` 不算成功也不算失败：它意味着"写请求已发出但结果没确认"，
 * 如果把它算成失败，用户会重复处理本已改成功的商品；算成成功则会掩盖真实缺口。
 */
export function deriveTaskStatus(
  counts: ShippingTaskCounts,
  options: { stopRequested: boolean; taskError?: string | null },
): ShippingTaskStatus {
  if (options.stopRequested) return 'stopped';
  if (counts.failed > 0 || counts.unknown > 0) return 'completed';
  if (options.taskError) return 'failed';
  return 'completed';
}

/** 任务是否可以宣布"整体成功"：有任何未知／失败／跳过或待恢复物流都不算。 */
export function isOverallSuccess(task: ShippingTask): boolean {
  const counts = countShippingItems(task.items);
  if (counts.failed > 0 || counts.unknown > 0 || counts.pending > 0) return false;
  if (task.logistics.requested) {
    if (!task.logistics.restoreCompleted) return false;
    // 关闭失败或**关闭结果未知**都算未收尾：未知可能已经生效，不能宣布整体成功
    if (task.logistics.records.some(r => r.closed === 'failed' || r.closed === 'unknown')) return false;
    if (task.logistics.records.some(r => r.originallyEnabled && r.restored !== 'success')) return false;
  }
  return true;
}

// ===== 物流记录合并 =====

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

/** 需要用户处理的渠道：原本启用，且本次未能确认恢复（含关闭结果未知）。 */
export function channelsAwaitingRestore(records: ShippingChannelRecord[]): ShippingChannelRecord[] {
  return records.filter(
    r =>
      r.originallyEnabled &&
      r.restored !== 'success' &&
      (r.closed === 'success' || r.closed === 'unknown'),
  );
}

/** 本次确实关闭过（或关闭结果未知）的渠道。 */
export function channelsToRestore(records: ShippingChannelRecord[]): ShippingChannelRecord[] {
  return records.filter(r => r.originallyEnabled && (r.closed === 'success' || r.closed === 'unknown'));
}

// ===== 中断与孤儿 =====

/**
 * 协调"没有执行者"的记录。
 *
 * MV3 同一扩展只有一个 service worker，因此本实例没在跑就等于没有执行者
 * （沿用一键修复的判定口径，不依赖会被回收的 setTimeout）。
 * 协调只把状态标成 interrupted 并**保留**已有结果与检查点，不自动重放商品写。
 */
export function resolveOrphanedShippingTask(
  task: ShippingTask,
  isExecutor: boolean,
  heartbeat: { taskId: string; at: number } | null,
): ShippingTask | null {
  if (!isShippingTaskActive(task)) return null;
  if (isExecutor) return null;
  const reason = heartbeat && heartbeat.taskId === task.taskId
    ? `执行者已中断（最后心跳 ${new Date(heartbeat.at).toISOString()}）`
    : '执行者已中断';
  return {
    ...task,
    status: 'interrupted',
    phase: 'interrupted',
    ...(task.message ? {} : {}),
    message: `${reason}，已完成 ${countShippingItems(task.items).success} 个商品；未确认的写请求不会被自动重放`,
    error: task.error ?? null,
    updatedAt: Date.now(),
    finishedAt: Date.now(),
  };
}

/** 已发出写请求但结果未知的商品 ID（用于中断后如实列出"需要人工核对"）。 */
export function itemsWithSentWrites(task: ShippingTask): string[] {
  const out = new Set<string>();
  for (const cp of task.checkpoints) {
    if (cp.writeSent && cp.target) out.add(cp.target);
  }
  return [...out];
}

// ===== 首页摘要 =====

export type ShippingSummaryTone = 'running' | 'pending' | 'done' | 'interrupted';

export interface ShippingSummary {
  kind: 'shipping';
  title: string;
  detail: string;
  actionLabel: string;
  tone: ShippingSummaryTone;
}

/** 首页任务摘要：由真实记录派生，绝不把"启动请求成功"显示成"商品修改成功"。 */
export function buildShippingSummary(task: ShippingTask | null | undefined): ShippingSummary | null {
  if (!task) return null;
  if (isShippingTaskActive(task)) {
    const counts = countShippingItems(task.items);
    return {
      kind: 'shipping',
      title: '商品备货修改进行中',
      detail: `${counts.success} 成功 / ${counts.failed} 失败 / ${counts.unknown} 待核对`,
      actionLabel: '查看任务',
      tone: 'running',
    };
  }
  if (task.status === 'interrupted') {
    return {
      kind: 'shipping',
      title: '商品备货修改已中断',
      detail: '部分商品可能已被修改，请查看结果',
      actionLabel: '查看任务',
      tone: 'interrupted',
    };
  }
  const counts = countShippingItems(task.items);
  if (channelsAwaitingRestore(task.logistics.records).length > 0) {
    return {
      kind: 'shipping',
      title: '原店铺物流待恢复',
      detail: `${channelsAwaitingRestore(task.logistics.records).length} 个渠道未确认恢复`,
      actionLabel: '查看任务',
      tone: 'interrupted',
    };
  }
  if (counts.failed > 0 || counts.unknown > 0) {
    return {
      kind: 'shipping',
      title: '商品备货修改有未完成项',
      detail: `${counts.success} 成功 / ${counts.failed} 失败 / ${counts.unknown} 待核对`,
      actionLabel: '查看任务',
      tone: 'done',
    };
  }
  return {
    kind: 'shipping',
    title: '商品备货修改完成',
    detail: `${counts.success} 个商品已修改并回读`,
    actionLabel: '查看任务',
    tone: 'done',
  };
}

/** 界面用的状态文案；与判定逻辑分离，改文案不影响归类。 */
export const SHIPPING_ITEM_STATUS_LABEL: Record<ShippingItemStatus, string> = {
  pending: '未执行',
  success: '成功',
  failed: '失败',
  skipped: '跳过',
  unknown: '待核对',
};
