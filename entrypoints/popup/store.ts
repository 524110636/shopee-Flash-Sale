import { create } from 'zustand';
import type { ShopeeProduct, FlashSale, EnableItem, EnableResult, EnableProgress } from './types';

// ===== 注入页面执行 fetch（MAIN world）=====
async function injectedFetch<T>(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  body?: object,
): Promise<T> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab?.id) throw new Error('没有找到活跃的标签页');
  if (!tab.url?.includes('seller.shopee.tw')) throw new Error('请在 seller.shopee.tw 页面使用此扩展');

  // 尝试从页面获取 sc-fe-session（虾皮 API 需要的 CSRF 令牌）
  const sessionInfo = await browser.scripting.executeScript({
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
  });
  const scFeSession = (sessionInfo?.[0]?.result as string) || '';
  console.log('[injectedFetch] sc-fe-session 最终值:', scFeSession || '(空)');

  const results = await browser.scripting.executeScript({
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
        const resp = await fetch(fetchUrl, opts);
        const bodyText = await resp.text();
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText || bodyText.slice(0, 200)}`);
        return JSON.parse(bodyText);
      } catch (e: any) {
        return { _error: e.message } as any;
      }
    },
    args: [url, method, body ? JSON.stringify(body) : null, scFeSession],
  });

  const result = results?.[0]?.result as any;
  if (!result) throw new Error('页面脚本执行返回为空，请刷新页面后重试');
  if (result._error) throw new Error(`API 请求失败: ${result._error}`);
  return result as T;
}

const FLASH_SALE_API = 'https://seller.shopee.tw/api/marketing/v4/shop_flash_sale';

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
  discountRate: number;
  flashSaleStock: number;
  isEnabling: boolean;
  enableProgress: EnableProgress | null;

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
  setDiscountRate: (n: number) => void;
  setFlashSaleStock: (n: number) => void;
  enableFlashSaleItems: () => Promise<void>;
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
  discountRate: 60,
  flashSaleStock: 200,
  isEnabling: false,
  enableProgress: null,

  setSpcCds: (spcCds, spcCdsVer) => set({ spcCds, spcCdsVer }),
  setConnected: (isConnected) => set({ isConnected }),
  setExtracting: (isExtracting) => set({ isExtracting }),
  setInputText: (inputText) => set({ inputText }),
  setProductIds: (productIds) => set({ productIds }),
  setProducts: (products) => set({ products }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  setMaxRetries: (maxRetries) => set({ maxRetries }),
  setDiscountRate: (discountRate) => set({ discountRate }),
  setFlashSaleStock: (flashSaleStock) => set({ flashSaleStock }),

  extractSpcCds: async () => {
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
            break;
          }
        } catch { /* next */ }
      }

      if (!spcCds) {
        const allCookies = await browser.cookies.getAll({ domain: '.shopee.tw' });
        const spc = allCookies.find(c => c.name === 'SPC_CDS');
        const ver = allCookies.find(c => c.name === 'SPC_CDS_VER');
        if (spc?.value) {
          spcCds = spc.value;
          spcCdsVer = ver?.value || '2';
        }
      }

      if (spcCds) {
        set({ spcCds, spcCdsVer, isConnected: true, isExtracting: false, error: null });
      } else {
        set({
          error: 'SPC_CDS 不存在，请确认：\n1. 已登录虾皮卖家中心 (seller.shopee.tw)\n2. 刷新页面后再试',
          isExtracting: false, isConnected: false,
        });
      }
    } catch (e: any) {
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
    } catch (e: any) {
      set({ error: `请求失败: ${e?.message || String(e)}`, isLoading: false });
    }
  },

  // ===== 获取限时特卖活动列表 =====
  fetchFlashSaleList: async () => {
    const { spcCds, spcCdsVer } = get();
    if (!spcCds) { set({ error: '请先获取 SPC_CDS' }); return; }

    set({ isLoadingFlashSaleList: true, error: null, flashSaleList: [] });

    try {
      const listResp = await injectedFetch<{ code: number; data?: { flash_sale_list?: FlashSale[] } }>(
        `${FLASH_SALE_API}/get_shop_flash_sale_list/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}&offset=0&limit=50&type=0`,
      );

      if (listResp.code !== 0 || !listResp.data?.flash_sale_list?.length) {
        set({ error: '未找到限时特卖活动', isLoadingFlashSaleList: false });
        return;
      }

      set({ flashSaleList: listResp.data.flash_sale_list, isLoadingFlashSaleList: false });
      console.log("[enable] 限时特卖列表详情:", JSON.stringify(listResp.data.flash_sale_list, null, 2));
    } catch (e: any) {
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
    const { products, flashSaleId, spcCds, spcCdsVer, maxRetries, discountRate, flashSaleStock } = get();

    if (!flashSaleId) { set({ error: '没有限时特卖活动 ID，请先加载限时特卖' }); return; }
    if (!products.length) { set({ error: '没有商品数据' }); return; }

    // 构建所有 SKU 的提交数据（跳过库存为 0 的 SKU）
    const allItems: EnableItem[] = products.flatMap(p =>
      (p.modelList || [])
        .filter(sku => (sku.normalStock || 0) > 0)
        .map(sku => ({
          item_id: Number(p.itemid),
          status: 1,
          model_id: Number(sku.modelid),
          item_display_image: p.images?.[0] || '',
          input_promo_price: Math.floor(Number(sku.originPrice || p.originPrice || 0) * discountRate / 100),
          stock: Math.min(flashSaleStock, sku.normalStock || flashSaleStock),
          purchase_limit: 5,
        }))
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

    for (round = 1; round <= maxRetries; round++) {
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

  // ===== 重置 =====
  reset: () => set({
    spcCds: '', spcCdsVer: '2', isConnected: false,
    productIds: [], products: [], isLoading: false, error: null, inputText: '',
    isLoadingFlashSales: false, flashSaleInfo: '', flashSaleId: null,
    flashSaleList: [], isLoadingFlashSaleList: false,
    maxRetries: 10, discountRate: 60, flashSaleStock: 200, isEnabling: false, enableProgress: null,
  }),
}));
