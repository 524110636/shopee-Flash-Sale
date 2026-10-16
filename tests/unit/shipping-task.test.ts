/**
 * shipping 任务契约与调度决策的隔离单测。
 *
 * 覆盖验收矩阵里靠浏览器难以稳定触发的分支：
 * 保存失败即停写（S4）、归属失效停写（S8）、按商品终态计数（S3）、
 * 中断不重放（S4）、物流快照与恢复义务（S5）、计划至多一份与等待（S6/S7）。
 */
import { describe, it, expect } from 'vitest';
import {
  channelsAwaitingRestore,
  channelsToRestore,
  countShippingItems,
  createShippingTask,
  deriveTaskStatus,
  isOverallSuccess,
  isShippingTaskActive,
  isTerminalShippingStatus,
  itemsWithSentWrites,
  mergeItemResults,
  patchShippingTask,
  resolveOrphanedShippingTask,
  buildShippingSummary,
  type CreateShippingTaskInput,
} from '@/features/shipping/task';
import { channelHasPendingRestore, mergeItemResults as mergeDeps } from '@/features/shipping/runner-deps';
import { needsLogisticsAction } from '@/features/shipping/runner';
import {
  applyPlanSkipped,
  applyPlanTerminalResult,
  claimPlanOccurrence,
  decidePlanActions,
  describeNextRun,
  planNeedsAttention,
  summarizePlans,
  type ShippingOccupancy,
} from '@/features/shipping/scheduler';
import {
  SHIPPING_DEFAULT_PLANS,
  type ShippingChannelRecord,
  type ShippingItemResult,
  type ShippingPlan,
  type ShippingTask,
} from '@/features/shipping/types';
import { buildOccurrenceId, resolvePlanDue, taipeiLocalToEpoch } from '@/features/shipping/rules';

function makeTask(overrides: Partial<CreateShippingTaskInput> = {}): ShippingTask {
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
    total: 3,
    toggleLogistics: false,
    now: 1_700_000_000_000,
    ...overrides,
  });
}

function item(itemId: string, status: ShippingItemResult['status']): ShippingItemResult {
  return { itemId, name: `商品 ${itemId}`, days: 1, status };
}

/** 计划归属已绑定（R3 起，未绑定的计划不会被执行） */
const BOUND_PLAN_OWNER = { ownerShopId: 777, ownerUserId: 1 };

const freeOccupancy: ShippingOccupancy = {
  shippingTaskActive: false,
  otherWriteConflict: null,
  pendingLogisticsRestore: false,
  identityOk: true,
  ...BOUND_PLAN_OWNER,
  currentShopId: 777,
  currentUserId: 1,
};

describe('任务记录与补丁', () => {
  it('创建时是运行中且未请求停止', () => {
    const task = makeTask();
    expect(task.status).toBe('running');
    expect(task.stopRequested).toBe(false);
    expect(isShippingTaskActive(task)).toBe(true);
    expect(isTerminalShippingStatus('running')).toBe(false);
  });

  it('终态不能被补丁拉回运行中', () => {
    const done = patchShippingTask(makeTask(), { status: 'completed', now: 1 });
    const back = patchShippingTask(done, { status: 'running', phase: 'writing', now: 2 });
    expect(back.status).toBe('completed');
    expect(back.phase).toBe('completed');
  });

  it('检查点只追加不替换（中断后据此说明哪些写请求已发出）', () => {
    let task = makeTask();
    task = patchShippingTask(task, {
      checkpoint: { step: 'update-product-batch', writeSent: true, target: '101', at: 1 },
      now: 1,
    });
    task = patchShippingTask(task, {
      checkpoint: { step: 'update-product-batch', writeSent: true, target: '102', at: 2 },
      now: 2,
    });
    expect(task.checkpoints).toHaveLength(2);
    expect(itemsWithSentWrites(task)).toEqual(['101', '102']);
  });

  it('进入终态时记录完成时间，不被后续补丁改写', () => {
    let task = patchShippingTask(makeTask(), { status: 'completed', now: 100 });
    expect(task.finishedAt).toBe(100);
    task = patchShippingTask(task, { message: '后到的心跳', now: 200 });
    expect(task.finishedAt).toBe(100);
  });
});

describe('逐商品结果归类', () => {
  it('同一商品只保留一条最终状态，不累加重试次数', () => {
    const merged = mergeItemResults(
      [item('1', 'failed'), item('2', 'success')],
      [item('1', 'success'), item('3', 'skipped')],
    );
    expect(merged).toHaveLength(3);
    expect(merged.find(i => i.itemId === '1')?.status).toBe('success');
    expect(countShippingItems(merged)).toEqual({ success: 2, failed: 0, skipped: 1, unknown: 0, pending: 0 });
  });

  it('跳过不算成功（1000100252 场景）', () => {
    const counts = countShippingItems([item('1', 'success'), item('2', 'skipped')]);
    expect(counts.success).toBe(1);
    expect(counts.skipped).toBe(1);
  });

  it('unknown 既不报成功也不报失败', () => {
    const counts = countShippingItems([item('1', 'unknown')]);
    expect(counts.unknown).toBe(1);
    expect(counts.success).toBe(0);
    expect(counts.failed).toBe(0);
    expect(deriveTaskStatus(counts, { stopRequested: false })).toBe('completed');
    // 但整体成功判定必须为否
    expect(isOverallSuccess(patchShippingTask(makeTask(), { items: [item('1', 'unknown')], now: 1 }))).toBe(false);
  });

  it('用户停止优先判定为 stopped', () => {
    const counts = countShippingItems([item('1', 'pending')]);
    expect(deriveTaskStatus(counts, { stopRequested: true })).toBe('stopped');
  });
});

describe('物流记录与恢复义务', () => {
  const records: ShippingChannelRecord[] = [
    { channelId: 1, originallyEnabled: true, closed: 'success', restored: 'pending' },
    { channelId: 2, originallyEnabled: false, closed: 'skipped', restored: 'skipped' },
    { channelId: 3, originallyEnabled: true, closed: 'success', restored: 'success' },
  ];

  it('只恢复原先启用且确实关闭过的渠道', () => {
    expect(channelsToRestore(records).map(r => r.channelId)).toEqual([1, 3]);
  });

  it('原先关闭的渠道不会被列入恢复，也不会被打开', () => {
    expect(channelsToRestore(records).some(r => r.channelId === 2)).toBe(false);
  });

  it('未确认恢复的渠道列入待处理清单', () => {
    expect(channelsAwaitingRestore(records).map(r => r.channelId)).toEqual([1]);
    expect(channelHasPendingRestore(records)).toBe(true);
  });

  it('待恢复物流时不能宣布整体成功', () => {
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      items: [item('1', 'success')],
      logistics: { records, closeAttempted: true, closeCompleted: true, restoreAttempted: true, restoreCompleted: false },
      now: 1,
    });
    expect(isOverallSuccess(task)).toBe(false);
  });

  it('关闭结果未知的渠道同样算恢复义务，不宣布整体成功（R4）', () => {
    const unknownClose: ShippingChannelRecord[] = [
      { channelId: 5, originallyEnabled: true, closed: 'unknown', restored: 'pending' },
    ];
    // 统一判断（runner 的 needsLogisticsAction / task 的 channelsAwaitingRestore /
    // runner-deps 的 channelHasPendingRestore 必须一致）
    expect(needsLogisticsAction(unknownClose[0])).toBe(true);
    expect(channelsAwaitingRestore(unknownClose).map(r => r.channelId)).toEqual([5]);
    expect(channelHasPendingRestore(unknownClose)).toBe(true);
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      items: [item('1', 'success')],
      logistics: {
        records: unknownClose,
        closeAttempted: true,
        closeCompleted: false,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    expect(isOverallSuccess(task)).toBe(false);
  });

  it('关闭结果未知但已确认恢复的渠道不再是义务', () => {
    const resolved: ShippingChannelRecord[] = [
      { channelId: 5, originallyEnabled: true, closed: 'unknown', restored: 'success' },
    ];
    expect(needsLogisticsAction(resolved[0])).toBe(false);
    expect(channelHasPendingRestore(resolved)).toBe(false);
    expect(channelsAwaitingRestore(resolved)).toEqual([]);
  });

  it('原本关闭的渠道不产生恢复义务，也不会被打开', () => {
    const closedByUser: ShippingChannelRecord[] = [
      { channelId: 7, originallyEnabled: false, closed: 'skipped', restored: 'skipped' },
    ];
    expect(needsLogisticsAction(closedByUser[0])).toBe(false);
    expect(channelsToRestore(closedByUser)).toEqual([]);
    expect(channelHasPendingRestore(closedByUser)).toBe(false);
  });

  it('全部恢复后才算整体成功', () => {
    const allRestored = records.map(r => (r.originallyEnabled ? { ...r, restored: 'success' as const } : r));
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      items: [item('1', 'success')],
      logistics: {
        records: allRestored,
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: true,
      },
      now: 1,
    });
    expect(isOverallSuccess(task)).toBe(true);
  });
});

describe('中断协调', () => {
  it('没有执行者时标记中断并保留已有结果', () => {
    const running = patchShippingTask(makeTask(), { items: [item('1', 'success')], now: 1 });
    const resolved = resolveOrphanedShippingTask(running, false, null);
    expect(resolved?.status).toBe('interrupted');
    expect(resolved?.items).toHaveLength(1);
    expect(resolved?.items[0].status).toBe('success');
  });

  it('本实例是执行者时不误判中断', () => {
    expect(resolveOrphanedShippingTask(makeTask(), true, null)).toBeNull();
  });

  it('已是终态时不再改动', () => {
    const done = patchShippingTask(makeTask(), { status: 'completed', now: 1 });
    expect(resolveOrphanedShippingTask(done, false, null)).toBeNull();
  });
});

describe('首页摘要', () => {
  it('没有任务时不出摘要', () => {
    expect(buildShippingSummary(null)).toBeNull();
  });

  it('运行中显示进度，不谎称完成', () => {
    const task = patchShippingTask(makeTask(), { items: [item('1', 'success')], now: 1 });
    const summary = buildShippingSummary(task);
    expect(summary?.tone).toBe('running');
    expect(summary?.title).toContain('进行中');
  });

  it('中断显示待查看而不是完成', () => {
    const task = patchShippingTask(makeTask(), { status: 'interrupted', now: 1 });
    expect(buildShippingSummary(task)?.tone).toBe('interrupted');
  });

  it('有待恢复物流时摘要直接指向物流', () => {
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      status: 'completed',
      items: [item('1', 'success')],
      logistics: {
        records: [{ channelId: 9, originallyEnabled: true, closed: 'success', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: true,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    expect(buildShippingSummary(task)?.title).toContain('物流待恢复');
  });

  it('关闭结果未知时摘要也指向物流（不显示完成）', () => {
    const task = patchShippingTask(makeTask({ toggleLogistics: true }), {
      status: 'failed',
      items: [item('1', 'success')],
      logistics: {
        records: [{ channelId: 9, originallyEnabled: true, closed: 'unknown', restored: 'pending' }],
        closeAttempted: true,
        closeCompleted: false,
        restoreAttempted: true,
        restoreCompleted: false,
      },
      now: 1,
    });
    const summary = buildShippingSummary(task);
    expect(summary?.title).toContain('物流待恢复');
    expect(summary?.tone).toBe('interrupted');
  });
});

describe('计划调度决策', () => {
  function plan(overrides: Partial<ShippingPlan> = {}): ShippingPlan {
    return {
      ...SHIPPING_DEFAULT_PLANS[0],
      enabled: true,
      date: '2026-10-14',
      time: '09:00',
      ...BOUND_PLAN_OWNER,
      ...overrides,
    };
  }

  /** 所有计划共用同一份占用（手动计划场景） */
  const occ = (overrides: Partial<ShippingOccupancy> = {}) => () => ({ ...freeOccupancy, ...overrides });

  it('无冲突时到点就运行，并带上计划的归属锚', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const decisions = decidePlanActions([plan()], now, occ(), null);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].kind).toBe('run');
    // 执行必须使用计划保存时的锚，不是触发时的身份
    expect((decisions[0] as any).ownerShopId).toBe(777);
    expect((decisions[0] as any).ownerUserId).toBe(1);
  });

  it('未绑定归属的计划不执行，提示重新保存（R3）', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const decisions = decidePlanActions([plan({ ownerShopId: null, ownerUserId: null })], now, occ(), null);
    expect(decisions[0].kind).toBe('wait');
    expect((decisions[0] as any).reason).toContain('没有绑定');
  });

  it('触发时店铺与计划锚不同：等待，不用新身份认领旧计划（R3）', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const decisions = decidePlanActions([plan()], now, occ({ currentShopId: 999 }), null);
    expect(decisions[0].kind).toBe('wait');
    expect((decisions[0] as any).reason).toContain('不是计划绑定的店铺');
  });

  it('触发时账号与计划锚不同：等待（R3）', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const decisions = decidePlanActions([plan()], now, occ({ currentUserId: 2 }), null);
    expect(decisions[0].kind).toBe('wait');
    expect((decisions[0] as any).reason).toContain('账号');
  });

  it('已有本功能任务在跑时等待，不强停也不重复启动', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const decisions = decidePlanActions([plan()], now, occ({ shippingTaskActive: true }), null);
    expect(decisions[0].kind).toBe('wait');
    expect((decisions[0] as any).reason).toContain('已有备货修改任务');
  });

  it('同店已有特卖／复制／修复写操作时等待并给出原因', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const decisions = decidePlanActions(
      [plan()],
      now,
      occ({ otherWriteConflict: '自动模式正在执行写操作' }),
      null,
    );
    expect(decisions[0].kind).toBe('wait');
    expect((decisions[0] as any).reason).toBe('自动模式正在执行写操作');
  });

  it('待恢复物流或身份失效时等待，不盲目开始下一轮', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    expect(decidePlanActions([plan()], now, occ({ pendingLogisticsRestore: true }), null)[0].kind).toBe('wait');
    expect(decidePlanActions([plan()], now, occ({ identityOk: false }), null)[0].kind).toBe('wait');
  });

  it('上轮被中断时等待用户处理，不自动继续写', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const interrupted = patchShippingTask(makeTask(), { status: 'interrupted', now: 1 });
    const decisions = decidePlanActions([plan()], now, occ(), interrupted);
    expect(decisions[0].kind).toBe('wait');
    expect((decisions[0] as any).reason).toContain('中断');
  });

  it('两计划同日重叠时都进入决策，排序稳定（先时刻后槽位）', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '12:00')!;
    const decisions = decidePlanActions(
      [plan({ id: 'plan2', time: '10:00' }), plan({ id: 'plan1', time: '09:00' })],
      now,
      occ(),
      null,
    );
    expect(decisions.map(d => d.planId)).toEqual(['plan1', 'plan2']);
  });

  it('一次性计划错过过去日期时标 missed，不补写历史', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '12:00')!;
    const decisions = decidePlanActions([plan({ date: '2026-10-13' })], now, occ(), null);
    expect(decisions[0].kind).toBe('mark-missed');
  });

  it('未启用的计划不参与决策', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '12:00')!;
    expect(decidePlanActions([plan({ enabled: false })], now, occ(), null)).toEqual([]);
  });
});

describe('计划结果与下一次时间', () => {
  function plan(overrides: Partial<ShippingPlan> = {}): ShippingPlan {
    return {
      ...SHIPPING_DEFAULT_PLANS[0],
      enabled: true,
      date: '2026-10-14',
      time: '09:00',
      ...BOUND_PLAN_OWNER,
      ...overrides,
    };
  }

  it('写入轮次标识后同一轮不再触发', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const occurrenceId = buildOccurrenceId('plan1', '2026-10-14', '09:00');
    const claimed = claimPlanOccurrence(plan(), { occurrenceId, now, taskId: 'task-1' });
    expect(claimed.lastRunId).toBe(occurrenceId);
    expect(claimed.lastTaskId).toBe('task-1');
    // **占用不等于结果**：只声明本轮的 lastRunId 与任务 id，不写 lastResult（R5）
    expect(claimed.lastResult).toBeNull();
    // 占用后同一轮不再被判为到期，重复 alarm 不会启动第二份
    expect(resolvePlanDue(claimed, now)).toBeNull();
  });

  it('终态由 runner 结束后回写；未结束前不显示已完成', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const occurrenceId = buildOccurrenceId('plan1', '2026-10-14', '09:00');
    const claimed = claimPlanOccurrence(plan(), { occurrenceId, now, taskId: 'task-1' });
    expect(claimed.lastResult).toBeNull();
    const done = applyPlanTerminalResult(claimed, {
      occurrenceId,
      taipeiDate: '2026-10-14',
      now: now + 1000,
      result: 'completed',
      taskId: 'task-1',
    });
    expect(done.lastResult).toBe('completed');
    // 一次性计划执行后自动关闭，避免再次触发
    expect(done.enabled).toBe(false);
  });

  it('旧轮次的迟到结果不覆盖新轮次', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const old = buildOccurrenceId('plan1', '2026-10-14', '09:00');
    const fresh = buildOccurrenceId('plan1', '2026-10-14', '10:00');
    const claimed = claimPlanOccurrence(plan({ loopDaily: true, date: '' }), {
      occurrenceId: fresh,
      now,
      taskId: 'task-2',
    });
    const late = applyPlanTerminalResult(claimed, {
      occurrenceId: old,
      taipeiDate: '2026-10-14',
      now,
      result: 'failed',
      error: '旧轮次失败',
    });
    // 旧轮次的结果不得写进新轮次
    expect(late.lastResult).toBeNull();
    expect(late.lastError).toBeNull();
    expect(late.lastRunId).toBe(fresh);
  });

  it('每日计划推进到下一次，但执行结果单独记录（不把推进当成功）', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const occurrenceId = buildOccurrenceId('plan1', '2026-10-14', '09:00');
    const claimed = claimPlanOccurrence(plan({ loopDaily: true, date: '' }), {
      occurrenceId,
      now,
      taskId: 'task-3',
    });
    const next = applyPlanTerminalResult(claimed, {
      occurrenceId,
      taipeiDate: '2026-10-14',
      now,
      result: 'failed',
      error: '预检没有可修改的商品',
    });
    expect(next.date).toBe('2026-10-15');
    expect(next.lastResult).toBe('failed');
    expect(next.lastError).toBe('预检没有可修改的商品');
    expect(next.enabled).toBe(true);
  });

  it('预检失败（未真正开始）记录为 waiting 而不是成功或失败', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:05')!;
    const occurrenceId = buildOccurrenceId('plan1', '2026-10-14', '09:00');
    const claimed = claimPlanOccurrence(plan({ loopDaily: true, date: '' }), {
      occurrenceId,
      now,
      taskId: null,
    });
    const skipped = applyPlanSkipped(claimed, { occurrenceId, now, reason: '预检失败' });
    expect(skipped.lastResult).toBe('waiting');
    expect(skipped.lastError).toBe('预检失败');
    // 日期不推进（本轮没有真正执行）
    expect(skipped.date).toBe(claimed.date);
  });

  it('下一次执行时间按台湾时区显示；未启用显示未启用；错过显示已错过', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '08:00')!;
    expect(describeNextRun(plan(), now).text).toBe('2026-10-14 09:00');
    expect(describeNextRun(plan({ enabled: false }), now).text).toBe('未启用');
    const later = taipeiLocalToEpoch('2026-10-14', '10:00')!;
    expect(describeNextRun(plan(), later).text).toBe('已错过');
  });

  it('每日计划到期后显示下一天', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '10:00')!;
    expect(describeNextRun(plan({ loopDaily: true, date: '' }), now).text).toBe('2026-10-15 09:00');
  });

  it('需要处理的状态：待恢复物流 / 身份 / 上轮中断 / 未绑定归属', () => {
    expect(planNeedsAttention(plan(), { ...freeOccupancy, pendingLogisticsRestore: true })).toContain('物流');
    expect(planNeedsAttention(plan(), { ...freeOccupancy, identityOk: false })).toContain('登录');
    expect(planNeedsAttention(plan({ lastResult: 'interrupted' }), freeOccupancy)).toContain('中断');
    // 未绑定归属的计划必须提示需处理（R3）
    expect(planNeedsAttention(plan({ ownerShopId: null }), freeOccupancy)).toContain('归属');
    expect(planNeedsAttention(plan(), freeOccupancy)).toBeNull();
  });

  it('摘要带下一次、上次与需处理提示', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '08:00')!;
    const summaries = summarizePlans([plan()], now, freeOccupancy);
    expect(summaries[0].next).toBe('2026-10-14 09:00');
    expect(summaries[0].lastRun).toBe('尚未执行');
    expect(summaries[0].enabled).toBe(true);
  });
});

describe('结果合并工具一致性', () => {
  it('task 与 runner-deps 两份合并实现行为一致（避免两处漂移）', () => {
    const existing = [item('1', 'failed')];
    const incoming = [item('1', 'success'), item('2', 'unknown')];
    expect(mergeItemResults(existing, incoming)).toEqual(mergeDeps(existing, incoming));
  });
});
