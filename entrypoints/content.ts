import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['https://seller.shopee.tw/*'],
  runAt: 'document_idle',
  main() {
    console.log('[限时特卖助手] Content Script 已加载');

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

    // ===== API 请求代理（通过页面内脚本执行同源 fetch） =====
    function fetchProductsViaPage(
      spcCds: string,
      spcCdsVer: string,
      productIds: string[]
    ): Promise<any> {
      return new Promise((resolve, reject) => {
        // 注入超时（15秒）
        const timeout = setTimeout(() => {
          window.removeEventListener('message', handler);
          reject(new Error(`API 请求超时（15秒），请检查网络或 SPC_CDS 是否已过期`));
        }, 15000);

        const handler = (event: MessageEvent) => {
          if (event.source !== window) return;
          const { type, data } = event.data || {};
          if (type === 'FETCH_PRODUCTS_RESULT') {
            clearTimeout(timeout);
            window.removeEventListener('message', handler);
            resolve(data);
          }
          if (type === 'FETCH_PRODUCTS_ERROR') {
            clearTimeout(timeout);
            window.removeEventListener('message', handler);
            reject(new Error(data?.error || 'API 请求失败'));
          }
        };
        window.addEventListener('message', handler);

        const injectScript = document.createElement('script');
        injectScript.textContent = `
          (async function() {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 12000);
              const resp = await fetch(
                '${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}',
                {
                  method: 'POST',
                  headers: {
                    'accept': 'application/json, text/plain, */*',
                    'content-type': 'application/json',
                    'x-sz-sdk-version': '1.12.33-sc.3',
                    'sc-fe-session': 'BFFB5DB1CB99D05E',
                    'sc-fe-ver': '21.146220',
                  },
                  credentials: 'include',
                  signal: controller.signal,
                  body: JSON.stringify({
                    query: ${JSON.stringify(PRODUCTS_QUERY)},
                    variables: { productIds: ${JSON.stringify(productIds)}, statusType: 0 }
                  })
                }
              );
              clearTimeout(timeoutId);
              if (!resp.ok) {
                throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
              }
              const data = await resp.json();
              if (data.code !== undefined && data.code !== 0) {
                throw new Error('API 返回错误 (code=' + data.code + '): ' + (data.message || '未知错误'));
              }
              window.postMessage({ type: 'FETCH_PRODUCTS_RESULT', data }, '*');
            } catch(e) {
              if (e.name === 'AbortError') {
                window.postMessage({ type: 'FETCH_PRODUCTS_ERROR', data: { error: 'API 请求超时（12秒），请检查网络连接' } }, '*');
              } else {
                window.postMessage({ type: 'FETCH_PRODUCTS_ERROR', data: { error: e.message || String(e) } }, '*');
              }
            }
          })();
        `;
        document.documentElement.appendChild(injectScript);
        injectScript.remove();
      });
    }

    // ===== 监听来自 Background 的消息 =====
    browser.runtime.onMessage.addListener(async (msg: any) => {
      if (msg.type === 'FETCH_PRODUCTS') {
        const spcCds = msg._spcCds;
        const spcCdsVer = msg._spcCdsVer || '2';

        if (!spcCds) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: 'SPC_CDS 为空，请先在虾皮卖家中心登录' };
        }

        if (!msg.productIds || !Array.isArray(msg.productIds) || msg.productIds.length === 0) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: '商品 ID 列表为空，请先输入商品 ID' };
        }

        if (msg.productIds.length > 50) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: `单次最多查询 50 个商品（当前 ${msg.productIds.length} 个），请分批查询` };
        }

        try {
          const data = await fetchProductsViaPage(spcCds, spcCdsVer, msg.productIds);
          const items = data?.data?.products?.items;
          if (!items || !Array.isArray(items)) {
            return { type: 'FETCH_PRODUCTS_ERROR', error: 'API 返回数据格式异常，未找到商品列表' };
          }
          if (items.length === 0) {
            return { type: 'FETCH_PRODUCTS_ERROR', error: `未找到匹配的商品（已查询 ${msg.productIds.length} 个 ID），请确认商品 ID 是否正确` };
          }
          return { type: 'FETCH_PRODUCTS_RESULT', products: items };
        } catch (e: any) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: e?.message || String(e) };
        }
      }
    });
  },
});
