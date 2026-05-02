import { defineConfig } from 'wxt';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  extensionApi: 'chrome',
  manifest: {
    name: '限时特卖助手',
    description: '虾皮卖家后台限时特卖自动化工具',
    version: '0.1.0',
    permissions: ['storage', 'cookies', 'scripting', 'alarms'],
    host_permissions: ['https://*.shopee.tw/*'],
  },
  vite: () => ({
    resolve: {
      alias: {
        '@': resolve(__dirname, '.'),
      },
    },
  }),
});
