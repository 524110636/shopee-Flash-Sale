import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground({
  main() {
    console.log('[限时特卖助手] Background 已启动');

    browser.runtime.onInstalled.addListener((details) => {
      console.log('[限时特卖助手] 已安装/更新:', details.reason);
    });

    // 消息中继：Popup (runtime.sendMessage) → Background → Content Script (tabs.sendMessage)
    // 因为 runtime.sendMessage 不会直接到达 content script
    browser.runtime.onMessage.addListener(async (msg: any) => {
      const type = msg?.type;
      if (type === 'SPC_CDS_REQUEST' || type === 'FETCH_PRODUCTS') {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const activeTab = tabs[0];
        if (!activeTab?.id) {
          throw new Error('没有找到活跃的标签页');
        }
        if (!activeTab.url?.includes('seller.shopee.tw')) {
          throw new Error('请先在虾皮卖家中心 (seller.shopee.tw) 打开此扩展');
        }
        // 转发到 content script，content script 的响应会通过 Promise 返回
        return browser.tabs.sendMessage(activeTab.id, msg);
      }
    });
  },
});
