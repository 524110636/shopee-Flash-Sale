/**
 * 单次成对安排的**纯决策规则**（任务书第 31 节 31.5／31.6）。
 *
 * 为什么单独一份而不是写进 `scheduler.ts`：
 * 旧的"两项独立计划"与新的"一组单次安排"是**两套**语义（前者是某天某时刻跑一次，
 * 后者是必须成对收尾的一件业务）。混在一处会让"错过开始要不要补切"
 * "恢复对象是谁"这类规则在两套模型间漂移。这里只放纯函数：
 * 不碰浏览器 API、不碰 storage、不 import React，因此可以被单测用可控时钟直接覆盖。
 *
 * 关键语义：
 * - 首次切 1 天必须落在 `[startAt, min(startAt+5min, restoreAt))` 窗口内；
 * - 窗口外且从未发过写请求 → 已错过，两阶段零写，**绝不补切 1 天**；
 * - 已确认达到 1 天的商品保留恢复义务，恢复对象**只用**确认过的那一份集合；
 * - 同一阶段只认领一次，迟到的旧回调不得回退已完成阶段。
 */

import {
  SHIPPING_MAX_DAYS,
  SHIPPING_MIN_DAYS,
  SHIPPING_START_WINDOW_MINUTES,
  type ShippingGroup,
  type ShippingGroupConfig,
  type ShippingGroupItemOutcome,
  type ShippingGroupPhase,
  type ShippingGroupsRecord,
  type ShippingGroupSchedule,
  type ShippingItemStatus,
} from './types';
import { parseExcludeIds, taipeiDateString } from './rules';

/** 切现货固定 1 天。 */
export const SHIPPING_SPOT_DAYS = 1;

/** 常规备货天数允许范围（2–10；1 天是现货，不作为"常规"选项）。 */
export const SHIPPING_REGULAR_MIN_DAYS = SHIPPING_MIN_DAYS + 1;
export const SHIPPING_REGULAR_MAX_DAYS = SHIPPING_MAX_DAYS;

/** 常规备货天数可选值，供下拉框按固定顺序渲染，避免界面与校验各写一份范围。 */
export const SHIPPING_REGULAR_DAY_OPTIONS: number[] = Array.from(
  { length: SHIPPING_REGULAR_MAX_DAYS - SHIPPING_REGULAR_MIN_DAYS + 1 },
  (_, i) => SHIPPING_REGULAR_MIN_DAYS + i,
);

/** 是否为合法的常规备货天数（2–10）。 */
export function isValidRegularDays(days: unknown): days is number {
  const n = Number(days);
  return (
    Number.isInteger(n) && n >= SHIPPING_REGULAR_MIN_DAYS && n <= SHIPPING_REGULAR_MAX_DAYS
  );
}

// ===== 组记录的构造与校验 =====

export interface CreateGroupInput {
  groupId: string;
  schedule: ShippingGroupSchedule;
  config: ShippingGroupConfig;
  ownerShopId: number | null;
  ownerUserId: number | null;
  now: number;
}

/**
 * 校验一组单次安排的输入；返回错误文案或 null。
 *
 * **前后台共用同一份**：界面据此禁用按钮，后台据此拒绝，避免"界面看着合法、后台也照做"
 * 或反过来的错位（31.3 要求 background 也校验，不能仅靠表单）。
 */
export function validateGroupInput(input: {
  schedule: Partial<ShippingGroupSchedule>;
  config?: Partial<ShippingGroupConfig>;
  ownerShopId?: number | null;
  ownerUserId?: number | null;
  now: number;
}): string | null {
  const { schedule, now } = input;
  if (schedule.spotDays !== undefined && Number(schedule.spotDays) !== SHIPPING_SPOT_DAYS) {
    return '切现货天数固定为 1 天，不接受其他值';
  }
  if (!isValidRegularDays(schedule.regularDays)) {
    return `常规备货天数必须是 ${SHIPPING_REGULAR_MIN_DAYS}–${SHIPPING_REGULAR_MAX_DAYS} 之间的整数`;
  }
  if (!Number.isFinite(schedule.startAt)) return '请选择开始日期和时间';
  if (!Number.isFinite(schedule.restoreAt)) return '请选择恢复日期和时间';
  if (Number(schedule.restoreAt) <= Number(schedule.startAt)) {
    return '恢复时间必须严格晚于开始时间';
  }
  if (Number(schedule.startAt) <= now) {
    return '开始时间不能是已经过去的时刻，请重新选择';
  }
  if (input.config) {
    if (input.config.range && !['all', 'online', 'offline'].includes(input.config.range)) {
      return '修改范围无效';
    }
    if (input.config.toggleLogistics !== undefined && typeof input.config.toggleLogistics !== 'boolean') {
      return '物流开关必须是布尔值';
    }
  }
  if (input.ownerShopId === null) return '无法核实当前店铺，请先打开卖家中心页面并确认已登录';
  if (input.ownerUserId === null) return '无法核实当前账号，请先确认已登录';
  return null;
}

/** 由已确认的输入构造一组新安排（阶段为 `scheduled`，尚未认领任何阶段）。 */
export function createShippingGroup(input: CreateGroupInput): ShippingGroup {
  return {
    groupId: input.groupId,
    revision: 1,
    executionMode: 'once',
    ownerShopId: input.ownerShopId,
    ownerUserId: input.ownerUserId,
    schedule: { ...input.schedule },
    config: { ...input.config, excludeIds: parseExcludeIds(input.config.excludeIds).join('\n') },
    phase: 'scheduled',
    claimedStages: [],
    spotTaskId: null,
    restoreTaskId: null,
    reconciledTaskIds: [],
    confirmedSpotItemIds: [],
    items: [],
    pendingItemIds: [],
    message: '已保存安排，等待开始时间',
    error: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** 组的阶段是否为终态（不再自动推进）。 */
export function isGroupTerminal(group: ShippingGroup): boolean {
  return group.phase === 'done' || group.phase === 'missed';
}

/** 组是否还持有恢复义务（已确认切到 1 天但尚未确认恢复完成）。 */
export function groupHoldsRestoreObligation(group: ShippingGroup): boolean {
  if (group.confirmedSpotItemIds.length === 0) return false;
  if (group.phase === 'missed') return false;
  return group.items.some(
    item =>
      group.confirmedSpotItemIds.includes(item.itemId) &&
      (item.spot === 'success' || item.spot === 'unknown') &&
      item.restore !== 'success',
  );
}

/**
 * 开始窗口的截止时刻。
 *
 * `min(startAt + 5min, restoreAt)`：容差不得越过恢复时刻——
 * 否则会出现"恢复时间已到、却才开始切 1 天"的倒挂（31.6 规则 2）。
 */
export function spotWindowDeadline(schedule: ShippingGroupSchedule): number {
  const tolerance = schedule.startAt + SHIPPING_START_WINDOW_MINUTES * 60_000;
  return Math.min(tolerance, schedule.restoreAt);
}

export type GroupAction =
  | { kind: 'wait'; reason: string }
  | { kind: 'start-spot'; stage: string }
  | { kind: 'wait-restore'; reason: string }
  | { kind: 'start-restore'; stage: string }
  | { kind: 'mark-missed' }
  | { kind: 'needs-attention'; reason: string }
  | { kind: 'nothing' };

/**
 * 决定在 `now` 这一刻这一组该做什么。**纯函数**，事务性推进与落盘由调用方负责。
 *
 * `occupancy` 表达外部约束（身份／权限／冲突／待恢复物流／已有任务在跑）；
 * 任一不满足就 `wait`，**不跳过**、也不改变阶段——这样用户下次上线仍能继续。
 */
export function decideGroupAction(
  group: ShippingGroup,
  now: number,
  occupancy: {
    identityOk: boolean;
    otherWriteConflict?: string | null;
    taskActive: boolean;
    /** 本组已发出的商品写结果未知，须先核实再决定 */
    hasUnknownWrites?: boolean;
  },
): GroupAction {
  // 结果不明／需处理：不自动重发，等人处理（31.6 规则 6）
  if (group.phase === 'needs-attention') {
    return { kind: 'needs-attention', reason: group.error || group.message || '结果不明，需人工处理' };
  }
  if (group.phase === 'done' || group.phase === 'missed') return { kind: 'nothing' };

  const { schedule } = group;

  if (group.phase === 'scheduled') {
    // 已到或已过恢复时刻却从未开始：绝不能再补切 1 天（31.6 规则 2）
    if (now >= schedule.restoreAt) return { kind: 'mark-missed' };
    if (now < schedule.startAt) return { kind: 'wait', reason: '尚未到开始时间' };
    if (now >= spotWindowDeadline(schedule)) return { kind: 'mark-missed' };
    if (group.claimedStages.includes('spot')) {
      // 已认领但阶段未推进：说明上次启动失败，等下一次补检，不重复认领
      return { kind: 'wait', reason: '本组开始阶段已认领，等待上一次结果落盘' };
    }
    if (!occupancy.identityOk) return { kind: 'wait', reason: '当前店铺身份／登录状态不可用' };
    if (occupancy.otherWriteConflict) return { kind: 'wait', reason: occupancy.otherWriteConflict };
    if (occupancy.taskActive) return { kind: 'wait', reason: '已有备货修改任务在执行，等待它结束' };
    return { kind: 'start-spot', stage: 'spot' };
  }

  if (group.phase === 'cutting') {
    // 正在切 1 天：不重复认领；由该任务自己推进到 awaiting-restore
    if (occupancy.taskActive) return { kind: 'nothing' };
    if (occupancy.hasUnknownWrites) {
      return { kind: 'needs-attention', reason: '已发出商品写请求但结果未知，需先核实' };
    }
    return { kind: 'wait', reason: '切现货阶段尚未落盘终态，等待补检' };
  }

  if (group.phase === 'awaiting-restore') {
    if (now < schedule.restoreAt) return { kind: 'wait', reason: '尚未到恢复时间' };
    if (group.claimedStages.includes('restore')) {
      return { kind: 'wait', reason: '本组恢复阶段已认领，等待上一次结果落盘' };
    }
    if (occupancy.taskActive) return { kind: 'wait', reason: '已有备货修改任务在执行，等待它结束' };
    // 恢复义务存在时，身份／权限不满足就等待——绝不绕过核验"优先恢复"（31.6 规则 6）
    if (!occupancy.identityOk) return { kind: 'wait', reason: '当前店铺身份／登录状态不可用，无法恢复' };
    if (occupancy.otherWriteConflict) return { kind: 'wait', reason: occupancy.otherWriteConflict };
    if (group.confirmedSpotItemIds.length === 0) {
      return { kind: 'needs-attention', reason: '没有任何已确认切到 1 天的商品，无法确定恢复对象' };
    }
    return { kind: 'start-restore', stage: 'restore' };
  }

  // restoring：任务在跑就等它，其它情况交给补检判定
  if (group.phase === 'restoring') {
    if (occupancy.taskActive) return { kind: 'nothing' };
    return { kind: 'wait', reason: '恢复阶段尚未落盘终态，等待补检' };
  }

  return { kind: 'nothing' };
}

// ===== 阶段推进 =====

/** 认领一个阶段：写进 `claimedStages`，保证重复 alarm 不重复认领（31.6 规则 7）。 */
export function claimGroupStage(group: ShippingGroup, stage: string, now: number): ShippingGroup {
  if (group.claimedStages.includes(stage)) return group;
  return { ...group, claimedStages: [...group.claimedStages, stage], revision: group.revision + 1, updatedAt: now };
}

/**
 * 释放一个阶段的认领，并把组放回**可重新认领**的前一阶段（第 40.3 节）。
 *
 * 为什么需要它：`advanceGroupPhase` 只允许阶段**前进**（那是防迟到回调把已完成的阶段改回去）。
 * 本处不是迟到回调，而是**有意放弃一次尚未产生任何写的认领**：
 * 恢复段认领之后、新任务创建之前失败（临时 503／权限暂拒／身份读取抛错），
 * 此时没有任何新的写请求、义务仍完整，必须能重新认领；
 * 否则组会永远停在"恢复中／需处理"，商品停在 1 天没人恢复。
 *
 * 回退的代价被显式记录：`revision` 递增（旧回调据此失效）、
 * `claimedStages` 去掉该阶段（补检能重新认领）、`message` 说明来源。
 */
export function releaseStageClaim(
  group: ShippingGroup,
  stage: string,
  next: ShippingGroupPhase,
  now: number,
  patch: Partial<ShippingGroup> = {},
): ShippingGroup {
  return {
    ...group,
    ...patch,
    phase: next,
    revision: group.revision + 1,
    claimedStages: group.claimedStages.filter(s => s !== stage),
    updatedAt: now,
  };
}

/**
 * 阶段推进。**只允许前进**：迟到的旧回调（用旧的 `revision`）不得把阶段改回去。
 *
 * 返回 `null` 表示这次推进被拒绝（调用方应保持原记录不动）。
 */
const PHASE_ORDER: Record<ShippingGroupPhase, number> = {
  scheduled: 0,
  cutting: 1,
  'awaiting-restore': 2,
  restoring: 3,
  done: 4,
  missed: 4,
  // 注意：`needs-attention` **不在**这条单调序里。它是"异常旁路"，可以从任何未结束阶段进入，
  // 也可以被"条件恢复后的重新核实"退出（第 37.2 节要求它不是死胡同）。终态保护单独判定。
  'needs-attention': 2,
};

export function advanceGroupPhase(
  group: ShippingGroup,
  next: ShippingGroupPhase,
  now: number,
  patch: Partial<ShippingGroup> = {},
): ShippingGroup | null {
  if (next === group.phase) return { ...group, ...patch, revision: group.revision + 1, updatedAt: now };
  /**
   * **终态不可回退**（第 34.6 节 R5）：已完成／已错过之后任何回调都不得改写。
   */
  if (group.phase === 'done' || group.phase === 'missed') return null;
  /**
   * 从 `needs-attention` **退出**只有在真正能继续时才允许（第 37.2 节）。
   *
   * 允许它退出是因为"需处理"不应该成为死胡同：临时断网、后端校验短暂失败、
   * 用户修好渠道之后，义务还在，程序必须能继续核实收尾。
   * 但**不允许**借退出之机回退到更早的阶段（比如 `restoring` 退回 `awaiting-restore`），
   * 那会让"恢复已发请求"这一类事实被当成没发生过。
   */
  if (group.phase === 'needs-attention') {
    const allowed: ShippingGroupPhase[] = ['awaiting-restore', 'restoring', 'done', 'missed'];
    if (!allowed.includes(next)) return null;
    return { ...group, ...patch, phase: next, revision: group.revision + 1, updatedAt: now };
  }
  if (next !== 'needs-attention' && PHASE_ORDER[next] < PHASE_ORDER[group.phase]) return null;
  return { ...group, ...patch, phase: next, revision: group.revision + 1, updatedAt: now };
}

// ===== 恢复对象 =====

/**
 * 计算恢复阶段的**唯一对象集合**（31.6 规则 5）。
 *
 * 只恢复"本轮已确认／可能被改成 1 天"的商品：排除集合里的商品、首阶段没能处理的商品、
 * 开始之后新上架的商品都不能被扩大纳入。
 *
 * **以 `confirmedSpotItemIds` 为唯一依据**（第 37.2 节 R3 收敛）。
 * 早先还会再按 `items` 里的 `spot` 状态过滤一遍，结果是**静默丢掉义务**：
 * 设备在商品请求进行中退出时，组是从**检查点**接回来的（"请求已发出、结果还没回来"），
 * 这些商品在 `items` 里的结论仍是 `pending`，于是被当成"不用恢复"而剔除，
 * 恢复对象变成空集，组直接报"没有需要恢复的商品"并结束 —— 商品却还停在 1 天没人管（验收实测）。
 *
 * `confirmedSpotItemIds` 本身已经是由 `confirmedSpotIdsAfterCut` 严格筛过的
 * （只有 success／unknown，以及原本就是 1 天的 skipped），可信且更完整；
 * 逐项该不该改由恢复阶段的**写前回读核实**决定，而不是在这里凭一个可能过期的
 * `pending` 结论把义务删掉。唯一可以在这里排除的，是**已经确认恢复成功**的项。
 */
export function restoreItemIds(group: ShippingGroup): string[] {
  const byId = new Map(group.items.map(item => [item.itemId, item]));
  return group.confirmedSpotItemIds.filter(id => byId.get(id)?.restore !== 'success');
}

/**
 * 按 ID 合并逐商品结果（同一商品只保留一条，两阶段字段分别更新）。
 *
 * **只更新本阶段字段**（第 34.6 节 R5）：早先的实现用整体展开覆盖，
 * 于是恢复阶段传来的 `spot: 'pending'` 会把首阶段已确认的 `spot: 'success'` 抹掉，
 * 导致 `restoreItemIds` 变空、恢复义务被判定为不存在 —— 义务就这么丢了。
 */
export function mergeGroupItems(
  existing: ShippingGroupItemOutcome[],
  incoming: ShippingGroupItemOutcome[],
): ShippingGroupItemOutcome[] {
  const map = new Map<string, ShippingGroupItemOutcome>();
  for (const item of existing) map.set(item.itemId, item);
  for (const item of incoming) {
    const prior = map.get(item.itemId);
    if (!prior) {
      map.set(item.itemId, item);
      continue;
    }
    // `pending` 表示"这一阶段还没结论"，不构成对已有结论的更新
    const merged: ShippingGroupItemOutcome = {
      ...prior,
      name: item.name || prior.name,
      spot: item.spot !== 'pending' ? item.spot : prior.spot,
      restore: item.restore !== 'pending' ? item.restore : prior.restore,
    };
    if (item.alreadyAtTarget) merged.alreadyAtTarget = true;
    if (item.reason) merged.reason = item.reason;
    map.set(item.itemId, merged);
  }
  return [...map.values()];
}

/**
 * 由任务逐项结果构造组内结果（只填对应阶段的字段）。
 *
 * `verifiedAlreadyTarget` 说明"回读确认已是目标天数、本次未发写"，据此记 `skipped`，
 * 让组判定能区分"确实已是目标"与"因为不可编辑等原因根本没动过"（第 34.6 节 R5）。
 */
export function itemOutcomesFromTask(
  phase: 'spot' | 'restore',
  items: Array<{
    itemId: string;
    name: string;
    status: ShippingItemStatus;
    reason?: string;
    verifiedAlreadyTarget?: boolean;
  }>,
): ShippingGroupItemOutcome[] {
  return items.map(item => ({
    itemId: item.itemId,
    name: item.name,
    spot: phase === 'spot' ? item.status : 'pending',
    restore: phase === 'restore' ? item.status : 'pending',
    // 回读确认已是目标 → 记为"跳过但已核实"，与"因不可编辑跳过"区分开
    alreadyAtTarget: item.verifiedAlreadyTarget === true ? true : undefined,
    reason: item.reason,
  }));
}

/**
 * 第一阶段结束后：哪些项应被记为"已确认达到 1 天"。
 *
 * `success` 与 `unknown` 都算（unknown 需在恢复前重新核实，但**义务先保留**，
 * 不能因为结果不明就把恢复义务丢掉）。已原本就是 1 天的项也纳入，
 * 但用 `alreadyAtTarget` 标出来，不冒充本次写成功。
 */
export function confirmedSpotIdsAfterCut(
  items: ShippingGroupItemOutcome[],
  originallyAtOneDay: string[] = [],
): string[] {
  const atOneDay = new Set(originallyAtOneDay);
  const out = new Set<string>();
  for (const item of items) {
    if (item.spot === 'success' || item.spot === 'unknown') out.add(item.itemId);
    else if (item.spot === 'skipped' && atOneDay.has(item.itemId)) out.add(item.itemId);
  }
  return [...out];
}

/**
 * 需要人工处理的项：恢复结果不明或失败的。非空时整组为 `needs-attention`。
 */
/** 组结束后仍待人工处理的项：结果不明或失败的恢复项，以及"跳过但其实没恢复"的项。 */
export function pendingIdsAfterRestore(items: ShippingGroupItemOutcome[]): string[] {
  return items
    .filter(
      item =>
        item.restore === 'unknown' ||
        item.restore === 'failed' ||
        // skipped 且没有"回读确认已是目标"证据 → 没有真的恢复，仍需处理
        (item.restore === 'skipped' && item.alreadyAtTarget !== true),
    )
    .map(item => item.itemId);
}

/**
 * 两阶段是否都已有明确落盘结论（用于判定"整组完成"）。
 *
 * `skipped` **只有**在明确"回读确认为目标天数"时才可当恢复完成（第 34.6 节 R5）：
 * 因商品不可编辑／被特卖排除等原因跳过，意思是"这一项根本没动过"，
 * 拿来充当恢复成功会让"未恢复的商品被完成掩盖"。
 */
export function groupIsComplete(items: ShippingGroupItemOutcome[]): boolean {
  return items.every(
    item =>
      item.restore === 'success' ||
      (item.restore === 'skipped' && item.alreadyAtTarget === true),
  );
}

// ===== 界面摘要 =====

/** 现货时段时长文案（跨天时也按小时数给出，避免用户误读成同一天）。 */
export function describeSpotDuration(schedule: ShippingGroupSchedule): string {
  const minutes = Math.max(0, Math.round((schedule.restoreAt - schedule.startAt) / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const mins = minutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (mins > 0) parts.push(`${mins} 分钟`);
  return parts.length ? parts.join(' ') : '0 分钟';
}

/**
 * 恢复时刻相对开始日期的**台湾日历**天数差（0 = 同日，1 = 次日，n = n 天后）。
 *
 * 为什么不能直接按毫秒除以一天：台北时间的 23:00 与次日 01:30 在 UTC 上可能是**同一天**
 * （台北 23:00 = 15:00Z，次日台北 01:30 = 17:30Z），按 UTC 取整会算成"同日"，
 * 界面上就少了应有的"次日"标识。因此必须按台北日历日期比较。
 */
export function describeDayOffset(schedule: ShippingGroupSchedule): number {
  const startDay = taipeiDateString(schedule.startAt);
  const restoreDay = taipeiDateString(schedule.restoreAt);
  const toIndex = (d: string) => {
    const [y, m, day] = d.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, day) / 86_400_000);
  };
  return Math.max(0, toIndex(restoreDay) - toIndex(startDay));
}

/** 台湾时刻 `MM-DD HH:mm`（用于状态区文案；不依赖操作系统时区）。 */
export function formatTaipeiShort(epochMs: number): string {
  const shifted = new Date(epochMs + 8 * 3600_000);
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

/**
 * 下一动作文案：顶部状态区直接显示，避免用户只能从阶段名猜"接下来会发生什么"。
 *
 * 时刻一律按**台湾时区**格式化：用户看的是台湾站的备货承诺，
 * 用本机时区显示会让"次日 01:30"这类跨天文案对不上。
 */
export function describeNextAction(group: ShippingGroup): string {
  const { schedule, phase } = group;
  const fmt = (ms: number) => formatTaipeiShort(ms);
  if (phase === 'scheduled') return `将在 ${fmt(schedule.startAt)} 切换为现货 1 天`;
  if (phase === 'cutting') return '正在切换为现货 1 天';
  if (phase === 'awaiting-restore') return `将在 ${fmt(schedule.restoreAt)} 恢复为 ${schedule.regularDays} 天`;
  if (phase === 'restoring') return `正在恢复为 ${schedule.regularDays} 天`;
  if (phase === 'done') return '这一组已完成，不会自动安排下一次';
  if (phase === 'missed') return '已错过开始时间，本次未修改任何商品';
  if (phase === 'needs-attention') return group.error || '结果不明，需要你确认后再处理';
  return '—';
}

/**
 * 校验从"旧循环配置"迁移过来的内容。
 *
 * 第 31 节 31.5：旧 shipping 重复计划要**保留原记录**、暂停未来重复并提示重新确认单次日期，
 * 不能强停已有写入、也不能丢掉旧物流收尾。因此这里只回答"是否需要提示用户重新确认"，
 * 不改写旧记录、不代为迁移出新的组。
 */
export function needsSingleRunReconfirmation(loopDaily: unknown): boolean {
  return loopDaily === true;
}

// ===== 撤销与互斥（U10/U12）=====

/**
 * 撤销整组（纯函数，返回新记录）。
 *
 * 规则（31.5）：
 * - 未开始且**从未发过**商品写 → 可整组撤销，零商品写；
 * - 一旦出现过已发或可能已发（`unknown`）的商品写，**不删除恢复义务**，
 *   只阻止后续切 1 天请求，界面明确仍需恢复。
 */
export function revokeGroup(
  group: ShippingGroup,
  now: number,
): { record: ShippingGroup; revoked: boolean; reason?: string } {
  const hasPossibleWrite =
    group.items.some(i => i.spot === 'success' || i.spot === 'unknown') ||
    group.claimedStages.includes('spot');
  if (hasPossibleWrite) {
    return {
      record: group,
      revoked: false,
      reason: '本组已经发出过商品写请求，不能直接撤销；仍需按计划恢复常规备货天数',
    };
  }
  return {
    record: {
      ...group,
      phase: 'done',
      revision: group.revision + 1,
      message: '已撤销本次安排，没有修改任何商品',
      finishedAt: now,
      updatedAt: now,
    },
    revoked: true,
  };
}

/**
 * 判断能否开始一组新安排（互斥）。
 *
 * 已有运行／待恢复／结果未知时不允许新安排绕过：否则会出现两组同时持有恢复义务，
 * 或新的切 1 天与旧的恢复互相覆盖（31.5）。
 */
export function canStartNewGroup(record: ShippingGroupsRecord): { ok: boolean; reason?: string } {
  const active = record.active;
  if (!active) return { ok: true };
  if (active.phase === 'done' || active.phase === 'missed') return { ok: true };
  if (active.phase === 'needs-attention') {
    return { ok: false, reason: '上一组安排需要你确认结果后再处理' };
  }
  if (groupHoldsRestoreObligation(active)) {
    return { ok: false, reason: '上一组安排的恢复义务尚未完成，请等它恢复完成后再安排新的' };
  }
  return { ok: false, reason: '已有一组安排在进行中，请先等它结束或撤销' };
}

/** 供界面显示组摘要（不参与判定，只影响文案）。 */
export function summarizeGroup(group: ShippingGroup): string {
  const days = isValidRegularDays(group.schedule.regularDays)
    ? `${group.schedule.regularDays} 天`
    : '（未设置）';
  const excluded = parseExcludeIds(group.config.excludeIds).length;
  return `切 1 天 → 恢复 ${days}；排除 ${excluded} 个商品；物流${
    group.config.toggleLogistics ? '自动管理' : '不处理'
  }`;
}

/** 开始窗口文案（界面折叠区与提示卡共用，避免两处描述不一致）。 */
export function describeWindowPolicy(): string {
  return `开始时间起 ${SHIPPING_START_WINDOW_MINUTES} 分钟内未开始则本次跳过，不会补切现货。`;
}
