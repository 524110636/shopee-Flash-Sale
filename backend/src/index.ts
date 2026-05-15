import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { execSync } from 'child_process';
import { initializeDatabase } from './db/index.js';
import authRoutes from './routes/auth.js';
import storesRoutes from './routes/stores.js';
import analyticsRoutes from './routes/analytics.js';
import adminRoutes from './routes/admin.js';

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

  const server = serve({ fetch: app.fetch, port: PORT });
  console.log(`[Server] Listening on http://localhost:${PORT}`);

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${PORT} in use, killing existing process...`);
      try { execSync(`npx kill-port ${PORT}`, { stdio: 'ignore' }); } catch {}
      server.listen(PORT);
    } else {
      throw err;
    }
  });
}

main().catch((err) => {
  console.error('[Server] Failed to start:', err);
  process.exit(1);
});
