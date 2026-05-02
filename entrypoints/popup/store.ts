import { create } from 'zustand';
import type { ShopeeProduct, FlashSale, EnableItem, EnableResult, EnableProgress, SkuOverride, CacheData, FlashSaleTemplate, TemplateProductInfo } from './types';

// ===== 注入页面执行 fetch（MAIN world）=====
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)),
  ]);
}

async function injectedFetch<T>(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  body?: object,
): Promise<T> {
  console.log('[injectedFetch] 开始', { url, method, hasBody: !!body });
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  console.log('[injectedFetch] 活跃标签页:', { tabId: tab?.id, url: tab?.url });
  if (!tab?.id) throw new Error('没有找到活跃的标签页');
  if (!tab.url?.includes('seller.shopee.tw')) throw new Error('请在 seller.shopee.tw 页面使用此扩展');

  // 尝试从页面获取 sc-fe-session（虾皮 API 需要的 CSRF 令牌）
  console.log('[injectedFetch] 开始获取 sc-fe-session...');
  const sessionInfo = await withTimeout(browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      try {
        // 尝试从多处获取 sc-fe-session
        const fromWindow = (window as any).__INITIAL_STATE__?.session?.sc_fe_session;
        const fromMeta = document.querySelector('meta[name="sc-fe-session"]')?.getAttribute('content');
        const cookies = document.cookie.split('; ').reduce((acc, c) => {
          const [k, ...v] = c.split('=');
          acc[k] = v.join('=');
          return acc;
        }, {} as Record<string, string>);
        const fromCookie = cookies['sc_fe_session'] || cookies['sc-fe-session'] || '';
        // 直接尝试从 window 上找
        const fromWindow2 = (window as any)['sc-fe-session'] || (window as any).sc_fe_session || '';
        // 找页面中可能包含 sc-fe-session 的 script 标签
        let fromScript = '';
        const scripts = document.querySelectorAll('script');
        for (let i = 0; i < Math.min(scripts.length, 5); i++) {
          const text = scripts[i].textContent || '';
          const m = text.match(/["']sc-fe-session["']\s*:\s*["']([^"']+)["']/);
          if (m) { fromScript = m[1]; break; }
        }
        const result = fromWindow || fromMeta || fromCookie || fromWindow2 || fromScript || '';
        console.log('[sc-fe-session 检测]', { fromWindow, fromMeta, fromCookie, fromWindow2, fromScript, result, cookieKeys: Object.keys(cookies) });
        return result;
      } catch (e: any) {
        console.log('[sc-fe-session 检测异常]', e.message);
        return '';
      }
    },
  }), 10000, 'sc-fe-session 获取');
  const scFeSession = (sessionInfo?.[0]?.result as string) || '';
  console.log('[injectedFetch] sc-fe-session 最终值:', scFeSession || '(空)');

  console.log('[injectedFetch] 开始执行 API 请求脚本...');
  const results = await withTimeout(browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (fetchUrl: string, fetchMethod: string, fetchBody: string | null, scFeSession: string) => {
      try {
        const headers: Record<string, string> = {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json;charset=UTF-8',
        };
        if (scFeSession) headers['sc-fe-session'] = scFeSession;
        const opts: RequestInit = {
          method: fetchMethod,
          credentials: 'include',
          headers,
        };
        if (fetchBody) opts.body = fetchBody;
        console.log('[injectedFetch] 页面内 fetch 开始', { url: fetchUrl, method: fetchMethod });
        const resp = await fetch(fetchUrl, opts);
        const bodyText = await resp.text();
        console.log('[injectedFetch] 页面内 fetch 完成', { status: resp.status, bodyLength: bodyText.length });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText || bodyText.slice(0, 200)}`);
        return JSON.parse(bodyText);
      } catch (e: any) {
        console.log('[injectedFetch] 页面内 fetch 异常:', e.message);
        return { _error: e.message } as any;
      }
    },
    args: [url, method, body ? JSON.stringify(body) : null, scFeSession],
  }), 30000, 'API 请求');

  console.log('[injectedFetch] 脚本执行结果:', results);
  const result = results?.[0]?.result as any;
  if (!result) throw new Error('页面脚本执行返回为空，请刷新页面后重试');
  if (result._error) throw new Error(`API 请求失败: ${result._error}`);
  console.log('[injectedFetch] 成功返回数据');
  return result as T;
}

const FLASH_SALE_API = 'https://seller.shopee.tw/api/marketing/v4/shop_flash_sale';

const STORAGE_TEMPLATES_KEY = 'flashSaleTemplates';

// ===== GraphQL 查询常量 =====
const GRAPHQL_URL = 'https://seller.shopee.tw/api/marketing/v4/graphql/query/';
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

interface AppState {
  // SPC_CDS 状态
  spcCds: string;
  spcCdsVer: string;
  isConnected: boolean;
  isExtracting: boolean;

  // 商品列表状态
  productIds: string[];
  products: ShopeeProduct[];
  isLoading: boolean;
  error: string | null;

  // 输入状态
  inputText: string;

  // 限时特卖加载状态
  isLoadingFlashSales: boolean;
  flashSaleInfo: string;
  flashSaleId: number | null;
  flashSaleList: FlashSale[];
  isLoadingFlashSaleList: boolean;

  // 开启限时特卖状态
  maxRetries: number;
  infiniteRetry: boolean;
  discountRate: number;
  flashSaleStock: number;
  isEnabling: boolean;
  enableProgress: EnableProgress | null;
  skuOverrides: Record<string, SkuOverride>; // key: `${itemId}-${modelId}`

  // Actions
  setSpcCds: (spcCds: string, spcCdsVer: string) => void;
  setConnected: (connected: boolean) => void;
  setExtracting: (extracting: boolean) => void;
  setInputText: (text: string) => void;
  setProductIds: (ids: string[]) => void;
  setProducts: (products: ShopeeProduct[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  extractSpcCds: () => Promise<void>;
  fetchProducts: () => Promise<void>;
  fetchFlashSaleProducts: () => Promise<void>;
  setMaxRetries: (n: number) => void;
  setInfiniteRetry: (v: boolean) => void;
  setDiscountRate: (n: number) => void;
  setFlashSaleStock: (n: number) => void;
  setSkuOverride: (itemId: string, modelId: string, override: SkuOverride) => void;
  setPurchaseLimit: (n: number) => void;
  enableFlashSaleItems: () => Promise<void>;
  stopEnabling: () => void;
  saveTemplate: (name: string) => Promise<void>;
  deleteTemplate: (name: string) => Promise<void>;
  getTemplateNames: () => Promise<string[]>;
  getTemplate: (name: string) => Promise<FlashSaleTemplate | null>;
  applyTemplate: (template: FlashSaleTemplate) => void;
  saveCache: () => Promise<void>;
  loadCache: () => Promise<boolean>;
  clearCache: () => Promise<void>;
  reset: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  spcCds: '',
  spcCdsVer: '2',
  isConnected: false,
  isExtracting: false,
  productIds: [],
  products: [],
  isLoading: false,
  error: null,
  inputText: '',
  isLoadingFlashSales: false,
  flashSaleInfo: '',
  flashSaleId: null,
  flashSaleList: [],
  isLoadingFlashSaleList: false,
  maxRetries: 10,
  infiniteRetry: false,
  discountRate: 60,
  flashSaleStock: 200,
  purchaseLimit: 5,
  isEnabling: false,
  enableProgress: null,
  skuOverrides: {},

  setSpcCds: (spcCds, spcCdsVer) => set({ spcCds, spcCdsVer }),
  setConnected: (isConnected) => set({ isConnected }),
  setExtracting: (isExtracting) => set({ isExtracting }),
  setInputText: (inputText) => set({ inputText }),
  setProductIds: (productIds) => set({ productIds }),
  setProducts: (products) => set({ products }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setMaxRetries: (maxRetries) => set({ maxRetries }),
  setInfiniteRetry: (infiniteRetry) => set({ infiniteRetry }),
  setDiscountRate: (discountRate) => set({ discountRate }),
  setFlashSaleStock: (flashSaleStock) => set({ flashSaleStock }),
  setSkuOverride: (itemId, modelId, override) => set(state => {
    const key = `${itemId}-${modelId}`;
    const next = { ...state.skuOverrides };
    if (override.discountRate === undefined && override.stock === undefined && override.purchaseLimit === undefined) {
      delete next[key];
    } else {
      next[key] = override;
    }
    return { skuOverrides: next };
  }),
  setPurchaseLimit: (purchaseLimit) => set({ purchaseLimit }),

  // ===== 缓存持久化 =====
  saveCache: async () => {
    const { products, flashSaleList, flashSaleId, flashSaleInfo, enableProgress, skuOverrides, discountRate, flashSaleStock, purchaseLimit, maxRetries, infiniteRetry } = get();
    const cache: CacheData = {
      timestamp: Date.now(),
      products, flashSaleList, flashSaleId, flashSaleInfo, enableProgress, skuOverrides,
      discountRate, flashSaleStock, purchaseLimit, maxRetries, infiniteRetry,
    };
    try { await browser.storage.local.set({ flashSaleCache: cache }); } catch {}
  },
  loadCache: async () => {
    try {
      const result = await browser.storage.local.get('flashSaleCache');
      const cache = result.flashSaleCache as CacheData | undefined;
      if (!cache) return false;
      if (Date.now() - cache.timestamp > 30 * 60 * 1000) {
        await browser.storage.local.remove('flashSaleCache');
        return false;
      }
      set({
        products: cache.products || [],
        flashSaleList: cache.flashSaleList || [],
        flashSaleId: cache.flashSaleId ?? null,
        flashSaleInfo: cache.flashSaleInfo || '',
        enableProgress: cache.enableProgress || null,
        skuOverrides: cache.skuOverrides || {},
        discountRate: cache.discountRate ?? 60,
        flashSaleStock: cache.flashSaleStock ?? 200,
        purchaseLimit: cache.purchaseLimit ?? 5,
        maxRetries: cache.maxRetries ?? 10,
        infiniteRetry: cache.infiniteRetry ?? false,
        isConnected: true,
        inputText: (cache.products?.[0] ? cache.products.map(p => p.itemid).join('\n') : ''),
        productIds: cache.products?.map(p => p.itemid) || [],
      });
      return true;
    } catch { return false; }
  },
  clearCache: async () => {
    try {
      await browser.storage.local.remove('flashSaleCache');
    } catch {}
  },

  extractSpcCds: async () => {
    console.log('[extractSpcCds] 开始获取 SPC_CDS...');
    set({ isExtracting: true, error: null });
    try {
      const urls = ['https://seller.shopee.tw', 'https://shopee.tw', 'https://www.shopee.tw'];
      let spcCds = '';
      let spcCdsVer = '2';

      for (const url of urls) {
        try {
          const cookie = await browser.cookies.get({ url, name: 'SPC_CDS' });
          if (cookie?.value) {
            const verCookie = await browser.cookies.get({ url, name: 'SPC_CDS_VER' });
            spcCds = cookie.value;
            spcCdsVer = verCookie?.value || '2';
            console.log('[extractSpcCds] 从', url, '获取到 SPC_CDS');
            break;
          }
        } catch { /* next */ }
      }

      if (!spcCds) {
        console.log('[extractSpcCds] 尝试 cookies.getAll 回退...');
        const allCookies = await browser.cookies.getAll({ domain: '.shopee.tw' });
        const spc = allCookies.find(c => c.name === 'SPC_CDS');
        const ver = allCookies.find(c => c.name === 'SPC_CDS_VER');
        if (spc?.value) {
          spcCds = spc.value;
          spcCdsVer = ver?.value || '2';
          console.log('[extractSpcCds] 通过 getAll 获取到 SPC_CDS');
        }
      }

      if (spcCds) {
        console.log('[extractSpcCds] 成功, isConnected = true');
        set({ spcCds, spcCdsVer, isConnected: true, isExtracting: false, error: null });
      } else {
        console.log('[extractSpcCds] 未找到 SPC_CDS');
        set({
          error: 'SPC_CDS 不存在，请确认：\n1. 已登录虾皮卖家中心 (seller.shopee.tw)\n2. 刷新页面后再试',
          isExtracting: false, isConnected: false,
        });
      }
    } catch (e: any) {
      console.log('[extractSpcCds] 异常:', e);
      set({
        error: `读取 Cookie 失败: ${e?.message || '未知错误'}`,
        isExtracting: false, isConnected: false,
      });
    }
  },

  fetchProducts: async () => {
    const { productIds, spcCds, spcCdsVer } = get();
    if (!spcCds) { set({ error: '请先获取 SPC_CDS' }); return; }
    if (productIds.length === 0) { set({ error: '请先在输入框中粘贴商品 ID' }); return; }
    if (productIds.length > 50) { set({ error: `单次最多查询 50 个商品` }); return; }

    set({ isLoading: true, error: null });

    try {
      const data = await injectedFetch<{ data?: { products?: { items?: ShopeeProduct[] } } }>(
        `${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
        'POST',
        { query: PRODUCTS_QUERY, variables: { productIds, statusType: 0 } },
      );

      const items = data?.data?.products?.items;
      if (!items?.length) {
        set({ error: '未找到匹配的商品', isLoading: false });
        return;
      }

      set({ products: items, isLoading: false, error: null });
      get().saveCache();
    } catch (e: any) {
      set({ error: `请求失败: ${e?.message || String(e)}`, isLoading: false });
    }
  },

  // ===== 获取限时特卖活动列表 =====
  fetchFlashSaleList: async () => {
    const { spcCds, spcCdsVer } = get();
    console.log('[fetchFlashSaleList] 开始', { spcCds: !!spcCds, spcCdsVer });
    if (!spcCds) { set({ error: '请先获取 SPC_CDS' }); return; }

    set({ isLoadingFlashSaleList: true, error: null, flashSaleList: [] });

    try {
      const url = `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&offset=0&limit=50&type=0`;
      console.log('[fetchFlashSaleList] 请求 URL:', url);
      const listResp = await injectedFetch<{ code: number; data?: { flash_sale_list?: FlashSale[] } }>(url);
      console.log('[fetchFlashSaleList] 响应:', JSON.stringify(listResp).slice(0, 500));

      if (listResp.code !== 0 || !listResp.data?.flash_sale_list?.length) {
        console.log('[fetchFlashSaleList] 无数据', { code: listResp.code, data: listResp.data });
        set({ error: `未找到限时特卖活动 (code=${listResp.code})`, isLoadingFlashSaleList: false });
        return;
      }

      set({ flashSaleList: listResp.data.flash_sale_list, isLoadingFlashSaleList: false });
      get().saveCache();
      console.log('[fetchFlashSaleList] 成功, 共', listResp.data.flash_sale_list.length, '个活动');
    } catch (e: any) {
      console.log('[fetchFlashSaleList] 异常:', e);
      set({
        error: `获取限时特卖列表失败: ${e?.message || '未知错误'}`,
        isLoadingFlashSaleList: false,
      });
    }
  },

  // ===== 加载指定限时特卖活动的商品 =====
  loadFlashSaleProducts: async (flashSaleId: number) => {
    const { spcCds, spcCdsVer, flashSaleList } = get();
    if (!spcCds) { set({ error: '请先获取 SPC_CDS', isLoadingFlashSales: false }); return; }

    set({ isLoadingFlashSales: true, error: null, flashSaleInfo: '' });

    try {
      const sale = flashSaleList.find(s => s.flash_sale_id === flashSaleId);
      const now = Math.floor(Date.now() / 1000);
      const timeStatus = sale
        ? (sale.start_time > now ? '即将开始' : (now >= sale.end_time ? '已结束' : '进行中'))
        : '';

      const itemResp = await injectedFetch<{ code: number; data?: { item_ids: number[] } }>(
        `${FLASH_SALE_API}/get_shop_flash_sale_item_id_list/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&flash_sale_id=${flashSaleId}`,
      );

      if (itemResp.code !== 0 || !itemResp.data?.item_ids?.length) {
        set({ error: `该活动中没有找到商品`, isLoadingFlashSales: false });
        return;
      }

      const ids = itemResp.data.item_ids.map(id => String(id));
      const label = sale?.name || `活动 #${flashSaleId}`;
      set({
        productIds: ids, inputText: ids.join('\n'),
        flashSaleId,
        isLoadingFlashSales: false,
        flashSaleInfo: `📦 ${label} [${timeStatus}] — ${ids.length} 个商品`,
      });

      get().fetchProducts();
    } catch (e: any) {
      set({
        error: `加载限时特卖商品失败: ${e?.message || '未知错误'}`,
        isLoadingFlashSales: false,
      });
    }
  },

  // ===== 开启限时特卖（带自动重试）=====
  enableFlashSaleItems: async () => {
    const { products, flashSaleId, spcCds, spcCdsVer, maxRetries, infiniteRetry, discountRate, flashSaleStock, purchaseLimit, skuOverrides } = get();

    if (!flashSaleId) { set({ error: '没有限时特卖活动 ID，请先加载限时特卖' }); return; }
    if (!products.length) { set({ error: '没有商品数据' }); return; }

    // 构建所有 SKU 的提交数据（跳过库存为 0 的 SKU，使用单个覆盖参数）
    console.log('[enable] skuOverrides 全部:', JSON.stringify(skuOverrides));
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
            console.log(`[enable] SKU ${key}: override=${JSON.stringify(override)}, usedDiscount=${usedDiscount}, usedStock=${usedStock}, usedPurchaseLimit=${usedPurchaseLimit}, promoPrice=${promoPrice}`);
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
      set({ error: `没有找到可提交的 SKU${skippedCount > 0 ? `（${skippedCount} 个 SKU 因库存为 0 已跳过）` : ''}` });
      return;
    }

    console.log(`[enable] 开始提交 ${allItems.length} 个 SKU${skippedCount > 0 ? `（${skippedCount} 个 SKU 因库存为 0 已跳过）` : ''}, 最多重试 ${maxRetries} 次`);
    console.log("[enable] 首个 SKU 示例:", JSON.stringify(allItems[0]));
    console.log("[enable] 请求体样本:", JSON.stringify({ flash_sale_id: flashSaleId, items: allItems.slice(0, 3), totalItems: allItems.length }));
    set({ isEnabling: true, error: null, enableProgress: null });

    let currentItems = [...allItems];
    let successCount = 0;
    let failedResults: EnableResult[] = [];
    let lastRawResponse: string = '';
    let round = 0;

    for (round = 1; ; round++) {
      if (!infiniteRetry && round > maxRetries) break;
      // 用户取消检测
      if (!get().isEnabling) {
        console.log('[enable] ⏹ 用户取消');
        break;
      }
      try {
        console.log(`[enable] === 第 ${round} 轮提交开始 ===`);
        console.log(`[enable] 提交 ${currentItems.length} 个 SKU`);

        const response = await injectedFetch<any>(
          `${FLASH_SALE_API}/set_shop_flash_sale_items/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
          'POST',
          {
            flash_sale_id: flashSaleId,
            items: currentItems,
            use_global_category: true,
          },
        );

        // 记录原始响应
        lastRawResponse = JSON.stringify(response).slice(0, 2000);
        console.log('[enable] 原始响应:', JSON.stringify(response, null, 2).slice(0, 3000));

        // 检查顶层 API 错误（非 0 表示整批失败）
        if (response?.code !== undefined && response.code !== 0) {
          const errMsg = response.message || `API error (code=${response.code})`;
          console.log(`[enable] ❌ API 顶层错误: ${errMsg}`);
          failedResults = currentItems.map(item => ({
            item_id: item.item_id,
            model_id: item.model_id,
            err_msg: errMsg,
          }));

          set({
            error: `API 返回错误 (code=${response.code}): ${errMsg}${response.code === 1001 ? '\n可能原因：SPC_CDS 失效、请求参数错误、或需要刷新页面' : ''}`,
            enableProgress: {
              totalSkus: allItems.length,
              successSkus: successCount,
              failedSkus: currentItems.length,
              currentRound: round,
              maxRetries,
              nextRetryItems: failedResults,
              isComplete: true,
              lastResponsePreview: lastRawResponse.slice(0, 500),
            },
          });
          break; // 顶层错误不需要重试
        }

        // 从 response.data.failed_items 读取失败列表
        // 成功项不会出现在返回中，不在 failed_items 里的就是成功
        const failedItemsFromResponse: EnableResult[] = Array.isArray(response?.data?.failed_items)
          ? response.data.failed_items
          : Array.isArray(response?.data)
            ? response.data  // 兼容旧格式（直接数组）
            : [];

        console.log(`[enable] 返回 ${failedItemsFromResponse.length} 个失败项`);

        // 记录每条失败信息及 unqualified_conditions
        failedItemsFromResponse.forEach((r, i) => {
          const uq = r.unqualified_conditions?.length
            ? r.unqualified_conditions.map(u => `[code=${u.unqualified_code} params=${u.params.join(',')} value=${u.value}]`).join(' ')
            : '';
          console.log(`[enable] 失败[${i}]: item=${r.item_id}, model=${r.model_id}, err=${r.err_msg?.slice(0, 80)}${uq ? ` unqualified: ${uq}` : ''}`);
        });

        // 已提交但不在 failed_items 里的 = 成功
        const failKeys = new Set(failedItemsFromResponse.map(r => `${r.item_id}-${r.model_id}`));
        const successInThisRound = currentItems.filter(
          i => !failKeys.has(`${i.item_id}-${i.model_id}`)
        );
        successCount += successInThisRound.length;
        failedResults = failedItemsFromResponse;

        console.log(`[enable] 本轮成功: ${successInThisRound.length}, 失败: ${failedItemsFromResponse.length}`);

        const progress: EnableProgress = {
          totalSkus: allItems.length,
          successSkus: successCount,
          failedSkus: failedItemsFromResponse.length,
          currentRound: round,
          maxRetries,
          nextRetryItems: failedItemsFromResponse,
          isComplete: failedItemsFromResponse.length === 0,
          lastResponsePreview: lastRawResponse.slice(0, 500),
        };

        set({ enableProgress: progress });
        get().saveCache();

        if (failedItemsFromResponse.length === 0) {
          console.log('[enable] ✅ 全部成功！');
          break;
        }

        // 只重试失败的
        currentItems = currentItems.filter(i => failKeys.has(`${i.item_id}-${i.model_id}`));
        console.log(`[enable] 第 ${round} 轮结束, 剩余 ${currentItems.length} 个需要重试`);

        // 诊断：查询剩余商品的当前状态
        if (currentItems.length > 0 && currentItems.length <= 10) {
          try {
            const diagItemIds = [...new Set(currentItems.map(i => String(i.item_id)))];
            console.log(`[enable] 🔍 诊断查询 ${diagItemIds.length} 个商品的当前状态`);
            const diagData = await injectedFetch<any>(
              `${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`,
              'POST',
              { query: PRODUCTS_QUERY, variables: { productIds: diagItemIds, statusType: 0 } },
            );
            const liveItems = diagData?.data?.products?.items || [];
            // 构建失败 SKU 的查询 map
            const failSkuMap = new Map(currentItems.map(i => [`${i.item_id}-${i.model_id}`, i]));
            for (const item of liveItems) {
              const orig = products.find(p => p.itemid === item.itemid);
              for (const sku of item.modelList || []) {
                const key = `${item.itemid}-${sku.modelid}`;
                // 显示失败 SKU 的具体库存数据
                if (failSkuMap.has(key)) {
                  const req = failSkuMap.get(key)!;
                  console.log(`[enable] 🔍 失败 SKU ${sku.modelid}: 当前库存=${sku.normalStock}, 请求活动库存=${req.stock}, 原价=${sku.originPrice}`);
                }
                // 记录其他 SKU 的变化（作为上下文参考）
                const origSku = orig?.modelList?.find(m => m.modelid === sku.modelid);
                if (origSku && (Number(sku.originPrice) !== Number(origSku.originPrice) || sku.normalStock !== origSku.normalStock)) {
                  console.log(`[enable] ⚠ SKU ${sku.modelid} 数据变化: 价格 ${origSku.originPrice}→${sku.originPrice}, 库存 ${origSku.normalStock}→${sku.normalStock}`);
                }
              }
            }
            if (liveItems.length > 0) console.log('[enable] ✅ 诊断完成');
          } catch (diagErr: any) {
            console.log('[enable] 诊断查询失败:', diagErr.message);
          }
        }

        // 自适应库存：对 NOT_ENOUGH_STOCK 的 SKU 逐步降低活动库存
        const hasStockErrors = failedItemsFromResponse.some(r => r.err_msg?.includes('NOT_ENOUGH_STOCK'));
        if (hasStockErrors && currentItems.length > 0) {
          const stockErrorKeys = new Set(
            failedItemsFromResponse
              .filter(r => r.err_msg?.includes('NOT_ENOUGH_STOCK'))
              .map(r => `${r.item_id}-${r.model_id}`)
          );
          currentItems = currentItems.map(item => {
            const key = `${item.item_id}-${item.model_id}`;
            if (stockErrorKeys.has(key)) {
              const newStock = Math.max(1, Math.floor(item.stock / 2));
              console.log(`[enable] 📉 库存不足，降低 SKU ${item.model_id} 活动库存: ${item.stock}→${newStock}`);
              return { ...item, stock: newStock };
            }
            return item;
          });
        }
      } catch (e: any) {
        console.log(`[enable] 第 ${round} 轮异常:`, e.message);
        const progress: EnableProgress = {
          totalSkus: allItems.length,
          successSkus: successCount,
          failedSkus: currentItems.length,
          currentRound: round,
          maxRetries,
          nextRetryItems: [],
          isComplete: false,
          lastResponsePreview: `异常: ${e.message}`,
        };
        set({ error: `第 ${round} 轮请求异常: ${e.message}`, enableProgress: progress });
      }
    }

    console.log(`[enable] 完成: 共 ${round} 轮, 成功 ${successCount}, 失败 ${failedResults.length}${skippedCount > 0 ? `, 跳过 ${skippedCount}（库存为 0）` : ''}`);
    set({ isEnabling: false });
  },

  stopEnabling: () => {
    set({ isEnabling: false });
  },

  // ===== 模板 =====
  getTemplateNames: async () => {
    try {
      const result = await browser.storage.local.get('flashSaleTemplates');
      const templates: Record<string, FlashSaleTemplate> = result.flashSaleTemplates || {};
      return Object.keys(templates).sort();
    } catch {
      return [];
    }
  },

  getTemplate: async (name: string) => {
    try {
      const result = await browser.storage.local.get('flashSaleTemplates');
      const templates: Record<string, FlashSaleTemplate> = result.flashSaleTemplates || {};
      return templates[name] || null;
    } catch {
      return null;
    }
  },

  saveTemplate: async (name: string) => {
    const { products, skuOverrides, discountRate, flashSaleStock, purchaseLimit } = get();
    try {
      const result = await browser.storage.local.get('flashSaleTemplates');
      const templates: Record<string, FlashSaleTemplate> = result.flashSaleTemplates || {};
      const existing = templates[name];
      const productInfo: TemplateProductInfo[] = products.map(p => ({
        itemId: p.itemid,
        name: p.name,
      }));
      const template: FlashSaleTemplate = {
        name,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        discountRate,
        flashSaleStock,
        purchaseLimit,
        skuOverrides: { ...skuOverrides },
        productInfo,
      };
      templates[name] = template;
      await browser.storage.local.set({ flashSaleTemplates: templates });
    } catch (e) {
      console.error('[saveTemplate] 保存失败:', e);
      throw e;
    }
  },

  deleteTemplate: async (name: string) => {
    try {
      const result = await browser.storage.local.get('flashSaleTemplates');
      const templates: Record<string, FlashSaleTemplate> = result.flashSaleTemplates || {};
      delete templates[name];
      await browser.storage.local.set({ flashSaleTemplates: templates });
    } catch (e) {
      console.error('[deleteTemplate] 删除失败:', e);
      throw e;
    }
  },

  applyTemplate: (template: FlashSaleTemplate) => {
    const currentProductIds = new Set(get().products.map(p => p.itemid));
    // 只保留模板中当前仍然存在的商品的覆盖参数
    const filteredOverrides: Record<string, SkuOverride> = {};
    for (const [key, override] of Object.entries(template.skuOverrides)) {
      const itemId = key.split('-')[0];
      if (currentProductIds.has(itemId)) {
        filteredOverrides[key] = override;
      }
    }
    set({
      discountRate: template.discountRate,
      flashSaleStock: template.flashSaleStock,
      purchaseLimit: template.purchaseLimit,
      skuOverrides: filteredOverrides,
    });
    get().saveCache();
  },

  // ===== 重置 =====
  reset: () => set({
    spcCds: '', spcCdsVer: '2', isConnected: false,
    productIds: [], products: [], isLoading: false, error: null, inputText: '',
    isLoadingFlashSales: false, flashSaleInfo: '', flashSaleId: null,
    flashSaleList: [], isLoadingFlashSaleList: false,
    maxRetries: 10, discountRate: 60, flashSaleStock: 200, purchaseLimit: 5, isEnabling: false, enableProgress: null, skuOverrides: {},
  }),
}));
