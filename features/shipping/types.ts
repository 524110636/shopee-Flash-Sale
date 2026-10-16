/**
 * 商品备货天数、物流与定时修改（M02.1）的模块内部类型、storage 键与消息契约。
 *
 * 为什么要独立一份而不是塞进 `entrypoints/popup/types.ts`：
 * WXT 的 popup／background／content 是三个独立运行环境，靠同一份**共享契约**才能不写错；
 * 但 shipping 的商品列表、任务记录、计划与结果只在本功能内流转，
 * 放进特卖 store 会让新增工具都去读特卖局部状态（见模块解耦审查 D1／D5）。
 * 因此：跨运行环境的消息契约在这里单一来源，特卖既有类型保持不动。
 *
 * 命名红线：本功能的 storage 键、alarm 名一律带 `shipping` 标识，
 * 绝不复用或清理特卖的 `_scheduledCopy`／`auto_mode_*` 等，避免停止本功能时误停特卖。
 */

// ===== 基础枚举 =====

/** 现货 1 天 / 预售 2–10 天。与源 `mode` 取值兼容（spot／preorder）。 */
export type ShippingMode = 'spot' | 'preorder';

/** 修改范围。`nonhot` = 排除销量前 500 与浏览前 500 的并集。 */
export type ShippingRange = 'all' | 'online' | 'offline' | 'nonhot';

export const SHIPPING_MODE_LABEL: Record<ShippingMode, string> = {
  spot: '现货（1 天）',
  preorder: '预售（2–10 天）',
};

export const SHIPPING_RANGE_LABEL: Record<ShippingRange, string> = {
  all: '全部商品',
  online: '在线商品',
  offline: '下架商品',
  nonhot: '非热销商品',
};

/** 备货天数允许范围（含）。1 天是现货，2–10 是预售。 */
export const SHIPPING_MIN_DAYS = 1;
export const SHIPPING_MAX_DAYS = 10;

// ===== storage 键与 alarm 名（本功能专属） =====

/** 后台权威任务记录（含逐商品结果与物流恢复义务） */
export const SHIPPING_TASK_KEY = '_shippingTask';
/** 用户可编辑设置：模式／天数／范围／手动排除／物流开关（即时落盘） */
export const SHIPPING_SETTINGS_KEY = '_shippingSettings';
/** 最多两项定时计划 */
export const SHIPPING_PLANS_KEY = '_shippingPlans';
/** 启动被拒原因（消息返回值不可靠，界面从这里读） */
export const SHIPPING_START_ERROR_KEY = '_shippingStartError';
/**
 * 最近一次只读预检结果。
 *
 * 为什么不靠 `sendMessage` 的返回值：popup 发消息时，seller 页里的 content script 也在
 * 同一个扩展的 onMessage 监听里，它会同步返回 `false` 抢先成为响应，
 * popup 于是拿到 `undefined`（项目手册 08-关键决策：MV3 下 sendMessage 响应不可靠）。
 * 预检结果因此落盘一次，界面按 `requestId` 读取，避免"点了预检什么都没发生"。
 */
export const SHIPPING_PREVIEW_KEY = '_shippingPreview';
/** 排除选择器用到的商品列表（只读，按 requestId 读） */
export const SHIPPING_PICKLIST_KEY = '_shippingPickList';
/** 最近一次核实到的归属（保存计划前现读，R3） */
export const SHIPPING_IDENTITY_KEY = '_shippingIdentity';
/** 本功能自有的轻量补检 alarm（丢 alarm／SW 休眠后补检当前台湾日期应执行轮次） */
export const SHIPPING_CHECK_ALARM = 'shipping_plan_check';
/** 本功能运行期保活 alarm；终态清理 */
export const SHIPPING_KEEPALIVE_ALARM = 'shipping_keepalive';
/** 补检周期（分钟）。源用 2 分钟心跳，这里沿用同一量级。 */
export const SHIPPING_CHECK_INTERVAL_MINUTES = 2;
/** 保活心跳写入间隔（毫秒） */
export const SHIPPING_KEEPALIVE_INTERVAL_MS = 20_000;
/** 计划数量上限 */
export const SHIPPING_MAX_PLANS = 2;

// ===== 商品 =====

/**
 * REST 商品列表项（`/api/v3/product/search_product_list_v2/` 的 `data.list[]`）。
 *
 * 注意：**这是 REST 契约，`status` 在线=1、下架=8**，
 * 与特卖 GraphQL 的活跃 `status=0` 完全不同，不能套同一常量。
 * 字段可能以字符串返回（`status: "1"`），比较必须走 `Number()`。
 */
export interface ShippingProduct {
  id: number | string;
  name?: string;
  status?: number | string;
  category_path?: string;
  sold?: number | string | null;
  view_count?: number | string | null;
  enable_model_level_dts?: boolean | null;
  [key: string]: unknown;
}

/** 本功能认定的商品状态常量（REST） */
export const SHIPPING_STATUS = {
  online: 1,
  offline: 8,
} as const;

/** 预览／写集合中的一条目标商品 */
export interface ShippingTargetItem {
  itemId: string;
  name: string;
  status: number;
  categoryPath: string;
}

/**
 * 预检（以及启动时比对）使用的设置子集。
 *
 * 放在 `types.ts` 而不是 `runner.ts`：预览记录要锁定它（返工 17.1），
 * 而预览记录属于本文件；让 `types.ts` 去 import `runner.ts` 会形成循环依赖。
 */
export interface ShippingPreviewSettings {
  mode: ShippingMode;
  days: number;
  range: ShippingRange;
  excludeIds: string;
  toggleLogistics: boolean;
}

// ===== 物流 =====

export interface ShippingChannel {
  channelId: number;
  enabled: boolean;
}

/** 渠道级结果：原状态 / 本次关闭 / 本次恢复各记一份，不互相掩盖 */
export type ShippingChannelOutcome = 'pending' | 'success' | 'failed' | 'unknown' | 'skipped';

export interface ShippingChannelRecord {
  channelId: number;
  /** 动作开始前读到的真实状态 */
  originallyEnabled: boolean;
  closed: ShippingChannelOutcome;
  restored: ShippingChannelOutcome;
  error?: string;
}

// ===== 任务 =====

export type ShippingTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
export type ShippingItemStatus = 'pending' | 'success' | 'failed' | 'skipped' | 'unknown';

/** 单个商品的最终归类（按 ID 最终状态，不累加重试次数） */
export interface ShippingItemResult {
  itemId: string;
  name: string;
  /** 目标天数（写请求实际使用的值） */
  days: number;
  status: ShippingItemStatus;
  reason?: string;
  /**
   * 该商品在**写之前**就被回读确认"已经是目标天数"，因此本次没有发出写请求。
   *
   * 为什么要单独一个字段而不是只靠 `reason` 文本：组判定"是否真的恢复完成"必须用**结构化证据**
   * （第 34.6 节 R5：skipped 只有明确"已回读目标"才可当恢复完成）。
   * 靠文本匹配会在改文案时静默失效，于是"没恢复的商品被完成掩盖"。
   */
  verifiedAlreadyTarget?: boolean;
}

export const SHIPPING_TERMINAL_STATUSES: ShippingTaskStatus[] = [
  'completed',
  'failed',
  'stopped',
  'interrupted',
];

/** 排查用的检查点步骤名（不写行号，用符号） */
export const SHIPPING_STEP = {
  taskAccepted: 'task-accepted',
  logisticsClose: 'close-channel',
  batchWrite: 'update-product-batch',
  logisticsRestore: 'restore-channel',
} as const;

export interface ShippingCheckpoint {
  step: string;
  /** 已发出写请求（结果可能未知） */
  writeSent: boolean;
  target?: string;
  outcome?: 'success' | 'failed' | 'unknown';
  at: number;
}

export interface ShippingLogisticsState {
  /** 用户是否勾选自动管理物流 */
  requested: boolean;
  /** 关闭阶段是否已走到（含失败） */
  closeAttempted: boolean;
  closeCompleted: boolean;
  restoreAttempted: boolean;
  restoreCompleted: boolean;
  records: ShippingChannelRecord[];
}

export interface ShippingTask {
  taskId: string;
  requestId: string;
  /** 任务归属锚：启动时核实的店铺 */
  shopId: number | null;
  ownerUserId: number | null;
  /** 来源：手动 / 旧计划 / 单次组 */
  source: 'manual' | 'plan' | 'group';
  planId?: string;
  /** 计划轮次标识（计划ID＋台湾日期＋目标时刻），手动为空 */
  occurrenceId?: string;
  /** 所属单次组 id（`source === 'group'` 时有值） */
  groupId?: string;
  /** 本任务承担组里哪一阶段：切现货或恢复常规天数 */
  groupPhase?: 'spot' | 'restore';
  mode: ShippingMode;
  days: number;
  range: ShippingRange;
  excludeIds: string[];
  status: ShippingTaskStatus;
  /** 阶段文案标识，界面据此显示，不参与判定 */
  phase: string;
  total: number;
  processed: number;
  items: ShippingItemResult[];
  logistics: ShippingLogisticsState;
  checkpoints: ShippingCheckpoint[];
  message: string;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** 用户请求停止：只阻止后续商品请求，不撤销已确认的备货天数 */
  stopRequested: boolean;
}

export interface ShippingTaskCounts {
  success: number;
  failed: number;
  skipped: number;
  unknown: number;
  pending: number;
}

// ===== 设置与计划 =====

export interface ShippingSettings {
  mode: ShippingMode;
  days: number;
  range: ShippingRange;
  /** 手动排除的商品 ID 文本（换行／逗号分隔），保存时统一成正整数 */
  excludeIds: string;
  toggleLogistics: boolean;
}

export const SHIPPING_DEFAULT_SETTINGS: ShippingSettings = {
  mode: 'spot',
  days: 1,
  range: 'all',
  excludeIds: '',
  toggleLogistics: false,
};

export interface ShippingPlan {
  id: string;
  enabled: boolean;
  /** 台湾日期 YYYY-MM-DD */
  date: string;
  /** 台湾时刻 HH:mm */
  time: string;
  days: number;
  /** 计划自己的范围（执行前据此重新预检） */
  range: ShippingPlanRange;
  loopDaily: boolean;
  /** 计划排除 ID 文本 */
  excludeIds: string;
  toggleLogistics: boolean;
  /**
   * 保存计划时已核实的**店铺归属锚**。
   *
   * 为什么计划必须自己带锚：否则到点执行时会用"触发那一刻登录的身份"重新认领旧计划，
   * 用户中途换店／换账号后，计划就会把商品改到别人店里（R3 复现项）。
   */
  ownerShopId: number | null;
  /** 保存计划时已核实的**后端账号锚**（与 `ownerShopId` 一起构成计划归属） */
  ownerUserId: number | null;
  /** 已执行的轮次标识（计划ID＋台湾日期＋目标时刻），据此保证每轮至多一次 */
  lastRunId: string | null;
  lastRunAt: number | null;
  lastResult: ShippingTaskStatus | 'waiting' | null;
  /** 最近一次执行对应的任务 id，供界面把计划与真实任务对上 */
  lastTaskId: string | null;
  lastError: string | null;
  /** 一次性计划的目标时刻已过期且未执行 */
  missed: boolean;
  /**
   * 这条记录是**已被停用的旧重复计划**（第 34.2 节 R1）。
   *
   * 为什么要有这个标记而不是直接删掉：验收要求"记录仍可追溯且暂停状态可见"，
   * 且旧运行任务的已发结果与渠道恢复不能丢。标记后界面显示"已暂停，请重新确认单次日期"。
   */
  retired?: boolean;
  /** 停用原因（界面直接显示，写清为什么必须重新确认） */
  retiredReason?: string;
  updatedAt: number;
}

/** 计划的修改范围。计划不使用"非热销"（源定时也只用全商品范围＋排除集合）。 */
export type ShippingPlanRange = 'all' | 'online' | 'offline';

export const SHIPPING_DEFAULT_PLANS: ShippingPlan[] = [
  {
    id: 'plan1',
    enabled: false,
    date: '',
    time: '09:00',
    days: 1,
    range: 'all',
    loopDaily: false,
    excludeIds: '',
    toggleLogistics: false,
    ownerShopId: null,
    ownerUserId: null,
    lastRunId: null,
    lastRunAt: null,
    lastResult: null,
    lastTaskId: null,
    lastError: null,
    missed: false,
    updatedAt: 0,
  },
  {
    id: 'plan2',
    enabled: false,
    date: '',
    time: '09:00',
    days: 1,
    range: 'all',
    loopDaily: false,
    excludeIds: '',
    toggleLogistics: false,
    ownerShopId: null,
    ownerUserId: null,
    lastRunId: null,
    lastRunAt: null,
    lastResult: null,
    lastTaskId: null,
    lastError: null,
    missed: false,
    updatedAt: 0,
  },
];

export const SHIPPING_PLAN_IDS = ['plan1', 'plan2'] as const;

// ===== 预览 / 结果契约 =====

export interface ShippingLogisticsImpact {
  requested: boolean;
  /** 只读预检读到的当前启用渠道 */
  enabledChannels: number[];
  /** 预检失败原因（此时不该开始关闭） */
  error?: string;
}

export interface ShippingPreviewResult {
  ok: boolean;
  error?: string;
  shopId: number | null;
  /** 参与过滤前的商品总数 */
  scanned: number;
  /** 读取是否完整；不完整时界面不得把它当"空店铺" */
  complete: boolean;
  /** 最终目标（已去掉手动排除、特卖排除、不支持的商品） */
  items: ShippingTargetItem[];
  /** 被手动排除命中的数量 */
  excludedByManual: number;
  /** 被进行中／即将开始的特卖排除的数量 */
  excludedByFlashSale: number;
  /** 因按 SKU 设置备货天数而不支持本次批量修改的数量 */
  unsupported: number;
  /** 特卖排除调查是否成功；失败时不能在未确认状态下继续 */
  flashSaleExclusionOk: boolean;
  /** 非热销范围是否可判定 */
  nonhotDeterminable: boolean;
  logistics: ShippingLogisticsImpact;
}

/** background ↔ popup 的 shipping 消息 */
export type ShippingMessage =
  | { type: 'SHIPPING_PREVIEW'; requestId: string; settings: ShippingSettings }
  | { type: 'SHIPPING_PRODUCT_LIST'; requestId: string }
  | {
      type: 'SHIPPING_START';
      requestId: string;
      settings: ShippingSettings;
      items: ShippingTargetItem[];
    }
  | { type: 'SHIPPING_STOP' }
  | { type: 'SHIPPING_SYNC_ALARMS' }
  | { type: 'SHIPPING_RESTORE_LOGISTICS' }
  | { type: 'SHIPPING_ACK_INTERRUPTED'; taskId: string };

/** 排除选择器用的商品条目（只读，供用户搜索／按销量挑选排除项） */
export interface ShippingPickableProduct {
  itemId: string;
  name: string;
  status: number;
  /** 销量（字段不可取得时为 null，界面显示"未知"而不是 0） */
  sold: number | null;
  /** 浏览量 */
  views: number | null;
}

export interface ShippingPickListResult {
  ok: boolean;
  error?: string;
  products: ShippingPickableProduct[];
}

/** 落盘的排除选择器结果（与预检同样按 requestId 读取，不依赖消息返回值） */
export interface ShippingPickListRecord {
  requestId: string;
  at: number;
  result: ShippingPickListResult;
}

/** 落盘的归属核实结果（保存计划前后读，避免消息抢先应答） */
export interface ShippingIdentityRecord {
  shopId: number | null;
  userId: number | null;
  at: number;
}

/**
 * 落盘的预检结果。
 *
 * **带上已核实的店铺与后端账号**：启动任务时用它核对"这份预览是谁确认的"，
 * 免得用户在账号 1 预览、切到账号 2 后还能拿旧预览启动（返工 14.1）。
 * 界面只传 `requestId`；店铺／账号由背景自己从记录里读，不信 UI 自报的 owner。
 *
 * **同时锁定确认时的设置与商品集合**（返工 17.1）：后台记录是参数与集合的**唯一依据**，
 * 启动消息里携带的天数／范围／排除／物流开关或预览外商品一律不作数。
 */
export interface ShippingPreviewRecord {
  requestId: string;
  at: number;
  /** 预检那一刻核实到的店铺；核实不到为 null */
  shopId: number | null;
  /** 预检那一刻核实到的后端账号 id；核实不到为 null */
  ownerUserId: number | null;
  /** 这份预览确认时的设置快照（启动时逐字段比对，不接受新内容） */
  settings: ShippingPreviewSettings;
  /** 这份预览确认时目标集合的指纹（商品 id 集合的稳定摘要） */
  itemIds: string[];
  result: ShippingPreviewResult;
}

/** 确认内容比对的差异类型（写入诊断，便于复验时一眼看清是哪一项不符） */
export type ShippingContentDiffKind =
  | 'settings-days'
  | 'settings-range'
  | 'settings-exclude'
  | 'settings-logistics'
  | 'items-extra'
  | 'items-missing';

export interface ShippingContentDiff {
  kind: ShippingContentDiffKind;
  /** 脱敏后的可读说明（例如"天数 7 → 9"） */
  detail: string;
}

/** R3 最小脱敏捕获：记录核验阶段与预期／实际锚，不保存凭据（返工 14.3） */
export const SHIPPING_DIAGNOSTIC_LIMIT = 20;

export interface ShippingDiagnostic {
  at: number;
  /** 核验发生的阶段，例如 preview-start / first-batch / between-batches / close-channel / restore-channel */
  stage: string;
  requestId?: string;
  taskId?: string;
  occurrenceId?: string;
  /** 任务或预览记录的锚 */
  expectedShopId: number | null;
  expectedUserId: number | null;
  /** 现读到的实际值；读取失败时为 null */
  actualShopId: number | null;
  actualUserId: number | null;
  /** 现行后端权限核验结果 */
  access: 'allowed' | 'denied' | 'read-failed' | 'not-checked';
  /** 该阶段是否已经发出写请求 */
  writeSent: boolean;
  reason: string;
  /**
   * 确认内容比对结果（返工 17.1）：只在预检→启动的内容比对失败时出现。
   * 记录差异**类型与脱敏摘要**，便于复验时定位是哪一项被改过。
   */
  contentDiffs?: ShippingContentDiff[];
  /**
   * 内容比对用的**实际原值类型与规范化值**（返工 20.1）。
   *
   * 为什么必须记：只看"拒绝了"分不清是"类型不对被拒"还是"值不同被拒"。
   * 例如 `toggleLogistics` 收到字符串 `"true"` 时，规范化后与 boolean `true` 无法区分 ——
   * 记录原值类型才能看出缺陷其实在"没做类型校验"。
   */
  contentValues?: ShippingDiagnosticContentValue[];
  /**
   * 上下文是否在核验与发送之间发生变化（返工 17.2）。
   * `blocked-write` 表示已阻止该次写并保留待处理；`same-owner-refresh` 表示同归属仅凭据刷新，正常放行。
   */
  contextChange?: 'none' | 'blocked-write' | 'same-owner-refresh' | 'unknown';
  /** 上下文比对时凭据字符串是否变化（返工 20.2）；只记 boolean，**不记** Cookie 原值 */
  credentialChanged?: boolean;
  /** 本次停止的直接原因分类，便于区分是哪一项没通过（返工 20.1／20.2） */
  blockedBy?: ShippingDiagnosticBlockReason;
}

/** 内容比对时记下的一项原值与规范化结果（不含凭据） */
export interface ShippingDiagnosticContentValue {
  field: string;
  /** 原值的 JS 类型，例如 `string`／`boolean`／`undefined`／`number` */
  rawType: string;
  /** 规范化后的值；字符串型会截断到 40 字符 */
  normalized: string;
}

/** 停止写请求的直接原因（用于让复验一眼看清是哪条闸门命中） */
export type ShippingDiagnosticBlockReason =
  | 'logistics-flag-type'
  | 'settings-mismatch'
  | 'items-extra'
  | 'identity-null'
  | 'identity-read-failed'
  | 'shop-changed'
  | 'account-changed'
  | 'access-denied'
  | 'access-read-failed'
  | 'stop-requested'
  | 'other';

/** 落盘的 R3 诊断（独立键，避免把任务记录撑大） */
export const SHIPPING_DIAGNOSTICS_KEY = '_shippingDiagnostics';

export interface ShippingStartResult {
  success: boolean;
  error?: string;
  taskId?: string;
}

// ===== 单次成对安排（任务书第 31 节） =====

/**
 * 执行方式。**只有单次**：每天／每周重复与"自动安排下一周"已按第 31 节撤回。
 *
 * 为什么仍把它落盘成一个字段而不是省略：后台必须能**拒绝**旧包或旧记录带来的
 * 循环模式（第 31 节 31.5 明确要求"新消息带每日／每周模式应拒绝，
 * 不可只在 UI 隐藏后后台仍接受"）。写死成联合类型，越界值在反序列化时就被挡掉。
 */
export type ShippingExecutionMode = 'once';

/**
 * 一组单次安排所处的阶段。
 *
 * 阶段推进只由后台在**真实写结果之后**落盘，不用内存计时器：
 * - `scheduled` 尚未到开始时刻；
 * - `cutting` 正在把目标商品切到 1 天（可能跨多次批次）；
 * - `awaiting-restore` 已确认切到 1 天，等待恢复时刻；
 * - `restoring` 正在改回常规备货天数；
 * - `done` 两阶段与物流收尾全部确认完成；
 * - `missed` 错过开始窗口且从未发过写请求（第 31 节 31.6 规则 2）；
 * - `needs-attention` 结果不明／需人工处理，**不自动重发**。
 */
export type ShippingGroupPhase =
  | 'scheduled'
  | 'cutting'
  | 'awaiting-restore'
  | 'restoring'
  | 'done'
  | 'missed'
  | 'needs-attention';

export const SHIPPING_GROUP_PHASE_LABEL: Record<ShippingGroupPhase, string> = {
  scheduled: '待开始',
  cutting: '切现货中',
  'awaiting-restore': '等待恢复',
  restoring: '恢复中',
  done: '已完成',
  missed: '已错过',
  'needs-attention': '需处理',
};

/**
 * 单次安排的两阶段规格。
 *
 * `spotDays` 固定为 1（切现货），`regularDays` 是用户选的 2–10 天。
 * 两个时刻都是绝对毫秒时间戳，按 Asia/Taipei 解释后落盘，
 * 因此关掉弹窗／重启浏览器后不依赖任何本地时区或表单状态。
 */
export interface ShippingGroupSchedule {
  /** 开始（切 1 天）时刻 */
  startAt: number;
  /** 恢复（改回常规天数）时刻，严格晚于 `startAt` */
  restoreAt: number;
  /** 切现货天数，固定 1 */
  spotDays: number;
  /** 恢复的常规备货天数，2–10 */
  regularDays: number;
}

/** 落在单次组上的执行配置：两阶段必须共用同一份，且不可静默变化。 */
export interface ShippingGroupConfig {
  /** 修改范围（计划不使用"非热销"，与既有 `ShippingPlanRange` 一致） */
  range: ShippingPlanRange;
  /** 排除的商品 ID（正整数文本，界面按换行存放） */
  excludeIds: string;
  /** 是否自动管理店铺物流（默认关闭） */
  toggleLogistics: boolean;
}

/** 商品在某一阶段的实际处置归类（按 ID 记录，不累加次数）。 */
export interface ShippingGroupItemOutcome {
  itemId: string;
  name: string;
  /** 预检时已原本是该天数（不被冒充为本次写成功） */
  alreadyAtTarget?: boolean;
  /** 切到 1 天的结果 */
  spot: ShippingItemStatus;
  /** 恢复常规天数的结果 */
  restore: ShippingItemStatus;
  reason?: string;
}

/**
 * 一组单次安排的权威记录。
 *
 * 为什么单独一个记录而不是沿用 `ShippingPlan`：
 * 旧 `ShippingPlan` 是"某天某时刻跑一次"的单阶段模型，两次修改要靠两个互相独立的计划；
 * 第 31 节要求把它们视为**一件完整业务**（共享排除集合、共享归属、必须成对收尾），
 * 因此新增一份带 `phase` 与两阶段结果的组记录。旧记录保留不删（31.5 迁移要求）。
 */
export interface ShippingGroup {
  /** 组标识；"再次安排"产生新 ID，不覆盖旧恢复义务 */
  groupId: string;
  /** 修订号：每次落盘 +1，用于识别迟到的旧回调不能回退已完成阶段 */
  revision: number;
  executionMode: ShippingExecutionMode;
  /** 保存时已核实的店铺归属锚 */
  ownerShopId: number | null;
  /** 保存时已核实的后端账号锚 */
  ownerUserId: number | null;
  schedule: ShippingGroupSchedule;
  config: ShippingGroupConfig;
  phase: ShippingGroupPhase;
  /** 已认领过的阶段（阶段标识），保证重复 alarm 不重复认领 */
  claimedStages: string[];
  /** 第一阶段的关联任务 id（同一时刻只有一个任务记录） */
  spotTaskId: string | null;
  restoreTaskId: string | null;
  /**
   * 已被本组**接回并承担义务**的任务 id（第 37.2 节 R3 收敛）。
   *
   * 为什么需要它：接回会把 `restoreTaskId` 清空（好让补检能重新认领恢复阶段），
   * 但那条 `interrupted` 记录仍留在 storage 里。若启动校验只看"组是不是 restoring"，
   * 接回后的组就会被自己的旧记录反复挡住，恢复永远起不来 ——
   * 表现为"重开后停在需处理、再也不继续"（验收实测）。
   * 记下这些 id 后，启动校验才能分清"这条中断记录已被消费"与"真的还没处理"。
   */
  reconciledTaskIds?: string[];
  /**
   * 已确认达到 1 天的商品集合：恢复阶段的**唯一对象来源**。
   * 排除 ID、首阶段未确认可处理的商品、开始后新上架商品都不能被扩大纳入（31.6 规则 5）。
   */
  confirmedSpotItemIds: string[];
  /** 逐商品结果（两阶段合并保存在同一处，便于界面显示与复验核对） */
  items: ShippingGroupItemOutcome[];
  /** 需要人工处理的项（结果不明等），非空时阶段为 needs-attention */
  pendingItemIds: string[];
  /** 供界面显示的原因／提示（已脱敏） */
  message: string;
  error: string | null;
  /** 保存时间与最近更新 */
  createdAt: number;
  updatedAt: number;
  /** 完成时间 */
  finishedAt?: number;
}

/** 组记录落盘契约（单一活跃组 + 历史，便于"再次安排"复用配置） */
export interface ShippingGroupsRecord {
  /** 当前活跃组；用户撤销或完成后为 null */
  active: ShippingGroup | null;
  /** 最近完成的组（供"再次安排"带出上次配置） */
  lastFinished: ShippingGroup | null;
  updatedAt: number;
}

export const SHIPPING_GROUPS_KEY = '_shippingGroups';

export const SHIPPING_EMPTY_GROUPS: ShippingGroupsRecord = {
  active: null,
  lastFinished: null,
  updatedAt: 0,
};

/** 阶段标识前缀：用于 `claimedStages` 与"下一阶段不得抢占恢复"判断。 */
export const SHIPPING_GROUP_STAGE = {
  spot: 'spot',
  restore: 'restore',
} as const;

/** 开始窗口容差（分钟）。第 31 节 31.6 规则 2 固定 5 分钟，不做用户配置。 */
export const SHIPPING_START_WINDOW_MINUTES = 5;

/** 组专属 alarm：两阶段各一个，避免与特卖 alarm 混用 */
export const SHIPPING_GROUP_ALARM = 'shipping_group_check';

/** 组的存储与消息契约结束标记 */
