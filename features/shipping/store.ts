/**
 * shipping 的**局部** store：只管本功能的设置、计划与任务只读镜像。
 *
 * 为什么不使用特卖 `store.ts`：那个 store 已经承载 Cookie／登录／特卖商品／SKU／复制／模板／
 * 自动模式／首次使用等多类职责（解耦审查 D1），继续往里加会让"改 shipping 参数"影响特卖的
 * 重置、持久化与监听。这里用独立 store + 独立 storage 键，界面切页／重开都能自恢复。
 *
 * 用户可编辑设置**即时落盘**（不是只在内存里），因此局部 store 被丢弃不等于用户设置丢失。
 */

import { create } from 'zustand';
import {
  SHIPPING_DEFAULT_SETTINGS,
  SHIPPING_GROUPS_KEY,
  SHIPPING_IDENTITY_KEY,
  SHIPPING_PICKLIST_KEY,
  SHIPPING_PLANS_KEY,
  SHIPPING_PREVIEW_KEY,
  SHIPPING_SETTINGS_KEY,
  SHIPPING_START_ERROR_KEY,
  SHIPPING_TASK_KEY,
  type ShippingGroup,
  type ShippingGroupsRecord,
  type ShippingIdentityRecord,
  type ShippingPickListRecord,
  type ShippingPickListResult,
  type ShippingPickableProduct,
  type ShippingPlan,
  type ShippingPlanRange,
  type ShippingPreviewRecord,
  type ShippingPreviewResult,
  type ShippingPreviewSettings,
  type ShippingSettings,
  type ShippingTask,
} from '@/features/shipping/types';
import { clampPlans, compareShippingConfirmedContent, defaultScheduleTimes, hasBlockingContentDiff, isValidDays, modeForDays, nextTaipeiDate, taipeiLocalToEpoch, taipeiTimeString, validateOneTimePlan, validateSettings, DEFAULT_RESTORE_TIME } from '@/features/shipping/rules';
import { validateGroupInput } from '@/features/shipping/group-rules';

export interface ShippingState {
  settings: ShippingSettings;
  plans: ShippingPlan[];
  task: ShippingTask | null;
  preview: ShippingPreviewResult | null;
  /** 这份预览对应的请求号与店铺（启动时交给后台核对归属，返工 14.1） */
  previewRequestId: string | null;
  previewShopId: number | null;
  previewOwnerUserId: number | null;
  /** 这份预览确认时的设置与商品集合（返工 17.1）：界面据此提示"内容已变，需重新预检" */
  previewSettings: ShippingPreviewSettings | null;
  previewItemIds: string[] | null;
  previewing: boolean;
  starting: boolean;
  error: string | null;
  notice: string | null;
  /** 当前已核实的店铺／账号归属；保存计划时写进计划（R3） */
  ownerShopId: number | null;
  ownerUserId: number | null;
  /** 排除选择器：候选商品与加载状态 */
  pickList: ShippingPickableProduct[];
  pickListLoading: boolean;
  pickListError: string | null;
  /** 当前候选列表所属的店铺（用于跨店隔离与"未核实归属不可选"，第 34.8 节 R7） */
  pickListShopId: number | null;
  /**
   * 当前候选列表所属的账号（第 43.2 节 R7）。
   * 同一家店可以换账号登入，只比店铺时旧账号的候选会被新账号认领。
   */
  pickListOwnerUserId: number | null;
  /** 单次成对安排（第 31 节）：本地草稿 + 后台权威记录只读镜像 */
  groupDraft: ShippingGroupDraft;
  group: ShippingGroup | null;
  groupLastFinished: ShippingGroup | null;
  groupSaving: boolean;

  loadFromStorage: () => Promise<void>;
  setOwner: (shopId: number | null, userId: number | null) => void;
  /** 重新核实当前归属（保存计划前用），并同步到 store */
  refreshOwner: () => Promise<boolean>;  updateSettings: (patch: Partial<ShippingSettings>) => Promise<void>;
  savePlan: (plan: ShippingPlan) => Promise<void>;
  removePlan: (planId: string) => Promise<void>;
  runPreview: () => Promise<ShippingPreviewResult | null>;
  clearPreview: () => void;
  loadPickList: () => Promise<void>;
  startTask: () => Promise<{ success: boolean; error?: string }>;
  stopTask: () => Promise<void>;
  restoreLogistics: () => Promise<{ success: boolean; completed: boolean; error?: string }>;
  /** 打断后的收尾：确认已核对结果、结束本轮，允许开始新一批（不自动重放） */
  acknowledgeInterrupted: () => Promise<void>;
  syncTask: () => Promise<void>;
  /** 只读同步计划记录（后台回写真实终态后界面刷新用） */
  syncPlans: () => Promise<void>;
  setNotice: (notice: string | null) => void;
  setError: (error: string | null) => void;
  /** 单次组：更新草稿（日期／时间／天数／排除／物流） */
  updateGroupDraft: (patch: Partial<ShippingGroupDraft>) => void;
  /**
   * 单次组：**仅当**草稿还是全新空白安排时补上默认时刻（第 53.3 节 U14）。
   * 已有日期／时刻／排除的草稿、以及"再次安排"带出的配置都不会被改动。
   */
  seedDefaultSchedule: () => void;
  /** 单次组：把草稿保存为后台权威安排（后台校验并落盘） */
  saveGroup: () => Promise<{ success: boolean; error?: string }>;
  /** 单次组：撤销整组（未开始零写） */
  revokeGroup: () => Promise<{ success: boolean; error?: string }>;
  /** 单次组：停止已开始的组（停止后续切现货批次，保留恢复与物流义务） */
  stopGroup: () => Promise<{ success: boolean; error?: string }>;
  /** 单次组：只读同步后台记录 */
  syncGroup: () => Promise<void>;
  /** 再次安排：把上一次已完成组的配置带进草稿（日期留待用户重新确认） */
  reuseLastGroup: () => void;
}

/**
 * 单次安排的本地草稿。
 *
 * 为什么界面有草稿而不是直接编辑后台记录：
 * 日期／时间在用户填完并点"确认并安排任务"之前都不该落盘成一个待执行安排，
 * 否则中途关掉弹窗会留下一个非法（例如时间已过）的组，后台还要处理它。
 * 落盘只发生在确认那一步，且以**后台校验通过**为准。
 */
export interface ShippingGroupDraft {
  /** 常规备货天数（2–10） */
  regularDays: number;
  /** 开始日期 `YYYY-MM-DD`（台湾） */
  startDate: string;
  /** 开始时间 `HH:mm`（台湾） */
  startTime: string;
  /** 恢复日期 */
  restoreDate: string;
  /** 恢复时间 */
  restoreTime: string;
  /**
   * 用户是否**手动改过恢复日期**（第 53.3 节 U14 第 2 点、第 56.2 节）。
   *
   * 为什么要记这一笔：默认规则要求"改开始日期时，恢复日期跟到其次日"，
   * 但"用户自己填的恢复日期不得被后续更新覆盖"。只有区分
   * "还是默认联动出来的" 与 "用户已经自己定过的"，两条要求才不冲突。
   *
   * 为什么只记日期、不记时间，两者要保护的东西不同：
   * - 恢复**日期**是"开始日期的次日"这条联动的产物，用户一旦自己选过就必须锁住；
   * - 恢复**时刻**（如上次复用的 02:15）与"哪一天恢复"无关，锁它没有依据 ——
   *   早先连时刻一起锁，导致"只改时刻→再改开始日"时恢复日停在旧值（第 56.2 节返工）。
   *   时刻本身不必额外标记：联动分支只在它为空时才补默认，已有值一律保留。
   */
  restoreDateTouched: boolean;
  /** 排除商品 ID（换行分隔） */
  excludeIds: string;
  /** 修改范围 */
  range: ShippingPlanRange;
  /** 是否自动管理店铺物流 */
  toggleLogistics: boolean;
}

async function persistSettings(settings: ShippingSettings) {
  await browser.storage.local.set({ [SHIPPING_SETTINGS_KEY]: settings });
}

/** 读取带 requestId 的预检结果；不是本次请求的结果就返回 null（避免读到上一次）。 */
async function readPreviewRecord(requestId: string): Promise<ShippingPreviewResult | null> {
  try {
    const stored = await browser.storage.local.get(SHIPPING_PREVIEW_KEY);
    const record = stored[SHIPPING_PREVIEW_KEY] as ShippingPreviewRecord | undefined;
    if (!record || record.requestId !== requestId) return null;
    return record.result;
  } catch {
    return null;
  }
}

/**
 * 等后台把本次预检结果落盘。
 *
 * 为什么不能只读一次：popup 发消息后，seller 页的 content script 会**同步**返回 `false`，
 * 这个响应会先于 background 的异步预检结束到达，于是 `sendMessage` 立刻 resolve。
 * 此时后台可能还没写完 `_shippingPreview`，只读一次就会误报"后台未返回结果"。
 */
async function awaitPreviewRecord(requestId: string, timeoutMs = 45000): Promise<ShippingPreviewResult | null> {
  const started = Date.now();
  for (;;) {
    const record = await readPreviewRecord(requestId);
    if (record) return record;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise(r => setTimeout(r, 300));
  }
}

/** 同上，用于排除选择器的商品列表。 */async function awaitPickListRecord(
  requestId: string,
  timeoutMs = 45000,
): Promise<ShippingPickListResult | null> {
  const started = Date.now();
  for (;;) {
    try {
      const stored = await browser.storage.local.get(SHIPPING_PICKLIST_KEY);
      const record = stored[SHIPPING_PICKLIST_KEY] as ShippingPickListRecord | undefined;
      if (record && record.requestId === requestId) return record.result;
    } catch {
      /* 读失败按未就绪处理 */
    }
    if (Date.now() - started > timeoutMs) return null;
    await new Promise(r => setTimeout(r, 300));
  }
}

function isPreviewResult(value: unknown): value is ShippingPreviewResult {
  return !!value && typeof value === 'object' && 'ok' in (value as object);
}

/**
 * 等身份记录落盘（`SHIPPING_IDENTITY` 的结果也写 storage，避免消息抢先应答）。
 */
async function awaitIdentityRecord(
  timeoutMs = 15000,
): Promise<{ shopId: number | null; userId: number | null } | null> {
  const started = Date.now();
  for (;;) {
    try {
      const stored = await browser.storage.local.get(SHIPPING_IDENTITY_KEY);
      const record = stored[SHIPPING_IDENTITY_KEY] as ShippingIdentityRecord | undefined;
      if (record && record.at && Date.now() - record.at < 60_000) return record;
    } catch {
      /* 未就绪继续等 */
    }
    if (Date.now() - started > timeoutMs) return null;
    await new Promise(r => setTimeout(r, 250));
  }
}

/** 读身份：先看消息返回值，拿不到再读落盘记录。 */
async function waitForIdentityRecord(): Promise<{ shopId: number | null; userId: number | null } | null> {
  return await awaitIdentityRecord();
}

async function persistPlans(plans: ShippingPlan[]) {
  await browser.storage.local.set({ [SHIPPING_PLANS_KEY]: clampPlans(plans) });
}

  /**
 * 候选列表请求的序号（第 43.2 节 R7）。
 *
 * 用来让"迟到的旧响应"失效，同时保证它**不会抹掉**已经加载好的新归属列表：
 * 只有序号仍等于最新值的请求才有权写列表与错误状态。
 */
let pickListRequestSeq = 0;

/** 单次安排的默认草稿：两个时刻都留空，强制用户自己选（不给"看起来已经安排好"的假象）。 */
export const SHIPPING_DEFAULT_GROUP_DRAFT: ShippingGroupDraft = {
  regularDays: 7,
  startDate: '',
  startTime: '',
  restoreDate: '',
  restoreTime: '',
  restoreDateTouched: false,
  excludeIds: '',
  range: 'all',
  toggleLogistics: false,
};

/** 台湾时刻 `HH:mm`（用于"再次安排"带出上次时间）。 */
function taipeiTimeOf(epochMs: number): string {
  return taipeiTimeString(epochMs);
}

/**
 * 把草稿的日期／时间转成台湾时刻的毫秒时间戳。
 *
 * 复用 `rules.ts` 的 `taipeiLocalToEpoch`（不依赖操作系统时区），
 * 因此同一份输入在任何机器上算出的时刻一致。
 */export function draftToEpoch(date: string, time: string): number | null {
  return taipeiLocalToEpoch(date, time);
}

export const useShippingStore = create<ShippingState>((set, get) => ({
  settings: { ...SHIPPING_DEFAULT_SETTINGS },
  /**
   * 旧计划初始为空列表（第 59.2 节）。
   *
   * 早先是 `SHIPPING_DEFAULT_PLANS`（两张空白占位），但那张表是**调度用的默认配置**，
   * 不是"用户有历史"的证据。初始即空可以避免"页面挂载后、`loadFromStorage` 回来之前"
   * 这一瞬间把占位渲染成两条假历史（冷打开时肉眼可见）。
   */
  plans: [],
  task: null,
  preview: null,
  previewRequestId: null,
  previewShopId: null,
  previewOwnerUserId: null,
  previewSettings: null,
  previewItemIds: null,
  previewing: false,
  starting: false,
  error: null,
  notice: null,
  ownerShopId: null,
  ownerUserId: null,
  pickList: [],
  pickListLoading: false,
  pickListError: null,
  pickListShopId: null,
  pickListOwnerUserId: null,
  groupDraft: { ...SHIPPING_DEFAULT_GROUP_DRAFT },
  group: null,
  groupLastFinished: null,
  groupSaving: false,

  /** 由外壳在身份就绪后调用：保存计划时要用这份归属（R3） */
  setOwner: (shopId, userId) => {
    /**
     * 换店／换账号时**清空上一家店的候选与草稿**（第 34.8 节 R7）。
     *
     * 为什么不能沿用：`pickList` 是某一家店的商品列表，`groupDraft` 里的排除 ID 也来自那家店。
     * 如果切店后还留着，用户会看到并勾选到**别家店**的商品，甚至把 A 店的排除集合
     * 随 B 店的新组一起提交（验收在真实 store 上复现过）。
     * 这里以"已核实归属发生变化"为界清理一次，同店重复设置不清。
     */
    const prevShop = get().ownerShopId;
    const prevUser = get().ownerUserId;
    const changed = (prevShop !== null && prevShop !== shopId) || (prevUser !== null && prevUser !== userId);
    set({
      ownerShopId: shopId,
      ownerUserId: userId,
      ...(changed
        ? {
            pickList: [],
            pickListError: null,
            pickListShopId: null,
            pickListOwnerUserId: null,
            /**
             * 归属变化 → 清空草稿，并**重新套用默认时刻**（第 53.3 节 U14 第 1 点）。
             *
             * 为什么这里也要给默认值：换店／换账号后用户面对的是一个全新空白安排，
             * 与首次打开同一种情形。留空会让"默认时间"只在首次挂载出现，切一次店就没了。
             * 时刻按**当时**的台湾日期算，不用模块加载时的快照。
             */
            groupDraft: { ...SHIPPING_DEFAULT_GROUP_DRAFT, ...defaultScheduleTimes(Date.now()) },
            groupLastFinished: null,
            notice: '已切换店铺／账号，上一家店的排除商品与草稿已清空，请重新选择',
          }
        : {}),
    });
  },

  /**
   * 重新核实当前店铺与账号归属。
   *
   * 从背景**现读**（`/api/v2/login/` 与 `backendAuth`），不使用启动时的快照：
   * 用户可能在弹窗打开期间换了店铺／账号，计划归属必须用核实到的那一刻的值。
   */
  /**
   * 重新核实当前店铺与账号归属。
   *
   * 从背景**现读**（`/api/v2/login/` 与 `backendAuth`），不使用启动时的快照：
   * 用户可能在弹窗打开期间换了店铺／账号，计划归属必须用核实到的那一刻的值。
   *
   * **走与 `setOwner` 同一条归属处理**（第 37.4 节 R7）：早先这里直接 `set` 归属，
   * 绕过了"换店要清空候选与草稿"的逻辑，于是真实 refreshOwner 路径下
   * A 店的排除集合会被带进 B 店的新组。凡是要写归属的地方都必须经 `setOwner`。
   */
  refreshOwner: async () => {
    try {
      const result = (await browser.runtime.sendMessage({ type: 'SHIPPING_IDENTITY' })) as
        | { shopId?: number | null; userId?: number | null }
        | undefined;
      const record = result && typeof result === 'object' ? result : await waitForIdentityRecord();
      if (!record) return false;
      get().setOwner(record.shopId ?? null, record.userId ?? null);
      return record.shopId !== null && record.shopId !== undefined;
    } catch {
      return false;
    }
  },

  /** 排除选择器：读取真实商品列表（只读），供搜索与按销量挑选排除项 */
  loadPickList: async () => {
    set({ pickListLoading: true, pickListError: null });
    const requestId = `pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    /**
     * 只有**最新一次**发起的请求有权决定最终列表（第 43.2 节 R7）。
     *
     * 为什么需要序号：迟到的旧响应若不区分先后，会把新归属已经加载好的列表**抹掉**
     * （晚到的旧请求既不该写内容，也不该写"已切换"的错误状态）。序号只用于
     * "谁最后说话"，不引入新的状态框架。
     */
    pickListRequestSeq += 1;
    const mySeq = pickListRequestSeq;
    // 记录"这一份候选属于哪个店铺／账号"，返回时据此判定完整归属（第 34.8／43.2 节 R7）
    const shopAtLoad = get().ownerShopId;
    const userAtLoad = get().ownerUserId;
    try {
      await browser.runtime.sendMessage({ type: 'SHIPPING_PRODUCT_LIST', requestId });
      const result = await awaitPickListRecord(requestId);
      /** 期间又发起过一次列表请求 → 本次结果已被取代，静默作废（不覆盖新结果） */
      if (mySeq !== pickListRequestSeq) return;
      if (!result) {
        set({ pickListLoading: false, pickListError: '后台未返回商品列表，请重试' });
        return;
      }
      if (!result.ok) {
        set({ pickListLoading: false, pickListError: result.error || '商品列表不可用', pickList: [] });
        return;
      }
      /**
       * **迟到响应不得回灌新归属**（第 40.5／43.2 节 R7）。
       *
       * A 店（账号 1）的列表请求发出后用户切到 B 店或同店换账号：
       * `setOwner` 已清空列表，但 A 的响应稍后才回来。早先这里无条件 `set`，
       * 于是旧归属的商品又被装回列表（`pickListShopId` 却仍是清空后的 null），
       * 用户就能把旧归属的商品确认进新归属的安排里。
       * 现在比较"请求发起时的完整归属"与"当前已核实归属"，不一致就整份丢弃。
       */
      const current = { shopId: get().ownerShopId, userId: get().ownerUserId };
      if (
        shopAtLoad === null ||
        userAtLoad === null ||
        shopAtLoad !== current.shopId ||
        userAtLoad !== current.userId
      ) {
        set({
          pickListLoading: false,
          pickList: [],
          pickListShopId: null,
          pickListOwnerUserId: null,
          pickListError: '已切换店铺／账号，本次列表结果已丢弃，请重新加载',
        });
        return;
      }
      set({
        pickListLoading: false,
        pickList: result.products,
        pickListShopId: shopAtLoad,
        pickListOwnerUserId: userAtLoad,
        pickListError: null,
      });
    } catch (e: any) {
      if (mySeq !== pickListRequestSeq) return;
      set({ pickListLoading: false, pickListError: `读取商品列表失败：${e?.message || String(e)}` });
    }
  },

  /** 冷打开时把用户设置与后台任务读回来；读失败保持原值，不伪称空闲 */
  loadFromStorage: async () => {
    try {
      const stored = await browser.storage.local.get([
        SHIPPING_SETTINGS_KEY,
        SHIPPING_PLANS_KEY,
        SHIPPING_TASK_KEY,
        SHIPPING_PREVIEW_KEY,
      ]);
      const settings = { ...SHIPPING_DEFAULT_SETTINGS, ...((stored[SHIPPING_SETTINGS_KEY] as object) || {}) };
      /**
       * 旧计划：**没有键就不要造出默认槽位**（第 59.2 节）。
       *
       * 早先这里是 `: SHIPPING_DEFAULT_PLANS`，于是从未设置过旧计划的人（无键）
       * 会拿到两张空白占位，界面照 `plans.length > 0` 显示成两条"未绑定，请重新保存"的安排。
       * 那是**不存在的历史**，而且指向的"重新保存"入口本轮已下线。
       * 空列表与"真的存过旧计划"在界面上的表现因此得以区分；后台仍照旧提供自己的默认槽位
       * （调度语义不变），这里只改界面所依据的这份状态。
       */
      const plans = Array.isArray(stored[SHIPPING_PLANS_KEY])
        ? clampPlans(stored[SHIPPING_PLANS_KEY] as ShippingPlan[])
        : [];
      const task = (stored[SHIPPING_TASK_KEY] as ShippingTask | undefined) ?? null;
      /**
       * 预览也要一起读回来：归属是写在**预览记录**里的。
       * 若只把预览放在内存，用户关掉弹窗再打开（或切到别的功能页再回来）时
       * 界面就看不到"这份预览属于哪个店铺／账号"，失效提示与开始按钮的禁用也随之丢失，
       * 而后台仍会在启动时拒绝 —— 界面说的和后台做的就不一致了（返工 14.1）。
       */
      const previewRecord = stored[SHIPPING_PREVIEW_KEY] as ShippingPreviewRecord | undefined;
      const preview =
        previewRecord?.result && previewRecord.result.ok && previewRecord.result.items.length > 0
          ? previewRecord.result
          : null;
      set({
        settings,
        plans: clampPlans(plans),
        task,
        preview,
        previewRequestId: preview ? previewRecord?.requestId ?? null : null,
        previewShopId: preview ? previewRecord?.shopId ?? null : null,
        previewOwnerUserId: preview ? previewRecord?.ownerUserId ?? null : null,
        previewSettings: preview ? previewRecord?.settings ?? null : null,
        previewItemIds: preview ? previewRecord?.itemIds ?? null : null,
      });
    } catch (e: any) {
      set({ error: `读取备货设置失败：${e?.message || String(e)}` });
    }
  },

  /** 用户可编辑设置即时落盘：局部 store 丢失不等于设置丢失 */
  updateSettings: async patch => {
    const next: ShippingSettings = { ...get().settings, ...patch };
    if (patch.days !== undefined) {
      const days = Number(patch.days);
      next.days = days;
      // 模式与天数必须自洽，避免界面显示"预售"却按 1 天提交
      next.mode = modeForDays(days);
    }
    // 改设置就作废这份预览：天数／范围／排除／物流任一变化后，原确认内容都不再有效。
    // 只清 `preview` 而留着请求号／归属锚会造成"界面没有预览、后台却还认这份记录"的错位。
    set({
      settings: next,
      error: null,
      preview: null,
      previewRequestId: null,
      previewShopId: null,
      previewOwnerUserId: null,
      previewSettings: null,
      previewItemIds: null,
    });
    await persistSettings(next);
  },

  savePlan: async plan => {
    /**
     * R1（第 34.2 节）：**旧的两项独立重复计划不再接受保存**。
     *
     * 为什么在保存处直接拒绝而不是只停用：验收是按"是否真的发出商品写"判定的，
     * 只要还能从任何入口存下一条 `enabled` 的重复计划，旧每日任务就会重新跑起来。
     * 这里给明确原因，并引导用户改用新版的单次「定时切换」。
     */
    if (plan.loopDaily) {
      set({
        error: '旧的每日／每周重复计划已停用，请改用上方「定时切换」安排单次执行（可指定开始与恢复时间）',
      });
      return;
    }
    /**
     * 第 56.3 节：**旧计划不能再被启用**，一律拒绝写 `enabled`。
     *
     * 只把 UI 的编辑表单改成只读还不够 —— 界面不是唯一入口（消息、旧版本页面、
     * 残留的调用都可能到这里）。一条 `enabled` 的旧计划会写 `_shippingPlans`
     * 并让 `shipping_plan_check` 重新调度，从而绕过"切到 1 天后必须有恢复安排"
     * 这条唯一主路径。所以拒绝点放在唯一会落盘的地方。
     * 记录本身不删：历史仍可追溯（`enabled: false` 的旧记录照常保留）。
     */
    if (plan.enabled) {
      set({
        error: '旧版计划入口已下线，不能再启用；请用上方「定时切换」安排单次执行（切 1 天后会按你选的天数恢复）',
      });
      return;
    }
    const existing = get().plans;
    const idx = existing.findIndex(p => p.id === plan.id);
    // 一次性计划：按台湾时间拒绝无效／已过时间（R5）
    const err = validateOneTimePlan(plan.date, plan.time, Date.now());
    if (err) {
      set({ error: err });
      return;
    }
    if (!isValidDays(plan.days)) {
      set({ error: '计划的天数必须是 1–10 的整数' });
      return;
    }
    // 绑定**保存当时已核实的**店铺与账号归属：执行时必须用它，不能用触发时的身份（R3）
    const ownerShopId = get().ownerShopId;
    const ownerUserId = get().ownerUserId;
    if (ownerShopId === null || ownerUserId === null) {
      set({ error: '无法核实当前店铺或账号身份，请先打开卖家中心页面并确认已登录，再保存计划' });
      return;
    }
    const bound: ShippingPlan = {
      ...plan,
      loopDaily: false,
      retired: false,
      retiredReason: undefined,
      ownerShopId,
      ownerUserId,
      updatedAt: Date.now(),
    };
    const next = idx >= 0 ? existing.map(p => (p.id === plan.id ? bound : p)) : [...existing, bound];
    const clamped = clampPlans(next);
    // 落盘成功后才显示"已保存"（R5）
    try {
      await persistPlans(clamped);
    } catch (e: any) {
      set({ error: `计划保存失败：${e?.message || String(e)}` });
      return;
    }
    set({ plans: clamped, notice: '计划已保存（后台触发）', error: null });
    // 让后台按新计划重建／清理本功能 alarm；调用失败不回滚已保存的计划
    await browser.runtime.sendMessage({ type: 'SHIPPING_SYNC_ALARMS' }).catch(() => {});
  },

  removePlan: async planId => {
    const next = get().plans.map(p => (p.id === planId ? { ...p, enabled: false, lastRunId: null, missed: false } : p));
    set({ plans: next, notice: '计划已关闭' });
    await persistPlans(next);
    await browser.runtime.sendMessage({ type: 'SHIPPING_SYNC_ALARMS' }).catch(() => {});
  },

  /**
   * 中断后的收尾：用户点「已核对结果，结束本轮」时调用。
   *
   * 为什么需要它：中断态会阻止开始新一批（这是对的：结果未确认时不该继续写），
   * 但**不能永远卡住用户**。用户核对完商品实际状态后需要一个明确的出口。
   * 这里只把记录标成 `stopped`（终态）并保留逐项结果与检查点，
   * **不自动重放任何未知商品**。
   */
  acknowledgeInterrupted: async () => {
    const task = get().task;
    if (!task || task.status !== 'interrupted') return;
    try {
      await browser.runtime.sendMessage({ type: 'SHIPPING_ACK_INTERRUPTED', taskId: task.taskId }).catch(() => {});
      await get().syncTask();
    } catch (e: any) {
      set({ error: `结束本轮失败：${e?.message || String(e)}` });
    }
  },

  /** 只读预检：零写请求，产出「最终目标预览」 */
  runPreview: async () => {
    const settings = get().settings;
    const settingsError = validateSettings(settings);
    if (settingsError) {
      set({ error: settingsError, preview: null });
      return null;
    }
    set({ previewing: true, error: null, notice: null, preview: null });
    const requestId = `prev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const sent = (await browser.runtime.sendMessage({
        type: 'SHIPPING_PREVIEW',
        requestId,
        settings,
      })) as ShippingPreviewResult | undefined;

      // 消息返回值可能被 content script 抢先应答（拿到 undefined／false），
      // 且这个抢先响应会早于后台预检结束；因此以 storage 里那份带 requestId 的结果为准。
      const preview = (await awaitPreviewRecord(requestId)) ?? (isPreviewResult(sent) ? sent : null);
      if (!preview) {
        set({ previewing: false, error: '后台未返回预检结果，请重试' });
        return null;
      }
      if (!preview.ok) {
        set({ previewing: false, preview: null, error: preview.error || '预检失败' });
        return preview;
      }
      if (preview.items.length === 0) {
        set({
          previewing: false,
          preview,
          error: '预检没有可修改的商品：请检查范围与排除设置',
        });
        return preview;
      }
      // 记住请求号与**确认时的内容**：启动时交给后台核对归属（14.1）与内容（17.1）
      set({
        previewing: false,
        preview,
        previewRequestId: requestId,
        previewShopId: preview.shopId,
        previewOwnerUserId: get().ownerUserId,
        previewSettings: {
          mode: modeForDays(Number(settings.days)),
          days: Number(settings.days),
          range: settings.range,
          excludeIds: settings.excludeIds ?? '',
          toggleLogistics: settings.toggleLogistics === true,
        },
        previewItemIds: preview.items.map(i => String(i.itemId)),
        notice: `预检完成：${preview.items.length} 个商品将修改为 ${
          settings.days === 1 ? '现货 1 天' : `预售 ${settings.days} 天`
        }`,
      });
      return preview;
    } catch (e: any) {
      set({ previewing: false, error: `预检失败：${e?.message || String(e)}` });
      return null;
    }
  },

  clearPreview: () =>
    set({ preview: null, previewRequestId: null, previewShopId: null, previewOwnerUserId: null, previewSettings: null, previewItemIds: null }),

  /** 启动：只把用户已确认的集合交给后台；不做第二次过滤（后台会重新核对归属与排除） */
  startTask: async () => {
    const { preview, settings, previewRequestId } = get();
    if (!preview?.ok || preview.items.length === 0) {
      set({ error: '请先完成预检并确认目标' });
      return { success: false, error: '请先完成预检' };
    }
    if (!previewRequestId) {
      set({ error: '缺少预览请求号，请重新预检后再开始' });
      return { success: false, error: '请重新预检' };
    }
    const settingsError = validateSettings(settings);
    if (settingsError) {
      set({ error: settingsError });
      return { success: false, error: settingsError };
    }
    /**
     * 物流开关必须是真正的 boolean（返工 20.1）。
     *
     * 后台会拒绝非 boolean，界面先拦一道：否则字符串 `"true"` 这种值
     * 会一路走到后台才被拒，用户看到的是一句不太好懂的错误。
     */
    if (typeof settings.toggleLogistics !== 'boolean') {
      const error = '「自动管理店铺物流」的值不合法，请重新预检后再开始';
      set({ error });
      return { success: false, error };
    }
    /**
     * 内容自检（返工 17.1）：界面先自己发现"这份预览确认的不是现在这套内容"，
     * 就不用等后台拒绝。后台的记录仍是最终依据（那里也会比对），这里只是让提示更快、更清楚。
     */
    const { previewSettings, previewItemIds } = get();
    if (previewSettings && previewItemIds) {
      const localDiffs = compareShippingConfirmedContent(
        { settings: previewSettings, itemIds: previewItemIds },
        {
          settings: {
            mode: modeForDays(Number(settings.days)),
            days: Number(settings.days),
            range: settings.range,
            excludeIds: settings.excludeIds ?? '',
            toggleLogistics: settings.toggleLogistics,
          },
          // 只把"已确认集合之外的商品"当作新增：单纯减少是既有规则允许的
          itemIds: [...previewItemIds, ...preview.items.map(i => String(i.itemId)).filter(id => !previewItemIds.includes(id))],
        },
      );
      if (hasBlockingContentDiff(localDiffs)) {
        const error = '设置或目标已与预检时不同，请重新预检后再开始';
        set({ error, preview: null, previewRequestId: null, previewSettings: null, previewItemIds: null });
        return { success: false, error };
      }
    }
    set({ starting: true, error: null, notice: null });
    try {
      const result = (await browser.runtime.sendMessage({
        type: 'SHIPPING_START',
        requestId: `manual-${Date.now()}`,
        previewRequestId,
        settings,
        items: preview.items,
      })) as { success?: boolean; error?: string } | undefined;
      if (result && result.success === false) {
        set({ starting: false, error: result.error || '后台未能接受任务' });
        return { success: false, error: result.error };
      }
      if (!result) {
        // 消息返回值不可靠：不重发、不谎报失败，改读后台写的权威拒绝原因
        const stored = await browser.storage.local.get(SHIPPING_START_ERROR_KEY);
        const rejection = (stored[SHIPPING_START_ERROR_KEY] as { error?: string } | undefined)?.error;
        if (rejection) {
          set({ starting: false, error: rejection, preview: null, previewRequestId: null });
          return { success: false, error: rejection };
        }
        set({ starting: false, notice: '已提交给后台，正在等待任务记录' });
      } else {
        set({ starting: false, notice: '任务已开始，可关闭弹窗，后台会继续', preview: null, previewRequestId: null });
      }
      await get().syncTask();
      return { success: true };
    } catch (e: any) {
      set({ starting: false, error: `启动失败：${e?.message || String(e)}` });
      return { success: false, error: e?.message };
    }
  },

  stopTask: async () => {
    await browser.runtime.sendMessage({ type: 'SHIPPING_STOP' }).catch(() => {});
    set({ notice: '已请求停止：不再发出后续商品写请求（已修改的备货天数保持）' });
    await get().syncTask();
  },

  restoreLogistics: async () => {
    try {
      const result = (await browser.runtime.sendMessage({ type: 'SHIPPING_RESTORE_LOGISTICS' })) as
        | { success?: boolean; completed?: boolean; error?: string }
        | undefined;
      await get().syncTask();
      return {
        success: result?.success !== false,
        completed: result?.completed === true,
        error: result?.error,
      };
    } catch (e: any) {
      set({ error: `恢复物流失败：${e?.message || String(e)}` });
      return { success: false, completed: false, error: e?.message };
    }
  },

  /** 只读同步后台任务到界面：不启动任何东西 */
  syncTask: async () => {
    try {
      const stored = await browser.storage.local.get(SHIPPING_TASK_KEY);
      set({ task: (stored[SHIPPING_TASK_KEY] as ShippingTask | undefined) ?? null });
    } catch {
      /* 读失败保持原值，不伪称空闲 */
    }
  },

  /** 只读同步计划记录：后台会回写真实终态，界面必须能刷新（R5） */
  syncPlans: async () => {
    try {
      const stored = await browser.storage.local.get(SHIPPING_PLANS_KEY);
      const plans = stored[SHIPPING_PLANS_KEY] as ShippingPlan[] | undefined;
      // 同步也过一遍降级：否则界面可能显示一条"启用中的每日计划"，而后台已拒绝执行（R1）
      /**
       * 无键／非数组时同步成**空列表**（第 59.2 节），不要保留上一次的值：
       * 旧计划键被清掉后，后台的 `onChanged` 也会走到这里；若沿用旧值，
       * 界面会继续显示已经不存在的"历史"。空列表是这里的真值。
       */
      set({ plans: Array.isArray(plans) ? clampPlans(plans) : [] });
    } catch {
      /* 读失败保持原值 */
    }
  },

  setNotice: notice => set({ notice }),
  setError: error => set({ error }),

  // ===== 单次成对安排（第 31 节） =====

  /**
   * 更新草稿。除了合并字段，还负责第 53.3 节 U14 的**默认联动**：
   *
   * - 用户改**开始日期**，且恢复日期还是自动联动出来的（`restoreDateTouched === false`）
   *   → 恢复日期自动跟到"开始日期的次日"；
   * - 用户改**恢复日期** → 记为"已手动编辑"，之后不再自动联动；
   * - 用户改**恢复时刻**或**开始时间**不触发联动（恢复是"开始日期的次日"，与几点无关），
   *   也**不锁日期**（第 56.2 节：锁日期会让"只改时刻→改开始日"把恢复日留在过去）。
   *
   * 为什么联动时**保留**已有的恢复时刻、只在为空时补默认：
   * "再次安排"会把上次的恢复时刻带出来（复用时恢复日期仍是空的）。若无条件写回默认 01:30，
   * 就把用户上次设的 02:15 之类悄悄改成 01:30，违背"再次安排沿用上次时刻"的原契约。
   *
   * 为什么联动放在这里而不是 UI：草稿的所有改动入口（表单、再次安排、换店重置）
   * 都要经过它，规则集中一处才不会有的地方联动、有的地方不联动。
   */
  updateGroupDraft: patch => {
    const prev = get().groupDraft;
    const next: ShippingGroupDraft = { ...prev, ...patch };

    /**
     * 第 56.2 节返工：**只有用户真正改了恢复日期**才锁住日期。
     *
     * 早先这里把"改恢复时刻"也一起锁了，于是"只改时刻 04:15 → 再改开始日 10-21"时，
     * 恢复日期停在旧的 10-17（验收在原生 popup 与实际 store 上都复现了：
     * 开始 2100-01-02、恢复仍是 2100-01-01 04:15，预期 2100-01-03 04:15）。
     * 两类编辑要保护的东西不同：
     * - 恢复**日期**的默认值是联动的产物，用户自己选过就必须锁住；
     * - 恢复**时刻**是用户设的"几点恢复"，与"哪一天恢复"无关，锁它没有依据。
     * 时刻本身不需要额外标记：联动分支只在它为空时才补默认，已有值一律保留。
     */
    if (patch.restoreDate !== undefined) {
      next.restoreDateTouched = true;
    } else if (
      patch.startDate !== undefined &&
      patch.startDate !== prev.startDate &&
      !prev.restoreDateTouched &&
      /^\d{4}-\d{2}-\d{2}$/.test(patch.startDate)
    ) {
      next.restoreDate = nextTaipeiDate(patch.startDate);
      if (!next.restoreTime) next.restoreTime = DEFAULT_RESTORE_TIME;
    }

    set({ groupDraft: next, error: null });
  },

  /**
   * 给"全新空白安排"补默认时刻（第 53.3 节 U14）。
   *
   * 为什么单独一个动作而不写进初始 state：初始 state 是**模块加载时**求值的，
   * popup 可能跨天常驻，那样默认值会以昨天的日期算出来。
   * 为什么不直接覆盖：`syncGroup` 会把"上一次已完成配置"（同店同账号）带进草稿
   * ——那是第 31 节明确要求的"再次安排沿用上次时刻"。若无条件覆盖，
   * 就把复用变成了自动下一轮。所以只在草稿**确实空**时补。
   */
  seedDefaultSchedule: () => {
    const d = get().groupDraft;
    const empty =
      !d.startDate && !d.startTime && !d.restoreDate && !d.restoreTime && !d.excludeIds;
    if (!empty) return;
    set({ groupDraft: { ...d, ...defaultScheduleTimes(Date.now()) } });
  },

  /**
   * 保存单次安排。
   *
   * 界面先做同一份校验（好让按钮即时禁用并给出原因），但**以后台结果为准**：
   * 后台会重新核实店铺／账号归属并写入自己的锚，界面无法绕过（31.3／31.5）。
   */
  saveGroup: async () => {
    const draft = get().groupDraft;
    /**
     * **先固定这次保存所依据的草稿归属**（第 40.5 节 R7），再去做任何身份刷新。
     *
     * 为什么必须在**第一次** `refreshOwner` 之前就固定：早先的顺序是
     * "捕获 A 草稿 → 首次刷新成 B（`setOwner` 清空草稿）→ 取 shopBefore（此时已是 B）→
     * 第二次刷新仍是 B → 放行"，最终提交的却是**第一次捕获的 A 草稿**（含 A 店排除 111）。
     * 第二次核对补不上第一次换店的漏判 —— 验收在真实 store 上复现了这条。
     * 现在记下草稿归属快照，之后**任何一次**核实与它不一致就整次拒绝。
     */
    const draftShopId = get().ownerShopId;
    const draftUserId = get().ownerUserId;
    const now = Date.now();
    const startAt = taipeiLocalToEpoch(draft.startDate, draft.startTime);
    const restoreAt = taipeiLocalToEpoch(draft.restoreDate, draft.restoreTime);
    if (startAt === null || restoreAt === null) {
      const error = '请选择合法的开始与恢复日期、时间';
      set({ error });
      return { success: false, error };
    }
    /**
     * 草稿归属未知时不允许继续：没有依据的草稿不能拿去保存，
     * 否则"未知归属"会变成"随便哪家店都能认领"。要求先核实出当前店铺。
     */
    if (draftShopId === null || draftUserId === null) {
      const error = '尚未核实当前店铺与账号，请先打开卖家中心页面并确认已登录后再保存';
      set({ error });
      return { success: false, error };
    }
    /** 任何一次身份核实发生变化（含换店清空草稿）→ 整次保存作废 */
    const ownershipDrifted = () =>
      get().ownerShopId !== draftShopId || get().ownerUserId !== draftUserId;

    const owner = await get().refreshOwner();
    if (ownershipDrifted()) {
      const error =
        '保存前核实到的店铺／账号与设置排除商品时不同，请确认当前店铺后重新设置排除商品并再次保存';
      set({ error });
      return { success: false, error };
    }
    const invalid = validateGroupInput({
      schedule: { startAt, restoreAt, spotDays: 1, regularDays: Number(draft.regularDays) },
      config: {
        range: draft.range,
        excludeIds: draft.excludeIds,
        toggleLogistics: draft.toggleLogistics,
      },
      ownerShopId: get().ownerShopId,
      ownerUserId: get().ownerUserId,
      now,
    });
    if (invalid) {
      set({ error: invalid });
      return { success: false, error: invalid };
    }
    if (!owner) {
      const error = '无法核实当前店铺或账号，请先打开卖家中心页面并确认已登录';
      set({ error });
      return { success: false, error };
    }
    set({ groupSaving: true, error: null, notice: null });
    try {
      /**
       * 保存前**再核实一次归属**，并确认它仍与草稿归属一致（第 37.4 节 R7，收敛于第 40.5 节）。
       *
       * 早先的顺序是"先捕获 draft → 再刷新归属"，于是核实到 B 店时用的仍是 A 店的草稿，
       * 结果把 A 店的排除集合保存成 B 店的新组。现在比较的对象是**草稿归属快照**，
       * 而不是"刚刚刷新前后有没有变"——后者在"第一次刷新就换店"时看不出差异。
       * 核实到变更就**拒绝这次保存**，要求用户在当前店铺重新选择，
       * 而不是清空排除后悄悄存成全店。
       */
      await get().refreshOwner();
      if (ownershipDrifted()) {
        const error =
          '保存前核实到的店铺／账号与设置排除商品时不同，请确认当前店铺后重新设置排除商品并再次保存';
        set({ groupSaving: false, error });
        return { success: false, error };
      }
      const result = (await browser.runtime.sendMessage({
        type: 'SHIPPING_GROUP_SAVE',
        executionMode: 'once',
        schedule: { startAt, restoreAt, regularDays: Number(draft.regularDays) },
        config: {
          range: draft.range,
          excludeIds: draft.excludeIds,
          toggleLogistics: draft.toggleLogistics,
        },
      })) as { success?: boolean; error?: string; groupId?: string } | undefined;

      // 消息返回值可能被 content script 抢先应答：以落盘记录为准（与预检同一手法）
      await get().syncGroup();
      const saved = get().group;
      if (!saved || (result && result.success === false)) {
        const error = result?.error || '安排未保存，请重试';
        set({ groupSaving: false, error });
        return { success: false, error };
      }
      set({ groupSaving: false, notice: '安排已保存（后台会按时间执行）', error: null });
      return { success: true };
    } catch (e: any) {
      set({ groupSaving: false, error: `保存安排失败：${e?.message || String(e)}` });
      return { success: false, error: e?.message };
    }
  },

  revokeGroup: async () => {
    try {
      const result = (await browser.runtime.sendMessage({ type: 'SHIPPING_GROUP_REVOKE' })) as
        | { success?: boolean; error?: string }
        | undefined;
      await get().syncGroup();
      if (result?.success === false) {
        const error = result.error || '撤销失败';
        set({ error });
        return { success: false, error };
      }
      set({ notice: '已撤销本次安排', error: null });
      return { success: true };
    } catch (e: any) {
      set({ error: `撤销失败：${e?.message || String(e)}` });
      return { success: false, error: e?.message };
    }
  },

  /**
   * 停止已开始的组（第 34.7 节 R6）。
   *
   * 与撤销分开：撤销只对"未开始"有效（已发过写就被拒绝），
   * 而用户要的是"别再继续切现货了，但已经改的仍要改回去"。这里走真正的停止机制，
   * 并保留恢复与物流义务（不能把还有义务的任务清空）。
   */
  stopGroup: async () => {
    try {
      const result = (await browser.runtime.sendMessage({ type: 'SHIPPING_GROUP_STOP' })) as
        | { success?: boolean; error?: string }
        | undefined;
      await get().syncGroup();
      await get().syncTask();
      if (result?.success === false) {
        const error = result.error || '停止失败';
        set({ error });
        return { success: false, error };
      }
      set({ notice: '已请求停止：不再发出后续切现货批次；已修改的商品仍会在恢复时刻改回常规天数', error: null });
      return { success: true };
    } catch (e: any) {
      set({ error: `停止失败：${e?.message || String(e)}` });
      return { success: false, error: e?.message };
    }
  },

  /** 只读同步后台记录：阶段与结果是后台权威，界面只做镜像 */
  syncGroup: async () => {    try {
      const stored = await browser.storage.local.get(SHIPPING_GROUPS_KEY);
      const record = stored[SHIPPING_GROUPS_KEY] as ShippingGroupsRecord | undefined;
      if (!record) {
        set({ group: null, groupLastFinished: null });
        return;
      }
      set({
        group: (record.active as ShippingGroup | null) ?? null,
        groupLastFinished: (record.lastFinished as ShippingGroup | null) ?? null,
      });
      // 上一次已完成的配置带进草稿（日期留空，强制用户重新确认）。
      // 只有**同一店铺同一账号**才带（第 34.8 节 R7）：跨店带会把别家店的排除集合认领进来。
      const finished = record.lastFinished as ShippingGroup | undefined;
      if (!record.active && finished) {
        const current = get().groupDraft;
        const sameOwner =
          finished.ownerShopId !== null &&
          finished.ownerShopId === get().ownerShopId &&
          finished.ownerUserId !== null &&
          finished.ownerUserId === get().ownerUserId;
        if (sameOwner && !current.startDate && !current.restoreDate) {
          set({
            groupDraft: {
              regularDays: finished.schedule.regularDays,
              startDate: '',
              startTime: taipeiTimeOf(finished.schedule.startAt),
              restoreDate: '',
              restoreTime: taipeiTimeOf(finished.schedule.restoreAt),
              excludeIds: finished.config.excludeIds,
              range: finished.config.range,
              toggleLogistics: finished.config.toggleLogistics,
              // 复用时日期是空的，恢复时刻沿用上次；`restoreDateTouched` 重置为"未手动编辑"，
              // 这样用户重新选开始日期时恢复日期仍会自动跟到次日（第 53.3 节 U14 第 2 点）
              restoreDateTouched: false,
            },
          });
        }
      }
    } catch {
      /* 读失败保持原值 */
    }
  },

  /**
   * "再次安排"：带出**同一店铺同一账号**上次的天数、时刻、排除与物流设置。
   *
   * 日期**故意留空**：31.5 要求"日期留待用户重新确认，不能自动下一周就启用"。
   *
   * 归属必须核对（第 34.8 节 R7）：上一组属于 A 店时，不能在 B 店把它的排除集合
   * 认领为新组的配置——那等于把别家店的商品排除规则带进来（验收复现过）。
   */
  reuseLastGroup: () => {
    const source = get().groupLastFinished;
    if (!source) {
      set({ error: '没有可复用的上一次安排' });
      return;
    }
    const shopId = get().ownerShopId;
    const userId = get().ownerUserId;
    if (shopId === null || userId === null) {
      set({ error: '还无法核实当前店铺／账号，请先打开卖家中心页面并确认已登录' });
      return;
    }
    if (source.ownerShopId !== shopId || source.ownerUserId !== userId) {
      set({
        error:
          '上一次安排属于另一个店铺／账号，不能把它的排除商品与设置带到当前店铺；请重新配置本次安排',
        groupLastFinished: null,
      });
      return;
    }
    set({
      groupDraft: {
        regularDays: source.schedule.regularDays,
        startDate: '',
        startTime: taipeiTimeOf(source.schedule.startAt),
        restoreDate: '',
        restoreTime: taipeiTimeOf(source.schedule.restoreAt),
        excludeIds: source.config.excludeIds,
        range: source.config.range,
        toggleLogistics: source.config.toggleLogistics,
        // 同上：日期仍待用户重新确认，恢复时刻沿用上次
        restoreDateTouched: false,
      },
      notice: '已带出上次配置，请重新选择日期并确认',
      error: null,
    });
  },
}));
