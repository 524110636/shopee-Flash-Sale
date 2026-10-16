/**
 * 商品备货与物流的接口适配层：只负责「拼请求 + 解析响应」，不做重试、不做结果归类。
 *
 * 为什么单独一层：源把这些 REST 调用散在 background 的大对象里，
 * 响应字段（尤其逐项错误码）与请求路径混在业务分支中，改一处要翻整段。
 * 这里集中成纯函数式适配器，runner 只调它、只处理业务语义。
 *
 * 凭据（`SPC_CDS` / `SPC_CDS_VER`）由调用方注入到 URL 参数，
 * 本模块不打印、不返回、不落盘这些值。
 */

import type { ShippingChannel, ShippingProduct } from './types';

export const SELLER_ORIGIN = 'https://seller.shopee.tw';

export const SHIPPING_ENDPOINTS = {
  productList: `${SELLER_ORIGIN}/api/v3/product/search_product_list_v2/`,
  updateProduct: `${SELLER_ORIGIN}/api/v3/product/update_product/`,
  productInfo: `${SELLER_ORIGIN}/api/v3/product/get_product_info`,
  channelList: `${SELLER_ORIGIN}/api/v3/logistics/get_channel_list`,
  channelToggle: `${SELLER_ORIGIN}/api/v3/settings/update_channel_toggle`,
  flashSaleList: `${SELLER_ORIGIN}/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_list/`,
  flashSaleItemIds: `${SELLER_ORIGIN}/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_item_id_list/`,
} as const;

/** 注入的 MAIN-world 页面请求能力（由 background 提供，实现细节不进入本模块）。 */
export interface ShippingFetch {
  <T>(url: string, method?: 'GET' | 'POST', body?: object): Promise<T>;
}

/** 凭据注入：调用方负责取最新 Cookie，模块只管拼串。 */
export function withCredential(
  url: string,
  credential: { spcCds: string; spcCdsVer: string },
  params: Record<string, string | number | undefined> = {},
): string {
  const usp = new URLSearchParams();
  usp.set('SPC_CDS', credential.spcCds);
  usp.set('SPC_CDS_VER', credential.spcCdsVer);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    usp.set(k, String(v));
  }
  return `${url}?${usp.toString()}`;
}

// ===== 商品列表（分页，cursor 契约） =====

export interface ProductPage {
  list: ShippingProduct[];
  cursor: string;
  total: number | null;
}

/**
 * 解析一页商品列表。
 *
 * 契约：HTTP 成功且 `code === 0`，数据在 `data.list`，游标在 `data.page_info.cursor`。
 * 不用 `data.list` 之外的自定义形状，也不把失败当空列表 ——
 * 「读不到」和「店铺里没商品」是两件事，后者会让预检放行一个空写集合。
 */
export function parseProductPage(response: unknown): ProductPage {
  const data = (response as any)?.data;
  const list = Array.isArray(data?.list) ? (data?.list as ShippingProduct[]) : [];
  const cursorRaw = data?.page_info?.cursor;
  const totalRaw = data?.page_info?.total;
  const cursor = typeof cursorRaw === 'string' ? cursorRaw : cursorRaw == null ? '' : String(cursorRaw);
  const total = typeof totalRaw === 'number' ? totalRaw : null;
  return { list, cursor: cursor === '0' ? '' : cursor, total };
}

export function isApiSuccess(response: unknown): boolean {
  const code = (response as any)?.code;
  return Number(code) === 0;
}

export function apiErrorMessage(response: unknown): string {
  const r = response as any;
  return String(r?.message || r?.msg || r?.error_message || '平台返回失败');
}

/**
 * 单页抓取（不重试）。重试与退避由调用方决定，避免同一层既重试又解析。
 * `pageSize` 固定 50，与源一致；`source=attribute_tool` 是备货工具专用来源标识。
 */
export async function fetchProductPage(
  fetchFn: ShippingFetch,
  credential: { spcCds: string; spcCdsVer: string },
  cursor: string,
  pageSize = 50,
): Promise<ProductPage> {
  const url = withCredential(SHIPPING_ENDPOINTS.productList, credential, {
    page_size: pageSize,
    source: 'attribute_tool',
    cursor,
    version: '4.0.0',
  });
  const response = await fetchFn<any>(url);
  if (!isApiSuccess(response)) throw new Error(`商品列表读取失败：${apiErrorMessage(response)}`);
  return parseProductPage(response);
}

/**
 * 翻完所有页。
 *
 * 三条判定都会让整批**报不完整**而不是静默截断：
 * 重复游标（平台异常会把同一页反复返回，硬跑会写出重复 ID）、中途失败、
 * 以及页数保护上限。调用方拿到 `complete: false` 必须停在预检。
 */
export async function fetchAllProducts(
  fetchFn: ShippingFetch,
  credential: { spcCds: string; spcCdsVer: string },
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<{ products: ShippingProduct[]; complete: boolean; error?: string }> {
  const maxPages = options.maxPages ?? 400;
  const pageSize = options.pageSize ?? 50;
  const products: ShippingProduct[] = [];
  const seenCursors = new Set<string>();
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    let parsed: ProductPage;
    try {
      parsed = await fetchProductPage(fetchFn, credential, cursor, pageSize);
    } catch (e: any) {
      return { products, complete: false, error: e?.message || String(e) };
    }
    products.push(...parsed.list);
    if (parsed.list.length < pageSize || !parsed.cursor) return { products, complete: true };
    if (seenCursors.has(parsed.cursor)) {
      return { products, complete: false, error: '商品列表分页游标重复，读取不完整' };
    }
    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }
  return { products, complete: false, error: '商品列表页数超过保护上限，读取不完整' };
}

// ===== 持久错误脱敏（R7） =====

/**
 * 最小错误脱敏：写进 storage／日志的文本一律先过这里。
 *
 * **为什么必须在这里做**：runner 与 background 会把异常原因持久化成"给用户看的结果"，
 * 而底层请求 URL 里带 `SPC_CDS` 等查询参数。一旦把原始异常原样落盘，
 * 凭据就进了 storage 与用户可见的错误文案。
 *
 * 保留可定位信息（动作、商品／渠道 ID、状态码、可读原因），只替换敏感值本身。
 */
export function redactSensitiveText(text: unknown): string {
  const raw = typeof text === 'string' ? text : text instanceof Error ? text.message : String(text ?? '');
  return raw
    // 查询参数里的凭据（SPC_CDS/SPC_CDS_VER 及其他常见命名的 token/key/secret/password/cookie）
    .replace(/((?:SPC_CDS|SPC_CDS_VER|spc_cds|access_token|refresh_token|token|api[_-]?key|secret|password|passwd|pwd|cookie|authorization)=)[^&\s'"]+/gi, '$1***')
    // Bearer / JWT 字面量
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/\beyJ[A-Za-z0-9._-]{10,}\b/g, '***')
    // Cookie 头整体
    .replace(/((?:^|[\s;])(?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi, '$1***')
    // URL 里任何 SPC_CDS 形态的残留
    .replace(/(SPC_CDS[^=]*=\s*)[^&\s'"]+/gi, '$1***');
}

/** 脱敏后的 Error（保留 name，不保留原始 stack） */
export function redactError(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(`${error.name}: ${error.message}`);
  }
  return redactSensitiveText(error);
}

// ===== 商品详情（按需，判断 SKU 级备货） =====

export async function fetchProductDetail(
  fetchFn: ShippingFetch,
  credential: { spcCds: string; spcCdsVer: string },
  itemId: string,
): Promise<any | null> {
  const url = withCredential(SHIPPING_ENDPOINTS.productInfo, credential, {
    product_id: itemId,
    is_draft: 'false',
  });
  const response = await fetchFn<any>(url);
  if (!isApiSuccess(response)) return null;
  return response?.data?.product_info ?? null;
}

// ===== 批量改备货 =====

export interface BatchWriteOutcome {
  /** 顶层是否确认成功（HTTP 成功 + code 0） */
  topLevelSuccess: boolean;
  /**
   * 逐项结果。`code` 为 `null` 表示**平台没给这一项的 code** ——
   * 调用方必须按"无法解释"处理（先核实，不能当成功）。
   */
  itemResults: Array<{ id: string; code: number | null }>;
  /** 顶层错误信息 */
  error?: string;
  /** 顶层错误码 */
  topCode: number;
  /** 响应里带了逐项结果数组（用于区分"没有逐项结果"与"逐项结果为空"） */
  hasItemResults: boolean;
}

/**
 * 解析批量改备货的响应。
 *
 * 关键点：
 * 1. **顶层 code 0 不等于每件都成功**。源用 `1000100007` 时逐项核对 `data.result[].id/code`；
 *    这里统一把逐项结果交回调用方，由 runner 决定按 ID 归类。
 * 2. **缺 code 不能默认 0**：以前写 `Number(entry.code ?? entry.err_code ?? 0)`，
 *    于是平台只回一个 `{id:101}` 就被当成"这件成功了"。现在缺 code 记 `null`，
 *    调用方按 `unknown` 处理并回读核实。
 */
export function parseBatchWriteResponse(response: unknown): BatchWriteOutcome {
  const r = response as any;
  const topCode = Number(r?.code);
  const topLevelSuccess = topCode === 0;
  const rawArray = Array.isArray(r?.data?.result)
    ? (r.data.result as any[])
    : Array.isArray(r?.data)
      ? (r.data as any[])
      : null;
  const rawResults = rawArray ?? [];
  const itemResults: Array<{ id: string; code: number | null }> = [];
  for (const entry of rawResults) {
    if (!entry || typeof entry !== 'object') continue;
    const id = entry.id ?? entry.item_id ?? entry.product_id;
    if (id === undefined || id === null) continue;
    const rawCode = entry.code ?? entry.err_code;
    const code = rawCode === undefined || rawCode === null ? null : Number(rawCode);
    itemResults.push({ id: String(id), code: Number.isFinite(code as number) ? (code as number) : null });
  }
  return {
    topLevelSuccess,
    itemResults,
    error: topLevelSuccess ? undefined : apiErrorMessage(response),
    topCode,
    hasItemResults: rawArray !== null,
  };
}

/** 需要重新核对的逐项错误码（平台把该项算进 result 但不是确定成功/失败） */
export const SHIPPING_ITEM_CODE = {
  /** 物流不支持该备货天数 —— 单列跳过，不能算成功 */
  unsupportedDays: 1000100252,
  /** 平台自述频率限制（业务码） */
  shopeeRateLimit: 1000100006,
} as const;

/**
 * 频率限制识别：HTTP 429／409 与平台业务码 1000100006。
 *
 * **只有明确被拒绝的次数限制才允许重试**；超时、连接断开、响应无法解析属于
 * "可能已经写成功"，重发会造成重复写，必须交回读定案（R2）。
 */
export function isRateLimitError(message: string): boolean {
  return /\b(429|409)\b/.test(message) || message.includes(String(SHIPPING_ITEM_CODE.shopeeRateLimit));
}

export interface BatchWriteResult {
  /** 顶层是否确认成功（HTTP 成功 + code 0） */
  topLevelSuccess: boolean;
  /** 逐项结果；`code: null` 表示平台没给这一项的 code（不得当成功） */
  itemResults: Array<{ id: string; code: number | null }>;
  /** 顶层错误信息 */
  error?: string;
  /** 顶层错误码；HTTP 层错误时为 HTTP 状态码 */
  topCode: number;
  /** 响应里是否带逐项结果数组 */
  hasItemResults: boolean;
  /** 明确被限流（可退避重试） */
  rateLimited: boolean;
  /**
   * 传输结果未知：请求可能已到平台。
   * 调用方**不得重发**，应标 `unknown` 并回读核实。
   */
  transportUnknown: boolean;
}

/**
 * 提交一批备货修改。
 *
 * 三种结果分开表达，调用方不需要解析异常：
 * - 正常响应 → 按 `topLevelSuccess` / `itemResults` 归类；
 * - 明确限流 → `rateLimited: true`（可退避重试）；
 * - 传输失败／响应无法解析 → `transportUnknown: true`（**不可重发**，回读定案）。
 */
export async function updateProductBatch(
  fetchFn: ShippingFetch,
  credential: { spcCds: string; spcCdsVer: string },
  items: Array<{ id: number; category_path: string; pre_order: boolean; days_to_ship: number }>,
): Promise<BatchWriteResult> {
  const url = withCredential(SHIPPING_ENDPOINTS.updateProduct, credential, {
    version: '3.1.0',
    source: 'attribute_tool',
  });
  let response: unknown;
  try {
    response = await fetchFn<unknown>(url, 'POST', items);
  } catch (e: any) {
    const message = e?.message || String(e);
    if (isRateLimitError(message)) {
      return {
        topLevelSuccess: false,
        itemResults: [],
        error: message,
        topCode: Number((message.match(/\b(429|409)\b/) || [])[1] || 0),
        hasItemResults: false,
        rateLimited: true,
        transportUnknown: false,
      };
    }
    return {
      topLevelSuccess: false,
      itemResults: [],
      error: message,
      topCode: 0,
      hasItemResults: false,
      rateLimited: false,
      transportUnknown: true,
    };
  }
  const parsed = parseBatchWriteResponse(response);
  return {
    ...parsed,
    rateLimited: Number(parsed.topCode) === SHIPPING_ITEM_CODE.shopeeRateLimit,
    transportUnknown: false,
  };
}

// ===== 物流渠道 =====

/** 解析渠道列表；只接受 `code 0`，失败返回 null 让调用方区分「读失败」与「没有渠道」。 */
export function parseChannelList(response: unknown): ShippingChannel[] | null {
  const r = response as any;
  if (Number(r?.code) !== 0) return null;
  const list = r?.data?.list;
  if (!Array.isArray(list)) return null;
  return list
    .filter((c: any) => c && c.channel_id !== undefined && c.channel_id !== null)
    .map((c: any) => ({ channelId: Number(c.channel_id), enabled: c.enabled === true }));
}

export async function fetchChannelList(
  fetchFn: ShippingFetch,
  credential: { spcCds: string; spcCdsVer: string },
): Promise<ShippingChannel[] | null> {
  const url = withCredential(SHIPPING_ENDPOINTS.channelList, credential);
  const response = await fetchFn<any>(url);
  return parseChannelList(response);
}

export interface ChannelToggleResult {
  success: boolean;
  error?: string;
  /** 结果未知（发送成功但响应不可解析）：需要回读确认 */
  unknown?: boolean;
}

/**
 * 单个渠道开关。
 *
 * `proceed_with_mass_toggle_on_item_channels: false` 是刻意的：不要顺带改动商品级渠道，
 * 本任务只改店铺级总开关，商品级留给后续独立工具。
 *
 * 传输异常 → `unknown: true`（可能已生效）；明确非 0 业务码 → 确定失败。
 */
export async function updateChannelToggle(
  fetchFn: ShippingFetch,
  credential: { spcCds: string; spcCdsVer: string },
  channelId: number,
  enabled: boolean,
): Promise<ChannelToggleResult> {
  const url = withCredential(SHIPPING_ENDPOINTS.channelToggle, credential);
  let response: any;
  try {
    response = await fetchFn<any>(url, 'POST', {
      command: 'set_enable',
      enabled,
      channel_id: channelId,
      proceed_with_mass_toggle_on_item_channels: false,
    });
  } catch (e: any) {
    return { success: false, error: e?.message || String(e), unknown: true };
  }
  if (!response || typeof response !== 'object' || !('code' in response)) {
    return { success: false, error: '渠道开关响应无法解析', unknown: true };
  }
  if (Number(response.code) !== 0) {
    return { success: false, error: apiErrorMessage(response) };
  }
  return { success: true };
}

// ===== 特卖排除调查（只读） =====

/** 特卖列表分页参数；源用 offset/limit，这里显式翻页而不是只看第一页。 */
const FLASH_SALE_LIST_PAGE_SIZE = 50;
const FLASH_SALE_LIST_MAX_PAGES = 40;

/**
 * 翻完进行中／即将开始的特卖活动列表。
 *
 * **为什么必须翻页**：只读第一页会在活动较多时漏掉后面的活动，
 * 于是那些活动里的商品不会被排除，本次修改就会写进去 —— 这正是"看起来成功但踩了活动"的成因。
 * 用 `has_more`／`total`／返回条数三种信号任意一种判定是否继续，读取到上限即视为不完整。
 */
async function fetchActiveFlashSales(
  fetchFn: ShippingFetch,
  credential: { spcCds: string; spcCdsVer: string },
): Promise<{ ok: boolean; sales: any[]; error?: string }> {
  const sales: any[] = [];
  let offset = 0;
  for (let page = 0; page < FLASH_SALE_LIST_MAX_PAGES; page++) {
    let response: any;
    try {
      response = await fetchFn<any>(
        withCredential(SHIPPING_ENDPOINTS.flashSaleList, credential, {
          offset,
          limit: FLASH_SALE_LIST_PAGE_SIZE,
          type: 0,
        }),
      );
    } catch (e: any) {
      return { ok: false, sales, error: `特卖活动列表读取失败（第 ${page + 1} 页）：${e?.message || String(e)}` };
    }
    if (Number(response?.code) !== 0) {
      return { ok: false, sales, error: `特卖活动列表读取失败：${apiErrorMessage(response)}` };
    }
    const list = response?.data?.flash_sale_list;
    if (!Array.isArray(list)) {
      return { ok: false, sales, error: '特卖活动列表响应缺少 flash_sale_list 字段' };
    }
    sales.push(...list);
    const totalRaw = response?.data?.total ?? response?.data?.page_info?.total;
    const total = typeof totalRaw === 'number' ? totalRaw : null;
    const hasMore = response?.data?.has_more === true;
    const gotFullPage = list.length === FLASH_SALE_LIST_PAGE_SIZE;
    const reachedEnd = list.length === 0 || (!hasMore && total !== null && sales.length >= total) || !gotFullPage;
    if (reachedEnd) return { ok: true, sales };
    offset += FLASH_SALE_LIST_PAGE_SIZE;
  }
  return { ok: false, sales, error: '特卖活动列表页数超过保护上限，读取不完整' };
}

/**
 * 取「进行中／即将开始」的特卖商品 ID，用作自动排除。
 *
 * 只读：不调用任何特卖写接口。
 *
 * **失败即整体失败（fail closed）**：任一活动列表页读失败、任一活动的商品 ID 读取失败、
 * 或响应缺字段，都返回 `ok: false`。**不能**把失败解释成"这个活动没有商品"——
 * 那会让本应排除的商品进入写集合。调用方拿到 `ok: false` 必须停在预检／执行前检查。
 */
export async function fetchFlashSaleExcludeIds(
  fetchFn: ShippingFetch,
  credential: { spcCds: string; spcCdsVer: string },
  nowSeconds: number,
): Promise<{ ok: boolean; itemIds: Set<string>; error?: string }> {
  const itemIds = new Set<string>();
  const listResult = await fetchActiveFlashSales(fetchFn, credential);
  if (!listResult.ok) return { ok: false, itemIds, error: listResult.error };

  // 按 start_time / end_time 认定进行中或即将开始（源同规则）
  const relevant = listResult.sales.filter((sale: any) => {
    const start = Number(sale?.start_time || 0);
    const end = Number(sale?.end_time || 0);
    const upcoming = start > nowSeconds;
    const ongoing = start <= nowSeconds && nowSeconds < end;
    return upcoming || ongoing;
  });

  for (const sale of relevant) {
    const saleId = sale?.flash_sale_id;
    if (saleId === undefined || saleId === null) {
      return { ok: false, itemIds, error: '特卖活动缺少 flash_sale_id，无法确认排除集合' };
    }
    let itemResponse: any;
    try {
      itemResponse = await fetchFn<any>(
        withCredential(SHIPPING_ENDPOINTS.flashSaleItemIds, credential, { flash_sale_id: saleId }),
      );
    } catch (e: any) {
      // 任一活动读不到就不能确认整体排除集合：直接失败，不"跳过这个活动继续"。
      return {
        ok: false,
        itemIds,
        error: `特卖活动 ${saleId} 的商品读取失败：${e?.message || String(e)}`,
      };
    }
    if (Number(itemResponse?.code) !== 0) {
      return {
        ok: false,
        itemIds,
        error: `特卖活动 ${saleId} 的商品读取失败：${apiErrorMessage(itemResponse)}`,
      };
    }
    const list = itemResponse?.data?.item_ids;
    if (!Array.isArray(list)) {
      return { ok: false, itemIds, error: `特卖活动 ${saleId} 响应缺少 item_ids 字段` };
    }
    for (const id of list) itemIds.add(String(id));
  }
  return { ok: true, itemIds };
}
