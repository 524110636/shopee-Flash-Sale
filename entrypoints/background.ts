import { defineBackground } from 'wxt/utils/define-background';
import type { ShopeeProduct, EnableItem, EnableResult, EnableProgress, SkuOverride, CopyTaskStatus, ScheduledCopyParams } from './popup/types';

// ===== Constants =====
const GRAPHQL_URL = 'https://seller.shopee.tw/api/marketing/v4/graphql/query/';
const FLASH_SALE_API = 'https://seller.shopee.tw/api/marketing/v4/shop_flash_sale';

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

// ===== Params type for enable loop =====
interface EnableParams {
  products: ShopeeProduct[];
  flashSaleId: number;
  spcCds: string;
  spcCdsVer: string;
  maxRetries: number;
  infiniteRetry: boolean;
  discountRate: number;
  flashSaleStock: number;
  purchaseLimit: number;
  skuOverrides: Record<string, SkuOverride>;
}

// ===== Progress helpers =====
async function saveProgress(progress: EnableProgress, running: boolean, error?: string) {
  await browser.storage.local.set({ _enableProgress: { progress, error, running } });
}

async function sendProgressToContentScript(progress: EnableProgress) {
  try {
    const tabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
    for (const tab of tabs) {
      if (tab.id) {
        await browser.tabs.sendMessage(tab.id, { type: 'ENABLE_PROGRESS', progress }).catch(() => {});
      }
    }
  } catch {
    // no content script — fine
  }
}

async function sendCompleteToContentScript(progress: EnableProgress) {
  try {
    const tabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
    for (const tab of tabs) {
      if (tab.id) {
        await browser.tabs.sendMessage(tab.id, { type: 'ENABLE_COMPLETE', progress }).catch(() => {});
      }
    }
  } catch {
    // no content script — fine
  }
}

async function sendProgress(progress: EnableProgress, error?: string) {
  try {
    await browser.runtime.sendMessage({ type: 'ENABLE_PROGRESS', progress, error });
  } catch {
    // popup closed — OK, progress is saved to storage
  }
  await sendProgressToContentScript(progress);
}

async function sendComplete(progress: EnableProgress, error?: string) {
  try {
    await browser.runtime.sendMessage({ type: 'ENABLE_COMPLETE', progress, error });
  } catch {
    // popup closed
  }
  await sendCompleteToContentScript(progress);
}

async function clearEnableState() {
  try {
    await browser.storage.local.remove(['_enableParams', '_enableProgress']);
  } catch { /* ignore */ }
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

// ===== Injected fetch (MAIN world) =====
async function injectedFetch<T>(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  body?: object,
  referrerUrl?: string,
): Promise<T> {
  console.log('[bg:injectedFetch] 开始', { url, method, hasBody: !!body, referrerUrl });
  const tabs = await browser.tabs.query({ url: '*://seller.shopee.tw/*' });
  const tab = tabs?.[0];
  console.log('[bg:injectedFetch] seller 标签页:', { tabId: tab?.id, url: tab?.url });
  if (!tab?.id) throw new Error('没有找到 seller.shopee.tw 标签页，请保持卖家中心页面打开');

  // 获取 sc-fe-session
  console.log('[bg:injectedFetch] 开始获取 sc-fe-session...');
  const sessionInfo = await withTimeout(browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      try {
        const fromWindow = (window as any).__INITIAL_STATE__?.session?.sc_fe_session;
        const fromMeta = document.querySelector('meta[name="sc-fe-session"]')?.getAttribute('content');
        const cookies = document.cookie.split('; ').reduce((acc, c) => {
          const [k, ...v] = c.split('=');
          acc[k] = v.join('=');
          return acc;
        }, {} as Record<string, string>);
        const fromCookie = cookies['sc_fe_session'] || cookies['sc-fe-session'] || '';
        const fromWindow2 = (window as any)['sc-fe-session'] || (window as any).sc_fe_session || '';
        let fromScript = '';
        const scripts = document.querySelectorAll('script');
        for (let i = 0; i < Math.min(scripts.length, 5); i++) {
          const text = scripts[i].textContent || '';
          const m = text.match(/["']sc-fe-session["']\s*:\s*["']([^"']+)["']/);
          if (m) { fromScript = m[1]; break; }
        }
        return fromWindow || fromMeta || fromCookie || fromWindow2 || fromScript || '';
      } catch { return ''; }
    },
  }), 10000, 'sc-fe-session 获取');
  const scFeSession = (sessionInfo?.[0]?.result as string) || '';
  console.log('[bg:injectedFetch] sc-fe-session:', scFeSession || '(空)');

  console.log('[bg:injectedFetch] 开始执行 API 请求...');
  const results = await withTimeout(browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (fetchUrl: string, fetchMethod: string, fetchBody: string | null, scFeSession: string, referrerUrl: string) => {
      try {
        const headers: Record<string, string> = {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
        };
        if (scFeSession) headers['sc-fe-session'] = scFeSession;
        const opts: RequestInit = { method: fetchMethod, credentials: 'include', headers };
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
    args: [url, method, body ? JSON.stringify(body) : null, scFeSession, referrerUrl || ''],
  }), 30000, 'API 请求');

  const result = results?.[0]?.result as any;
  if (!result) throw new Error('页面脚本执行返回为空，请刷新页面后重试');
  if (result._error) throw new Error(`API 请求失败: ${result._error}`);
  return result as T;
}

// ===== Enable Loop =====
async function runEnableLoop(params: EnableParams) {
  if (_enableRunning) {
    console.log('[bg:enable] 已有循环在运行，忽略重复启动');
    return;
  }
  _enableRunning = true;
  try {
    const { products, flashSaleId, spcCds, spcCdsVer, maxRetries, infiniteRetry, discountRate, flashSaleStock, purchaseLimit, skuOverrides } = params;

  // 构建所有 SKU 的提交数据
  console.log('[bg:enable] skuOverrides 全部:', JSON.stringify(skuOverrides));
  const allItems: EnableItem[] = products.flatMap(p =>
    (p.modelList || [])
      .filter(sku => (sku.normalStock || 0) > 0)
      .map(sku => {
        const key = `${p.itemid}-${sku.modelid}`;
        const override = skuOverrides[key];
        const usedDiscount = override?.discountRate ?? discountRate;
        const usedStock = Math.min(override?.stock ?? flashSaleStock, sku.normalStock || flashSaleStock);
        const usedPurchaseLimit = override?.purchaseLimit ?? purchaseLimit;
        const promoPrice = Math.floor(Number(sku.originPrice || p.originPrice || 0) * usedDiscount / 100);
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

  // 立即保存运行状态，确保弹窗关闭后重新打开能看到循环在运行
  const initialProgress: EnableProgress = {
    totalSkus: allItems.length, successSkus: 0, failedSkus: 0,
    currentRound: 0, maxRetries, nextRetryItems: [], isComplete: false,
  };
  await saveProgress(initialProgress, true);

  _enableStopRequested = false;
  let currentItems = [...allItems];
  let successCount = 0;
  let failedResults: EnableResult[] = [];
  let lastRawResponse = '';
  let round = 0;

  for (round = 1; ; round++) {
    if (!infiniteRetry && round > maxRetries) break;
    if (_enableStopRequested) {
      console.log('[bg:enable] ⏹ 用户取消');
      break;
    }

    try {
      console.log(`[bg:enable] === 第 ${round} 轮提交开始 ===`);
      const response = await injectedFetch<any>(
        `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
        'POST',
        { flash_sale_id: flashSaleId, items: currentItems, use_global_category: true },
      );

      lastRawResponse = JSON.stringify(response).slice(0, 2000);
      console.log('[bg:enable] 原始响应:', JSON.stringify(response, null, 2).slice(0, 3000));

      // 顶层 API 错误
      if (response?.code !== undefined && response.code !== 0) {
        const errMsg = response.message || `API error (code=${response.code})`;
        console.log(`[bg:enable] ❌ API 顶层错误: ${errMsg}`);
        failedResults = currentItems.map(item => ({ item_id: item.item_id, model_id: item.model_id, err_msg: errMsg }));
        const progress: EnableProgress = {
          totalSkus: allItems.length, successSkus: successCount,
          failedSkus: currentItems.length, currentRound: round, maxRetries,
          nextRetryItems: failedResults, isComplete: true,
          lastResponsePreview: lastRawResponse.slice(0, 500),
        };
        await saveProgress(progress, false, errMsg);
        await sendComplete(progress, errMsg);
        return;
      }

      // 解析失败项
      const failedItemsFromResponse: EnableResult[] = Array.isArray(response?.data?.failed_items)
        ? response.data.failed_items
        : Array.isArray(response?.data) ? response.data : [];

      const failKeys = new Set(failedItemsFromResponse.map(r => `${r.item_id}-${r.model_id}`));
      const successInThisRound = currentItems.filter(i => !failKeys.has(`${i.item_id}-${i.model_id}`));
      successCount += successInThisRound.length;
      failedResults = failedItemsFromResponse;

      console.log(`[bg:enable] 本轮成功: ${successInThisRound.length}, 失败: ${failedItemsFromResponse.length}`);

      const progress: EnableProgress = {
        totalSkus: allItems.length, successSkus: successCount,
        failedSkus: failedItemsFromResponse.length, currentRound: round, maxRetries,
        nextRetryItems: failedItemsFromResponse,
        isComplete: failedItemsFromResponse.length === 0,
        lastResponsePreview: lastRawResponse.slice(0, 500),
      };

      await saveProgress(progress, failedItemsFromResponse.length > 0);
      await sendProgress(progress);

      if (failedItemsFromResponse.length === 0) {
        console.log('[bg:enable] ✅ 全部成功！');
        await saveProgress(progress, false);
        await sendComplete(progress);
        return;
      }

      // 只重试失败的
      currentItems = currentItems.filter(i => failKeys.has(`${i.item_id}-${i.model_id}`));
      console.log(`[bg:enable] 剩余 ${currentItems.length} 个需要重试`);

      // 小批量诊断
      if (currentItems.length > 0 && currentItems.length <= 10) {
        try {
          const diagItemIds = [...new Set(currentItems.map(i => String(i.item_id)))];
          const diagData = await injectedFetch<any>(
            `${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
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
      const progress: EnableProgress = {
        totalSkus: allItems.length, successSkus: successCount,
        failedSkus: currentItems.length, currentRound: round, maxRetries,
        nextRetryItems: [], isComplete: false,
        lastResponsePreview: `异常: ${e.message}`,
      };

      // 致命错误（找不到 seller 标签页）— 停止循环
      if (e.message?.includes('seller.shopee.tw 标签页')) {
        progress.isComplete = true;
        await saveProgress(progress, false, e.message);
        await sendComplete(progress, e.message);
        return;
      }

      await saveProgress(progress, true, e.message);
      await sendProgress(progress, e.message);
    }
  }

  // 循环正常结束（重试用完或被取消）
  const finalProgress: EnableProgress = {
    totalSkus: allItems.length, successSkus: successCount,
    failedSkus: failedResults.length, currentRound: round, maxRetries,
    nextRetryItems: failedResults, isComplete: true,
    lastResponsePreview: lastRawResponse.slice(0, 500),
  };
  await saveProgress(finalProgress, false);
  await sendComplete(finalProgress);
  console.log(`[bg:enable] 完成: ${round} 轮, 成功 ${successCount}, 失败 ${failedResults.length}${skippedCount > 0 ? `, 跳过 ${skippedCount}` : ''}`);
  } finally {
    _enableRunning = false;
  }
}

export default defineBackground({
  main() {
    console.log('[限时特卖助手] Background 已启动');

    browser.runtime.onInstalled.addListener((details) => {
      console.log('[限时特卖助手] 已安装/更新:', details.reason);
    });

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
          console.log('[START_ENABLE] ✅ 参数已找到，启动循环');
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
        } catch (e: any) {
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
          console.log('[bg:SCHEDULE_COPY]', { targetStartTime: params.targetStartTime, fireTime, now, delayMs });
          if (delayMs <= 0) throw new Error('目标时间已过');

          await browser.storage.local.set({ _scheduledCopy: params });
          chrome.alarms.create('scheduled_copy', { delayInMinutes: Math.ceil(delayMs / 60000) });
          console.log('[bg:SCHEDULE_COPY] ✅ 定时任务已创建');
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

      // ===== EXECUTE_COPY: 一站式复制执行 =====
      if (type === 'EXECUTE_COPY') {
        try {
          const { sourceFlashSale, targetTime, templateName, products, spcCds: cds, spcCdsVer: cdsVer, skuOverrides } = msg;
          let finalCds = cds;
          let finalVer = cdsVer || '2';
          if (!finalCds) {
            const result = await browser.storage.local.get(['spcCds', 'spcCdsVer']);
            finalCds = result.spcCds;
            finalVer = result.spcCdsVer || '2';
          }

          // 步骤 1: 检查并关闭进行中的活动
          console.log('[bg:executeCopy] 步骤1: 检查进行中的活动');
          const listData = await injectedFetch<any>(
            `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}&offset=0&limit=50&type=0`
          );
          const activeSales = (listData?.data?.flash_sale_list || []).filter((s: any) => s.status === 1);
          for (const sale of activeSales) {
            console.log(`[bg:executeCopy] 关闭活动: ${sale.flash_sale_id}`);
            await injectedFetch(
              `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
              'POST',
              { flash_sale_id: sale.flash_sale_id, time_slot_id: sale.timeslot_id, status: 2 }
            );
          }

          // 步骤 2: 获取可用时间段
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

          // 步骤 3: 创建新活动（不含商品，后续手动复制）
          console.log('[bg:executeCopy] 步骤3: 创建新活动');
          const createData = await injectedFetch<any>(
            `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
            'POST',
            { time_slot_id: bestSlot.timeslot_id }
          );
          console.log('[bg:executeCopy] 步骤3 响应:', JSON.stringify(createData).slice(0, 1000));
          const newFlashSaleId = createData?.data?.flash_sale_id;
          if (!newFlashSaleId) throw new Error('创建活动失败，响应: ' + JSON.stringify(createData).slice(0, 300));

          // 步骤 4: 复制源活动的商品配置到新活动
          const stepErrors: string[] = [];
          if (templateName && products?.length > 0) {
            // 4a: 使用模板 — 从 GraphQL 商品数据 + 模板参数计算促销价
            console.log('[bg:executeCopy] 步骤4a: 应用模板:', templateName);
            try {
              const tResult = await browser.storage.local.get('flashSaleTemplates');
              const templates = tResult.flashSaleTemplates || {};
              const template = templates[templateName];
              if (template) {
                const items = products.flatMap((p: any) =>
                  (p.modelList || []).filter((sku: any) => (sku.normalStock || 0) > 0).map((sku: any) => {
                    const key = `${p.itemid}-${sku.modelid}`;
                    const override = (skuOverrides || {})[key];
                    const usedDiscount = override?.discountRate ?? template.discountRate;
                    const usedStock = Math.min(override?.stock ?? template.flashSaleStock, sku.normalStock || template.flashSaleStock);
                    const usedPurchaseLimit = override?.purchaseLimit ?? template.purchaseLimit;
                    const promoPrice = Math.floor(Number(sku.originPrice || p.originPrice || 0) * usedDiscount / 100);
                    return {
                      item_id: Number(p.itemid), status: 1, model_id: Number(sku.modelid),
                      item_display_image: p.images?.[0] || '',
                      input_promo_price: promoPrice, stock: usedStock, purchase_limit: usedPurchaseLimit,
                    };
                  })
                );
                if (items.length > 0) {
                  const apiResult = await injectedFetch<any>(
                    `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
                    'POST',
                    { flash_sale_id: newFlashSaleId, items, use_global_category: true }
                  );
                  if (apiResult?.code !== undefined && apiResult.code !== 0) {
                    const errMsg = `模板应用API错误: ${apiResult.message || `code=${apiResult.code}`}`;
                    console.error('[bg:executeCopy] ❌', errMsg);
                    stepErrors.push(errMsg);
                  } else {
                    const failedItems = apiResult?.data?.failed_items || [];
                    if (failedItems.length > 0) {
                      const errMsg = `模板应用部分失败: ${failedItems.length} 个SKU, 示例: ${JSON.stringify(failedItems.slice(0, 2))}`;
                      console.error('[bg:executeCopy] ⚠', errMsg);
                      stepErrors.push(errMsg);
                    } else {
                      console.log('[bg:executeCopy] ✅ 模板应用成功');
                    }
                  }
                }
              }
            } catch (e: any) {
              const errMsg = `模板应用异常: ${e.message}`;
              console.error('[bg:executeCopy] ❌', errMsg);
              stepErrors.push(errMsg);
            }
          } else {
            // 4b: 无模板 — 从源活动直接获取商品配置并复制
            console.log('[bg:executeCopy] 步骤4b: 从源活动复制商品配置');
            const srcId = sourceFlashSale?.flash_sale_id;
            if (!srcId) {
              const errMsg = '源活动ID为空，无法复制商品';
              console.error('[bg:executeCopy] ❌', errMsg);
              stepErrors.push(errMsg);
            } else {
              try {
                // 获取源活动的商品完整配置
                const sourceItemsData = await injectedFetch<any>(
                  `${FLASH_SALE_API}/get_shop_flash_sale_item/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}&flash_sale_id=${srcId}&offset=0&limit=100`
                );
                console.log('[bg:executeCopy] 源活动商品数据:', JSON.stringify(sourceItemsData).slice(0, 2000));
                // 支持两种响应格式: data.items (SKU级) 或 data.item_info (商品级)
                let sourceItems = sourceItemsData?.data?.items || [];
                const itemInfo = sourceItemsData?.data?.item_info || [];
                // 如果 items 为空但 item_info 有数据, 从 item_info 构建
                if (sourceItems.length === 0 && itemInfo.length > 0) {
                  sourceItems = itemInfo.map((info: any) => ({
                    item_id: info.itemid,
                    model_id: 0, // 单规格商品
                    item_display_image: (info.images || '').split(',')[0],
                    stock: info.stock || 0,
                    purchase_limit: info.min_purchase_limit || 0,
                    price: info.price || 0,
                  }));
                }
                if (sourceItems.length > 0) {
                  // 构建价格映射: 先尝试 model_info_str, 再退回到 item_info
                  let priceMap: Record<string, Record<string, number>> = {};
                  try {
                    const raw = sourceItemsData?.data?.model_info_str;
                    if (raw) priceMap = JSON.parse(raw);
                  } catch { /* ignore parse errors */ }
                  // 后备: 从 item_info 构建商品级价格映射
                  if (Object.keys(priceMap).length === 0 && itemInfo.length > 0) {
                    for (const info of itemInfo) {
                      const itemId = String(info.itemid);
                      if (info.price > 0) {
                        priceMap[itemId] = priceMap[itemId] || {};
                        priceMap[itemId]['0'] = { price: info.price };
                      }
                    }
                  }
                  const items: EnableItem[] = sourceItems.map((si: any) => {
                    const itemId = String(si.item_id);
                    const modelId = String(si.model_id);
                    let promoPrice = priceMap[itemId]?.[modelId]?.price ?? priceMap[itemId]?.['0']?.price ?? 0;
                    if (!promoPrice) promoPrice = Number(si.price) || 0;
                    if (!promoPrice) promoPrice = 1; // 最低有效价格
                    return {
                      item_id: Number(si.item_id),
                      status: 1,
                      model_id: Number(si.model_id),
                      item_display_image: si.item_display_image || '',
                      input_promo_price: promoPrice,
                      stock: si.stock || 0,
                      purchase_limit: si.purchase_limit || 0,
                    };
                  }).filter((i: EnableItem) => i.stock > 0);
                  if (items.length > 0) {
                    console.log(`[bg:executeCopy] 复制 ${items.length} 个 SKU, 价格示例:`, items.slice(0, 3).map(i => ({ id: i.item_id, price: i.input_promo_price, stock: i.stock })));
                    const apiResult = await injectedFetch<any>(
                      `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${finalCds}&SPC_CDS_VER=${finalVer}`,
                      'POST',
                      { flash_sale_id: newFlashSaleId, items, use_global_category: true }
                    );
                    if (apiResult?.code !== undefined && apiResult.code !== 0) {
                      const errMsg = `商品复制API错误: ${apiResult.message || `code=${apiResult.code}`}`;
                      console.error('[bg:executeCopy] ❌', errMsg);
                      stepErrors.push(errMsg);
                    } else {
                      const failedItems = apiResult?.data?.failed_items || [];
                      if (failedItems.length > 0) {
                        const errMsg = `商品复制部分失败: ${failedItems.length} 个SKU`;
                        console.error('[bg:executeCopy] ⚠', errMsg);
                        stepErrors.push(errMsg);
                      } else {
                        console.log('[bg:executeCopy] ✅ 商品复制成功');
                      }
                    }
                  } else {
                    console.log('[bg:executeCopy] ⚠ 源活动没有可用的SKU');
                    stepErrors.push('源活动没有可用的SKU（库存>0）');
                  }
                } else {
                  console.log('[bg:executeCopy] ⚠ 源活动没有商品数据');
                  stepErrors.push('源活动没有商品数据');
                }
              } catch (e: any) {
                const errMsg = `商品复制异常: ${e.message}`;
                console.error('[bg:executeCopy] ❌', errMsg);
                stepErrors.push(errMsg);
              }
            }
          }

          console.log(`[bg:executeCopy] ✅ 完成: ${newFlashSaleId}`);
          // 保存到 storage 作为可靠的状态备份（popup 可通过 storage 获取结果）
          const finalStatus: CopyTaskStatus = {
            scheduled: true, executed: true, success: true,
            newFlashSaleId,
            warning: stepErrors.length > 0 ? stepErrors.join('; ') : undefined,
          };
          await browser.storage.local.set({ _copyTaskStatus: finalStatus }).catch(() => {});
          return { success: true, flashSaleId: newFlashSaleId, stepErrors: stepErrors.length > 0 ? stepErrors : undefined };
        } catch (e: any) {
          console.error('[bg:executeCopy] ❌ 失败:', e);
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
      if (alarm.name === 'scheduled_copy') {
        console.log('[bg:scheduled_copy] 定时复制任务触发');
        try {
          const result = await browser.storage.local.get('_scheduledCopy');
          const params = result._scheduledCopy as ScheduledCopyParams | undefined;
          if (!params) return;

          // 获取 SPC_CDS
          const cookieResult = await browser.storage.local.get(['spcCds', 'spcCdsVer']);
          const cds = cookieResult.spcCds || '';
          const cdsVer = cookieResult.spcCdsVer || '2';
          if (!cds) throw new Error('SPC_CDS 不存在');

          // 步骤 1: 关闭进行中的活动
          console.log('[bg:scheduled_copy] 步骤1: 关闭进行中的活动');
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

          // 步骤 2: 获取时间段并创建新活动
          console.log('[bg:scheduled_copy] 步骤2: 创建新活动');
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

          const createData = await injectedFetch<any>(
            `${FLASH_SALE_API}/set_shop_flash_sale/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}`,
            'POST',
            { time_slot_id: bestSlot.timeslot_id }
          );
          const newId = createData?.data?.flash_sale_id;
          if (!newId) throw new Error('创建活动失败');

          // 步骤 3: 复制源活动商品（无模板时）或应用模板
          if (params.templateItems?.length) {
            console.log('[bg:scheduled_copy] 步骤3: 应用模板');
            await injectedFetch(
              `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}`,
              'POST',
              { flash_sale_id: newId, items: params.templateItems, use_global_category: true }
            );
          } else {
            // 无模板：从源活动复制商品配置
            console.log('[bg:scheduled_copy] 步骤3: 从源活动复制商品');
            const sourceItemsData = await injectedFetch<any>(
              `${FLASH_SALE_API}/get_shop_flash_sale_item/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}&flash_sale_id=${params.sourceFlashSaleId}&offset=0&limit=100`
            );
            let sourceItems = sourceItemsData?.data?.items || [];
            const itemInfo = sourceItemsData?.data?.item_info || [];
            if (sourceItems.length === 0 && itemInfo.length > 0) {
              sourceItems = itemInfo.map((info: any) => ({
                item_id: info.itemid, model_id: 0,
                item_display_image: (info.images || '').split(',')[0],
                stock: info.stock || 0, purchase_limit: info.min_purchase_limit || 0,
                price: info.price || 0,
              }));
            }
            if (sourceItems.length > 0) {
              let priceMap: Record<string, Record<string, number>> = {};
              try { const raw = sourceItemsData?.data?.model_info_str; if (raw) priceMap = JSON.parse(raw); } catch {}
              if (Object.keys(priceMap).length === 0 && itemInfo.length > 0) {
                for (const info of itemInfo) {
                  const itemId = String(info.itemid);
                  if (info.price > 0) { priceMap[itemId] = priceMap[itemId] || {}; priceMap[itemId]['0'] = { price: info.price }; }
                }
              }
              const items = sourceItems
                .map((si: any) => {
                  const itemId = String(si.item_id);
                  const modelId = String(si.model_id);
                  let promoPrice = priceMap[itemId]?.[modelId]?.price ?? priceMap[itemId]?.['0']?.price ?? 0;
                  if (!promoPrice) promoPrice = Number(si.price) || 1;
                  return {
                    item_id: Number(si.item_id), status: 1, model_id: Number(si.model_id),
                    item_display_image: si.item_display_image || '',
                    input_promo_price: promoPrice, stock: si.stock || 0, purchase_limit: si.purchase_limit || 0,
                  };
                })
                .filter((i: any) => i.stock > 0);
              if (items.length > 0) {
                await injectedFetch(
                  `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${cds}&SPC_CDS_VER=${cdsVer}`,
                  'POST',
                  { flash_sale_id: newId, items, use_global_category: true }
                );
                console.log(`[bg:scheduled_copy] ✅ 复制 ${items.length} 个 SKU`);
              }
            }
          }

          await browser.storage.local.set({
            _copyTaskStatus: { scheduled: true, executed: true, success: true, newFlashSaleId: newId },
          });
          await browser.storage.local.remove('_scheduledCopy');
          console.log('[bg:scheduled_copy] ✅ 完成');
        } catch (e: any) {
          console.error('[bg:scheduled_copy] ❌ 失败:', e);
          await browser.storage.local.set({
            _copyTaskStatus: { scheduled: true, executed: true, success: false, error: e.message },
          });
        }
      }
    });
  },
});
