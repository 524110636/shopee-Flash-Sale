import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground({
  main() {
    console.log('[限时特卖助手] Background 已启动');

    browser.runtime.onInstalled.addListener((details) => {
      console.log('[限时特卖助手] 已安装/更新:', details.reason);
    });

    // 消息中继：Popup (runtime.sendMessage) → Background → Content Script (tabs.sendMessage)
    browser.runtime.onMessage.addListener(async (msg: any) => {
      const type = msg?.type;

      // SPC_CDS_REQUEST: 直接从 Cookie 读取（需要 "cookies" 权限）
      if (type === 'SPC_CDS_REQUEST') {
        try {
          const cookie = await browser.cookies.get({
            url: 'https://seller.shopee.tw',
            name: 'SPC_CDS',
          });
          const verCookie = await browser.cookies.get({
            url: 'https://seller.shopee.tw',
            name: 'SPC_CDS_VER',
          });
          return {
            spcCds: cookie?.value || '',
            spcCdsVer: verCookie?.value || '2',
          };
        } catch (e) {
          throw new Error('无法读取 SPC_CDS Cookie，请确保已登录虾皮卖家中心');
        }
      }

      // FETCH_PRODUCTS: 需要转发到 Content Script（页面内 fetch 绕过 TLS 拦截）
      if (type === 'FETCH_PRODUCTS') {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs[0];
        if (!activeTab?.id) {
          throw new Error('没有找到活跃的标签页');
        }
        if (!activeTab.url?.includes('seller.shopee.tw')) {
          throw new Error('请先在虾皮卖家中心 (seller.shopee.tw) 打开此扩展');
        }
        // 先读取 SPC_CDS 并注入到消息中
        const cookie = await browser.cookies.get({
          url: 'https://seller.shopee.tw',
          name: 'SPC_CDS',
        });
        const verCookie = await browser.cookies.get({
          url: 'https://seller.shopee.tw',
          name: 'SPC_CDS_VER',
        });
        msg._spcCds = cookie?.value || '';
        msg._spcCdsVer = verCookie?.value || '2';
        // 转发到 content script，content script 的响应会通过 Promise 返回
        return browser.tabs.sendMessage(activeTab.id, msg);
      }
    });
  },
});
