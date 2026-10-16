/**
 * 单次成对安排的**事务性推进**（任务书第 31 节 31.5／31.6）。
 *
 * 为什么不把这段写进 `background.ts` 的 alarm 回调：
 * "读记录 → 认领阶段 → 落盘 → 重新预检 → 启动任务 → 等真实结果回写阶段"
 * 是**可单测的一段流程**，而 alarm 回调需要真浏览器才能触发。
 * 这里只依赖注入的 deps（读写记录、核验、启动任务），因此能在隔离环境与单测里
 * 用可控时钟覆盖"窗口边界／错过／跨午夜／重复认领／恢复对象"。
 *
 * 关键红线：
 * - 阶段推进**只由真实落盘结果驱动**，不靠内存计时器；
 * - 认领与写前检查点都必须真正落盘成功，保存失败就停；
 * - 恢复对象只用"本轮已确认达到 1 天"的集合，不扩大、不猜测；
 * - 已有运行／待恢复／结果未知时，不允许新安排绕过互斥。
 */

import {
  advanceGroupPhase,
  claimGroupStage,
  confirmedSpotIdsAfterCut,
  decideGroupAction,
  groupIsComplete,
  itemOutcomesFromTask,
  mergeGroupItems,
  pendingIdsAfterRestore,
  releaseStageClaim,
  restoreItemIds,
  SHIPPING_SPOT_DAYS,
  spotWindowDeadline,
} from './group-rules';
import { modeForDays } from './rules';
import { redactSensitiveText } from './api';
import type {
  ShippingGroup,
  ShippingGroupsRecord,
  ShippingItemResult,
  ShippingSettings,
  ShippingTargetItem,
  ShippingTask,
} from './types';

/** 组的推进依赖：把"读写组记录"和"启动一次任务"注入进来，便于单测。 */
export interface ShippingGroupDeps {
  /** 读取组记录（事实来源；读失败必须抛错，不能当成"没有组"） */
  loadGroups: () => Promise<ShippingGroupsRecord>;
  /** 持久保存组记录；**必须真正落盘**，失败要抛错 */
  saveGroups: (record: ShippingGroupsRecord) => Promise<void>;
  /** 重新预检一轮，返回目标商品（不写任何东西） */
  preview: (settings: ShippingSettings) => Promise<{
    ok: boolean;
    error?: string;
    shopId: number | null;
    items: ShippingTargetItem[];
  }>;
  /** 启动一段任务；返回是否被接受 */
  startTask: (input: {
    group: ShippingGroup;
    phase: 'spot' | 'restore';
    items: ShippingTargetItem[];
    settings: ShippingSettings;
  }) => Promise<{ success: boolean; error?: string; taskId?: string }>;
  /** 当前本功能是否有任务在跑 */
  isTaskActive: () => Promise<boolean>;
  /** 当前店铺与账号是否可用（核实失败返回 false，不抛） */
  isIdentityOk: () => Promise<boolean>;
  /**
   * 当前实际核实到的店铺与后端账号。
   *
   * 为什么与 `isIdentityOk` 分开：`isIdentityOk` 只回答"能不能读到身份"，
   * 而组必须确认"读到的**就是本组那一份**"。换店／换账号后若只在启动时被拒绝，
   * 组会被标成 `needs-attention`（永久"需处理"），而正确语义是**等待**用户切回来
   * （31.6 规则 6：换店／账号改变时保留义务，不丢、也不误报需人工处理）。
   */
  currentOwnership?: () => Promise<{ shopId: number | null; userId: number | null }>;
  /** 同店铺其它写任务的冲突原因；无冲突返回 null */
  findOtherWriteConflict: () => Promise<string | null>;
  /** 读取当前本功能的任务记录（接回被中断的组时用，第 34.4 节 R3） */
  loadTask?: () => Promise<ShippingTask | null>;
  /**
   * 仍待恢复的原启用渠道（无则返回 null）。
   *
   * 为什么恢复阶段也需要它：商品可能已经全部恢复，但**物流还关着**。
   * 此时若只按"商品都好了"就把整组结束，就违背了 31.6 规则 7 的
   * "物流收尾也算本组义务" —— 用户店铺会留在少一个渠道的状态。
   */
  pendingLogistics?: () => Promise<string | null>;
  /** 最小脱敏诊断（第 37.1 节：R3 修复前先补捕获） */
  recordDiagnostic?: (entry: {
    stage: string;
    groupId?: string;
    taskId?: string;
    groupPhase?: string;
    detail: string;
  }) => Promise<void>;
  now: () => number;
  /** 脱敏日志 */
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/** 组推进的结果，供调用方决定是否要重建 alarm / 提示界面。 */
export interface ShippingGroupTickResult {
  action:
    | 'idle'
    | 'wait'
    | 'mark-missed'
    | 'started-spot'
    | 'started-restore'
    | 'needs-attention'
    | 'done'
    | 'save-failed';
  /** 被拒绝／等待的可读原因 */
  reason?: string;
  groupId?: string;
}

function activeGroup(record: ShippingGroupsRecord): ShippingGroup | null {
  return record.active;
}

/**
 * 商品写检查点的步骤名集合。
 *
 * 为什么必须靠步骤名过滤：渠道关闭／恢复的检查点也带 `writeSent` 与 `target`，
 * 但那里的 `target` 是**渠道号**；不分青红皂白地收进来，
 * 会把渠道 ID 当成商品 ID 去回读，得到一个永远核实不了、也永远恢复不了的假商品。
 */
const SPOT_WRITE_STEPS = new Set(['update-product-batch', 'batch', 'write-batch']);

/**
 * 把一次任务结果并入组记录，并推进阶段。
 *
 * 只有**真实终态**才能推进（31.6 规则 7）：迟到的旧回调用旧 `groupId`／已完成阶段判断，
 * 不能回退已经完成的阶段。
 */
export function applyTaskResultToGroup(
  group: ShippingGroup,
  phase: 'spot' | 'restore',
  task: {
    status: string;
    items: ShippingItemResult[];
    /** 本阶段任务结束时的物流收尾是否完成（第 34.6 节 R5：整组完成需要物流证据） */
    logisticsSettled?: boolean;
    /** 仍未收尾的渠道数（用于说明为什么不能报完成） */
    pendingChannels?: number;
  },
  now: number,
  originallyAtOneDay: string[] = [],
): ShippingGroup {
  const outcomes = mergeGroupItems(group.items, itemOutcomesFromTask(phase, task.items));

  if (phase === 'spot') {
    const confirmed = confirmedSpotIdsAfterCut(outcomes, originallyAtOneDay);
    // 任务被中断／异常：保留已发出请求的义务，标为需处理，不自动重放
    const interrupted = task.status === 'interrupted';
    const failed = task.status === 'failed';
    if (interrupted || failed) {
      const reason = interrupted
        ? '切现货阶段被中断，已发出请求的结果不明，需先核实后再恢复'
        : '切现货阶段失败，请查看结果';
      return (
        advanceGroupPhase(group, 'needs-attention', now, {
          items: outcomes,
          confirmedSpotItemIds: confirmed,
          pendingItemIds: outcomes.filter(i => i.spot === 'unknown').map(i => i.itemId),
          message: reason,
          error: reason,
        }) ?? group
      );
    }
    if (confirmed.length === 0) {
      // 没有任何商品确认切到 1 天：没有恢复义务，整组直接结束
      return (
        advanceGroupPhase(group, 'done', now, {
          items: outcomes,
          confirmedSpotItemIds: [],
          pendingItemIds: [],
          message: '本次没有商品需要恢复（切现货阶段未产生可恢复项）',
          finishedAt: now,
        }) ?? group
      );
    }
    return (
      advanceGroupPhase(group, 'awaiting-restore', now, {
        items: outcomes,
        confirmedSpotItemIds: confirmed,
        pendingItemIds: [],
        message: `已切现货 ${confirmed.length} 个商品，等待恢复`,
      }) ?? group
    );
  }

  // ===== 恢复阶段 =====
  /**
   * **只就"真正需要恢复的商品"判定完成**（第 37.2 节 R5）。
   *
   * 早先对**全部** outcomes 调用 `groupIsComplete`，于是首阶段明确失败的商品
   * （它从未参与恢复、也不该被恢复）会被算成"未确认恢复"，组于是永远停在需处理，
   * 且提示里出现"有 0 个商品未确认"这种自相矛盾的话。
   *
   * 正确的义务集合以 `confirmedSpotItemIds` 为准（它已被严格筛选过）。
   * 明细里写着 `pending` **不能**当作"没有义务"：从检查点接回来的组，
   * 商品结论正是 `pending`（请求已发出、响应还没回来）。
   * 其它项（首阶段失败／从未发送）保留自己的明细，但不产生恢复义务。
   */
  const owingIds = new Set(group.confirmedSpotItemIds);
  const owingOutcomes = outcomes.filter(i => owingIds.has(i.itemId));
  const pending = pendingIdsAfterRestore(owingOutcomes);
  /**
   * 有义务但**连明细都没有**的项（第 37.2 节 R3 收敛）。
   *
   * 从检查点接回的组可能只记得"这些商品发过请求"，却没有逐项记录。
   * 这种项不能因为"没记录"就被当成"不用恢复"，必须计入待处理。
   */
  const owingWithoutOutcome = [...owingIds].filter(id => !outcomes.some(i => i.itemId === id));
  pending.push(...owingWithoutOutcome);
  /**
   * 整组完成的**两个必要条件**（第 34.6 节 R5）：
   * 1) 所有**应恢复**商品都已确认达到目标（`success`，或 `skipped` 且有回读确认）；
   * 2) 本阶段物流收尾已完成 —— 商品成功但渠道恢复失败时，组不能报完成。
   */
  const itemsDone =
    pending.length > 0
      ? false
      : owingOutcomes.length > 0
        ? groupIsComplete(owingOutcomes)
        : owingIds.size === 0;
  const logisticsDone = task.logisticsSettled !== false;
  /** 任务是否仍在跑（在跑时不得判定完成；终态是 completed／stopped／interrupted／failed） */
  const taskRunning = task.status === 'running';
  /**
   * 完成判定按**是否还有未了义务**，而不是按任务的历史终态字符串。
   *
   * 为什么不能只看 `completed`／`stopped`：物流恢复失败会把任务落成 `failed`，
   * 用户随后点「恢复物流」把它修好时，那条记录**仍然是 `failed`**（那是历史事实，不会改写）。
   * 早先据此判定，于是"商品已恢复、渠道已恢复"却因为一个过期的失败状态永远结不了案，
   * 组卡在需处理、不能再次安排（验收实测）。
   * 真正的判据是：应恢复的商品都确认到了目标、物流已收尾、且任务不在运行中。
   */
  const nothingOutstanding = itemsDone && logisticsDone && !taskRunning;

  if (nothingOutstanding) {
    return (
      advanceGroupPhase(group, 'done', now, {
        items: outcomes,
        pendingItemIds: [],
        message: '商品已恢复常规备货，物流收尾已完成，这一组结束',
        error: null,
        finishedAt: now,
      }) ?? group
    );
  }

  if (!logisticsDone) {
    const reason = `有 ${task.pendingChannels ?? 0} 个渠道尚未确认恢复，本组不能报完成，请先恢复物流`;
    return (
      advanceGroupPhase(group, 'needs-attention', now, {
        items: outcomes,
        pendingItemIds: pending,
        message: reason,
        error: reason,
      }) ?? group
    );
  }

  if (task.status === 'interrupted' || task.status === 'failed') {
    const reason =
      task.status === 'interrupted'
        ? '恢复阶段被中断，结果不明，需先核实实际备货天数'
        : '恢复阶段失败，请查看结果后再处理';
    return (
      advanceGroupPhase(group, 'needs-attention', now, {
        items: outcomes,
        pendingItemIds: pending,
        message: reason,
        error: reason,
      }) ?? group
    );
  }

  if (!itemsDone) {
    const reason = `有 ${pending.length} 个商品未确认恢复到常规天数，需你确认后再处理`;
    return (
      advanceGroupPhase(group, 'needs-attention', now, {
        items: outcomes,
        pendingItemIds: pending,
        message: reason,
        error: reason,
      }) ?? group
    );
  }

  return (
    advanceGroupPhase(group, 'needs-attention', now, {
      items: outcomes,
      pendingItemIds: pending,
      message: '恢复阶段未得到明确结论，需你确认后再处理',
      error: '恢复结果未确认',
    }) ?? group
  );
}

/**
 * 从**关联任务的权威记录**把组接回可推进状态（第 34.4 节 R3，收敛于第 37.2 节）。
 *
 * 为什么必须有这一步：设备／浏览器在商品请求进行中退出时，组停在 `cutting`（或 `restoring`），
 * 关联任务已被 `reconcileOrphanShippingTask` 标成 `interrupted`。
 * 早先的实现把这种情况直接标成"需处理"就结束了，于是**没有任何路径继续核实**，
 * 商品可能停在 1 天没人恢复（第 36 节反复复现的就是这一条）。
 *
 * 收敛后的原则：**接回到"还能自己继续走"的阶段，把核实交给既有的写前核实**，
 * 而不是要求用户手工重建一组：
 * - 用持久 `groupPhase` 判定这是哪一段（**不能用 `task.phase`**：终态通常是 interrupted／failed，
 *   拿它区分 spot／restore 会判错，第 36.2 节第 2 条就是这个错）；
 * - 待核实集合只从 **update-product 类检查点**取（渠道检查点的 target 是渠道号，不能当商品）；
 * - `task.items` 为空也照样核实 —— "已发但没回" 正是最需要回读的情形；
 * - 切现货段：未发过写 → 标已错过；发过 → 进 `awaiting-restore` 并把它们计入恢复义务（到点后核实再恢复）；
 * - 恢复段：回到 `awaiting-restore` 并**释放恢复阶段的认领**，让补检能重新认领并逐项核实
 *   （仍 1 天 → 恢复；已是目标 → 记完成；冲突／读不到 → 留明确待处理）。
 */
export function reattachGroupFromTask(
  group: ShippingGroup,
  task: {
    taskId: string;
    status: string;
    phase: string;
    items: ShippingTask['items'];
    checkpoints: ShippingTask['checkpoints'];
    groupId?: string;
    groupPhase?: 'spot' | 'restore';
  },
  now: number,
): ShippingGroup {
  /**
   * 本段归属：优先用**持久**的 `groupPhase`／组的阶段，`task.phase` 只作为最后的兜底。
   * （`task.phase` 在中断后通常是 `interrupted`／`failed`，用它判段位会张冠李戴。）
   */
  const stage: 'spot' | 'restore' =
    task.groupPhase === 'restore' || group.phase === 'restoring'
      ? 'restore'
      : task.groupPhase === 'spot' || group.phase === 'cutting'
        ? 'spot'
        : task.phase === 'restoring'
          ? 'restore'
          : 'spot';

  const outcomes = mergeGroupItems(group.items, itemOutcomesFromTask(stage, task.items));

  /**
   * 只从**商品写检查点**取"已发出但未定案"的商品。
   *
   * 为什么必须过滤：渠道关闭／恢复的检查点也带 `writeSent` 与 `target`，
   * 但那里的 `target` 是**渠道号**；不分青红皂白地收进来，会把渠道 ID 当成商品 ID 去回读，
   * 得到一个永远核实不了、也永远恢复不了的假商品（第 37.2 节明确要求只取 update-product 类）。
   */
  const sentIds = new Set(
    task.checkpoints
      .filter(cp => cp.writeSent && cp.target && SPOT_WRITE_STEPS.has(String(cp.step)))
      .map(cp => String(cp.target)),
  );
  // 逐项结果里已经定案的也算"有痕迹"（有些路径会先写结果再写检查点）
  for (const item of task.items ?? []) {
    if (item.status === 'success' || item.status === 'unknown' || item.status === 'failed') {
      sentIds.add(String(item.itemId));
    }
  }

  if (stage === 'spot') {
    const confirmed = confirmedSpotIdsAfterCut(outcomes, group.confirmedSpotItemIds);
    // 已发出（含"只发了检查点、结果还没回来"）的商品一律计入恢复义务：
    // 它们的实际天数不明，必须到恢复时刻**回读核实**后再决定改不改。
    const obligations = new Set([...confirmed, ...sentIds]);
    if (sentIds.size === 0 && obligations.size === 0) {
      // 从未发出任何商品写 → 无义务，按"错过"结束，绝不补切
      return (
        advanceGroupPhase(group, 'missed', now, {
          items: outcomes,
          confirmedSpotItemIds: [],
          pendingItemIds: [],
          message: '切现货在发出请求前中断，本次未修改任何商品',
          error: null,
        }) ?? group
      );
    }
    return (
      advanceGroupPhase(group, 'awaiting-restore', now, {
        items: outcomes,
        confirmedSpotItemIds: [...obligations],
        // 待核实项就是这些"结果不明"的商品；到点由恢复阶段逐项回读定案
        pendingItemIds: [...obligations],
        message: `已从关联任务接回：${obligations.size} 个商品的结果待核实，恢复时先核实再改`,
        error: null,
      }) ?? group
    );
  }

  // ===== 恢复段：回到可重新认领的"等待恢复"，让补检逐项核实收尾 =====
  const stillToCheck = new Set(group.confirmedSpotItemIds);
  for (const item of outcomes) {
    if (item.restore !== 'success') stillToCheck.add(item.itemId);
  }
  /**
   * 这里**直接构造**记录而不走 `advanceGroupPhase`。
   *
   * 原因：`restoring → awaiting-restore` 在单调序上是"回退"，`advanceGroupPhase` 会正确地拒绝它 ——
   * 那条规则是防"迟到回调把已推进的阶段改回去"。但本处不是迟到回调，
   * 而是**有意重置**：恢复阶段被中断后必须重新认领、逐项回读，
   * 否则组会永远停在"恢复中／需处理"（第 36.2 节第 2 条）。
   * 重置的代价被显式记录下来（`revision` 递增、`claimedStages` 去掉 restore、message 说明来源）。
   */
  return {
    ...group,
    phase: 'awaiting-restore',
    revision: group.revision + 1,
    items: outcomes,
    claimedStages: group.claimedStages.filter(s => s !== 'restore'),
    restoreTaskId: null,
    /** 记下"这条中断记录已被接回消费"，启动校验据此不再拿它挡后续恢复 */
    reconciledTaskIds: [...new Set([...(group.reconciledTaskIds ?? []), task.taskId])],
    confirmedSpotItemIds: group.confirmedSpotItemIds,
    pendingItemIds: [...stillToCheck],
    message: `已从关联任务接回：${stillToCheck.size} 个商品待核实／恢复，将逐项回读后收尾`,
    error: null,
    updatedAt: now,
  };
}

/**
 * 组卡在 `cutting` / `restoring` / `needs-attention` 时，尝试把义务接回可推进状态。
 *
 * 只在"关联任务已有非 running 的终态"时动作：正常执行中的任务由自身收尾并回写组，这里不能抢跑。
 *
 * **`needs-attention` 也要尝试接回**（第 37.2 节）：临时断网、后端校验短暂 503、
 * 用户修好渠道之后，义务仍在，程序必须能继续核实收尾；
 * 否则"需处理"就成了死胡同，用户只能重建一组来绕过。
 */
export async function recoverInterruptedGroup(deps: {
  loadGroups: () => Promise<ShippingGroupsRecord>;
  saveGroups: (record: ShippingGroupsRecord) => Promise<void>;
  loadTask: () => Promise<ShippingTask | null>;
  now: () => number;
  log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
  /** 最小脱敏诊断（第 37.1 节要求 R3 修复前先补捕获；不含凭据） */
  recordDiagnostic?: (entry: {
    stage: string;
    groupId?: string;
    taskId?: string;
    groupPhase?: string;
    detail: string;
  }) => Promise<void>;
}): Promise<'none' | 'reattached' | 'unchanged'> {
  const record = await deps.loadGroups();
  const group = record.active;
  if (!group) return 'none';

  const task = await deps.loadTask().catch(() => null);
  if (!task) return 'none';
  if (task.groupId !== group.groupId) return 'none';
  /**
   * 只在这条任务**就是本组"卡住的那一段"**时接回。
   *
   * 关键约束（否则会自激）：
   * - 任务必须属于本组；
   * - `cutting` 只认 spot 段的任务，`restoring` 只认 restore 段的任务；
   * - `needs-attention` **只有在任务阶段与本组当前该继续的阶段一致**时才接回。
   *   为什么这条不能省：状态冲突（用户把商品改成第三种天数）会正确地落成 `needs-attention`，
   *   而它的关联任务阶段仍是 restore —— 若不加区分地反复接回，
   *   就会形成"接回 → 再核实 → 再需处理"的死循环，把"需处理"变成永不停止的重试。
   */
  const expectedPhase: 'spot' | 'restore' | null =
    group.phase === 'cutting' ? 'spot' : group.phase === 'restoring' ? 'restore' : null;
  if (group.phase === 'needs-attention') {
    /**
     * 需处理态：只在"这次需处理是由**中断**造成的、而且条件也许已经恢复"时才尝试继续。
     * 判据用任务的终态与阶段：
     * - 任务是 `interrupted`／`failed`（异常导致），且其阶段与本组应继续的阶段一致；
     * - 若任务本身已 `completed`（说明商品流程正常走完，问题在别处，如状态冲突），**不接回**，
     *   否则会把"需要用户判断的冲突"反复重试成死循环。
     */
    if (task.status !== 'interrupted' && task.status !== 'failed') return 'none';
    const continuePhase = task.groupPhase ?? null;
    if (continuePhase === null) return 'none';
    const next = reattachGroupFromTask(
      { ...group, phase: continuePhase === 'restore' ? 'restoring' : 'cutting' },
      task,
      deps.now(),
    );
    return await commitReattach(deps, record, group, next, task);
  }
  if (expectedPhase === null) return 'none';

  const linkedTaskId = expectedPhase === 'spot' ? group.spotTaskId : group.restoreTaskId;
  const matches =
    (linkedTaskId !== null && task.taskId === linkedTaskId) ||
    (task.groupPhase === expectedPhase);
  /**
   * **认领了但从未创建任务**（第 40.3 节）：释放认领，让补检能重新认领。
   *
   * 判据：组处于 `cutting`／`restoring`（已认领），但手上的任务**不是本段**的
   * （`restoreTaskId` 为空且任务的 `groupPhase` 也不是本段，例如仍是更早的 spot 任务）。
   * 这说明认领与创建任务之间就结束了（临时 503／权限暂拒／身份读取抛错／页面被杀），
   * 此时**没有任何本段的新写请求**，义务完整。
   *
   * 早先这种情况返回 `none`，组永久停在"恢复中／需处理"，商品停在 1 天没人恢复
   * —— 验收实测：`recoverInterruptedGroup` 找不到"恢复段的中断任务"就没辙了。
   * 释放认领不绕过任何校验：身份／权限闸门在 `decideGroupAction` 里，重新认领时会再核验一次。
   */
  if (!matches) {
    /**
     * 走到这里说明：组已认领本段，但**本段的任务从未创建成功**
     * （若创建成功，`readTask()` 会返回带本段 `groupPhase` 的任务 → `matches` 为真）。
     * 因此本段没有任何新写请求、义务完整，可以安全释放认领。
     * 释放**不绕过任何校验**：身份／权限／窗口闸门都在 `decideGroupAction` 里，
     * 重新认领时会再核验一次。
     */
    if (task.status !== 'running') {
      const reason = `本组${expectedPhase === 'spot' ? '开始' : '恢复'}阶段已认领，但任务尚未创建（可能上次被中断）；已释放认领，等待下一次补检重新核验`;
      const released = releaseStageClaim(
        group,
        expectedPhase,
        expectedPhase === 'spot' ? 'scheduled' : 'awaiting-restore',
        deps.now(),
        { message: reason, error: null },
      );
      await deps
        .recordDiagnostic?.({
          stage: 'group-release-claim',
          groupId: group.groupId,
          taskId: task.taskId,
          groupPhase: expectedPhase,
          detail: `阶段 ${group.phase} → ${released.phase}；手上任务 groupPhase=${task.groupPhase ?? '-'} status=${task.status}；本段未创建任务、未发写`,
        })
        .catch(() => {});
      await deps.saveGroups({ ...record, active: released, updatedAt: deps.now() });
      deps.log?.(`[shipping-group] ${group.groupId} ${expectedPhase} 段认领后未创建任务，已释放认领等待补检`, 'warn');
      return 'reattached';
    }
    return 'none';
  }
  // 任务还在跑 → 由它自己收尾，别抢跑
  if (task.status === 'running') return 'none';

  const next = reattachGroupFromTask(group, task, deps.now());
  return await commitReattach(deps, record, group, next, task);
}

/** 落盘接回结果 + 最小脱敏诊断；接回无变化时返回 `unchanged`。 */
async function commitReattach(
  deps: {
    saveGroups: (record: ShippingGroupsRecord) => Promise<void>;
    now: () => number;
    log?: (message: string, level?: 'info' | 'warn' | 'error') => void;
    recordDiagnostic?: (entry: {
      stage: string;
      groupId?: string;
      taskId?: string;
      groupPhase?: string;
      detail: string;
    }) => Promise<void>;
  },
  record: ShippingGroupsRecord,
  group: ShippingGroup,
  next: ShippingGroup,
  task: ShippingTask,
): Promise<'reattached' | 'unchanged'> {
  if (next === group) return 'unchanged';
  const now = deps.now();
  /**
   * R3 最小脱敏诊断（第 37.1 节：只记"决定了 needs-attention"不够）。
   *
   * 必须能回答"**为什么没救回来**"：哪些商品发出过写请求、回读有没有真的发生、
   * 逐项结论怎么分类的、义务接回多少、新阶段是什么。凭据一律不进证据。
   */
  const sentIds = task.checkpoints
    .filter(cp => cp.writeSent && cp.target && SPOT_WRITE_STEPS.has(String(cp.step)))
    .map(cp => String(cp.target));
  const outcomeCounts = next.items.reduce<Record<string, number>>((acc, it) => {
    const key = `${it.spot}/${it.restore}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  await deps
    .recordDiagnostic?.({
      stage: 'group-reattach',
      groupId: group.groupId,
      taskId: task.taskId,
      groupPhase: task.groupPhase ?? group.phase,
      detail:
        `task.status=${task.status}; 已发检查点=${task.checkpoints.filter(cp => cp.writeSent).length};` +
        ` 已发商品[${sentIds.slice(0, 20).join(',')}${sentIds.length > 20 ? `,…共${sentIds.length}` : ''}];` +
        ` 逐项结果=${task.items.length}; 分类=${JSON.stringify(outcomeCounts)};` +
        ` 阶段 ${group.phase} → ${next.phase};` +
        ` 义务=${next.confirmedSpotItemIds.length}; 待核实=${next.pendingItemIds.length};` +
        ` 已消费任务=${(next.reconciledTaskIds ?? []).length}`,
    })
    .catch(() => {});
  await deps.saveGroups({
    active: next.phase === 'done' ? null : next,
    lastFinished: next.phase === 'done' ? next : record.lastFinished,
    updatedAt: now,
  });
  deps.log?.(
    `[shipping-group] ${group.groupId} 已从关联任务接回（${group.phase} → ${next.phase}），` +
      `义务 ${next.confirmedSpotItemIds.length} 个、待核实 ${next.pendingItemIds.length} 个，不重放未确认写`,
    'warn',
  );
  return 'reattached';
}

/**
 * 跑一轮补检：读记录、决定动作、认领并落盘、重新预检、启动任务。
 *
 * 一次只推进**一组**（本功能同时最多一个活跃组）：与旧计划"一次只启动一个"一致，
 * 避免两个阶段同时抢占同一店铺。
 */
export async function tickShippingGroup(
  deps: ShippingGroupDeps,
  depth = 0,
): Promise<ShippingGroupTickResult> {
  let record: ShippingGroupsRecord;
  try {
    record = await deps.loadGroups();
  } catch (e) {
    // 读不到记录就不动作：宁可什么都不做，也不要凭猜测重建一个组
    deps.log?.(`[shipping-group] 读取单次安排失败：${redactSensitiveText(e)}`, 'error');
    return { action: 'idle', reason: '读取单次安排记录失败' };
  }

  const group = activeGroup(record);
  if (!group) return { action: 'idle' };

  /**
   * 先尝试把"任务已结束但组还卡在中间阶段"的组接回来（第 34.4 节 R3）。
   *
   * 必须放在决策**之前**：否则 `decideGroupAction` 只会看到 `cutting`／`restoring`
   * 并返回"等待"，组就永久卡住、商品停在 1 天没人恢复（验收正是这样复现的）。
   */
  const recovered = await recoverInterruptedGroup({
    loadGroups: async () => (await deps.loadGroups()),
    saveGroups: deps.saveGroups,
    loadTask: async () => (deps.loadTask ? await deps.loadTask() : null),
    now: () => deps.now(),
    log: deps.log,
    recordDiagnostic: deps.recordDiagnostic,
  }).catch(() => 'none' as const);
  if (recovered === 'reattached') {
    /**
     * 接回后**重跑一轮**，用新阶段继续推进；带深度上限防止自激循环。
     *
     * 为什么要重跑而不是在同一轮里继续：接回改变了阶段语义（`cutting` → `awaiting-restore`
     * 或 `needs-attention`），继续走旧分支会用错的前提做决策。重跑一次读的是**新的持久记录**。
     */
    if (depth === 0) return await tickShippingGroup(deps, depth + 1);
    return { action: 'idle', reason: '已接回中断的组，等待下一轮补检' };
  }

  const now = deps.now();
  const taskActive = await deps.isTaskActive().catch(() => true);
  const identityOk = await deps.isIdentityOk().catch(() => false);
  const conflict = await deps.findOtherWriteConflict().catch(() => null);
  const hasUnknownWrites = group.items.some(i => i.spot === 'unknown' && i.restore !== 'success');

  /**
   * 归属核对必须先于任何启动：读到别的店铺／账号时**等待**，不是标"需处理"。
   *
   * 为什么不能只靠 `isIdentityOk`：它只说明"身份读得到"，不说明"是**本组**那一份"。
   * 换店或换账号后若直接去启动，会先在启动校验里被拒，组被标成 `needs-attention`——
   * 用户切回原店铺后仍看到"需处理"，恢复义务也停在原地（本轮实测到的行为）。
   * 正确语义是保留义务并等待（31.6 规则 6）。
   */
  let ownershipMismatch = null;
  if (deps.currentOwnership) {
    try {
      const current = await deps.currentOwnership();
      if (group.ownerShopId !== null && current.shopId !== null && current.shopId !== group.ownerShopId) {
        ownershipMismatch = `当前店铺（${current.shopId}）不是本组绑定的店铺（${group.ownerShopId}）`;
      } else if (
        group.ownerUserId !== null &&
        current.userId !== null &&
        current.userId !== group.ownerUserId
      ) {
        ownershipMismatch = '当前账号不是本组绑定的账号';
      }
    } catch {
      // 读不到就按"身份不可用"处理，交给 decideGroupAction 走等待分支
    }
  }

  const action = decideGroupAction(group, now, {
    identityOk: identityOk && !ownershipMismatch,
    otherWriteConflict: conflict,
    taskActive,
    hasUnknownWrites,
  });

  if (ownershipMismatch && (action.kind === 'wait' || action.kind === 'nothing')) {
    deps.log?.(`[shipping-group] ${group.groupId} 等待：${ownershipMismatch}`, 'info');
    return { action: 'wait', reason: ownershipMismatch, groupId: group.groupId };
  }

  // 最小诊断：把"这一轮决定了什么、为什么"落一条可读日志。
  // 调度分支多，出了偏差只靠最终 storage 很难判断卡在哪一条闸门（本轮实测踩到）。
  deps.log?.(
    `[shipping-group] ${group.groupId} 阶段=${group.phase} 决定=${action.kind}${
      'reason' in action && action.reason ? ` 原因=${action.reason}` : ''
    } 身份=${identityOk ? 'ok' : 'unavailable'} 任务在跑=${taskActive} 冲突=${conflict ?? '无'}${
      ownershipMismatch ? ` 归属=${ownershipMismatch}` : ''
    }`,
    'info',
  );

  if (action.kind === 'nothing') return { action: 'idle', groupId: group.groupId };
  if (action.kind === 'wait') {
    return { action: 'wait', reason: action.reason, groupId: group.groupId };
  }
  if (action.kind === 'needs-attention') {
    const next = advanceGroupPhase(group, 'needs-attention', now, {
      message: action.reason,
      error: action.reason,
    });
    if (next && next !== group) {
      await saveOrThrow(deps, { ...record, active: next, updatedAt: now });
    }
    return { action: 'needs-attention', reason: action.reason, groupId: group.groupId };
  }
  if (action.kind === 'mark-missed') {
    // 从未发过写请求才可标错过（decideGroupAction 只对 scheduled 阶段返回它）
    const next = advanceGroupPhase(group, 'missed', now, {
      message: '已错过开始时间窗口，本次未修改任何商品；请重新确认日期后再安排',
      error: null,
      pendingItemIds: [],
    });
    if (next && next !== group) {
      await saveOrThrow(deps, { ...record, active: next, updatedAt: now });
    }
    return { action: 'mark-missed', groupId: group.groupId };
  }

  const phase: 'spot' | 'restore' = action.kind === 'start-spot' ? 'spot' : 'restore';

  /**
   * 真正动作之前**再核一次截止**（第 34.3 节 R2）。
   *
   * 上面的决策用的是本轮进入时的 `now`；认领落盘、身份核验、归属读取都要耗时，
   * 期间可能刚好跨过恢复时刻。此时若照旧启动，就会出现"到点了却才开始切 1 天"。
   * 这里在发写之前按**当前时刻**重新判定：已越界且从未发过写 → 标已错过，零写。
   */
  if (phase === 'spot' && deps.now() >= spotWindowDeadline(group.schedule)) {
    const missed = advanceGroupPhase(group, 'missed', now, {
      message: '已错过开始时间窗口，本次未修改任何商品；请重新确认日期后再安排',
      error: null,
      pendingItemIds: [],
    });
    if (missed && missed !== group) {
      await saveOrThrow(deps, { ...record, active: missed, updatedAt: now });
    }
    return { action: 'mark-missed', reason: '启动前已越过开始窗口', groupId: group.groupId };
  }

  // ===== 认领阶段：先落盘再动作，保证重复 alarm 不重复认领 =====
  const claimed = claimGroupStage(group, action.stage, now);
  const claiming: ShippingGroup = {
    ...claimed,
    phase: phase === 'spot' ? 'cutting' : 'restoring',
    revision: claimed.revision + 1,
    updatedAt: now,
    message: phase === 'spot' ? '正在切换为现货 1 天' : '正在恢复常规备货天数',
  };
  try {
    await deps.saveGroups({ ...record, active: claiming, updatedAt: now });
  } catch (e) {
    // 保存失败就停：不能在"没有持久认领"的情况下发写请求，否则重启后会重复执行
    deps.log?.(`[shipping-group] 认领阶段保存失败，已停止：${redactSensitiveText(e)}`, 'error');
    return { action: 'save-failed', reason: '保存阶段认领失败，已停止本次执行', groupId: group.groupId };
  }

  const days = phase === 'spot' ? SHIPPING_SPOT_DAYS : group.schedule.regularDays;
  const settings: ShippingSettings = {
    mode: modeForDays(days),
    days,
    range: group.config.range,
    excludeIds: phase === 'restore' ? '' : group.config.excludeIds,
    toggleLogistics: group.config.toggleLogistics,
  };

  // 恢复阶段**只恢复本轮确认过的商品**：用记录里的集合而不是重新全店预检的结果。
  let items: ShippingTargetItem[];
  if (phase === 'restore') {
    const ids = new Set(restoreItemIds(group));
    if (ids.size === 0) {
      /**
       * 没有可恢复**商品**时，还要看**物流**是否已收尾（第 37.2 节 R5）。
       *
       * 为什么不能直接结束：物流关闭是本组做的，恢复义务与商品恢复是**并列**的
       * （31.6 规则 7）。商品都好了、渠道却还关着时直接删掉活跃组，
       * 用户再也看不到"还有渠道没恢复"，店铺就少一个物流渠道。
       * 早先这里直接落 `done`，而任务的物流义务仍在 —— 验收实测到"组已完成、渠道未恢复"。
       */
      const logisticsPending = await deps.pendingLogistics?.().catch(() => null);
      if (logisticsPending) {
        const next = advanceGroupPhase(claiming, 'needs-attention', now, {
          message: logisticsPending,
          error: logisticsPending,
        });
        if (next) await saveOrThrow(deps, { ...record, active: next, updatedAt: now });
        return { action: 'needs-attention', reason: logisticsPending, groupId: group.groupId };
      }
      const reason =
        group.confirmedSpotItemIds.length === 0
          ? '本次没有商品被改为现货 1 天，无需恢复'
          : '需要恢复的商品都已确认恢复到常规天数';
      const next = advanceGroupPhase(claiming, 'done', now, {
        message: reason,
        pendingItemIds: [],
        finishedAt: now,
      });
      if (next) await saveOrThrow(deps, { ...record, active: next, updatedAt: now });
      return { action: 'done', reason, groupId: group.groupId };
    }
    const known = new Map(group.items.map(i => [i.itemId, i]));
    items = [...ids].map(id => ({
      itemId: id,
      name: known.get(id)?.name ?? `商品 ${id}`,
      status: 1,
      categoryPath: '',
    }));
  } else {
    const previewed = await deps.preview(settings);
    if (!previewed.ok || previewed.items.length === 0) {
      // 预检不通过 → 不写。阶段回退到可重试状态，保留认领记录避免无限重试同一次
      const reason = previewed.error || '预检没有可修改的商品';
      const next = advanceGroupPhase(claiming, 'needs-attention', now, {
        message: reason,
        error: reason,
      });
      if (next) await saveOrThrow(deps, { ...record, active: next, updatedAt: now });
      return { action: 'needs-attention', reason, groupId: group.groupId };
    }
    items = previewed.items;
  }

  /**
   * 启动任务：**失败或抛错时不能把组留在"已认领"上**（第 40.3 节）。
   *
   * 认领发生在创建任务**之前**。若这一步因为临时 503／权限暂拒／身份读取抛错而失败，
   * 此时没有任何新写请求、商品义务完整，组必须能**重新认领**再试；
   * 早先直接落 `needs-attention`，而它没有回到可认领状态的路径
   * （`recoverInterruptedGroup` 也救不了：那条持久任务可能是**更早的 spot completed**，
   * 不存在"恢复段的中断任务"可供接回），于是组永久停在需处理、商品停在 1 天（验收实测）。
   *
   * 这里在确认**尚未创建任务**时释放本次认领、退回可重新认领的阶段：
   * 身份／权限／窗口等闸门仍在 `decideGroupAction` 里，重试时会重新核验，不会绕过校验。
   */
  let started: { success: boolean; error?: string; taskId?: string };
  try {
    started = await deps.startTask({ group: claiming, phase, items, settings });
  } catch (e) {
    const reason = `启动失败：${redactSensitiveText(e)}`;
    const next = releaseStageClaim(claiming, phase, phase === 'spot' ? 'scheduled' : 'awaiting-restore', now, {
      message: reason,
      error: reason,
    });
    await saveOrThrow(deps, { ...record, active: next, updatedAt: now });
    deps.log?.(`[shipping-group] ${group.groupId} ${phase} 段启动抛错，已释放认领等待补检：${reason}`, 'warn');
    return { action: 'wait', reason, groupId: group.groupId };
  }
  if (!started.success) {
    const reason = started.error || '启动被拒绝';
    const next = releaseStageClaim(claiming, phase, phase === 'spot' ? 'scheduled' : 'awaiting-restore', now, {
      message: reason,
      error: reason,
    });
    await saveOrThrow(deps, { ...record, active: next, updatedAt: now });
    deps.log?.(`[shipping-group] ${group.groupId} ${phase} 段启动被拒，已释放认领等待补检：${reason}`, 'warn');
    return { action: 'wait', reason, groupId: group.groupId };
  }

  const withTask =
    phase === 'spot'
      ? { ...claiming, spotTaskId: started.taskId ?? null }
      : { ...claiming, restoreTaskId: started.taskId ?? null };
  await saveOrThrow(deps, { ...record, active: withTask, updatedAt: now });
  return {
    action: phase === 'spot' ? 'started-spot' : 'started-restore',
    groupId: group.groupId,
  };
}

/** 保存组记录；失败抛错（由调用方决定如何停），不静默吞掉。 */
async function saveOrThrow(
  deps: ShippingGroupDeps,
  record: ShippingGroupsRecord,
  ): Promise<void> {
  await deps.saveGroups(record);
}
