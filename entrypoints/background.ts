import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground({
  main() {
    console.log('[限时特卖助手] Background 已启动');

    browser.runtime.onInstalled.addListener((details) => {
      console.log('[限时特卖助手] 已安装/更新:', details.reason);
    });

    browser.runtime.onMessage.addListener(async (msg: any) => {
      const type = msg?.type;

      // SPC_CDS_REQUEST: 直接从 Cookie 读取
      if (type === 'SPC_CDS_REQUEST') {
        // 检查 cookies 权限（chrome.runtime.lastError 会在 api 调用时体现）
        try {
          const cookie = await browser.cookies.get({
            url: 'https://seller.shopee.tw',
            name: 'SPC_CDS',
          });
          const verCookie = await browser.cookies.get({
            url: 'https://seller.shopee.tw',
            name: 'SPC_CDS_VER',
          });

          if (!cookie?.value) {
            // Cookie 存在但值为空，或者 Cookie 不存在
            return { spcCds: '', spcCdsVer: '2', error: 'SPC_CDS 不存在，请确认：\n1. 已登录虾皮卖家中心 (seller.shopee.tw)\n2. 刷新页面后再试' };
          }

          return {
            spcCds: cookie.value,
            spcCdsVer: verCookie?.value || '2',
          };
        } catch (e: any) {
          // chrome.cookies.get() 失败，通常是权限问题
          const msg = (e?.message || '').toLowerCase();
          if (msg.includes('permission')) {
            return { spcCds: '', spcCdsVer: '2', error: 'Chrome Cookie 权限被拒绝，请在扩展管理页面检查权限设置后重新加载扩展' };
          }
          return { spcCds: '', spcCdsVer: '2', error: `读取 Cookie 失败: ${e?.message || '未知错误'}` };
        }
      }

      // FETCH_PRODUCTS: 转发到 Content Script
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

        // 2. 读取 SPC_CDS
        try {
          const cookie = await browser.cookies.get({
            url: 'https://seller.shopee.tw',
            name: 'SPC_CDS',
          });
          const verCookie = await browser.cookies.get({
            url: 'https://seller.shopee.tw',
            name: 'SPC_CDS_VER',
          });
          if (!cookie?.value) {
            return { type: 'FETCH_PRODUCTS_ERROR', error: 'SPC_CDS Cookie 不存在，请先在虾皮卖家中心登录并刷新页面' };
          }
          msg._spcCds = cookie.value;
          msg._spcCdsVer = verCookie?.value || '2';
        } catch (e: any) {
          return { type: 'FETCH_PRODUCTS_ERROR', error: `读取 SPC_CDS Cookie 失败: ${e?.message || '未知错误'}` };
        }

        // 3. 转发到 content script（带超时）
        try {
          const result = await Promise.race([
            browser.tabs.sendMessage(activeTab.id, msg),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Content Script 响应超时（10秒），请刷新页面后重试')), 10000)
            ),
          ]);
          return result;
        } catch (e: any) {
          const errMsg = e?.message || '未知错误';
          if (errMsg.includes('Receiving end does not exist')) {
            return { type: 'FETCH_PRODUCTS_ERROR', error: 'Content Script 未加载，请刷新虾皮卖家中心页面后重试' };
          }
          if (errMsg.includes('超时')) {
            return { type: 'FETCH_PRODUCTS_ERROR', error: errMsg };
          }
          return { type: 'FETCH_PRODUCTS_ERROR', error: `请求失败: ${errMsg}` };
        }
      }
    });
  },
});
