/**
 * 「商品备货与物流」功能页。
 *
 * 第 53.4 节 U15：主路径只有一条 —— 定时把参与商品切到 1 天、到点恢复常规备货
 * （`ShippingSchedulePanel`）。原来的「立即修改」页签（任意 1–10 天单向修改）已移除。
 *
 * 与特卖工作页的分工：本组件只做「保存设置／发动作／读后台记录」，
 * 不自己发任何虾皮请求、不自己算过滤规则（那些在 features/shipping 里）。
 * 这样后台 runner 与调度共用同一份规则，界面不成为第二套实现。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CalendarClock, Truck, TriangleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import { useShippingStore } from '@/features/shipping/store';
import { SHIPPING_ITEM_STATUS_LABEL, countShippingItems } from '@/features/shipping/task';
import { needsLogisticsAction } from '@/features/shipping/runner';
import { taipeiDateString, taipeiTimeString, meaningfulPlans } from '@/features/shipping/rules';
import {
  SHIPPING_RANGE_LABEL,
  type ShippingPlan,
  type ShippingTask,
} from '@/features/shipping/types';
import { planNeedsAttention } from '@/features/shipping/scheduler';
import { ShippingSchedulePanel } from './ShippingSchedulePanel';

const PLAN_SLOT_LABEL: Record<string, string> = { plan1: '计划 1', plan2: '计划 2' };

function toneOf(status: string) {
  if (status === 'success') return 'bg-shopee-green';
  if (status === 'failed') return 'bg-destructive';
  if (status === 'skipped') return 'bg-muted-foreground';
  return 'bg-shopee-blue';
}

/** 任务结果面板：按最终状态归类，带可复制 ID 与原因 */
function TaskResultPanel({ task }: { task: ShippingTask }) {
  const counts = countShippingItems(task.items);
  const pendingChannels = task.logistics.records.filter(
    r => r.originallyEnabled && r.closed === 'success' && r.restored !== 'success',
  );
  const [copied, setCopied] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {task.status === 'running' ? (
            <LoaderCircle className="h-4 w-4 animate-spin text-shopee-brand" aria-hidden='true' />
          ) : task.status === 'completed' ? (
            <CircleCheck className="h-4 w-4 text-shopee-green" aria-hidden='true' />
          ) : (
            <TriangleAlert className="h-4 w-4 text-destructive" aria-hidden='true' />
          )}
          运行结果
          <span className="text-[11px] font-normal text-muted-foreground">
            {task.days === 1 ? '现货 1 天' : `预售 ${task.days} 天`} · {SHIPPING_RANGE_LABEL[task.range]}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">成功 {counts.success}</Badge>
          <Badge variant="secondary">失败 {counts.failed}</Badge>
          <Badge variant="secondary">跳过 {counts.skipped}</Badge>
          <Badge variant="secondary">待核对 {counts.unknown}</Badge>
          <Badge variant="secondary">未执行 {counts.pending}</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">{task.message}</p>
        {task.error && <p className="text-[11px] text-destructive break-all">{task.error}</p>}

        {task.logistics.requested && (
          <div className="rounded border px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <Truck className="h-3.5 w-3.5" aria-hidden='true' />
              物流渠道
            </div>
            {task.logistics.records.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">尚未读取渠道</p>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {task.logistics.records.map(r => (
                  <li key={r.channelId} className="flex items-center justify-between gap-2 text-[11px]">
                    <span>渠道 {r.channelId}</span>
                    <span className="text-muted-foreground">
                      原来{r.originallyEnabled ? '启用' : '关闭'} · 关闭{r.closed} · 恢复{r.restored}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {pendingChannels.length > 0 && (
          <div className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
            原店铺物流待恢复：渠道 {pendingChannels.map(c => c.channelId).join('、')}。
            请登录原店铺后点「恢复物流」。原先关闭的渠道不会被打开。
          </div>
        )}

        {task.items.length > 0 && (
          <details>
            <summary className="cursor-pointer text-[11px] text-muted-foreground">
              逐商品结果（{task.items.length}）
            </summary>
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
              {task.items.map(item => (
                <li key={item.itemId} className="flex items-start gap-1.5 text-[11px]">
                  <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${toneOf(item.status)}`} />
                  <span className="min-w-0 flex-1 break-all">
                    <span className="font-mono">{item.itemId}</span> {SHIPPING_ITEM_STATUS_LABEL[item.status]}
                    {item.reason ? ` — ${item.reason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        {task.items.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={async () => {
              await navigator.clipboard.writeText(task.items.map(i => i.itemId).join('\n')).catch(() => {});
              setCopied(true);
            }}
          >
            {copied ? '已复制 ID' : '复制全部商品 ID'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 旧的单次计划：**只读历史**，不提供新建／编辑／启用／保存。
 *
 * 第 56.3 节返工：早先这里是一个可编辑表单（启用勾选、日期、时刻、天数、排除、保存），
 * 普通用户在**全新页面上**就能把 `enabled` 置真并保存一条未来单向 1 天任务 ——
 * 它绕过"切到 1 天后必须有恢复安排"这条唯一主路径，也让界面继续堆着旧表单
 * （验收实际 DOM 保存后得到 `enabled:true, days:1, retired:false` 并写了 `_shippingPlans`）。
 *
 * 为什么保留展示：记录仍要可追溯。用户需要看到"以前有这么一条计划、它现在停了、原因是什么"，
 * 直接藏起来会让人以为安排凭空消失。所以这里只**读**计划记录并展示状态。
 *
 * 为什么还留一个「停用」：界面下线后，**已经存在**的启用中的单向计划仍会被后台调度执行
 * （`readShippingPlans` 只降级旧的每日重复，不碰一次性计划）。
 * 用户如果以前存过这样一条，他在界面上既看不到编辑表单、也没有任何办法把它关掉 ——
 * 这正是第 56.4 节同类缺口（出口被一起删掉）。这里只提供"关掉"，不能新建、不能改期、不能启用，
 * 复用既有 `removePlan`（置 `enabled:false` 并让后台重建 alarm），不新增能力。
 */
function PlanHistoryItem({ plan, attention }: { plan: ShippingPlan; attention: string | null }) {
  const removePlan = useShippingStore(s => s.removePlan);
  const lastRun = plan.lastRunAt
    ? `${taipeiDateString(plan.lastRunAt)} ${taipeiTimeString(plan.lastRunAt)}`
    : '尚未执行';
  const stillEnabled = plan.enabled && !plan.retired;
  return (
    <div className="space-y-0.5 rounded border bg-muted/30 p-2 text-[11px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{PLAN_SLOT_LABEL[plan.id] || plan.id}</span>
        {/* 如实反映记录本身的状态，不笼统写"已停用" */}
        <span className="text-muted-foreground">{stillEnabled ? '启用中（旧版遗留）' : '已停用（只读）'}</span>
      </div>
      <p className="text-muted-foreground">
        {plan.retired
          ? plan.retiredReason || '旧的每日／每周重复已停用，请重新确认一次单次日期。'
          : '旧版单次计划入口已下线，请用上方「定时切换」安排。'}
      </p>
      <p className="text-muted-foreground">
        上次：{lastRun} · 结果 {plan.lastResult ?? '—'}
        {plan.missed ? ' · 已错过（不补写）' : ''}
      </p>
      {stillEnabled && (
        <div className="space-y-1">
          <p className="text-amber-800">
            这条旧计划仍在启用中，到点仍会发出单向修改（没有配对的恢复安排）。
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => void removePlan(plan.id)}
          >
            停用这条旧计划
          </Button>
        </div>
      )}
      {attention && <p className="text-amber-700">需处理：{attention}</p>}
    </div>
  );
}

export function ShippingWorkPage({ ownerShopId, ownerUserId }: { ownerShopId?: number | null; ownerUserId?: number | null } = {}) {
  const plans = useShippingStore(s => s.plans);
  /**
   * 界面只展示**真的承载过用户数据**的旧计划（第 59.2 节）。
   *
   * 为什么还要再过滤一次：`plans` 是 store 的完整列表，可能包含两张空白默认槽位
   * （后台的默认配置、或旧版本遗留的键内容）。判据集中在 `meaningfulPlans`，
   * 避免"加载路径改了、渲染判定没改"或反过来造成两处口径不一致。
   */
  const historyPlans = useMemo(() => meaningfulPlans(plans), [plans]);
  const task = useShippingStore(s => s.task);
  const loadFromStorage = useShippingStore(s => s.loadFromStorage);
  const restoreLogistics = useShippingStore(s => s.restoreLogistics);
  const acknowledgeInterrupted = useShippingStore(s => s.acknowledgeInterrupted);
  const stopTask = useShippingStore(s => s.stopTask);
  const setOwner = useShippingStore(s => s.setOwner);

  useEffect(() => {
    void loadFromStorage();
    const onChange = (changes: Record<string, any>, area: string) => {
      if (area !== 'local') return;
      // 任务记录变化 → 同步；计划记录变化 → 同步（否则后台回写的真实终态看不到，R5）
      if (changes._shippingTask) void useShippingStore.getState().syncTask();
      if (changes._shippingPlans) void useShippingStore.getState().syncPlans();
      /**
       * 单次组记录变化 → 同步（第 34.7 节 R6）。
       *
       * 少了这一条，页面会一直停在挂载时读到的阶段：后台已经 `awaiting-restore`／`done`，
       * 顶部仍显示"待开始"，用户必须切页或重开弹窗才能看到真实进度（验收就复现了这个）。
       */
      if (changes._shippingGroups) void useShippingStore.getState().syncGroup();
    };
    browser.storage.onChanged.addListener(onChange);
    return () => browser.storage.onChanged.removeListener(onChange);
  }, [loadFromStorage]);

  // 把外壳已核实的店铺／账号归属交给本页，保存计划时要写进计划（R3）
  useEffect(() => {
    if (ownerShopId !== undefined || ownerUserId !== undefined) {
      setOwner(ownerShopId ?? null, ownerUserId ?? null);
    }
  }, [ownerShopId, ownerUserId, setOwner]);

  /**
   * 预览已失效／预览内容已变的判断随「立即修改」入口一起下线（第 53.4 节 U15）。
   *
   * 那不表示后台放松了保护：`startTask`／`handleShippingStart` 仍会重新核实归属，
   * 并按确认快照比对内容差异后拒绝。这里移除的只是"单向修改"的前置提示 UI。
   */

  // 进入本页时核实一次归属：保存计划时会再核实一次（R3）
  useEffect(() => {
    void useShippingStore.getState().refreshOwner();
  }, []);

  const running = task?.status === 'running';
  const pendingLogisticsRestore = (task?.logistics.records ?? []).some(r => needsLogisticsAction(r));
  /**
   * 计划的"需处理"提示：只由**本功能自己的状态**决定（待恢复物流／上轮因冲突等待）。
   * 不在这里传特卖占用等外部信息 —— 那些在真正到点启动时由后台重新判定，
   * 界面上谎报"现在就能跑"或"现在不能跑"都会误导用户。
   */
  const planAttention = useMemo(
    () =>
      historyPlans.map(plan =>
        planNeedsAttention(plan, {
          shippingTaskActive: running,
          otherWriteConflict: null,
          pendingLogisticsRestore,
          identityOk: true,
        }),
      ),
    [historyPlans, running, pendingLogisticsRestore],
  );

  return (
    <div className="space-y-3 p-4">
      {/*
        第 53.4 节 U15：取消「立即修改」页签。
        主路径只剩"切到 1 天 → 恢复常规备货"这一条单次成对安排，
        所以不再保留只有一个选项的模式页签条，直接把安排面板铺在页面上。
        共用能力（handleShippingStart／runner／API／历史 settings／task／plan）都保留，
        只是不再从本页新建单向修改任务。需要尽快开始时，把开始时间设成当前时间后几分钟即可。
      */}
      <ShippingSchedulePanel />

      {/*
        下面两块原先在「立即修改」分支里，随页签一起被藏起来就会让已发生的任务与
        待恢复的物流义务变得不可见、无人处理（第 53.4 节明确要求迁出）。
        因此改成**按条件**出现在同一页：没有异常时不会铺一堆旧表单在主流程上。
      */}
      {task && <TaskResultPanel task={task} />}

          {/*
            第 56.4 节：补回**无 group 的历史运行任务**的停止出口。
            删掉旧编辑区时连停止按钮一起删了，于是 `source: manual`／`plan`、
            `status: running` 且没有配对的组的任务，用户能看结果却停不下来。
            成对任务的停止走组自己的规则（`stopGroup`，含"保留恢复义务"语义），
            所以这里用 `groupId` 明确排除，避免旧停止按钮误停配对流程。
          */}
          {task && task.status === 'running' && !task.groupId && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => void stopTask()}
            >
              停止更新（不再发出后续商品写请求）
            </Button>
          )}

      {/* 中断后的出口：结果已留在上面，处理完必要事项后可结束本轮（R6） */}
      {task?.status === 'interrupted' && (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-2">
          <p className="text-[11px] text-amber-900">
            上一轮被中断，结果可能不完整。请核对上方逐商品状态；
            <span className="font-medium">未确认的商品不会被自动重放</span>。
            {pendingLogisticsRestore ? ' 先点「恢复物流」处理物流义务。' : ''}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => void acknowledgeInterrupted()}
            disabled={pendingLogisticsRestore}
          >
            已核对结果，结束本轮
          </Button>
          {pendingLogisticsRestore && (
            <p className="text-[11px] text-amber-800">待恢复物流未处理完前，不能开始新一批。</p>
          )}
        </div>
      )}

      {task && task.logistics.records.some(r => needsLogisticsAction(r)) && (
        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => void restoreLogistics()}>
          恢复物流（需先登录原店铺）
        </Button>
      )}

      {/*
        旧计划改为只读历史（第 56.3 节）：**没有真实记录就不渲染这一块**。
        早先无条件渲染两个空槽位，普通新用户会看到一个可以填日期／天数并保存的表单，
        而那正好绕过"切到 1 天后必须有恢复安排"的唯一主路径。

        第 59.2 节：`plans.length > 0` 不够 —— 加载兜底给的两张空白占位也满足它，
        新用户会看到两条"未绑定，请重新保存"的**不存在**记录。改用 `historyPlans`
        （只含真的配置过／跑过／迁移过／仍启用的记录），空占位不再冒充历史。
      */}
      {historyPlans.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarClock className="h-4 w-4 text-shopee-brand" aria-hidden='true' />
              旧版计划记录（只读）
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              旧的定时计划入口已下线，请用上方「定时切换」安排单次执行（可指定开始与恢复时间）。
              这里只展示历史记录，不能新建或修改；旧记录保持停用，不删除。
            </p>
            {historyPlans.map((plan, index) => (
              <PlanHistoryItem key={plan.id} plan={plan} attention={planAttention[index]} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default ShippingWorkPage;