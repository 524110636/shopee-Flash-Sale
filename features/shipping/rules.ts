/**
 * 商品备货与定时修改的**纯规则**：不碰浏览器 API、不碰 storage、不 import React／Zustand。
 *
 * 为什么单独成模块：范围过滤、排除解析、台湾时区换算、计划排序都是"改一条就要同步另一条"的地方，
 * 集中在一处才能被单测直接覆盖，也避免 runner／调度／界面各写一份而漂移。
 */

import {
  SHIPPING_MAX_DAYS,
  SHIPPING_MAX_PLANS,
  SHIPPING_MIN_DAYS,
  SHIPPING_STATUS,
  type ShippingContentDiff,
  type ShippingDiagnosticContentValue,
  type ShippingMode,
  type ShippingPickableProduct,
  type ShippingPlan,
  type ShippingPreviewSettings,
  type ShippingProduct,
  type ShippingRange,
  type ShippingSettings,
} from './types';

// ===== 天数 / 模式 =====

export function isValidDays(days: unknown): days is number {
  const n = Number(days);
  return Number.isInteger(n) && n >= SHIPPING_MIN_DAYS && n <= SHIPPING_MAX_DAYS;
}

/** 天数 → 模式：1 天是现货，2–10 是预售。避免界面与后台对同一数字给出不同模式。 */
export function modeForDays(days: number): ShippingMode {
  return Number(days) <= 1 ? 'spot' : 'preorder';
}

/** 校验用户设置；返回错误文案或 null。 */
export function validateSettings(settings: Partial<ShippingSettings>): string | null {
  if (!isValidDays(settings.days)) {
    return `备货天数必须是 ${SHIPPING_MIN_DAYS}–${SHIPPING_MAX_DAYS} 之间的整数`;
  }
  if (settings.mode && settings.mode !== modeForDays(Number(settings.days))) {
    return '模式与备货天数不一致，请重新选择';
  }
  if (settings.range && !['all', 'online', 'offline', 'nonhot'].includes(settings.range)) {
    return '修改范围无效';
  }
  return null;
}

// ===== 排除 ID =====

/**
 * 手动排除 ID 统一成正整数格式。
 *
 * 源允许换行或逗号分隔；这里保留用户输入的排版方式无法保证稳定比较，
 * 因此统一成字符串数组，去重且按首次出现排序（保持用户可预期顺序）。
 */
export function parseExcludeIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of String(raw).split(/[\s,，;；]+/)) {
    const t = piece.trim();
    if (!t) continue;
    if (!/^\d+$/.test(t)) continue;
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n <= 0) continue;
    const key = String(n);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 把 ID 列表与文本合并成可显示的排除文本（保留用户已填内容，只去重）。 */
export function mergeExcludeText(current: string, add: string[]): string {
  const merged = [...parseExcludeIds(current)];
  const seen = new Set(merged);
  for (const id of parseExcludeIds(add.join('\n'))) {
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(id);
  }
  return merged.join('\n');
}

// ===== 状态与范围过滤 =====

/** REST 契约的在线／下架判断：`status` 可能是字符串，必须 `Number()`。 */
export function normalizeShippingStatus(status: unknown): number {
  const n = Number(status);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function isOnlineProduct(product: ShippingProduct): boolean {
  return normalizeShippingStatus(product.status) === SHIPPING_STATUS.online;
}

export function isOfflineProduct(product: ShippingProduct): boolean {
  return normalizeShippingStatus(product.status) === SHIPPING_STATUS.offline;
}

/**
 * 可批量改备货天数 = 在线或下架。其他状态（草稿／删除中等）单列未纳入。
 * 与特卖的活跃检查不同：这里不能因为「不活跃」就放行或排除。
 */
export function isEditableForShipping(product: ShippingProduct): boolean {
  return isOnlineProduct(product) || isOfflineProduct(product);
}

/**
 * 热销集合：销量前 500 与浏览量前 500 的并集（沿用源 `getHotProducts` 规则）。
 *
 * 字段缺失（`undefined`／`null`）的按不可排序处理，不当作 0 ——
 * 否则会把「平台没返回销量」误当成「销量为 0」而漏排除真实热销商品。
 */
export function buildHotProductIds(products: ShippingProduct[], topN = 500): Set<string> {
  const sold = products
    .filter(p => p.sold !== undefined && p.sold !== null)
    .sort((a, b) => Number(b.sold || 0) - Number(a.sold || 0))
    .slice(0, topN);
  const views = products
    .filter(p => p.view_count !== undefined && p.view_count !== null)
    .sort((a, b) => Number(b.view_count || 0) - Number(a.view_count || 0))
    .slice(0, topN);
  const hot = new Set<string>();
  for (const p of sold) hot.add(String(p.id));
  for (const p of views) hot.add(String(p.id));
  return hot;
}

/** 非热销范围是否可判定：两个排序字段至少要有一个在任意商品上出现过。 */
export function isNonHotDeterminable(products: ShippingProduct[]): boolean {
  return products.some(
    p =>
      (p.sold !== undefined && p.sold !== null && Number.isFinite(Number(p.sold))) ||
      (p.view_count !== undefined && p.view_count !== null && Number.isFinite(Number(p.view_count))),
  );
}

/**
 * 按范围过滤商品。**只做范围过滤**，不做排除（排除在 preview 里单独统计，
 * 因为界面要分别显示"手动排除几个／特卖排除几个"）。
 *
 * `topN` 可覆盖用于测试；生产路径使用默认 500。注意：商品总数少于 500 时，
 * 非热销范围会过滤掉全部商品（源 `getHotProducts` 同样如此），这是可以预期的结果，
 * 不是"读失败"。
 */
export function filterByRange(
  products: ShippingProduct[],
  range: ShippingRange,
  topN = 500,
): ShippingProduct[] {
  if (range === 'online') return products.filter(isOnlineProduct);
  if (range === 'offline') return products.filter(isOfflineProduct);
  if (range === 'nonhot') {
    const hot = buildHotProductIds(products, topN);
    return products.filter(p => !hot.has(String(p.id)));
  }
  return products;
}

// ===== 请求体 =====

export interface ShippingBatchRequestItem {
  id: number;
  category_path: string;
  pre_order: boolean;
  days_to_ship: number;
}

/**
 * 组装批量改备货请求项。保留源 `category_path`，1 天 `pre_order=false`，2–10 天 `true`。
 *
 * 这里**不静默关闭** `enable_model_level_dts`，也不重置 SKU 天数：
 * 商品级备货是商品级字段，按 SKU 设置的商品由调用方排除（见 `isSkuLevelProduct`）。
 */
export function buildBatchItem(
  itemId: string,
  categoryPath: string,
  days: number,
): ShippingBatchRequestItem {
  return {
    id: Number(itemId),
    category_path: categoryPath || '',
    pre_order: Number(days) > 1,
    days_to_ship: Number(days),
  };
}

/**
 * 商品是否按 SKU 设置备货天数。
 *
 * 源的单商品降级路径会关闭 `enable_model_level_dts`，那会**抹掉用户的 SKU 级结构**；
 * 本任务明确不这么做，改为在预览时排除并说明，SKU 工具另做。
 */
export function isSkuLevelProduct(product: ShippingProduct): boolean {
  return product.enable_model_level_dts === true;
}

// ===== 台湾时区（Asia/Taipei，不依赖操作系统时区） =====

const TAIPEI_TZ = 'Asia/Taipei';

const taipeiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TAIPEI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export interface TaipeiParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** 把某个瞬间换算成台湾本地时刻的各字段。 */
export function taipeiParts(epochMs: number): TaipeiParts {
  const parts = taipeiFormatter.formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value || '0');
  // en-CA 的 hour 在 24 小时制下可能返回 '24'（午夜），归一到 0
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** 台湾日期字符串 `YYYY-MM-DD`。 */
export function taipeiDateString(epochMs: number): string {
  const p = taipeiParts(epochMs);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** 台湾时刻字符串 `HH:mm`。 */
export function taipeiTimeString(epochMs: number): string {
  const p = taipeiParts(epochMs);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 台湾本地时刻到 UTC 瞬间的偏移（毫秒）。台北无夏令时，仍按实测偏移计算以保证正确。 */
function taipeiOffsetMs(epochMs: number): number {
  const p = taipeiParts(epochMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - epochMs;
}

/** `YYYY-MM-DD` + `HH:mm`（台湾本地）→ 该瞬间的毫秒时间戳。 */
export function taipeiLocalToEpoch(dateStr: string, timeStr: string): number | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || '').trim());
  if (!dm || !tm) return null;
  const [, ys, ms, ds] = dm;
  const [, hs, mis] = tm;
  const year = Number(ys);
  const month = Number(ms);
  const day = Number(ds);
  const hour = Number(hs);
  const minute = Number(mis);
  if (hour > 23 || minute > 59 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const guessUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = taipeiOffsetMs(guessUtc);
  let epoch = guessUtc - firstOffset;
  const secondOffset = taipeiOffsetMs(epoch);
  if (secondOffset !== firstOffset) epoch = guessUtc - secondOffset;
  // 校验回读一致，避免把不存在的日期（如 2026-02-30）当有效
  const back = taipeiParts(epoch);
  if (back.year !== year || back.month !== month || back.day !== day) return null;
  if (back.hour !== hour || back.minute !== minute) return null;
  return epoch;
}

/** 台湾日期字符串加一天（不经过系统时区）。 */
export function nextTaipeiDate(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const next = new Date(base + 86_400_000);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
    next.getUTCDate(),
  ).padStart(2, '0')}`;
}

/**
 * 全新空白安排的默认时刻（第 53.3 节 U14）：
 * 把商品切到 1 天＝**今天 23:30**（台湾），恢复＝**所选开始日期的次日 01:30**。
 *
 * 为什么做成"传 now 再算"的纯函数，而不是模块加载时算一次的常量：
 * 扩展的 service worker／popup 可能跨天常驻，模块级常量会把昨天的日期当成"今天"，
 * 于是打开弹窗时默认值是过去的时刻，用户还没动手就已经不可保存。
 *
 * 为什么不在 23:30 已过时自动挪到明天：用户明确要求"默认仍遵守今天，只提示需选未来时间"。
 * 悄悄挪日期会让"用户以为安排在今天夜里"变成"实际明天夜里"，那是未被决定的行为。
 */
export function defaultScheduleTimes(nowMs: number): {
  startDate: string;
  startTime: string;
  restoreDate: string;
  restoreTime: string;
} {
  const startDate = taipeiDateString(nowMs);
  return {
    startDate,
    startTime: DEFAULT_START_TIME,
    restoreDate: nextTaipeiDate(startDate),
    restoreTime: DEFAULT_RESTORE_TIME,
  };
}

/** 默认开始时刻（台湾本地）。 */
export const DEFAULT_START_TIME = '23:30';
/** 默认恢复时刻（台湾本地，开始日期的次日）。 */
export const DEFAULT_RESTORE_TIME = '01:30';

/**
 * 开始时刻是否已经过去（第 53.3 节第 3 点）。
 *
 * 只用来**提示与阻止保存**，不改变默认值本身。首写窗口／截止保护在后台照旧判断，
 * 这里只解决"用户看到默认值却不知道它已经过了"。
 *
 * 为什么同一分钟不算过：默认值就是 23:30，用户在 23:30 那一分钟按下保存时，
 * 后台的 `startAt <= now` 仍会拒绝，但界面先报"已过"只会制造困惑。
 * 为什么空时刻返回 false：那时该提示的是"请选择时间"，由 `validateGroupInput` 负责。
 */
export function isStartTimePassed(startAt: number | null, startTime: string, nowMs: number): boolean {
  if (startAt === null || !startTime) return false;
  if (startAt > nowMs) return false;
  return taipeiTimeString(nowMs) !== startTime;
}

// ===== 计划轮次标识与排序 =====
/**
 * 每轮标识：计划 ID ＋ 台湾日期 ＋ 目标时刻。
 *
 * 固定成字符串后，"重复 alarm／重复 UI 消息不得启动第二份"就有了可持久比较的锚，
 * 不需要依赖内存锁（worker 重启会清空内存锁）。
 */
export function buildOccurrenceId(planId: string, taipeiDate: string, time: string): string {
  return `${planId}@${taipeiDate}@${time}`;
}

export interface PlanDueInfo {
  plan: ShippingPlan;
  occurrenceId: string;
  /** 该轮应当触发的毫秒时间戳 */
  dueAt: number;
  /** 台湾日期 */
  taipeiDate: string;
}

/**
 * 判断某个计划在给定瞬间是否"应执行"。
 *
 * - 一次性计划：只在自己保存的日期／时刻到期时执行一次；错过（已过期且未执行）标 missed，不补写历史。
 * - 每日计划：today 的该时刻已到且今天尚未执行 → 本轮；未到 → 不执行。
 */
export function resolvePlanDue(plan: ShippingPlan, nowMs: number): PlanDueInfo | 'missed' | null {
  if (!plan.enabled) return null;
  const today = taipeiDateString(nowMs);
  const targetDate = plan.loopDaily ? today : plan.date;
  if (!targetDate) return null;
  const dueAt = taipeiLocalToEpoch(targetDate, plan.time);
  if (dueAt === null) return null;
  const occurrenceId = buildOccurrenceId(plan.id, targetDate, plan.time);

  if (dueAt > nowMs) return null;
  if (plan.lastRunId === occurrenceId) return null;

  if (!plan.loopDaily) {
    // 一次性：到点即执行；已过期且从未执行过 → 标 missed（不补写历史批次）
    const sameDay = targetDate === today;
    if (!sameDay) return plan.lastRunId ? null : 'missed';
    return { plan, occurrenceId, dueAt, taipeiDate: targetDate };
  }
  return { plan, occurrenceId, dueAt, taipeiDate: targetDate };
}

/**
 * 同日到期的多个计划排序：先按目标时刻，再按稳定槽位（计划 ID）。
 *
 * 排序稳定才能保证"两个计划同一天到期"不会因为对象顺序不同而随机先跑哪一个。
 */
export function sortDuePlans(due: PlanDueInfo[]): PlanDueInfo[] {
  return [...due].sort((a, b) => {
    if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
    return a.plan.id.localeCompare(b.plan.id);
  });
}

/** 一次性计划保存时的校验：日期时间必须有效且未过期（台湾时区解释）。 */
export function validateOneTimePlan(dateStr: string, timeStr: string, nowMs: number): string | null {
  const epoch = taipeiLocalToEpoch(dateStr, timeStr);
  if (epoch === null) return '计划的日期或时间无效';
  if (epoch <= nowMs) return '一次性计划的执行时间已过，请选择未来的日期时间';
  return null;
}

/** 裁剪计划列表到上限，并保证 id 唯一（只保留前 N 项）。 */
export function clampPlans(plans: ShippingPlan[]): ShippingPlan[] {
  return retireLegacyRepeatPlans(plans).slice(0, SHIPPING_MAX_PLANS);
}

/**
 * 这条旧计划**是否真的承载过用户数据**（第 59.2 节）。
 *
 * 为什么需要它：`SHIPPING_DEFAULT_PLANS` 是两张**空白占位**（日期空、`ownerShopId: null`、
 * 从未运行、也没被迁移过）。从未设置过旧计划的人（storage 里没有 `_shippingPlans` 键，
 * 或显式写了 `[]`）在加载兜底时会拿到这两张占位，界面照 `plans.length > 0` 渲染，
 * 于是新用户看到两条"未绑定，请重新保存"的**根本不存在的**安排 ——
 * 而那个"重新保存"入口本轮已经下线，提示指向一个不存在的地方。
 *
 * 判据取"任一真实痕迹"，不用 `lastRunAt` 单条：
 * - `date` 非空 → 用户配置过执行日期；
 * - `enabled` → 用户启用过；
 * - `ownerShopId`／`ownerUserId` 非 `null` → 保存时绑定过归属（保存路径必写这两个字段）；
 * - `lastRunAt`／`lastResult`／`lastTaskId`／`lastRunId` → 真跑过；
 * - `retired` → 被迁移标记过；
 * - `missed` → 真到过点。
 *
 * 为什么不能只按 `lastRunAt` 过滤：验收明确要求保留"已配置日期／归属但从未运行"的禁用记录，
 * 那些记录恰恰没有 `lastRunAt`，按时间过滤会把用户的真实安排丢掉。
 */
export function isMeaningfulPlan(plan: ShippingPlan): boolean {
  return Boolean(
    plan.date ||
      plan.enabled ||
      plan.retired ||
      plan.missed ||
      plan.lastRunAt ||
      plan.lastResult ||
      plan.lastTaskId ||
      plan.lastRunId ||
      plan.ownerShopId !== null ||
      plan.ownerUserId !== null,
  );
}

/** 从计划列表里挑出真正承载过用户数据的记录（默认空占位会被滤掉）。 */
export function meaningfulPlans(plans: ShippingPlan[]): ShippingPlan[] {
  return plans.filter(isMeaningfulPlan);
}

/**
 * 停用旧的"每日重复／两项独立计划"，但**保留记录本身**（第 34.2 节 R1）。
 *
 * 为什么放在这里、而不是逐个改保存分支：
 * `clampPlans` 是读写旧计划列表的**唯一汇合点**（界面保存、关闭计划、后台保存都经过它），
 * 在这一个地方强制降级，能保证**没有任何入口**再写回一个启用的重复计划；
 * 分散去改每个分支，只要漏一处，旧每日任务就又能被调度起来（验收就是按真实执行判定的）。
 *
 * 降级内容：`loopDaily` 置 false、`enabled` 置 false、标记 `retired` 并给出原因。
 * 不删除记录、不改 `lastRunId`／`lastTaskId`／归属锚，因此历史执行与物流收尾证据仍然可追溯；
 * 用户看到的是"已暂停"，而不是"记录凭空消失"。
 */
export function retireLegacyRepeatPlans(plans: ShippingPlan[]): ShippingPlan[] {
  return plans.map(plan => {
    if (!plan.loopDaily && !plan.retired) return plan;
    if (!plan.loopDaily) return plan;
    return {
      ...plan,
      loopDaily: false,
      enabled: false,
      retired: true,
      retiredReason: '旧的每日／每周重复已停用；请在新版「定时切换」里重新确认一次单次日期',
      updatedAt: plan.updatedAt || 0,
    };
  });
}

/** 是否存在需要用户重新确认的旧重复计划（界面据此显示迁移提示）。 */
export function hasRetiredRepeatPlans(plans: ShippingPlan[]): boolean {
  return plans.some(p => p.retired);
}

// ===== 排除规则合并（手动优先） =====

/**
 * 计算最终写集合的排除判定。
 *
 * 手动排除优先级最高：即使商品同时被特卖排除命中，也按"手动排除"归类，
 * 因为用户手动填的 ID 是明确意图，不能被别的规则覆盖。
 */
export function classifyExclusion(
  itemId: string,
  manual: Set<string>,
  flashSale: Set<string>,
): 'manual' | 'flash-sale' | null {
  if (manual.has(itemId)) return 'manual';
  if (flashSale.has(itemId)) return 'flash-sale';
  return null;
}

// ===== 确认内容比对（返工 17.1）=====

/** 把设置里的排除文本规范化成稳定形式，避免"同一份排除写得不一样"被误判成内容变更。 */
function normalizeExcludeText(text: unknown): string {
  return [...parseExcludeIds(typeof text === 'string' ? text : '')].sort().join(',');
}

/**
 * 比对"这份预览确认时的内容"与"本次启动消息里的内容"。
 *
 * **为什么要比对**：预览请求号只证明"这个预览存在"，不证明"要执行的就是它"。
 * 用户（或任何改客户端数据的一方）完全可以拿同一个有效请求号换一套天数或额外商品，
 * 后台若照单全收，就把确认过的范围悄悄扩大了 —— 这正是返工 17.1 复现的缺陷。
 *
 * 规则：设置逐字段必须**完全一致**；商品集合必须是原集合的**子集或全等**
 * （减少是既有规则允许的，例如开跑前被排除规则命中而掉出；增加一律拒绝）。
 */
export function compareShippingConfirmedContent(
  confirmed: { settings: ShippingPreviewSettings; itemIds: string[] },
  incoming: { settings: ShippingPreviewSettings; itemIds: string[] },
): ShippingContentDiff[] {
  const diffs: ShippingContentDiff[] = [];

  const cDays = Number(confirmed.settings.days);
  const iDays = Number(incoming.settings.days);
  if (cDays !== iDays) diffs.push({ kind: 'settings-days', detail: `天数 ${cDays} → ${iDays}` });

  if (confirmed.settings.range !== incoming.settings.range) {
    diffs.push({
      kind: 'settings-range',
      detail: `范围 ${confirmed.settings.range} → ${incoming.settings.range}`,
    });
  }

  const cEx = normalizeExcludeText(confirmed.settings.excludeIds);
  const iEx = normalizeExcludeText(incoming.settings.excludeIds);
  if (cEx !== iEx) {
    diffs.push({
      kind: 'settings-exclude',
      detail: `排除项 ${cEx || '(空)'} → ${iEx || '(空)'}`,
    });
  }

  const cLog = confirmed.settings.toggleLogistics === true;
  const iLog = incoming.settings.toggleLogistics === true;
  const cLogRaw = typeof confirmed.settings.toggleLogistics;
  const iLogRaw = typeof incoming.settings.toggleLogistics;
  if (cLog !== iLog || cLogRaw !== iLogRaw) {
    diffs.push({
      kind: 'settings-logistics',
      detail:
        cLogRaw !== iLogRaw
          ? `物流开关原值类型 ${cLogRaw}(${String(
              confirmed.settings.toggleLogistics,
            )}) → ${iLogRaw}(${String(incoming.settings.toggleLogistics)})`
          : `物流开关 ${cLog ? '开' : '关'} → ${iLog ? '开' : '关'}`,
    });
  }

  const confirmedSet = new Set(confirmed.itemIds);
  const incomingSet = new Set(incoming.itemIds);
  const extra = incoming.itemIds.filter(id => !confirmedSet.has(id));
  if (extra.length > 0) {
    diffs.push({
      kind: 'items-extra',
      detail: `多了 ${extra.length} 个预览外商品（如 ${extra.slice(0, 3).join('、')}）`,
    });
  }
  const missing = confirmed.itemIds.filter(id => !incomingSet.has(id));
  if (missing.length > 0) {
    // 减少本身是允许的（开跑前检查还会再过滤一次），所以**不**据它拒绝；
    // 但记下来，便于复验时看清"这次执行比确认时少了几件"。
    diffs.push({
      kind: 'items-missing',
      detail: `少了 ${missing.length} 个已确认商品（如 ${missing.slice(0, 3).join('、')}）`,
    });
  }

  return diffs;
}

/** 差异里只要出现"扩大集合"或"改设置"就不允许启动；纯减少可以继续。 */
export function hasBlockingContentDiff(diffs: ShippingContentDiff[]): boolean {
  return diffs.some(
    d =>
      d.kind === 'settings-days' ||
      d.kind === 'settings-range' ||
      d.kind === 'settings-exclude' ||
      d.kind === 'settings-logistics' ||
      d.kind === 'items-extra',
  );
}

/** 把差异拼成给用户看的一句话（脱敏；差异里本来就只有天数／范围／ID）。 */
export function describeContentDiff(diffs: ShippingContentDiff[]): string {
  return diffs.map(d => d.detail).join('；');
}

// ===== 设置规范化（返工 20.1）=====
//
// 比较与执行必须用**同一份**规范化后的设置。早先的做法是：比较时把物流开关
// `=== true` 化成 boolean（于是字符串 "true" 与 boolean true 被当成一样），
// 执行时却把原始的 `request.settings.toggleLogistics`（字符串 "true"）交给任务 ——
// 任务里再 `=== true` 一次，字符串就成了 false? 不，更糟：字符串 "true" 在
// `if (toggleLogistics)` 里为真，于是"预览说不操作物流"仍被关闭并恢复了渠道。
//
// 因此：**非 boolean 直接拒绝**，不猜测调用方意图。

/** 一条字段的原值类型与规范化结果（用于诊断；不含凭据） */
export function describeContentValues(raw: unknown): ShippingDiagnosticContentValue[] {
  const s = (raw ?? {}) as Partial<ShippingSettings>;
  const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const clip = (v: unknown) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v ?? null);
    return t !== undefined && t.length > 40 ? `${t.slice(0, 40)}…` : String(t);
  };
  return [
    { field: 'days', rawType: typeName(s.days), normalized: clip(Number(s.days)) },
    { field: 'range', rawType: typeName(s.range), normalized: clip(s.range) },
    { field: 'excludeIds', rawType: typeName(s.excludeIds), normalized: clip(s.excludeIds ?? '') },
    {
      field: 'toggleLogistics',
      rawType: typeName(s.toggleLogistics),
      normalized: clip(typeof s.toggleLogistics === 'boolean' ? s.toggleLogistics : '(非boolean)'),
    },
  ];
}

/**
 * 把外部传入的设置规范化成执行用的那一份；**不合规就拒绝**。
 *
 * `toggleLogistics` 必须是真正的 boolean：字符串 `"true"` / `"false"` 一律拒绝，
 * 因为一旦按 JS 真值语义处理，`"false"` 会变成"开"，与用户确认的内容正好相反。
 */
export function normalizePreviewSettings(
  raw: unknown,
): { ok: true; settings: ShippingPreviewSettings } | { ok: false; error: string } {
  const s = (raw ?? {}) as Partial<ShippingSettings>;
  if (typeof s.toggleLogistics !== 'boolean') {
    return {
      ok: false,
      error: `「自动管理店铺物流」必须是开关值（true/false），当前是 ${
        s.toggleLogistics === null ? 'null' : typeof s.toggleLogistics
      }，已拒绝；请重新预检后再开始`,
    };
  }
  if (!isValidDays(s.days)) {
    return { ok: false, error: `备货天数必须是 ${SHIPPING_MIN_DAYS}–${SHIPPING_MAX_DAYS} 之间的整数` };
  }
  if (!s.range || !['all', 'online', 'offline', 'nonhot'].includes(s.range)) {
    return { ok: false, error: '修改范围无效，请重新预检' };
  }
  const days = Number(s.days);
  return {
    ok: true,
    settings: {
      mode: modeForDays(days),
      days,
      range: s.range,
      excludeIds: typeof s.excludeIds === 'string' ? s.excludeIds : '',
      toggleLogistics: s.toggleLogistics,
    },
  };
}

// ===== 排除选择器的排名与检索（任务书第 31 节 31.4）=====
//
// 为什么排行必须用**完整店铺列表**：界面里可见的只是筛选后的前若干项，
// 用它当"全店前 N"会给出错的商品（用户以为排的是全店销量）。
// 因此这里只接收完整列表，排序与取前 N 全在这一个纯函数里完成。

/**
 * 候选列表的归属标记：列表**发起时**已核实的店铺与账号。
 *
 * 为什么要记 `userId`（第 43.2 节 R7）：同一家店可以换账号登入，商品列表是按
 * 账号取的。只比店铺时，"同店换账号"这条路径上的旧列表会被当成当前列表，
 * 用户就能把旧账号的商品确认进新账号的安排里（验收在真实 store 上复现过）。
 */
export interface PickListOwnership {
  shopId: number | null;
  userId: number | null;
}

/**
 * 候选列表是否属于**当前已核实的完整归属**（店铺＋账号）。
 *
 * 判据（任一条不成立即为"不可信"，界面必须暂停显示、也不得据此保存）：
 * - 当前归属本身已核实（店铺与账号都非 null）—— 没有依据的缓存不能用；
 * - 列表带有归属标记，且店铺与账号都与当前归属一致。
 *
 * 为什么抽成纯函数：store 的返回分支与弹窗的可信判定必须用**同一条**判据。
 * 早先弹窗自己写 `pickListShopId === ownerShopId`，只覆盖店铺，
 * 于是 store 修好了、弹窗仍认为旧账号的列表可用（验收复现）。
 */
export function isPickListOwnedBy(
  list: PickListOwnership | null | undefined,
  current: PickListOwnership,
): boolean {
  if (current.shopId === null || current.userId === null) return false;
  if (!list || list.shopId === null || list.userId === null) return false;
  return list.shopId === current.shopId && list.userId === current.userId;
}

/**
 * 按销量降序排列候选商品。
 *
 * 规则（31.4）：
 * - 销量未知（`null`）**不冒充 0**，排在已知销量之后；
 * - 相同销量按商品 ID 稳定排序，保证同一份输入每次得到同一顺序；
 * - ID 排序用数值比较（`"9"` 小于 `"10"`），避免字符串比较把 10 排到 9 前面。
 */
export function sortProductsBySold(products: ShippingPickableProduct[]): ShippingPickableProduct[] {
  return [...products].sort((a, b) => {
    const av = a.sold;
    const bv = b.sold;
    const aKnown = typeof av === 'number' && Number.isFinite(av);
    const bKnown = typeof bv === 'number' && Number.isFinite(bv);
    if (aKnown && bKnown && av !== bv) return (bv as number) - (av as number);
    if (aKnown !== bKnown) return aKnown ? -1 : 1;
    return Number(a.itemId) - Number(b.itemId);
  });
}

/**
 * 全店销量前 N 的商品 ID。
 *
 * 只从**已知销量**里取；不足 N 个就按实际数量返回（不补齐、不伪造）。
 * 结果固定为具体 ID，因此不会随未来销量变化自动换商品（31.4 要求）。
 */
export function topSoldItemIds(products: ShippingPickableProduct[], n: number): string[] {
  const known = products.filter(p => typeof p.sold === 'number' && Number.isFinite(p.sold));
  return sortProductsBySold(known)
    .slice(0, Math.max(0, Math.floor(n)))
    .map(p => p.itemId);
}

/**
 * 按商品 ID 检索（支持多段空白分隔的 ID；空检索词返回全部）。
 *
 * 语义：**包含匹配**，精确命中的排在前面。
 * 为什么不"有精确命中就只返回精确"：那样用户搜 `123` 与搜 `1234` 的行为不一致，
 * 且店铺里存在 `123` 时 `1234` 会突然搜不到，看起来像列表缺项。
 * 统一按包含匹配 + 精确优先，结果稳定可预期。
 */
export function searchByItemId(
  products: ShippingPickableProduct[],
  query: string,
): ShippingPickableProduct[] {
  const q = String(query || '').trim();
  if (!q) return products;
  const terms = q.split(/[\s,，;；]+/).filter(Boolean);
  const out: ShippingPickableProduct[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    const exact = products.filter(p => p.itemId === term);
    const partial = products.filter(p => p.itemId !== term && p.itemId.includes(term));
    for (const p of [...exact, ...partial]) {
      if (seen.has(p.itemId)) continue;
      seen.add(p.itemId);
      out.push(p);
    }
  }
  return out;
}

/** 追加勾选（保留已有选择、去重）——快捷前 N 与"全选检索结果"共用同一语义。 */
export function addPickedIds(current: Iterable<string>, add: string[]): string[] {
  const out = new Set(current);
  for (const id of add) {
    const t = String(id);
    if (/^\d+$/.test(t)) out.add(t);
  }
  return [...out];
}
