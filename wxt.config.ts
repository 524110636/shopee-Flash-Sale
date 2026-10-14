import { defineConfig } from 'wxt';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  extensionApi: 'chrome',
  // 用函数式 manifest：开发版换一个名字，使 chrome://extensions 里一眼能分清
  // dev 版与生产版（两者的弹窗行为完全不同——dev 版依赖本地开发服务器）。
  manifest: (env) => {
    const isDev = env.mode === 'development';
    return {
      name: isDev ? '限时特卖助手（开发版）' : '限时特卖助手',
      description: isDev
        ? '【开发版】需保持 npm run dev 终端开启，否则弹窗白屏'
        : '虾皮卖家后台限时特卖自动化工具',
      version: '1.15.2',
      permissions: ['storage', 'cookies', 'scripting', 'alarms', 'unlimitedStorage', 'downloads'],
      host_permissions: ['https://*.shopee.tw/*'],
    };
  },
  vite: () => ({
    resolve: {
      alias: {
        '@': resolve(__dirname, '.'),
      },
    },
  }),
});
