import { defineBackground } from 'wxt/utils/define-background';

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

// ===== SPC_CDS Cookie 提取（带详细日志）=====
async function getSpcCdsCookie(): Promise<{ spcCds: string; spcCdsVer: string }> {
  const TAG = '[SPC_CDS]';
  console.log(TAG, '=== 开始查找 SPC_CDS Cookie ===');

  // 方法1: 通过 cookies.get() 尝试多个域名
  const urls = ['https://seller.shopee.tw', 'https://shopee.tw', 'https://www.shopee.tw'];
  for (const url of urls) {
    try {
      console.log(TAG, `尝试 cookies.get() url=${url}, name=SPC_CDS`);
      const cookie = await browser.cookies.get({ url, name: 'SPC_CDS' });
      console.log(TAG, `cookies.get(${url}) 结果:`, cookie ? `domain=${cookie.domain}, value存在=${!!cookie.value}, value长度=${cookie.value?.length}` : 'null/undefined');

      if (cookie?.value) {
        const verCookie = await browser.cookies.get({ url, name: 'SPC_CDS_VER' });
        console.log(TAG, `✅ 在 ${url} 找到 SPC_CDS, 长度: ${cookie.value.length}, VER: ${verCookie?.value || '2'}`);
        return { spcCds: cookie.value, spcCdsVer: verCookie?.value || '2' };
      }
      console.log(TAG, `cookies.get(${url}) 未返回 SPC_CDS`);
    } catch (e: any) {
      console.log(TAG, `cookies.get(${url}) 抛出异常:`, e?.message || String(e));
    }
  }

  // 方法2: 通过 cookies.getAll() 在 .shopee.tw 域名下搜索
  console.log(TAG, '--- cookies.get() 全部失败，尝试 cookies.getAll({ domain: ".shopee.tw" }) ---');
  try {
    const allCookies = await browser.cookies.getAll({ domain: '.shopee.tw' });
    console.log(TAG, `cookies.getAll({ domain: '.shopee.tw' }) 返回 ${allCookies.length} 个 cookie`);
    for (const c of allCookies) {
      console.log(TAG, `  Cookie: name=${c.name}, domain=${c.domain}, path=${c.path}, value存在=${!!c.value}, value长度=${c.value?.length}, secure=${c.secure}, httpOnly=${c.httpOnly}`);
    }

    const spc = allCookies.find(c => c.name === 'SPC_CDS');
    const ver = allCookies.find(c => c.name === 'SPC_CDS_VER');
    if (spc?.value) {
      console.log(TAG, `✅ 在 cookies.getAll 中找到 SPC_CDS, domain=${spc.domain}, 长度: ${spc.value.length}`);
      return { spcCds: spc.value, spcCdsVer: ver?.value || '2' };
    }
    console.log(TAG, 'cookies.getAll 也未找到 SPC_CDS');
  } catch (e: any) {
    console.log(TAG, `cookies.getAll 抛出异常:`, e?.message || String(e));
  }

  // 方法3: 尝试在 seller.shopee.tw 的子域名下搜索
  console.log(TAG, '--- 尝试 cookies.getAll({ domain: "seller.shopee.tw" }) ---');
  try {
    const allCookies = await browser.cookies.getAll({ domain: 'seller.shopee.tw' });
    console.log(TAG, `cookies.getAll({ domain: 'seller.shopee.tw' }) 返回 ${allCookies.length} 个 cookie`);
    for (const c of allCookies) {
      console.log(TAG, `  Cookie: name=${c.name}, domain=${c.domain}, value存在=${!!c.value}`);
    }
    const spc = allCookies.find(c => c.name === 'SPC_CDS');
    if (spc?.value) {
      console.log(TAG, `✅ 在 seller.shopee.tw 中找到 SPC_CDS`);
      return { spcCds: spc.value, spcCdsVer: '2' };
    }
  } catch (e: any) {
    console.log(TAG, `cookies.getAll(seller.shopee.tw) 抛出异常:`, e?.message || String(e));
  }

  console.log(TAG, '❌ 所有方法均未找到 SPC_CDS');
  return { spcCds: '', spcCdsVer: '2' };
}

// ===== 页面内注入 fetch（MAIN world）=====
async function executePageFetch(
  tabId: number,
  url: string,
  body: object,
  timeoutMs = 15000
): Promise<any> {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (fetchUrl: string, fetchBody: string) => {
      try {
        const response = await fetch(fetchUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
          },
          body: fetchBody,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
      } catch (error: any) {
        return { _error: error.message };
      }
    },
    args: [url, JSON.stringify(body)],
  });

  if (!results?.[0]?.result) {
    throw new Error('页面脚本执行返回为空，请刷新页面后重试');
  }

  const result = results[0].result;
  if (result?._error) {
    throw new Error(`API 请求失败: ${result._error}`);
  }

  return result;
}

export default defineBackground({
  main() {
    console.log('[限时特卖助手] Background 已启动');

    browser.runtime.onInstalled.addListener((details) => {
      console.log('[限时特卖助手] 已安装/更新:', details.reason);
    });

    browser.runtime.onMessage.addListener(async (msg: any) => {
      const type = msg?.type;

      // SPC_CDS_REQUEST: 从 Cookie 读取
      if (type === 'SPC_CDS_REQUEST') {
        console.log('[SPC_CDS_REQUEST] 收到请求');
        try {
          const { spcCds, spcCdsVer } = await getSpcCdsCookie();

          if (!spcCds) {
            console.log('[SPC_CDS_REQUEST] ❌ 未找到 SPC_CDS');
            return {
              spcCds: '', spcCdsVer: '2',
              error: 'SPC_CDS 不存在，请确认：\n1. 已登录虾皮卖家中心 (seller.shopee.tw)\n2. 刷新页面后再试\n\n🔍 已输出详细日志到 Background Console\n在 chrome://extensions 点击"Service Worker"查看',
            };
          }

          console.log('[SPC_CDS_REQUEST] ✅ SPC_CDS 获取成功, 长度:', spcCds.length);
          return { spcCds, spcCdsVer };
        } catch (e: any) {
          console.log('[SPC_CDS_REQUEST] 异常:', e?.message || String(e));
          const msg = (e?.message || '').toLowerCase();
          if (msg.includes('permission')) {
            return { spcCds: '', spcCdsVer: '2', error: 'Chrome Cookie 权限被拒绝，请在扩展管理页面检查权限设置后重新加载扩展' };
          }
          return { spcCds: '', spcCdsVer: '2', error: `读取 Cookie 失败: ${e?.message || '未知错误'}\n\n🔍 查看 Background Console: chrome://extensions → 点击"Service Worker"` };
        }
      }

      // FETCH_PRODUCTS: 页面注入 fetch
      if (type === 'FETCH_PRODUCTS') {
        // 1. 检查活跃标签页
        let tabs;
        try {
          tabs = await browser.tabs.query({ active: true, currentWindow: true });
        } catch (e: any) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: `查询标签页失败: ${e?.message || '未知错误'}` };
        }

        const activeTab = tabs?.[0];
        if (!activeTab?.id) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: '没有找到活跃的标签页，请确保已打开一个虾皮卖家中心页面' };
        }
        if (!activeTab.url?.includes('seller.shopee.tw')) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: `当前标签页不是虾皮卖家中心\n当前: ${activeTab.url || '未知'}\n请在 seller.shopee.tw 页面使用此扩展` };
        }

        // 2. 读取 SPC_CDS 并检查商品 ID
        const { productIds } = msg;
        if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: '商品 ID 列表为空，请先输入商品 ID' };
        }
        if (productIds.length > 50) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: `单次最多查询 50 个商品（当前 ${productIds.length} 个），请分批查询` };
        }

        const { spcCds, spcCdsVer } = await getSpcCdsCookie();
        if (!spcCds) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: 'SPC_CDS Cookie 不存在，请先在虾皮卖家中心登录并刷新页面' };
        }

        // 3. 页面注入 fetch
        const fetchUrl = `${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`;
        const fetchBody = {
          query: PRODUCTS_QUERY,
          variables: { productIds, statusType: 0 },
        };

        try {
          const data = await Promise.race([
            executePageFetch(activeTab.id, fetchUrl, fetchBody),
            new Promise<any>((_, reject) =>
              setTimeout(() => reject(new Error('API 请求超时（15秒），请检查网络或 SPC_CDS 是否已过期')), 15000)
            ),
          ]);

          const items = data?.data?.products?.items;
          if (!items || !Array.isArray(items)) {
            return { type: 'FETCH_PRODUCTS_ERROR', error: 'API 返回数据格式异常，未找到商品列表' };
          }
          if (items.length === 0) {
            return { type: 'FETCH_PRODUCTS_ERROR', error: `未找到匹配的商品（已查询 ${productIds.length} 个 ID），请确认商品 ID 是否正确` };
          }
          return { type: 'FETCH_PRODUCTS_RESULT', products: items };
        } catch (e: any) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: e?.message || String(e) };
        }
      }
    });
  },
});
