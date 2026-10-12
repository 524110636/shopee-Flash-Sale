/**
 * 首页任务摘要：由真实任务状态派生展示文案与直达入口标识。
 *
 * 纯函数、不依赖浏览器 API，便于用虚构数据回归。
 * 注意：自动页签选中（autoModeActive）不是运行状态，这里只看 isRunning。
 */

export type TaskSummaryKind = 'loading' | 'auto' | 'manual' | 'scheduled' | 'copy-completed';

export interface TaskSummary {
  kind: TaskSummaryKind;
  title: string;
  detail: string;
  /** 查看入口文案；为空表示无可点击入口（加载态） */
  actionLabel: string;
  tone: 'loading' | 'running' | 'pending' | 'done';
}

export interface TaskSummaryInput {
  /** 任务状态是否已恢复完成；未完成时显示加载态，不能谎称空闲 */
  statusReady: boolean;
  /** autoModeStatus.isRunning */
  autoModeRunning: boolean;
  autoModeRound?: number;
  autoModePhase?: string;
  /** 手动开启限时特卖进行中 */
  isEnabling?: boolean;
  enableRound?: number;
  enableMaxRounds?: number;
  /** 定时复制（创建新活动）待执行；来自 `_scheduledCopy` */
  scheduledCopyExists?: boolean;
  /** 定时复制目标时间（秒） */
  scheduledCopyTargetTime?: number;
  /** 定时加入待执行；来自 `_scheduledEnable` / `_wizardFlowParams` */
  scheduledEnableExists?: boolean;
  /** 定时加入目标时间（秒） */
  scheduledEnableTargetTime?: number;
  copyCompleted?: boolean;
  copyCompletedName?: string;
}

const AUTO_PHASE_LABELS: Record<string, string> = {
  waiting_create: '等待申报时间',
  creating: '正在创建活动',
  waiting_enable: '等待传递商品',
  enabling: '正在传递商品参数',
};

const VIEW_TASK_LABEL = '查看任务';

/** 秒钟级时间戳格式化为 MM/DD HH:mm */
export function formatTaskTime(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

export function buildTaskSummaries(input: TaskSummaryInput): TaskSummary[] {
  if (!input.statusReady) {
    return [{ kind: 'loading', title: '正在读取任务状态…', detail: '', actionLabel: '', tone: 'loading' }];
  }

  const summaries: TaskSummary[] = [];

  if (input.autoModeRunning) {
    const phase = input.autoModePhase ? AUTO_PHASE_LABELS[input.autoModePhase] : undefined;
    summaries.push({
      kind: 'auto',
      title: '自动模式运行中',
      detail: [typeof input.autoModeRound === 'number' ? `第 ${input.autoModeRound} 轮` : '', phase || '']
        .filter(Boolean)
        .join(' · '),
      actionLabel: VIEW_TASK_LABEL,
      tone: 'running',
    });
  }

  if (input.isEnabling) {
    const rounds =
      typeof input.enableRound === 'number' && typeof input.enableMaxRounds === 'number'
        ? `第 ${input.enableRound}/${input.enableMaxRounds} 轮`
        : '';
    summaries.push({
      kind: 'manual',
      title: '手动开启限时特卖进行中',
      detail: rounds,
      actionLabel: VIEW_TASK_LABEL,
      tone: 'running',
    });
  }

  if (input.scheduledCopyExists) {
    summaries.push({
      kind: 'scheduled',
      title: '定时复制待执行',
      detail:
        typeof input.scheduledCopyTargetTime === 'number' ? `目标 ${formatTaskTime(input.scheduledCopyTargetTime)}` : '',
      actionLabel: VIEW_TASK_LABEL,
      tone: 'pending',
    });
  }

  if (input.scheduledEnableExists) {
    summaries.push({
      kind: 'scheduled',
      title: '定时加入待执行',
      detail:
        typeof input.scheduledEnableTargetTime === 'number' ? `目标 ${formatTaskTime(input.scheduledEnableTargetTime)}` : '',
      actionLabel: VIEW_TASK_LABEL,
      tone: 'pending',
    });
  }

  if (input.copyCompleted) {
    summaries.push({
      kind: 'copy-completed',
      title: '复制完成，可查看新活动',
      detail: input.copyCompletedName ? `来自 ${input.copyCompletedName}` : '',
      actionLabel: '去查看',
      tone: 'done',
    });
  }

  return summaries;
}
