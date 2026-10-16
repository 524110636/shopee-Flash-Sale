/**
 * 「备货时间定时切换」三步引导界面（任务书第 31 节 31.3）。
 *
 * 为什么单独一个组件而不是塞进 `ShippingWorkPage`：主页面已经有手动修改、
 * 结果面板与旧计划区；三步流程有自己的草稿、摘要联动与撤销入口，
 * 放在一起会让"改一处影响另一处"。这里只做展示与本地草稿，
 * 保存／撤销／阶段推进全部交给后台记录（界面不成为第二套实现）。
 *
 * 颜色沿用扩展既有主题（tailwind 的 shopee.* 与 CSS 变量），
 * 不照搬原型里的橙色 —— 原型的橙是虾皮品牌色，与本扩展当前配色不一致。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  CalendarClock,
  CircleCheck,
  Clock,
  Info,
  LoaderCircle,
  PackageSearch,
  TriangleAlert,
  Truck,
  Undo2,
} from 'lucide-react';
import { useShippingStore } from '@/features/shipping/store';
import { ShippingExcludeModal, excludeIdsToText } from './ShippingExcludeModal';
import {
  describeDayOffset,
  describeNextAction,
  describeSpotDuration,
  describeWindowPolicy,
  isValidRegularDays,
  SHIPPING_REGULAR_DAY_OPTIONS,
  SHIPPING_SPOT_DAYS,
  validateGroupInput,
} from '@/features/shipping/group-rules';
import { parseExcludeIds, taipeiLocalToEpoch, isStartTimePassed } from '@/features/shipping/rules';
import {
  SHIPPING_GROUP_PHASE_LABEL,
  SHIPPING_RANGE_LABEL,
  type ShippingGroup,
  type ShippingPlanRange,
} from '@/features/shipping/types';

/** 把毫秒时间戳显示成"MM月DD日 HH:mm"（按台湾时区）。 */
function formatTaipei(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const d = new Date(ms + 8 * 3600_000);
  const hh = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${hh}`;
}

/** 阶段 → 顶部状态区色调（只影响展示，不参与判定）。 */
function statusTone(phase: ShippingGroup['phase']) {
  if (phase === 'done') return { cls: 'border-shopee-green/40 bg-shopee-green/5', Icon: CircleCheck, tone: 'text-shopee-green' };
  if (phase === 'needs-attention')
    return { cls: 'border-destructive/40 bg-destructive/5', Icon: TriangleAlert, tone: 'text-destructive' };
  if (phase === 'missed') return { cls: 'border-border bg-muted/40', Icon: Info, tone: 'text-muted-foreground' };
  if (phase === 'cutting' || phase === 'restoring')
    return { cls: 'border-shopee-brand/40 bg-shopee-brand-light', Icon: LoaderCircle, tone: 'text-shopee-brand' };
  return { cls: 'border-border bg-muted/30', Icon: CalendarClock, tone: 'text-shopee-brand' };
}

/** 顶部真实状态：阶段与下一动作都来自后台记录，不靠界面猜测。 */
function GroupStatus({ group }: { group: ShippingGroup }) {  const { cls, Icon, tone } = statusTone(group.phase);
  return (
    <div className={`flex items-start gap-2 rounded-md border px-2.5 py-2 ${cls}`} role="status">
      <Icon
        className={`mt-0.5 h-4 w-4 shrink-0 ${tone} ${
          group.phase === 'cutting' || group.phase === 'restoring' ? 'animate-spin' : ''
        }`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium">{SHIPPING_GROUP_PHASE_LABEL[group.phase]}</span>
          <Badge variant="outline" className="h-4 px-1 text-[10px]">
            单次执行
          </Badge>
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{describeNextAction(group)}</p>
        {group.message && group.phase !== 'needs-attention' && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{group.message}</p>
        )}
        {group.phase === 'needs-attention' && group.error && (
          <p className="mt-0.5 text-[11px] text-destructive break-all">{group.error}</p>
        )}
        {group.confirmedSpotItemIds.length > 0 && group.phase !== 'done' && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            已确认切现货 {group.confirmedSpotItemIds.length} 个商品，恢复义务保留
          </p>
        )}
      </div>
    </div>
  );
}

/** 融合式使用建议卡：浅暖色，与界面同一套边框／圆角，不用原型橙色。 */
function UsageNotice() {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-900">
      <div className="flex items-center gap-1.5 font-medium">
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
        使用建议 · 优先安排在周末
      </div>
      <p className="mt-0.5">
        建议尽量在周末使用，避免安排在其他时段。执行期间请保持设备开机、浏览器运行并联网，以减少任务中断。
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer text-amber-800">关机或断网时如何处理</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>提前保存的安排在重启后仍保留，执行前重启不需要重新设置。</li>
          <li>
            错过"切到 1 天"：{describeWindowPolicy()}已切到 1 天的商品会保留恢复义务。
          </li>
          <li>若已经切到 1 天：恢复联网后核实原店铺及实际结果，优先恢复常规天数；结果不明时提示处理。</li>
          <li>设备关机或浏览器完全退出期间，无法按时执行任务。</li>
        </ul>
      </details>
    </div>
  );
}

/** 三步标题（编号 + 标题 + 说明），原型与实现的间距都靠它统一。 */
function StepHeading({ n, title, hint }: { n: number; title: string; hint: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-shopee-brand text-[12px] font-semibold text-primary-foreground">
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="text-[13px] font-medium leading-tight">{title}</h3>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

export function ShippingSchedulePanel() {
  const draft = useShippingStore(s => s.groupDraft);
  const updateGroupDraft = useShippingStore(s => s.updateGroupDraft);
  const saveGroup = useShippingStore(s => s.saveGroup);
  const revokeGroup = useShippingStore(s => s.revokeGroup);
  const stopGroup = useShippingStore(s => s.stopGroup);
  const reuseLastGroup = useShippingStore(s => s.reuseLastGroup);
  const syncGroup = useShippingStore(s => s.syncGroup);
  const group = useShippingStore(s => s.group);
  const lastFinished = useShippingStore(s => s.groupLastFinished);
  const saving = useShippingStore(s => s.groupSaving);
  const notice = useShippingStore(s => s.notice);
  const error = useShippingStore(s => s.error);

  const [excludeOpen, setExcludeOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    /**
     * 先同步后台记录，再给"全新空白安排"补默认时刻（第 53.3 节 U14）。
     *
     * 顺序很重要：`syncGroup` 会把同店同账号"上一次已完成配置"的时刻带进草稿
     * （第 31 节要求"再次安排沿用上次"）。若先补默认就会把复用结果当成空白安排覆盖掉。
     * `seedDefaultSchedule` 自己在草稿非空时不动作，因此复用路径不会被破坏。
     */
    void (async () => {
      await syncGroup();
      useShippingStore.getState().seedDefaultSchedule();
    })();
    // 状态区要显示"下一动作还有多久"，用本地心跳刷新即可（不改任何记录）
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [syncGroup]);

  const excludedIds = useMemo(() => parseExcludeIds(draft.excludeIds), [draft.excludeIds]);
  const startAt = taipeiLocalToEpoch(draft.startDate, draft.startTime);
  const restoreAt = taipeiLocalToEpoch(draft.restoreDate, draft.restoreTime);
  const dayOffset = startAt !== null && restoreAt !== null ? describeDayOffset({ startAt, restoreAt, spotDays: 1, regularDays: draft.regularDays }) : 0;
  const duration =
    startAt !== null && restoreAt !== null && restoreAt > startAt
      ? describeSpotDuration({ startAt, restoreAt, spotDays: 1, regularDays: draft.regularDays })
      : null;

  const draftError = useMemo(
    () =>
      validateGroupInput({
        schedule: {
          startAt: startAt ?? NaN,
          restoreAt: restoreAt ?? NaN,
          spotDays: SHIPPING_SPOT_DAYS,
          regularDays: Number(draft.regularDays),
        },
        config: { range: draft.range, excludeIds: draft.excludeIds, toggleLogistics: draft.toggleLogistics },
        // 归属在保存时由后台重新核实，这里不提前拦截（避免"看起来没登录"的误导）
        ownerShopId: 0,
        ownerUserId: 0,
        now,
      }),
    [startAt, restoreAt, draft.regularDays, draft.range, draft.excludeIds, draft.toggleLogistics, now],
  );

  const activeBlocking = !!group && group.phase !== 'done' && group.phase !== 'missed';
  const canSubmit = !draftError && !activeBlocking && !saving;

  const submit = async () => {
    const result = await saveGroup();
    if (result.success) setExcludeOpen(false);
  };

  return (
    <div className="min-w-0 space-y-3" data-shipping-panel="schedule">
      {/* 顶部状态区：有进行中的组就显示它，否则显示**上一次的真实终态**（第 37.5 节 R6） */}
      {group ? <GroupStatus group={group} /> : lastFinished ? <GroupStatus group={lastFinished} /> : null}

      <UsageNotice />

      {/* ===== 第一步：常规备货天数 ===== */}
      <Card>
        <CardHeader className="px-3 pb-2 pt-3">
          <CardTitle className="text-sm">
            <StepHeading n={1} title="设置常规备货天数" hint="恢复时，参与商品统一改为所选天数" />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 px-3 pb-3">
          <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="shipping-regular-days">
            备货天数
          </label>
          <select
            id="shipping-regular-days"
            value={String(draft.regularDays)}
            onChange={e => updateGroupDraft({ regularDays: Number(e.target.value) })}
            className="h-8 w-[120px] rounded-md border border-input bg-background px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {SHIPPING_REGULAR_DAY_OPTIONS.map(d => (
              <option key={d} value={d}>
                {d} 天
              </option>
            ))}
          </select>
          <p className="text-[11px] text-muted-foreground">支持 2–10 天；切现货固定为 1 天。</p>
          {!isValidRegularDays(draft.regularDays) && (
            <p className="text-[11px] text-destructive">常规备货天数必须是 2–10 之间的整数</p>
          )}
        </CardContent>
      </Card>

      {/* ===== 第二步：安排切换时间 ===== */}
      <Card>
        <CardHeader className="px-3 pb-2 pt-3">
          <CardTitle className="text-sm">
            <StepHeading n={2} title="安排切换时间" hint="日期和时间由你决定，支持跨天" />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 px-3 pb-3">
          <div className="rounded-md border-l-2 border-shopee-brand bg-shopee-brand-light px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-shopee-brand">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                切换为现货
              </span>
              <Badge variant="outline" className="h-4 px-1 text-[10px]">
                1 天
              </Badge>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <div>
                <label className="block text-[11px] text-muted-foreground" htmlFor="shipping-start-date">
                  开始日期
                </label>
                <Input
                  id="shipping-start-date"
                  type="date"
                  value={draft.startDate}
                  onChange={e => updateGroupDraft({ startDate: e.target.value })}
                  className="h-8 text-[12px]"
                />
              </div>
              <div>
                <label className="block text-[11px] text-muted-foreground" htmlFor="shipping-start-time">
                  开始时间
                </label>
                <Input
                  id="shipping-start-time"
                  type="time"
                  value={draft.startTime}
                  onChange={e => updateGroupDraft({ startTime: e.target.value })}
                  className="h-8 text-[12px]"
                />
              </div>
            </div>
            {/**
             * 开始时刻已过（第 53.3 节第 3 点）：只提示，不改默认值。
             * 判据集中在 `isStartTimePassed`，界面与测试共用一份，避免两处口径漂移。
             */}
            {isStartTimePassed(startAt, draft.startTime, now) && (
              <p className="mt-1.5 flex items-start gap-1 text-[11px] text-destructive">
                <TriangleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                开始时间已过（默认 23:30），请选择未来的日期或时间后再保存；系统不会自动改为明天，也不会补切现货。
              </p>
            )}
          </div>

          <div className="rounded-md border-l-2 border-shopee-blue bg-shopee-blue/5 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-shopee-blue">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                恢复常规备货
              </span>
              <Badge variant="outline" className="h-4 px-1 text-[10px]">
                {draft.regularDays} 天
              </Badge>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <div>
                <label className="block text-[11px] text-muted-foreground" htmlFor="shipping-restore-date">
                  恢复日期
                </label>
                <Input
                  id="shipping-restore-date"
                  type="date"
                  value={draft.restoreDate}
                  onChange={e => updateGroupDraft({ restoreDate: e.target.value })}
                  className="h-8 text-[12px]"
                />
              </div>
              <div>
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground" htmlFor="shipping-restore-time">
                  恢复时间
                  {dayOffset > 0 && startAt !== null && restoreAt !== null && (
                    <span className="rounded bg-shopee-blue/10 px-1 text-[10px] text-shopee-blue">
                      {dayOffset === 1 ? '次日' : `${dayOffset} 天后`}
                    </span>
                  )}
                </label>
                <Input
                  id="shipping-restore-time"
                  type="time"
                  value={draft.restoreTime}
                  onChange={e => updateGroupDraft({ restoreTime: e.target.value })}
                  className="h-8 text-[12px]"
                />
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2 rounded-md border px-2.5 py-2">
            <span className="text-[12px] font-medium">执行方式</span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-medium text-shopee-brand">单次执行</span>
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  固定
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                切到 1 天后按时恢复常规天数，完成这一组操作即结束，不会自动安排下一次。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ===== 第三步：确认本次安排 ===== */}
      <Card>
        <CardHeader className="px-3 pb-2 pt-3">
          <CardTitle className="text-sm">
            <StepHeading n={3} title="确认本次安排" hint="确认两次操作的日期、时间和恢复天数" />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 px-3 pb-3">
          <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-center">
            <p className="text-[12px] leading-relaxed">
              <strong className="text-shopee-brand">{formatTaipei(startAt)}</strong>，
              {draft.range === 'all' ? '范围内商品' : SHIPPING_RANGE_LABEL[draft.range as ShippingPlanRange] || '范围内商品'}切换为{' '}
              <strong>1 天</strong>
              {excludedIds.length > 0 && <span className="text-muted-foreground">（排除 {excludedIds.length} 个）</span>}
            </p>
            <div className="text-muted-foreground" aria-hidden="true">
              ↓
            </div>
            <p className="text-[12px] leading-relaxed">
              <strong className="text-shopee-blue">
                {dayOffset > 0 ? `${dayOffset === 1 ? '次日' : `${dayOffset} 天后`} ` : ''}
                {formatTaipei(restoreAt)}
              </strong>
              ，恢复为 <strong>{draft.regularDays} 天</strong>
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {duration ? `现货时段 ${duration} · ` : ''}台湾时间（Asia/Taipei）
            </p>
          </div>

          <div className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2">
            <div className="min-w-0">
              <div className="text-[12px] font-medium">排除商品</div>
              <p className="text-[11px] text-muted-foreground">
                {excludedIds.length === 0 ? '尚未排除商品' : `已排除 ${excludedIds.length} 个商品`}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-[11px]"
              onClick={() => setExcludeOpen(true)}
            >
              设定排除商品
            </Button>
          </div>

          <div className="space-y-1.5">
            <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="shipping-group-range">
              修改范围
            </label>
            <div className="flex flex-wrap gap-1.5">
              {(['all', 'online', 'offline'] as ShippingPlanRange[]).map(range => (
                <Button
                  key={range}
                  variant={draft.range === range ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-[11px]"
                  onClick={() => updateGroupDraft({ range })}
                >
                  {SHIPPING_RANGE_LABEL[range]}
                </Button>
              ))}
            </div>
          </div>

          <label className="flex items-center gap-1.5 text-[12px]">
            <input
              type="checkbox"
              checked={draft.toggleLogistics}
              onChange={e => updateGroupDraft({ toggleLogistics: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            自动管理店铺物流（默认关闭）
          </label>
          <p className="text-[11px] text-muted-foreground">
            修改前保存渠道状态，完成本次修改后立刻恢复本次影响的渠道；两次修改之间不会一直关闭物流。
          </p>
          {draft.toggleLogistics && (
            <p className="flex items-start gap-1 text-[11px] text-amber-800">
              <Truck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              关闭物流期间，买家无法使用这些渠道下单。
            </p>
          )}

          {activeBlocking && (
            <p className="text-[11px] text-destructive">
              已有一组安排在进行中（{SHIPPING_GROUP_PHASE_LABEL[group!.phase]}），请先等它结束或撤销后再保存新的。
            </p>
          )}
          {!activeBlocking && draftError && <p className="text-[11px] text-destructive">{draftError}</p>}
          {notice && !error && <p className="text-[11px] text-shopee-green">{notice}</p>}
          {error && <p className="text-[11px] text-destructive break-all">{error}</p>}

          <Button
            size="sm"
            className="h-9 w-full text-[12px]"
            onClick={() => void submit()}
            disabled={!canSubmit}
          >
            {saving ? '保存中…' : '确认并安排任务'}
          </Button>
        </CardContent>
      </Card>

      {/* 停止／撤销入口：未开始是撤销（零写），已开始是停止（保留义务） */}
      {group && (group.phase === 'scheduled' || group.phase === 'cutting' || group.phase === 'awaiting-restore') && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full text-[11px]"
          onClick={() => void (group.phase === 'scheduled' ? revokeGroup() : stopGroup())}
        >
          <Undo2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {group.phase === 'scheduled' ? '撤销本次安排' : '停止后续切现货（仍需恢复常规天数）'}
        </Button>
      )}

      {lastFinished && !activeBlocking && (lastFinished.phase === 'done' || lastFinished.phase === 'missed') && (
        <Button variant="outline" size="sm" className="h-8 w-full text-[11px]" onClick={() => reuseLastGroup()}>
          <PackageSearch className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          再次安排（带出上次配置，需重新选日期）
        </Button>
      )}

      <ShippingExcludeModal
        open={excludeOpen}
        onClose={() => setExcludeOpen(false)}
        confirming={excludedIds}
        onConfirm={ids => {
          updateGroupDraft({ excludeIds: excludeIdsToText(ids) });
          setExcludeOpen(false);
        }}
      />
    </div>
  );
}
