import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { initializeDatabase } from './db/index.js';
import authRoutes from './routes/auth.js';
import storesRoutes from './routes/stores.js';
import analyticsRoutes from './routes/analytics.js';
import adminRoutes from './routes/admin.js';
import { adminSite } from './routes/admin-site.js';

const PORT = parseInt(process.env.PORT || '5724', 10);

async function main() {
  await initializeDatabase();

  const app = new Hono();

  app.use('*', cors({
    origin: (origin) => {
      if (!origin) return '*';
      if (origin.startsWith('chrome-extension://')) return origin;
      if (origin === 'https://seller.shopee.tw') return origin;
      return null;
    },
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
  }));

  app.route('/api/auth', authRoutes);
  app.route('/api/stores', storesRoutes);
  app.route('/api/analytics', analyticsRoutes);
  app.route('/api/admin', adminRoutes);

  app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // 独立管理网站（/admin/），仅托管静态构建产物，不影响既有 API。
  app.route('/', adminSite);

  const server = serve({ fetch: app.fetch, port: PORT });
  console.log(`[Server] Listening on http://localhost:${PORT}`);

  // 端口被占用时明确报错退出，不去杀别人的进程（避免影响同机上其他服务）。
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[Server] Port ${PORT} is already in use. 请先停掉占用该端口的服务，或用 PORT=其他端口 启动。`,
      );
      process.exit(1);
    }
    throw err;
  });
}

main().catch((err) => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});
