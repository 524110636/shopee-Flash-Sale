import { defineContentScript } from 'wxt/utils/define-content-script';
import type { MessagePayload, InjectionPayload } from './popup/types';

export default defineContentScript({
  matches: ['https://seller.shopee.tw/*'],
  runAt: 'document_idle',
  main() {
    // ===== SPC_CDS 提取策略（多级降级） =====

    function extractSpcCdsFromCookie(): string | null {
      const match = document.cookie.match(/SPC_CDS=([^;]+)/);
      return match ? match[1] : null;
    }

    async function fetchSpcCdsViaInjection(): Promise<{ spcCds: string; spcCdsVer: string } | null> {
      return new Promise((resolve) => {
        const handler = (event: MessageEvent<InjectionPayload>) => {
          if (event.source !== window) return;
          if (event.data.type === 'SPC_CDS_FROM_PAGE') {
            window.removeEventListener('message', handler);
            resolve(event.data.data ?? null);
          }
        };
        window.addEventListener('message', handler);

        const injectScript = document.createElement('script');
        injectScript.textContent = `
          (function() {
            try {
              let spcCds = localStorage.getItem('SPC_CDS');
              let spcCdsVer = localStorage.getItem('SPC_CDS_VER');

              if (!spcCds) {
                const urlMatch = window.location.href.match(/SPC_CDS=([a-f0-9-]+)/i);
                if (urlMatch) {
                  spcCds = urlMatch[1];
                  spcCdsVer = '2';
                }
              }

              if (spcCds) {
                window.postMessage({
                  type: 'SPC_CDS_FROM_PAGE',
                  data: { spcCds, spcCdsVer: spcCdsVer || '2' }
                }, '*');
              }
            } catch(e) {
              console.error('[限时特卖助手] SPC_CDS 提取失败:', e);
            }
          })();
        `;
        document.documentElement.appendChild(injectScript);
        injectScript.remove();
      });
    }

    // ===== API 请求代理（通过页面内脚本执行同源 fetch） =====
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
        const query = `query Products($productIds: [String], $statusType: Int) {
          products(productIds: $productIds, statusType: $statusType) {
            items {
              itemid, name, images, variationImages, transparentBackgroundImage,
              status, inputOriginPrice, originPrice, normalStock, localPrice,
              pffTag, normalSellerStock, normalWmsStock, minPurchaseLimit,
              itemSellerSellableStock, itemWmsSellableStock,
              itemTotalReservedStock, itemNormalStock,
              modelList {
                modelid, name, inputOriginPrice, originPrice, normalStock,
                localPrice, pffTag, normalSellerStock, normalWmsStock,
                modelNormalStock, modelSellerSellableStock,
                modelWmsSellableStock, modelTotalReservedStock,
                enableShopFlashSaleNewStock, totalNormalStock
              }
            }
          }
        }`;

        injectScript.textContent = `
          (async function() {
            try {
              const resp = await fetch(
                'https://seller.shopee.tw/api/marketing/v4/graphql/query/?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}',
                {
                  method: 'POST',
                  headers: {
                    'accept': 'application/json, text/plain, */*',
                    'accept-language': 'zh-CN,zh;q=0.9',
                    'content-type': 'application/json',
                    'priority': 'u=1, i',
                    'x-sz-sdk-version': '1.12.33-sc.3',
                    'sc-fe-session': 'BFFB5DB1CB99D05E',
                    'sc-fe-ver': '21.146220',
                  },
                  credentials: 'include',
                  body: JSON.stringify({
                    query: ${JSON.stringify(query)},
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

    // ===== 监听来自 Popup/Background 的消息 =====
    browser.runtime.onMessage.addListener(async (msg: MessagePayload) => {
      switch (msg.type) {
        case 'SPC_CDS_REQUEST': {
          let spcCds = extractSpcCdsFromCookie();
          let spcCdsVer = '2';

          if (!spcCds) {
            const result = await fetchSpcCdsViaInjection();
            if (result) {
              spcCds = result.spcCds;
              spcCdsVer = result.spcCdsVer;
            }
          }

          return { spcCds, spcCdsVer };
        }

        case 'FETCH_PRODUCTS': {
          try {
            let spcCds = extractSpcCdsFromCookie();
            let spcCdsVer = '2';

            if (!spcCds) {
              const result = await fetchSpcCdsViaInjection();
              if (result) {
                spcCds = result.spcCds;
                spcCdsVer = result.spcCdsVer;
              }
            }

            if (!spcCds) {
              return { type: 'FETCH_PRODUCTS_ERROR', error: '无法获取 SPC_CDS，请确保已登录虾皮卖家中心' };
            }

            const data = await fetchProductsViaPage(spcCds, spcCdsVer, (msg as any).productIds);
            return { type: 'FETCH_PRODUCTS_RESULT', products: data?.data?.products?.items ?? [] };
          } catch (e) {
            return { type: 'FETCH_PRODUCTS_ERROR', error: String(e) };
          }
        }
      }
    });
  },
});
