/**
 * 后台一键修复任务的持久契约与纯决策函数。
 *
 * 只依赖类型与纯计算，不触碰 browser/storage/DOM，因此 background、popup 与单测可共用同一份规则。
 * 关键不变量：
 * - 只保留一份当前/最近任务（不建历史任务系统）；
 * - 写请求「发出前」先落检查点，中断时据此说明哪些商品可能已被改动，且不自动重放；
 * - 状态未持久确认前不得开始写请求，读取未知不得伪称无任务或成功。
 */

import type {
  OneDayRepairAppliedMarker,
  OneDayRepairHeartbeat,
  OneDayRepairTask,
  OneDaySkuCheckpoint,
  OneDaySkuItemStatus,
  OneDaySkuFlowPhase,
  ShopeeProduct,
} from './types';
import { ONE_DAY_SKU_NAME } from './one-day-sku';

/** 后台修复任务的专用 storage 键（只存一份当前/最近任务） */
export const ONE_DAY_REPAIR_TASK_KEY = '_oneDaySkuRepairTask';
/** 独立心跳键：与任务记录分开写，避免心跳覆盖更新的进度/终态 */
export const ONE_DAY_REPAIR_HEARTBEAT_KEY = '_oneDaySkuRepairHeartbeat';
/** 独立「结果已应用」标记键：popup 只写这里，不触碰后台权威记录 */
export const ONE_DAY_REPAIR_APPLIED_KEY = '_oneDaySkuRepairApplied';
/** popup → storage 的启动请求键（含商品快照） */
export const ONE_DAY_REPAIR_REQUEST_KEY = '_oneDaySkuRepairRequest';
/**
 * 启动被拒绝的记录键。
 *
 * 为什么不只靠消息返回值：popup 里还有别的 `onMessage` 监听者（例如内容脚本/自身监听），
 * 它们可能抢先把响应变成布尔值，后台的 `{success:false,error}` 就到不了发送方。
 * 拒绝原因写进 storage 后，popup 无论拿到什么都能读到真实结果。
 */
export const ONE_DAY_REPAIR_START_ERROR_KEY = '_oneDaySkuRepairStartError';

/**
 * 后台一键修复的最小脱敏诊断记录键。
 *
 * 目的：同类返工已出现两轮，再靠猜会浪费更多轮次。这里只记录**定位所需的最少字段**：
 * 任务锚 vs 实际锚、阶段、被拒原因、动作的已确认/未知状态。**绝不**记录 Cookie、
 * SPC_CDS、token 或密码。仅保留最近若干条，不做历史任务系统。
 */
export const ONE_DAY_REPAIR_DIAGNOSTICS_KEY = '_oneDaySkuRepairDiagnostics';

/** 诊断记录保留条数上限（小而有界，避免无限增长） */
export const REPAIR_DIAGNOSTIC_LIMIT = 20;

export interface OneDayRepairDiagnostic {
  at: number;
  kind:
    | 'start-rejected'
    | 'ownership-stopped'
    | 'checkpoint-failed'
    | 'item-failed'
    | 'stale-write'
    | 'task-failed';
  taskId: string | null;
  requestId: string | null;
  phase: string | null;
  /** 任务记录里的归属锚 */
  taskShopId: number | null;
  taskOwnerUserId: number | null;
  /** 实际核实到的锚；null 表示核实不到（不等于"一致"） */
  actualShopId: number | null;
  actualUserId: number | null;
  reason: string;
  /** 已经确认产生的副作用（写请求已发出且已收到响应） */
  confirmedActions: string[];
  /** 状态未知的副作用（请求发出后异常，无法确认平台是否已处理） */
  unknownActions: string[];
}

/** 生成一条诊断记录（纯函数，便于单测） */
export function buildRepairDiagnostic(
  input: Omit<OneDayRepairDiagnostic, 'at'> & { at?: number },
): OneDayRepairDiagnostic {
  return { at: input.at ?? Date.now(), ...input, reason: redactDiagnosticReason(input.reason) };
}

/**
 * 诊断原因脱敏：即使用户/平台消息里带了凭据，也不能落进 storage。
 * 只做必要的模式替换，不改动不含凭据的正常文案。
 */
export function redactDiagnosticReason(reason: string): string {
  return String(reason || '')
    .replace(/(SPC_CDS(?:_VER)?=)[^&\s'"]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
    // token/password/凭据字段可能带引号也可能不带（`token=...` 与 `"token":"..."`）
    .replace(/((?:token|password|access_token|refresh_token|spcCds|spc_cds)"?\s*[:=]\s*"?)[^"'\s,}&]+/gi, '$1***')
    .slice(0, 500);
}

/**
 * 保活周期：worker 空闲回收约 30 秒，取 20 秒在其之内重置空闲计时。
 * 只做有界、短完成的扩展 API 调用，任务终态即清理。
 */
export const REPAIR_KEEPALIVE_INTERVAL_MS = 20_000;

/**
 * 心跳宽限：超过这个时长没有心跳，就认定执行者已消失。
 * 取保活周期的 3 倍以上，避免正常调度抖动被误判成中断。
 */
export const REPAIR_HEARTBEAT_GRACE_MS = 75_000;

/** 已进入终态、不再继续写请求的状态 */
export const TERMINAL_REPAIR_STATUSES: OneDayRepairTask['status'][] = ['completed', 'failed', 'interrupted'];

export function isTerminalRepairStatus(status: OneDayRepairTask['status']): boolean {
  return TERMINAL_REPAIR_STATUSES.includes(status);
}

/** 后台正在执行（含刚接受、尚未写出凭据的窗口） */
export function isRepairTaskActive(task: OneDayRepairTask | null | undefined): boolean {
  return !!task && !isTerminalRepairStatus(task.status);
}

/**
 * 凭据指纹：只用于识别「换了账号」，因此不保存 Cookie/SPC_CDS 本身。
 * 采用短哈希，碰撞代价仅是提示不精确，不承担安全职责。
 */
export function fingerprintCredential(spcCds: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < spcCds.length; i++) {
    hash ^= spcCds.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface CreateRepairTaskInput {
  taskId: string;
  requestId: string;
  source: OneDayRepairTask['source'];
  shopId: number | null;
  ownerUserId: number | null;
  spcCds: string;
  products: ShopeeProduct[];
  initialItems: OneDaySkuItemStatus[];
  now: number;
}

/**
 * 建立「已接受」任务记录。后台必须在第一条商品写请求之前写入这份记录并落盘，
 * 否则用户关闭 popup 后无法区分「还没开始」与「已经开始改商品」。
 */
export function createRepairTask(input: CreateRepairTaskInput): OneDayRepairTask {
  return {
    taskId: input.taskId,
    requestId: input.requestId,
    source: input.source,
    status: 'accepted',
    shopId: input.shopId,
    ownerUserId: input.ownerUserId,
    spcCdsFingerprint: fingerprintCredential(input.spcCds),
    phase: 'preparing_sku',
    currentIndex: 0,
    total: input.products.length,
    message: '正在优化商品...',
    error: null,
    items: input.initialItems,
    workItem: null,
    resultProducts: [],
    discountRate: null,
    checkpoints: [],
    writeStarted: false,
    revision: 1,
    startedAt: input.now,
    updatedAt: input.now,
  };
}

export interface RepairProgressPatch {
  phase?: OneDaySkuFlowPhase;
  status?: OneDayRepairTask['status'];
  currentIndex?: number;
  message?: string;
  error?: string | null;
  items?: OneDaySkuItemStatus[];
  /** 正在处理中的商品（含折扣与恢复资料），失败/中断时保留证据 */
  workItem?: OneDaySkuItemStatus | null;
  /** 追加一个检查点；seq 由本函数按现有最大序号 + 1 生成 */
  checkpoint?: Omit<OneDaySkuCheckpoint, 'seq'>;
  /** 标记已发生商品写请求（其后不再回退） */
  markWriteStarted?: boolean;
  at: number;
}

/** 调用方只描述"改什么"，时间戳由 runner 统一补上 */
export type RepairProgressInput = Omit<RepairProgressPatch, 'at'>;

/** 把进度补丁合并进任务记录；返回新对象，保持原记录不可变 */
export function patchRepairTask(task: OneDayRepairTask, patch: RepairProgressPatch): OneDayRepairTask {
  const next: OneDayRepairTask = {
    ...task,
    updatedAt: patch.at,
  };
  if (patch.phase !== undefined) next.phase = patch.phase;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.currentIndex !== undefined) next.currentIndex = patch.currentIndex;
  if (patch.message !== undefined) next.message = patch.message;
  if (patch.error !== undefined) next.error = patch.error;
  if (patch.items !== undefined) next.items = patch.items;
  if (patch.workItem !== undefined) next.workItem = patch.workItem;
  if (patch.markWriteStarted) next.writeStarted = true;
  if (patch.checkpoint) {
    const maxSeq = task.checkpoints.reduce((max, cp) => Math.max(max, cp.seq), 0);
    next.checkpoints = [...task.checkpoints, { ...patch.checkpoint, seq: maxSeq + 1 }];
    if (patch.checkpoint.writeSent) next.writeStarted = true;
  }
  return next;
}

/**
 * 后台写入是否允许落地。
 *
 * 规则：已进入终态的记录不再被普通进度改写（防止迟到写入把 completed 拉回 running）；
 * 例外是显式携带终态的补丁（正常收尾）。心跳不参与这里，它写独立键。
 */
export function canAdvanceTask(current: OneDayRepairTask, incoming: OneDayRepairTask): boolean {
  if (isTerminalRepairStatus(current.status) && !isTerminalRepairStatus(incoming.status)) return false;
  if (incoming.revision < current.revision) return false;
  return true;
}

/** 中断时被改动过的商品（有已发出的写请求检查点） */
export function itemsWithSentWrites(task: OneDayRepairTask): string[] {
  const ids: string[] = [];
  for (const cp of task.checkpoints) {
    if (cp.writeSent && !ids.includes(cp.itemId)) ids.push(cp.itemId);
  }
  return ids;
}

/**
 * 判断持久记录是否「孤儿」：状态仍是执行中，但没有任何活跃执行者。
 *
 * 关键点：MV3 每个扩展同时只有一个 service worker，所以「本实例没有执行者」
 * 就等于「没有执行者」。`heartbeat` 只作为证据随记录保留，**不用来延迟判定** ——
 * 否则就得等心跳过期，而等待依赖的定时器会随 worker 一起被回收（规划方 BR5 指出的问题）。
 * 独立成纯函数是为了能在单测里直接验证「不伪称运行、不自动重放」。
 */
export function resolveOrphanedTask(
  task: OneDayRepairTask | null | undefined,
  hasLiveRunner: boolean,
  heartbeat?: OneDayRepairHeartbeat | null,
  now: number = Date.now(),
): OneDayRepairTask | null {
  if (!task) return null;
  if (isTerminalRepairStatus(task.status)) return task;
  if (hasLiveRunner) return task;

  const touched = itemsWithSentWrites(task);
  const suffix = task.writeStarted
    ? `有 ${touched.length || task.currentIndex} 个商品可能已被修改，请核对后再决定是否重跑。`
    : '尚未发出任何商品写请求，可安全重跑。';
  const heartbeatAt = heartbeat && heartbeat.taskId === task.taskId ? heartbeat.at : null;

  return {
    ...task,
    status: 'interrupted',
    phase: 'interrupted',
    message: `修复已中断（后台执行者已退出）。${suffix}`,
    error: `${task.items.filter(i => i.publishStatus === 'failed').length} 个商品失败，其余未完成。`,
    heartbeatAt,
    updatedAt: now,
    revision: task.revision + 1,
  };
}

/** 后台修复任务在首页的展示状态 */
export type RepairSummaryTone = 'running' | 'pending' | 'done' | 'interrupted';

export interface RepairSummary {
  title: string;
  detail: string;
  actionLabel: string;
  tone: RepairSummaryTone;
}

/**
 * 生成首页「一键修复」摘要。
 * 运行中/已中断/已完成待编辑都要能看见；加载未知时返回 null 而不是「无任务」。
 */
export function buildRepairSummary(task: OneDayRepairTask | null | undefined): RepairSummary | null {
  if (!task) return null;

  const successCount = task.items.filter(i => i.publishStatus === 'success').length;
  const failCount = task.items.filter(i => i.publishStatus === 'failed').length;

  if (!isTerminalRepairStatus(task.status)) {
    return {
      title: '商品修复中',
      detail: `${task.currentIndex}/${task.total} · ${task.message || '正在优化商品'}`,
      actionLabel: '查看进度',
      tone: 'running',
    };
  }

  if (task.status === 'interrupted') {
    return {
      title: '商品修复已中断',
      detail: task.writeStarted ? '部分商品可能已被修改，需核对' : '尚未修改商品，可重跑',
      actionLabel: '查看详情',
      tone: 'interrupted',
    };
  }

  if (task.status === 'completed' && successCount > 0) {
    return {
      title: '修复完成，待编辑参数',
      detail: failCount > 0 ? `${successCount} 个可继续，${failCount} 个失败` : `${successCount} 个商品可继续`,
      actionLabel: '继续编辑',
      tone: 'done',
    };
  }

  if (task.status === 'failed') {
    return {
      title: '商品修复未完成',
      detail: `${failCount} 个商品失败`,
      actionLabel: '查看详情',
      tone: 'interrupted',
    };
  }

  return null;
}

/** 结果是否需要用当前任务覆盖 popup 状态。 */
export interface ShouldApplyRepairResultInput {
  task: OneDayRepairTask | null | undefined;
  /** 独立 storage 键里记录的已应用标记（不是 popup 内存里的） */
  appliedMarker: OneDayRepairAppliedMarker | null | undefined;
  /** 任务归属是否与当前认证/店铺一致；false 时不得套用 */
  ownerMatches: boolean;
  /** 后台是否已经准备好必要结果（有可编辑的商品） */
  resultReady: boolean;
}

/**
 * 结果是否应该套用到 popup 状态。
 *
 * 幂等规则：已应用标记按 taskId 存在就不再套用；归属不符或结果未就绪一律不套用。
 * 判据全部来自 storage/入参，不依赖 popup 内存里的 taskId（冷打开时内存是空的，
 * 靠内存判断必然重复套用）。
 */
export function shouldApplyRepairResult(input: ShouldApplyRepairResultInput): boolean {
  const { task, appliedMarker, ownerMatches, resultReady } = input;
  if (!task) return false;
  if (task.status !== 'completed') return false;
  if (!ownerMatches) return false;
  if (!resultReady) return false;
  return appliedMarker?.taskId !== task.taskId;
}

/**
 * 结果是否「就绪」到可以允许用户进入下一步（选择场次/提交）。
 *
 * 「就绪」= 拿到了**修复后**的可编辑数据，而不是"随便有某些模型"：
 * - 修复前缓存里那批旧模型**不能**冒充修复结果 —— 实际界面已复现「旧模型被当成结果、
 *   折扣被改回、用户带着不含新增 SKU 的数据进入选场次」。
 * - 因此按**逐项修好时的实际情况**判定：
 *   · 该商品在修复**前就有**专用 1 天备货 SKU（`hasOneDaySku`）→ 有模型即可（本来就在）；
 *   · 该商品是本次**新建**的 SKU（`skuCreated`）→ 加载到的模型里必须真的出现那个专用 SKU；
 *   · 两者都没有（本次没有产生 SKU 变化）→ 有模型即可。
 *
 * `fallbackProducts` 是调用方**当前已加载**的商品：后台可能因图未就绪没取到结果，
 * 但 popup 自己从当前店铺重取到了修复后的完整商品，那时同样可以放行。
 * 读取不到就保持"待加载"，不提前标记已应用、也不重设用户已填参数。
 */
export function isRepairResultReady(
  task: OneDayRepairTask | null | undefined,
  fallbackProducts: ShopeeProduct[] = [],
): boolean {
  if (!task) return false;
  if (task.status !== 'completed') return false;
  const successItems = task.items.filter(i => i.publishStatus === 'success');
  if (successItems.length === 0) return false;

  const satisfiedBy = (item: OneDaySkuItemStatus, list: ShopeeProduct[]): boolean => {
    const product = list.find(p => p.itemid === item.itemId);
    const models = product?.modelList;
    if (!Array.isArray(models) || models.length === 0) return false;
    if (item.hasOneDaySku) return true;
    if (item.skuCreated) return models.some(m => m?.name === ONE_DAY_SKU_NAME);
    return true;
  };

  return successItems.some(
    item => satisfiedBy(item, task.resultProducts || []) || satisfiedBy(item, fallbackProducts),
  );
}

/**
 * 套用完成结果后应该停在哪个阶段。
 *
 * 已经推进到选场次/提交的用户**不该**因为一次再同步被踢回编辑参数 ——
 * 那会丢掉他刚做的选择，看起来像"界面自己退回去了"。
 */
export function nextFlowPhaseAfterApply(prevPhase: OneDaySkuFlowPhase): OneDaySkuFlowPhase {
  if (prevPhase === 'selecting_flash_sale' || prevPhase === 'starting_flash_sale' || prevPhase === 'success') {
    return prevPhase;
  }
  return 'editing_params';
}

/** 界面是否已经推进到"选场次"之后（用于判断要不要做补读，避免覆盖用户当前阶段） */
export function isFlowPhaseAdvanced(phase: OneDaySkuFlowPhase): boolean {
  return phase === 'selecting_flash_sale' || phase === 'starting_flash_sale' || phase === 'success';
}

/**
 * 归属核对结果。
 *
 * 与 `isSameOwner` 的区别：写请求必须 fail-closed（核实不到就不放行），
 * 而**界面套用结果**需要区分「已确认不一致」和「还不知道」—— 冷打开时店铺身份是
 * 异步取回的，把「还不知道」当成不一致会把自己的修复结果拒之门外。
 */
export type RepairOwnerVerdict = 'match' | 'mismatch' | 'unknown';

/**
 * 判定任务归属与**当前实际身份**的关系。
 *
 * 'unknown' 只用于界面展示层的重试判断，绝不能用来放行任何写请求。
 */
export function verifyRepairOwner(
  task: OneDayRepairTask | null | undefined,
  actualShopId: number | null,
  ownerUserId: number | null,
  spcCds: string,
): RepairOwnerVerdict {
  if (!task) return 'unknown';
  if (task.shopId !== null && actualShopId === null) return 'unknown';
  if (task.shopId !== null && actualShopId !== task.shopId) return 'mismatch';
  // 任务记了账号、但当前还没取到（冷打开/未登录检查中）→ 还不知道，不能判失败
  if (task.ownerUserId !== null && ownerUserId === null) return 'unknown';
  if (task.ownerUserId !== null && ownerUserId !== task.ownerUserId) return 'mismatch';
  if (spcCds && fingerprintCredential(spcCds) !== task.spcCdsFingerprint) return 'mismatch';
  return 'match';
}

/**
 * 记录归属是否与任务一致；不一致即停止新的写请求。
 *
 * 注意两个身份域不同，不能互相比相等：
 * - `shopId` 必须是**本次实际核实到的店铺**；核实不到（null）即视为不一致，不放行写请求。
 * - `ownerUserId` 是后端账号 id，`accountId` 是虾皮账号 id，两者不比较。
 * - 凭据指纹只用于识别「换了凭据」，不承担授权判断。
 *
 * **fail-closed**：任务记了账号而当前**取不到**（登出/切换中）同样算不一致 ——
 * 「核实不到」不能被当成「与任务一致」而继续发写请求。
 */
export function isSameOwner(
  task: OneDayRepairTask,
  actualShopId: number | null,
  ownerUserId: number | null,
  spcCds: string,
): boolean {
  // 任务记录了店铺，就必须核对到同一个店铺；核实不到即不一致
  if (task.shopId !== null && actualShopId !== task.shopId) return false;
  if (task.ownerUserId !== null && ownerUserId !== task.ownerUserId) return false;
  if (spcCds && fingerprintCredential(spcCds) !== task.spcCdsFingerprint) return false;
  return true;
}
