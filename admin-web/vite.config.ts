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
      // 弹窗正文里的自有图片用绝对路径 /popup-assets/xxx 引用。
      // 生产由后端托管没问题；开发时 vite 是另一个源，必须把该前缀也代理过去，
      // 否则预览里的图片全部 404（正文能显示、图裂开）。
      '/popup-assets': {
        target: BACKEND_TARGET,
        changeOrigin: true,
      },
    },
  },
});
