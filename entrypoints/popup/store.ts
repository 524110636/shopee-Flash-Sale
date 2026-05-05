import { create } from 'zustand';
import type { ShopeeProduct, FlashSale, EnableItem, EnableResult, EnableProgress, SkuOverride, CacheData, FlashSaleTemplate, TemplateProductInfo, CopyTaskStatus, ScheduledCopyParams, CopiedSaleData, TimeSlot, ScheduledTaskStatus, AutoModeConfig, AutoModeStatus, AutoModeLog } from './types';

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

  console.log('[injectedFetch] 开始执行 API 请求脚本...');
  const results = await withTimeout(browser.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async (fetchUrl: string, fetchMethod: string, fetchBody: string | null) => {
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
    args: [url, method, body ? JSON.stringify(body) : null],
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
  hasScheduledCopy: boolean;
  scheduledTaskStatus: ScheduledTaskStatus | null;

  // 自动模式状态
  autoModeActive: boolean;
  autoModeStatus: AutoModeStatus | null;
  autoModeLogs: AutoModeLog[];
  firstSelectedActivity: { flashSaleId: number; flashSaleName: string } | null;

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
  importTemplate: (template: FlashSaleTemplate) => Promise<void>;
  updateTemplate: (name: string, updates: Partial<FlashSaleTemplate>) => Promise<void>;
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
  checkScheduledCopy: () => Promise<void>;
  triggerScheduledCopyNow: () => Promise<void>;

  // 自动模式 Actions
  enterAutoMode: () => void;
  exitAutoMode: () => void;
  startAutoMode: (config: AutoModeConfig, flashSaleId?: number, flashSaleName?: string, debugMode?: boolean, selectedSlotId?: number, selectedSlotTime?: number) => Promise<void>;
  stopAutoMode: () => Promise<void>;
  setFirstSelectedActivity: (sale: FlashSale) => void;
  loadAutoModeStatus: () => Promise<void>;
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
  hasScheduledCopy: false,
  scheduledTaskStatus: null,

  // 自动模式初始值
  autoModeActive: false,
  autoModeStatus: null,
  autoModeLogs: [],
  firstSelectedActivity: null,

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
  setSkuOverride: (itemId, modelId, override) => {
    set(state => {
      const key = `${itemId}-${modelId}`;
      const next = { ...state.skuOverrides };
      if (override.discountRate === undefined && override.stock === undefined && override.purchaseLimit === undefined && override.promoPrice === undefined) {
        delete next[key];
      } else {
        next[key] = override;
      }
      return { skuOverrides: next };
    });
    get().saveCache();

    const amStatus = get().autoModeStatus;
    if (amStatus?.isRunning) {
      browser.storage.local.get('_autoModeStatus').then(result => {
        const status = result._autoModeStatus;
        if (status?.isRunning && status.enableParams) {
          status.enableParams.skuOverrides = get().skuOverrides;
          browser.storage.local.set({ _autoModeStatus: status }).catch(() => {});
        }
      }).catch(() => {});
    }
  },
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

      // dump 第一个商品的 modelList，用于对比 skuOverrides 的 key 是否匹配
      const firstItem = items[0];
      if (firstItem?.modelList?.length > 0) {
        const skuKeysFromApi = Object.keys(get().skuOverrides).filter(k => k.startsWith(`${firstItem.itemid}-`));
        const modelIdsFromGraphql = firstItem.modelList.map((m: any) => String(m.modelid));
        console.log(`[fetchProducts] 第一个商品 itemid=${firstItem.itemid}, GraphQL modelIds=[${modelIdsFromGraphql.join(',')}], skuOverrides keys匹配=[${skuKeysFromApi.join(',')}]`);
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

    set({ isLoadingFlashSaleList: true, error: null });

    try {
      const url = `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&offset=0&limit=50&type=0`;
      console.log('[fetchFlashSaleList] 请求 URL:', url);
      const listResp = await injectedFetch<{ code: number; data?: { flash_sale_list?: FlashSale[] } }>(url);
      console.log('[fetchFlashSaleList] 响应:', JSON.stringify(listResp).slice(0, 500));

      if (listResp.code !== 0) {
        console.log('[fetchFlashSaleList] API 错误', { code: listResp.code, data: listResp.data });
        set({ error: `获取限时特卖列表失败 (code=${listResp.code})`, isLoadingFlashSaleList: false });
        return;
      }
      if (!listResp.data?.flash_sale_list?.length) {
        console.warn('[fetchFlashSaleList] API 返回空列表（可能为新活动未完成同步），保留上次数据');
        set({ isLoadingFlashSaleList: false });
        return;
      }

      const currentList = get().flashSaleList;
      const newList = listResp.data.flash_sale_list;
      if (currentList.length > 0 && newList.length < currentList.length) {
        // 虾皮 API 存在服务端缓存不一致问题：新创建的活动可能在几次查询中时有时无
        // 如果新列表比当前列表小，说明可能漏掉了活动，保留当前列表下次再试
        console.warn('[fetchFlashSaleList] API 返回数量减少', { 之前: currentList.length, 现在: newList.length, 保留: true });
        set({ isLoadingFlashSaleList: false });
        return;
      }
      set({ flashSaleList: newList, isLoadingFlashSaleList: false });
      get().saveCache();
      console.log('[fetchFlashSaleList] 成功, 共', newList.length, '个活动');
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

    const sale = flashSaleList.find(s => s.flash_sale_id === flashSaleId);
    const now = Math.floor(Date.now() / 1000);
    const timeStatus = sale
      ? (sale.start_time > now ? '即将开始' : (now >= sale.end_time ? '已结束' : '进行中'))
      : '';

    try {
      // 检查是否有复制的源活动商品数据（本地存储的，不是从 Shopee API 拉的）
      let copiedData: CopiedSaleData | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 300));
          const result = await browser.storage.local.get('_copiedSaleData');
          const allData: Record<string, CopiedSaleData> = result._copiedSaleData || {};
          const entry = allData[String(flashSaleId)];
          if (entry?.products?.length) {
            copiedData = entry;
            console.log('[loadFlashSaleProducts] 从本地复制数据加载, 源活动:', entry.sourceFlashSaleName);
            break;
          }
        } catch (e) {
          console.warn(`[loadFlashSaleProducts] 读取 _copiedSaleData 失败 (第${attempt + 1}次):`, e);
        }
      }

      if (copiedData) {
        // 先通过 API 获取当前活动中的实际商品 ID，验证缓存是否仍然有效
        let currentIds: string[] = [];
        try {
          const idCheckResp = await injectedFetch<{ code: number; data?: { item_ids: number[] } }>(
            `${FLASH_SALE_API}/get_shop_flash_sale_item_id_list/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&flash_sale_id=${flashSaleId}`,
          );
          if (idCheckResp.code === 0 && idCheckResp.data?.item_ids?.length) {
            currentIds = idCheckResp.data.item_ids.map(id => String(id));
          }
        } catch (e) {
          console.warn('[loadFlashSaleProducts] 验证缓存时的 API 调用失败:', e);
        }

        const cachedIds = new Set(copiedData.products.map(p => p.itemid));
        const currentIdSet = new Set(currentIds);
        const isDifferent = currentIds.length > 0 && (
          cachedIds.size !== currentIdSet.size ||
          [...cachedIds].some(id => !currentIdSet.has(id)) ||
          [...currentIdSet].some(id => !cachedIds.has(id))
        );

        if (isDifferent) {
          console.log(`[loadFlashSaleProducts] 缓存商品与 API 不一致 (缓存:${cachedIds.size}个, API:${currentIds.length}个)，清除缓存走 API`);
          const result = await browser.storage.local.get('_copiedSaleData');
          const allData: Record<string, CopiedSaleData> = result._copiedSaleData || {};
          delete allData[String(flashSaleId)];
          await browser.storage.local.set({ _copiedSaleData: allData });
          copiedData = null;
        }
      }

      if (copiedData) {
        const ids = copiedData.products.map(p => p.itemid);
        const label = sale?.name || `活动 #${flashSaleId}`;
        const loadedOverrides = copiedData.skuOverrides ?? {};
        let computedDiscountRate = copiedData.discountRate ?? get().discountRate;
        let computedStock = copiedData.flashSaleStock ?? get().flashSaleStock;
        let computedPurchaseLimit = copiedData.purchaseLimit ?? get().purchaseLimit;

        // 从 SKU 覆盖参数反推每个 SKU 的 discountRate 及全局显示值
        const enrichedOverrides: Record<string, SkuOverride> = { ...loadedOverrides };
        const allRates: number[] = [];
        for (const p of copiedData.products) {
          for (const m of p.modelList || []) {
            const key = `${p.itemid}-${m.modelid}`;
            const ov = enrichedOverrides[key];
            if (ov?.promoPrice) {
              const originPrice = Number(m.originPrice || p.originPrice || 0);
              if (originPrice > 0) {
                const dr = Math.round(ov.promoPrice / originPrice * 100);
                enrichedOverrides[key] = { ...ov, discountRate: dr };
                allRates.push(dr);
              }
            } else if (!ov) {
              const originPrice = Number(m.originPrice || p.originPrice || 0);
              enrichedOverrides[key] = {
                discountRate: computedDiscountRate,
                promoPrice: originPrice > 0 ? Math.floor(originPrice * computedDiscountRate / 100) : undefined,
                stock: Math.min(computedStock, m.normalStock || computedStock),
                purchaseLimit: computedPurchaseLimit,
              };
            }
          }
        }
        if (allRates.length > 0) {
          const minRate = Math.min(...allRates);
          const maxRate = Math.max(...allRates);
          computedDiscountRate = minRate === maxRate ? minRate
            : Math.round(allRates.reduce((a, b) => a + b, 0) / allRates.length);
        }

        set({
          products: copiedData.products,
          productIds: ids,
          inputText: ids.join('\n'),
          flashSaleId,
          isLoadingFlashSales: false,
          flashSaleInfo: `📦 ${label} [${timeStatus}] — ${ids.length} 个商品 (源: ${copiedData.sourceFlashSaleName || '复制活动'})`,
          discountRate: computedDiscountRate,
          flashSaleStock: computedStock,
          purchaseLimit: computedPurchaseLimit,
          skuOverrides: enrichedOverrides,
        });
        get().saveCache();

        // 缓存路径也调用 GraphQL 刷新商品实时库存，skuOverrides 不受影响
        try {
          await get().fetchProducts();
          const freshProducts = get().products;
          if (freshProducts.length > 0) {
            const freshMap = new Map(freshProducts.map(p => [String(p.itemid), p]));
            for (const p of copiedData.products) {
              const fresh = freshMap.get(String(p.itemid));
              if (fresh) {
                p.normalStock = fresh.normalStock;
                for (const m of (p.modelList || [])) {
                  const freshSku = (fresh.modelList || []).find(sm => String(sm.modelid) === String(m.modelid));
                  if (freshSku) {
                    m.normalStock = freshSku.normalStock;
                    m.totalNormalStock = freshSku.totalNormalStock;
                  }
                }
              }
            }
            set({ products: copiedData.products });
          }
        } catch {}

        return;
      }

      // 正常 API 路径：从 Shopee 获取活动商品列表
      const itemResp = await injectedFetch<{ code: number; data?: { item_ids: number[] } }>(
        `${FLASH_SALE_API}/get_shop_flash_sale_item_id_list/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&flash_sale_id=${flashSaleId}`,
      );

      console.log(`[loadFlashSaleProducts] item_id_list API: code=${itemResp.code}, item_ids=${itemResp.data?.item_ids?.length ?? 0} 个`);

      if (itemResp.code !== 0 || !itemResp.data?.item_ids?.length) {
        set({ products: [], productIds: [], inputText: '', error: `该活动中没有找到商品`, isLoadingFlashSales: false });
        return;
      }

      const ids = itemResp.data.item_ids.map(id => String(id));
      const label = sale?.name || `活动 #${flashSaleId}`;

      // 从虾皮 API 获取该活动中每个 SKU 的实际限时特卖参数（促销价/库存/限购）
      let flashSaleOverrides: Record<string, SkuOverride> = {};
      try {
        const configResp = await injectedFetch<any>(
          `${FLASH_SALE_API}/get_shop_flash_sale_item/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&flash_sale_id=${flashSaleId}&offset=0&limit=100`,
        );
        console.log(`[loadFlashSaleProducts] get_shop_flash_sale_item API: code=${configResp?.code}, hasData=${!!configResp?.data}`);
        if (configResp?.data) {
          const configItems: any[] = configResp.data.items || [];
          const modelInfoStr: string = configResp.data.model_info_str || '{}';
          console.log(`[loadFlashSaleProducts] config: items=${configItems.length}, model_info_str长度=${modelInfoStr.length}, item_info数量=${(configResp.data.item_info || []).length}`);
          if (modelInfoStr.length > 0) {
            console.log(`[loadFlashSaleProducts] model_info_str 前200字符:`, modelInfoStr.slice(0, 200));
          } else {
            console.warn(`[loadFlashSaleProducts] ⚠️ model_info_str 为空! 无法获取 per-SKU 促销价`);
          }
          if (configItems.length > 0) {
            console.log(`[loadFlashSaleProducts] config 前3条 items:`, JSON.stringify(configItems.slice(0, 3)));
          }
          // model_info_str 实际格式: { itemId: [{ modelid, price }, ...] } (数组)
          // 构建 price lookup: { itemId: { modelId: price } }
          const rawModelInfo: Record<string, Array<{ modelid: number; price: number }>> = {};
          try { Object.assign(rawModelInfo, JSON.parse(modelInfoStr)); } catch (e) { console.warn(`[loadFlashSaleProducts] model_info_str JSON解析失败`); }
          const priceLookup: Record<string, Record<string, number>> = {};
          for (const [itemId, models] of Object.entries(rawModelInfo)) {
            if (Array.isArray(models)) {
              const pmap: Record<string, number> = {};
              for (const m of models) {
                pmap[String(m.modelid)] = m.price;
              }
              priceLookup[itemId] = pmap;
            }
          }

          let promoPriceHits = 0;
          let promoPriceMisses = 0;
          for (const ci of configItems) {
            const itemId = String(ci.item_id);
            const modelId = String(ci.model_id);
            const key = `${itemId}-${modelId}`;
            flashSaleOverrides[key] = {
              stock: ci.stock,
              purchaseLimit: ci.purchase_limit,
              promoPrice: ci.promotion_price,
            };
            if (ci.promotion_price !== undefined) promoPriceHits++;
            else promoPriceMisses++;
          }
          console.log(`[loadFlashSaleProducts] 从 get_shop_flash_sale_item 获取到 ${Object.keys(flashSaleOverrides).length} 条 SKU 覆盖参数 (promoPrice命中=${promoPriceHits}, 缺失=${promoPriceMisses})`);
          const sampleKeys = Object.keys(flashSaleOverrides).slice(0, 3);
          if (sampleKeys.length > 0) {
            console.log(`[loadFlashSaleProducts] flashSaleOverrides 前3条:`, JSON.stringify(sampleKeys.map(k => ({ key: k, ...flashSaleOverrides[k] }))));
          }
        }
      } catch (e: any) {
        console.warn('[loadFlashSaleProducts] 获取 get_shop_flash_sale_item 失败:', e?.message);
      }

      // 合并：API 数据优先，store 中已有的覆盖参数兜底（仅保留当前活动的商品）
      const currentIds = new Set(ids);
      const currentOverrides = get().skuOverrides;
      const filteredOverrides: Record<string, SkuOverride> = { ...flashSaleOverrides };
      for (const [key, override] of Object.entries(currentOverrides)) {
        const itemId = key.split('-')[0];
        if (currentIds.has(itemId) && !filteredOverrides[key]) {
          filteredOverrides[key] = override;
        }
      }

      set({
        productIds: ids, inputText: ids.join('\n'),
        flashSaleId,
        isLoadingFlashSales: false,
        flashSaleInfo: `📦 ${label} [${timeStatus}] — ${ids.length} 个商品`,
        skuOverrides: filteredOverrides,
      });

      await get().fetchProducts();

      const loadedProducts = get().products;
      console.log(`[loadFlashSaleProducts] fetchProducts 完成: products=${loadedProducts.length}, 第一个 product modelList=${loadedProducts[0]?.modelList?.length ?? 0}`);

      // 补全 skuOverrides 中的 discountRate：从 promoPrice / originPrice 反推填入每个 SKU
      const enrichedOverrides = { ...get().skuOverrides };
      let enrichedCount = 0;
      for (const p of loadedProducts) {
        for (const m of p.modelList || []) {
          const key = `${p.itemid}-${m.modelid}`;
          const ov = enrichedOverrides[key];
          if (ov?.promoPrice) {
            const originPrice = Number(m.originPrice || p.originPrice || 0);
            if (originPrice > 0) {
              enrichedOverrides[key] = {
                ...ov,
                discountRate: Math.round(ov.promoPrice / originPrice * 100),
              };
              enrichedCount++;
            }
          }
        }
      }
      console.log(`[loadFlashSaleProducts] 为 ${enrichedCount} 个 SKU 补全了 discountRate`);

      // 从补全后的覆盖参数反推全局显示值
      const allRates: number[] = [];
      for (const v of Object.values(enrichedOverrides)) {
        if (v.discountRate !== undefined) allRates.push(v.discountRate);
      }
      if (allRates.length > 0) {
        const minRate = Math.min(...allRates);
        const maxRate = Math.max(...allRates);
        const newDiscountRate = minRate === maxRate ? minRate : Math.round(allRates.reduce((a, b) => a + b, 0) / allRates.length);
        set({ skuOverrides: enrichedOverrides, discountRate: newDiscountRate });
      }
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

    // 构建所有 SKU 的提交数据
    const allItems: EnableItem[] = products.flatMap(p =>
      (p.modelList || [])
        .filter(sku => (sku.normalStock || 0) > 0)
        .map(sku => {
          const key = `${p.itemid}-${sku.modelid}`;
          const override = skuOverrides[key];
          const usedDiscount = override?.discountRate ?? discountRate;
          const usedStock = Math.min(override?.stock ?? flashSaleStock, sku.normalStock || flashSaleStock);
          const usedPurchaseLimit = override?.purchaseLimit ?? purchaseLimit;
          const promoPrice = override?.promoPrice ?? Math.floor(Number(sku.originPrice || p.originPrice || 0) * usedDiscount / 100);
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

    const withPromoPrice = allItems.filter((_, i) => {
      const p = products.find(pp => pp.itemid === String(allItems[i].item_id));
      const m = p?.modelList?.find(mm => String(mm.modelid) === String(allItems[i].model_id));
      if (!p || !m) return false;
      return skuOverrides[`${p.itemid}-${m.modelid}`]?.promoPrice !== undefined;
    }).length;
    const withDiscountRate = allItems.filter((_, i) => {
      const p = products.find(pp => pp.itemid === String(allItems[i].item_id));
      const m = p?.modelList?.find(mm => String(mm.modelid) === String(allItems[i].model_id));
      if (!p || !m) return false;
      return skuOverrides[`${p.itemid}-${m.modelid}`]?.discountRate !== undefined;
    }).length;
    console.log(`[enable] 准备启动，共 ${allItems.length} 个 SKU${skippedCount > 0 ? `，${skippedCount} 个跳过` : ''}`);
    console.log(`[enable] 其中 ${withPromoPrice} 个有 promoPrice 覆盖, ${withDiscountRate} 个有 discountRate 覆盖`);
    console.log('[enable] skuOverrides 总数:', Object.keys(skuOverrides).length);
    if (allItems.length > 0) {
      const sample = allItems.slice(0, 5).map(item => {
        const p = products.find(pp => pp.itemid === String(item.item_id));
        const m = p?.modelList?.find(mm => String(mm.modelid) === String(item.model_id));
        return {
          key: `${item.item_id}-${item.model_id}`,
          originPrice: m?.originPrice || p?.originPrice || '?',
          promoPrice: item.input_promo_price,
          override: skuOverrides[`${item.item_id}-${item.model_id}`],
        };
      });
      console.log('[enable] 前5个 SKU 示例:', JSON.stringify(sample));
    }
    console.log('[enable] 全局参数: discountRate=%d, flashSaleStock=%d, purchaseLimit=%d', discountRate, flashSaleStock, purchaseLimit);

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

    // 清除旧进度，避免 stale state
    try { await browser.storage.local.remove('_enableProgress'); } catch {}

    // 乐观更新 UI：立即显示为"正在执行"状态
    set({ isEnabling: true, error: null, enableProgress: null });

    // 监听 storage 确认 background 已启动（代替不可靠的 sendMessage 返回值）
    const waitForBoot = (timeoutMs = 5000): Promise<boolean> => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          browser.storage.onChanged.removeListener(onChange);
          resolve(false);
        }, timeoutMs);

        const onChange = (changes: any, area: string) => {
          if (area !== 'local') return;
          const epChange = changes._enableProgress;
          if (epChange?.newValue) {
            const data = epChange.newValue as { progress?: EnableProgress; running?: boolean } | undefined;
            if (data?.progress && data.running) {
              browser.storage.onChanged.removeListener(onChange);
              clearTimeout(timer);
              resolve(true);
            }
          }
        };
        browser.storage.onChanged.addListener(onChange);

        // 同时检查一次（处理时序问题）
        browser.storage.local.get('_enableProgress').then((r) => {
          const data = r._enableProgress as { progress?: EnableProgress; running?: boolean } | undefined;
          if (data?.progress && data.running) {
            browser.storage.onChanged.removeListener(onChange);
            clearTimeout(timer);
            resolve(true);
          }
        }).catch(() => {});
      });
    };

    // 发送 START_ENABLE（fire-and-forget，不依赖返回值）
    browser.runtime.sendMessage({ type: 'START_ENABLE' }).catch(() => {});

    const booted = await waitForBoot();
    if (!booted) {
      // 超时未收到启动确认，再试一次
      browser.runtime.sendMessage({ type: 'START_ENABLE' }).catch(() => {});
      const retryBooted = await waitForBoot(4000);
      if (!retryBooted) {
        // 最后尝试：直接读 storage
        await new Promise(r => setTimeout(r, 1500));
        const stored = await browser.storage.local.get('_enableProgress').catch(() => ({}));
        const data = stored._enableProgress as { progress?: EnableProgress; running?: boolean } | undefined;
        if (!data?.progress || !data.running) {
          set({ error: '后台启动失败，请重试' });
        }
        // 如果 storage 显示 running=true，说明 loop 在工作，popup 的 ENABLE_PROGRESS 监听器会更新 UI
      }
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

  importTemplate: async (template: FlashSaleTemplate) => {
    try {
      const result = await browser.storage.local.get('flashSaleTemplates');
      const templates: Record<string, FlashSaleTemplate> = result.flashSaleTemplates || {};
      templates[template.name] = template;
      await browser.storage.local.set({ flashSaleTemplates: templates });
    } catch (e) {
      console.error('[importTemplate] 导入失败:', e);
      throw e;
    }
  },

  updateTemplate: async (name: string, updates: Partial<FlashSaleTemplate>) => {
    try {
      const result = await browser.storage.local.get('flashSaleTemplates');
      const templates: Record<string, FlashSaleTemplate> = result.flashSaleTemplates || {};
      const existing = templates[name];
      if (!existing) throw new Error(`模板「${name}」不存在`);
      const merged: FlashSaleTemplate = {
        ...existing,
        ...updates,
        name: existing.name,
        createdAt: existing.createdAt,
        updatedAt: Date.now(),
        discountRate: updates.discountRate ?? existing.discountRate,
        flashSaleStock: updates.flashSaleStock ?? existing.flashSaleStock,
        purchaseLimit: updates.purchaseLimit ?? existing.purchaseLimit,
        skuOverrides: updates.skuOverrides ?? existing.skuOverrides,
        productInfo: updates.productInfo ?? existing.productInfo,
      };
      templates[name] = merged;
      await browser.storage.local.set({ flashSaleTemplates: templates });
    } catch (e) {
      console.error('[updateTemplate] 更新失败:', e);
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
    copyMode: null, copySource: null, copyTaskStatus: null, isCopying: false, savedTemplates: [], selectedTemplate: null, hasScheduledCopy: false, scheduledTaskStatus: null,
    autoModeActive: false, autoModeStatus: null, autoModeLogs: [], firstSelectedActivity: null,
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
    set({ savedTemplates: names, selectedTemplate: null });
  },

  executeCopy: async (targetTime: number, templateName: string | null) => {
    const state = get();
    if (!state.copySource) return;
    set({ isCopying: true, error: null });

    // 如果选择了模板，使用模板参数覆盖当前参数
    let effectiveDiscountRate = state.discountRate;
    let effectiveFlashSaleStock = state.flashSaleStock;
    let effectivePurchaseLimit = state.purchaseLimit;
    let effectiveSkuOverrides = state.skuOverrides;

    if (templateName) {
      const template = await state.getTemplate(templateName);
      if (template) {
        effectiveDiscountRate = template.discountRate;
        effectiveFlashSaleStock = template.flashSaleStock;
        effectivePurchaseLimit = template.purchaseLimit;
        effectiveSkuOverrides = { ...template.skuOverrides, ...state.skuOverrides };
        console.log('[executeCopy] 已加载模板参数:', {
          discountRate: effectiveDiscountRate, stock: effectiveFlashSaleStock,
          purchaseLimit: effectivePurchaseLimit, overrides: Object.keys(effectiveSkuOverrides).length,
        });
      }
    }

    // 复制活动保存的是源活动的完整 SKU 配置；没有显式覆盖的 SKU 也按当前全局参数固化，
    // 这样新活动展示时会全部视为“手动修改过”，不会被后续全局折扣行影响。
    effectiveSkuOverrides = { ...effectiveSkuOverrides };
    for (const p of state.products) {
      for (const sku of p.modelList || []) {
        const key = `${p.itemid}-${sku.modelid}`;
        if (effectiveSkuOverrides[key]) continue;

        const originPrice = Number(sku.originPrice || p.originPrice || 0);
        effectiveSkuOverrides[key] = {
          discountRate: effectiveDiscountRate,
          promoPrice: originPrice > 0 ? Math.floor(originPrice * effectiveDiscountRate / 100) : undefined,
          stock: Math.min(effectiveFlashSaleStock, sku.normalStock || effectiveFlashSaleStock),
          purchaseLimit: effectivePurchaseLimit,
        };
      }
    }

    // 过滤 skuOverrides：仅保留当前 products 中存在的 itemId 对应的覆盖参数
    const currentProductIds = new Set(state.products.map(p => p.itemid));
    const filteredSkuOverrides: Record<string, SkuOverride> = {};
    for (const [key, override] of Object.entries(effectiveSkuOverrides)) {
      const itemId = key.split('-')[0];
      if (currentProductIds.has(itemId)) {
        filteredSkuOverrides[key] = override;
      }
    }
    effectiveSkuOverrides = filteredSkuOverrides;

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
          skuOverrides: effectiveSkuOverrides,
          discountRate: effectiveDiscountRate,
          flashSaleStock: effectiveFlashSaleStock,
          purchaseLimit: effectivePurchaseLimit,
        }, 120000);

        if (status) {
          console.log('[executeCopy] EXECUTE_COPY storage 状态:', JSON.stringify(status));
          set({ copyMode: 'result', isCopying: false, copyTaskStatus: status });
          // 即时执行：刷新活动列表直到新活动出现
          const newId = status.newFlashSaleId;
          if (newId) {
            for (let attempt = 0; attempt < 5; attempt++) {
              await get().fetchFlashSaleList();
              if (get().flashSaleList.some(s => s.flash_sale_id === newId)) {
                console.log('[executeCopy] 新活动已在列表中');
                set({ flashSaleId: newId });
                break;
              }
              if (attempt < 4) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
            await get().saveCache();
          }
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
          templateItems = state.products.flatMap((p: ShopeeProduct) =>
            (p.modelList || []).filter(sku => (sku.normalStock || 0) > 0).map(sku => {
              const key = `${p.itemid}-${sku.modelid}`;
              const override = effectiveSkuOverrides[key];
              const usedDiscount = override?.discountRate ?? effectiveDiscountRate;
              const usedStock = Math.min(override?.stock ?? effectiveFlashSaleStock, sku.normalStock || effectiveFlashSaleStock);
              const usedPurchaseLimit = override?.purchaseLimit ?? effectivePurchaseLimit;
              const promoPrice = override?.promoPrice ?? Math.floor(Number(sku.originPrice || p.originPrice || 0) * usedDiscount / 100);
              return {
                item_id: Number(p.itemid), status: 1, model_id: Number(sku.modelid),
                item_display_image: p.images?.[0] || '',
                input_promo_price: promoPrice, stock: usedStock, purchase_limit: usedPurchaseLimit,
              };
            }),
          );
        }

        const params: ScheduledCopyParams = {
          sourceFlashSaleId: state.copySource.flashSale.flash_sale_id,
          sourceFlashSaleName: state.copySource.flashSale.name || '',
          targetStartTime: targetTime,
          templateName,
          templateItems,
          products: state.products,
          discountRate: effectiveDiscountRate,
          flashSaleStock: effectiveFlashSaleStock,
          purchaseLimit: effectivePurchaseLimit,
          skuOverrides: effectiveSkuOverrides,
        };

        console.log('[executeCopy] 定时执行, targetTime:', targetTime, 'template:', templateName);
        const status = await waitForStorage({ type: 'SCHEDULE_COPY', params });

        if (status) {
          console.log('[executeCopy] SCHEDULE_COPY storage 状态:', JSON.stringify(status));
          set({ copyMode: 'result', isCopying: false, copyTaskStatus: status, hasScheduledCopy: true });
          get().checkScheduledCopy();
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
      const scheduledResult = await browser.storage.local.get('_scheduledCopy');
      const hasTask = !!scheduledResult._scheduledCopy;
      set({ hasScheduledCopy: hasTask });
      if (hasTask) get().checkScheduledCopy();
    } catch {}
  },

  setSelectedTemplate: (templateName: string | null) => {
    set({ selectedTemplate: templateName });
  },

  checkScheduledCopy: async () => {
    try {
      const result = await browser.storage.local.get('_scheduledCopy');
      const hasTask = !!result._scheduledCopy;
      set({ hasScheduledCopy: hasTask });

      if (hasTask) {
        try {
          const status = await browser.runtime.sendMessage({ type: 'GET_SCHEDULED_STATUS' }) as ScheduledTaskStatus;
          set({ scheduledTaskStatus: status });
        } catch {
          set({ scheduledTaskStatus: { exists: hasTask, alarmActive: false, params: result._scheduledCopy } });
        }
      } else {
        set({ scheduledTaskStatus: null });
      }
    } catch {
      set({ hasScheduledCopy: false, scheduledTaskStatus: null });
    }
  },

  triggerScheduledCopyNow: async () => {
    try {
      set({ isEnabling: true, error: null, enableProgress: null, hasScheduledCopy: false });
      await browser.runtime.sendMessage({ type: 'TRIGGER_SCHEDULED_COPY_NOW' });
    } catch (e: any) {
      console.error('[triggerScheduledCopyNow] 异常:', e);
      set({ isEnabling: false, error: `触发失败: ${e?.message || '未知错误'}` });
    }
  },

  enterAutoMode: () => set({ autoModeActive: true }),

  exitAutoMode: () => set({ autoModeActive: false }),

  setFirstSelectedActivity: (sale: FlashSale) => {
    set({ firstSelectedActivity: { flashSaleId: sale.flash_sale_id, flashSaleName: sale.name } });
  },

  startAutoMode: async (config: AutoModeConfig, flashSaleId?: number, flashSaleName?: string, debugMode?: boolean, selectedSlotId?: number, selectedSlotTime?: number) => {
    const sourceId = flashSaleId || get().firstSelectedActivity?.flashSaleId;
    const sourceName = flashSaleName || get().firstSelectedActivity?.flashSaleName;
    if (!sourceId) {
      set({ error: '请先选择一个模板活动' });
      return;
    }
    set({ error: null });

    try {
      const currentOverrides = get().skuOverrides;
      await browser.runtime.sendMessage({
        type: 'START_AUTO_MODE',
        config,
        sourceFlashSaleId: sourceId,
        sourceFlashSaleName: sourceName || `活动 #${sourceId}`,
        skuOverrides: currentOverrides || {},
        debugMode: !!debugMode,
        selectedSlotId,
        selectedSlotTime,
      });
      await get().loadAutoModeStatus();
    } catch (e: any) {
      set({ error: `启动自动模式失败: ${e?.message || '未知错误'}` });
    }
  },

  stopAutoMode: async () => {
    try {
      await browser.runtime.sendMessage({ type: 'STOP_AUTO_MODE' });
      await get().loadAutoModeStatus();
    } catch (e: any) {
      set({ error: `停止自动模式失败: ${e?.message || '未知错误'}` });
    }
  },

  loadAutoModeStatus: async () => {
    try {
      const result = await browser.storage.local.get('_autoModeStatus');
      const status = result._autoModeStatus as AutoModeStatus | undefined;
      if (status) {
        set({ autoModeStatus: status, autoModeActive: true });
      } else {
        set({ autoModeStatus: null });
      }
      const logsResult = await browser.storage.local.get('_autoModeLogs');
      const logs = logsResult._autoModeLogs as AutoModeLog[] | undefined;
      if (logs?.length) {
        set({ autoModeLogs: logs.slice(0, 50) });
      }
    } catch {}
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

    if (type === 'AUTO_MODE_UPDATE') {
      console.log('[store] 收到自动模式状态更新:', msg.status);
      useAppStore.setState({ autoModeStatus: msg.status });
    }

    if (type === 'AUTO_MODE_LOG') {
      console.log('[store] 收到自动模式日志:', msg.log);
      const currentLogs = useAppStore.getState().autoModeLogs;
      useAppStore.setState({
        autoModeLogs: [msg.log, ...currentLogs].slice(0, 50),
      });
    }

    return false;
  });
}
