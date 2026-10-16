/**
 * shipping 定时计划的**纯决策**：什么时候该跑、能不能跑、跑过没有。
 *
 * 为什么不把这段写进 background 的 alarm 回调：
 * "台湾时区算下一次""重复 alarm 不得启动第二份""错过不补历史""冲突时等待"这几条
 * 都是验收矩阵 S6／S7 直接检查的规则，必须能用可控时钟单测，
 * 不能埋在需要真浏览器才能触发的回调里。
 * 真正的启动动作由 `features/shipping/background.ts` 接线调用同一个 runner。
 */

import {
  buildOccurrenceId,
  resolvePlanDue,
  sortDuePlans,
  taipeiDateString,
  taipeiLocalToEpoch,
  taipeiTimeString,
  nextTaipeiDate,
  type PlanDueInfo,
} from './rules';
import { channelsAwaitingRestore, isShippingTaskActive } from './task';
import type { ShippingPlan, ShippingTask } from './types';

/** 当前占用情况：决定本轮能不能真正开始写。 */
export interface ShippingOccupancy {
  /** 本功能自己的任务是否还在推进 */
  shippingTaskActive: boolean;
  /** 同店铺已有特卖／复制／修复的实际写操作 */
  otherWriteConflict: string | null;
  /** 待恢复物流（未确认终态） */
  pendingLogisticsRestore: boolean;
  /** 身份／凭据是否可用 */
  identityOk: boolean;
  /**
   * 计划保存时的店铺锚（由调用方从计划记录里取出）。
   * `null` 表示这个计划还没绑定归属 —— 不能执行（绑定归属是 R3 的要求）。
   */
  planOwnerShopId?: number | null;
  /** 计划保存时的后端账号锚 */
  planOwnerUserId?: number | null;
  /** 当前实际核实到的店铺／账号，用于与计划锚比对 */
  currentShopId?: number | null;
  currentUserId?: number | null;
}

export type ShippingPlanDecision =
  | {
      kind: 'run';
      planId: string;
      occurrenceId: string;
      taipeiDate: string;
      dueAt: number;
      days: number;
      /** 计划保存时核实的归属锚；执行必须用它，不能用触发时的身份 */
      ownerShopId: number | null;
      ownerUserId: number | null;
    }
  | { kind: 'wait'; planId: string; occurrenceId: string; reason: string }
  | { kind: 'mark-missed'; planId: string }
  | { kind: 'skip'; planId: string; reason: string };

/**
 * 决定在 `nowMs` 这一刻各计划分别该做什么。
 *
 * 关键语义（都来自验收矩阵 S6／S7）：
 * - 只处理**当前台湾日期**应执行而未执行的轮次；错过过去日期不补写历史；
 * - 一次性计划错过标 `mark-missed`（界面显示"已错过"），每日计划直接算下一轮；
 * - 已有同功能任务在跑 → `wait`（不强停、不用旧快照开始新一批）；
 * - 同店已有其他写操作 → `wait` 并给出可读原因；
 * - 有待恢复物流／身份失效 → `wait`，不盲目开始下一轮。
 */
export function decidePlanActions(
  plans: ShippingPlan[],
  nowMs: number,
  occupancyFor: (plan: ShippingPlan) => ShippingOccupancy,
  selfTask: ShippingTask | null | undefined,
): ShippingPlanDecision[] {
  const due: PlanDueInfo[] = [];
  const decisions: ShippingPlanDecision[] = [];

  for (const plan of plans) {
    const resolved = resolvePlanDue(plan, nowMs);
    if (resolved === null) continue;
    if (resolved === 'missed') {
      decisions.push({ kind: 'mark-missed', planId: plan.id });
      continue;
    }
    due.push(resolved);
  }

  for (const item of sortDuePlans(due)) {
    // 每个计划的归属锚不同，占用情况要按计划分别评估（R3）
    const occupancy = occupancyFor(item.plan);
    // 计划归属必须先绑定，否则无法保证"执行的是原店铺原账号的对象"（R3）
    if (item.plan.ownerShopId === null || item.plan.ownerUserId === null) {
      decisions.push({
        kind: 'wait',
        planId: item.plan.id,
        occurrenceId: item.occurrenceId,
        reason: '该计划还没有绑定店铺与账号归属，请重新保存计划',
      });
      continue;
    }
    // 每轮至多一份：已有本功能任务在跑（含本次刚启动的），后续计划一律等待
    if (occupancy.shippingTaskActive) {
      decisions.push({
        kind: 'wait',
        planId: item.plan.id,
        occurrenceId: item.occurrenceId,
        reason: '已有备货修改任务在执行，等待它结束',
      });
      continue;
    }
    if (occupancy.pendingLogisticsRestore) {
      decisions.push({
        kind: 'wait',
        planId: item.plan.id,
        occurrenceId: item.occurrenceId,
        reason: '上一批的原店铺物流尚未确认恢复，请先处理',
      });
      continue;
    }
    if (!occupancy.identityOk) {
      decisions.push({
        kind: 'wait',
        planId: item.plan.id,
        occurrenceId: item.occurrenceId,
        reason: '当前店铺身份／登录状态不可用，无法开始',
      });
      continue;
    }
    // 触发时的实际身份必须与计划锚一致：不一致就等待，绝不用新身份认领旧计划（R3）
    if (occupancy.currentShopId !== undefined && occupancy.currentShopId !== item.plan.ownerShopId) {
      decisions.push({
        kind: 'wait',
        planId: item.plan.id,
        occurrenceId: item.occurrenceId,
        reason: `当前店铺（${occupancy.currentShopId ?? '未知'}）不是计划绑定的店铺（${item.plan.ownerShopId}），已等待`,
      });
      continue;
    }
    if (occupancy.currentUserId !== undefined && occupancy.currentUserId !== item.plan.ownerUserId) {
      decisions.push({
        kind: 'wait',
        planId: item.plan.id,
        occurrenceId: item.occurrenceId,
        reason: `当前账号不是计划绑定的账号，已等待`,
      });
      continue;
    }
    if (occupancy.otherWriteConflict) {
      decisions.push({
        kind: 'wait',
        planId: item.plan.id,
        occurrenceId: item.occurrenceId,
        reason: occupancy.otherWriteConflict,
      });
      continue;
    }
    // 中断／结果未知的历史任务：不自动继续写
    if (selfTask && selfTask.status === 'interrupted') {
      decisions.push({
        kind: 'wait',
        planId: item.plan.id,
        occurrenceId: item.occurrenceId,
        reason: '上次任务被中断，结果未确认，请先查看结果',
      });
      continue;
    }
    decisions.push({
      kind: 'run',
      planId: item.plan.id,
      occurrenceId: item.occurrenceId,
      taipeiDate: item.taipeiDate,
      dueAt: item.dueAt,
      days: item.plan.days,
      ownerShopId: item.plan.ownerShopId,
      ownerUserId: item.plan.ownerUserId,
    });
  }

  return decisions;
}

/**
 * 记录**计划已被占用**（本轮已启动）。
 *
 * 刻意只写 `lastRunId`（用于"每轮至多一次"）与归属，**不写 `lastResult`**：
 * 「启动请求成功」不等于「商品修改成功」。真实终态由 runner 结束后
 * 用同一 `occurrenceId` 写入 `applyPlanTerminalResult`（R5）。
 * 旧实现把"启动成功"直接当 `running` 甚至成功，导致任务早已结束、计划仍显示运行中。
 */
export function claimPlanOccurrence(
  plan: ShippingPlan,
  input: { occurrenceId: string; now: number; taskId: string | null },
): ShippingPlan {
  return {
    ...plan,
    lastRunId: input.occurrenceId,
    lastRunAt: input.now,
    lastTaskId: input.taskId,
    lastError: null,
    missed: false,
    updatedAt: input.now,
  };
}

/**
 * 写入**真实终态**（由 runner 结束回调调用）。
 *
 * 两条约束：
 * - 只有 `occurrenceId` 与当前 `lastRunId` 相符才写入，避免旧结果覆盖新轮次；
 * - 日期推进与执行成败分开：`lastResult` 记真实状态，日期按规则推进，
 *   绝不把"日期 +1"当成"执行成功"（源的错误行为）。
 */
export function applyPlanTerminalResult(
  plan: ShippingPlan,
  input: {
    occurrenceId: string;
    taipeiDate: string;
    now: number;
    result: ShippingTask['status'];
    taskId?: string | null;
    error?: string | null;
  },
): ShippingPlan {
  // 晚到的旧轮次结果不得覆盖新轮次
  if (plan.lastRunId !== input.occurrenceId) return plan;
  const next: ShippingPlan = {
    ...plan,
    lastResult: input.result,
    lastRunAt: input.now,
    lastTaskId: input.taskId ?? plan.lastTaskId,
    lastError: input.error ?? null,
    missed: false,
    updatedAt: input.now,
  };
  if (plan.loopDaily) {
    // 每日：沿所设时间生成下一次（今天已执行 → 下一天）
    const today = taipeiDateString(input.now);
    if (input.taipeiDate === today || nextTaipeiDate(input.taipeiDate) <= today) {
      next.date = nextTaipeiDate(today);
    } else {
      next.date = nextTaipeiDate(input.taipeiDate);
    }
  } else {
    // 一次性：本轮已执行，关闭以避免再次触发
    next.enabled = false;
  }
  return next;
}

/**
 * 预检未通过 / 被忙态拒绝时记录"本轮未真正开始"。
 *
 * 与终态区分：这不是商品修改结果，界面应显示"等待"而不是成功或失败。
 */
export function applyPlanSkipped(
  plan: ShippingPlan,
  input: { occurrenceId: string; now: number; reason: string },
): ShippingPlan {
  if (plan.lastRunId !== input.occurrenceId) return plan;
  return {
    ...plan,
    lastResult: 'waiting',
    lastRunAt: input.now,
    lastError: input.reason,
    updatedAt: input.now,
  };
}

/** 计划界面要展示的「下一次执行时间」，一律按台湾时区解释。 */
export function describeNextRun(plan: ShippingPlan, nowMs: number): { text: string; epoch: number | null } {
  if (!plan.enabled) return { text: '未启用', epoch: null };
  const date = plan.loopDaily ? taipeiDateString(nowMs) : plan.date;
  const epoch = taipeiLocalToEpoch(date, plan.time);
  if (epoch === null) return { text: '时间无效', epoch: null };
  if (epoch <= nowMs) {
    if (plan.loopDaily) {
      const tomorrow = nextTaipeiDate(taipeiDateString(nowMs));
      const nextEpoch = taipeiLocalToEpoch(tomorrow, plan.time);
      return {
        text: nextEpoch === null ? '时间无效' : `${tomorrow} ${plan.time}`,
        epoch: nextEpoch,
      };
    }
    return { text: plan.lastRunId ? '已执行' : '已错过', epoch: null };
  }
  return { text: `${date} ${plan.time}`, epoch };
}

/** 计划是否处于"需要用户处理"的状态：有待恢复物流、身份失效、上轮未确认终态。 */
export function planNeedsAttention(plan: ShippingPlan, occupancy: ShippingOccupancy): string | null {
  if (occupancy.pendingLogisticsRestore) return '原店铺物流待恢复';
  if (!occupancy.identityOk) return '登录状态需重新确认';
  if (plan.ownerShopId === null || plan.ownerUserId === null) return '计划未绑定店铺与账号归属，请重新保存';
  if (plan.lastResult === 'interrupted') return '上轮被中断，结果未确认';
  if (plan.lastResult === 'waiting') return plan.lastError || '上轮因冲突未能开始';
  return null;
}

/** 计划展示用的真实终态文案（不把"日期推进"说成成功）。 */
export const SHIPPING_PLAN_RESULT_LABEL: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  failed: '未完成',
  stopped: '已停止',
  interrupted: '已中断',
  waiting: '等待中（未真正开始）',
};

/** 计划摘要（供界面顶部展示，避免逐条读原始字段）。 */
export function summarizePlans(
  plans: ShippingPlan[],
  nowMs: number,
  occupancy: ShippingOccupancy,
): Array<{ id: string; next: string; lastRun: string; enabled: boolean; attention: string | null }> {
  return plans.map(plan => {
    const next = describeNextRun(plan, nowMs);
    const lastRun = plan.lastRunAt
      ? `${taipeiDateString(plan.lastRunAt)} ${taipeiTimeString(plan.lastRunAt)} · ${plan.lastResult ?? '—'}`
      : '尚未执行';
    return {
      id: plan.id,
      next: next.text,
      lastRun,
      enabled: plan.enabled,
      attention: planNeedsAttention(plan, occupancy),
    };
  });
}

export { buildOccurrenceId, isShippingTaskActive, channelsAwaitingRestore };
