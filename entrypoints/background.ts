import { defineBackground } from 'wxt/utils/define-background';
import type { ShopeeProduct, EnableItem, EnableResult, EnableProgress, SkuOverride, CopyTaskStatus, ScheduledCopyParams, CopiedSaleData, ScheduledTaskStatus, AutoModeStatus, AutoModeLog, TimeSlot, OneDayRepairTask, OneDayRepairRequest, OneDayRepairHeartbeat } from './popup/types';
import {
  ONE_DAY_REPAIR_TASK_KEY,
  ONE_DAY_REPAIR_HEARTBEAT_KEY,
  ONE_DAY_REPAIR_REQUEST_KEY,
  ONE_DAY_REPAIR_START_ERROR_KEY,
  ONE_DAY_REPAIR_DIAGNOSTICS_KEY,
  REPAIR_DIAGNOSTIC_LIMIT,
  REPAIR_KEEPALIVE_INTERVAL_MS,
  buildRepairDiagnostic,
  createRepairTask,
  isRepairTaskActive,
  isTerminalRepairStatus,
  resolveOrphanedTask,
  type OneDayRepairDiagnostic,
} from './popup/one-day-sku-task';
import {
  buildInitialItems,
  describeConfirmedActions,
  runOneDaySkuRepairTask,
  RepairCheckpointSaveError,
  RepairOwnershipError,
  RepairStaleWriteError,
} from './popup/one-day-sku-runner';

// ===== Constants =====
const GRAPHQL_URL = 'https://seller.shopee.tw/api/marketing/v4/graphql/query/';
const FLASH_SALE_API = 'https://seller.shopee.tw/api/marketing/v4/shop_flash_sale';
const COPY_MAX_RETRIES = 10;
const DEFAULT_BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5724';
const FALLBACK_BACKEND_URL = import.meta.env.VITE_BACKEND_FALLBACK_URL || '';

function tryBackendFetch(url: string, init?: RequestInit, baseUrl?: string): Promise<Response> {
  return fetch(url, init).catch((primaryErr) => {
    if (!FALLBACK_BACKEND_URL) throw primaryErr;
    const fromUrl = baseUrl || DEFAULT_BACKEND_URL;
    const fallbackUrl = url.replace(fromUrl, FALLBACK_BACKEND_URL);
    if (import.meta.env.VITE_DEBUG_LOGS === 'true') console.warn('[bg] 主域名请求失败，尝试 IP 直连:', fallbackUrl);
    return fetch(fallbackUrl, init).catch(() => {
      throw primaryErr;
    });
  });
}

const PRODUCTS_QUERY = `query Products($productIds: [String], $statusType: Int) {
  products(productIds: $productIds, statusType: $statusType) {
    items {
      itemid, name, images, status, inputOriginPrice, originPrice,
      normalStock, modelList {
        modelid, name, originPrice, normalStock, totalNormalStock
      }
    }
  }
}`;

// ===== State =====
let _enableStopRequested = false;
let _enableRunning = false;
/** 复制（关闭/创建活动 + 提交商品）正在实际执行；用于与一键修复互斥 */
let _copyExecuting = false;
let _autoModeStopRequested = false;
let _autoModeStarting = false;
/** 一键修复：同一时刻只允许一个 task 执行（防重入），不跨 worker 重启存活 */
let _repairRunningTaskId: string | null = null;
/**
 * 启动互斥：必须在第一个 await 之前同步取得（Chrome 事件循环单线程，同步段不可被打断），
 * 否则两个并发启动会双双通过校验，第二个被"接受"却不会执行。
 */
let _repairStarting = false;
/** 一键修复保活定时器；终态必须清理 */
let _repairKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

// ===== Params type for enable loop =====
interface EnableParams {
  products: ShopeeProduct[];
  flashSaleId: number;
  spcCds: string;
  spcCdsVer: string;
  shopId?: number | null;
  maxRetries: number;
  infiniteRetry: boolean;
  discountRate: number;
  flashSaleStock: number;
  purchaseLimit: number;
  skuOverrides: Record<string, SkuOverride>;
  skipSkuKeys?: string[];
}

interface FailedItemDetail {
  itemId: number;
  modelId: number;
  image: string;
  itemName: string;
  modelName: string;
  promoPrice: number;
  stock: number;
  purchaseLimit: number;
  errMsg: string;
}

// ===== Progress helpers =====
async function saveProgress(progress: EnableProgress, running: boolean, error?: string) {
  await browser.storage.local.set({ _enableProgress: { progress, error, running } });
}

async function sendProgressToContentScript(progress: EnableProgress, failedItemDetails?: FailedItemDetail[]) {
  try {
    const tabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
    for (const tab of tabs) {
      if (tab.id) {
        await browser.tabs.sendMessage(tab.id, { type: 'ENABLE_PROGRESS', progress, failedItemDetails }).catch(() => {});
      }
    }
  } catch {
    // no content script — fine
  }
}

async function sendCompleteToContentScript(progress: EnableProgress, failedItemDetails?: FailedItemDetail[]) {
  try {
    const tabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
    for (const tab of tabs) {
      if (tab.id) {
        await browser.tabs.sendMessage(tab.id, { type: 'ENABLE_COMPLETE', progress, failedItemDetails }).catch(() => {});
      }
    }
  } catch {
    // no content script — fine
  }
}

async function sendProgress(progress: EnableProgress, error?: string, failedItemDetails?: FailedItemDetail[]) {
  try {
    await browser.runtime.sendMessage({ type: 'ENABLE_PROGRESS', progress, failedItemDetails, error });
  } catch {
    // popup closed — OK, progress is saved to storage
  }
  await sendProgressToContentScript(progress, failedItemDetails);
}

async function sendComplete(progress: EnableProgress, error?: string, failedItemDetails?: FailedItemDetail[]) {
  try {
    await browser.runtime.sendMessage({ type: 'ENABLE_COMPLETE', progress, failedItemDetails, error });
  } catch {
    // popup closed
  }
  await sendCompleteToContentScript(progress, failedItemDetails);
}

async function clearEnableState() {
  try {
    await browser.storage.local.remove(['_enableParams', '_enableProgress']);
  } catch { /* ignore */ }
}

// ===== Copy progress messaging =====
async function sendCopyMessage(type: string, data: Record<string, any> = {}) {
  const tabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
  for (const tab of tabs) {
    browser.tabs.sendMessage(tab.id!, { type, ...data }).catch(() => {});
  }
}

// ===== 保存复制活动的源商品数据（供新活动展示和开启限时特卖使用）=====
async function saveCopiedSaleData(data: CopiedSaleData) {
  const result = await browser.storage.local.get('_copiedSaleData');
  const allData: Record<string, CopiedSaleData> = result._copiedSaleData || {};
  allData[String(data.newFlashSaleId)] = data;
  await browser.storage.local.set({ _copiedSaleData: allData });
  console.log('[bg:copiedSaleData] 已保存:', data.newFlashSaleId, data.sourceFlashSaleName);
}

// ===== 商品状态过滤：通过 GraphQL 检查商品是否仍处于正常上架状态 =====
// 已下架/删除的商品在 Shopee API 中不会返回或 status !== 0，自动剔除
async function filterActiveProducts(
  products: ShopeeProduct[],
  spcCds: string,
  spcCdsVer: string,
): Promise<{ activeProducts: ShopeeProduct[]; activeIds: Set<string> }> {
  if (!products.length) return { activeProducts: [], activeIds: new Set() };

  const productIds = products.map(p => String(p.itemid));
  try {
    const graphqlResp = await injectedFetch<any>(
      `${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
      'POST',
      { query: PRODUCTS_QUERY, variables: { productIds, statusType: 0 } },
    );
    const freshItems: ShopeeProduct[] = graphqlResp?.data?.products?.items || [];
    // status === 0 表示正常上架，非 0 表示已下架/删除/违规
    // Number() 兼容 API 返回字符串 "0" 而非数字 0 的情况
    const activeIds = new Set(
      freshItems.filter(p => Number(p.status) === 0).map(p => String(p.itemid)),
    );

    const activeProducts = products.filter(p => activeIds.has(String(p.itemid)));
    const filteredCount = products.length - activeProducts.length;
    if (filteredCount > 0) {
      if (activeProducts.length === 0) {
        const rawStatuses = freshItems.slice(0, 5).map(p => `${p.itemid}:status=${p.status}(${typeof p.status})`).join(', ');
        console.warn(`[filterActiveProducts] 所有 ${products.length} 个商品均未通过活跃检查 (API 返回 ${freshItems.length} 个, 样本: ${rawStatuses})，保留原商品列表`);
        await logAutoMode('warning', `filterActiveProducts: 所有 ${products.length} 个商品均被判定为非活跃 (API 返回 ${freshItems.length} 个)，保留原商品以防误判`);
        return { activeProducts: products, activeIds: new Set(products.map(p => String(p.itemid))) };
      }
      console.log(`[filterActiveProducts] 已过滤 ${filteredCount} 个已下架/删除的商品 (共 ${products.length} → ${activeProducts.length})`);
      await logAutoMode('info', `filterActiveProducts: 已过滤 ${filteredCount} 个已下架/删除的商品 (${products.length} → ${activeProducts.length})`);
    }
    return { activeProducts, activeIds };
  } catch (e: any) {
    // GraphQL 调用失败时保留所有商品，避免阻塞复制流程
    console.warn('[filterActiveProducts] GraphQL API 调用失败，保留所有商品:', e?.message);
    await logAutoMode('warning', `filterActiveProducts: API 调用失败，保留所有 ${products.length} 个商品: ${e.message}`);
    return { activeProducts: products, activeIds: new Set(products.map(p => String(p.itemid))) };
  }
}

// ===== Utility: timeout race =====
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)),
  ]);
}

function getMonthEnd(): number {
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
  return Math.floor(endOfMonth.getTime() / 1000) - 1;
}

// ===== 从 Cookie 读取 SPC_CDS（供后台直接使用，不依赖 storage.local）=====
async function getSpcCdsFromCookies(): Promise<{ spcCds: string; spcCdsVer: string }> {
  const urls = ['https://seller.shopee.tw', 'https://shopee.tw', 'https://www.shopee.tw'];
  for (const url of urls) {
    try {
      const cookie = await browser.cookies.get({ url, name: 'SPC_CDS' });
      if (cookie?.value) {
        const verCookie = await browser.cookies.get({ url, name: 'SPC_CDS_VER' });
        return { spcCds: cookie.value, spcCdsVer: verCookie?.value || '2' };
      }
    } catch { /* next */ }
  }
  // getAll 回退
  const allCookies = await browser.cookies.getAll({ domain: '.shopee.tw' });
  const spc = allCookies.find(c => c.name === 'SPC_CDS');
  if (spc?.value) {
    const ver = allCookies.find(c => c.name === 'SPC_CDS_VER');
    return { spcCds: spc.value, spcCdsVer: ver?.value || '2' };
  }
  return { spcCds: '', spcCdsVer: '2' };
}

// ===== Analytics event reporting (fire-and-forget to backend) =====
async function reportAnalyticsEvent(eventType: string, eventData: Record<string, any> = {}) {
  try {
    const result = await browser.storage.local.get(['backendAuth', 'backendUrl']);
    const auth = result.backendAuth as { token?: string } | undefined;
    const backendUrl = result.backendUrl as string | undefined;
    if (!auth?.token || !backendUrl) return;
    await tryBackendFetch(`${backendUrl}/api/analytics/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ eventType, eventData }),
    }, backendUrl);
  } catch {
    // fire-and-forget, ignore errors
  }
}

// ===== Shop access validation (backend check) =====
async function validateShopAccess(spcCds: string, action: string, shopId?: number | null): Promise<{ allowed: boolean; error?: string }> {
  const debug = import.meta.env.VITE_DEBUG_LOGS === 'true';
  if (debug) console.log(`[bg:validate] 开始校验: action=${action}, spcCds=[已脱敏], shopId=${shopId ?? '(none)'}`);
  try {
    const result = await browser.storage.local.get(['backendAuth', 'backendUrl']);
    const auth = result.backendAuth as { token?: string } | undefined;
    const backendUrl = result.backendUrl as string | undefined;
    if (!auth?.token) {
      if (debug) console.warn('[bg:validate] ❌ 未登录后端系统');
      return { allowed: false, error: '未登录后端系统，请先登录' };
    }
    // fallback to default URL (store.ts 仅持久化非默认值)
    const baseUrl = backendUrl || DEFAULT_BACKEND_URL;
    const body = shopId != null ? { spcCds, action, shopId } : { spcCds, action };
    if (debug) console.log(`[bg:validate] 请求 POST ${baseUrl}/api/stores/validate, body=`, JSON.stringify({ ...body, spcCds: '[已脱敏]' }));
    const response = await tryBackendFetch(`${baseUrl}/api/stores/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.token}`,
      },
      body: JSON.stringify(body),
    }, baseUrl);
    const data = await response.json();
    if (debug) console.log(`[bg:validate] 后端响应: status=${response.status}, data=`, JSON.stringify(data));
    if (!response.ok) {
      if (debug) console.error(`[bg:validate] ❌ 验证失败: ${data.error || `HTTP ${response.status}`}`);
      return { allowed: false, error: data.error || `验证失败 (${response.status})` };
    }
    if (debug) console.log('[bg:validate] ✅ 验证通过');
    return { allowed: true };
  } catch (e: any) {
    if (debug) console.error(`[bg:validate] ❌ 网络错误: ${e.message}`);
    return { allowed: false, error: `无法连接后端服务: ${e.message}` };
  }
}

// 消耗试用次数 — 操作成功后调用，fire-and-forget
async function consumeTrial() {
  const debug = import.meta.env.VITE_DEBUG_LOGS === 'true';
  const logResult = (result: Record<string, unknown>) => {
    browser.storage.local.set({ _consumeTrialLog: { ...result, ts: Date.now() } }).catch(() => {});
  };
  try {
    const storageData = await browser.storage.local.get(['backendAuth', 'backendUrl']);
    const auth = storageData.backendAuth as { token?: string } | undefined;
    const backendUrl = storageData.backendUrl as string | undefined;
    if (!auth?.token) {
      if (debug) console.warn('[bg:consume-trial] 跳过：未找到 token');
      logResult({ status: 'skipped', reason: 'no_token' });
      return;
    }
    const baseUrl = backendUrl || DEFAULT_BACKEND_URL;
    const requestUrl = `${baseUrl}/api/stores/consume-trial`;
    logResult({ status: 'requesting', url: requestUrl, hasToken: true });
    const response = await tryBackendFetch(requestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${auth.token}` },
    }, baseUrl);
    if (!response.ok) {
      let errorMsg = `HTTP ${response.status}`;
      try { const data = await response.json(); if (data.error) errorMsg = data.error; } catch {}
      console.warn('[bg:consume-trial] 消耗试用失败:', errorMsg);
      logResult({ status: 'failed', error: errorMsg, httpStatus: response.status });
      return;
    }
    const data = await response.json();
    if (debug) console.log('[bg:consume-trial] 响应:', JSON.stringify(data));
    console.log('[bg:consume-trial] 试用次数已消耗');
    logResult({ status: 'success', consumed: data.consumed, reason: data.reason || null });
  } catch (e: any) {
    // fire-and-forget: 失败不阻塞操作
    console.warn('[bg:consume-trial] 消耗试用失败（不影响操作）:', e.message);
    logResult({ status: 'network_error', error: e.message });
  }
}

// ===== Session Keepalive（参考 shopee-plugin 的自动刷新机制）=====
const HEARTBEAT_ALARM = 'session-heartbeat';
const HEARTBEAT_INTERVAL_MINUTES = 4;

async function handleHeartbeat() {
  console.log('[bg:heartbeat] 开始保活检查');
  try {
    const sellerTabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
    if (sellerTabs.length === 0) {
      console.log('[bg:heartbeat] 没有 seller 标签页，跳过');
      return;
    }

    // 优先使用营销页面标签页
    const marketingTab = sellerTabs.find(t => t.url?.includes('/marketing/'));
    const targetTab = marketingTab || sellerTabs[0];
    if (!targetTab?.id) return;

    console.log('[bg:heartbeat] 标签页:', targetTab.url?.slice(0, 80));
    const results = await executeScriptSafe({
      target: { tabId: targetTab.id },
      world: 'MAIN',
      func: () => {
        try {
          const w = window as any;
          const session =
            w.__INITIAL_STATE__?.session?.sc_fe_session ||
            document.querySelector('meta[name="sc-fe-session"]')?.getAttribute('content') ||
            document.cookie.match(/(?:^|;\s*)sc_fe_session=([^;]*)/)?.[1] || '';
          if (session) {
            fetch('/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_list/?offset=0&limit=1', {
              credentials: 'include',
              headers: {
                accept: 'application/json',
                'sc-fe-session': session,
                'content-type': 'application/json',
              },
            }).catch(() => {});
          }
          return !!session;
        } catch { return false; }
      },
    }, 10000, '心跳保活');

    const alive = results?.[0]?.result === true;
    console.log('[bg:heartbeat] 保活完成:', alive ? '✓ 会话有效' : '✗ 会话为空');
    await browser.storage.local.set({ _lastHeartbeat: Date.now() });
  } catch (e: any) {
    console.log('[bg:heartbeat] 保活失败:', e?.message?.slice(0, 100));
  }
}

// ===== 带重试的 executeScript（处理 Service Worker 长时间休眠后权限未就绪的问题）=====
async function executeScriptSafe(
  params: any,
  timeoutMs: number,
  label: string,
): Promise<any[]> {
  const maxRetries = 5;
  let lastError: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await withTimeout(browser.scripting.executeScript(params), timeoutMs, label);
    } catch (e: any) {
      lastError = e;
      const msg: string = e?.message || '';
      if (msg.includes('Cannot access contents') || msg.includes('permission to access')) {
        const delay = 1000 * (attempt + 1);
        console.log(`[bg:executeSafe] 权限未就绪，${delay}ms 后第 ${attempt + 1}/${maxRetries} 次重试...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// ===== Injected fetch (MAIN world) — 仅靠 credentials: 'include' 发送 Cookie，无需 sc-fe-session =====
async function injectedFetch<T>(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  body?: object,
  referrerUrl?: string,
): Promise<T> {
  console.log('[bg:injectedFetch] 开始', { url: redactSpcCds(url), method, hasBody: !!body });
  const allTabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
  if (allTabs.length === 0) throw new Error('没有找到 seller.shopee.tw 标签页，请保持卖家中心页面打开');

  // 优先找营销页面，再回退到其他 seller 页面
  const marketingTabs = allTabs.filter(t => t.url?.includes('/marketing/'));
  const otherTabs = allTabs.filter(t => !t.url?.includes('/marketing/'));
  const selectedTab = marketingTabs[0] || otherTabs[0];

  if (!selectedTab?.id) throw new Error('没有找到 seller.shopee.tw 标签页，请保持卖家中心页面打开');
  console.log('[bg:injectedFetch] 选定标签页:', redactSpcCds(selectedTab.url || '').slice(0, 100));

  console.log('[bg:injectedFetch] 开始执行 API 请求...');
  const results = await executeScriptSafe({
    target: { tabId: selectedTab.id },
    world: 'MAIN',
    func: async (fetchUrl: string, fetchMethod: string, fetchBody: string | null, referrerUrl: string) => {
      try {
        const opts: RequestInit = {
          method: fetchMethod,
          credentials: 'include',
          cache: 'no-cache',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json;charset=UTF-8',
          },
        };
        if (referrerUrl) {
          opts.referrer = referrerUrl;
          opts.referrerPolicy = 'unsafe-url';
        }
        if (fetchBody) opts.body = fetchBody;
        const resp = await fetch(fetchUrl, opts);
        const bodyText = await resp.text();
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText || bodyText.slice(0, 200)}`);
        return JSON.parse(bodyText);
      } catch (e: any) {
        return { _error: e.message } as any;
      }
    },
    args: [url, method, body ? JSON.stringify(body) : null, referrerUrl || ''],
  }, 30000, 'API 请求');

  const result = results?.[0]?.result as any;
  if (!result) throw new Error('页面脚本执行返回为空，请刷新页面后重试');
  if (result._error) throw new Error(`API 请求失败: ${result._error}`);
  return result as T;
}

// ===== 一键修复：后台执行接线 =====

/** 写入后台权威任务记录（只由 background 调用） */
async function saveRepairTask(task: OneDayRepairTask) {
  // 必须真正落盘：写不进去就不能继续发新的商品写请求（调用方据此抛错）
  await browser.storage.local.set({ [ONE_DAY_REPAIR_TASK_KEY]: task });
}

/** 读取后台权威任务记录 */
async function readRepairTask(): Promise<OneDayRepairTask | null> {
  const stored = await browser.storage.local.get(ONE_DAY_REPAIR_TASK_KEY);
  return (stored[ONE_DAY_REPAIR_TASK_KEY] as OneDayRepairTask | undefined) ?? null;
}

/** 读取上传心跳（独立键，不与任务记录混写） */
async function readRepairHeartbeat(): Promise<OneDayRepairHeartbeat | null> {
  const stored = await browser.storage.local.get(ONE_DAY_REPAIR_HEARTBEAT_KEY);
  return (stored[ONE_DAY_REPAIR_HEARTBEAT_KEY] as OneDayRepairHeartbeat | undefined) ?? null;
}

/**
 * 取当前实际登录的店铺与虾皮账号 id。
 *
 * 查不到返回 null —— 调用方必须把 null 当作「不一致」并停止写请求，
 * 不允许把「核实不到」当成「与任务一致」放行。
 */
async function getRepairShopIdentity(spcCds: string, spcCdsVer: string): Promise<{ shopId: number | null; accountId: number | null }> {
  try {
    const data = await injectedFetch<{ id?: number; shopid?: number }>(
      `https://seller.shopee.tw/api/v2/login/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
    );
    // 只有真正拿到数字才认为核实成功
    const shopId = typeof data?.shopid === 'number' ? data.shopid : null;
    const accountId = typeof data?.id === 'number' ? data.id : null;
    return { shopId, accountId };
  } catch {
    return { shopId: null, accountId: null };
  }
}

/**
 * 由**当前持久记录**反推「已经确认产生的副作用」，用于最小脱敏诊断（不含凭据）。
 * 写请求已发出且已收到成功响应才算"已确认"。
 */
function describeConfirmedActionsForTask(task: OneDayRepairTask): string[] {
  const out: string[] = [];
  for (const item of task.items) {
    for (const action of describeConfirmedActions(item)) {
      out.push(`${item.itemId}: ${action}`);
    }
  }
  return out.slice(0, 20);
}

/**
 * 已发出但**结果未知**的写请求（用于诊断"要不要人工核对"）。
 *
 * 依据检查点里 `outcome === 'unknown'` 的记录 —— 只有这一类才真的"不知道平台处理了没有"。
 * 已确认成功（`outcome === 'success'`）的步骤不再列进来，避免把成功当成未知重复展示。
 */
function describeUnknownActionsForTask(task: OneDayRepairTask): string[] {
  const out: string[] = [];
  for (const cp of task.checkpoints) {
    if (!cp.writeSent || cp.outcome !== 'unknown') continue;
    const label = cp.promotionName ? `${cp.step}（${cp.promotionName}）` : cp.step;
    out.push(`${cp.itemId}: ${label} 已发出但结果未知，请人工核对`);
  }
  // 折扣逐活动结果里标记为 unknown 的同样要提示
  for (const item of task.items) {
    for (const r of item.discountRemovals ?? []) {
      if (r.status !== 'unknown') continue;
      out.push(`${item.itemId}: 折扣活动「${r.name}」移除结果未知，请人工核对`);
    }
  }
  return Array.from(new Set(out)).slice(0, 20);
}

/**
 * 追加一条最小脱敏诊断记录。
 *
 * 只为了"下一轮不用猜"：记录任务锚 vs 实际锚、阶段、原因与动作确认状态。
 * 永不记录凭据；写不进去也不影响修复本身。
 */async function recordRepairDiagnostic(entry: Omit<OneDayRepairDiagnostic, 'at'>) {
  try {
    const stored = await browser.storage.local.get(ONE_DAY_REPAIR_DIAGNOSTICS_KEY);
    const list = (stored[ONE_DAY_REPAIR_DIAGNOSTICS_KEY] as OneDayRepairDiagnostic[] | undefined) || [];
    const next = [...list, buildRepairDiagnostic(entry)].slice(-REPAIR_DIAGNOSTIC_LIMIT);
    await browser.storage.local.set({ [ONE_DAY_REPAIR_DIAGNOSTICS_KEY]: next });
  } catch {
    /* 诊断写不进去不影响修复 */
  }
}

/**
 * 当前认证的后端账号 id（与虾皮 accountId 属不同身份域，不能互相比相等）。
 *
 * **必须现读** `backendAuth`：启动消息里的 `ownerUserId` 是快照，
 * 修复期间用户切换账号后它就不再代表当前身份（BR1 曾因此放行写请求）。
 * 读不到（未登录/登出）返回 null，调用方按「不一致」停止写请求。
 */
async function getRepairAuthUserId(): Promise<number | null> {
  try {
    const stored = await browser.storage.local.get('backendAuth');
    const auth = stored.backendAuth as { token?: string; user?: { id?: number } } | undefined;
    if (!auth?.token) return null;
    const id = auth.user?.id;
    return typeof id === 'number' ? id : null;
  } catch {
    return null;
  }
}

/** 用 GraphQL 取回完整商品（含最新 SKU），供修复完成后准备可编辑结果 */
async function fetchRepairResultProducts(itemIds: string[]): Promise<ShopeeProduct[]> {
  const { spcCds, spcCdsVer } = await getSpcCdsFromCookies();
  if (!spcCds || itemIds.length === 0) return [];
  const data = await injectedFetch<{ data?: { products?: { items?: ShopeeProduct[] } } }>(
    `${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
    'POST',
    { query: PRODUCTS_QUERY, variables: { productIds: itemIds, statusType: 0 } },
  );
  return data?.data?.products?.items || [];
}

/**
 * 保活 + 心跳。
 *
 * 心跳写**独立键**（只含 taskId + 时间），不读改写整份任务记录 —— 否则就会
 * 「心跳读到 running → runner 写 completed → 迟到心跳把旧副本写回」的回退。
 * 同时定期核对：如果本实例已不再是执行者（例如任务被协调成中断），保活立刻停止。
 */
function startRepairKeepalive(taskId: string) {
  stopRepairKeepalive();
  const beat = () => {
    if (_repairRunningTaskId !== taskId) return;
    browser.storage.local
      .set({ [ONE_DAY_REPAIR_HEARTBEAT_KEY]: { taskId, at: Date.now() } })
      .catch(() => {});
  };
  beat();
  _repairKeepaliveTimer = setInterval(beat, REPAIR_KEEPALIVE_INTERVAL_MS);
}

function stopRepairKeepalive() {
  if (_repairKeepaliveTimer !== null) {
    clearInterval(_repairKeepaliveTimer);
    _repairKeepaliveTimer = null;
  }
}

/**
 * 协调旧的「执行中」记录。
 *
 * MV3 每个扩展同时只有一个 service worker，所以本实例没有执行者就等于没有执行者：
 * 启动时立刻判定，不需要等心跳过期（等待依赖的定时器会随 worker 被回收 —— BR5）。
 * 心跳只被读出来作为证据写进记录，便于用户核对。
 */
async function reconcileOrphanRepairTask(): Promise<boolean> {
  try {
    const task = await readRepairTask();
    if (!task) return false;
    const heartbeat = await readHeartbeatFor(task.taskId);
    const resolved = resolveOrphanedTask(task, _repairRunningTaskId === task.taskId, heartbeat);
    if (resolved && resolved.status !== task.status) {
      await saveRepairTask(resolved);
      await clearOrphanAlarm();
      console.log('[bg:repair] 检测到无执行者的旧任务，已标记中断:', task.taskId);
      return true;
    }
    // 本实例不是执行者且记录仍活跃：用 alarm 复检（不依赖会被回收的 setTimeout）
    if (isRepairTaskActive(task) && _repairRunningTaskId !== task.taskId) {
      scheduleOrphanAlarm();
    } else {
      await clearOrphanAlarm();
    }
    return false;
  } catch (e: any) {
    console.warn('[bg:repair] 协调旧任务失败:', e?.message || e);
    return false;
  }
}

/** 读心跳，并只在它属于该任务时才返回 */
async function readHeartbeatFor(taskId: string): Promise<{ taskId: string; at: number } | null> {
  const beat = await readRepairHeartbeat();
  return beat && beat.taskId === taskId ? beat : null;
}

/**
 * 用 alarm 兜底中断复检。
 *
 * 为什么不用长时间 setTimeout：worker 约 30 秒空闲即被回收，届时 timer 一并消失，
 * 判断永远跑不到。alarm 由浏览器持久调度，SW 醒来后能继续。
 */
const ORPHAN_ALARM = 'repair_orphan_check';

function scheduleOrphanAlarm() {
  // 1 分钟内复检一次即可：记录本就是"没有执行者"才会走到这里
  chrome.alarms.create(ORPHAN_ALARM, { delayInMinutes: 1 });
}

async function clearOrphanAlarm() {
  try {
    await chrome.alarms.clear(ORPHAN_ALARM);
  } catch { /* ignore */ }
}

/** 上下文菜单/日志用的脱敏：URL 里的 SPC_CDS 一律替换，避免凭据进日志 */
function redactSpcCds(text: string): string {
  return text.replace(/(SPC_CDS=)[^&\s'"]+/gi, '$1***');
}

/**
 * 启动一键修复：接受后立即返回，不等整批完成。
 *
 * 启动互斥在第一个 await 之前同步取得：Chrome 的监听回调是单线程同步段，
 * 两个并发消息会依次执行这一段，第二个必然看到 `_repairStarting` 已置位而得到忙态。
 *
 * `payload.requestId` 用于把本次启动绑定到它自己那份参数快照：
 * 参数键是共享的，另一个 popup 可能刚刚覆盖它。requestId 不匹配时拒绝启动，
 * 绝不用别人的参数去改商品。
 */
async function handleStartOneDayRepair(payload?: {
  ownerUserId?: number | null;
  requestId?: string;
}): Promise<{ success: boolean; error?: string; taskId?: string }> {
  if (_repairStarting) {
    const busy = '另一个修复启动正在处理中，请稍后再试';
    await recordRepairStartError(busy);
    return { success: false, error: busy };
  }
  _repairStarting = true;
  try {
    const result = await startOneDayRepairInner(payload);
    // 拒绝原因写进 storage：popup 不能只依赖消息返回（可能被其他监听者抢先应答）
    await recordRepairStartError(result.success ? null : result.error || '启动修复任务失败');
    if (!result.success) {
      // 最小脱敏诊断：启动为什么被拒（任务锚 vs 实际锚、阶段、原因）
      const stored = await browser.storage.local.get([ONE_DAY_REPAIR_TASK_KEY, ONE_DAY_REPAIR_REQUEST_KEY]);
      const existingTask = stored[ONE_DAY_REPAIR_TASK_KEY] as OneDayRepairTask | undefined;
      const request = stored[ONE_DAY_REPAIR_REQUEST_KEY] as OneDayRepairRequest | undefined;
      // 实际锚取"现在真正登录的账号"，不是客户端自称值 —— 诊断的意义就在于对比这两者
      const currentAuthUserId = await getRepairAuthUserId();
      await recordRepairDiagnostic({
        kind: 'start-rejected',
        taskId: existingTask?.taskId ?? null,
        requestId: payload?.requestId ?? request?.requestId ?? null,
        phase: existingTask?.phase ?? null,
        taskShopId: existingTask?.shopId ?? null,
        taskOwnerUserId: existingTask?.ownerUserId ?? null,
        actualShopId: null,
        actualUserId: currentAuthUserId,
        reason: result.error || '启动修复任务失败',
        confirmedActions: [],
        unknownActions: existingTask ? describeUnknownActionsForTask(existingTask) : [],
      });
    }
    return result;
  } finally {
    _repairStarting = false;
  }
}

/** 记录最近一次启动被拒的原因；成功则清除 */
async function recordRepairStartError(error: string | null) {
  try {
    if (error) {
      await browser.storage.local.set({ [ONE_DAY_REPAIR_START_ERROR_KEY]: { error, at: Date.now() } });
    } else {
      await browser.storage.local.remove(ONE_DAY_REPAIR_START_ERROR_KEY);
    }
  } catch { /* 记录失败不影响启动本身 */ }
}

async function startOneDayRepairInner(payload?: {
  ownerUserId?: number | null;
  requestId?: string;
}): Promise<{ success: boolean; error?: string; taskId?: string }> {
  // 已有修复在跑：明确忙态
  if (_repairRunningTaskId) {
    return { success: false, error: '已有修复任务正在执行，请等待完成后再启动' };
  }

    const stored = await browser.storage.local.get(ONE_DAY_REPAIR_REQUEST_KEY);
    const request = stored[ONE_DAY_REPAIR_REQUEST_KEY] as OneDayRepairRequest | undefined;
    if (!request) return { success: false, error: '未找到修复任务参数' };

    // 参数键是共享的：本次消息必须绑定到它自己那份快照，否则可能用别人的商品去改
    if (payload?.requestId && payload.requestId !== request.requestId) {
      return { success: false, error: '启动参数已被其他窗口覆盖，请重新点击一键修复' };
    }

    const existing = await readRepairTask();

    // 同一 requestId 重复投递：复用原任务，不产生第二套副作用
    if (existing && existing.requestId === request.requestId) {
      if (isRepairTaskActive(existing)) {
        if (_repairRunningTaskId === existing.taskId) return { success: true, taskId: existing.taskId };
        if (existing.writeStarted) {
          return { success: false, error: '该修复任务已中断且可能已修改商品，请先查看详情再决定是否重跑' };
        }
        runRepairInBackground(existing, request.products);
        return { success: true, taskId: existing.taskId };
      }
      return { success: true, taskId: existing.taskId };
    }

    // 已有另一个未结束的任务：明确忙态，不偷偷终止别人的任务
    if (existing && isRepairTaskActive(existing)) {
      return { success: false, error: '已有修复任务正在执行，请等待完成后再启动' };
    }

    // 旧任务已中断且可能改过商品：不静默覆盖其证据，先让用户核对
    if (existing && existing.status === 'interrupted' && existing.writeStarted) {
      return { success: false, error: '上一次修复中断且部分商品可能已修改，请先查看详情再启动新任务' };
    }

    // 与同店铺的既有写任务互斥：不偷偷停别人的任务，只拒绝新的修复
    const conflict = await findSameShopWriteConflict();
    if (conflict) return { success: false, error: conflict };

    // 凭据与归属都从 Cookie/后端现读，不信客户端传来的副本（请求里也不带凭据）
    const credential = await getSpcCdsFromCookies();
    if (!credential.spcCds) {
      return { success: false, error: '登录状态失效，请重新连接店铺' };
    }

    // 无人看守的执行必须补上只读访问校验（旧 popup 循环没有这一步）
    const validation = await validateShopAccess(credential.spcCds, 'wizard_flow', request.shopId ?? undefined);
    if (!validation.allowed) {
      return { success: false, error: validation.error || '店铺访问校验未通过' };
    }

    // 归属必须来自实际核实身份，而不是客户端请求里的自称值
    const identity = await getRepairShopIdentity(credential.spcCds, credential.spcCdsVer);
    if (identity.shopId === null) {
      return { success: false, error: '无法核实当前店铺身份，已拒绝启动修复（请确认已登录卖家中心）' };
    }

    // 账号锚也必须来自**当前实际认证**，不能沿用客户端自称值。
    // 若这里存了空锚/null，之后 `isSameOwner` 会跳过账号比较 —— 换号也拦不住（BR1 复验复现）。
    const currentAuthUserId = await getRepairAuthUserId();
    if (currentAuthUserId === null) {
      return { success: false, error: '未能确认当前登录账号，已拒绝启动修复（请重新登录后再试）' };
    }

    const task = createRepairTask({
      taskId: request.taskId,
      requestId: request.requestId,
      source: request.source,
      shopId: identity.shopId,
      ownerUserId: currentAuthUserId,
      spcCds: credential.spcCds,
      products: request.products,
      initialItems: buildInitialItems(request.products),
      now: Date.now(),
    });
    // 先持久确认"已接受"，再开始任何写请求
    await saveRepairTask(task);

    runRepairInBackground(task, request.products);
    return { success: true, taskId: task.taskId };
}

/**
 * 修复是否正在执行（含「启动请求已到达、异步准备尚未完成」的窗口）。
 *
 * 为什么窗口期也要算：启动 handler 里第一段 await 之前只是取得互斥量并记录了内存锁，
 * 任务记录还没落盘。此时若只看 storage 会认为"没有修复任务"，另一条写流程就会挤进来。
 */
function isRepairInFlight(): boolean {
  return _repairStarting || _repairRunningTaskId !== null;
}

/**
 * 供开卖/定时等既有写入口调用：修复进行中时返回拒绝原因，否则返回 null。
 *
 * 只是拒绝**新**的冲突动作，不去停已经在跑的任务，也不加队列。
 */
async function findActiveRepairConflict(): Promise<string | null> {
  if (isRepairInFlight()) {
    return '一键修复正在执行商品写操作，请等它结束后再开启限时特卖';
  }
  try {
    const stored = await browser.storage.local.get(ONE_DAY_REPAIR_TASK_KEY);
    const task = stored[ONE_DAY_REPAIR_TASK_KEY] as OneDayRepairTask | undefined;
    if (task && isRepairTaskActive(task)) {
      return '一键修复正在执行商品写操作，请等它结束后再开启限时特卖';
    }
  } catch {
    // 读不到时按"没有修复"处理：这是开卖入口的额外保护，不是它的主校验
  }
  return null;
}

/**
 * 同店铺已有写任务时拒绝启动修复。
 * 只做必要的入口 guard，不搭建队列、不取消既有任务。
 */
async function findSameShopWriteConflict(): Promise<string | null> {
  try {
    const keys = await browser.storage.local.get(['_autoModeStatus', '_scheduledEnable', '_wizardFlowParams', '_enableProgress', '_copyTaskStatus']);
    const auto = keys._autoModeStatus as AutoModeStatus | undefined;
    if (auto?.isRunning) return '自动模式正在执行写操作，请等它结束或先停止自动模式';
    const progress = keys._enableProgress as { running?: boolean } | undefined;
    if (progress?.running) return '正在开启限时特卖，请等待完成后再启动修复';
    if (_enableRunning) return '正在开启限时特卖，请等待完成后再启动修复';
    // 复制正在实际执行（关闭进行中活动／创建新活动／提交商品）时也不能挤进来
    if (_copyExecuting) return '正在复制限时特卖活动，请等它结束后再启动修复';
    if (keys._scheduledEnable || keys._wizardFlowParams) {
      // 定时任务的执行由 alarm 触发；只提示存在冲突写任务，不代替用户取消
      const scheduled = keys._scheduledEnable as { fireTime?: number } | undefined;
      const wizard = keys._wizardFlowParams as { createTime?: number } | undefined;
      void scheduled;
      void wizard;
    }
    return null;
  } catch {
    return null;
  }
}

/** 异步跑修复；不 await，避免与 popup 关闭耦合 */
function runRepairInBackground(task: OneDayRepairTask, products: ShopeeProduct[]) {
  if (_repairRunningTaskId) {
    console.log('[bg:repair] 已有修复在运行，忽略重复启动');
    return;
  }
  _repairRunningTaskId = task.taskId;
  let staleWrite = false;

  runOneDaySkuRepairTask(task, products, {
    // 与已有写路径一致：日志里把 SPC_CDS 打码，凭据不进日志
    injectedFetch: (url, method, body) => {
      if (import.meta.env.VITE_DEBUG_LOGS === 'true') console.log('[bg:repair] fetch', method || 'GET', redactSpcCds(url));
      return injectedFetch(url, method, body);
    },
    getCredential: getSpcCdsFromCookies,
    getShopIdentity: (async () => {
      const cred = await getSpcCdsFromCookies();
      return getRepairShopIdentity(cred.spcCds, cred.spcCdsVer);
    }),
    getAuthUserId: getRepairAuthUserId,
    fetchProductsByIds: fetchRepairResultProducts,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
    saveTask: saveRepairTask,
    loadTask: readRepairTask,
    startKeepalive: () => startRepairKeepalive(task.taskId),
    stopKeepalive: stopRepairKeepalive,
    onItemFailed: info => {
      void recordRepairDiagnostic({
        kind: 'item-failed',
        taskId: task.taskId,
        requestId: task.requestId,
        phase: task.phase,
        taskShopId: task.shopId,
        taskOwnerUserId: task.ownerUserId,
        actualShopId: null,
        actualUserId: null,
        reason: `商品 ${info.itemId} 处理失败：${info.reason}`,
        confirmedActions: info.confirmedActions,
        unknownActions: [],
      });
    },
  }).then(final => {
    console.log('[bg:repair] 任务结束:', final.taskId, final.status);
  }).catch(async (e: any) => {
    console.error('[bg:repair] 任务异常:', e?.message || e);
    // 诊断必须描述**当前持久状态**，而不是启动时的快照：
    // 快照里没有已经发生的副作用，会导致"已经移除了折扣却记成没有动作"（规划方复验指出）。
    const persisted = await readRepairTask().catch(() => null);
    const diagTask = persisted && persisted.taskId === task.taskId ? persisted : task;
    // 权威记录已被标记终态/中断：本实例只是迟到的写入者，什么都不该改（BR5）
    if (e instanceof RepairStaleWriteError) {
      staleWrite = true;
      console.warn('[bg:repair] 记录已被标记终态，放弃本实例的后续写入');
      return;
    }
    // 保存进度失败（含浏览器正在关闭）时不能改写状态：此时写不进去，而且"失败"也不属实 ——
    // 我们并不知道商品是否已被改动。保留最后落盘的真实状态，让下次启动按"无执行者"标记为中断。
    if (e instanceof RepairCheckpointSaveError || /shutting down|Extension context invalidated|message port closed/i.test(e?.message || '')) {
      console.warn('[bg:repair] 进度未能落盘（可能是浏览器关闭），保留最后状态交由启动协调标记中断');
      void recordRepairDiagnostic({
        kind: 'checkpoint-failed',
        taskId: diagTask.taskId,
        requestId: diagTask.requestId,
        phase: diagTask.phase,
        taskShopId: diagTask.shopId,
        taskOwnerUserId: diagTask.ownerUserId,
        actualShopId: null,
        actualUserId: null,
        reason: `进度保存失败：${e?.message || '未知'}`,
        confirmedActions: describeConfirmedActionsForTask(diagTask),
        unknownActions: [],
      });
      return;
    }
    // 归属变化（切店/换号/登出）：如实记录任务锚与实际锚，便于定位是哪一侧变了
    if (e instanceof RepairOwnershipError) {
      void recordRepairDiagnostic({
        kind: 'ownership-stopped',
        taskId: diagTask.taskId,
        requestId: diagTask.requestId,
        phase: diagTask.phase,
        taskShopId: diagTask.shopId,
        taskOwnerUserId: diagTask.ownerUserId,
        actualShopId: e.actualShopId,
        actualUserId: e.actualUserId,
        reason: e.message,
        confirmedActions: describeConfirmedActionsForTask(diagTask),
        unknownActions: describeUnknownActionsForTask(diagTask),
      });
    } else {
      void recordRepairDiagnostic({
        kind: 'task-failed',
        taskId: diagTask.taskId,
        requestId: diagTask.requestId,
        phase: diagTask.phase,
        taskShopId: diagTask.shopId,
        taskOwnerUserId: diagTask.ownerUserId,
        actualShopId: null,
        actualUserId: null,
        reason: e?.message || '修复任务异常终止',
        confirmedActions: describeConfirmedActionsForTask(diagTask),
        unknownActions: [],
      });
    }
    try {
      const cur = await readRepairTask();
      if (cur && cur.taskId === task.taskId && !isTerminalRepairStatus(cur.status)) {
        await saveRepairTask({
          ...cur,
          status: 'failed',
          phase: 'failed',
          error: e?.message || '修复任务异常终止',
          message: e?.message || '修复任务异常终止',
          updatedAt: Date.now(),
          revision: cur.revision + 1,
        });
      }
    } catch { /* ignore */ }
  }).finally(() => {
    if (_repairRunningTaskId === task.taskId) _repairRunningTaskId = null;
    stopRepairKeepalive();
    // 终态后不再需要心跳与中断复检；但"迟到写入被拒"时本实例并非记录的主人，
    // 不能顺手把别人留下的中断证据（心跳）清掉。
    if (!staleWrite) {
      browser.storage.local.remove(ONE_DAY_REPAIR_HEARTBEAT_KEY).catch(() => {});
      clearOrphanAlarm();
    }
  });
}


// ===== Enable Loop =====
async function runEnableLoop(params: EnableParams) {
  if (_enableRunning) {
    console.log('[bg:enable] 已有循环在运行，忽略重复启动');
    return;
  }
  _enableRunning = true;
  try {
    const { products, flashSaleId, spcCds: initialSpcCds, spcCdsVer: initialSpcCdsVer, maxRetries, infiniteRetry, discountRate, flashSaleStock, purchaseLimit, skuOverrides, skipSkuKeys } = params;
    let currentSpcCds = initialSpcCds;
    let currentSpcCdsVer = initialSpcCdsVer;

  // 构建所有 SKU 的提交数据
  const skipSet = new Set(skipSkuKeys || []);
  console.log('[bg:enable] skuOverrides 总数:', Object.keys(skuOverrides).length);
  const withPromoPrice = Object.values(skuOverrides).filter(o => o?.promoPrice !== undefined).length;
  console.log('[bg:enable] 其中 promoPrice 覆盖:', withPromoPrice, '/', Object.keys(skuOverrides).length);
  const allItems: EnableItem[] = products.flatMap(p =>
    (p.modelList || [])
      .filter(sku => (sku.normalStock || 0) > 0)
      .filter(sku => !skipSet.has(`${p.itemid}-${sku.modelid}`))
      .map(sku => {
        const key = `${p.itemid}-${sku.modelid}`;
        const override = skuOverrides[key];
        const usedDiscount = override?.discountRate ?? discountRate;
        const usedStock = Math.min(override?.stock ?? flashSaleStock, sku.normalStock || flashSaleStock);
        const usedPurchaseLimit = override?.purchaseLimit ?? purchaseLimit;
        const promoPrice = override?.promoPrice ?? Math.floor(Number(sku.originPrice || p.originPrice || 0) * usedDiscount / 100);
        if (override) {
          console.log(`[bg:enable] SKU ${key}: override=${JSON.stringify(override)}, usedDiscount=${usedDiscount}, usedStock=${usedStock}, usedPurchaseLimit=${usedPurchaseLimit}, promoPrice=${promoPrice}`);
        }
        return {
          item_id: Number(p.itemid),
          status: 1,
          model_id: Number(sku.modelid),
          item_display_image: p.images?.[0] || '',
          input_promo_price: promoPrice,
          stock: usedStock,
          purchase_limit: usedPurchaseLimit,
        };
      })
  );
  const skippedCount = products.reduce((sum, p) =>
    sum + (p.modelList || []).filter(sku => !sku.normalStock || sku.normalStock <= 0).length, 0
  );

  if (allItems.length === 0) {
    const errMsg = `没有找到可提交的 SKU${skippedCount > 0 ? `（${skippedCount} 个 SKU 因库存为 0 已跳过）` : ''}`;
    const emptyProgress: EnableProgress = {
      totalSkus: 0, successSkus: 0, failedSkus: 0,
      currentRound: 0, maxRetries, nextRetryItems: [], isComplete: true,
    };
    await saveProgress(emptyProgress, false, errMsg);
    await sendComplete(emptyProgress, errMsg);
    return;
  }

  console.log(`[bg:enable] 开始提交 ${allItems.length} 个 SKU${skippedCount > 0 ? `（${skippedCount} 跳过）` : ''}, 最多重试 ${maxRetries} 次`);

  // 构建商品名称/图片查找表（用于失败详情展示）
  const productDetailLookup: Record<string, { name: string; modelName: string; image: string }> = {};
  for (const p of products) {
    for (const m of p.modelList || []) {
      const key = `${p.itemid}-${m.modelid}`;
      productDetailLookup[key] = { name: p.name, modelName: m.name, image: p.images?.[0] || '' };
    }
  }

  function buildFailedItemDetails(failedItems: EnableResult[], submittedItems: EnableItem[]): FailedItemDetail[] {
    const submittedMap = new Map(submittedItems.map(i => [`${i.item_id}-${i.model_id}`, i]));
    return failedItems.map(r => {
      const key = `${r.item_id}-${r.model_id}`;
      const submitted = submittedMap.get(key);
      const info = productDetailLookup[key];
      return {
        itemId: r.item_id,
        modelId: r.model_id,
        image: info?.image || '',
        itemName: info?.name || `商品 #${r.item_id}`,
        modelName: info?.modelName || '',
        promoPrice: submitted?.input_promo_price || 0,
        stock: submitted?.stock || 0,
        purchaseLimit: submitted?.purchase_limit || 0,
        errMsg: r.err_msg || '',
      };
    });
  }

  // 立即保存运行状态，确保弹窗关闭后重新打开能看到循环在运行
  const initialProgress: EnableProgress = {
    totalSkus: allItems.length, successSkus: 0, failedSkus: 0,
    currentRound: 0, maxRetries, nextRetryItems: [], isComplete: false,
  };
  await saveProgress(initialProgress, true);
  // 立即发送初始进度到内容脚本，悬浮 UI 立刻出现
  await sendProgress(initialProgress);

  _enableStopRequested = false;
  let currentItems = [...allItems];
  let successCount = 0;
  let failedResults: EnableResult[] = [];
  const hardFailedAccum: EnableResult[] = []; // 价格超限等不可重试的硬错误
  let lastRawResponse = '';
  let round = 0;
  let lowFailureStallCount = 0;
  let previousFailedCount = 0;
  let zeroProgressCount = 0; // 连续零进展轮数（所有 SKU 全部失败）

  for (round = 1; ; round++) {
    if (round === 1) {
      logAutoMode('info', `runEnableLoop 开始提交商品`, {
        totalSkus: allItems.length,
        maxRetries,
        infiniteRetry,
      });
    }
    if (!infiniteRetry && round > maxRetries) break;
    if (_enableStopRequested) {
      console.log('[bg:enable] ⏹ 用户取消');
      logAutoMode('info', 'runEnableLoop 用户手动取消');
      break;
    }

    try {
      console.log(`[bg:enable] === 第 ${round} 轮提交开始 ===`);

      // 写请求前的互斥复核（双向）：修复可能在开卖等待期间启动。
      // 只停止本流程的后续写请求并如实报错，不去动修复任务。
      const repairConflict = await findActiveRepairConflict();
      if (repairConflict) {
        const msg = `${repairConflict}（已停止后续提交，剩余 SKU 未提交）`;
        console.log('[bg:enable] ⛔', msg);
        logAutoMode('error', msg);
        await saveProgress(initialProgress, false, msg);
        await sendProgress(initialProgress, msg);
        break;
      }

      // 每 3 轮刷新一次 SPC_CDS，防止 token 过期导致 spex common error
      if (round % 3 === 1 && round > 1) {
        const fresh = await getSpcCdsFromCookies();
        if (fresh.spcCds) {
          currentSpcCds = fresh.spcCds;
          currentSpcCdsVer = fresh.spcCdsVer;
          console.log('[bg:enable] 🔄 SPC_CDS 已刷新');
        }
      }
      const response = await injectedFetch<any>(
        `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${currentSpcCds}&SPC_CDS_VER=${currentSpcCdsVer}`,
        'POST',
        { flash_sale_id: flashSaleId, items: currentItems, use_global_category: true },
      );

      lastRawResponse = JSON.stringify(response).slice(0, 2000);
      console.log('[bg:enable] 原始响应:', JSON.stringify(response, null, 2).slice(0, 3000));

      // 解析失败项
      let failedItemsFromResponse: EnableResult[];

      // 顶层 API 错误（如 code 1001）— 偶发性错误，标记所有项失败继续重试
      if (response?.code !== undefined && response.code !== 0) {
        const errMsg = response.message || `API error (code=${response.code})`;
        console.log(`[bg:enable] ❌ API 顶层错误: ${errMsg}，继续重试`);
        failedItemsFromResponse = currentItems.map(item => ({
          item_id: item.item_id,
          model_id: item.model_id,
          err_msg: errMsg,
        }));
      } else {
        failedItemsFromResponse = Array.isArray(response?.data?.failed_items)
          ? response.data.failed_items
          : Array.isArray(response?.data) ? response.data : [];
      }

      failedResults = failedItemsFromResponse;
      const failKeys = new Set(failedItemsFromResponse.map(r => `${r.item_id}-${r.model_id}`));
      const successInThisRound = currentItems.filter(i => !failKeys.has(`${i.item_id}-${i.model_id}`));
      successCount += successInThisRound.length;

      // 零进展僵局检测：连续 10 轮没有任何新增成功则停止
      if (successInThisRound.length === 0) {
        zeroProgressCount++;
        console.log(`[bg:enable] ⏳ 零进展检测 (${zeroProgressCount}/10): 本轮全部失败`);
        if (zeroProgressCount >= 10) {
          const stallMsg = `连续 ${zeroProgressCount} 轮无进展，疑似持久性 API 错误`;
          console.log(`[bg:enable] ⏹ ${stallMsg}`);
          logAutoMode('warning', `runEnableLoop: ${stallMsg}`, { zeroProgressCount });
          lastRawResponse = stallMsg;
          break;
        }
      } else {
        zeroProgressCount = 0;
      }

      console.log(`[bg:enable] 本轮成功: ${successInThisRound.length}, 失败: ${failedItemsFromResponse.length}`);

      const failedDetails = buildFailedItemDetails(failedItemsFromResponse, currentItems);
      const progress: EnableProgress = {
        totalSkus: allItems.length, successSkus: successCount,
        failedSkus: failedItemsFromResponse.length, currentRound: round, maxRetries,
        nextRetryItems: failedItemsFromResponse,
        hardFailedSkus: hardFailedAccum.length > 0 ? [...hardFailedAccum] : undefined,
        isComplete: failedItemsFromResponse.length === 0,
        lastResponsePreview: lastRawResponse.slice(0, 500),
      };

      await saveProgress(progress, failedItemsFromResponse.length > 0);
      await sendProgress(progress, undefined, failedDetails);

      if (failedItemsFromResponse.length === 0) {
        console.log('[bg:enable] ✅ 全部成功！');
        await saveProgress(progress, false);
        await sendComplete(progress, undefined, []);
        return;
      }

      // 只重试失败的
      currentItems = currentItems.filter(i => failKeys.has(`${i.item_id}-${i.model_id}`));

      // 分离不可重试的硬错误（价格超限 code=10010），从重试列表中移除
      const PRICE_ERROR_CODE = 10010;
      const hardFailedThisRound = failedItemsFromResponse.filter(r =>
        r.unqualified_conditions?.some(c => c.unqualified_code === PRICE_ERROR_CODE)
      );
      if (hardFailedThisRound.length > 0) {
        const hardFailedKeys = new Set(hardFailedThisRound.map(r => `${r.item_id}-${r.model_id}`));
        currentItems = currentItems.filter(i => !hardFailedKeys.has(`${i.item_id}-${i.model_id}`));
        hardFailedAccum.push(...hardFailedThisRound);
        console.log(`[bg:enable] ⛔ 价格超限 ${hardFailedThisRound.length} 个 SKU，已排除出重试`);
      }

      console.log(`[bg:enable] 剩余 ${currentItems.length} 个需要重试`);

      // 低失败数僵局检测：失败 SKU ≤ 5 且连续 10 轮数量不变则停止
      if (currentItems.length > 0 && currentItems.length <= 5) {
        if (currentItems.length < previousFailedCount) {
          lowFailureStallCount = 1;
        } else {
          lowFailureStallCount++;
        }
        previousFailedCount = currentItems.length;
        console.log(`[bg:enable] ⏳ 僵局检测 (${lowFailureStallCount}/10): 剩余 ${currentItems.length} 个`);
        if (lowFailureStallCount >= 10) {
          const stallMsg = `僵局检测：${currentItems.length} 个 SKU 连续 10 轮无法开启`;
          console.log(`[bg:enable] ⏹ ${stallMsg}`);
          logAutoMode('warning', `runEnableLoop: ${stallMsg}`, { remainingItemCount: currentItems.length });
          lastRawResponse = stallMsg;
          break;
        }
      } else {
        lowFailureStallCount = 0;
        previousFailedCount = 0;
      }

      // 小批量诊断
      if (currentItems.length > 0 && currentItems.length <= 10) {
        try {
          const diagItemIds = [...new Set(currentItems.map(i => String(i.item_id)))];
          const diagData = await injectedFetch<any>(
            `${GRAPHQL_URL}?SPC_CDS=${currentSpcCds}&SPC_CDS_VER=${currentSpcCdsVer}`,
            'POST',
            { query: PRODUCTS_QUERY, variables: { productIds: diagItemIds, statusType: 0 } },
          );
          const liveItems = diagData?.data?.products?.items || [];
          for (const item of liveItems) {
            const orig = products.find(p => p.itemid === item.itemid);
            for (const sku of item.modelList || []) {
              const key = `${item.itemid}-${sku.modelid}`;
              if (failKeys.has(key)) {
                const req = currentItems.find(i => `${i.item_id}-${i.model_id}` === key);
                console.log(`[bg:enable] 🔍 失败 SKU ${sku.modelid}: 当前库存=${sku.normalStock}, 请求活动库存=${req?.stock}, 原价=${sku.originPrice}`);
              }
              const origSku = orig?.modelList?.find(m => m.modelid === sku.modelid);
              if (origSku && (Number(sku.originPrice) !== Number(origSku.originPrice) || sku.normalStock !== origSku.normalStock)) {
                console.log(`[bg:enable] ⚠ SKU ${sku.modelid} 数据变化: 价格 ${origSku.originPrice}→${sku.originPrice}, 库存 ${origSku.normalStock}→${sku.normalStock}`);
              }
            }
          }
        } catch (diagErr: any) {
          console.log('[bg:enable] 诊断查询失败:', diagErr.message);
        }
      }

      // 自适应库存
      if (failedItemsFromResponse.some(r => r.err_msg?.includes('NOT_ENOUGH_STOCK'))) {
        const stockErrorKeys = new Set(
          failedItemsFromResponse.filter(r => r.err_msg?.includes('NOT_ENOUGH_STOCK')).map(r => `${r.item_id}-${r.model_id}`)
        );
        currentItems = currentItems.map(item => {
          const key = `${item.item_id}-${item.model_id}`;
          if (stockErrorKeys.has(key)) {
            const newStock = Math.max(1, Math.floor(item.stock / 2));
            console.log(`[bg:enable] 📉 降低 SKU ${item.model_id} 库存: ${item.stock}→${newStock}`);
            return { ...item, stock: newStock };
          }
          return item;
        });
      }
    } catch (e: any) {
      console.log(`[bg:enable] 第 ${round} 轮异常:`, e.message);
      logAutoMode('warning', `runEnableLoop 第 ${round} 轮异常: ${e.message}`);
      const progress: EnableProgress = {
        totalSkus: allItems.length, successSkus: successCount,
        failedSkus: currentItems.length, currentRound: round, maxRetries,
        nextRetryItems: [], isComplete: false,
        hardFailedSkus: hardFailedAccum.length > 0 ? [...hardFailedAccum] : undefined,
        lastResponsePreview: `异常: ${e.message}`,
      };

      // 致命错误（找不到 seller 标签页）— 停止循环
      if (e.message?.includes('seller.shopee.tw 标签页')) {
        logAutoMode('error', `runEnableLoop 致命错误: ${e.message}`, { round });
        progress.isComplete = true;
        const errDetails = buildFailedItemDetails(currentItems.map(i => ({ item_id: i.item_id, model_id: i.model_id, err_msg: e.message } as EnableResult)), currentItems);
        await saveProgress(progress, false, e.message);
        await sendComplete(progress, e.message, errDetails);
        return;
      }

      const catchDetails = buildFailedItemDetails(currentItems.map(i => ({ item_id: i.item_id, model_id: i.model_id, err_msg: e.message } as EnableResult)), currentItems);
      await saveProgress(progress, true, e.message);
      await sendProgress(progress, e.message, catchDetails);
    }
  }

  // 循环正常结束（重试用完或被取消）
  const finalProgress: EnableProgress = {
    totalSkus: allItems.length, successSkus: successCount,
    failedSkus: failedResults.length, currentRound: round, maxRetries,
    nextRetryItems: failedResults,
    hardFailedSkus: hardFailedAccum.length > 0 ? [...hardFailedAccum] : undefined,
    isComplete: true,
    lastResponsePreview: lastRawResponse.slice(0, 500),
  };
  const finalDetails = buildFailedItemDetails(failedResults, allItems);
  await saveProgress(finalProgress, false);
  await sendComplete(finalProgress, undefined, finalDetails);
  reportAnalyticsEvent('enable_loop', {
    totalSkus: allItems.length,
    successSkus: successCount,
    failedSkus: failedResults.length,
    rounds: round,
  });
  consumeTrial();
  console.log(`[bg:enable] 完成: ${round} 轮, 成功 ${successCount}, 失败 ${failedResults.length}${skippedCount > 0 ? `, 跳过 ${skippedCount}` : ''}`);
  } finally {
    _enableRunning = false;
  }
}



// ===== 定时复制流程（创建活动 + 保存数据，返回 enableParams 供调用方启动 runEnableLoop）=====
async function executeScheduledCopyFlow(
  params: ScheduledCopyParams,
  cds: string,
  cdsVer: string,
): Promise<{ newFlashSaleId: number; enableParams: EnableParams }> {
  // 校验店铺访问权限
  const validation = await validateShopAccess(cds, 'scheduled_copy');
  if (!validation.allowed) {
    throw new Error(`店铺验证失败: ${validation.error}`);
  }

  // 与一键修复互斥：复制会关闭进行中的活动并新建活动，与修复同时跑会把店铺改乱。
  // 放在**首个副作用之前**（关闭活动之前），拒绝时不发出任何关闭/创建/提交请求。
  const repairConflict = await findActiveRepairConflict();
  if (repairConflict) {
    throw new Error(`${repairConflict}（复制已取消，未关闭或创建任何活动）`);
  }

  // Step 1: 关闭进行中的活动
  sendCopyMessage('COPY_PROGRESS', { currentStep: 1, totalSteps: 4, description: '关闭进行中的活动...' });
  const listData = await injectedFetch<any>(
    `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}&offset=0&limit=50&type=0`
  );
  const activeSales = (listData?.data?.flash_sale_list || []).filter((s: any) => s.status === 1);
  for (const sale of activeSales) {
    await injectedFetch(
      `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}`,
      'POST',
      { flash_sale_id: sale.flash_sale_id, time_slot_id: sale.timeslot_id, status: 2 }
    );
  }

  // Step 2: 获取时间段
  sendCopyMessage('COPY_PROGRESS', { currentStep: 2, totalSteps: 4, description: '获取时间段...' });
  const startTime = params.targetStartTime - 1800;
  const endTime = getMonthEnd();
  const tsData = await injectedFetch<any>(
    `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}&start_time=${startTime}&end_time=${endTime}`
  );
  const timeSlots = Array.isArray(tsData?.data) ? tsData.data : [];
  let bestSlot = timeSlots[0];
  for (const slot of timeSlots) {
    if (!bestSlot || Math.abs(slot.start_time - params.targetStartTime) < Math.abs(bestSlot.start_time - params.targetStartTime)) {
      bestSlot = slot;
    }
  }
  if (!bestSlot) throw new Error('没有可用的时间段');

  // Step 3: 创建新活动
  sendCopyMessage('COPY_PROGRESS', { currentStep: 3, totalSteps: 4, description: '创建新活动...' });
  const createData = await injectedFetch<any>(
    `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}`,
    'POST',
    { time_slot_id: bestSlot.timeslot_id }
  );
  const newId = createData?.data?.flash_sale_id;
  if (!newId) throw new Error('创建活动失败');

  // Step 4: 保存源活动商品数据
  sendCopyMessage('COPY_PROGRESS', { currentStep: 4, totalSteps: 4, description: '保存商品数据...' });

  // 过滤已下架/删除的商品，避免后续开售时反复请求无效商品
  let activeProducts = params.products || [];
  let activeSkuOverrides = params.skuOverrides || {};
  if (activeProducts.length > 0) {
    const { activeProducts: filtered, activeIds } = await filterActiveProducts(activeProducts, cds, cdsVer);
    if (filtered.length < activeProducts.length) {
      const filteredOverrides: Record<string, SkuOverride> = {};
      for (const [key, override] of Object.entries(activeSkuOverrides)) {
        const itemId = key.split('-')[0];
        if (activeIds.has(itemId)) {
          filteredOverrides[key] = override;
        }
      }
      activeSkuOverrides = filteredOverrides;
    }
    activeProducts = filtered;
  }

  if (activeProducts.length) {
    try {
      await saveCopiedSaleData({
        sourceFlashSaleId: params.sourceFlashSaleId,
        sourceFlashSaleName: params.sourceFlashSaleName || '',
        newFlashSaleId: newId,
        copiedAt: Date.now(),
        products: activeProducts,
        skuOverrides: activeSkuOverrides,
        discountRate: params.discountRate ?? 60,
        flashSaleStock: params.flashSaleStock ?? 200,
        purchaseLimit: params.purchaseLimit ?? 5,
      });
    } catch (saveErr: any) {
      throw new Error(`活动已创建 (ID: ${newId})，但商品数据保存失败: ${saveErr.message}`, { cause: saveErr });
    }
  }

  // 返回 enableParams，由调用方通过 runEnableLoop 异步提交商品（复用正常的开启限时特卖逻辑）
  const enableParams: EnableParams = {
    products: activeProducts,
    flashSaleId: newId,
    spcCds: cds,
    spcCdsVer: cdsVer,
    maxRetries: COPY_MAX_RETRIES,
    infiniteRetry: true,
    discountRate: params.discountRate ?? 60,
    flashSaleStock: params.flashSaleStock ?? 200,
    purchaseLimit: params.purchaseLimit ?? 5,
    skuOverrides: activeSkuOverrides,
  };

  return { newFlashSaleId: newId, enableParams };
}

// ===== 自动模式 =====
async function saveAutoModeStatus(status: AutoModeStatus) {
  await browser.storage.local.set({ _autoModeStatus: status });
}

async function sendAutoModeUpdate(status: AutoModeStatus) {
  try {
    await browser.runtime.sendMessage({ type: 'AUTO_MODE_UPDATE', status });
  } catch {}
  try {
    const tabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
    for (const tab of tabs) {
      if (tab.id) {
        browser.tabs.sendMessage(tab.id, { type: 'AUTO_MODE_UPDATE', status }).catch(() => {});
      }
    }
  } catch {}
}

async function sendAutoModeLog(log: AutoModeLog) {
  try {
    await browser.runtime.sendMessage({ type: 'AUTO_MODE_LOG', log });
  } catch {}
  try {
    const tabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
    for (const tab of tabs) {
      if (tab.id) {
        browser.tabs.sendMessage(tab.id, { type: 'AUTO_MODE_LOG', log }).catch(() => {});
      }
    }
  } catch {}
}

function generateLogId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

const LOG_RETENTION = 500;

function fmtAutoLogTime(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}:${ss}`;
}

// 串行化 _autoModeLogs 的读写操作，避免并发写入导致的乱序和重复
let _logLock: Promise<void> = Promise.resolve();

async function logAutoMode(type: AutoModeLog['type'], message: string, data?: Record<string, unknown>) {
  const ts = Math.floor(Date.now() / 1000);
  const log: AutoModeLog = {
    id: generateLogId(),
    timestamp: ts,
    iso: fmtAutoLogTime(ts),
    type,
    message,
    ...(data ? { data } : {}),
  };
  console.log(`[bg:auto] [${type}] ${message}`, data || '');
  await sendAutoModeLog(log);

  // 串行化：等上一个写入完成再执行自己的读-改-写，消除竞态
  const prev = _logLock;
  let release: () => void;
  _logLock = new Promise<void>(r => { release = r; });
  await prev;
  try {
    const result = await browser.storage.local.get('_autoModeLogs').catch(() => ({ _autoModeLogs: [] }));
    const logs = (result._autoModeLogs as AutoModeLog[]) || [];
    const updated = [log, ...logs].slice(0, LOG_RETENTION);
    await browser.storage.local.set({ _autoModeLogs: updated }).catch(() => {});
  } finally {
    release();
  }
}

function countSlotsInDays(slots: TimeSlot[], days: number): number {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now + days * 86400;
  const futureSlots = slots.filter(s => s.start_time > now && s.start_time < cutoff);
  const daySet = new Set<string>();
  for (const slot of futureSlots) {
    const d = new Date(slot.start_time * 1000);
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    daySet.add(key);
  }
  return futureSlots.length;
}

async function pickNextTargetTime(cds: string, cdsVer: string): Promise<{ targetTime: number; slotId: number } | null> {
  const now = Math.floor(Date.now() / 1000);
  const endTime = (() => {
    const d = new Date();
    const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0);
    return Math.floor(endOfMonth.getTime() / 1000) - 1;
  })();

  const data = await injectedFetch<any>(
    `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}&start_time=${now - 1800}&end_time=${endTime}`
  );
  const slots: TimeSlot[] = Array.isArray(data?.data) ? data.data : [];
  const futureSlots = slots.filter(s => s.start_time > now).sort((a, b) => a.start_time - b.start_time);

  if (futureSlots.length === 0) return null;
  return { targetTime: futureSlots[0].start_time, slotId: futureSlots[0].timeslot_id };
}

async function scheduleNextRound() {
  const result = await browser.storage.local.get('_autoModeStatus');
  const status = result._autoModeStatus as AutoModeStatus | undefined;
  if (!status?.isRunning) {
    await logAutoMode('warning', 'scheduleNextRound: 状态非运行中，跳过');
    return;
  }

  await logAutoMode('info', '开始调度下一轮', {
    round: status.currentRound,
    totalRounds: status.totalRounds,
    phase: status.phase,
    nextTargetTime: status.nextTargetTime,
  });

  if (_autoModeStopRequested) {
    await logAutoMode('info', '收到停止请求，不再调度下一场');
    status.isRunning = false;
    status.phase = 'stopped';
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);
    await clearAutoModeAlarms();
    return;
  }

  if (status.currentRound > status.totalRounds) {
    await logAutoMode('success', `自动模式完成：共完成 ${status.totalRounds} 场`);
    status.isRunning = false;
    status.phase = 'completed';
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);
    await clearAutoModeAlarms();
    return;
  }

  const { spcCds, spcCdsVer } = await getSpcCdsFromCookies();
  if (!spcCds) {
    await logAutoMode('error', 'SPC_CDS 不存在，无法调度下一场');
    status.lastError = 'SPC_CDS 不存在，请确认已登录 seller.shopee.tw';
    status.phase = 'stopped';
    status.isRunning = false;
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);
    await clearAutoModeAlarms();
    return;
  }

  // SW 在 waiting_enable 阶段终止后恢复：活动已创建，只需重建 auto_mode_enable alarm
  if (status.phase === 'waiting_enable' && status.currentFlashSaleId) {
    await logAutoMode('info', '恢复 waiting_enable 阶段: 活动已创建，重建传递 alarm', {
      flashSaleId: status.currentFlashSaleId,
      nextTargetTime: status.nextTargetTime,
    });
    const targetTime = status.nextTargetTime || Math.floor(Date.now() / 1000) + 600;
    const isDbg = !!status.debugMode;
    const delaySec = (status.config.delayMinutes || 5) * (isDbg ? 1 : 60);
    const enableTime = targetTime + delaySec;
    const nowSec = Math.floor(Date.now() / 1000);
    if (enableTime <= nowSec) {
      const delayMin = isDbg ? 1 / 60 : 0.5;
      status.nextActionTime = nowSec + (isDbg ? 1 : 30);
      chrome.alarms.create('auto_mode_enable', { delayInMinutes: delayMin });
      chrome.alarms.create('auto_mode_heartbeat', { periodInMinutes: 5 });
      await logAutoMode('info', isDbg ? '传递时间已过，1秒后传递' : `传递时间已过，${delayMin}分钟后传递`);
    } else {
      const remainSec = enableTime - nowSec;
      const delayMin = isDbg ? Math.max(remainSec / 60, 1 / 60) : Math.max(1, Math.ceil(remainSec / 60));
      status.nextActionTime = enableTime;
      chrome.alarms.create('auto_mode_enable', { delayInMinutes: delayMin });
      chrome.alarms.create('auto_mode_heartbeat', { periodInMinutes: 5 });
      await logAutoMode('info', isDbg ? `${remainSec} 秒后传递商品参数` : `${delayMin} 分钟后传递商品参数`);
    }
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);
    return;
  }

  const isDebug = !!status.debugMode;

  if (isDebug) {
    // 伪造目标时间 = 当前时间 + 提前量 + 3 秒缓冲
    const advanceSec = status.config.advanceMinutes || 5;
    const fakeTargetTime = Math.floor(Date.now() / 1000) + advanceSec + 3;

    status.nextTargetTime = fakeTargetTime;
    status.nextActionTime = fakeTargetTime;
    status.phase = 'waiting_create';

    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);
    await logAutoMode('info', `[加速] 伪造目标时间: ${fmtBgTime(fakeTargetTime)}，${advanceSec + 3} 秒后创建活动`);

    chrome.alarms.create('auto_mode_create', { delayInMinutes: (advanceSec + 3) / 60 });
    chrome.alarms.create('auto_mode_heartbeat', { periodInMinutes: 5 });
    // 调试模式也需清除可能的残留 auto_mode_enable
    await chrome.alarms.clear('auto_mode_enable').catch(() => {});
    return;
  }

  // 第一轮优先使用用户选择的场次
  let targetTime: number | undefined;
  if (status.currentRound === 1 && status.selectedSlotId && status.selectedSlotTime) {
    const now = Math.floor(Date.now() / 1000);
    const tsData = await injectedFetch<any>(
      `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&start_time=${now - 1800}&end_time=${getMonthEnd()}`
    );
    const currentSlots = Array.isArray(tsData?.data) ? tsData.data : [];
    const foundSlot = currentSlots.find((s: any) => s.timeslot_id === status.selectedSlotId);
    if (!foundSlot) {
      await logAutoMode('warning', `选择的场次 #${status.selectedSlotId} 已不存在，回退到自动选择`);
    } else if (foundSlot.start_time !== status.selectedSlotTime) {
      await logAutoMode('warning', `场次 #${status.selectedSlotId} 的开始时间已变更，回退到自动选择`);
    } else if (foundSlot.start_time <= now) {
      await logAutoMode('warning', `场次 #${status.selectedSlotId} 已经开始 (${fmtBgTime(foundSlot.start_time)})，回退到自动选择`);
    } else {
      targetTime = foundSlot.start_time;
      await logAutoMode('info', `使用选定场次 #${status.selectedSlotId}: ${fmtBgTime(targetTime)}`);
    }
  }

  // SW 恢复路径: 如果已有有效的 nextTargetTime，直接复用，避免 injectedFetch 在无标签页时失败
  if (!targetTime && status.phase === 'waiting_create' && status.nextTargetTime) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (status.nextTargetTime > nowSec) {
      targetTime = status.nextTargetTime;
      await logAutoMode('info', `复用已有目标时间: ${fmtBgTime(targetTime)}`);
    }
  }

  let next;
  if (targetTime) {
    next = { targetTime };
  } else {
    const result = await pickNextTargetTime(spcCds, spcCdsVer);
    next = result;
  }

  if (!next) {
    await logAutoMode('warning', '未找到可用的时间段，5 分钟后重试');
    chrome.alarms.create('auto_mode_heartbeat', { delayInMinutes: 5 });
    return;
  }

  status.nextTargetTime = next.targetTime;
  status.phase = 'waiting_create';
  await chrome.alarms.clear('auto_mode_enable').catch(() => {});

  const advanceSec = (status.config.advanceMinutes || 5) * 60;
  const creationTime = next.targetTime - advanceSec;
  const now = Math.floor(Date.now() / 1000);

  if (creationTime <= now) {
    status.nextActionTime = now + 30;
    await logAutoMode('info', `申报时间已过(${fmtBgTime(next.targetTime)} -${advanceSec}秒)，30秒后创建`);
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);
    chrome.alarms.create('auto_mode_create', { delayInMinutes: 0.5 });
    chrome.alarms.create('auto_mode_heartbeat', { periodInMinutes: 5 });
  } else {
    const delayMin = Math.ceil((creationTime - now) / 60);
    status.nextActionTime = creationTime;
    await logAutoMode('info', `下一场: ${fmtBgTime(next.targetTime)}，${delayMin} 分钟后创建活动`);
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);
    chrome.alarms.create('auto_mode_create', { delayInMinutes: delayMin });
    chrome.alarms.create('auto_mode_heartbeat', { periodInMinutes: 5 });
  }
}

function fmtBgTime(ts: number): string {
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:${mi}`;
}

async function clearAutoModeAlarms() {
  await logAutoMode('info', '清除所有 auto_mode alarm');
  await chrome.alarms.clear('auto_mode_create').catch(() => {});
  await chrome.alarms.clear('auto_mode_enable').catch(() => {});
  await chrome.alarms.clear('auto_mode_heartbeat').catch(() => {});
}

async function handleAutoModeCreate() {
  const result = await browser.storage.local.get('_autoModeStatus');
  const status = result._autoModeStatus as AutoModeStatus | undefined;
  if (!status?.isRunning || _autoModeStopRequested) {
    await logAutoMode('warning', 'auto_mode_create alarm 触发但状态非运行中', {
      isRunning: !!status?.isRunning,
      stopRequested: _autoModeStopRequested,
    });
    return;
  }

  // 防止重复触发：只有 waiting_create 阶段才能创建活动
  if (status.phase !== 'waiting_create') {
    await logAutoMode('warning', `auto_mode_create alarm 触发但阶段不匹配: ${status.phase}`, {
      phase: status.phase,
    });
    return;
  }

  status.phase = 'creating';
  await saveAutoModeStatus(status);
  await sendAutoModeUpdate(status);

  try {
    const { spcCds, spcCdsVer } = await getSpcCdsFromCookies();
    if (!spcCds) throw new Error('SPC_CDS 不存在，请确认已登录 seller.shopee.tw');

    const autoValidation = await validateShopAccess(spcCds, 'auto_mode_create', status.enableParams?.shopId);
    if (!autoValidation.allowed) {
      status.lastError = `店铺验证失败: ${autoValidation.error}`;
      status.isRunning = false;
      status.phase = 'stopped';
      await saveAutoModeStatus(status);
      await logAutoMode('error', `店铺验证失败，自动模式已停止: ${autoValidation.error}`);
      return;
    }

    // 关闭进行中的活动
    const listData = await injectedFetch<any>(
      `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&offset=0&limit=50&type=0`
    );
    const activeSales = (listData?.data?.flash_sale_list || []).filter((s: any) => s.status === 1);
    if (activeSales.length > 0) {
      await logAutoMode('info', `关闭 ${activeSales.length} 个进行中的活动`);
    }
    for (const sale of activeSales) {
      await injectedFetch(
        `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
        'POST',
        { flash_sale_id: sale.flash_sale_id, time_slot_id: sale.timeslot_id, status: 2 }
      );
    }

    // 获取最佳时间段
    const startTime = (status.nextTargetTime || Math.floor(Date.now() / 1000)) - 1800;
    const endTime = getMonthEnd();
    const tsData = await injectedFetch<any>(
      `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&start_time=${startTime}&end_time=${endTime}`
    );
    const timeSlots = Array.isArray(tsData?.data) ? tsData.data : [];
    let bestSlot = timeSlots[0];
    const target = status.nextTargetTime || Math.floor(Date.now() / 1000);
    for (const slot of timeSlots) {
      if (!bestSlot || Math.abs(slot.start_time - target) < Math.abs(bestSlot.start_time - target)) {
        bestSlot = slot;
      }
    }
    if (!bestSlot) throw new Error('没有可用的时间段');

    // 创建空活动
    const createData = await injectedFetch<any>(
      `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
      'POST',
      { time_slot_id: bestSlot.timeslot_id }
    );
    const newId = createData?.data?.flash_sale_id;
    if (!newId) throw new Error('创建限时特卖活动失败');

    status.currentFlashSaleId = newId;
    await logAutoMode('success', `已创建活动 #${newId}，目标时间: ${fmtBgTime(status.nextTargetTime || 0)}`);

    // 保存源活动商品数据
    if (status.enableParams?.products?.length) {
      await saveCopiedSaleData({
        sourceFlashSaleId: status.sourceFlashSaleId,
        sourceFlashSaleName: status.sourceFlashSaleName,
        newFlashSaleId: newId,
        copiedAt: Date.now(),
        products: status.enableParams.products,
        skuOverrides: status.enableParams.skuOverrides || {},
        discountRate: status.enableParams.discountRate ?? 60,
        flashSaleStock: status.enableParams.flashSaleStock ?? 200,
        purchaseLimit: status.enableParams.purchaseLimit ?? 5,
      });
    }

    // 设置 auto_mode_enable alarm
    const targetTime = status.nextTargetTime || Math.floor(Date.now() / 1000) + 600;
    const isDbg = !!status.debugMode;
    const delaySec = (status.config.delayMinutes || 5) * (isDbg ? 1 : 60);
    const enableTime = targetTime + delaySec;
    const nowSec = Math.floor(Date.now() / 1000);

    status.phase = 'waiting_enable';
    status.currentFlashSaleId = newId;
    if (enableTime <= nowSec) {
      const delayMin = isDbg ? 1/60 : 0.5;
      status.nextActionTime = nowSec + (isDbg ? 1 : 30);
      await saveAutoModeStatus(status);
      await sendAutoModeUpdate(status);
      chrome.alarms.create('auto_mode_enable', { delayInMinutes: delayMin });
      await logAutoMode('info', isDbg ? '传递时间已到，1秒后传递' : `传递时间已到(${delaySec}秒后)，立即传递`);
    } else {
      const remainSec = enableTime - nowSec;
      const delayMin = isDbg ? Math.max(remainSec / 60, 1/60) : Math.max(1, Math.ceil(remainSec / 60));
      status.nextActionTime = enableTime;
      await saveAutoModeStatus(status);
      await sendAutoModeUpdate(status);
      chrome.alarms.create('auto_mode_enable', { delayInMinutes: delayMin });
      await logAutoMode('info', isDbg ? `${remainSec} 秒后传递商品参数` : `${delayMin} 分钟后传递商品参数`);
    }
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    await logAutoMode('error', `创建活动失败: ${errMsg}`);
    status.lastError = `创建活动失败: ${errMsg}`;
    status.phase = 'waiting_create';
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);

    // 致命错误暂停
    if (errMsg.includes('seller.shopee.tw') || errMsg.includes('SPC_CDS')) {
      status.isRunning = false;
      status.phase = 'stopped';
      await saveAutoModeStatus(status);
      await sendAutoModeUpdate(status);
      await clearAutoModeAlarms();
    }
  }
}

async function handleAutoModeEnable() {
  const result = await browser.storage.local.get('_autoModeStatus');
  const status = result._autoModeStatus as AutoModeStatus | undefined;
  if (!status?.isRunning || _autoModeStopRequested) {
    await logAutoMode('warning', 'auto_mode_enable alarm 触发但状态非运行中', {
      isRunning: !!status?.isRunning,
      stopRequested: _autoModeStopRequested,
    });
    return;
  }

  if (status.phase !== 'waiting_enable') {
    await logAutoMode('warning', `auto_mode_enable alarm 触发但阶段不匹配: ${status.phase}`, {
      phase: status.phase,
    });
    return;
  }

  status.phase = 'enabling';
  await saveAutoModeStatus(status);
  await sendAutoModeUpdate(status);

  try {
    const { spcCds, spcCdsVer } = await getSpcCdsFromCookies();
    if (!spcCds) throw new Error('SPC_CDS 不存在');

    const flashSaleId = status.currentFlashSaleId;
    if (!flashSaleId) throw new Error('没有找到当前活动 ID');

    const ep = status.enableParams;
    if (!ep?.products?.length) throw new Error('没有固化商品参数');

    // 每轮开始前重新拉取商品库存数据
    await logAutoMode('info', `开始刷新 ${ep.products.length} 个商品库存数据`);
    const productIds = ep.products.map(p => String(p.itemid));
    const graphqlResp = await injectedFetch<any>(
      `${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
      'POST',
      { query: PRODUCTS_QUERY, variables: { productIds, statusType: 0 } }
    );
    const freshItems: ShopeeProduct[] = graphqlResp?.data?.products?.items || [];
    await logAutoMode('info', `商品库存刷新完成: ${freshItems.length}/${ep.products.length} 个商品有数据`);
    if (freshItems.length > 0) {
      // 用最新库存数据更新 products，保留 skuOverrides 不变
      const freshMap = new Map(freshItems.map(p => [String(p.itemid), p]));
      for (const oldProduct of ep.products) {
        const fresh = freshMap.get(String(oldProduct.itemid));
        if (fresh) {
          oldProduct.normalStock = fresh.normalStock;
          for (const oldSku of (oldProduct.modelList || [])) {
            const freshSku = (fresh.modelList || []).find(m => String(m.modelid) === String(oldSku.modelid));
            if (freshSku) {
              oldSku.normalStock = freshSku.normalStock;
              oldSku.totalNormalStock = freshSku.totalNormalStock;
              oldSku.originPrice = freshSku.originPrice;
            }
          }
        }
      }
      status.enableParams = { ...ep, products: ep.products };
      await saveAutoModeStatus(status);
      await logAutoMode('info', `已刷新 ${freshItems.length} 个商品的最新库存数据`);

      // 同步写回 _copiedSaleData，确保查看商品弹窗也显示最新库存
      try {
        const saleResult = await browser.storage.local.get('_copiedSaleData');
        const allSaleData: Record<string, CopiedSaleData> = saleResult._copiedSaleData || {};
        const currentEntry = allSaleData[String(flashSaleId)];
        if (currentEntry) {
          currentEntry.products = ep.products;
          await browser.storage.local.set({ _copiedSaleData: allSaleData });
        }
      } catch {}
    }

    // 过滤已下架/删除的商品：freshItems 中缺失或 Number(status) !== 0 的商品自动剔除
    // 诊断日志：记录 freshItems 的 status 原始值，便于追踪过滤误判
    if (freshItems.length > 0) {
      const statusSample = freshItems.slice(0, 3).map(p => `${p.itemid}:${p.status}(${typeof p.status})`).join(', ');
      await logAutoMode('info', `商品状态样本 (前3个): ${statusSample}`);
    }
    try {
      if (freshItems.length < ep.products.length || freshItems.some(p => Number(p.status) !== 0)) {
        const activeIds = new Set(
          freshItems.filter(p => Number(p.status) === 0).map(p => String(p.itemid)),
        );
        const filteredProducts = ep.products.filter(p => activeIds.has(String(p.itemid)));
        // 安全底线: 全部被过滤时保留原商品，防止 enableParams 清空
        if (filteredProducts.length === 0) {
          const rawStatuses = freshItems.slice(0, 5).map(p => `${p.itemid}:status=${p.status}(${typeof p.status})`).join(', ');
          await logAutoMode('warning', `商品过滤检测到全部 ${ep.products.length} 个商品 status 异常 (样本: ${rawStatuses})，保留原商品以防误判`);
        } else {
          const filteredOverrides: Record<string, SkuOverride> = {};
          for (const [key, override] of Object.entries(ep.skuOverrides || {})) {
            const itemId = key.split('-')[0];
            if (activeIds.has(itemId)) {
              filteredOverrides[key] = override;
            }
          }
          const removedCount = ep.products.length - filteredProducts.length;
          if (removedCount > 0) {
            await logAutoMode('warning', `已自动过滤 ${removedCount} 个已下架/删除的商品`);
            ep.products = filteredProducts;
            ep.skuOverrides = filteredOverrides;
            status.enableParams = { ...ep, products: filteredProducts, skuOverrides: filteredOverrides };
            await saveAutoModeStatus(status);
          }
        }
      }
    } catch (filterErr: any) {
      await logAutoMode('error', `商品过滤异常，保留原商品继续: ${filterErr?.message || filterErr}`, {
        stack: filterErr?.stack?.slice(0, 300),
      });
    }

    // 最终防线：如果 products 意外为空，记录诊断信息并中止
    if (!ep.products?.length) {
      const diagInfo = {
        freshItemCount: freshItems.length,
        freshStatusSample: freshItems.slice(0, 5).map(p => `${p.itemid}:${p.status}(${typeof p.status})`),
        epProductIds: ep.products?.map(p => p.itemid) || [],
      };
      await logAutoMode('error', `最终防线触发: enableParams.products 为空`, diagInfo);
      throw new Error('商品参数为空，无法继续自动模式');
    }

    const enableParams: EnableParams = {
      products: ep.products,
      flashSaleId,
      spcCds,
      spcCdsVer,
      shopId: ep.shopId,
      maxRetries: COPY_MAX_RETRIES,
      infiniteRetry: true,
      discountRate: ep.discountRate,
      flashSaleStock: ep.flashSaleStock,
      purchaseLimit: ep.purchaseLimit,
      skuOverrides: ep.skuOverrides,
      skipSkuKeys: ep.skipSkuKeys,
    };

    // 校验店铺访问权限
    const validation = await validateShopAccess(spcCds, 'auto_mode_enable', enableParams.shopId);
    if (!validation.allowed) {
      await logAutoMode('error', `店铺验证失败，自动模式已停止: ${validation.error}`);
      status.lastError = `店铺验证失败: ${validation.error}`;
      status.isRunning = false;
      status.phase = 'stopped';
      await saveAutoModeStatus(status);
      await sendAutoModeUpdate(status);
      await clearAutoModeAlarms();
      return;
    }

    await logAutoMode('info', `开始传递商品参数到活动 #${flashSaleId}`, {
      itemCount: enableParams.products?.length ?? 0,
      flashSaleId,
      round: status.currentRound,
    });
    await runEnableLoop(enableParams);

    await logAutoMode('success', `第 ${status.currentRound}/${status.totalRounds} 轮商品参数传递完成`, {
      round: status.currentRound,
      totalRounds: status.totalRounds,
    });
    status.sourceFlashSaleId = flashSaleId;
    status.sourceFlashSaleName = `自动模式 第${status.currentRound}轮`;
    status.currentRound++;
    status.phase = 'idle';
    status.lastError = undefined;
    status.currentFlashSaleId = undefined;
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);

    await scheduleNextRound();
    reportAnalyticsEvent('auto_mode_round', {
      round: status.currentRound - 1,
      totalRounds: status.totalRounds,
      flashSaleId: flashSaleId,
    });
    consumeTrial();
  } catch (e: any) {
    const errMsg = e?.message || String(e);
    await logAutoMode('error', `传递商品参数失败: ${errMsg}`);
    status.lastError = `传递商品参数失败: ${errMsg}`;
    status.phase = 'waiting_enable';
    await saveAutoModeStatus(status);
    await sendAutoModeUpdate(status);

    if (errMsg.includes('seller.shopee.tw') || errMsg.includes('SPC_CDS')) {
      status.isRunning = false;
      status.phase = 'stopped';
      await saveAutoModeStatus(status);
      await sendAutoModeUpdate(status);
      await clearAutoModeAlarms();
    }
  }
}

async function handleAutoModeHeartbeat() {
  const result = await browser.storage.local.get('_autoModeStatus');
  const status = result._autoModeStatus as AutoModeStatus | undefined;
  if (!status?.isRunning || _autoModeStopRequested) {
    await logAutoMode('warning', 'auto_mode_heartbeat 触发但状态非运行中，清除心跳', {
      isRunning: !!status?.isRunning,
      stopRequested: _autoModeStopRequested,
    });
    await chrome.alarms.clear('auto_mode_heartbeat').catch(() => {});
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const nextAction = status.nextActionTime || 0;
  const remainMin = nextAction > now ? Math.ceil((nextAction - now) / 60) : 0;

  // 等待阶段：确认主 alarm 还在，只记日志不重复调度
  if (status.phase === 'waiting_create' || status.phase === 'waiting_enable') {
    const alarmName = status.phase === 'waiting_create' ? 'auto_mode_create' : 'auto_mode_enable';
    const existing = await chrome.alarms.get(alarmName);
    if (existing) {
      await logAutoMode('info', `心跳: ${status.phase === 'waiting_create' ? '等待创建活动' : '等待传递商品'}，约 ${remainMin} 分钟后执行，第 ${status.currentRound}/${status.totalRounds} 轮`, {
        phase: status.phase,
        round: status.currentRound,
        nextActionTime: status.nextActionTime,
        alarmScheduled: existing.scheduledTime,
      });
      return;
    }
    await logAutoMode('warning', `心跳: ${alarmName} alarm 丢失，触发恢复调度`);
  }

  await logAutoMode('info', '心跳检测，重新尝试调度');
  try {
    await scheduleNextRound();
  } catch (e: any) {
    await logAutoMode('error', `心跳调度失败: ${e.message}`, { stack: e.stack });
  }
}

export default defineBackground({
  main() {
    console.log('[限时特卖助手] Background 已启动');

    // 检查自动模式持久状态（SW 重启后恢复 alarm）
    browser.storage.local.get('_autoModeStatus').then(async (result) => {
      const status = result._autoModeStatus as AutoModeStatus | undefined;
      if (status?.isRunning) {
        await logAutoMode('warning', 'SW 启动: 检测到自动模式仍在运行', {
          round: status.currentRound,
          totalRounds: status.totalRounds,
          phase: status.phase,
        });
        // 长时间休眠后 chrome.alarms 可能丢失，重新评估并恢复调度
        try {
          await clearAutoModeAlarms();
          await scheduleNextRound();
        } catch (e: any) {
          await logAutoMode('error', `SW 启动恢复调度失败: ${e.message}`);
        }
      }
    }).catch(() => {});

    browser.runtime.onInstalled.addListener((details) => {
      console.log('[限时特卖助手] 已安装/更新:', details.reason);
    });

    // 创建心跳 alarm 保持 Service Worker 活跃，防止因 SW 终止导致的会话失效
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_INTERVAL_MINUTES });
    console.log(`[bg:heartbeat] 心跳 alarm 已创建 (每${HEARTBEAT_INTERVAL_MINUTES}分钟)`);

    // worker 重启后协调旧的一键修复记录：无执行者则标记真实中断，不自动重放写请求
    reconcileOrphanRepairTask();
    browser.runtime.onMessage.addListener(async (msg: any) => {
      const type = msg?.type;

      // ===== SPC_CDS_REQUEST: Cookie 读取 =====
      if (type === 'SPC_CDS_REQUEST') {
        console.log('[SPC_CDS_REQUEST] 收到请求');
        try {
          const urls = ['https://seller.shopee.tw', 'https://shopee.tw', 'https://www.shopee.tw'];
          for (const url of urls) {
            try {
              const cookie = await browser.cookies.get({ url, name: 'SPC_CDS' });
              if (cookie?.value) {
                const verCookie = await browser.cookies.get({ url, name: 'SPC_CDS_VER' });
                console.log('[SPC_CDS_REQUEST] ✅ 获取成功');
                return { spcCds: cookie.value, spcCdsVer: verCookie?.value || '2' };
              }
            } catch { /* next */ }
          }
          // getAll 回退
          const allCookies = await browser.cookies.getAll({ domain: '.shopee.tw' });
          const spc = allCookies.find(c => c.name === 'SPC_CDS');
          if (spc?.value) {
            const ver = allCookies.find(c => c.name === 'SPC_CDS_VER');
            return { spcCds: spc.value, spcCdsVer: ver?.value || '2' };
          }
          return { spcCds: '', spcCdsVer: '2', error: 'SPC_CDS 不存在，请确认已登录 seller.shopee.tw' };
        } catch (e: any) {
          return { spcCds: '', spcCdsVer: '2', error: `读取 Cookie 失败: ${e?.message || '未知错误'}` };
        }
      }

      // ===== START_ENABLE: 启动限时特卖 =====
      if (type === 'START_ENABLE') {
        console.log('[START_ENABLE] 收到启动请求, _enableRunning =', _enableRunning);

        // 与后台一键修复互斥（双向）：修复期间不允许再启动会改商品的开卖流程。
        // 只在真正启动写流程前拒绝，不取消已有任务，也不阻止无关操作。
        const repairConflict = await findActiveRepairConflict();
        if (repairConflict) {
          console.log('[START_ENABLE] ⛔ 修复进行中，拒绝启动开卖:', repairConflict);
          await browser.storage.local.set({
            _enableProgress: { progress: null, error: repairConflict, running: false },
          }).catch(() => {});
          return { success: false, error: repairConflict };
        }

        // 如果 _enableRunning true 但 storage 显示不在运行，说明是 SW 重启后的假阳性
        if (_enableRunning) {
          try {
            const stored = await browser.storage.local.get('_enableProgress');
            const data = stored._enableProgress as { running?: boolean } | undefined;
            if (!data?.running) {
              console.log('[START_ENABLE] 标志为 true 但 storage 不在运行，重置');
              _enableRunning = false;
            }
          } catch {}
        }
        try {
          // 重试读取 storage（处理 storage 写入传播延迟）
          let params: EnableParams | undefined;
          for (let i = 0; i < 5; i++) {
            const result = await browser.storage.local.get('_enableParams');
            params = result._enableParams as EnableParams | undefined;
            if (params) break;
            if (i < 4) await new Promise(r => setTimeout(r, 200 * (i + 1)));
            console.log(`[START_ENABLE] 重试读取 _enableParams (第 ${i + 1} 次)`);
          }
          if (!params) {
            console.log('[START_ENABLE] ❌ 未找到启动参数');
            return { success: false, error: '未找到启动参数' };
          }
          const debug = import.meta.env.VITE_DEBUG_LOGS === 'true';
          if (debug) console.log(`[START_ENABLE] ✅ 参数已找到: flashSaleId=${params.flashSaleId}, spcCds=[已脱敏], products=${params.products?.length || 0}`);

          // 校验店铺访问权限
          const validation = await validateShopAccess(params.spcCds, 'enable', params.shopId);
          if (!validation.allowed) {
            if (debug) console.log('[START_ENABLE] ❌ 店铺验证失败:', validation.error);
            // 写入 _enableProgress 让 popup 能读取错误信息
            await browser.storage.local.set({
              _enableProgress: { progress: null, error: validation.error, running: false }
            }).catch(() => {});
            return { success: false, error: validation.error };
          }

          // 异步启动循环（不 await）
          runEnableLoop(params).catch(err => {
            console.error('[bg:enable] 循环异常:', err);
          });
          console.log('[START_ENABLE] 返回 success = true');
          return { success: true };
        } catch (e: any) {
          console.log('[START_ENABLE] ❌ 异常:', e?.message || e);
          return { success: false, error: e?.message || '启动失败' };
        }
      }

      // ===== START_ONE_DAY_REPAIR: 启动后台一键修复 =====
      if (type === 'START_ONE_DAY_REPAIR') {
        try {
          return await handleStartOneDayRepair({
            ownerUserId: msg?.ownerUserId,
            requestId: msg?.requestId,
          });
        } catch (e: any) {
          console.error('[bg:repair] 启动异常:', e?.message || e);
          return { success: false, error: e?.message || '启动修复任务失败' };
        }
      }

      // ===== STOP_ENABLE: 停止 =====
      if (type === 'STOP_ENABLE') {
        console.log('[STOP_ENABLE] 收到停止请求');
        _enableStopRequested = true;
        return { success: true };
      }

      // ===== GET_ENABLE_STATUS: 查询状态 =====
      if (type === 'GET_ENABLE_STATUS') {
        try {
          const result = await browser.storage.local.get('_enableProgress');
          const data = result._enableProgress as { progress?: EnableProgress; error?: string; running?: boolean } | undefined;
          return { data: data || null };
        } catch {
          return { data: null };
        }
      }

      // ===== GET_TIME_SLOTS: 获取可用时间段 =====
      if (type === 'GET_TIME_SLOTS') {
        try {
          const { spcCds: cds, spcCdsVer: cdsVer } = msg;
          // 如果消息中没有传入，尝试从 storage 读取
          let finalCds = cds;
          let finalVer = cdsVer || '2';
          if (!finalCds) {
            const result = await browser.storage.local.get(['spcCds', 'spcCdsVer']);
            finalCds = result.spcCds;
            finalVer = result.spcCdsVer || '2';
          }
          const now = Math.floor(Date.now() / 1000);
          const startTime = now - 1800;
          const endTime = getMonthEnd();
          const data = await injectedFetch<any>(
            `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}&start_time=${startTime}&end_time=${endTime}`
          );
          const list = Array.isArray(data?.data) ? data.data : [];
          return { success: true, timeSlots: list };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      }

      // ===== GET_FLASH_SALE_ITEM_COUNT: 获取活动商品数量 =====
      if (type === 'GET_FLASH_SALE_ITEM_COUNT') {
        try {
          const { flashSaleId, spcCds: cds, spcCdsVer: cdsVer } = msg;
          let finalCds = cds;
          let finalVer = cdsVer || '2';
          if (!finalCds) {
            const result = await browser.storage.local.get(['spcCds', 'spcCdsVer']);
            finalCds = result.spcCds;
            finalVer = result.spcCdsVer || '2';
          }
          const data = await injectedFetch<any>(
            `${FLASH_SALE_API}/get_shop_flash_sale_item_id_list/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}&flash_sale_id=${flashSaleId}`
          );
          const ids = data?.data?.item_ids || [];
          return { itemCount: ids.length };
        } catch (_e: any) {
          return { itemCount: 0 };
        }
      }

      // ===== CLOSE_FLASH_SALE: 关闭活动 =====
      if (type === 'CLOSE_FLASH_SALE') {
        try {
          const { flashSaleId, timeSlotId, spcCds: cds, spcCdsVer: cdsVer } = msg;
          let finalCds = cds;
          let finalVer = cdsVer || '2';
          if (!finalCds) {
            const result = await browser.storage.local.get(['spcCds', 'spcCdsVer']);
            finalCds = result.spcCds;
            finalVer = result.spcCdsVer || '2';
          }
          await injectedFetch(
            `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
            'POST',
            { flash_sale_id: flashSaleId, time_slot_id: timeSlotId, status: 2 }
          );
          return { success: true };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      }

      // ===== COPY_FLASH_SALE: 创建新活动 =====
      if (type === 'COPY_FLASH_SALE') {
        try {
          // 与一键修复互斥：创建活动属于店铺写操作，修复期间不得插入
          const repairConflict = await findActiveRepairConflict();
          if (repairConflict) {
            return { success: false, error: `${repairConflict}（未创建活动）` };
          }
          const { timeSlotId, spcCds: cds, spcCdsVer: cdsVer } = msg;
          let finalCds = cds;
          let finalVer = cdsVer || '2';
          if (!finalCds) {
            const result = await browser.storage.local.get(['spcCds', 'spcCdsVer']);
            finalCds = result.spcCds;
            finalVer = result.spcCdsVer || '2';
          }
          const data = await injectedFetch<any>(
            `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
            'POST',
            { time_slot_id: timeSlotId }
          );
          return { success: true, flashSaleId: data?.data?.flash_sale_id };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      }

      // ===== APPLY_TEMPLATE_ITEMS: 应用模板并启用商品 =====
      if (type === 'APPLY_TEMPLATE_ITEMS') {
        try {
          const { flashSaleId, items, spcCds: cds, spcCdsVer: cdsVer } = msg;
          let finalCds = cds;
          let finalVer = cdsVer || '2';
          if (!finalCds) {
            const result = await browser.storage.local.get(['spcCds', 'spcCdsVer']);
            finalCds = result.spcCds;
            finalVer = result.spcCdsVer || '2';
          }
          const data = await injectedFetch<any>(
            `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
            'POST',
            { flash_sale_id: flashSaleId, items, use_global_category: true }
          );
          return { success: true, failedItems: data?.data?.failed_items || [] };
        } catch (e: any) {
          return { success: false, error: e.message };
        }
      }

      // ===== SCHEDULE_COPY: 定时复制 =====
      if (type === 'SCHEDULE_COPY') {
        try {
          const params: ScheduledCopyParams = msg.params;
          const fireTime = params.targetStartTime - 300;
          const now = Math.floor(Date.now() / 1000);
          const delayMs = (fireTime - now) * 1000;
          console.log('[bg:SCHEDULE_COPY] 收到请求:', {
            targetStartTime: params.targetStartTime,
            targetStartTimeStr: new Date(params.targetStartTime * 1000).toLocaleString(),
            fireTime,
            fireTimeStr: new Date(fireTime * 1000).toLocaleString(),
            now,
            nowStr: new Date(now * 1000).toLocaleString(),
            delayMs,
            delayMinutes: Math.ceil(delayMs / 60000),
            sourceFlashSaleId: params.sourceFlashSaleId,
            sourceFlashSaleName: params.sourceFlashSaleName,
            productCount: params.products?.length ?? 0,
            templateName: params.templateName || '(无)',
          });
          if (delayMs <= 0) throw new Error('目标时间已过，无法安排定时任务');

          // 校验店铺访问权限（含试用限制）
          const { spcCds: scCds } = await getSpcCdsFromCookies();
          console.log('[bg:SCHEDULE_COPY] 店铺校验:', {
            hasSpcCds: !!scCds,
            spcCdsPreview: scCds ? scCds.slice(0, 16) + '...' : '无',
          });
          if (!scCds) {
            console.error('[bg:SCHEDULE_COPY] ❌ 未找到 SPC_CDS，操作已取消');
            await browser.storage.local.set({
              _copyTaskStatus: { scheduled: true, executed: true, success: false, error: '未找到 SPC_CDS，操作已取消' },
            });
            return { success: false, error: '未找到 SPC_CDS，操作已取消' };
          }
          const scValidation = await validateShopAccess(scCds, 'scheduled_copy');
          console.log('[bg:SCHEDULE_COPY] 校验结果:', { allowed: scValidation.allowed, error: scValidation.error || null });
          if (!scValidation.allowed) {
            console.error('[bg:SCHEDULE_COPY] ❌ 店铺验证失败:', scValidation.error);
            await browser.storage.local.set({
              _copyTaskStatus: { scheduled: true, executed: true, success: false, error: scValidation.error },
            });
            return { success: false, error: scValidation.error };
          }
          console.log('[bg:SCHEDULE_COPY] ✅ 店铺验证通过');

          await browser.storage.local.set({
            _scheduledCopy: params,
            _copyCountdown: { targetStartTime: params.targetStartTime, sourceName: params.sourceFlashSaleName || '' },
          });
          chrome.alarms.create('scheduled_copy', { delayInMinutes: Math.ceil(delayMs / 60000) });
          console.log('[bg:SCHEDULE_COPY] ✅ 定时任务已创建');
          // Send countdown info to content script
          sendCopyMessage('COPY_SCHEDULED', {
            targetStartTime: params.targetStartTime,
            sourceName: params.sourceFlashSaleName || '',
          });
          // 写入 storage，popup 通过 storage 读取状态（sendMessage 响应不可靠）
          await browser.storage.local.set({
            _copyTaskStatus: { scheduled: true, executed: false, success: null },
          });
          return { success: true };
        } catch (e: any) {
          console.error('[bg:SCHEDULE_COPY] ❌ 失败:', e.message);
          await browser.storage.local.set({
            _copyTaskStatus: { scheduled: true, executed: true, success: false, error: e.message },
          });
          return { success: false, error: e.message };
        }
      }

      // ===== GET_SCHEDULED_STATUS: 查询定时任务存活状态 =====
      if (type === 'GET_SCHEDULED_STATUS') {
        try {
          const storageResult = await browser.storage.local.get('_scheduledCopy');
          const params = storageResult._scheduledCopy as ScheduledCopyParams | undefined;
          const exists = !!params;

          let alarmActive = false;
          let alarmScheduledTime: number | undefined;
          let remainingSeconds: number | undefined;

          try {
            const alarm = await chrome.alarms.get('scheduled_copy');
            if (alarm) {
              alarmActive = true;
              alarmScheduledTime = alarm.scheduledTime;
              const now = Date.now();
              remainingSeconds = Math.max(0, Math.floor((alarm.scheduledTime - now) / 1000));
            }
          } catch {}

          return {
            exists,
            alarmActive,
            params: params || null,
            alarmScheduledTime,
            remainingSeconds,
          } as ScheduledTaskStatus;
        } catch (_e: any) {
          return { exists: false, alarmActive: false, params: null } as ScheduledTaskStatus;
        }
      }

      // ===== EXECUTE_COPY: 一站式复制执行 =====
      if (type === 'EXECUTE_COPY') {
        try {
          const { sourceFlashSale, targetTime, products, spcCds: cds, spcCdsVer: cdsVer, skuOverrides } = msg;
          let finalCds = cds;
          let finalVer = cdsVer || '2';
          if (!finalCds) {
            const result = await browser.storage.local.get(['spcCds', 'spcCdsVer']);
            finalCds = result.spcCds;
            finalVer = result.spcCdsVer || '2';
          }

          // 校验店铺访问权限
          const validation = await validateShopAccess(finalCds, 'copy');
          if (!validation.allowed) {
            console.log('[EXECUTE_COPY] ❌ 店铺验证失败:', validation.error);
            const failStatus = { scheduled: true, executed: true, success: false, error: validation.error };
            await browser.storage.local.set({ _copyTaskStatus: failStatus }).catch(() => {});
            sendCopyMessage('COPY_COMPLETE', { success: false, error: validation.error });
            return { success: false, error: validation.error };
          }

          // 与一键修复互斥：复制会关闭进行中的活动并新建活动，与修复同时跑会把店铺改乱。
          // 放在**首个副作用之前**，拒绝时不发出任何关闭/创建/提交请求。
          const repairConflict = await findActiveRepairConflict();
          if (repairConflict) {
            console.log('[EXECUTE_COPY] ⛔ 修复进行中，拒绝复制:', repairConflict);
            const busyStatus = { scheduled: true, executed: true, success: false, error: repairConflict };
            await browser.storage.local.set({ _copyTaskStatus: busyStatus }).catch(() => {});
            sendCopyMessage('COPY_COMPLETE', { success: false, error: repairConflict });
            return { success: false, error: repairConflict };
          }

          // 步骤 1: 检查并关闭进行中的活动
          sendCopyMessage('COPY_PROGRESS', { currentStep: 1, totalSteps: 4, description: '关闭进行中的活动...' });
          console.log('[bg:executeCopy] 步骤1: 检查进行中的活动');
          const listData = await injectedFetch<any>(
            `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}&offset=0&limit=50&type=0`
          );
          const activeSales = (listData?.data?.flash_sale_list || []).filter((s: any) => s.status === 1);
          // 从这里开始已经有真实写动作（关闭活动），标记以挡住新修复
          _copyExecuting = true;
          for (const sale of activeSales) {
            console.log(`[bg:executeCopy] 关闭活动: ${sale.flash_sale_id}`);
            await injectedFetch(
              `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
              'POST',
              { flash_sale_id: sale.flash_sale_id, time_slot_id: sale.timeslot_id, status: 2 }
            );
          }

          // 步骤 2: 获取可用时间段
          sendCopyMessage('COPY_PROGRESS', { currentStep: 2, totalSteps: 4, description: '获取时间段...' });
          console.log('[bg:executeCopy] 步骤2: 获取时间段');
          const startTime = targetTime - 1800;
          const endTime = getMonthEnd();
          const tsData = await injectedFetch<any>(
            `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}&start_time=${startTime}&end_time=${endTime}`
          );
          const timeSlots = Array.isArray(tsData?.data) ? tsData.data : [];
          let bestSlot = timeSlots[0];
          for (const slot of timeSlots) {
            if (!bestSlot || Math.abs(slot.start_time - targetTime) < Math.abs(bestSlot.start_time - targetTime)) {
              bestSlot = slot;
            }
          }
          if (!bestSlot) throw new Error('没有可用的时间段');

          // 步骤 3: 创建新活动（不含商品）
          sendCopyMessage('COPY_PROGRESS', { currentStep: 3, totalSteps: 4, description: '创建新活动...' });
          console.log('[bg:executeCopy] 步骤3: 创建新活动');
          const createData = await injectedFetch<any>(
            `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
            'POST',
            { time_slot_id: bestSlot.timeslot_id }
          );
          console.log('[bg:executeCopy] 步骤3 响应:', JSON.stringify(createData).slice(0, 1000));
          const newFlashSaleId = createData?.data?.flash_sale_id;
          if (!newFlashSaleId) throw new Error('创建活动失败，响应: ' + JSON.stringify(createData).slice(0, 300));

          // 步骤 4: 保存源活动商品数据（供后续开启限时特卖使用）
          sendCopyMessage('COPY_PROGRESS', { currentStep: 4, totalSteps: 4, description: '保存商品数据...' });
          console.log('[bg:executeCopy] 步骤4: 保存源活动商品数据');

          // 保存商品数据到 storage，供后续在 popup 中展示和开启限时特卖使用
          const savedProducts: ShopeeProduct[] = products || [];
          let savedSkuOverrides = skuOverrides || {};

          // 过滤已下架/删除的商品，避免后续开售时反复请求无效商品
          if (savedProducts.length > 0) {
            const { activeProducts, activeIds } = await filterActiveProducts(savedProducts, finalCds, finalVer);
            if (activeProducts.length < savedProducts.length) {
              // 同步过滤 skuOverrides，移除已删除商品对应的覆盖参数
              const filteredOverrides: Record<string, SkuOverride> = {};
              for (const [key, override] of Object.entries(savedSkuOverrides)) {
                const itemId = key.split('-')[0];
                if (activeIds.has(itemId)) {
                  filteredOverrides[key] = override;
                }
              }
              savedSkuOverrides = filteredOverrides;
            }
            // 使用过滤后的商品列表
            (savedProducts as ShopeeProduct[]).length = 0;
            savedProducts.push(...activeProducts);
          }

          try {
            await saveCopiedSaleData({
              sourceFlashSaleId: sourceFlashSale?.flash_sale_id || 0,
              sourceFlashSaleName: sourceFlashSale?.name || '',
              newFlashSaleId,
              copiedAt: Date.now(),
              products: savedProducts,
              skuOverrides: savedSkuOverrides,
              discountRate: msg.discountRate ?? 60,
              flashSaleStock: msg.flashSaleStock ?? 200,
              purchaseLimit: msg.purchaseLimit ?? 5,
            });
          } catch (saveErr: any) {
            console.error('[bg:executeCopy] 保存商品数据失败:', saveErr.message);
            await browser.storage.local.set({
              _copyTaskStatus: {
                scheduled: true, executed: true, success: false,
                newFlashSaleId,
                error: `复制成功但商品数据保存失败: ${saveErr.message}。请重新加载扩展后重试。`,
              },
            }).catch(() => {});
            sendCopyMessage('COPY_COMPLETE', { success: false, error: saveErr.message });
            return { success: false, error: saveErr.message };
          }

          console.log(`[bg:executeCopy] ✅ 完成: ${newFlashSaleId}`);
          const finalStatus: CopyTaskStatus = {
            scheduled: true, executed: true, success: true,
            newFlashSaleId,
          };
          await browser.storage.local.set({ _copyTaskStatus: finalStatus }).catch(() => {});
          sendCopyMessage('COPY_COMPLETE', { success: true });
          reportAnalyticsEvent('copy_flow', {
            flashSaleId: newFlashSaleId,
            hasSkuOverrides: Object.keys(skuOverrides || {}).length > 0,
          });
          consumeTrial();
          return { success: true, flashSaleId: newFlashSaleId };
        } catch (e: any) {
          console.error('[bg:executeCopy] ❌ 失败:', e);
          sendCopyMessage('COPY_COMPLETE', { success: false, error: e.message });
          return { success: false, error: e.message };
        } finally {
          // 复制结束（成功或失败）都必须放行，否则会永久挡住新修复
          _copyExecuting = false;
        }
      }

      // ===== TRIGGER_SCHEDULED_COPY_NOW: 手动触发定时复制 =====
      if (type === 'TRIGGER_SCHEDULED_COPY_NOW') {
        try {
          const result = await browser.storage.local.get('_scheduledCopy');
          const params = result._scheduledCopy as ScheduledCopyParams | undefined;
          if (!params) throw new Error('没有找到定时复制任务');

          const { spcCds: cds, spcCdsVer: cdsVer } = await getSpcCdsFromCookies();
          if (!cds) throw new Error('SPC_CDS 不存在，请确认已登录 seller.shopee.tw');

          chrome.alarms.clear('scheduled_copy');
          _copyExecuting = true;
          let flowResult;
          try {
            flowResult = await executeScheduledCopyFlow(params, cds, cdsVer);
          } finally {
            _copyExecuting = false;
          }
          console.log(`[TRIGGER] 空活动已创建: ${flowResult.newFlashSaleId}`);

          await browser.storage.local.set({
            _copyTaskStatus: {
              scheduled: true, executed: true, success: true,
              newFlashSaleId: flowResult.newFlashSaleId,
            },
          });

          await browser.storage.local.set({ _enableParams: flowResult.enableParams });
          await browser.storage.local.remove(['_scheduledCopy', '_copyCountdown', 'flashSaleCache']);

          const now = Math.floor(Date.now() / 1000);
          const enableFireTime = params.targetStartTime + 300;

          if (now >= enableFireTime) {
            // 活动已经开始超过 5 分钟，直接执行
            console.log('[TRIGGER] 活动已开始，立即提交 SKU 参数');
            runEnableLoop(flowResult.enableParams).catch(err => {
              console.error('[TRIGGER] runEnableLoop 异常:', err);
            });
            await browser.storage.local.remove('_enableParams');
          } else {
            // 活动尚未开始或刚开始不足 5 分钟，设置定时 alarm
            const enableDelayMinutes = Math.max(1, Math.ceil((enableFireTime - now) / 60));
            chrome.alarms.create('scheduled_copy_enable', { delayInMinutes: enableDelayMinutes });
            console.log(`[TRIGGER] 已安排在 ${enableDelayMinutes} 分钟后 (活动开始+5分钟) 提交 SKU 参数`);
          }

          sendCopyMessage('COPY_COMPLETE', { success: true });
          return { success: true, flashSaleId: flowResult.newFlashSaleId };
        } catch (e: any) {
          console.error('[TRIGGER] 失败:', e.message);
          await browser.storage.local.set({
            _copyTaskStatus: { scheduled: true, executed: true, success: false, error: e.message },
          });
          sendCopyMessage('COPY_COMPLETE', { success: false, error: e.message });
          return { success: false, error: e.message };
        }
      }

      // ===== START_AUTO_MODE: 启动自动模式 =====
      if (type === 'START_AUTO_MODE') {
        // 防重入：如果正在启动中或自动模式已在运行，拒绝后续请求
        if (_autoModeStarting) {
          console.warn('[bg:START_AUTO_MODE] 拒绝重复启动请求: 正在启动中');
          return { success: false, error: '正在启动中，请稍候' };
        }
        const statusCheck = await browser.storage.local.get('_autoModeStatus');
        if ((statusCheck._autoModeStatus as AutoModeStatus)?.isRunning) {
          console.warn('[bg:START_AUTO_MODE] 拒绝重复启动请求: 自动模式已在运行');
          return { success: false, error: '自动模式已在运行中' };
        }
        _autoModeStarting = true;
        const startTs = Date.now();
        console.log('[bg:START_AUTO_MODE] ===== 收到启动请求 =====');

        // 启动前清除上一次运行的日志，确保本次日志从零开始
        await browser.storage.local.set({ _autoModeLogs: [] });

        try {
          const { config, sourceFlashSaleId, sourceFlashSaleName, skuOverrides: msgOverrides, products: msgProducts, discountRate: msgDiscountRate, flashSaleStock: msgFlashSaleStock, purchaseLimit: msgPurchaseLimit, debugMode, selectedSlotId, selectedSlotTime } = msg;
          console.log('[bg:START_AUTO_MODE] 参数:', JSON.stringify({
             sourceFlashSaleId, sourceFlashSaleName,
             mode: config.mode, value: config.value,
             advanceMinutes: config.advanceMinutes, delayMinutes: config.delayMinutes,
             debugMode, selectedSlotId, selectedSlotTime: selectedSlotTime ? new Date(selectedSlotTime * 1000).toISOString() : undefined,
             skuOverrideCount: Object.keys(msgOverrides || {}).length,
             msgProductCount: msgProducts?.length ?? 0,
           }));

          // Step 0: 验证自动模式权限
          console.log('[bg:START_AUTO_MODE] Step0: 验证自动模式权限...');
          try {
            const authResult = await browser.storage.local.get(['backendAuth', 'backendUrl']);
            const auth = authResult.backendAuth as { token?: string } | undefined;
            const backendUrl = authResult.backendUrl as string | undefined;
            if (!auth?.token) {
              console.warn('[bg:START_AUTO_MODE] Step0 失败: 未登录后端');
              return { success: false, error: '未登录后端系统，请先登录' };
            }
            const baseUrl = backendUrl || DEFAULT_BACKEND_URL;
            const permResp = await tryBackendFetch(`${baseUrl}/api/auth/check-auto-mode`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${auth.token}`,
              },
            }, baseUrl);
            const permData = await permResp.json() as { allowed?: boolean };
            if (!permResp.ok || !permData.allowed) {
              console.warn('[bg:START_AUTO_MODE] Step0 失败: 无自动模式权限');
              return { success: false, error: '该功能仅限高级用户，请联络管理员开通。' };
            }
            console.log('[bg:START_AUTO_MODE] Step0 通过');
            await logAutoMode('info', 'START_AUTO_MODE Step0: 权限验证通过');
          } catch (e: any) {
            console.error('[bg:START_AUTO_MODE] Step0 异常:', e?.message);
            await logAutoMode('error', `START_AUTO_MODE Step0 异常: ${e.message}`);
            return { success: false, error: `权限验证失败: ${e.message}` };
          }

          // Step 1: 获取源活动商品数据
          console.log('[bg:START_AUTO_MODE] Step1: 读取 _copiedSaleData...');
          let sourceData: CopiedSaleData | undefined;
          try {
            const sourceDataResult = await browser.storage.local.get('_copiedSaleData');
            const allData = sourceDataResult._copiedSaleData as Record<string, CopiedSaleData> | undefined;
            sourceData = allData?.[String(sourceFlashSaleId)];
            console.log('[bg:START_AUTO_MODE] Step1 结果:', sourceData
              ? `productCount=${sourceData.products?.length}, skuOverrideCount=${Object.keys(sourceData.skuOverrides || {}).length}`
              : 'null — 未找到源活动商品数据');
            await logAutoMode(sourceData ? 'success' : 'warning', `START_AUTO_MODE Step1: ${sourceData ? `找到 ${sourceData.products?.length} 个商品` : '未找到源活动商品数据'}`);
          } catch (e: any) {
            console.error('[bg:START_AUTO_MODE] Step1 失败:', e?.message, e?.stack);
            return { success: false, error: `读取源活动数据失败: ${e?.message || '未知错误'}` };
          }

          if (!sourceData?.products?.length) {
            // _copiedSaleData 中没有数据时，尝试使用 popup 传来的 products
            if (msgProducts?.length) {
              console.log('[bg:START_AUTO_MODE] Step1 _copiedSaleData 为空，使用消息中附带的 products (数量=' + msgProducts.length + ')');
              sourceData = {
                sourceFlashSaleId,
                sourceFlashSaleName,
                newFlashSaleId: sourceFlashSaleId,
                copiedAt: Date.now(),
                products: msgProducts,
                skuOverrides: msgOverrides || {},
                discountRate: msgDiscountRate ?? 0,
                flashSaleStock: msgFlashSaleStock ?? 0,
                purchaseLimit: msgPurchaseLimit ?? 0,
              };
            } else {
              console.warn('[bg:START_AUTO_MODE] Step1 失败: 源活动无商品 (_copiedSaleData 和消息中均无)');
              return { success: false, error: '源活动没有商品数据，请先在主界面加载该活动' };
            }
          }

          // Step 2: 获取 SPC_CDS
          console.log('[bg:START_AUTO_MODE] Step2: 获取 SPC_CDS...');
          let spcCds = ''; let spcCdsVer = '';
          try {
            const cookies = await getSpcCdsFromCookies();
            spcCds = cookies.spcCds; spcCdsVer = cookies.spcCdsVer;
            console.log('[bg:START_AUTO_MODE] Step2 结果:', spcCds ? `SPC_CDS=${spcCds.slice(0, 12)}..., SPC_CDS_VER=${spcCdsVer}` : 'SPC_CDS 为空');
          } catch (e: any) {
            console.error('[bg:START_AUTO_MODE] Step2 失败:', e?.message, e?.stack);
            return { success: false, error: `获取 SPC_CDS 失败: ${e?.message || '未知错误'}` };
          }
          if (!spcCds) {
            console.warn('[bg:START_AUTO_MODE] Step2 失败: SPC_CDS 为空');
            return { success: false, error: 'SPC_CDS 不存在，请确认已登录 seller.shopee.tw' };
          }

          // Step 3: 验证场次
          if (selectedSlotId && selectedSlotTime) {
            console.log('[bg:START_AUTO_MODE] Step3: 验证场次 #' + selectedSlotId + '...');
            try {
              const now = Math.floor(Date.now() / 1000);
              const tsData = await injectedFetch<any>(
                `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&start_time=${now - 1800}&end_time=${getMonthEnd()}`
              );
              const currentSlots = Array.isArray(tsData?.data) ? tsData.data : [];
              console.log('[bg:START_AUTO_MODE] Step3 场次总数:', currentSlots.length);
              const foundSlot = currentSlots.find((s: any) => s.timeslot_id === selectedSlotId);
              if (!foundSlot) {
                console.warn('[bg:START_AUTO_MODE] Step3 失败: 场次不存在');
                return { success: false, error: `选择的场次 #${selectedSlotId} 已不存在，请重新选择` };
              }
              if (foundSlot.start_time !== selectedSlotTime) {
                console.warn('[bg:START_AUTO_MODE] Step3 失败: 时间已变更', { expected: selectedSlotTime, actual: foundSlot.start_time });
                return { success: false, error: `场次 #${selectedSlotId} 的开始时间已变更，请重新选择` };
              }
              if (foundSlot.start_time <= now) {
                console.warn('[bg:START_AUTO_MODE] Step3 失败: 场次已开始');
                return { success: false, error: `场次 #${selectedSlotId} 已经开始 (${fmtBgTime(foundSlot.start_time)})，请选择未来的场次` };
              }
              console.log('[bg:START_AUTO_MODE] Step3 通过');
            } catch (e: any) {
              console.error('[bg:START_AUTO_MODE] Step3 失败:', e?.message, e?.stack);
              return { success: false, error: `验证场次失败: ${e?.message || '未知错误'}` };
            }
          } else {
            console.log('[bg:START_AUTO_MODE] Step3 跳过: 无选定场次');
          }

          // Step 4: 清除残留状态
          console.log('[bg:START_AUTO_MODE] Step4: 清除残留状态...');
          try {
            await clearAutoModeAlarms();
            await browser.storage.local.remove('_enableParams');
            console.log('[bg:START_AUTO_MODE] Step4 完成');
          } catch (e: any) {
            console.error('[bg:START_AUTO_MODE] Step4 失败:', e?.message);
          }

          // Step 5: 计算总轮数
          console.log('[bg:START_AUTO_MODE] Step5: 计算总轮数...');
          let totalRounds = config.value;
          if (config.mode === 'days') {
            try {
              const now = Math.floor(Date.now() / 1000);
              const endTime = getMonthEnd();
              const tsData = await injectedFetch<any>(
                `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&start_time=${now - 1800}&end_time=${endTime}`
              );
              const slots = Array.isArray(tsData?.data) ? tsData.data : [];
              totalRounds = countSlotsInDays(slots, config.value);
              console.log('[bg:START_AUTO_MODE] Step5 天数模式下总轮数:', totalRounds);
            } catch (e: any) {
              console.error('[bg:START_AUTO_MODE] Step5 失败:', e?.message);
              return { success: false, error: `计算场次失败: ${e?.message || '未知错误'}` };
            }
            if (totalRounds === 0) {
              console.warn('[bg:START_AUTO_MODE] Step5 失败: 无可选场次');
              return { success: false, error: `未来 ${config.value} 天内没有可用的限时特卖时间段` };
            }
          } else {
            console.log('[bg:START_AUTO_MODE] Step5 轮数模式: totalRounds=' + totalRounds);
          }

          _autoModeStopRequested = false;

          // 启动前过滤已下架/删除的商品
          let autoProducts = sourceData.products || [];
          let autoOverrides = msgOverrides || sourceData.skuOverrides || {};
          if (autoProducts.length > 0) {
            const { activeProducts, activeIds } = await filterActiveProducts(autoProducts, spcCds, spcCdsVer);
            if (activeProducts.length < autoProducts.length) {
              const filteredOverrides: Record<string, SkuOverride> = {};
              for (const [key, override] of Object.entries(autoOverrides)) {
                const itemId = key.split('-')[0];
                if (activeIds.has(itemId)) {
                  filteredOverrides[key] = override;
                }
              }
              autoOverrides = filteredOverrides;
              await logAutoMode('warning', `启动时已过滤 ${autoProducts.length - activeProducts.length} 个已下架/删除的商品`);
            }
            autoProducts = activeProducts;
          }

          // Step 6: 构建并保存状态
          console.log('[bg:START_AUTO_MODE] Step6: 构建并保存状态...');
          const status: AutoModeStatus = {
            isRunning: true,
            sourceFlashSaleId,
            sourceFlashSaleName,
            config,
            currentRound: 1,
            totalRounds,
            phase: 'idle',
            startedAt: Date.now(),
            debugMode: !!debugMode,
            selectedSlotId,
            selectedSlotTime,
            enableParams: {
              products: autoProducts,
              skuOverrides: autoOverrides,
              discountRate: sourceData.discountRate,
              flashSaleStock: sourceData.flashSaleStock,
              purchaseLimit: sourceData.purchaseLimit,
              skipSkuKeys: msg.skipSkuKeys || [],
              shopId: msg.shopId,
            },
          };

          try {
            await saveAutoModeStatus(status);
            console.log('[bg:START_AUTO_MODE] Step6 _autoModeStatus 已保存');
            await logAutoMode('success', `START_AUTO_MODE Step6: 状态已保存`, {
              totalRounds: status.totalRounds,
              advanceMinutes: status.config.advanceMinutes,
              delayMinutes: status.config.delayMinutes,
            });
          } catch (e: any) {
            console.error('[bg:START_AUTO_MODE] Step6 保存失败:', e?.message);
            await logAutoMode('error', `START_AUTO_MODE Step6 保存失败: ${e.message}`);
            await browser.storage.local.remove('_autoModeStatus');
            return { success: false, error: `保存自动模式状态失败: ${e?.message || '未知错误'}` };
          }

          // Step 7: 通知前端
          console.log('[bg:START_AUTO_MODE] Step7: 通知前端...');
          await sendAutoModeUpdate(status);

          // Step 8: 记录日志并调度
          console.log('[bg:START_AUTO_MODE] Step8: 记录日志并调度首轮...');
          await logAutoMode('info', `自动模式启动: 源活动 "${sourceFlashSaleName}", ${config.mode === 'rounds' ? `共 ${totalRounds} 轮` : `${config.value} 天共 ${totalRounds} 场`}`);

          try {
            await scheduleNextRound();
            console.log(`[bg:START_AUTO_MODE] Step8 scheduleNextRound 完成`);
            await logAutoMode('success', 'START_AUTO_MODE Step8: 首轮调度完成');
          } catch (e: any) {
            console.error('[bg:START_AUTO_MODE] Step8 scheduleNextRound 失败:', e?.message, e?.stack);
            await logAutoMode('error', `START_AUTO_MODE Step8 调度失败: ${e.message}`, { stack: e.stack });
            status.phase = 'stopped';
            status.lastError = `调度首轮失败: ${e?.message}`;
            await saveAutoModeStatus(status);
            await sendAutoModeUpdate(status);
            return { success: false, error: `调度首轮失败: ${e?.message || '未知错误'}` };
          }

          const elapsed = Date.now() - startTs;
          console.log(`[bg:START_AUTO_MODE] ===== 启动成功，耗时 ${elapsed}ms =====`);
          return { success: true };
        } catch (e: any) {
          const elapsed = Date.now() - startTs;
          console.error(`[bg:START_AUTO_MODE] ===== 启动异常，耗时 ${elapsed}ms =====`, e?.message, e?.stack);
          return { success: false, error: `启动自动模式失败: ${e?.message || '未知错误'}` };
        } finally {
          _autoModeStarting = false;
        }
      }

      // ===== STOP_AUTO_MODE: 停止自动模式 =====
      if (type === 'STOP_AUTO_MODE') {
        _autoModeStopRequested = true;
        try {
          await clearAutoModeAlarms();
          await browser.storage.local.remove('_enableParams');
          const result = await browser.storage.local.get('_autoModeStatus');
          const status = result._autoModeStatus as AutoModeStatus | undefined;
          if (status) {
            status.isRunning = false;
            status.phase = 'stopped';
            await saveAutoModeStatus(status);
            await sendAutoModeUpdate(status);
          }
          await logAutoMode('warning', '自动模式已手动停止');
          reportAnalyticsEvent('auto_mode_stop', {
            currentRound: status?.currentRound || 0,
            totalRounds: status?.totalRounds || 0,
          });
          await browser.storage.local.remove('_autoModeStatus');
        } catch (e: any) {
          await logAutoMode('error', `停止自动模式时出错: ${e.message}`, { stack: e.stack });
        }
        return { success: true };
      }

      // ===== GET_AUTO_MODE_STATUS: 查询自动模式状态 =====
      if (type === 'GET_AUTO_MODE_STATUS') {
        try {
          const result = await browser.storage.local.get('_autoModeStatus');
          return { status: result._autoModeStatus || null };
        } catch {
          return { status: null };
        }
      }

      // ===== EXPORT_AUTO_MODE_LOGS: 导出自动模式日志为文件 =====
      if (type === 'EXPORT_AUTO_MODE_LOGS') {
        // 哨兵：第一时间写入 storage，证明 handler 被调用了
        const exportLogs: string[] = [];
        const handlerEntryTime = Date.now();
        exportLogs.push(`handler_entered_at=${handlerEntryTime}`);
        await browser.storage.local.set({ _exportLogResult: { _handlerEntered: true, _time: handlerEntryTime, _debug: exportLogs } }).catch(() => {});

        const saveAndReturn = async (result: Record<string, unknown>) => {
          await browser.storage.local.set({ _exportLogResult: result }).catch(() => {});
          return result;
        };

        try {
          // Step 1: 读取 storage
          exportLogs.push('step1: 开始读取storage');
          let logs: AutoModeLog[] = [];
          try {
            const result = await browser.storage.local.get('_autoModeLogs');
            logs = (result._autoModeLogs as AutoModeLog[]) || [];
            exportLogs.push(`step1: 读取成功, 共${logs.length}条日志`);
          } catch (e: any) {
            exportLogs.push(`step1: 读取失败 — ${e?.message || String(e)}`);
            throw new Error(`[step1-storage] ${e?.message || String(e)}`);
          }

          // Step 2: 格式化为文本
          exportLogs.push('step2: 开始格式化');
          let text = '';
          try {
            const lines = logs.map(l => {
              const label = `[${l.iso || '?'}] [${(l.type || 'info').toUpperCase()}]`;
              const dataStr = l.data ? ` ${JSON.stringify(l.data)}` : '';
              return `${label} ${l.message || ''}${dataStr}`;
            });
            text = lines.join('\n');
            exportLogs.push(`step2: 格式化成功, 文本长度${text.length}`);
          } catch (e: any) {
            exportLogs.push(`step2: 格式化失败 — ${e?.message || String(e)}`);
            throw new Error(`[step2-format] ${e?.message || String(e)}`);
          }

          // Step 3: 创建 Blob
          exportLogs.push('step3: 开始创建Blob');
          let dataUrl = '';
          try {
            const blob = new Blob([text], { type: 'text/plain' });
            dataUrl = URL.createObjectURL(blob);
            exportLogs.push(`step3: Blob创建成功, url=${dataUrl.substring(0, 50)}...`);
          } catch (e: any) {
            exportLogs.push(`step3: Blob创建失败 — ${e?.message || String(e)}`);
            throw new Error(`[step3-blob] ${e?.message || String(e)}`);
          }

          // Step 4: 生成文件名
          const ts = new Date();
          const pad = (n: number) => String(n).padStart(2, '0');
          const fname = `auto-mode-logs-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.txt`;
          exportLogs.push(`step4: 文件名=${fname}`);

          // Step 5: 检查 chrome.downloads API 是否可用
          exportLogs.push(`step5: chrome.downloads=${typeof chrome?.downloads}, .download=${typeof chrome?.downloads?.download}`);

          // Step 6: 触发下载
          exportLogs.push('step6: 开始调用chrome.downloads.download');
          try {
            const downloadId = await chrome.downloads.download({ url: dataUrl, filename: fname, saveAs: true });
            exportLogs.push(`step6: 下载调用成功, downloadId=${downloadId}`);
          } catch (e: any) {
            exportLogs.push(`step6: 下载调用失败 — ${e?.message || String(e)} — name=${e?.name || '?'} — constructor=${e?.constructor?.name || '?'}`);
            throw new Error(`[step6-download] ${e?.message || String(e)}`);
          }

          // Step 7: 延迟 revoke
          setTimeout(() => {
            try { URL.revokeObjectURL(dataUrl); } catch {}
          }, 5000);
          exportLogs.push('step7: 完成');

          return await saveAndReturn({ success: true, count: logs.length, filename: fname, _debug: exportLogs });
        } catch (e: any) {
          console.error('[bg:EXPORT] 导出失败:', e?.message || String(e), exportLogs);
          return await saveAndReturn({ success: false, error: e?.message || String(e), _debug: exportLogs });
        }
      }

      // ===== SCHEDULE_ENABLE: 定时开启（Wizard 修复后定时加入限时特卖）=====
      if (type === 'SCHEDULE_ENABLE') {
        try {
          const { enableParams, fireTime, flashSaleName } = msg;
          const now = Math.floor(Date.now() / 1000);
          const delaySec = fireTime - now;
          console.log('[bg:SCHEDULE_ENABLE]', { fireTime, now, delaySec, flashSaleName });

          if (delaySec <= 0) {
            return { success: false, error: '目标时间已过，请使用立即加入' };
          }

          // 校验店铺访问权限（含试用限制）
          if (enableParams?.spcCds) {
            const seValidation = await validateShopAccess(enableParams.spcCds, 'scheduled_enable');
            if (!seValidation.allowed) {
              console.log('[bg:SCHEDULE_ENABLE] ❌ 店铺验证失败:', seValidation.error);
              return { success: false, error: seValidation.error };
            }
          }

          await browser.storage.local.set({
            _enableParams: enableParams,
            _scheduledEnable: { fireTime, flashSaleName, flashSaleId: enableParams.flashSaleId },
          });

          const delayMinutes = Math.max(1, Math.ceil(delaySec / 60));
          chrome.alarms.create('scheduled_enable', { delayInMinutes: delayMinutes });
          console.log(`[bg:SCHEDULE_ENABLE] ✅ 定时开启任务已创建，${delayMinutes} 分钟后触发`);

          return { success: true };
        } catch (e: any) {
          console.error('[bg:SCHEDULE_ENABLE] ❌ 失败:', e.message);
          return { success: false, error: e.message };
        }
      }

      // ===== SCHEDULE_WIZARD_FLOW: 定时创建 + 定时启用（Wizard 创建新场次）=====
      if (type === 'SCHEDULE_WIZARD_FLOW') {
        try {
          const { timeSlotId, createTime, enableFireTime, enableParams, spcCds: cds, spcCdsVer: cdsVer } = msg;
          const now = Math.floor(Date.now() / 1000);

          if (createTime <= now) {
            return { success: false, error: '创建时间已过，请重新操作' };
          }

          // 校验店铺访问权限（含试用限制）
          let finalCds = cds;
          if (!finalCds) {
            const cookies = await getSpcCdsFromCookies();
            finalCds = cookies.spcCds;
          }
          if (finalCds) {
            const swValidation = await validateShopAccess(finalCds, 'wizard_flow', enableParams?.shopId);
            if (!swValidation.allowed) {
              console.log('[bg:SCHEDULE_WIZARD_FLOW] ❌ 店铺验证失败:', swValidation.error);
              return { success: false, error: swValidation.error };
            }
          }

          await browser.storage.local.set({
            _wizardFlowParams: { timeSlotId, enableFireTime, enableParams, cds, cdsVer },
          });

          const delayMin = Math.max(1, Math.ceil((createTime - now) / 60));
          chrome.alarms.create('wizard_create', { delayInMinutes: delayMin });
          console.log(`[bg:SCHEDULE_WIZARD_FLOW] ✅ ${delayMin} 分钟后创建空活动`);

          return { success: true };
        } catch (e: any) {
          console.error('[bg:SCHEDULE_WIZARD_FLOW] ❌ 失败:', e.message);
          return { success: false, error: e.message };
        }
      }

      // ===== CLEAR_ENABLE_STATE: 清除状态 =====
      if (type === 'CLEAR_ENABLE_STATE') {
        await clearEnableState();
        return { success: true };
      }
    });

    // ===== chrome.alarms 监听（定时复制） =====
    chrome.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === HEARTBEAT_ALARM) {
        handleHeartbeat();
        return;
      }

      if (alarm.name === ORPHAN_ALARM) {
        await reconcileOrphanRepairTask();
        return;
      }

      if (alarm.name === 'scheduled_copy') {
        console.log('[bg:scheduled_copy] 定时复制任务触发 (活动开始前5分钟)');
        try {
          const result = await browser.storage.local.get('_scheduledCopy');
          const params = result._scheduledCopy as ScheduledCopyParams | undefined;
          if (!params) return;

          const { spcCds: cds, spcCdsVer: cdsVer } = await getSpcCdsFromCookies();
          if (!cds) throw new Error('SPC_CDS 不存在，请确认已登录 seller.shopee.tw');

          _copyExecuting = true;
          let flowResult;
          try {
            flowResult = await executeScheduledCopyFlow(params, cds, cdsVer);
          } finally {
            _copyExecuting = false;
          }
          console.log(`[bg:scheduled_copy] 空活动已创建: ${flowResult.newFlashSaleId}`);

          await browser.storage.local.set({
            _copyTaskStatus: {
              scheduled: true, executed: true, success: true,
              newFlashSaleId: flowResult.newFlashSaleId,
            },
          });

          reportAnalyticsEvent('copy_flow', {
            flashSaleId: flowResult.newFlashSaleId,
            source: 'scheduled_copy',
          });
          consumeTrial();

          await browser.storage.local.set({ _enableParams: flowResult.enableParams });
          await browser.storage.local.remove(['_scheduledCopy', '_copyCountdown', 'flashSaleCache']);

          // 设置第二个 alarm：活动开始 5 分钟后执行 enable
          const enableFireTime = params.targetStartTime + 300;
          const now = Math.floor(Date.now() / 1000);
          const enableDelayMinutes = Math.max(1, Math.ceil((enableFireTime - now) / 60));
          chrome.alarms.create('scheduled_copy_enable', { delayInMinutes: enableDelayMinutes });
          console.log(`[bg:scheduled_copy] 已安排在 ${enableDelayMinutes} 分钟后 (活动开始+5分钟) 提交 SKU 参数`);
        } catch (e: any) {
          console.error('[bg:scheduled_copy] 失败:', e.message);
          sendCopyMessage('COPY_COMPLETE', { success: false, error: e.message });
          await browser.storage.local.set({
            _copyTaskStatus: { scheduled: true, executed: true, success: false, error: e.message },
          });
        }
      }

      if (alarm.name === 'scheduled_copy_enable') {
        console.log('[bg:scheduled_copy_enable] 定时启用任务触发 (活动开始5分钟后)');
        try {
          const paramsResult = await browser.storage.local.get('_enableParams');
          const params = paramsResult._enableParams as EnableParams | undefined;
          if (!params) {
            console.log('[bg:scheduled_copy_enable] 未找到 enable 参数，跳过');
            return;
          }

          const { spcCds: cds, spcCdsVer: cdsVer } = await getSpcCdsFromCookies();
          if (!cds) {
            console.error('[scheduled_copy_enable] ❌ 未找到 SPC_CDS，操作已取消');
            await browser.storage.local.remove('_enableParams');
            return;
          }
          params.spcCds = cds;
          params.spcCdsVer = cdsVer;

          await browser.storage.local.set({ _enableParams: params });

          // 校验店铺访问权限
          const validation = await validateShopAccess(params.spcCds, 'scheduled_copy_enable', params.shopId);
          if (!validation.allowed) {
            console.log('[scheduled_copy_enable] ❌ 店铺验证失败:', validation.error);
            await browser.storage.local.remove('_enableParams');
            return;
          }

          try {
            await runEnableLoop(params);
            console.log('[bg:scheduled_copy_enable] 启用循环已启动');
          } catch (err: any) {
            console.error('[scheduled_copy_enable] runEnableLoop 异常:', err);
          }
          await browser.storage.local.remove('_enableParams');
        } catch (e: any) {
          console.error('[bg:scheduled_copy_enable] 失败:', e.message);
        }
      }

      if (alarm.name === 'scheduled_enable') {
        console.log('[bg:scheduled_enable] 定时开启任务触发');
        try {
          const paramsResult = await browser.storage.local.get(['_enableParams', '_scheduledEnable']);
          const params = paramsResult._enableParams as EnableParams | undefined;
          if (!params) {
            console.log('[bg:scheduled_enable] 未找到 enable 参数，跳过');
            await browser.storage.local.remove('_scheduledEnable').catch(() => {});
            return;
          }

          const { spcCds: cds, spcCdsVer: cdsVer } = await getSpcCdsFromCookies();
          if (!cds) {
            console.error('[bg:scheduled_enable] ❌ 未找到 SPC_CDS，操作已取消');
            await browser.storage.local.remove(['_enableParams', '_scheduledEnable']).catch(() => {});
            return;
          }
          params.spcCds = cds;
          params.spcCdsVer = cdsVer;

          // 校验店铺访问权限
          const validation = await validateShopAccess(params.spcCds, 'scheduled_enable', params.shopId);
          if (!validation.allowed) {
            console.log('[bg:scheduled_enable] ❌ 店铺验证失败:', validation.error);
            await browser.storage.local.remove(['_enableParams', '_scheduledEnable']).catch(() => {});
            return;
          }

          try {
            // 过滤已下架/删除的商品（可能在定时等待期间被用户手动删除）
            if (params.products?.length) {
              const { activeProducts, activeIds } = await filterActiveProducts(params.products, params.spcCds, params.spcCdsVer);
              if (activeProducts.length < params.products.length) {
                const filteredOverrides: Record<string, SkuOverride> = {};
                for (const [key, override] of Object.entries(params.skuOverrides || {})) {
                  if (activeIds.has(key.split('-')[0])) {
                    filteredOverrides[key] = override;
                  }
                }
                params.skuOverrides = filteredOverrides;
              }
              params.products = activeProducts;
            }
            await runEnableLoop(params);
            console.log('[bg:scheduled_enable] 启用循环已启动');
          } catch (err: any) {
            console.error('[bg:scheduled_enable] runEnableLoop 异常:', err);
          }
          await browser.storage.local.remove(['_enableParams', '_scheduledEnable']).catch(() => {});
        } catch (e: any) {
          console.error('[bg:scheduled_enable] 失败:', e.message);
        }
      }

      if (alarm.name === 'wizard_create') {
        console.log('[bg:wizard_create] 定时创建空活动触发');
        try {
          const stored = await browser.storage.local.get('_wizardFlowParams');
          const params = stored._wizardFlowParams as { timeSlotId: number; enableFireTime: number; enableParams: any; cds: string; cdsVer: string } | undefined;
          if (!params) return;

          const wizValidation = await validateShopAccess(params.cds, 'wizard_create', params.enableParams?.shopId);
          if (!wizValidation.allowed) {
            console.error('[bg:wizard_create] 店铺验证失败:', wizValidation.error);
            await browser.storage.local.remove('_wizardFlowParams').catch(() => {});
            return;
          }

          // Step 1: 创建空活动
          const createData = await injectedFetch<any>(
            `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${params.cds}&SPC_CDS_VER=${params.cdsVer}`,
            'POST',
            { time_slot_id: params.timeSlotId }
          );
          const newFlashSaleId = createData?.data?.flash_sale_id;
          if (!newFlashSaleId) throw new Error('创建空活动失败');

          console.log(`[bg:wizard_create] 空活动已创建: #${newFlashSaleId}`);

          // Step 2: 更新 enableParams 中的 flashSaleId
          params.enableParams.flashSaleId = newFlashSaleId;

          // Step 3: 保存 _wizardFlashSaleId、_enableParams 和 _copiedSaleData
          // _copiedSaleData 确保用户查看空活动时 loadFlashSaleProducts 能找到商品数据
          const copiedDataResult = await browser.storage.local.get('_copiedSaleData');
          const allCopiedData: Record<string, any> = copiedDataResult._copiedSaleData || {};
          allCopiedData[String(newFlashSaleId)] = {
            sourceFlashSaleId: 0,
            sourceFlashSaleName: '一键修复',
            newFlashSaleId,
            copiedAt: Date.now(),
            products: params.enableParams.products,
            skuOverrides: params.enableParams.skuOverrides,
            discountRate: params.enableParams.discountRate,
            flashSaleStock: params.enableParams.flashSaleStock,
            purchaseLimit: params.enableParams.purchaseLimit,
          };
          await browser.storage.local.set({
            _wizardFlashSaleId: newFlashSaleId,
            _enableParams: params.enableParams,
            _copiedSaleData: allCopiedData,
          });

          // Step 4: 设置定时启用 alarm
          const now = Math.floor(Date.now() / 1000);
          const enableDelayMin = Math.max(1, Math.ceil((params.enableFireTime - now) / 60));
          chrome.alarms.create('scheduled_enable', { delayInMinutes: enableDelayMin });
          await browser.storage.local.remove('_wizardFlowParams').catch(() => {});
          console.log(`[bg:wizard_create] 已安排 ${enableDelayMin} 分钟后提交商品参数`);
        } catch (e: any) {
          console.error('[bg:wizard_create] 失败:', e.message);
        }
      }

      if (alarm.name === 'auto_mode_create') {
        await logAutoMode('info', 'auto_mode_create alarm 触发');
        try {
          await handleAutoModeCreate();
        } catch (e: any) {
          await logAutoMode('error', `handleAutoModeCreate 异常: ${e.message}`, { stack: e.stack });
        }
      }

      if (alarm.name === 'auto_mode_enable') {
        await logAutoMode('info', 'auto_mode_enable alarm 触发');
        try {
          await handleAutoModeEnable();
        } catch (e: any) {
          await logAutoMode('error', `handleAutoModeEnable 异常: ${e.message}`, { stack: e.stack });
        }
      }

      if (alarm.name === 'auto_mode_heartbeat') {
        await logAutoMode('info', 'auto_mode_heartbeat alarm 触发');
        try {
          await handleAutoModeHeartbeat();
        } catch (e: any) {
          await logAutoMode('error', `handleAutoModeHeartbeat 异常: ${e.message}`, { stack: e.stack });
        }
      }
    });
  },
});
