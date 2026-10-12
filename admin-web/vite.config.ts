import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 本地后端地址，仅开发服务器代理使用；可通过环境变量覆盖。
const BACKEND_TARGET = process.env.ADMIN_WEB_BACKEND_TARGET || 'http://localhost:5724';

// base 固定 /admin/：生产由后端 Hono 托管构建产物到 /admin/ 路径。
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5175,
    proxy: {
      '/api': {
        target: BACKEND_TARGET,
        changeOrigin: true,
      },
    },
  },
});
