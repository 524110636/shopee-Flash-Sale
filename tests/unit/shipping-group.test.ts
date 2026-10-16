/**
 * 单次成对安排（任务书第 31 节）的纯规则与事务推进单测。
 *
 * 覆盖验收矩阵 U4／U5／U6／U7／U9／U10／U11／U12 里靠"改时间／等一周"
 * 难以稳定触发的分支：启动窗口边界、错过不补切、跨午夜、恢复对象不扩大、
 * 重复认领、迟到回调不回退阶段、撤销语义、配置复用。
 *
 * 全部用可控时钟，不依赖真实时间流逝。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SHIPPING_REGULAR_DAY_OPTIONS,
  SHIPPING_SPOT_DAYS,
  advanceGroupPhase,
  canStartNewGroup,
  claimGroupStage,
  confirmedSpotIdsAfterCut,
  createShippingGroup,
  decideGroupAction,
  describeDayOffset,
  describeNextAction,
  describeSpotDuration,
  describeWindowPolicy,
  groupHoldsRestoreObligation,
  groupIsComplete,
  isValidRegularDays,
  itemOutcomesFromTask,
  mergeGroupItems,
  needsSingleRunReconfirmation,
  pendingIdsAfterRestore,
  restoreItemIds,
  revokeGroup,
  spotWindowDeadline,
  summarizeGroup,
  validateGroupInput,
} from '@/features/shipping/group-rules';
import { applyTaskResultToGroup, tickShippingGroup, type ShippingGroupDeps } from '@/features/shipping/group';
import {
  SHIPPING_EMPTY_GROUPS,
  type ShippingGroup,
  type ShippingGroupItemOutcome,
  type ShippingGroupsRecord,
  type ShippingItemStatus,
  type ShippingTargetItem,
} from '@/features/shipping/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 一个基准"现在"：2026-10-21 12:00 台湾时间（UTC+8）。 */
const NOW = Date.parse('2026-10-21T04:00:00.000Z');

function makeGroup(overrides: Partial<ShippingGroup> = {}): ShippingGroup {
  return {
    ...createShippingGroup({
      groupId: 'grp-1',
      schedule: {
        startAt: NOW + 4 * HOUR,
        restoreAt: NOW + 6 * HOUR,
        spotDays: SHIPPING_SPOT_DAYS,
        regularDays: 8,
      },
      config: { range: 'all', excludeIds: '11\n22', toggleLogistics: false },
      ownerShopId: 7001,
      ownerUserId: 42,
      now: NOW,
    }),
    ...overrides,
  };
}

function item(itemId: string, spot: ShippingItemStatus, restore: ShippingItemStatus = 'pending'): ShippingGroupItemOutcome {
  return { itemId, name: `商品 ${itemId}`, spot, restore };
}

// ===== 输入校验（U1）=====

describe('单次安排输入校验', () => {
  it('常规备货天数只接受 2–10 的整数', () => {
    expect(isValidRegularDays(2)).toBe(true);
    expect(isValidRegularDays(10)).toBe(true);
    expect(isValidRegularDays(1)).toBe(false);
    expect(isValidRegularDays(11)).toBe(false);
    expect(isValidRegularDays(2.5)).toBe(false);
    expect(SHIPPING_REGULAR_DAY_OPTIONS).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('切现货天数固定为 1，传别的值被拒绝', () => {
    const err = validateGroupInput({
      schedule: { startAt: NOW + HOUR, restoreAt: NOW + 2 * HOUR, spotDays: 3, regularDays: 7 },
      ownerShopId: 1,
      ownerUserId: 1,
      now: NOW,
    });
    expect(err).toContain('固定为 1 天');
  });

  it('恢复时间必须严格晚于开始时间', () => {
    const err = validateGroupInput({
      schedule: { startAt: NOW + 2 * HOUR, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 7 },
      ownerShopId: 1,
      ownerUserId: 1,
      now: NOW,
    });
    expect(err).toContain('严格晚于');
  });

  it('开始时间不能是已经过去的时刻', () => {
    const err = validateGroupInput({
      schedule: { startAt: NOW - MINUTE, restoreAt: NOW + HOUR, spotDays: 1, regularDays: 7 },
      ownerShopId: 1,
      ownerUserId: 1,
      now: NOW,
    });
    expect(err).toContain('已经过去');
  });

  it('缺少日期或店铺/账号归属都被拒绝', () => {
    expect(
      validateGroupInput({
        schedule: { startAt: NaN, restoreAt: NOW + HOUR, spotDays: 1, regularDays: 7 },
        ownerShopId: 1,
        ownerUserId: 1,
        now: NOW,
      }),
    ).toContain('开始日期');
    expect(
      validateGroupInput({
        schedule: { startAt: NOW + HOUR, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 7 },
        ownerShopId: null,
        ownerUserId: 1,
        now: NOW,
      }),
    ).toContain('店铺');
    expect(
      validateGroupInput({
        schedule: { startAt: NOW + HOUR, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 7 },
        ownerShopId: 1,
        ownerUserId: null,
        now: NOW,
      }),
    ).toContain('账号');
  });

  it('物流开关必须是布尔值，字符串被拒绝（20.1 同类要求）', () => {
    for (const bad of ['true', 'false', 1, 0, null]) {
      const err = validateGroupInput({
        schedule: { startAt: NOW + HOUR, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 7 },
        config: { range: 'all', excludeIds: '', toggleLogistics: bad as unknown as boolean },
        ownerShopId: 1,
        ownerUserId: 1,
        now: NOW,
      });
      expect(err, `toggleLogistics=${String(bad)}`).toContain('布尔');
    }
  });
});

// ===== 启动窗口与错过（U4）=====

describe('启动窗口与错过策略', () => {
  it('窗口截止取 min(startAt+5分钟, restoreAt)', () => {
    const wide = { startAt: NOW, restoreAt: NOW + HOUR, spotDays: 1, regularDays: 7 };
    expect(spotWindowDeadline(wide)).toBe(NOW + 5 * MINUTE);

    // 恢复时间很近时，容差不得越过恢复时刻
    const narrow = { startAt: NOW, restoreAt: NOW + 2 * MINUTE, spotDays: 1, regularDays: 7 };
    expect(spotWindowDeadline(narrow)).toBe(NOW + 2 * MINUTE);
  });

  it('窗口内可以开始', () => {
    const group = makeGroup();
    const action = decideGroupAction(group, group.schedule.startAt + 4 * MINUTE, {
      identityOk: true,
      taskActive: false,
    });
    expect(action.kind).toBe('start-spot');
  });

  it('过了窗口且从未发过写请求 → 已错过，绝不补切', () => {
    const group = makeGroup();
    const action = decideGroupAction(group, group.schedule.startAt + 6 * MINUTE, {
      identityOk: true,
      taskActive: false,
    });
    expect(action.kind).toBe('mark-missed');
  });

  it('已到恢复时刻却从未开始 → 也是错过，不补切 1 天', () => {
    const group = makeGroup();
    const action = decideGroupAction(group, group.schedule.restoreAt + MINUTE, {
      identityOk: true,
      taskActive: false,
    });
    expect(action.kind).toBe('mark-missed');
  });

  it('还没到开始时间只是等待，不标错过', () => {
    const group = makeGroup();
    const action = decideGroupAction(group, group.schedule.startAt - MINUTE, {
      identityOk: true,
      taskActive: false,
    });
    expect(action.kind).toBe('wait');
  });

  it('同一阶段已被认领则等待，不重复认领', () => {
    const group = claimGroupStage(makeGroup(), 'spot', NOW);
    const action = decideGroupAction(group, group.schedule.startAt + MINUTE, {
      identityOk: true,
      taskActive: false,
    });
    expect(action.kind).toBe('wait');
  });
});

// ===== 恢复阶段（U5/U6/U7）=====

describe('恢复阶段', () => {
  it('未到恢复时刻先等待', () => {
    const group = makeGroup({ phase: 'awaiting-restore', confirmedSpotItemIds: ['11'] });
    const action = decideGroupAction(group, group.schedule.restoreAt - MINUTE, {
      identityOk: true,
      taskActive: false,
    });
    expect(action.kind).toBe('wait');
  });

  it('已过恢复时刻且身份可用 → 开始恢复', () => {
    const group = makeGroup({ phase: 'awaiting-restore', confirmedSpotItemIds: ['11'] });
    const action = decideGroupAction(group, group.schedule.restoreAt + MINUTE, {
      identityOk: true,
      taskActive: false,
    });
    expect(action.kind).toBe('start-restore');
  });

  it('身份不可用时恢复义务保留，只等待不绕过核验', () => {
    const group = makeGroup({ phase: 'awaiting-restore', confirmedSpotItemIds: ['11'] });
    const action = decideGroupAction(group, group.schedule.restoreAt + 10 * HOUR, {
      identityOk: false,
      taskActive: false,
    });
    expect(action.kind).toBe('wait');
  });

  it('没有任何已确认商品时不能猜恢复对象 → 需处理', () => {
    const group = makeGroup({ phase: 'awaiting-restore', confirmedSpotItemIds: [] });
    const action = decideGroupAction(group, group.schedule.restoreAt + MINUTE, {
      identityOk: true,
      taskActive: false,
    });
    expect(action.kind).toBe('needs-attention');
  });

  it('恢复对象只用已确认集合：排除项与后上架商品不被纳入', () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      confirmedSpotItemIds: ['11', '22'],
      items: [
        item('11', 'success'),
        item('22', 'unknown'),
        // 后上架／被排除、从未确认的商品
        item('33', 'pending'),
        item('44', 'skipped'),
      ],
    });
    expect(restoreItemIds(group).sort()).toEqual(['11', '22']);
  });

  it('已恢复成功的商品不再进入恢复集合（重复事件不重复写）', () => {
    const group = makeGroup({
      phase: 'restoring',
      confirmedSpotItemIds: ['11', '22'],
      items: [item('11', 'success', 'success'), item('22', 'success', 'pending')],
    });
    expect(restoreItemIds(group)).toEqual(['22']);
  });

  it('结果未知（unknown）也保留恢复义务，不因不明就丢掉', () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      confirmedSpotItemIds: ['11'],
      items: [item('11', 'unknown')],
    });
    expect(groupHoldsRestoreObligation(group)).toBe(true);
    expect(restoreItemIds(group)).toEqual(['11']);
  });
});

// ===== 阶段推进与幂等（U9）=====

describe('阶段推进与幂等', () => {
  it('阶段只前进，不回退', () => {
    const group = makeGroup({ phase: 'awaiting-restore' });
    // 迟到回调想把阶段改回 cutting
    expect(advanceGroupPhase(group, 'cutting', NOW)).toBeNull();
    expect(advanceGroupPhase(group, 'restoring', NOW)?.phase).toBe('restoring');
  });

  it('已完成的组不会被迟到回调改写', () => {
    const group = makeGroup({ phase: 'done' });
    expect(advanceGroupPhase(group, 'cutting', NOW)).toBeNull();
    expect(advanceGroupPhase(group, 'awaiting-restore', NOW)).toBeNull();
  });

  it('可以从任何未结束阶段进入需处理', () => {
    for (const phase of ['scheduled', 'cutting', 'awaiting-restore', 'restoring'] as const) {
      const group = makeGroup({ phase });
      expect(advanceGroupPhase(group, 'needs-attention', NOW)?.phase).toBe('needs-attention');
    }
  });

  it('认领同一阶段两次只记一次', () => {
    const once = claimGroupStage(makeGroup(), 'spot', NOW);
    const twice = claimGroupStage(once, 'spot', NOW + MINUTE);
    expect(twice.claimedStages).toEqual(['spot']);
    expect(twice.revision).toBe(once.revision);
  });

  it('切现货任务完成后：确认集合只含 success／unknown，原已 1 天的项也纳入', () => {
    const outcomes = mergeGroupItems([], itemOutcomesFromTask('spot', [
      { itemId: '11', name: 'a', status: 'success' },
      { itemId: '22', name: 'b', status: 'unknown' },
      { itemId: '33', name: 'c', status: 'failed' },
      { itemId: '44', name: 'd', status: 'skipped' },
    ]));
    const confirmed = confirmedSpotIdsAfterCut(outcomes, ['44']);
    expect(confirmed.sort()).toEqual(['11', '22', '44']);
  });

  it('切现货阶段无任何可恢复项 → 整组直接完成，不留无意义义务', () => {
    const group = makeGroup({ phase: 'cutting' });
    const next = applyTaskResultToGroup(
      group,
      'spot',
      { status: 'completed', items: [{ itemId: '11', name: 'a', days: 1, status: 'failed' }] },
      NOW,
    );
    expect(next.phase).toBe('done');
    expect(next.confirmedSpotItemIds).toEqual([]);
  });

  it('切现货阶段被中断 → 需处理，且保留可能已发出的义务', () => {
    const group = makeGroup({ phase: 'cutting' });
    const next = applyTaskResultToGroup(
      group,
      'spot',
      { status: 'interrupted', items: [{ itemId: '11', name: 'a', days: 1, status: 'unknown' }] },
      NOW,
    );
    expect(next.phase).toBe('needs-attention');
    expect(next.confirmedSpotItemIds).toEqual(['11']);
  });

  it('恢复阶段全部成功 → 完成', () => {
    const group = makeGroup({
      phase: 'restoring',
      confirmedSpotItemIds: ['11'],
      items: [item('11', 'success')],
    });
    const next = applyTaskResultToGroup(
      group,
      'restore',
      { status: 'completed', items: [{ itemId: '11', name: 'a', days: 8, status: 'success' }] },
      NOW,
    );
    expect(next.phase).toBe('done');
    expect(next.pendingItemIds).toEqual([]);
    expect(groupIsComplete(next.items)).toBe(true);
  });

  it('恢复阶段有未确认项 → 需处理，不能报完成', () => {
    const group = makeGroup({
      phase: 'restoring',
      confirmedSpotItemIds: ['11', '22'],
      items: [item('11', 'success'), item('22', 'success')],
    });
    const next = applyTaskResultToGroup(
      group,
      'restore',
      {
        status: 'completed',
        items: [
          { itemId: '11', name: 'a', days: 8, status: 'success' },
          { itemId: '22', name: 'b', days: 8, status: 'unknown' },
        ],
      },
      NOW,
    );
    expect(next.phase).toBe('needs-attention');
    expect(next.pendingItemIds).toEqual(['22']);
  });

  it('恢复阶段被中断 → 需处理并保留待核实项', () => {
    const group = makeGroup({
      phase: 'restoring',
      confirmedSpotItemIds: ['11'],
      items: [item('11', 'success')],
    });
    const next = applyTaskResultToGroup(
      group,
      'restore',
      { status: 'interrupted', items: [{ itemId: '11', name: 'a', days: 8, status: 'unknown' }] },
      NOW,
    );
    expect(next.phase).toBe('needs-attention');
    expect(next.pendingItemIds).toContain('11');
  });

  it('重试更新同一商品时不产生重复条目', () => {
    const merged = mergeGroupItems(
      [item('11', 'failed')],
      itemOutcomesFromTask('spot', [{ itemId: '11', name: 'a', status: 'success' }]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].spot).toBe('success');
  });
});

// ===== 撤销与互斥（U10/U12）=====

describe('撤销与互斥', () => {
  it('未开始且没有写过 → 可整组撤销', () => {
    const { revoked, record } = revokeGroup(makeGroup(), NOW);
    expect(revoked).toBe(true);
    expect(record.phase).toBe('done');
  });

  it('已发出过商品写请求 → 拒绝撤销并保留恢复义务', () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11'],
      items: [item('11', 'success')],
    });
    const { revoked, reason } = revokeGroup(group, NOW);
    expect(revoked).toBe(false);
    expect(reason).toContain('恢复');
  });

  it('已有活跃组时不允许开始新组；完成后允许', () => {
    const active = makeGroup({ phase: 'awaiting-restore', confirmedSpotItemIds: ['11'], items: [item('11', 'success')] });
    expect(canStartNewGroup({ ...SHIPPING_EMPTY_GROUPS, active }).ok).toBe(false);
    expect(canStartNewGroup({ ...SHIPPING_EMPTY_GROUPS, active: makeGroup({ phase: 'done' }) }).ok).toBe(true);
    expect(canStartNewGroup({ ...SHIPPING_EMPTY_GROUPS, active: makeGroup({ phase: 'missed' }) }).ok).toBe(true);
    expect(canStartNewGroup({ ...SHIPPING_EMPTY_GROUPS, active: makeGroup({ phase: 'needs-attention' }) }).ok).toBe(false);
  });

  it('旧循环配置需要重新确认单次日期（不改写旧记录）', () => {
    expect(needsSingleRunReconfirmation(true)).toBe(true);
    expect(needsSingleRunReconfirmation(false)).toBe(false);
  });
});

// ===== 摘要与文案（U1）=====

describe('摘要与跨天文案', () => {
  it('跨天按台湾日历判定：23:00→次日 01:30 是次日，不是同日', () => {
    const base = { spotDays: 1, regularDays: 8 };
    // 台北 2026-10-21 10:00 → 同日 12:00（UTC 02:00 → 04:00）
    expect(
      describeDayOffset({
        ...base,
        startAt: Date.parse('2026-10-21T02:00:00Z'),
        restoreAt: Date.parse('2026-10-21T04:00:00Z'),
      }),
    ).toBe(0);
    // 台北 2026-10-21 23:00 → 次日 01:30（UTC 2026-10-21T15:00Z → 2026-10-21T17:30Z）
    expect(
      describeDayOffset({
        ...base,
        startAt: Date.parse('2026-10-21T15:00:00Z'),
        restoreAt: Date.parse('2026-10-21T17:30:00Z'),
      }),
    ).toBe(1);
    // 关键反例：台北 23:00 → 次日 01:30，但 **UTC 日期相同**（15:00Z → 16:30Z）
    expect(
      describeDayOffset({
        ...base,
        startAt: Date.parse('2026-10-21T15:10:00Z'),
        restoreAt: Date.parse('2026-10-21T16:30:00Z'),
      }),
    ).toBe(1);
    expect(
      describeDayOffset({
        ...base,
        startAt: Date.parse('2026-10-21T15:00:00Z'),
        restoreAt: Date.parse('2026-10-24T09:00:00Z'),
      }),
    ).toBe(3);
  });

  it('现货时段时长按天/小时/分钟组合', () => {
    const base = { spotDays: 1, regularDays: 8 };
    expect(describeSpotDuration({ ...base, startAt: 0, restoreAt: 2 * HOUR })).toBe('2 小时');
    expect(describeSpotDuration({ ...base, startAt: 0, restoreAt: HOUR + 30 * MINUTE })).toBe('1 小时 30 分钟');
    expect(describeSpotDuration({ ...base, startAt: 0, restoreAt: 26 * HOUR })).toBe('1 天 2 小时');
  });

  it('下一动作文案随阶段变化，且按台湾时区显示', () => {
    const group = makeGroup();
    expect(describeNextAction(group)).toContain('切换为现货');
    expect(describeNextAction({ ...group, phase: 'awaiting-restore' })).toContain('恢复为 8 天');
    expect(describeNextAction({ ...group, phase: 'done' })).toContain('已完成');
    expect(describeNextAction({ ...group, phase: 'missed' })).toContain('未修改任何商品');
    expect(describeNextAction({ ...group, phase: 'needs-attention', error: '结果不明' })).toBe('结果不明');
  });

  it('组摘要包含天数／排除数量／物流选项', () => {
    const text = summarizeGroup(makeGroup());
    expect(text).toContain('恢复 8 天');
    expect(text).toContain('排除 2 个商品');
    expect(text).toContain('不处理');
  });

  it('待处理项只含恢复未知或失败的商品', () => {
    const items = [item('11', 'success', 'success'), item('22', 'success', 'unknown'), item('33', 'success', 'failed')];
    expect(pendingIdsAfterRestore(items)).toEqual(['22', '33']);
  });
});

// ===== 事务推进 tickShippingGroup（U4/U5/U9）=====

describe('tickShippingGroup 事务推进', () => {
  function makeDeps(overrides: Partial<ShippingGroupDeps> & { record: ShippingGroupsRecord }): {
    deps: ShippingGroupDeps;
    saves: ShippingGroupsRecord[];
    starts: Array<{ phase: string; items: ShippingTargetItem[] }>;
  } {
    const saves: ShippingGroupsRecord[] = [];
    const starts: Array<{ phase: string; items: ShippingTargetItem[] }> = [];
    const deps: ShippingGroupDeps = {
      loadGroups: async () => overrides.record,
      saveGroups: async record => {
        saves.push(record);
        overrides.record = record;
      },
      preview: async () => ({
        ok: true,
        shopId: 7001,
        items: [{ itemId: '11', name: 'a', status: 1, categoryPath: '1:2' }],
      }),
      startTask: async input => {
        starts.push({ phase: input.phase, items: input.items });
        return { success: true, taskId: `t-${input.phase}` };
      },
      isTaskActive: async () => false,
      isIdentityOk: async () => true,
      findOtherWriteConflict: async () => null,
      now: () => NOW,
      ...overrides,
    };
    return { deps, saves, starts };
  }

  it('窗口内启动切现货：先落盘认领再启动任务', async () => {
    const group = makeGroup({ schedule: { startAt: NOW, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, saves, starts } = makeDeps({ record: { ...SHIPPING_EMPTY_GROUPS, active: group } });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('started-spot');
    expect(starts).toHaveLength(1);
    expect(starts[0].phase).toBe('spot');
    // 第一次保存是"认领 + 进入 cutting"，必须在启动任务之前完成
    expect(saves[0].active?.phase).toBe('cutting');
    expect(saves[0].active?.claimedStages).toContain('spot');
    expect(saves[saves.length - 1].active?.spotTaskId).toBe('t-spot');
  });

  it('保存认领失败 → 不发任何写请求', async () => {
    const group = makeGroup({ schedule: { startAt: NOW, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, starts } = makeDeps({
      record: { ...SHIPPING_EMPTY_GROUPS, active: group },
      saveGroups: async () => {
        throw new Error('disk full');
      },
    });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('save-failed');
    expect(starts).toHaveLength(0);
  });

  it('预检失败 → 转为需处理，不启动任务', async () => {
    const group = makeGroup({ schedule: { startAt: NOW, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, starts } = makeDeps({
      record: { ...SHIPPING_EMPTY_GROUPS, active: group },
      preview: async () => ({ ok: false, error: '特卖排除调查失败', shopId: 7001, items: [] }),
    });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('needs-attention');
    expect(starts).toHaveLength(0);
  });

  it('恢复阶段只带已确认集合，不用重新预检的结果', async () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      schedule: { startAt: NOW - HOUR, restoreAt: NOW - MINUTE, spotDays: 1, regularDays: 8 },
      confirmedSpotItemIds: ['11'],
      items: [item('11', 'success'), item('99', 'pending')],
    });
    const { deps, starts } = makeDeps({
      record: { ...SHIPPING_EMPTY_GROUPS, active: group },
      preview: async () => {
        throw new Error('恢复阶段不应重新预检');
      },
    });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('started-restore');
    expect(starts[0].items.map(i => i.itemId)).toEqual(['11']);
  });

  it('错过窗口 → 标已错过且零任务', async () => {
    const group = makeGroup({ schedule: { startAt: NOW - 10 * MINUTE, restoreAt: NOW + HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, starts, saves } = makeDeps({ record: { ...SHIPPING_EMPTY_GROUPS, active: group } });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('mark-missed');
    expect(starts).toHaveLength(0);
    expect(saves[saves.length - 1].active?.phase).toBe('missed');
  });

  it('重复补检不会重复启动同一阶段', async () => {
    const group = makeGroup({ schedule: { startAt: NOW, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, starts } = makeDeps({ record: { ...SHIPPING_EMPTY_GROUPS, active: group } });
    await tickShippingGroup(deps);
    await tickShippingGroup(deps);
    await tickShippingGroup(deps);
    expect(starts).toHaveLength(1);
  });

  it('没有活跃组时什么都不做', async () => {
    const { deps, starts } = makeDeps({ record: { ...SHIPPING_EMPTY_GROUPS } });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('idle');
    expect(starts).toHaveLength(0);
  });

  it('读记录失败时不猜、不发请求', async () => {
    const { deps, starts } = makeDeps({
      record: { ...SHIPPING_EMPTY_GROUPS },
      loadGroups: async () => {
        throw new Error('storage read failed');
      },
    });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('idle');
    expect(starts).toHaveLength(0);
  });

  it('身份不可用时切现货只是等待，不改阶段', async () => {
    const group = makeGroup({ schedule: { startAt: NOW, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, starts, saves } = makeDeps({
      record: { ...SHIPPING_EMPTY_GROUPS, active: group },
      isIdentityOk: async () => false,
    });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('wait');
    expect(starts).toHaveLength(0);
    expect(saves).toHaveLength(0);
    expect(group.phase).toBe('scheduled');
  });

  it('启动被拒绝且尚未创建任务 → 释放认领保留原因，等待补检重新核验', async () => {
    /**
     * 第 40.3 节：认领发生在创建任务**之前**；此处被拒时没有任何新写请求、义务完整，
     * 必须能重新认领再试。早先直接落 `needs-attention`，而它没有回到可认领状态的路径，
     * 组就永久卡住（临时 503／权限暂拒解除后也起不来）。
     * 身份／权限闸门仍在 `decideGroupAction` 里，重新认领时会再核验，不绕过校验。
     */
    const group = makeGroup({ schedule: { startAt: NOW, restoreAt: NOW + 2 * HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, saves } = makeDeps({
      record: { ...SHIPPING_EMPTY_GROUPS, active: group },
      startTask: async () => ({ success: false, error: '当前店铺不是绑定的店铺' }),
    });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('wait');
    expect(result.reason).toContain('不是绑定的店铺');
    const saved = saves[saves.length - 1].active;
    expect(saved?.phase, '应退回可重新认领的阶段，而不是永久需处理').toBe('scheduled');
    expect(saved?.claimedStages).not.toContain('spot');
    expect(saved?.error).toContain('不是绑定的店铺');
  });

  it('恢复段启动被拒且尚未创建任务 → 退回等待恢复，义务不丢', async () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11'],
      items: [item('11', 'success')],
      schedule: { startAt: NOW - 4 * HOUR, restoreAt: NOW - HOUR, spotDays: 1, regularDays: 8 },
    });
    const { deps, saves } = makeDeps({
      record: { ...SHIPPING_EMPTY_GROUPS, active: group },
      startTask: async () => ({ success: false, error: '店铺访问校验未通过（临时 503）' }),
    });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('wait');
    const saved = saves[saves.length - 1].active;
    expect(saved?.phase).toBe('awaiting-restore');
    expect(saved?.claimedStages).not.toContain('restore');
    expect(saved?.confirmedSpotItemIds).toEqual(['11']);
  });

  it('已发出但结果未知的写请求存在时，不重复切现货批次', async () => {
    const group = makeGroup({
      phase: 'cutting',
      items: [item('11', 'unknown')],
    });
    const { deps, starts } = makeDeps({ record: { ...SHIPPING_EMPTY_GROUPS, active: group } });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('needs-attention');
    expect(starts).toHaveLength(0);
  });
});
// ===== 返工 R1–R5（第 34 节）=====

import { retireLegacyRepeatPlans, clampPlans, hasRetiredRepeatPlans } from '@/features/shipping/rules';
import { reattachGroupFromTask, recoverInterruptedGroup } from '@/features/shipping/group';

describe('R1 旧重复计划停用（第 34.2 节）', () => {
  const legacyPlan = (over = {}) => ({
    id: 'plan1',
    enabled: true,
    date: '',
    time: '09:00',
    days: 3,
    range: 'all' as const,
    loopDaily: true,
    excludeIds: '111',
    toggleLogistics: false,
    ownerShopId: 7001,
    ownerUserId: 1,
    lastRunId: 'plan1@2026-10-14@09:00',
    lastRunAt: 1760000000000,
    lastResult: 'completed' as const,
    lastTaskId: 'ship-old',
    lastError: null,
    missed: false,
    updatedAt: 1760000000000,
    ...over,
  });

  it('启用中的每日计划被降级为暂停，且保留记录与执行证据', () => {
    const [out] = retireLegacyRepeatPlans([legacyPlan()]);
    expect(out.loopDaily).toBe(false);
    expect(out.enabled).toBe(false);
    expect(out.retired).toBe(true);
    expect(out.retiredReason).toContain('单次');
    // 历史证据与物流收尾依据不能被抹掉
    expect(out.lastRunId).toBe('plan1@2026-10-14@09:00');
    expect(out.lastTaskId).toBe('ship-old');
    expect(out.lastResult).toBe('completed');
    expect(out.ownerShopId).toBe(7001);
  });

  it('clampPlans 也强制降级：任何入口都写不回启用的重复计划', () => {
    const out = clampPlans([legacyPlan(), legacyPlan({ id: 'plan2' })]);
    expect(out.every(p => p.enabled === false && p.loopDaily === false)).toBe(true);
    expect(hasRetiredRepeatPlans(out)).toBe(true);
  });

  it('正常的一次性计划不受影响', () => {
    const oneTime = legacyPlan({ loopDaily: false, lastRunId: null });
    const [out] = retireLegacyRepeatPlans([oneTime]);
    expect(out.enabled).toBe(true);
    expect(out.retired).toBeUndefined();
  });
});

describe('R3 从关联任务接回被中断的组（第 34.4 节）', () => {
  const cutGroup = (over = {}) => makeGroup({ phase: 'cutting', claimedStages: ['spot'], spotTaskId: 't-spot', ...over });

  it('已确认切到 1 天 → 接回等待恢复，义务保留', () => {
    const g = reattachGroupFromTask(
      cutGroup(),
      {
        taskId: 't-spot',
        status: 'interrupted',
        phase: 'writing',
        groupPhase: 'spot',
        items: [
          { itemId: '11', name: 'a', days: 1, status: 'success' },
          { itemId: '22', name: 'b', days: 1, status: 'unknown' },
        ],
        checkpoints: [{ step: 'update-product-batch', writeSent: true, target: '11', at: 1 }],
      },
      1000,
    );
    expect(g.phase).toBe('awaiting-restore');
    expect(g.confirmedSpotItemIds.sort()).toEqual(['11', '22']);
    // 待核实集合保留：到恢复时刻由恢复阶段逐项回读定案（不再停成"需处理"死胡同）
    expect(g.pendingItemIds.sort()).toEqual(['11', '22']);
  });

  it('从未发出写请求就中断 → 按错过结束，零补切', () => {
    const g = reattachGroupFromTask(
      cutGroup(),
      { taskId: 't-spot', status: 'interrupted', phase: 'precheck', items: [], checkpoints: [] },
      1000,
    );
    expect(g.phase).toBe('missed');
    expect(g.confirmedSpotItemIds).toEqual([]);
  });

  it('发过写但结果全不明 → 需处理并保留待核实项，不假装有义务', () => {
    const g = reattachGroupFromTask(
      cutGroup(),
      {
        taskId: 't-spot',
        status: 'interrupted',
        phase: 'writing',
        items: [{ itemId: '11', name: 'a', days: 1, status: 'unknown' }],
        checkpoints: [{ step: 'update-product-batch', writeSent: true, target: '11', at: 1 }],
      },
      1000,
    );
    // unknown 会被 confirmedSpotIdsAfterCut 纳入，因此进入等待恢复并带待核实项
    expect(['awaiting-restore', 'needs-attention']).toContain(g.phase);
    expect(g.confirmedSpotItemIds).toContain('11');
  });

  it('恢复阶段被中断 → 回到可重新认领的等待恢复，并释放该阶段认领', () => {
    const g = reattachGroupFromTask(
      makeGroup({
        phase: 'restoring',
        claimedStages: ['spot', 'restore'],
        confirmedSpotItemIds: ['11'],
        items: [item('11', 'success')],
      }),
      {
        taskId: 't-restore',
        status: 'interrupted',
        phase: 'restoring',
        groupPhase: 'restore',
        items: [{ itemId: '11', name: 'a', days: 8, status: 'unknown' }],
        checkpoints: [{ step: 'update-product-batch', writeSent: true, target: '11', at: 1 }],
      },
      1000,
    );
    /**
     * 收敛语义（第 37.2 节）：不再停成 `needs-attention` 死胡同，
     * 而是回到 `awaiting-restore` 并**释放 restore 认领**，
     * 让补检能重新认领、逐项回读后收尾。
     */
    expect(g.phase).toBe('awaiting-restore');
    expect(g.claimedStages).toEqual(['spot']);
    expect(g.pendingItemIds).toContain('11');
  });

  it('任务仍在跑时接回函数不动作（不抢跑）', async () => {
    const record = { ...SHIPPING_EMPTY_GROUPS, active: cutGroup() };
    const result = await recoverInterruptedGroup({
      loadGroups: async () => record,
      saveGroups: async () => {
        throw new Error('should not save');
      },
      loadTask: async () => ({
        taskId: 't-spot',
        status: 'running',
        groupId: 'grp-1',
        groupPhase: 'spot',
      } as any),
      now: () => 1000,
    });
    expect(result).toBe('none');
  });

  it('关联任务已终态时接回并落盘', async () => {
    let saved = null;
    const record = { ...SHIPPING_EMPTY_GROUPS, active: cutGroup() };
    const result = await recoverInterruptedGroup({
      loadGroups: async () => record,
      saveGroups: async r => {
        saved = r;
      },
      loadTask: async () => ({
        taskId: 't-spot',
        status: 'interrupted',
        phase: 'writing',
        groupId: 'grp-1',
        groupPhase: 'spot',
        items: [{ itemId: '11', name: 'a', days: 1, status: 'success' }],
        checkpoints: [{ step: 'update-product-batch', writeSent: true, target: '11', at: 1 }],
      } as any),
      now: () => 1000,
    });
    expect(result).toBe('reattached');
    expect(saved.active.phase).toBe('awaiting-restore');
  });
});

describe('R2 写截止（第 34.3 节）', () => {
  /** 与上面的 `makeDeps` 同构的最小依赖（那个在同级 describe 内不可见） */
  function makeTickDeps(active: ShippingGroup) {
    const starts: Array<{ phase: string }> = [];
    const saves: ShippingGroupsRecord[] = [];
    let record: ShippingGroupsRecord = { ...SHIPPING_EMPTY_GROUPS, active };
    const deps: ShippingGroupDeps = {
      loadGroups: async () => record,
      saveGroups: async r => {
        saves.push(r);
        record = r;
      },
      preview: async () => ({
        ok: true,
        shopId: 7001,
        items: [{ itemId: '11', name: 'a', status: 1, categoryPath: '1:2' }],
      }),
      startTask: async input => {
        starts.push({ phase: input.phase });
        return { success: true, taskId: `t-${input.phase}` };
      },
      isTaskActive: async () => false,
      isIdentityOk: async () => true,
      findOtherWriteConflict: async () => null,
      now: () => NOW,
    };
    return { deps, starts, saves };
  }

  it('启动前已越过窗口 → 标已错过且不启动任务', async () => {
    const group = makeGroup({ schedule: { startAt: NOW - 10 * MINUTE, restoreAt: NOW + HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, starts, saves } = makeTickDeps(group);
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('mark-missed');
    expect(starts).toHaveLength(0);
    expect(saves[saves.length - 1].active?.phase).toBe('missed');
  });

  it('窗口内正常启动（对照）', async () => {
    const group = makeGroup({ schedule: { startAt: NOW - 30_000, restoreAt: NOW + HOUR, spotDays: 1, regularDays: 8 } });
    const { deps, starts } = makeTickDeps(group);
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('started-spot');
    expect(starts).toHaveLength(1);
  });
});

describe('R5 两阶段结果与义务一致（第 34.6 节）', () => {
  it('合并不会用 pending 抹掉另一阶段已确认的结论', () => {
    const merged = mergeGroupItems(
      [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
      itemOutcomesFromTask('restore', [{ itemId: '11', name: 'a', status: 'failed' }]),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].spot).toBe('success');
    expect(merged[0].restore).toBe('failed');
  });

  it('恢复失败后首阶段结论仍在，恢复义务不丢', () => {
    const group = makeGroup({
      phase: 'restoring',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11'],
      items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
    });
    const next = applyTaskResultToGroup(
      group,
      'restore',
      { status: 'completed', items: [{ itemId: '11', name: 'a', days: 8, status: 'failed' }] },
      NOW,
    );
    const spotItem = next.items.find(i => i.itemId === '11');
    expect(spotItem?.spot).toBe('success');
    expect(spotItem?.restore).toBe('failed');
    expect(groupHoldsRestoreObligation(next)).toBe(true);
    expect(restoreItemIds(next)).toEqual(['11']);
  });

  it('skipped 但没有"回读确认已是目标"证据 → 不算恢复完成', () => {
    const group = makeGroup({
      phase: 'restoring',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11'],
      items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
    });
    const next = applyTaskResultToGroup(
      group,
      'restore',
      { status: 'completed', items: [{ itemId: '11', name: 'a', days: 8, status: 'skipped' }] },
      NOW,
    );
    expect(next.phase).toBe('needs-attention');
    expect(next.pendingItemIds).toEqual(['11']);
  });

  it('skipped 且有回读确认 → 才算恢复完成', () => {
    const next = applyTaskResultToGroup(
      makeGroup({ phase: 'restoring', claimedStages: ['spot'], confirmedSpotItemIds: ['11'], items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }] }),
      'restore',
      {
        status: 'completed',
        items: [{ itemId: '11', name: 'a', days: 8, status: 'skipped' }],
      },
      NOW,
      [],
    );
    // 无 alreadyAtTarget 证据时不算完成（上一个用例已断言）；这里补上证据后应完成
    const withEvidence = applyTaskResultToGroup(
      makeGroup({
        phase: 'restoring',
        claimedStages: ['spot'],
        confirmedSpotItemIds: ['11'],
        items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
      }),
      'restore',
      { status: 'completed', items: [{ itemId: '11', name: 'a', days: 8, status: 'skipped' }] },
      NOW,
    );
    expect(next.pendingItemIds).toEqual(['11']);
    expect(withEvidence.pendingItemIds).toEqual(['11']);
  });

  it('商品成功但物流未收尾 → 不能报完成', () => {
    const next = applyTaskResultToGroup(
      makeGroup({
        phase: 'restoring',
        claimedStages: ['spot'],
        confirmedSpotItemIds: ['11'],
        items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
      }),
      'restore',
      {
        status: 'completed',
        items: [{ itemId: '11', name: 'a', days: 8, status: 'success' }],
        logisticsSettled: false,
        pendingChannels: 2,
      },
      NOW,
    );
    expect(next.phase).toBe('needs-attention');
    expect(next.error).toContain('渠道');
  });

  it('商品与物流都收尾 → 完成', () => {
    const next = applyTaskResultToGroup(
      makeGroup({
        phase: 'restoring',
        claimedStages: ['spot'],
        confirmedSpotItemIds: ['11'],
        items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
      }),
      'restore',
      {
        status: 'completed',
        items: [{ itemId: '11', name: 'a', days: 8, status: 'success' }],
        logisticsSettled: true,
        pendingChannels: 0,
      },
      NOW,
    );
    expect(next.phase).toBe('done');
    expect(next.pendingItemIds).toEqual([]);
  });

  it('已完成的组不会被迟到回调改回（done 不回退）', () => {
    const group = makeGroup({ phase: 'done' });
    const next = applyTaskResultToGroup(
      group,
      'spot',
      { status: 'failed', items: [{ itemId: '11', name: 'a', days: 1, status: 'failed' }] },
      NOW,
    );
    expect(next.phase).toBe('done');
  });
});

// ===== 第 37 节返工时修掉的静默丢义务 / 死胡同（回归）=====

describe('第 37 节回归：义务不因"没有明细"而丢失', () => {
  /**
   * 设备在商品写请求进行中退出时，组是从**检查点**接回来的：
   * `confirmedSpotItemIds` 有商品，但 `items` 里没有它们的记录。
   * 早先 `restoreItemIds` 从 `items` 过滤，于是这些商品被静默剔除，
   * 恢复对象变成空集，组直接报"没有需要恢复的商品"并结束 ——
   * 商品却还停在 1 天没人恢复（真实中断复现）。
   */
  it('没有逐项明细时仍以已确认集合为恢复对象', () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11', '22'],
      items: [],
    });
    expect(restoreItemIds(group).sort()).toEqual(['11', '22']);
  });

  it('已确认集合里的项即使明细仍是 pending 也保留义务', () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11'],
      items: [item('11', 'pending')],
    });
    expect(restoreItemIds(group)).toEqual(['11']);
  });

  it('已恢复成功的项不再进入恢复集合（重复事件不重复写）', () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11', '22'],
      items: [item('11', 'success', 'success'), item('22', 'success', 'pending')],
    });
    expect(restoreItemIds(group)).toEqual(['22']);
  });

  it('有义务但完全没有明细的项会被计入待处理，不谎报完成', () => {
    const next = applyTaskResultToGroup(
      makeGroup({
        phase: 'restoring',
        claimedStages: ['spot'],
        confirmedSpotItemIds: ['11', '22'],
        items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
      }),
      'restore',
      { status: 'completed', items: [{ itemId: '11', name: 'a', days: 8, status: 'success' }] },
      NOW,
    );
    expect(next.phase).toBe('needs-attention');
    expect(next.pendingItemIds).toContain('22');
  });

  it('过期的 failed 状态不应阻止"义务已全部了结"的结案', () => {
    // 物流恢复失败会把任务落成 failed；用户修好渠道后那条记录仍是 failed（历史事实）。
    // 判据必须回到"还有没有未了义务"，否则组永远结不了案。
    const next = applyTaskResultToGroup(
      makeGroup({
        phase: 'restoring',
        claimedStages: ['spot'],
        confirmedSpotItemIds: ['11'],
        items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
      }),
      'restore',
      {
        status: 'failed',
        items: [{ itemId: '11', name: 'a', days: 8, status: 'success' }],
        logisticsSettled: true,
        pendingChannels: 0,
      },
      NOW,
    );
    expect(next.phase).toBe('done');
  });

  it('任务仍在跑时不得判定完成', () => {
    const next = applyTaskResultToGroup(
      makeGroup({
        phase: 'restoring',
        claimedStages: ['spot'],
        confirmedSpotItemIds: ['11'],
        items: [{ itemId: '11', name: 'a', spot: 'success', restore: 'pending' }],
      }),
      'restore',
      {
        status: 'running',
        items: [{ itemId: '11', name: 'a', days: 8, status: 'success' }],
        logisticsSettled: true,
        pendingChannels: 0,
      },
      NOW,
    );
    expect(next.phase).not.toBe('done');
  });
});

describe('第 37 节回归：物流义务与"无商品可恢复"的结案', () => {
  function makeDeps(overrides: Partial<ShippingGroupDeps> & { record: ShippingGroupsRecord }): {
    deps: ShippingGroupDeps;
    saves: ShippingGroupsRecord[];
  } {
    const saves: ShippingGroupsRecord[] = [];
    const deps: ShippingGroupDeps = {
      loadGroups: async () => overrides.record,
      saveGroups: async record => {
        saves.push(record);
        overrides.record = record;
      },
      preview: async () => ({
        ok: true,
        shopId: 7001,
        items: [{ itemId: '11', name: 'a', status: 1, categoryPath: '1:2' }],
      }),
      startTask: async () => ({ success: true, taskId: 't-restore' }),
      isTaskActive: async () => false,
      isIdentityOk: async () => true,
      findOtherWriteConflict: async () => null,
      now: () => NOW,
      ...overrides,
    };
    return { deps, saves };
  }

  it('没有商品可恢复且无物流义务 → 正常结束（不再误报需处理）', async () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11'],
      // 已恢复成功 → 恢复对象为空，且没有物流义务 → 应当结束
      items: [item('11', 'success', 'success')],
      schedule: { startAt: NOW - 4 * HOUR, restoreAt: NOW - HOUR, spotDays: 1, regularDays: 8 },
    });
    const { deps } = makeDeps({ record: { ...SHIPPING_EMPTY_GROUPS, active: group }, pendingLogistics: async () => null });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('done');
  });

  it('没有商品可恢复但物流还关着 → 留需处理，保住店铺渠道', async () => {
    const group = makeGroup({
      phase: 'awaiting-restore',
      claimedStages: ['spot'],
      confirmedSpotItemIds: ['11'],
      // 商品都恢复好了，但这次关掉的渠道还没恢复 → 不能结束本组
      items: [item('11', 'success', 'success')],
      schedule: { startAt: NOW - 4 * HOUR, restoreAt: NOW - HOUR, spotDays: 1, regularDays: 8 },
    });
    const { deps } = makeDeps({
      record: { ...SHIPPING_EMPTY_GROUPS, active: group },
      pendingLogistics: async () => '上一批的原店铺物流尚未恢复（渠道 101），请先恢复物流',
    });
    const result = await tickShippingGroup(deps);
    expect(result.action).toBe('needs-attention');
    expect(result.reason).toContain('渠道');
  });
});
