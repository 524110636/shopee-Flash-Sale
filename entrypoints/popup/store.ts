import { create } from 'zustand';
import type { ShopeeProduct, FlashSale, EnableItem, EnableResult, EnableProgress, SkuOverride, CacheData, FlashSaleTemplate, TemplateProductInfo, CopyTaskStatus, ScheduledCopyParams, TimeSlot } from './types';

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
  purchaseLimit: number;
  isEnabling: boolean;
  enableProgress: EnableProgress | null;
  skuOverrides: Record<string, SkuOverride>; // key: `${itemId}-${modelId}`

  // 复制功能状态
  copyMode: null | 'confirm' | 'result';
  copySource: { flashSale: FlashSale; itemCount: number | null } | null;
  copyTaskStatus: CopyTaskStatus | null;
  isCopying: boolean;
  savedTemplates: string[];
  selectedTemplate: string | null;

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
  fetchTimeSlots: () => Promise<TimeSlot[]>;
  fetchFlashSaleItemCount: (flashSaleId: number) => Promise<number>;
  setMaxRetries: (n: number) => void;
  setInfiniteRetry: (v: boolean) => void;
  setDiscountRate: (n: number) => void;
  setFlashSaleStock: (n: number) => void;
  setSkuOverride: (itemId: string, modelId: string, override: SkuOverride) => void;
  setPurchaseLimit: (n: number) => void;
  enableFlashSaleItems: () => Promise<void>;
  stopEnabling: () => void;
  checkBackgroundStatus: () => Promise<void>;
  saveTemplate: (name: string) => Promise<void>;
  deleteTemplate: (name: string) => Promise<void>;
  getTemplateNames: () => Promise<string[]>;
  getTemplate: (name: string) => Promise<FlashSaleTemplate | null>;
  applyTemplate: (template: FlashSaleTemplate) => void;
  saveCache: () => Promise<void>;
  loadCache: () => Promise<boolean>;
  clearCache: () => Promise<void>;
  reset: () => void;

  // 复制功能 Actions
  enterCopyMode: (flashSale: FlashSale) => Promise<void>;
  executeCopy: (targetTime: number, templateName: string | null) => Promise<void>;
  exitCopyMode: () => void;
  checkCopyTaskStatus: () => Promise<void>;
  setSelectedTemplate: (templateName: string | null) => void;
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

  // 复制功能初始值
  copyMode: null,
  copySource: null,
  copyTaskStatus: null,
  isCopying: false,
  savedTemplates: [],
  selectedTemplate: null,

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

  // ===== 获取可用时间段 =====
  fetchTimeSlots: async () => {
    const { spcCds, spcCdsVer } = get();
    if (!spcCds) throw new Error('SPC_CDS 不存在');

    const now = Math.floor(Date.now() / 1000);
    const startTime = now - 1800;
    const endTime = (() => {
      const d = new Date();
      const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0);
      return Math.floor(endOfMonth.getTime() / 1000) - 1;
    })();

    const data = await injectedFetch<any>(
      `${FLASH_SALE_API}/get_time_slot_id/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&start_time=${startTime}&end_time=${endTime}`
    );
    const list = Array.isArray(data?.data) ? data.data : [];
    if (list.length === 0) console.warn('[fetchTimeSlots] 接口返回空列表');
    return list as TimeSlot[];
  },

  // ===== 获取活动商品数量 =====
  fetchFlashSaleItemCount: async (flashSaleId: number) => {
    const { spcCds, spcCdsVer } = get();
    if (!spcCds) throw new Error('SPC_CDS 不存在');

    const data = await injectedFetch<any>(
      `${FLASH_SALE_API}/get_shop_flash_sale_item_id_list/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&flash_sale_id=${flashSaleId}`
    );
    const ids = data?.data?.item_ids || [];
    console.log('[fetchFlashSaleItemCount]', { flashSaleId, count: ids.length });
    return ids.length;
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
        set({ products: [], productIds: [], inputText: '', error: `该活动中没有找到商品`, isLoadingFlashSales: false });
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

  // ===== 开启限时特卖（popup 只负责启动，循环在 background 中运行）=====
  enableFlashSaleItems: async () => {
    const state = get();
    if (state.isEnabling) {
      console.log('[enable] 已在运行中，忽略重复启动');
      return;
    }
    const { products, flashSaleId, discountRate, flashSaleStock, purchaseLimit, skuOverrides, spcCds, spcCdsVer, maxRetries, infiniteRetry } = state;

    if (!flashSaleId) { set({ error: '没有限时特卖活动 ID，请先加载限时特卖' }); return; }
    if (!products.length) { set({ error: '没有商品数据' }); return; }

    // 构建所有 SKU 的提交数据（与之前相同）
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
          return {
            item_id: Number(p.itemid), status: 1, model_id: Number(sku.modelid),
            item_display_image: p.images?.[0] || '', input_promo_price: promoPrice,
            stock: usedStock, purchase_limit: usedPurchaseLimit,
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

    // 保存参数到 storage，background 会读取
    try {
      await browser.storage.local.set({
        _enableParams: {
          products, flashSaleId, spcCds, spcCdsVer, maxRetries, infiniteRetry,
          discountRate, flashSaleStock, purchaseLimit, skuOverrides,
        },
      });
    } catch (e: any) {
      set({ error: `保存启动参数失败: ${e?.message || '未知错误'}` });
      return;
    }

    // 乐观更新 UI：立即显示为"正在执行"状态
    set({ isEnabling: true, error: null, enableProgress: null });

    // 通知 background 启动循环（带重试）
    let succeeded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 500));
        const resp = await browser.runtime.sendMessage({ type: 'START_ENABLE' });
        console.log('[enable] START_ENABLE 响应:', JSON.stringify(resp));
        if (resp?.success) {
          succeeded = true;
          console.log(`[enable] 已通知 background 启动，共 ${allItems.length} 个 SKU${skippedCount > 0 ? `，${skippedCount} 个跳过` : ''}`);
          break;
        }
        console.log(`[enable] START_ENABLE 失败 (第${attempt + 1}次):`, JSON.stringify(resp));
        if (attempt === 2) set({ error: resp?.error || '后台启动失败' });
      } catch (e: any) {
        console.log(`[enable] START_ENABLE 异常 (第${attempt + 1}次):`, e?.message);
        if (attempt === 2) set({ error: `无法连接到后台: ${e?.message || '未知错误'}` });
      }
    }

    // 如果 START_ENABLE 返回失败，但循环可能已启动，主动查询状态确认
    if (!succeeded) {
      try {
        await new Promise(r => setTimeout(r, 1000));
        const status = await browser.runtime.sendMessage({ type: 'GET_ENABLE_STATUS' });
        console.log('[enable] 查询后台状态:', JSON.stringify(status));
        if (status?.data?.progress && !status.data.progress.isComplete) {
          // 循环确实在运行，清除错误提示
          set({ error: null });
        }
      } catch {}
    }
  },

  stopEnabling: async () => {
    try {
      await browser.runtime.sendMessage({ type: 'STOP_ENABLE' });
    } catch { /* background may be inactive */ }
    set({ isEnabling: false });
  },

  checkBackgroundStatus: async () => {
    try {
      const result = await browser.storage.local.get('_enableProgress');
      const data = result._enableProgress as { progress?: EnableProgress; error?: string; running?: boolean } | undefined;
      if (data?.progress && !data.progress.isComplete) {
        set({ isEnabling: true, enableProgress: data.progress, error: data.error || null });
      } else if (data?.progress && data.progress.isComplete) {
        set({ isEnabling: false, enableProgress: data.progress, error: data.error || null });
      } else {
        set({ isEnabling: false, enableProgress: null, error: null });
      }
    } catch { /* storage not accessible */ }
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
    copyMode: null, copySource: null, copyTaskStatus: null, isCopying: false, savedTemplates: [], selectedTemplate: null,
  }),

  // ===== 复制功能 =====
  enterCopyMode: async (flashSale: FlashSale) => {
    const state = get();
    set({ copyMode: 'confirm', copySource: { flashSale, itemCount: null } });
    // 获取该活动的商品数量
    try {
      const count = await state.fetchFlashSaleItemCount(flashSale.flash_sale_id);
      set({ copySource: { flashSale, itemCount: count } });
    } catch (e: any) {
      console.error('[enterCopyMode] 获取商品数量失败:', e?.message || e);
    }
    // 加载该活动的商品数据（供模板复制使用）
    try {
      await state.loadFlashSaleProducts(flashSale.flash_sale_id);
    } catch (e: any) {
      console.error('[enterCopyMode] 加载商品数据失败:', e?.message || e);
    }
    // 加载模板列表
    const names = await state.getTemplateNames();
    set({ savedTemplates: names, selectedTemplate: names.length > 0 ? names[0] : null });
  },

  executeCopy: async (targetTime: number, templateName: string | null) => {
    const state = get();
    if (!state.copySource) return;
    set({ isCopying: true, error: null });

    // 清除旧的 storage 状态
    try { await browser.storage.local.remove('_copyTaskStatus'); } catch {}

    // 辅助函数：发消息后用 storage.onChanged 监听结果（代替不可靠的 sendMessage 返回值）
    const waitForStorage = (message: any, timeoutMs = 60000): Promise<CopyTaskStatus | null> => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          browser.storage.onChanged.removeListener(onChange);
          resolve(null);
        }, timeoutMs);

        const onChange = (changes: any, area: string) => {
          if (area === 'local' && changes._copyTaskStatus?.newValue) {
            browser.storage.onChanged.removeListener(onChange);
            clearTimeout(timer);
            resolve(changes._copyTaskStatus.newValue as CopyTaskStatus);
          }
        };
        browser.storage.onChanged.addListener(onChange);

        // 发消息（fire-and-forget，不依赖返回值）
        browser.runtime.sendMessage(message).catch(() => {});

        // 也立即检查一次（防止时序问题）
        browser.storage.local.get('_copyTaskStatus').then((r) => {
          const st = r._copyTaskStatus as CopyTaskStatus | undefined;
          if (st) {
            browser.storage.onChanged.removeListener(onChange);
            clearTimeout(timer);
            resolve(st);
          }
        }).catch(() => {});
      });
    };

    try {
      const fireTime = targetTime - 300;
      const now = Math.floor(Date.now() / 1000);

      if (fireTime <= now) {
        // === 立即执行路径 ===
        console.log('[executeCopy] 立即执行, targetTime:', targetTime, 'template:', templateName);
        const status = await waitForStorage({
          type: 'EXECUTE_COPY',
          sourceFlashSale: state.copySource.flashSale,
          targetTime,
          templateName,
          products: state.products,
          spcCds: state.spcCds,
          spcCdsVer: state.spcCdsVer,
          skuOverrides: state.skuOverrides,
        });

        if (status) {
          console.log('[executeCopy] EXECUTE_COPY storage 状态:', JSON.stringify(status));
          set({ copyMode: 'result', isCopying: false, copyTaskStatus: status });
        } else {
          console.error('[executeCopy] EXECUTE_COPY 无响应');
          set({
            copyMode: 'result', isCopying: false,
            copyTaskStatus: { scheduled: true, executed: true, success: false, error: '后台无响应' },
          });
        }
      } else {
        // === 定时执行路径 ===
        let templateItems: EnableItem[] | null = null;
        if (templateName) {
          const template = await state.getTemplate(templateName);
          if (template) {
            templateItems = state.products.flatMap((p: ShopeeProduct) =>
              (p.modelList || []).filter(sku => (sku.normalStock || 0) > 0).map(sku => {
                const key = `${p.itemid}-${sku.modelid}`;
                const override = state.skuOverrides[key];
                const usedDiscount = override?.discountRate ?? template.discountRate;
                const usedStock = Math.min(override?.stock ?? template.flashSaleStock, sku.normalStock || template.flashSaleStock);
                const usedPurchaseLimit = override?.purchaseLimit ?? template.purchaseLimit;
                const promoPrice = Math.floor(Number(sku.originPrice || p.originPrice || 0) * usedDiscount / 100);
                return {
                  item_id: Number(p.itemid), status: 1, model_id: Number(sku.modelid),
                  item_display_image: p.images?.[0] || '',
                  input_promo_price: promoPrice, stock: usedStock, purchase_limit: usedPurchaseLimit,
                };
              }),
            );
          }
        }

        const params: ScheduledCopyParams = {
          sourceFlashSaleId: state.copySource.flashSale.flash_sale_id,
          sourceFlashSaleName: state.copySource.flashSale.name || '',
          targetStartTime: targetTime,
          templateName,
          templateItems,
        };

        console.log('[executeCopy] 定时执行, targetTime:', targetTime, 'template:', templateName);
        const status = await waitForStorage({ type: 'SCHEDULE_COPY', params });

        if (status) {
          console.log('[executeCopy] SCHEDULE_COPY storage 状态:', JSON.stringify(status));
          set({ copyMode: 'result', isCopying: false, copyTaskStatus: status });
        } else {
          console.error('[executeCopy] SCHEDULE_COPY 无响应');
          set({
            copyMode: 'result', isCopying: false,
            copyTaskStatus: { scheduled: true, executed: true, success: false, error: '后台无响应' },
          });
        }
      }
    } catch (e: any) {
      console.error('[executeCopy] 异常:', e);
      set({
        copyMode: 'result',
        isCopying: false,
        copyTaskStatus: {
          scheduled: true, executed: true, success: false,
          error: e.message,
        },
      });
    }
    // 刷新活动列表
    get().fetchFlashSaleList();
    get().saveCache();
  },

  exitCopyMode: () => {
    set({
      copyMode: null,
      copySource: null,
      copyTaskStatus: null,
      isCopying: false,
      selectedTemplate: null,
    });
    browser.storage.local.remove('_copyTaskStatus');
  },

  checkCopyTaskStatus: async () => {
    try {
      const result = await browser.storage.local.get('_copyTaskStatus');
      const status = result._copyTaskStatus as CopyTaskStatus | undefined;
      if (status && status.executed) {
        set({ copyMode: 'result', copyTaskStatus: status });
      }
    } catch {}
  },

  setSelectedTemplate: (templateName: string | null) => {
    set({ selectedTemplate: templateName });
  },
}));

// ===== Background 消息监听（接收进度更新）=====
export function setupBackgroundListener() {
  browser.runtime.onMessage.addListener((msg: any) => {
    const type = msg?.type;

    if (type === 'ENABLE_PROGRESS') {
      console.log('[store] 收到进度更新:', msg.progress);
      useAppStore.setState({
        enableProgress: msg.progress,
        error: msg.error || null,
      });
    }

    if (type === 'ENABLE_COMPLETE') {
      console.log('[store] 收到完成通知:', msg.progress);
      useAppStore.setState({
        isEnabling: false,
        enableProgress: msg.progress,
        error: msg.error || null,
      });
      const state = useAppStore.getState();
      state.saveCache();
    }

    return false;
  });
}
