import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground({
  main() {
    console.log('[限时特卖助手] Background 已启动');

    // 当前阶段 background 仅做基本日志和安装事件监听
    // 后续扩展功能（定时任务、批量重试队列）将在此处实现

    browser.runtime.onInstalled.addListener((details) => {
      console.log('[限时特卖助手] 已安装/更新:', details.reason);
    });
  },
});
