import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  matches: ['https://seller.shopee.tw/*'],
  runAt: 'document_idle',
  main() {
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

    // ===== API 请求代理（通过页面内脚本执行同源 fetch，绕过 TLS 拦截） =====
    async function fetchProductsViaPage(
      spcCds: string,
      spcCdsVer: string,
      productIds: string[]
    ): Promise<any> {
      return new Promise((resolve, reject) => {
        const handler = (event: MessageEvent) => {
          if (event.source !== window) return;
          const { type, data } = event.data || {};
          if (type === 'FETCH_PRODUCTS_RESULT') {
            window.removeEventListener('message', handler);
            resolve(data);
          }
          if (type === 'FETCH_PRODUCTS_ERROR') {
            window.removeEventListener('message', handler);
            reject(new Error(data?.error || 'Unknown error'));
          }
        };
        window.addEventListener('message', handler);

        const injectScript = document.createElement('script');
        injectScript.textContent = `
          (async function() {
            try {
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
                  body: JSON.stringify({
                    query: ${JSON.stringify(PRODUCTS_QUERY)},
                    variables: { productIds: ${JSON.stringify(productIds)}, statusType: 0 }
                  })
                }
              );
              const data = await resp.json();
              window.postMessage({ type: 'FETCH_PRODUCTS_RESULT', data }, '*');
            } catch(e) {
              window.postMessage({ type: 'FETCH_PRODUCTS_ERROR', error: e.message }, '*');
            }
          })();
        `;
        document.documentElement.appendChild(injectScript);
        injectScript.remove();
      });
    }

    // ===== 监听来自 Background 的消息（tabs.sendMessage） =====
    browser.runtime.onMessage.addListener(async (msg: any) => {
      if (msg.type === 'FETCH_PRODUCTS') {
        const spcCds = msg._spcCds;
        const spcCdsVer = msg._spcCdsVer || '2';
        if (!spcCds) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: '无法获取 SPC_CDS，请确保已登录虾皮卖家中心' };
        }
        try {
          const data = await fetchProductsViaPage(spcCds, spcCdsVer, msg.productIds);
          return { type: 'FETCH_PRODUCTS_RESULT', products: data?.data?.products?.items ?? [] };
        } catch (e) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: String(e) };
        }
      }
    });
  },
});
