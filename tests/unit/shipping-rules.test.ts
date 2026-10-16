/**
 * shipping 纯规则的隔离单测：范围过滤、排除解析、台湾时区、计划判定。
 *
 * 不联网、不碰 storage、不开浏览器，因此这些规则一旦漂移会立刻在这里失败，
 * 而不是等真实任务把商品改成错的天数。
 */
import { describe, it, expect } from 'vitest';
import {
  buildBatchItem,
  buildHotProductIds,
  buildOccurrenceId,
  classifyExclusion,
  compareShippingConfirmedContent,
  defaultScheduleTimes,
  describeContentDiff,
  describeContentValues,
  filterByRange,
  hasBlockingContentDiff,
  normalizePreviewSettings,
  addPickedIds,
  isEditableForShipping,
  isNonHotDeterminable,
  isPickListOwnedBy,
  isMeaningfulPlan,
  meaningfulPlans,
  isSkuLevelProduct,
  isStartTimePassed,
  isValidDays,
  mergeExcludeText,
  modeForDays,
  nextTaipeiDate,
  parseExcludeIds,
  resolvePlanDue,
  searchByItemId,
  sortDuePlans,
  sortProductsBySold,
  taipeiDateString,
  taipeiLocalToEpoch,
  taipeiTimeString,
  topSoldItemIds,
  validateOneTimePlan,
  validateSettings,
} from '@/features/shipping/rules';
import {
  SHIPPING_DEFAULT_PLANS,
  type ShippingPickableProduct,
  type ShippingPlan,
  type ShippingPreviewSettings,
  type ShippingProduct,
} from '@/features/shipping/types';

function product(id: number, status: number | string | undefined, extra: Partial<ShippingProduct> = {}): ShippingProduct {
  return { id, status, ...extra };
}

describe('备货天数与模式', () => {
  it('只接受 1–10 的整数天数', () => {
    expect(isValidDays(1)).toBe(true);
    expect(isValidDays(10)).toBe(true);
    expect(isValidDays(0)).toBe(false);
    expect(isValidDays(11)).toBe(false);
    expect(isValidDays(2.5)).toBe(false);
    expect(isValidDays('3')).toBe(true);
    expect(isValidDays('3天')).toBe(false);
  });

  it('1 天是现货，2–10 天是预售', () => {
    expect(modeForDays(1)).toBe('spot');
    expect(modeForDays(2)).toBe('preorder');
    expect(modeForDays(10)).toBe('preorder');
  });

  it('设置校验同时拦住非法天数与模式/天数不一致', () => {
    expect(validateSettings({ days: 5, mode: 'preorder' })).toBeNull();
    expect(validateSettings({ days: 1, mode: 'spot' })).toBeNull();
    expect(validateSettings({ days: 0 })).toContain('1–10');
    expect(validateSettings({ days: 3, mode: 'spot' })).toContain('模式与备货天数不一致');
    expect(validateSettings({ days: 3, range: 'bogus' as any })).toContain('修改范围无效');
  });
});

describe('排除 ID 解析', () => {
  it('统一成正整数、去重、丢弃非法输入', () => {
    expect(parseExcludeIds(' 1 \n2, 3，4;5 ')).toEqual(['1', '2', '3', '4', '5']);
    expect(parseExcludeIds('007\n7')).toEqual(['7']);
    expect(parseExcludeIds('abc\n-1\n0\n1.5\n')).toEqual([]);
    expect(parseExcludeIds('')).toEqual([]);
    expect(parseExcludeIds(null)).toEqual([]);
  });

  it('合并时保留原有顺序并去重', () => {
    expect(mergeExcludeText('1\n2', ['2', '3'])).toBe('1\n2\n3');
  });
});

describe('REST 状态与范围过滤', () => {
  it('status 可能是字符串，必须按数字比较', () => {
    expect(isEditableForShipping(product(1, '1'))).toBe(true);
    expect(isEditableForShipping(product(1, 1))).toBe(true);
    expect(isEditableForShipping(product(1, '8'))).toBe(true);
    expect(isEditableForShipping(product(1, 8))).toBe(true);
    // 特卖 GraphQL 的活跃 status=0 不是本端点的可编辑状态
    expect(isEditableForShipping(product(1, 0))).toBe(false);
    expect(isEditableForShipping(product(1, undefined))).toBe(false);
  });

  it('在线 / 下架范围分别只取 1 和 8', () => {
    const all = [product(1, '1'), product(2, 1), product(3, '8'), product(4, 8), product(5, 3)];
    expect(filterByRange(all, 'online').map(p => p.id)).toEqual([1, 2]);
    expect(filterByRange(all, 'offline').map(p => p.id)).toEqual([3, 4]);
    expect(filterByRange(all, 'all').map(p => p.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('非热销排除销量前 500 与浏览量前 500 的并集', () => {
    const all = [
      product(1, 1, { sold: 100, view_count: 1 }),
      product(2, 1, { sold: 1, view_count: 100 }),
      product(3, 1, { sold: 50, view_count: 50 }),
    ];
    const hot = buildHotProductIds(all, 1);
    expect(hot.has('1')).toBe(true);
    expect(hot.has('2')).toBe(true);
    expect(hot.has('3')).toBe(false);
    expect(filterByRange(all, 'nonhot', 1).map(p => p.id)).toEqual([3]);
    // 商品总数少于 topN 时全部算热销 → 非热销范围为空，这是预期结果而非读失败
    expect(filterByRange(all, 'nonhot').map(p => p.id)).toEqual([]);
  });

  it('字段缺失按不可排序处理，不当作 0', () => {
    const all = [
      product(1, 1, { sold: undefined, view_count: undefined }),
      product(2, 1, { sold: 5, view_count: 5 }),
    ];
    const hot = buildHotProductIds(all, 1);
    // 只有商品 2 参与排序；商品 1 不应因为「缺失」而被当成销量 0 之外的怪值
    expect(hot.has('2')).toBe(true);
    expect(hot.has('1')).toBe(false);
  });

  it('两个排序字段都不可取得时明确报告不可判定', () => {
    expect(isNonHotDeterminable([product(1, 1)])).toBe(false);
    expect(isNonHotDeterminable([product(1, 1, { sold: 0 })])).toBe(true);
    expect(isNonHotDeterminable([product(1, 1, { view_count: null })])).toBe(false);
  });
});

describe('请求体', () => {
  it('1 天 pre_order=false，2–10 天 pre_order=true，保留 category_path', () => {
    expect(buildBatchItem('123', 'a/b', 1)).toEqual({
      id: 123,
      category_path: 'a/b',
      pre_order: false,
      days_to_ship: 1,
    });
    expect(buildBatchItem('123', '', 7)).toEqual({
      id: 123,
      category_path: '',
      pre_order: true,
      days_to_ship: 7,
    });
  });

  it('按 SKU 设置备货的商品被识别为不支持（不在预览里被静默降级）', () => {
    expect(isSkuLevelProduct({ id: 1, enable_model_level_dts: true })).toBe(true);
    expect(isSkuLevelProduct({ id: 1, enable_model_level_dts: false })).toBe(false);
    expect(isSkuLevelProduct({ id: 1 })).toBe(false);
  });
});

describe('台湾时区', () => {
  it('日期与时刻按 Asia/Taipei 换算，不看系统时区', () => {
    // 2026-10-14T00:30:00+08:00 = 2026-10-13T16:30:00Z
    const epoch = Date.UTC(2026, 9, 13, 16, 30, 0);
    expect(taipeiDateString(epoch)).toBe('2026-10-14');
    expect(taipeiTimeString(epoch)).toBe('00:30');
  });

  it('本地时刻到瞬间可往返（含跨日界）', () => {
    const epoch = taipeiLocalToEpoch('2026-10-14', '09:00');
    expect(epoch).not.toBeNull();
    expect(taipeiDateString(epoch!)).toBe('2026-10-14');
    expect(taipeiTimeString(epoch!)).toBe('09:00');
    // 午夜：en-CA 的 24 时制会把 0 点写成 24，必须归一到 0
    const midnight = taipeiLocalToEpoch('2026-10-14', '00:00');
    expect(taipeiTimeString(midnight!)).toBe('00:00');
  });

  it('不存在的日期返回 null，不静默变成别的日子', () => {
    expect(taipeiLocalToEpoch('2026-02-30', '09:00')).toBeNull();
    expect(taipeiLocalToEpoch('2026-10-14', '25:00')).toBeNull();
    expect(taipeiLocalToEpoch('', '09:00')).toBeNull();
    expect(taipeiLocalToEpoch('2026-10-14', '')).toBeNull();
  });

  it('日期加一天不经过系统时区', () => {
    expect(nextTaipeiDate('2026-10-14')).toBe('2026-10-15');
    expect(nextTaipeiDate('2026-12-31')).toBe('2027-01-01');
  });
});

/**
 * 第 53.3 节 U14：新空白安排的默认时刻。
 *
 * 为什么这些要单独测：默认值是"跨天/跨年边界 + 台湾本地时区"的组合，
 * 一旦漂移，用户会看到一个已经过去、根本存不下的默认时间。
 */
describe('U14 新空白安排的默认时刻', () => {
  it('普通日期：今天 23:30 切现货，开始日期的次日 01:30 恢复', () => {
    // 2026-10-14T10:00:00+08:00
    const now = Date.UTC(2026, 9, 14, 2, 0, 0);
    expect(defaultScheduleTimes(now)).toEqual({
      startDate: '2026-10-14',
      startTime: '23:30',
      restoreDate: '2026-10-15',
      restoreTime: '01:30',
    });
  });

  it('台湾日期边界：UTC 还是前一天时，默认按台北当天算', () => {
    // 2026-10-14T00:30:00+08:00 == 2026-10-13T16:30:00Z
    const now = Date.UTC(2026, 9, 13, 16, 30, 0);
    expect(defaultScheduleTimes(now).startDate).toBe('2026-10-14');
    expect(defaultScheduleTimes(now).restoreDate).toBe('2026-10-15');
  });

  it('月底与年底的次日不会溢出', () => {
    expect(defaultScheduleTimes(Date.UTC(2026, 9, 31, 2, 0, 0)).restoreDate).toBe('2026-11-01');
    expect(defaultScheduleTimes(Date.UTC(2026, 11, 31, 2, 0, 0)).restoreDate).toBe('2027-01-01');
  });

  it('过点判断：默认 23:30 在 23:00 未过、23:40 已过', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 9, 14, h - 8, m, 0);
    const before = defaultScheduleTimes(at(23, 0));
    const after = defaultScheduleTimes(at(23, 40));
    expect(isStartTimePassed(taipeiLocalToEpoch(before.startDate, before.startTime), before.startTime, at(23, 0))).toBe(false);
    expect(isStartTimePassed(taipeiLocalToEpoch(after.startDate, after.startTime), after.startTime, at(23, 40))).toBe(true);
  });

  it('isStartTimePassed：空时刻不报"已过"，同一分钟也不算', () => {
    const start = taipeiLocalToEpoch('2026-10-14', '23:30')!;
    // 还没到
    expect(isStartTimePassed(start, '23:30', start - 60_000)).toBe(false);
    // 就在 23:30 那一分钟：交给后台的 `startAt <= now` 处理，界面不抢先报过
    expect(isStartTimePassed(start, '23:30', start)).toBe(false);
    // 已过
    expect(isStartTimePassed(start, '23:30', start + 60_000)).toBe(true);
    // 空时刻 → 由 validateGroupInput 提示"请选择时间"
    expect(isStartTimePassed(null, '', start + 60_000)).toBe(false);
  });

  it('同一毫秒内重复调用结果一致（不依赖模块加载时刻）', () => {
    const now = Date.now();
    expect(defaultScheduleTimes(now)).toEqual(defaultScheduleTimes(now));
  });
});

describe('计划轮次判定', () => {
  function plan(overrides: Partial<ShippingPlan> = {}): ShippingPlan {
    return { ...SHIPPING_DEFAULT_PLANS[0], enabled: true, ...overrides };
  }

  it('轮次标识由 计划ID + 台湾日期 + 时刻 固定', () => {
    expect(buildOccurrenceId('plan1', '2026-10-14', '09:00')).toBe('plan1@2026-10-14@09:00');
  });

  it('未到点不执行；到点且未执行才返回本轮', () => {
    const p = plan({ date: '2026-10-14', time: '09:00' });
    const before = taipeiLocalToEpoch('2026-10-14', '08:59')!;
    expect(resolvePlanDue(p, before)).toBeNull();
    const after = taipeiLocalToEpoch('2026-10-14', '09:01')!;
    const due = resolvePlanDue(p, after);
    expect(due).not.toBeNull();
    expect((due as any).occurrenceId).toBe('plan1@2026-10-14@09:00');
  });

  it('同一轮已执行过则不再触发（重复 alarm 不得启动第二份）', () => {
    const p = plan({ date: '2026-10-14', time: '09:00', lastRunId: 'plan1@2026-10-14@09:00' });
    expect(resolvePlanDue(p, taipeiLocalToEpoch('2026-10-14', '09:01')!)).toBeNull();
  });

  it('一次性计划错过过去日期标 missed，不补写历史', () => {
    const p = plan({ date: '2026-10-13', time: '09:00' });
    expect(resolvePlanDue(p, taipeiLocalToEpoch('2026-10-14', '12:00')!)).toBe('missed');
    // 已执行过的一次性计划不再报 missed
    const done = plan({ date: '2026-10-13', time: '09:00', lastRunId: 'plan1@2026-10-13@09:00' });
    expect(resolvePlanDue(done, taipeiLocalToEpoch('2026-10-14', '12:00')!)).toBeNull();
  });

  it('每日计划只在自己的时刻到期后触发，跨日按当天算', () => {
    const p = plan({ loopDaily: true, time: '09:00', date: '' });
    expect(resolvePlanDue(p, taipeiLocalToEpoch('2026-10-14', '08:00')!)).toBeNull();
    const due = resolvePlanDue(p, taipeiLocalToEpoch('2026-10-14', '09:00')!);
    expect((due as any).taipeiDate).toBe('2026-10-14');
    // 跨午夜：次日同一时刻是新的轮次标识
    const nextDay = resolvePlanDue(p, taipeiLocalToEpoch('2026-10-15', '09:00')!);
    expect((nextDay as any).occurrenceId).toBe('plan1@2026-10-15@09:00');
  });

  it('同日到期按目标时刻、再按稳定槽位排序', () => {
    const due = [
      { plan: plan({ id: 'plan2', time: '10:00' }), occurrenceId: 'b', dueAt: 200, taipeiDate: '2026-10-14' },
      { plan: plan({ id: 'plan1', time: '09:00' }), occurrenceId: 'a', dueAt: 100, taipeiDate: '2026-10-14' },
      { plan: plan({ id: 'plan2', time: '09:00' }), occurrenceId: 'c', dueAt: 100, taipeiDate: '2026-10-14' },
    ];
    expect(sortDuePlans(due as any).map(d => d.occurrenceId)).toEqual(['a', 'c', 'b']);
  });

  it('一次性计划保存时拒绝已过或无效的日期时间', () => {
    const now = taipeiLocalToEpoch('2026-10-14', '09:00')!;
    expect(validateOneTimePlan('2026-10-14', '08:59', now)).toContain('已过');
    expect(validateOneTimePlan('2026-10-14', '09:01', now)).toBeNull();
    expect(validateOneTimePlan('2026-13-40', '09:01', now)).toContain('无效');
  });
});

describe('排除规则归类', () => {
  it('手动排除优先级最高', () => {
    const manual = new Set(['1']);
    const flash = new Set(['1', '2']);
    expect(classifyExclusion('1', manual, flash)).toBe('manual');
    expect(classifyExclusion('2', manual, flash)).toBe('flash-sale');
    expect(classifyExclusion('3', manual, flash)).toBeNull();
  });
});

// ===== 返工 17.1：确认内容比对 =====
//
// 预览请求号只证明"这个预览存在"，不证明"要执行的就是它"。
// 同一请求号配另一套天数或额外商品必须被拒绝，否则确认过的范围会被悄悄扩大。

function previewSettings(over: Partial<ShippingPreviewSettings> = {}): ShippingPreviewSettings {
  return {
    mode: 'preorder',
    days: 7,
    range: 'all',
    excludeIds: '',
    toggleLogistics: false,
    ...over,
  };
}

describe('确认内容比对（17.1）', () => {
  const confirmed = { settings: previewSettings(), itemIds: ['101', '102', '103'] };

  it('完全相同：无差异、不阻断', () => {
    const diffs = compareShippingConfirmedContent(confirmed, {
      settings: previewSettings(),
      itemIds: ['101', '102', '103'],
    });
    expect(diffs).toEqual([]);
    expect(hasBlockingContentDiff(diffs)).toBe(false);
  });

  it('顺序不同不算内容变更', () => {
    const diffs = compareShippingConfirmedContent(confirmed, {
      settings: previewSettings(),
      itemIds: ['103', '101', '102'],
    });
    expect(diffs).toEqual([]);
    expect(hasBlockingContentDiff(diffs)).toBe(false);
  });

  it('改天数 → 阻断', () => {
    const diffs = compareShippingConfirmedContent(confirmed, {
      settings: previewSettings({ days: 9, mode: 'preorder' }),
      itemIds: ['101', '102', '103'],
    });
    expect(diffs.map(d => d.kind)).toContain('settings-days');
    expect(hasBlockingContentDiff(diffs)).toBe(true);
    expect(describeContentDiff(diffs)).toContain('7 → 9');
  });

  it('改范围 → 阻断', () => {
    const diffs = compareShippingConfirmedContent(confirmed, {
      settings: previewSettings({ range: 'online' }),
      itemIds: ['101', '102', '103'],
    });
    expect(diffs.map(d => d.kind)).toContain('settings-range');
    expect(hasBlockingContentDiff(diffs)).toBe(true);
  });

  it('改排除项 → 阻断（顺序不同但内容相同不阻断）', () => {
    const base = { settings: previewSettings({ excludeIds: '9\n8' }), itemIds: ['101'] };
    const sameContent = compareShippingConfirmedContent(base, {
      settings: previewSettings({ excludeIds: '8\n9' }),
      itemIds: ['101'],
    });
    expect(sameContent).toEqual([]);

    const changed = compareShippingConfirmedContent(base, {
      settings: previewSettings({ excludeIds: '8' }),
      itemIds: ['101'],
    });
    expect(changed.map(d => d.kind)).toContain('settings-exclude');
    expect(hasBlockingContentDiff(changed)).toBe(true);
  });

  it('改物流开关 → 阻断', () => {
    const diffs = compareShippingConfirmedContent(confirmed, {
      settings: previewSettings({ toggleLogistics: true }),
      itemIds: ['101', '102', '103'],
    });
    expect(diffs.map(d => d.kind)).toContain('settings-logistics');
    expect(hasBlockingContentDiff(diffs)).toBe(true);
  });

  it('多出预览外商品 → 阻断（不得扩大集合）', () => {
    const diffs = compareShippingConfirmedContent(confirmed, {
      settings: previewSettings(),
      itemIds: ['101', '102', '103', '999'],
    });
    expect(diffs.map(d => d.kind)).toContain('items-extra');
    expect(hasBlockingContentDiff(diffs)).toBe(true);
    expect(describeContentDiff(diffs)).toContain('999');
  });

  it('只减少已确认商品 → 记差异但不阻断（开跑前过滤属既有规则）', () => {
    const diffs = compareShippingConfirmedContent(confirmed, {
      settings: previewSettings(),
      itemIds: ['101', '102'],
    });
    expect(diffs.map(d => d.kind)).toEqual(['items-missing']);
    expect(hasBlockingContentDiff(diffs)).toBe(false);
    expect(describeContentDiff(diffs)).toContain('103');
  });

  it('全部被排除（集合为空）→ 只记减少，不阻断', () => {
    const diffs = compareShippingConfirmedContent(confirmed, {
      settings: previewSettings(),
      itemIds: [],
    });
    expect(diffs.map(d => d.kind)).toEqual(['items-missing']);
    expect(hasBlockingContentDiff(diffs)).toBe(false);
  });
});

// ===== 返工 20.1：设置规范化（比较与执行必须用同一份，且拒绝非 boolean）=====

describe('设置规范化（20.1）', () => {
  it('boolean false 通过，且原样保留 false（不因字面量真值语义被当成开）', () => {
    const r = normalizePreviewSettings({ days: 7, range: 'all', excludeIds: '', toggleLogistics: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settings.toggleLogistics).toBe(false);
  });

  it('boolean true 通过', () => {
    const r = normalizePreviewSettings({ days: 7, range: 'all', excludeIds: '', toggleLogistics: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settings.toggleLogistics).toBe(true);
  });

  it('字符串 "true" 被拒绝（不能凭 JS 真值语义理解成开）', () => {
    const r = normalizePreviewSettings({ days: 7, range: 'all', excludeIds: '', toggleLogistics: 'true' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('true/false');
  });

  it('字符串 "false" 同样被拒绝（若按真值语义会变成"开"，与用户确认相反）', () => {
    const r = normalizePreviewSettings({ days: 7, range: 'all', excludeIds: '', toggleLogistics: 'false' });
    expect(r.ok).toBe(false);
  });

  it('数字 1／0 与 null／undefined 都被拒绝', () => {
    for (const v of [1, 0, null, undefined]) {
      const r = normalizePreviewSettings({ days: 7, range: 'all', excludeIds: '', toggleLogistics: v });
      expect(r.ok, `${String(v)} 应被拒绝`).toBe(false);
    }
  });

  it('天数或范围不合法时也拒绝', () => {
    expect(normalizePreviewSettings({ days: 99, range: 'all', excludeIds: '', toggleLogistics: false }).ok).toBe(false);
    expect(normalizePreviewSettings({ days: 7, range: 'bogus', excludeIds: '', toggleLogistics: false }).ok).toBe(false);
  });

  it('天数 1 归到现货模式，2–10 归到预售', () => {
    const spot = normalizePreviewSettings({ days: 1, range: 'all', excludeIds: '', toggleLogistics: false });
    const pre = normalizePreviewSettings({ days: 6, range: 'all', excludeIds: '', toggleLogistics: false });
    if (spot.ok) expect(spot.settings.mode).toBe('spot');
    if (pre.ok) expect(pre.settings.mode).toBe('preorder');
  });

  it('诊断值里如实标出原值类型（便于复验区分"类型不对"与"值不同"）', () => {
    const values = describeContentValues({ days: 7, range: 'all', excludeIds: '', toggleLogistics: 'true' });
    const log = values.find(v => v.field === 'toggleLogistics');
    expect(log?.rawType).toBe('string');
    expect(log?.normalized).toContain('非boolean');
    const okLog = describeContentValues({ days: 7, range: 'all', excludeIds: '', toggleLogistics: false }).find(
      v => v.field === 'toggleLogistics',
    );
    expect(okLog?.rawType).toBe('boolean');
  });

  it('非 boolean 的物流开关与 boolean false 相比算"不一致"（类型不同即不同）', () => {
    const diffs = compareShippingConfirmedContent(
      { settings: previewSettings({ toggleLogistics: false }), itemIds: ['1'] },
      {
        settings: { ...previewSettings(), toggleLogistics: 'false' as unknown as boolean },
        itemIds: ['1'],
      },
    );
    expect(diffs.map(d => d.kind)).toContain('settings-logistics');
    expect(hasBlockingContentDiff(diffs)).toBe(true);
  });
});
// ===== 排除选择器的排名与检索（第 31 节 31.4 / U2）=====

function pick(id: number, sold: number | null, name = ''): ShippingPickableProduct {
  return { itemId: String(id), name: name || `商品 ${id}`, status: 1, sold, views: null };
}

describe('排除选择器：销量排名与检索', () => {
  it('销量降序，未知销量排在已知之后且不冒充 0', () => {
    const list = [pick(1, 5), pick(2, null), pick(3, 99), pick(4, null), pick(5, 5)];
    const sorted = sortProductsBySold(list).map(p => p.itemId);
    expect(sorted.slice(0, 3)).toEqual(['3', '1', '5']);
    expect(sorted.slice(3).sort()).toEqual(['2', '4']);
  });

  it('相同销量按商品 ID 稳定排序（数值比较，10 不排到 9 前面）', () => {
    const list = [pick(10, 7), pick(9, 7), pick(100, 7)];
    expect(sortProductsBySold(list).map(p => p.itemId)).toEqual(['9', '10', '100']);
  });

  it('全店前 5／前 10 基于完整列表，与当前检索无关', () => {
    const list = Array.from({ length: 60 }, (_, i) => pick(i + 1, 1000 - i));
    const searched = searchByItemId(list, '42');
    expect(searched).toHaveLength(1);
    expect(topSoldItemIds(list, 5)).toEqual(['1', '2', '3', '4', '5']);
    expect(topSoldItemIds(list, 10)).toHaveLength(10);
  });

  it('未知销量的商品不参与快捷前 N，商品不足 N 时按实际数量返回', () => {
    const list = [pick(1, null), pick(2, 9), pick(3, 8), pick(4, null)];
    expect(topSoldItemIds(list, 10)).toEqual(['2', '3']);
  });

  it('快捷勾选追加且去重，不替换已有选择', () => {
    expect(addPickedIds(['9'], ['1', '2', '9'])).toEqual(['9', '1', '2']);
  });

  it('按 ID 检索为包含匹配且精确命中优先，多段检索词合并去重', () => {
    const list = [pick(123), pick(456), pick(1234), pick(789)];
    expect(searchByItemId(list, '456').map(p => p.itemId)).toEqual(['456']);
    expect(searchByItemId(list, '123').map(p => p.itemId)).toEqual(['123', '1234']);
    expect(searchByItemId(list, '456 789').map(p => p.itemId)).toEqual(['456', '789']);
    expect(searchByItemId(list, '123 1234').map(p => p.itemId)).toEqual(['123', '1234']);
    expect(searchByItemId(list, '')).toHaveLength(4);
  });

  it('超过 50 个商品时仍能检索到第 60 个（不受界面可见数量限制）', () => {
    const list = Array.from({ length: 60 }, (_, i) => pick(i + 1, i));
    const found = searchByItemId(list, '60');
    expect(found).toHaveLength(1);
    expect(found[0].itemId).toBe('60');
  });

  it('排除集合解析与去重（两阶段共用同一份）', () => {
    expect(parseExcludeIds('11\n22\n11')).toEqual(['11', '22']);
    expect(parseExcludeIds('abc, 0, -3, 5')).toEqual(['5']);
  });
});

/**
 * 第 43.2 节 R7：候选列表的**完整归属**判据。
 *
 * 为什么单列：这条判据同时被 store 的返回分支与排除弹窗使用。
 * 只比店铺时，"同一家店换账号"会整条漏掉 —— 旧账号的候选仍被判为可信，
 * 用户能把旧账号的商品确认进新账号的安排（验收在真实 store 上复现过）。
 */
describe('候选列表归属判据（店铺＋账号）', () => {
  const owned = { shopId: 101, userId: 2 };

  it('店铺与账号都一致才算当前归属的列表', () => {
    expect(isPickListOwnedBy({ shopId: 101, userId: 2 }, owned)).toBe(true);
  });

  it('同店换账号：店铺相同但账号不同，必须判为不可用', () => {
    expect(isPickListOwnedBy({ shopId: 101, userId: 1 }, owned)).toBe(false);
  });

  it('跨店必须判为不可用', () => {
    expect(isPickListOwnedBy({ shopId: 202, userId: 2 }, owned)).toBe(false);
  });

  it('当前归属未核实（店铺或账号为 null）时一律不可用', () => {
    expect(isPickListOwnedBy({ shopId: 101, userId: 2 }, { shopId: null, userId: 2 })).toBe(false);
    expect(isPickListOwnedBy({ shopId: 101, userId: 2 }, { shopId: 101, userId: null })).toBe(false);
  });

  it('列表没有归属标记（含账号缺失）时不可用', () => {
    expect(isPickListOwnedBy(null, owned)).toBe(false);
    expect(isPickListOwnedBy(undefined, owned)).toBe(false);
    expect(isPickListOwnedBy({ shopId: null, userId: 2 }, owned)).toBe(false);
    expect(isPickListOwnedBy({ shopId: 101, userId: null }, owned)).toBe(false);
  });
});

/**
 * 第 59.2 节：怎么区分"真实旧计划"与"默认空占位"。
 *
 * 为什么单列：连续两轮"新用户隐藏旧计划"都漏在这里 ——
 * `SHIPPING_DEFAULT_PLANS` 的两张占位满足 `plans.length > 0`，
 * 于是从未设置过旧计划的人看到两条"未绑定，请重新保存"的假记录。
 * 判据必须落在**记录本身有没有真实痕迹**上，而不是列表长度。
 */
describe('旧计划是否承载过用户数据（第 59.2 节）', () => {
  const blank = { ...SHIPPING_DEFAULT_PLANS[0] };

  it('两张默认空占位都不是历史', () => {
    expect(meaningfulPlans(SHIPPING_DEFAULT_PLANS)).toEqual([]);
    expect(isMeaningfulPlan(blank)).toBe(false);
  });

  it('每种真实痕迹都能被识别出来', () => {
    const marks: Array<[string, object]> = [
      ['配置过日期', { date: '2100-03-08' }],
      ['启用过', { enabled: true }],
      ['被迁移过', { retired: true }],
      ['到过点', { missed: true }],
      ['跑过', { lastRunAt: 1 }],
      ['有结果', { lastResult: 'completed' }],
      ['有任务', { lastTaskId: 't1' }],
      ['占了轮次', { lastRunId: 'occ1' }],
      ['绑定过店铺', { ownerShopId: 101 }],
      ['绑定过账号', { ownerUserId: 1 }],
    ];
    for (const [label, patch] of marks) {
      expect(isMeaningfulPlan({ ...blank, ...patch }), label).toBe(true);
    }
  });

  it('已配置日期但从未运行也要算历史（不能按 lastRunAt 过滤）', () => {
    const configured = { ...blank, date: '2100-03-08', ownerShopId: 101, ownerUserId: 1 };
    expect(meaningfulPlans([configured]), '保留已配置未运行的安排').toHaveLength(1);
    expect(configured.lastRunAt, '该记录本身没有运行时间').toBeNull();
  });

  it('混合列表只滤掉空占位，真实记录原样保留', () => {
    const real = { ...SHIPPING_DEFAULT_PLANS[1], date: '2100-04-04' };
    const kept = meaningfulPlans([blank, real]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(real);
  });
});
