/**
 * shipping 在 background 的接线层：注册消息与 alarm、把入口依赖注入 runner、读写本功能专属 storage。
 *
 * 为什么单独一个文件而不是继续往 `background.ts` 里堆：
 * 后台入口已经是多业务实现集（解耦审查 D3）。这里把 shipping 自己的消息、
 * alarm、占用检查、存储键全收在一处，入口只加一行 `registerShippingBackground(...)`。
 * 副作用是：停止 shipping 不会碰到特卖的 storage／alarm，改 shipping 规则不需要翻后台入口。
 *
 * 本模块**唯一**允许 import React／DOM 之外的东西：chrome/browser API。
 * 业务算法一律在 `rules.ts` / `runner.ts` / `scheduler.ts` 里，本层只做适配。
 */

import {
  SHIPPING_CHECK_ALARM,
  SHIPPING_CHECK_INTERVAL_MINUTES,
  SHIPPING_DEFAULT_PLANS,
  SHIPPING_DEFAULT_SETTINGS,
  SHIPPING_EMPTY_GROUPS,
  SHIPPING_GROUPS_KEY,
  SHIPPING_GROUP_ALARM,
  SHIPPING_KEEPALIVE_ALARM,
  SHIPPING_DIAGNOSTICS_KEY,
  SHIPPING_DIAGNOSTIC_LIMIT,
  SHIPPING_IDENTITY_KEY,
  SHIPPING_PICKLIST_KEY,
  SHIPPING_PLANS_KEY,
  SHIPPING_PREVIEW_KEY,
  SHIPPING_SETTINGS_KEY,
  SHIPPING_START_ERROR_KEY,
  SHIPPING_TASK_KEY,
  type ShippingDiagnostic,
  type ShippingGroup,
  type ShippingGroupConfig,
  type ShippingGroupsRecord,
  type ShippingGroupSchedule,
  type ShippingIdentityRecord,
  type ShippingPickListRecord,
  type ShippingPickListResult,
  type ShippingPlan,
  type ShippingPreviewRecord,
  type ShippingPreviewResult,
  type ShippingSettings,
  type ShippingTargetItem,
  type ShippingTask,
} from './types';
import {
  applyTaskResultToGroup,
  tickShippingGroup,
  type ShippingGroupDeps,
  type ShippingGroupTickResult,
} from './group';
import {
  advanceGroupPhase,
  canStartNewGroup,
  createShippingGroup,
  isValidRegularDays,
  revokeGroup,
  SHIPPING_SPOT_DAYS,
  spotWindowDeadline,
  validateGroupInput,
} from './group-rules';
import {
  createShippingTask,
  isShippingTaskActive,
  patchShippingTask,
  resolveOrphanedShippingTask,
  type ShippingTaskPatch,
} from './task';
import {
  buildOccurrenceId,
  compareShippingConfirmedContent,
  describeContentDiff,
  describeContentValues,
  hasBlockingContentDiff,
  modeForDays,
  normalizePreviewSettings,
  parseExcludeIds,
  retireLegacyRepeatPlans,
  taipeiDateString,
  validateSettings,
} from './rules';
import {
  applyPlanSkipped,
  applyPlanTerminalResult,
  claimPlanOccurrence,
  decidePlanActions,
} from './scheduler';
import {
  needsLogisticsAction,
  previewShippingTargets,
  restorePendingLogistics,
  runShippingTask,
  type ShippingPreviewSettings,
} from './runner';
import {
  fetchAllProducts,
  fetchChannelList,
  fetchFlashSaleExcludeIds,
  fetchProductDetail,
  redactSensitiveText,
  updateChannelToggle,
  updateProductBatch,
  type ShippingFetch,
} from './api';
import type { ShippingCredential, ShippingIdentity, ShippingRunnerDeps } from './runner-deps';

/** 入口注入的能力：复用现有 Cookie／身份／页面请求／后端校验，不复制第二套授权。 */
export interface ShippingBackgroundDeps {
  /** MAIN-world 页面请求（background 的 injectedFetch） */
  injectedFetch: ShippingFetch;
  /** 从 Cookie 现读凭据，禁止读 storage.local */
  getCredential: () => Promise<ShippingCredential>;
  /** 现读实际登录店铺与虾皮账号；核实不到返回 null */
  getShopIdentity: (credential: ShippingCredential) => Promise<ShippingIdentity>;
  /** 现读后端账号 id */
  getAuthUserId: () => Promise<number | null>;
  /** 复用现有 `/api/stores/validate`；action 用明确的 shipping 标识 */
  validateAccess: (credential: ShippingCredential, shopId: number | null) => Promise<{ allowed: boolean; error?: string }>;
  /** 同店铺是否已有其他写任务（特卖／复制／修复）；返回拒绝原因或 null */
  findOtherWriteConflict: () => Promise<string | null>;
  log: (message: string, level?: 'info' | 'warn' | 'error') => void;
}
// ===== 运行期状态（只在本实例有效；跨 worker 重启的判定走 storage） =====

let _shippingRunningTaskId: string | null = null;
let _shippingStarting = false;
/** 用户请求停止：只阻止后续商品写请求，不撤销已确认的修改 */
let _shippingStopRequested = false;
let _keepaliveTimer: ReturnType<typeof setInterval> | null = null;

export function isShippingInFlight(): boolean {
  return _shippingRunningTaskId !== null || _shippingStarting;
}

// ===== storage 读写（本功能专属键） =====

async function readTask(): Promise<ShippingTask | null> {
  const stored = await browser.storage.local.get(SHIPPING_TASK_KEY);
  return (stored[SHIPPING_TASK_KEY] as ShippingTask | undefined) ?? null;
}

async function saveTask(task: ShippingTask, _patch?: ShippingTaskPatch): Promise<void> {
  // 必须真正落盘：写不进去 runner 会抛 ShippingCheckpointSaveError 并停止后续写
  await browser.storage.local.set({ [SHIPPING_TASK_KEY]: task });
}

export async function readShippingSettings(): Promise<ShippingSettings> {
  const stored = await browser.storage.local.get(SHIPPING_SETTINGS_KEY);
  const value = stored[SHIPPING_SETTINGS_KEY] as Partial<ShippingSettings> | undefined;
  return { ...SHIPPING_DEFAULT_SETTINGS, ...(value || {}) };
}

export async function readShippingPlans(): Promise<ShippingPlan[]> {
  const stored = await browser.storage.local.get(SHIPPING_PLANS_KEY);
  const value = stored[SHIPPING_PLANS_KEY] as ShippingPlan[] | undefined;
  if (!Array.isArray(value) || value.length === 0) return SHIPPING_DEFAULT_PLANS.map(p => ({ ...p }));
  /**
   * 读取即降级旧重复计划（第 34.2 节 R1）。
   *
   * 放在**读取**这一层，是为了让"任何**可能**推进旧计划的代码路径"看到的都是已暂停版本：
   * 调度、alarm 重建、界面同步全部经这里，漏改其中一个分支就会让旧每日任务重新跑起来。
   * 真正的落盘迁移在 `checkShippingPlans` 里做，以便状态可见且可追溯。
   */
  return retireLegacyRepeatPlans(value);
}

/** 是否本次读取发生了旧重复计划的降级（用于把迁移真正落盘并留下痕迹）。 */
function needsLegacyRetirementMigration(stored: ShippingPlan[]): boolean {
  return stored.some(p => p.loopDaily && !p.retired);
}

async function savePlans(plans: ShippingPlan[]): Promise<void> {
  await browser.storage.local.set({ [SHIPPING_PLANS_KEY]: plans });
}

// ===== 单次成对安排记录（第 31 节） =====

/**
 * 读取单次组记录。
 *
 * 读失败**必须抛错**而不是返回空记录：返回空会让上层以为"没有安排"，
 * 从而把用户已经保存的恢复义务当成不存在（31.6 规则 1 要求本地记录是事实来源）。
 */
export async function readShippingGroups(): Promise<ShippingGroupsRecord> {
  const stored = await browser.storage.local.get(SHIPPING_GROUPS_KEY);
  const value = stored[SHIPPING_GROUPS_KEY] as ShippingGroupsRecord | undefined;
  if (!value || typeof value !== 'object') {
    return { ...SHIPPING_EMPTY_GROUPS };
  }
  return {
    active: (value.active as ShippingGroup | null) ?? null,
    lastFinished: (value.lastFinished as ShippingGroup | null) ?? null,
    updatedAt: Number(value.updatedAt) || 0,
  };
}

async function saveGroups(record: ShippingGroupsRecord): Promise<void> {
  await browser.storage.local.set({ [SHIPPING_GROUPS_KEY]: record });
}

/**
 * 单次组的推进依赖组装：把"读写记录／重新预检／启动一次任务"接到既有 runner。
 *
 * 计划（`plan`）与新组（`group`）共用同一个执行器，不另造第二套 runner（31.5 要求）。
 */
function buildGroupDeps(deps: ShippingBackgroundDeps): ShippingGroupDeps {
  return {
    loadGroups: readShippingGroups,
    saveGroups,
    preview: async settings => {
      /**
       * 必须先规范化：`normalizePreviewSettings` 返回的是 `{ok, settings}` 包装，
       * 不是设置本身。早先把包装整个当设置传下去，`range`/`excludeIds` 全是 undefined，
       * 预检虽然"看起来跑通了"，走的却是错的过滤条件（本轮实际踩到过）。
       */
      const normalized = normalizePreviewSettings(settings);
      if (!normalized.ok) {
        return { ok: false, error: normalized.error, shopId: null, items: [] };
      }
      const result = await previewShippingTargets(buildRunnerDeps(deps), normalized.settings);
      return { ok: result.ok, error: result.error, shopId: result.shopId, items: result.items };
    },
    startTask: async ({ group, phase, items, settings }) => {
      /**
       * 快照里的设置必须是**规范化后的对象本身**。
       *
       * 早先把 `normalizePreviewSettings(settings)` 的包装 `{ok, settings}` 直接放进来，
       * 于是快照里的 `toggleLogistics` 是 `undefined`，启动校验按"不是开关值"拒绝，
       * 表现为"到点了却不执行"（本轮实际踩到，两处都要改）。
       */
      const normalized = normalizePreviewSettings(settings);
      if (!normalized.ok) {
        return { success: false, error: normalized.error };
      }
      const result = await handleShippingStart(deps, {
        requestId: `${group.groupId}:${phase}:${group.revision}`,
        settings: normalized.settings,
        items,
        source: 'group',
        groupId: group.groupId,
        groupPhase: phase,
        groupStartedAt: group.schedule.startAt,
        groupRestoreAt: group.schedule.restoreAt,
        previewRecord: {
          requestId: `${group.groupId}:${phase}:${group.revision}`,
          at: Date.now(),
          shopId: group.ownerShopId,
          ownerUserId: group.ownerUserId,
          settings: normalized.settings,
          itemIds: items.map(i => String(i.itemId)),
          result: {
            ok: true,
            shopId: group.ownerShopId,
            scanned: items.length,
            complete: true,
            items,
            excludedByManual: 0,
            excludedByFlashSale: 0,
            unsupported: 0,
            flashSaleExclusionOk: true,
            nonhotDeterminable: true,
            logistics: { requested: normalized.settings.toggleLogistics, enabledChannels: [] },
          },
        },
        ownerShopId: group.ownerShopId,
        ownerUserId: group.ownerUserId,
      });
      return { success: result.success, error: result.error, taskId: result.taskId };
    },
    isTaskActive: async () => isShippingTaskActive(await readTask()),
    loadTask: readTask,
    recordDiagnostic: async entry => {
      await recordShippingDiagnostic({
        stage: entry.stage,
        taskId: entry.taskId,
        /**
         * `groupId` 必须一起落盘：组级诊断（接回）若不带组 ID，事后无法判断
         * 这条记录属于哪一组，多个组交替时会张冠李戴（本轮加断言时发现）。
         */
        reason: `[${entry.groupPhase ?? '-'}]${entry.groupId ? ` group=${entry.groupId}` : ''} ${entry.detail}`,
        expectedShopId: null,
        expectedUserId: null,
        actualShopId: null,
        actualUserId: null,
        access: 'not-checked',
        writeSent: false,
      } as Omit<ShippingDiagnostic, 'at'>);
    },
    isIdentityOk: async () => {
      const credential = await deps.getCredential().catch(() => null);
      if (!credential?.spcCds) return false;
      const identity = await deps.getShopIdentity(credential).catch(() => ({ shopId: null, accountId: null }));
      return identity.shopId !== null;
    },
    currentOwnership: async () => {
      const credential = await deps.getCredential().catch(() => null);
      if (!credential?.spcCds) return { shopId: null, userId: null };
      const identity = await deps.getShopIdentity(credential).catch(() => ({ shopId: null, accountId: null }));
      const userId = await deps.getAuthUserId().catch(() => null);
      return { shopId: identity.shopId, userId };
    },
    /**
     * 仍待恢复的原启用渠道（第 37.2 节 R5）。
     *
     * 组完成判定必须包含"物流已收尾"：商品恢复好了但渠道还关着时结束本组，
     * 就会把用户店铺留在少一个物流渠道的状态，而且界面上再也看不到这件事。
     */
    pendingLogistics: async () => {
      const task = await readTask().catch(() => null);
      if (!task) return null;
      const pending = task.logistics.records.filter(r => needsLogisticsAction(r));
      if (pending.length === 0) return null;
      return `上一批的原店铺物流尚未恢复（渠道 ${pending.map(r => r.channelId).join('、')}），请先恢复物流`;
    },
    findOtherWriteConflict: deps.findOtherWriteConflict,
    now: () => Date.now(),
    log: deps.log,
  };
}

/**
 * 组补检：alarm 与消息都走这里。
 *
 * 与旧计划补检分开：旧计划是"某天某时刻跑一次"，新组是"成对两阶段"，
 * 判定规则不同（窗口／错过／恢复对象），混在一个函数里会让两套语义互相干扰。
 */
export async function checkShippingGroup(deps: ShippingBackgroundDeps): Promise<ShippingGroupTickResult> {
  const result = await tickShippingGroup(buildGroupDeps(deps));
  deps.log(`[shipping] 单次安排补检：${result.action}${result.reason ? `（${result.reason}）` : ''}`, 'info');
  // 补检 alarm：组未结束就继续挂着；结束就清掉，避免空转
  await syncShippingGroupAlarm();
  return result;
}

/** 按当前组状态重建／清理组 alarm。 */
export async function syncShippingGroupAlarm(): Promise<void> {
  const record = await readShippingGroups().catch(() => null);
  const active = record?.active ?? null;
  const needsAlarm = !!active && active.phase !== 'done' && active.phase !== 'missed';
  if (needsAlarm) {
    chrome.alarms.create(SHIPPING_GROUP_ALARM, { periodInMinutes: SHIPPING_CHECK_INTERVAL_MINUTES });
  } else {
    await chrome.alarms.clear(SHIPPING_GROUP_ALARM).catch(() => {});
  }
}

// ===== runner 依赖组装 =====

function buildRunnerDeps(deps: ShippingBackgroundDeps): ShippingRunnerDeps {
  return {
    getCredential: deps.getCredential,
    /**
     * 生产路径：**先读一次凭据，再用这同一份凭据**核实身份（返工 17.2）。
     * 这样"核验用的会话"与"随后发写请求用的会话"必然是同一个，
     * 不会出现按会话 A 核验、用会话 B 写的情况。
     */
    verifiedContext: async () => {
      const credential = await deps.getCredential();
      const identity = await deps.getShopIdentity(credential);
      const userId = await deps.getAuthUserId();
      return { credential, shopId: identity.shopId, userId };
    },
    getShopIdentity: async () => {
      const credential = await deps.getCredential();
      return deps.getShopIdentity(credential);
    },
    getAuthUserId: deps.getAuthUserId,
    fetchAllProducts: credential => fetchAllProducts(deps.injectedFetch, credential),
    fetchProductDetail: (credential, itemId) => fetchProductDetail(deps.injectedFetch, credential, itemId),
    fetchFlashSaleExcludeIds: credential =>
      fetchFlashSaleExcludeIds(deps.injectedFetch, credential, Math.floor(Date.now() / 1000)),
    fetchChannelList: credential => fetchChannelList(deps.injectedFetch, credential),
    updateChannelToggle: async (credential, channelId, enabled) => {
      // 由 api 层统一区分"明确失败"与"结果未知"（传输异常 → unknown）
      return updateChannelToggle(deps.injectedFetch, credential, channelId, enabled);
    },
    updateProductBatch: async (credential, payload) => {
      const outcome = await updateProductBatch(deps.injectedFetch, credential, payload);
      // 三态分开交给 runner：明确限流可重试；传输未知**不重发**，由回读定案
      return {
        topLevelSuccess: outcome.topLevelSuccess,
        itemResults: outcome.itemResults,
        error: outcome.error,
        topCode: outcome.topCode,
        hasItemResults: outcome.hasItemResults,
        rateLimited: outcome.rateLimited,
        transportUnknown: outcome.transportUnknown,
      };
    },
    saveTask,
    loadTask: readTask,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
    startKeepalive: () => startKeepalive(),
    stopKeepalive: () => stopKeepalive(),
    isStopRequested: () => _shippingStopRequested,
    log: deps.log,
    // 写前核验要用现行后端权限（返工 14.3）；由入口注入的同一个 validateAccess
    validateAccess: deps.validateAccess,
    recordDiagnostic: recordShippingDiagnostic,
  };
}

/**
 * 最小脱敏诊断（返工 14.3 要求）。
 *
 * 只记录"下一轮不用猜"的定位字段：阶段、预览／任务／轮次标识、预期与实际店铺／账号、
 * 权限结果、是否已发写请求、可读原因。**永不保存 Cookie、token 或带凭据的地址**，
 * 写入前统一过 `redactSensitiveText`。
 */
async function recordShippingDiagnostic(entry: Omit<ShippingDiagnostic, 'at'>): Promise<void> {
  try {
    const stored = await browser.storage.local.get(SHIPPING_DIAGNOSTICS_KEY);
    const list = (stored[SHIPPING_DIAGNOSTICS_KEY] as ShippingDiagnostic[] | undefined) || [];
    const record: ShippingDiagnostic = {
      ...entry,
      reason: redactSensitiveText(entry.reason),
      at: Date.now(),
    };
    const next = [...list, record].slice(-SHIPPING_DIAGNOSTIC_LIMIT);
    await browser.storage.local.set({ [SHIPPING_DIAGNOSTICS_KEY]: next });
  } catch {
    /* 诊断写不进去不影响业务，也不应改变结果 */
  }
}

function startKeepalive() {
  stopKeepalive();
  const beat = () => {
    if (_shippingRunningTaskId === null) return;
    chrome.alarms.create(SHIPPING_KEEPALIVE_ALARM, { delayInMinutes: 1 / 3 }).catch?.(() => {});
  };
  beat();
  _keepaliveTimer = setInterval(beat, 15_000);
}

function stopKeepalive() {
  if (_keepaliveTimer !== null) {
    clearInterval(_keepaliveTimer);
    _keepaliveTimer = null;
  }
  chrome.alarms.clear(SHIPPING_KEEPALIVE_ALARM).catch(() => {});
}

// ===== 启动 =====

async function recordStartError(error: string | null) {
  if (error) {
    await browser.storage.local
      .set({ [SHIPPING_START_ERROR_KEY]: { error, at: Date.now() } })
      .catch(() => {});
  } else {
    await browser.storage.local.remove(SHIPPING_START_ERROR_KEY).catch(() => {});
  }
}

export interface ShippingStartRequest {
  requestId: string;
  settings: ShippingSettings;
  items: ShippingTargetItem[];
  source?: 'manual' | 'plan' | 'group';
  planId?: string;
  occurrenceId?: string;
  /** 所属单次组（`source === 'group'` 时有值） */
  groupId?: string;
  /** 本任务承担组里哪一阶段 */
  groupPhase?: 'spot' | 'restore';
  /** 所属组的开始时刻（用于在写边界重新计算截止，第 34.3 节 R2） */
  groupStartedAt?: number;
  /** 所属组的恢复时刻（截止不得越过它） */
  groupRestoreAt?: number;
  /**
   * 手动任务必须带上"这份目标是在哪次预览确认的"请求号。
   * 背景据此读回落盘的预览记录并核对店铺／账号归属（返工 14.1）。
   */
  previewRequestId?: string;
  /**
   * 计划任务的**当轮**预检快照（返工 20.1）。
   *
   * 计划每轮都重新预检，结果没有落盘到 `_shippingPreview`（那是手动预览用的键），
   * 所以由调用方把这一份内联传进来；`startShippingInner` 对它做与手动路径**同一套**
   * 归属核对、类型校验与内容比对，执行参数也只从它构造。
   */
  previewRecord?: ShippingPreviewRecord;
  /**
   * 计划任务必须显式带上计划保存时核实的归属锚。
   * 手动任务留空（用预览记录里的锚）。
   */
  ownerShopId?: number | null;
  ownerUserId?: number | null;
}

/**
 * 接受并启动一次备货修改任务。
 *
 * 启动互斥在第一个 await 之前同步取得（与一键修复同一手法）：
 * Chrome 的监听回调是单线程同步段，两个并发消息会依次执行这一段，
 * 第二个必然看到 `_shippingStarting` 已置位而得到忙态，不会双双通过校验。
 */
export async function handleShippingStart(
  deps: ShippingBackgroundDeps,
  request: ShippingStartRequest,
): Promise<{ success: boolean; error?: string; taskId?: string }> {
  if (_shippingStarting || _shippingRunningTaskId !== null) {
    const busy = '已有备货修改任务在执行，请先等它结束';
    await recordStartError(busy);
    return { success: false, error: busy };
  }
  _shippingStarting = true;
  try {
    return await startShippingInner(deps, request);
  } finally {
    _shippingStarting = false;
  }
}

async function startShippingInner(
  deps: ShippingBackgroundDeps,
  request: ShippingStartRequest,
): Promise<{ success: boolean; error?: string; taskId?: string }> {
  const settingsError = validateSettings(request.settings);
  if (settingsError) {
    await recordStartError(settingsError);
    return { success: false, error: settingsError };
  }
  if (request.items.length === 0) {
    const error = '没有需要修改的商品（预检结果为空）';
    await recordStartError(error);
    return { success: false, error };
  }

  const credential = await deps.getCredential();
  if (!credential.spcCds) {
    const error = '凭据已失效（Cookie 中找不到 SPC_CDS），请重新登录 seller.shopee.tw';
    await recordStartError(error);
    return { success: false, error };
  }
  const identity = await deps.getShopIdentity(credential);
  if (identity.shopId === null) {
    const error = '无法核实当前店铺身份，请打开卖家中心页面后重试';
    await recordStartError(error);
    return { success: false, error };
  }

  // 双向冲突检查：同店已有其他写任务时拒绝新动作（不取消既有任务）
  const otherConflict = await deps.findOtherWriteConflict();
  if (otherConflict) {
    await recordStartError(otherConflict);
    return { success: false, error: otherConflict };
  }
  const existing = await readTask();
  if (existing && isShippingTaskActive(existing)) {
    const busy = '已有备货修改任务在执行，请先等它结束';
    await recordStartError(busy);
    return { success: false, error: busy };
  }
  /**
   * 旧的终态记录不再无条件挡新任务（第 34.4 节 R3）。
   *
   * 早先只要存在 `interrupted` 记录就拒绝启动，于是"中断被接回后要恢复"的场景被自己挡住：
   * 组已经从关联任务接回到 `awaiting-restore`，但那条 `interrupted` 任务记录还在，
   * 恢复阶段永远起不来（验收里实测就是这样卡住的）。
   *
   * 正确判据是"这条记录是否仍代表**未处理完**的义务"：
   * - 待恢复物流 → 仍要挡（物流义务确实没完成）；
   * - 中断但**已经通过接回被追踪**（组已不是 cutting/restoring）→ 不挡，义务由组承担；
   * - 中断且未接回（组仍在 cutting/restoring）→ 仍挡，避免在结果未明时叠加新写。
   */
  if (existing) {
    const pendingRestore = existing.logistics.records.filter(r => needsLogisticsAction(r));
    if (pendingRestore.length > 0) {
      const error = `上一批的原店铺物流尚未恢复（渠道 ${pendingRestore
        .map(r => r.channelId)
        .join('、')}），请先恢复物流`;
      await recordStartError(error);
      return { success: false, error };
    }
    if (existing.status === 'interrupted') {
      const groups = await readShippingGroups().catch(() => null);
      const active = groups?.active ?? null;
      /**
       * 只在这条中断记录**正是本组当前还等着的那一段**时才挡。
       *
       * 为什么不能只判"组不是 cutting"：恢复阶段在启动前会先把阶段认领成 `restoring`，
       * 于是"组是 restoring"既可能是"恢复还没做完"（该挡），也可能是"正在启动这次恢复"（不该挡）。
       * 用**任务自己带的 groupId + groupPhase** 去对，才能分清：
       * 组停在 cutting 且中断的是 spot 段 → 挡；组正在跑 restore 而中断的是更早的 spot 段 → 不挡。
       *
       * **但组已从这条任务接回后就不该再挡**（第 37.2 节 R3 收敛）。
       * `recoverInterruptedGroup` 会把义务接进组记录（`confirmedSpotItemIds` + `pendingItemIds`）
       * 并把组放回 `awaiting-restore`，此时那条 `interrupted` 记录已经被"消费"过了。
       * 早先的实现只看"组是不是 restoring"，于是接回后的组被自己的旧记录反复挡住，
       * 恢复永远起不来 —— 表现就是"重开后停在需处理、永远不继续"（验收实测）。
       * 判据加上一条**组是否已认领并由该任务承担过此阶段**（`spotTaskId`／`restoreTaskId`）。
       */
      const expectedPhase =
        active === null
          ? null
          : active.phase === 'cutting'
            ? 'spot'
            : active.phase === 'restoring'
              ? 'restore'
              : null;
      const linkedTaskId =
        active === null ? null : expectedPhase === 'spot' ? active.spotTaskId : active.restoreTaskId;
      /**
       * 已被接回消费过的中断记录**不再挡**（第 37.2 节 R3 收敛）。
       * 接回会把义务搬进组记录并把 `restoreTaskId` 清空，那条记录已无未处理的义务。
       */
      const alreadyReconciled = active?.reconciledTaskIds?.includes(existing.taskId) === true;
      const stillUnreconciled =
        active !== null &&
        expectedPhase !== null &&
        !alreadyReconciled &&
        existing.groupId === active.groupId &&
        existing.groupPhase === expectedPhase &&
        linkedTaskId !== existing.taskId;
      if (stillUnreconciled) {
        const error = '上次任务被中断且结果未确认，请先查看结果并结束该轮，再开始新任务';
        await recordStartError(error);
        return { success: false, error };
      }
      // 组已接回或该记录不属于当前组当前阶段 → 不再用它挡新任务（义务由组记录承担）
    }
  }

  const access = await deps.validateAccess(credential, identity.shopId);
  if (!access.allowed) {
    const error = access.error || '店铺访问校验未通过';
    await recordStartError(error);
    return { success: false, error };
  }

  const currentUserId = await deps.getAuthUserId();

  /**
   * 本次执行实际要用的设置与商品（返工 20.1）。
   *
   * 手动路径会用"由后台记录构造的那一份"覆盖它；
   * 计划路径由调用方（`checkShippingPlans`）把当轮预检结果作为内联记录传进来，
   * 走同一段核对与规范化，因此下面统一由记录赋值。
   */
  let executionSettings: ShippingSettings;
  let executionItems: ShippingTargetItem[];
  /** 本次执行所依据的后台记录：手动路径来自 `_shippingPreview`，计划路径是当轮内联快照 */
  let executionRecord: ShippingPreviewRecord;

  // ===== 归属锚确定（R3 / 返工 14.1）=====
  // 手动任务：必须核对"这份预览是谁确认的"。用户在账号 1 预览、切到账号 2 后
  // 不允许拿旧预览启动 —— 否则会把商品改到别的账号／店铺。
  // **绝不用启动时的身份去重新认领旧预览**，也不信 UI 自报的 owner。
  //
  // 计划与单次组都自带归属锚与当轮预检快照，因此共用**同一套**核对：
  // 两边都是"到点由后台自己启动"，没有用户在弹窗里现场确认的那一步（第 31 节）。
  if (request.source === 'plan' || request.source === 'group') {
    if (!request.previewRecord) {
      const error = '缺少当轮预检快照，已拒绝执行（请重新保存安排）';
      await recordStartError(error);
      return { success: false, error };
    }
    executionRecord = request.previewRecord;
  } else {
    if (!request.previewRequestId) {
      const error = '缺少预览请求号，无法确认这份目标是谁核实的，请重新预检';
      await recordStartError(error);
      return { success: false, error };
    }
    const stored = await browser.storage.local.get(SHIPPING_PREVIEW_KEY);
    const record = stored[SHIPPING_PREVIEW_KEY] as ShippingPreviewRecord | undefined;
    if (!record || record.requestId !== request.previewRequestId) {
      const error = '预览记录已过期或不存在，请重新预检后再开始';
      await recordStartError(error);
      return { success: false, error };
    }
    if (record.shopId === null || record.ownerUserId === null) {
      const error = '这份预览没有可核实的店铺／账号归属，请重新预检';
      await recordStartError(error);
      return { success: false, error };
    }
    if (record.shopId !== identity.shopId) {
      const error = `这份预览是在店铺 ${record.shopId} 确认的，当前店铺是 ${identity.shopId}，请重新预检`;
      await recordStartError(error);
      return { success: false, error };
    }
    if (record.ownerUserId !== currentUserId) {
      const error = '这份预览是在另一个账号确认的，请重新预检后再开始';
      await recordStartError(error);
      return { success: false, error };
    }
    executionRecord = record;
  }

  // ===== 确认内容核对与规范化（返工 17.1／20.1）=====
  // 请求号只证明"这个预览存在"，不证明"要执行的就是它"。同一个有效请求号配上
  // 另一套天数或额外商品，如果照单全收，就等于把用户确认过的范围悄悄扩大了。
  // **后台记录是参数与集合的唯一依据**：
  //   1）先把消息里的设置规范化（不合规直接拒绝）；
  //   2）再与记录比对；
  //   3）**执行参数只从记录构造**，不再使用消息里的对象。
  // 计划路径同样走这一段：它的记录是当轮预检刚生成的内联快照。
  {
    const record = executionRecord!;
    if (typeof request.settings?.toggleLogistics !== 'boolean') {
      const rawType = request.settings?.toggleLogistics === null ? 'null' : typeof request.settings?.toggleLogistics;
      await recordShippingDiagnostic({
        stage: 'start-logistics-flag-type',
        requestId: request.requestId,
        expectedShopId: identity.shopId,
        expectedUserId: currentUserId,
        actualShopId: identity.shopId,
        actualUserId: currentUserId,
        access: 'allowed',
        writeSent: false,
        blockedBy: 'logistics-flag-type',
        contentValues: describeContentValues(request.settings),
        reason: `「自动管理店铺物流」不是 boolean（实际 ${rawType}），已拒绝`,
      });
      const error = `「自动管理店铺物流」的值不合法（必须是 true/false，实际是 ${rawType}），已拒绝；请重新预检后再开始`;
      await recordStartError(error);
      return { success: false, error };
    }

    // 记录本身也必须是合规快照：老记录可能缺字段或被改坏，同样拒绝并要求重新预检
    const normalizedRecord = normalizePreviewSettings(record.settings);
    if (!normalizedRecord.ok) {
      await recordShippingDiagnostic({
        stage: 'start-record-invalid',
        requestId: request.requestId,
        expectedShopId: identity.shopId,
        expectedUserId: currentUserId,
        actualShopId: identity.shopId,
        actualUserId: currentUserId,
        access: 'allowed',
        writeSent: false,
        blockedBy: 'settings-mismatch',
        contentValues: describeContentValues(record.settings),
        reason: `预览记录缺少可执行的设置：${normalizedRecord.error}`,
      });
      const error = `这份预览记录不再可用（${normalizedRecord.error}），请重新预检后再开始`;
      await recordStartError(error);
      return { success: false, error };
    }
    const confirmedSettings: ShippingPreviewSettings = normalizedRecord.settings;
    const incomingNormalized = normalizePreviewSettings(request.settings);
    // 规范化在类型上必然成立（上面已检查 toggleLogistics）；不成立就是校验规则变了，按拒绝处理
    if (!incomingNormalized.ok) {
      await recordStartError(incomingNormalized.error);
      return { success: false, error: incomingNormalized.error };
    }
    const incomingSettings: ShippingPreviewSettings = incomingNormalized.settings;

    // 目标集合从**记录**取（不是消息），并且只允许取已核对 ID 的子集
    const confirmedIds: string[] = (record.itemIds ?? []).map(String);
    // 记录里带着当轮预检的完整目标（含名称／状态／类目），执行时优先用它
    const confirmedById = new Map<string, ShippingTargetItem>(
      (record.result?.items ?? []).map(i => [String(i.itemId), i]),
    );
    const requestedIds = new Set(request.items.map(i => String(i.itemId)));
    const executionIds = [...new Set(confirmedIds.filter(id => requestedIds.has(id)))];
    const extraIds = [...requestedIds].filter(id => !confirmedIds.includes(id));

    const contentDiffs = compareShippingConfirmedContent(
      { settings: confirmedSettings, itemIds: confirmedIds },
      { settings: incomingSettings, itemIds: extraIds.length > 0 ? [...confirmedIds, ...extraIds] : [...confirmedIds] },
    );
    if (hasBlockingContentDiff(contentDiffs) || executionIds.length === 0) {
      const detail =
        executionIds.length === 0 ? '本次消息里没有包含任何已确认的商品' : describeContentDiff(contentDiffs);
      await recordShippingDiagnostic({
        stage: 'start-content-check',
        requestId: request.requestId,
        expectedShopId: identity.shopId,
        expectedUserId: currentUserId,
        actualShopId: identity.shopId,
        actualUserId: currentUserId,
        access: 'allowed',
        writeSent: false,
        contentDiffs,
        contentValues: describeContentValues(request.settings),
        blockedBy: hasBlockingContentDiff(contentDiffs) ? 'settings-mismatch' : 'items-extra',
        reason: `确认内容与预览不一致：${detail}`,
      });
      const error = `本次要执行的内容与预检确认的不一致（${detail}），已拒绝；请重新预检后再开始`;
      await recordStartError(error);
      return { success: false, error };
    }

    // 执行用的设置与目标：**全部来自后台记录**（规范化后），消息只用于比对
    executionSettings = confirmedSettings;
    executionItems = executionIds.map(id => {
      const fromRecord = confirmedById.get(id);
      const fromMessage = request.items.find(i => String(i.itemId) === id);
      return {
        itemId: id,
        name: fromRecord?.name ?? fromMessage?.name ?? `商品 ${id}`,
        status: fromRecord?.status ?? fromMessage?.status ?? 1,
        categoryPath: fromRecord?.categoryPath ?? fromMessage?.categoryPath ?? '',
      };
    });
  }

  // 计划与单次组任务必须**使用保存时的锚**，并且当前实际身份必须与之一致。
  let ownerShopId = identity.shopId;
  let ownerUserId = currentUserId;
  if (request.source === 'plan' || request.source === 'group') {
    const what = request.source === 'plan' ? '计划' : '本次安排';
    if (request.ownerShopId === undefined || request.ownerShopId === null) {
      const error = `${what}未绑定店铺归属，已拒绝执行（请重新保存）`;
      await recordStartError(error);
      return { success: false, error };
    }
    if (request.ownerUserId === undefined || request.ownerUserId === null) {
      const error = `${what}未绑定账号归属，已拒绝执行（请重新保存）`;
      await recordStartError(error);
      return { success: false, error };
    }
    if (request.ownerShopId !== identity.shopId) {
      const error = `当前店铺（${identity.shopId}）不是${what}绑定的店铺（${request.ownerShopId}），已拒绝执行`;
      await recordStartError(error);
      return { success: false, error };
    }
    if (currentUserId !== request.ownerUserId) {
      const error = `当前账号不是${what}绑定的账号（${request.ownerUserId}），已拒绝执行`;
      await recordStartError(error);
      return { success: false, error };
    }
    // 自报锚必须与它带来的快照一致：不一致说明消息被改过，直接拒绝（返工 20.1）
    if (
      executionRecord?.shopId !== request.ownerShopId ||
      executionRecord?.ownerUserId !== request.ownerUserId
    ) {
      const error = `${what}的归属锚与当轮预检快照不一致，已拒绝执行（请重新保存）`;
      await recordStartError(error);
      return { success: false, error };
    }
    ownerShopId = request.ownerShopId;
    ownerUserId = request.ownerUserId;
  }

  const now = Date.now();
  const taskId = `ship-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const task = createShippingTask({
    taskId,
    requestId: request.requestId,
    shopId: ownerShopId,
    ownerUserId,
    source: request.source ?? 'manual',
    planId: request.planId,
    occurrenceId: request.occurrenceId,
    groupId: request.groupId,
    groupPhase: request.groupPhase,
    mode: executionSettings.mode,
    days: Number(executionSettings.days),
    range: executionSettings.range,
    excludeIds: parseExcludeIds(executionSettings.excludeIds),
    total: executionItems.length,
    toggleLogistics: executionSettings.toggleLogistics,
    now,
  });

  // 任务接受必须先持久成功，再开始执行
  await saveTask(task);
  await recordStartError(null);
  _shippingRunningTaskId = taskId;
  _shippingStopRequested = false;
  /** 本次执行是否已经真正发出过"切现货"批次（用于 R2 区分首写窗口与全程截止） */
  let spotBatchSent = false;

  // 不 await：popup 关闭不影响后台推进
  /**
   * 单次组的**写截止**（第 34.3 节 R2，收敛于第 37.3 节）。
   *
   * 两条**不同**的约束，早先错用了同一条：
   * - **首写窗口**：第一次真正发出"切 1 天"必须落在 `min(startAt+5分钟, restoreAt)` 之前；
   * - **后续截止**：已经正常开始的分批允许超过 5 分钟（那是调度容差，不是执行上限），
   *   但到 `restoreAt` 必须停止发送**新的**切 1 天批次。
   *
   * 早先对**所有**批次都用首写窗口，于是 125 个商品里最后 25 个在第 6 分钟被误截
   * （第 36.2 节第 3 条）。现在把两个时刻分别交给 runner：`writeDeadlineAt` 是首写窗口，
   * `restoreAt` 是全程截止，由 `canSendSpotWrite` 按"是否已经发过第一批"选择用哪一个。
   */
  const groupStartAt = request.groupStartedAt;
  const groupRestoreAt = request.groupRestoreAt;
  const groupSpotDeadline =
    request.source === 'group' && request.groupPhase === 'spot' && typeof groupStartAt === 'number'
      ? spotWindowDeadline({
          startAt: groupStartAt,
          restoreAt: typeof groupRestoreAt === 'number' ? groupRestoreAt : Number.MAX_SAFE_INTEGER,
          spotDays: 1,
          regularDays: 2,
        })
      : null;
  const hardStop = typeof groupRestoreAt === 'number' ? groupRestoreAt : Number.MAX_SAFE_INTEGER;

  void runShippingTask(task, executionItems, buildRunnerDeps(deps), {
    spotPhase: request.source === 'group' && request.groupPhase === 'spot',
    canSendSpotWrite:
      request.source === 'group' && request.groupPhase === 'spot'
        ? () => {
            const now = Date.now();
            // 到恢复时刻一律停（不论是否已开始）
            if (now >= hardStop) return false;
            // 尚未真正发出过任何现货批次 → 仍受首写窗口约束
            if (!spotBatchSent && groupSpotDeadline !== null && now >= groupSpotDeadline) return false;
            return true;
          }
        : undefined,
    // 绝对截止交给 runner：请求一旦在它之后才轮到发出，就不再发送（第 34.3 节 R2）
    writeDeadlineAt: groupSpotDeadline,
    /** runner 在**真的发出**第一批后回调，用于把约束从"首写窗口"切换到"仅 restoreAt" */
    onSpotBatchSent: () => {
      spotBatchSent = true;
    },
    hardStopAt: hardStop,
    /**
     * 恢复阶段必须**先核实当前实际天数**再决定写不写（第 34.5 节 R4）：
     * 只恢复"确认仍是 1 天"的项；已是目标的不重复写；被改过或读不到的留需处理。
     */
    verifyCurrentDays:
      request.source === 'group' && request.groupPhase === 'restore'
        ? { expectedCurrent: 1, targetDays: Number(executionSettings.days) }
        : undefined,
  })
    .then(async result => {
      deps.log(
        `[shipping] 任务结束：${result.task.status} 成功 ${result.summary.counts.success} / 失败 ${
          result.summary.counts.failed
        } / 待核对 ${result.summary.counts.unknown}`,
        'info',
      );
      // 计划任务的**真实终态**在这里回写（R5）：不是"启动成功"，而是 runner 的结果。
      await writePlanTerminalResult(request, result.task).catch(() => {});
      await writeGroupTerminalResult(request, result.task).catch(() => {});
    })
    .catch(async (e: any) => {
      deps.log(`[shipping] 任务异常：${e?.message || e}`, 'error');
      const persisted = await readTask().catch(() => null);
      if (persisted && persisted.taskId === taskId) {
        const failed = patchShippingTask(persisted, {
          status: 'failed',
          phase: 'failed',
          error: redactSensitiveText(e),
          message: '任务异常结束',
          now: Date.now(),
        });
        await saveTask(failed).catch(() => {});
        await writePlanTerminalResult(request, failed).catch(() => {});
        await writeGroupTerminalResult(request, failed).catch(() => {});
      }
    })
    .finally(() => {
      if (_shippingRunningTaskId === taskId) {
        _shippingRunningTaskId = null;
        _shippingStopRequested = false;
        stopKeepalive();
      }
      // 跑完后立即检查是否还有下一轮（旧计划与单次组各自补检）
      void checkShippingPlans(deps);
      void checkShippingGroup(deps);
    });

  return { success: true, taskId };
}

/**
 * 把 runner 的真实终态写回对应计划（R5）。
 *
 * 只在 `occurrenceId` 匹配时写入，避免旧轮次结果覆盖新轮次。
 */
async function writePlanTerminalResult(
  request: ShippingStartRequest,
  task: ShippingTask,
): Promise<void> {
  if (request.source !== 'plan' || !request.planId || !request.occurrenceId) return;
  const plans = await readShippingPlans();
  const idx = plans.findIndex(p => p.id === request.planId);
  if (idx < 0) return;
  const taipeiDate = request.occurrenceId.split('@')[1] || taipeiDateString(Date.now());
  plans[idx] = applyPlanTerminalResult(plans[idx], {
    occurrenceId: request.occurrenceId,
    taipeiDate,
    now: Date.now(),
    result: task.status,
    taskId: task.taskId,
    error: task.error ?? null,
  });
  await savePlans(plans);
}

/**
 * 把 runner 的真实终态写回单次组（第 31 节）。
 *
 * 与计划回写同一手法：**只有真实结果**才推进阶段（不是"启动成功"就当成功）。
 * 组 ID／阶段都要匹配，迟到的旧任务不会改写已经结束的组。
 */
async function writeGroupTerminalResult(
  request: ShippingStartRequest,
  task: ShippingTask,
): Promise<void> {
  if (request.source !== 'group' || !request.groupId || !request.groupPhase) return;
  let record: ShippingGroupsRecord;
  try {
    record = await readShippingGroups();
  } catch (e) {
    logShippingBackground(`[shipping] 组终态回写读取失败：${redactSensitiveText(e)}`, 'error');
    return;
  }
  const active = record.active;
  /**
   * 迟到回调防护（第 34.6 节 R5）：必须核对 **groupId + 阶段 + 关联任务**。
   *
   * 只比 groupId 时，"本组上一阶段的旧回调"也会命中，从而把已经推进的阶段改回去。
   * 因此要求：组 ID 一致、阶段与请求一致、且该阶段的关联任务 ID 与本回调任务一致。
   */
  if (!active || active.groupId !== request.groupId) return;
  const expectedPhase = request.groupPhase;
  if (active.phase !== (expectedPhase === 'spot' ? 'cutting' : 'restoring')) return;
  const linkedTaskId = expectedPhase === 'spot' ? active.spotTaskId : active.restoreTaskId;
  if (linkedTaskId !== null && linkedTaskId !== task.taskId) return;

  /**
   * 物流证据来自**权威任务记录的重新读取**，不只看传进来的 `status/items`（第 34.6 节 R5）。
   *
   * 为什么必须重读：`writeGroupTerminalResult` 的调用方拿到的 task 是 runner 的返回值，
   * 其中物流字段可能不是最后落盘的那份（例如渠道恢复在收尾阶段又被标为失败）。
   * 重读能保证"组完成"的依据是**持久记录**，而不是某一次调用的入参。
   */
  const authoritative = await readTask().catch(() => null);
  const source = authoritative && authoritative.taskId === task.taskId ? authoritative : task;
  const pendingChannels = source.logistics.records.filter(r => needsLogisticsAction(r)).length;
  const logisticsSettled = pendingChannels === 0;

  const next = applyTaskResultToGroup(
    active,
    request.groupPhase,
    { status: source.status, items: source.items, logisticsSettled, pendingChannels },
    Date.now(),
  );
  record = {
    active: next.phase === 'done' ? null : next,
    lastFinished: next.phase === 'done' ? next : record.lastFinished,
    updatedAt: Date.now(),
  };
  await saveGroups(record).catch(() => {});
  await syncShippingGroupAlarm().catch(() => {});
}

/** 供本文件内部日志使用（与 deps.log 分开，避免终态回写时没有 deps 上下文）。 */
function logShippingBackground(message: string, level: 'info' | 'warn' | 'error' = 'info') {
  try {
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](message);
  } catch {
    /* 日志失败不影响业务 */
  }
}

// ===== 预检 =====

export async function handleShippingPreview(
  deps: ShippingBackgroundDeps,
  settings: ShippingSettings,
  requestId?: string,
): Promise<ShippingPreviewResult> {
  const previewSettings: ShippingPreviewSettings = {
    mode: modeForDays(Number(settings.days)),
    days: Number(settings.days),
    range: settings.range,
    excludeIds: settings.excludeIds,
    toggleLogistics: settings.toggleLogistics,
  };
  const runnerDeps = buildRunnerDeps(deps);
  const preview = await previewShippingTargets(runnerDeps, previewSettings);
  if (requestId) {
    // 记住**这份预览是谁确认的、确认的是什么**：启动时据此核对，免得换账号后旧预览还能被执行
    // （返工 14.1），也免得拿同一个请求号换一套内容执行（返工 17.1）。
    let shopId: number | null = null;
    let ownerUserId: number | null = null;
    try {
      const credential = await deps.getCredential();
      if (credential.spcCds) {
        const identity = await deps.getShopIdentity(credential);
        shopId = identity.shopId;
        ownerUserId = await deps.getAuthUserId();
      }
    } catch {
      // 核实不到就记 null：启动时会因"记录缺归属"而拒绝，要求重新预览
    }
    const record: ShippingPreviewRecord = {
      requestId,
      at: Date.now(),
      shopId,
      ownerUserId,
      // 确认时的设置与目标集合：后台记录是唯一依据，启动消息里的内容只用来比对（返工 17.1）
      settings: previewSettings,
      itemIds: preview.ok ? preview.items.map(i => String(i.itemId)) : [],
      result: preview,
    };
    // 落盘一份带 requestId 的结果：message 返回值可能被 content script 抢先应答，
    // 界面据此读取，保证"点了预检就一定有可读结果"
    await browser.storage.local.set({ [SHIPPING_PREVIEW_KEY]: record }).catch(() => {});
  }
  return preview;
}

/**
 * 排除选择器用的商品列表（只读）。
 *
 * 复用同一条 `fetchAllProducts`（cursor 分页），产出可搜索／按销量排序的候选；
 * 结果同样落盘并按 `requestId` 读取（消息返回值可能被 content script 抢先应答）。
 * **失败返回 `ok: false`**：界面据此提示"列表不可用"，而不是给出空列表让用户以为店铺没商品。
 */
export async function handleShippingPickList(
  deps: ShippingBackgroundDeps,
  requestId?: string,
): Promise<ShippingPickListResult> {
  const credential = await deps.getCredential();
  let result: ShippingPickListResult;
  if (!credential.spcCds) {
    result = { ok: false, error: '凭据已失效（Cookie 中找不到 SPC_CDS），请重新登录 seller.shopee.tw', products: [] };
  } else {
    const listed = await fetchAllProducts(deps.injectedFetch, credential);
    if (!listed.complete) {
      result = {
        ok: false,
        error: `商品列表读取不完整：${redactSensitiveText(listed.error || '未知原因')}`,
        products: [],
      };
    } else {
      result = {
        ok: true,
        products: listed.products.map(p => ({
          itemId: String(p.id),
          name: String(p.name || ''),
          status: Number(p.status),
          sold: toNullableNumber((p as any).sold),
          views: toNullableNumber((p as any).view_count),
        })),
      };
    }
  }
  if (requestId) {
    await browser.storage.local
      .set({ [SHIPPING_PICKLIST_KEY]: { requestId, at: Date.now(), result } satisfies ShippingPickListRecord })
      .catch(() => {});
  }
  return result;
}

/** 数值字段：缺失／非数值返回 null（不把"没有这个字段"当成 0）。 */
function toNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function handleShippingIdentity(
  deps: ShippingBackgroundDeps,
): Promise<{ shopId: number | null; userId: number | null }> {
  const credential = await deps.getCredential().catch(() => null);
  const identity = credential?.spcCds
    ? await deps.getShopIdentity(credential).catch(() => ({ shopId: null, accountId: null }))
    : { shopId: null, accountId: null };
  const userId = credential?.spcCds ? await deps.getAuthUserId().catch(() => null) : null;
  const record: ShippingIdentityRecord = { shopId: identity.shopId, userId, at: Date.now() };
  // 落盘一份：消息返回值可能被 content script 抢先应答，界面据此读取
  await browser.storage.local.set({ [SHIPPING_IDENTITY_KEY]: record }).catch(() => {});
  return { shopId: record.shopId, userId: record.userId };
}

// ===== 停止 =====

export async function handleShippingStop(): Promise<{ success: boolean }> {
  _shippingStopRequested = true;
  const task = await readTask();
  if (task && isShippingTaskActive(task)) {
    const patched = patchShippingTask(task, {
      stopRequested: true,
      phase: 'stopping',
      message: '已请求停止：不再发出后续商品写请求（已修改的备货天数保持）',
      now: Date.now(),
    });
    await saveTask(patched);
  }
  return { success: true };
}

// ===== 中断后的收尾 =====

/**
 * 用户核对完中断结果后结束本轮。
 *
 * 只把记录从 `interrupted` 推进到终态 `stopped`，**保留**逐项结果与检查点；
 * 不重放任何"结果未知"的商品（那需要用户自己重新预检后才能开始新一批）。
 */
export async function handleShippingAcknowledgeInterrupted(
  taskId: string,
): Promise<{ success: boolean; error?: string }> {
  const task = await readTask();
  if (!task) return { success: false, error: '没有任务记录' };
  if (taskId && task.taskId !== taskId) return { success: false, error: '任务记录已变化，请重新打开' };
  if (task.status !== 'interrupted') return { success: true };
  const patched = patchShippingTask(task, {
    status: 'stopped',
    phase: 'stopped',
    message: '用户已核对中断结果，本轮结束（未确认的商品不会被自动重放）',
    now: Date.now(),
  });
  await saveTask(patched);
  return { success: true };
}

// ===== 手动恢复物流 =====

export async function handleShippingRestoreLogistics(
  deps: ShippingBackgroundDeps,
): Promise<{ success: boolean; completed: boolean; error?: string }> {
  const task = await readTask();
  if (!task) return { success: false, completed: false, error: '没有可恢复的任务记录' };
  const result = await restorePendingLogistics(task, buildRunnerDeps(deps));
  /**
   * 物流收尾后**按权威记录重新同步组**（第 37.2 节 R5）。
   *
   * 少了这一步：商品已恢复、渠道也修好了，组却还停在"需处理"，用户既不能结束本组、
   * 也不能再次安排（第 36.2 节第 5 条实测）。
   */
  await reconcileGroupAfterLogisticsRestore().catch(() => {});
  return { success: true, completed: result.completed, error: result.error };
}

// ===== 孤儿协调 =====

/**
 * worker 重启后的协调：没有执行者的 running 记录标为 interrupted，并**保留**已有结果与检查点。
 * 不自动重放任何商品写请求（与一键修复同一口径）。
 */
export async function reconcileOrphanShippingTask(): Promise<boolean> {
  try {
    const task = await readTask();
    if (!task) return false;
    const resolved = resolveOrphanedShippingTask(task, _shippingRunningTaskId === task.taskId, null);
    if (resolved && resolved.status !== task.status) {
      await saveTask(resolved);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ===== 计划调度 =====

/**
 * 计划与补检的统一入口。
 *
 * 同时承担"丢 alarm／SW 休眠后的补检"：只处理**当前台湾日期**应执行而未执行的轮次，
 * 错过过去日期不补写历史（一次性标「已错过」，每日直接算下一轮）。
 */
export async function checkShippingPlans(deps: ShippingBackgroundDeps): Promise<void> {
  /**
   * 旧重复计划迁移（第 34.2 节 R1）：先把降级**真正落盘**，再决定是否调度。
   *
   * 顺序不能反：若先调度，`readShippingPlans()` 虽然返回降级版本，但盘上仍是 `enabled: true`，
   * 下一次别的入口读到就会重新启用（验收正是按"真实是否发过商品写"判定的）。
   * 落盘后 `plans.some(p => p.enabled)` 自然为假，旧 alarm 也会被清掉。
   */
  const storedPlans = await browser.storage.local.get(SHIPPING_PLANS_KEY);
  const rawPlans = storedPlans[SHIPPING_PLANS_KEY] as ShippingPlan[] | undefined;
  if (Array.isArray(rawPlans) && needsLegacyRetirementMigration(rawPlans)) {
    const migrated = retireLegacyRepeatPlans(rawPlans);
    await savePlans(migrated);
    deps.log(
      `[shipping] 旧的每日／每周重复计划已停用（保留记录与执行证据，共 ${
        migrated.filter(p => p.retired).length
      } 条），请在新版「定时切换」重新确认单次日期`,
      'warn',
    );
  }

  const plans = await readShippingPlans();
  if (!plans.some(p => p.enabled)) {
    await chrome.alarms.clear(SHIPPING_CHECK_ALARM).catch(() => {});
    return;
  }
  const now = Date.now();
  const task = await readTask();
  // 共享部分只读一次（身份／冲突／待恢复义务），每个计划只额外带上自己的归属锚
  const credential = await deps.getCredential();
  const identity = credential.spcCds
    ? await deps.getShopIdentity(credential).catch(() => ({ shopId: null, accountId: null }))
    : { shopId: null, accountId: null };
  const otherConflict = await deps.findOtherWriteConflict();
  const currentUserId = await deps.getAuthUserId().catch(() => null);
  const baseOccupancy = {
    shippingTaskActive: isShippingTaskActive(task),
    otherWriteConflict: otherConflict,
    pendingLogisticsRestore: Boolean(task && task.logistics.records.some(r => needsLogisticsAction(r))),
    identityOk: Boolean(credential.spcCds) && identity.shopId !== null,
    currentShopId: identity.shopId,
    currentUserId,
  };
  const decisions = decidePlanActions(
    plans,
    now,
    plan => ({ ...baseOccupancy, planOwnerShopId: plan.ownerShopId, planOwnerUserId: plan.ownerUserId }),
    task,
  );

  const nextPlans: ShippingPlan[] = [...plans];
  let changed = false;

  for (const decision of decisions) {
    const idx = nextPlans.findIndex(p => p.id === decision.planId);
    if (idx < 0) continue;
    const plan = nextPlans[idx];

    if (decision.kind === 'mark-missed') {
      nextPlans[idx] = { ...plan, missed: true, lastResult: plan.lastResult ?? null };
      changed = true;
      continue;
    }
    if (decision.kind === 'wait' || decision.kind === 'skip') {
      // 等待状态要写进记录，界面才能显示"需处理"，但**不推进日期**、也不改 lastResult 为成功
      nextPlans[idx] = {
        ...plan,
        lastResult: decision.kind === 'wait' ? 'waiting' : plan.lastResult,
        lastError: redactSensitiveText(decision.kind === 'wait' ? decision.reason : plan.lastError),
        updatedAt: now,
      };
      changed = true;
      continue;
    }

    // kind === 'run'：先持久占用（写 lastRunId 供"每轮至多一次"判定），
    // **不写 lastResult** —— 真实终态由 runner 结束后回写（R5）
    nextPlans[idx] = claimPlanOccurrence(plan, {
      occurrenceId: decision.occurrenceId,
      now,
      taskId: null,
    });
    await savePlans(nextPlans);
    changed = false;

    // 计划用自己的范围／排除／物流开关重新预检，不能用旧商品快照写
    const effective: ShippingSettings = {
      mode: modeForDays(decision.days),
      days: decision.days,
      range: plan.range,
      excludeIds: plan.excludeIds,
      toggleLogistics: plan.toggleLogistics,
    };

    // 计划按用户保存的规则**在真正执行前重新预检**
    const preview = await handleShippingPreview(deps, effective);
    if (!preview.ok || preview.items.length === 0) {
      nextPlans[idx] = applyPlanSkipped(plan, {
        occurrenceId: decision.occurrenceId,
        now,
        reason: preview.error || '预检没有可修改的商品',
      });
      await savePlans(nextPlans);
      continue;
    }

    // 归属锚：用**计划保存时核实的店铺与账号**，不是触发时的身份（R3）
    const startResult = await handleShippingStart(deps, {
      requestId: decision.occurrenceId,
      settings: effective,
      items: preview.items,
      source: 'plan',
      planId: plan.id,
      occurrenceId: decision.occurrenceId,
      ownerShopId: decision.ownerShopId,
      ownerUserId: decision.ownerUserId,
      // 当轮预检快照：启动处理据此核对内容并构造执行参数（返工 20.1）
      previewRecord: {
        requestId: decision.occurrenceId,
        at: now,
        shopId: decision.ownerShopId,
        ownerUserId: decision.ownerUserId,
        settings: {
          mode: effective.mode,
          days: effective.days,
          range: effective.range,
          excludeIds: effective.excludeIds,
          toggleLogistics: effective.toggleLogistics,
        },
        itemIds: preview.items.map(i => String(i.itemId)),
        result: preview,
      },
    });

    if (startResult.success) {
      // 记录本轮关联的任务 id；终态由 runShippingTask 结束后回写
      nextPlans[idx] = claimPlanOccurrence(plan, {
        occurrenceId: decision.occurrenceId,
        now,
        taskId: startResult.taskId ?? null,
      });
    } else {
      nextPlans[idx] = applyPlanSkipped(plan, {
        occurrenceId: decision.occurrenceId,
        now,
        reason: startResult.error || '启动被拒绝',
      });
    }
    await savePlans(nextPlans);
    // 一次只启动一个计划：其余计划下一轮补检再评估
    break;
  }

  if (changed) await savePlans(nextPlans);

  // 兜底补检 alarm：不依赖长期 setTimeout（worker 会被回收）
  const stillEnabled = nextPlans.some(p => p.enabled);
  if (stillEnabled) {
    chrome.alarms.create(SHIPPING_CHECK_ALARM, { periodInMinutes: SHIPPING_CHECK_INTERVAL_MINUTES });
  } else {
    await chrome.alarms.clear(SHIPPING_CHECK_ALARM).catch(() => {});
  }
}

/** 按当前计划列表重建/清理本功能 alarm（设置保存后调用）。 */
export async function syncShippingAlarms(): Promise<void> {
  const plans = await readShippingPlans();
  if (plans.some(p => p.enabled)) {
    chrome.alarms.create(SHIPPING_CHECK_ALARM, { periodInMinutes: SHIPPING_CHECK_INTERVAL_MINUTES });
  } else {
    await chrome.alarms.clear(SHIPPING_CHECK_ALARM).catch(() => {});
  }
  // 单次组的补检 alarm 与旧计划分开管理：两者语义不同，不能用一个开关互相关闭
  await syncShippingGroupAlarm().catch(() => {});
}

// ===== 单次组消息处理（第 31 节） =====

/**
 * 保存一组单次安排。
 *
 * 校验放在后台（31.3 要求"不能仅靠表单"）：界面被改过、或旧包带着循环模式来，
 * 都在这里被拒绝，不会因为只隐藏了 UI 就照旧执行。
 */
export async function handleShippingGroupSave(
  deps: ShippingBackgroundDeps,
  input: {
    groupId?: string;
    schedule?: Partial<ShippingGroupSchedule>;
    config?: Partial<ShippingGroupConfig>;
    executionMode?: unknown;
  },
): Promise<{ success: boolean; error?: string; groupId?: string }> {
  // 循环模式一律拒绝：本轮只支持单次（31.5）
  if (input.executionMode !== undefined && input.executionMode !== 'once') {
    const error = '本轮只支持单次执行，不接受每天／每周重复';
    await recordStartError(error);
    return { success: false, error };
  }
  const credential = await deps.getCredential();
  if (!credential.spcCds) {
    const error = '凭据已失效（Cookie 中找不到 SPC_CDS），请重新登录 seller.shopee.tw';
    await recordStartError(error);
    return { success: false, error };
  }
  const identity = await deps.getShopIdentity(credential).catch(() => ({ shopId: null, accountId: null }));
  const userId = await deps.getAuthUserId().catch(() => null);
  const now = Date.now();

  let record: ShippingGroupsRecord;
  try {
    record = await readShippingGroups();
  } catch (e) {
    const error = `读取已有安排失败：${redactSensitiveText(e)}`;
    await recordStartError(error);
    return { success: false, error };
  }

  // 互斥：已有运行／待恢复／结果未知时不允许绕过（31.5）
  const gate = canStartNewGroup(record);
  if (!gate.ok) {
    await recordStartError(gate.reason || '已有安排在进行中');
    return { success: false, error: gate.reason };
  }

  const schedule: ShippingGroupSchedule = {
    startAt: Number(input.schedule?.startAt),
    restoreAt: Number(input.schedule?.restoreAt),
    spotDays: SHIPPING_SPOT_DAYS,
    regularDays: Number(input.schedule?.regularDays),
  };
  const config: ShippingGroupConfig = {
    range: (input.config?.range as ShippingGroupConfig['range']) ?? 'all',
    excludeIds: String(input.config?.excludeIds ?? ''),
    toggleLogistics: input.config?.toggleLogistics === true,
  };

  const invalid = validateGroupInput({
    schedule,
    config,
    ownerShopId: identity.shopId,
    ownerUserId: userId,
    now,
  });
  if (invalid) {
    await recordStartError(invalid);
    return { success: false, error: invalid };
  }
  if (!isValidRegularDays(schedule.regularDays)) {
    const error = '常规备货天数必须是 2–10 之间的整数';
    await recordStartError(error);
    return { success: false, error };
  }

  const groupId = typeof input.groupId === 'string' && input.groupId ? input.groupId : `grp-${now}-${Math.random().toString(36).slice(2, 8)}`;
  const group = createShippingGroup({
    groupId,
    schedule,
    config,
    ownerShopId: identity.shopId,
    ownerUserId: userId,
    now,
  });
  // 上一次完成的组降级为历史（供"再次安排"带出配置），不覆盖它的恢复义务判定
  record = {
    active: group,
    lastFinished: record.lastFinished,
    updatedAt: now,
  };
  try {
    await saveGroups(record);
  } catch (e) {
    const error = `保存安排失败（未产生任何商品修改）：${redactSensitiveText(e)}`;
    await recordStartError(error);
    return { success: false, error };
  }
  await syncShippingGroupAlarm().catch(() => {});
  await recordStartError(null);
  return { success: true, groupId };
}

/** 撤销一组安排（未开始零写；已发过写请求则拒绝并保留恢复义务）。 */
export async function handleShippingGroupRevoke(): Promise<{ success: boolean; error?: string }> {
  const record = await readShippingGroups().catch(() => null);
  const active = record?.active;
  if (!record || !active) return { success: false, error: '当前没有可撤销的安排' };
  const { record: next, revoked, reason } = revokeGroup(active, Date.now());
  if (!revoked) return { success: false, error: reason };
  await saveGroups({
    active: null,
    lastFinished: next,
    updatedAt: Date.now(),
  });
  await syncShippingGroupAlarm().catch(() => {});
  return { success: true };
}

/** 只读同步：界面据此显示真实阶段（不依赖内存状态）。 */
export async function handleShippingGroupStatus(): Promise<ShippingGroupsRecord | null> {
  try {
    return await readShippingGroups();
  } catch {
    return null;
  }
}

/**
 * 停止一组**已开始**的安排（第 34.7 节 R6）。
 *
 * 与撤销的区别（这是验收明确指出的问题）：
 * - 未开始时 → 撤销整组，零写（`handleShippingGroupRevoke`）；
 * - **已开始后** → 不是"不允许停止"，而是**真正停止后续切现货批次**，
 *   同时**保留**已发出的结果、恢复义务与物流义务。早先直接调用撤销会被后台拒绝，
 *   于是按钮点了等于没点（组仍停在 `cutting`、`stopRequested` 依旧是 false）。
 *
 * 实现复用既有停止机制：置 `_shippingStopRequested` 并把任务记录的 `stopRequested` 落盘，
 * runner 的写边界据此停止发新批次；恢复阶段属于"必须继续的收尾"，不受停止影响。
 */
export async function handleShippingGroupStop(): Promise<{ success: boolean; error?: string }> {
  const record = await readShippingGroups().catch(() => null);
  const active = record?.active;
  if (!record || !active) return { success: false, error: '当前没有可停止的安排' };
  if (active.phase === 'done' || active.phase === 'missed') {
    return { success: false, error: '这一组已经结束' };
  }

  const stopped = await handleShippingStop();
  const refreshed = await readShippingGroups().catch(() => null);
  if (refreshed?.active) {
    const next = {
      ...refreshed.active,
      revision: refreshed.active.revision + 1,
      message:
        active.phase === 'scheduled'
          ? '已撤销本次安排（尚未开始，未修改任何商品）'
          : '已请求停止：不再发出后续切现货批次；已修改的商品仍会在恢复时刻改回常规天数',
      updatedAt: Date.now(),
    };
    await saveGroups({ ...refreshed, active: next, updatedAt: Date.now() }).catch(() => {});
  }
  return { success: stopped.success };
}

/**
 * 物流收尾完成后，按**权威商品 + 物流结果**同步组（第 37.2 节 R5，收敛于第 40.2 节）。
 *
 * 为什么必须有这一步：商品已恢复、但某个渠道恢复失败时，组会被正确地标成"需处理"；
 * 用户随后单独点「恢复物流」把它修好了，那条 `needs-attention` 却**没有任何路径重新核实**，
 * 于是组永远占着位置、不能结束也不能再次安排（第 36.2 节第 5 条）。
 *
 * **阶段必须取自权威任务本身，不能从组的当前阶段猜**（第 40.2 节）。
 * 早先写的是 `active.phase === 'restoring' ? 'restore' : ... : 'restore'`，
 * 于是 `awaiting-restore`／`needs-attention` 一律当成恢复段。首阶段（spot）渠道修好时，
 * 那条任务的逐项结果是**切现货的 success**，被当成"恢复成功"写进 `restore` 字段，
 * 组据此误报完成、清掉 active 与恢复 alarm —— 商品还停在 1 天，**常规恢复义务直接丢失**
 * （验收实测，最严重的一条）。
 *
 * 现在的口径：
 * - 阶段由 `task.groupPhase`（任务自己的持久归属）决定，且任务必须确实是本组**该段**的关联任务；
 * - **首阶段**渠道修好：只收尾首阶段的物流，保留 `awaiting-restore` 与商品义务，
 *   恢复仍按原时刻走（不动 `restore` 字段、不清 active、不撤恢复 alarm）；
 * - **恢复段**商品确已达标且渠道收尾 → 才结束整组。
 */
export async function reconcileGroupAfterLogisticsRestore(): Promise<
  'none' | 'closed' | 'still-pending' | 'spot-settled'
> {
  const record = await readShippingGroups().catch(() => null);
  const active = record?.active;
  if (!record || !active) return 'none';
  const task = await readTask().catch(() => null);
  if (!task || task.groupId !== active.groupId) return 'none';

  const pendingChannels = task.logistics.records.filter(r => needsLogisticsAction(r)).length;
  /** 阶段取自任务；缺失时退到"组当前正在跑的那一段"，仍不默认成恢复段 */
  const stage: 'spot' | 'restore' =
    task.groupPhase === 'spot' || task.groupPhase === 'restore'
      ? task.groupPhase
      : active.phase === 'restoring' || active.phase === 'cutting'
        ? active.phase === 'restoring'
          ? 'restore'
          : 'spot'
        : active.spotTaskId === task.taskId
          ? 'spot'
          : 'restore';

  if (stage === 'spot') {
    /**
     * 首阶段物流收尾：**只**确认渠道已恢复，绝不推进商品阶段。
     *
     * 这里连 `applyTaskResultToGroup` 都不能调：那个函数是"任务结束时的结果回写"，
     * 会按 spot 段的结果推进阶段；而这里发生的是"物流补做"，商品段的结论早已落盘。
     * 组保持原阶段，等 `restoreAt` 到了再按义务核实恢复。
     */
    if (pendingChannels > 0) return 'still-pending';
    const note = '首阶段的原店铺物流已恢复；商品恢复仍按原定时间进行';
    /**
     * 组若因为**这条渠道义务**停在 `needs-attention`，现在把它放回 `awaiting-restore`。
     *
     * 为什么必须放回：`needs-attention` 会让补检一直报"需处理"，用户看到的是"有问题要处理"；
     * 而渠道已经修好、商品义务还在，正确语义是"继续等原定时刻恢复"。
     * `advanceGroupPhase` 允许 `needs-attention → awaiting-restore`（第 37.2 节要求它不是死胡同）。
     * 只在**原因确实是渠道**时才放回，避免把别的冲突（如用户改成了第三种天数）一并放行。
     */
    const blockedByChannel = /渠道|物流/.test(`${active.error ?? ''}${active.message ?? ''}`);
    const nextActive =
      active.phase === 'needs-attention' && blockedByChannel
        ? advanceGroupPhase(active, 'awaiting-restore', Date.now(), {
            message: note,
            error: null,
          }) ?? { ...active, message: note, updatedAt: Date.now() }
        : { ...active, message: note, updatedAt: Date.now() };
    if (active.message !== note || nextActive.phase !== active.phase) {
      await saveGroups({ ...record, active: nextActive, updatedAt: Date.now() }).catch(() => {});
    }
    // 保留恢复 alarm：渠道修好不代表商品义务消失
    await syncShippingGroupAlarm().catch(() => {});
    return 'spot-settled';
  }

  const next = applyTaskResultToGroup(
    active,
    'restore',
    {
      status: task.status,
      items: task.items,
      logisticsSettled: pendingChannels === 0,
      pendingChannels,
    },
    Date.now(),
  );
  await saveGroups({
    active: next.phase === 'done' ? null : next,
    lastFinished: next.phase === 'done' ? next : record.lastFinished,
    updatedAt: Date.now(),
  }).catch(() => {});
  await syncShippingGroupAlarm().catch(() => {});
  return next.phase === 'done' ? 'closed' : 'still-pending';
}

// ===== 消息与 alarm 注册 =====

/** shipping 的消息类型集合；入口据此判断是否交给本模块处理。 */
export const SHIPPING_MESSAGE_TYPES = [
  'SHIPPING_PREVIEW',
  'SHIPPING_PRODUCT_LIST',
  'SHIPPING_IDENTITY',
  'SHIPPING_START',
  'SHIPPING_STOP',
  'SHIPPING_SYNC_ALARMS',
  'SHIPPING_RESTORE_LOGISTICS',
  'SHIPPING_ACK_INTERRUPTED',
  'SHIPPING_GROUP_SAVE',
  'SHIPPING_GROUP_REVOKE',
  'SHIPPING_GROUP_STOP',
  'SHIPPING_GROUP_STATUS',
] as const;

export function isShippingMessage(type: unknown): boolean {
  return typeof type === 'string' && (SHIPPING_MESSAGE_TYPES as readonly string[]).includes(type);
}

/** 处理一条 shipping 消息；非本模块消息返回 `undefined` 让入口继续分发。 */
export async function handleShippingMessage(
  deps: ShippingBackgroundDeps,
  msg: any,
): Promise<unknown | undefined> {
  const type = msg?.type;
  if (!isShippingMessage(type)) return undefined;

  if (type === 'SHIPPING_PREVIEW') {
    return await handleShippingPreview(
      deps,
      msg.settings as ShippingSettings,
      typeof msg.requestId === 'string' ? msg.requestId : undefined,
    );
  }
  if (type === 'SHIPPING_PRODUCT_LIST') {
    return await handleShippingPickList(deps, typeof msg.requestId === 'string' ? msg.requestId : undefined);
  }
  if (type === 'SHIPPING_IDENTITY') {
    return await handleShippingIdentity(deps);
  }
  if (type === 'SHIPPING_START') {
    return await handleShippingStart(deps, {
      requestId: String(msg.requestId || `manual-${Date.now()}`),
      settings: msg.settings as ShippingSettings,
      items: (msg.items as ShippingTargetItem[]) || [],
      source: 'manual',
      previewRequestId: typeof msg.previewRequestId === 'string' ? msg.previewRequestId : undefined,
    });
  }
  if (type === 'SHIPPING_STOP') {
    return await handleShippingStop();
  }
  if (type === 'SHIPPING_SYNC_ALARMS') {
    await syncShippingAlarms();
    // 保存计划后立刻评估一次：否则用户要等到下一个 alarm 周期（2 分钟）才看到效果
    await checkShippingPlans(deps);
    return { success: true };
  }
  if (type === 'SHIPPING_RESTORE_LOGISTICS') {
    return await handleShippingRestoreLogistics(deps);
  }
  if (type === 'SHIPPING_ACK_INTERRUPTED') {
    return await handleShippingAcknowledgeInterrupted(String(msg.taskId || ''));
  }
  if (type === 'SHIPPING_GROUP_SAVE') {
    return await handleShippingGroupSave(deps, {
      groupId: typeof msg.groupId === 'string' ? msg.groupId : undefined,
      schedule: msg.schedule as Partial<ShippingGroupSchedule> | undefined,
      config: msg.config as Partial<ShippingGroupConfig> | undefined,
      executionMode: msg.executionMode,
    });
  }
  if (type === 'SHIPPING_GROUP_REVOKE') {
    return await handleShippingGroupRevoke();
  }
  if (type === 'SHIPPING_GROUP_STOP') {
    return await handleShippingGroupStop();
  }
  if (type === 'SHIPPING_GROUP_STATUS') {
    return await handleShippingGroupStatus();
  }
  return undefined;
}

/** 处理 shipping 的 alarm；非本模块 alarm 返回 false 让入口继续分发。 */
export async function handleShippingAlarm(
  deps: ShippingBackgroundDeps,
  alarmName: string,
): Promise<boolean> {
  if (alarmName === SHIPPING_CHECK_ALARM) {
    await checkShippingPlans(deps);
    return true;
  }
  if (alarmName === SHIPPING_GROUP_ALARM) {
    await checkShippingGroup(deps);
    return true;
  }
  if (alarmName === SHIPPING_KEEPALIVE_ALARM) {
    // 保活本身不需要动作：alarm 触发就会唤醒 worker，让执行中的任务继续
    return true;
  }
  return false;
}

/** 计划轮次标识（供界面显示与调试对照，不在界面里拼字符串）。 */
export function planOccurrenceId(planId: string, nowMs: number, time: string): string {
  return buildOccurrenceId(planId, taipeiDateString(nowMs), time);
}
