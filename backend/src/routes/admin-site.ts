import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * 托管独立管理网站（admin-web 的构建产物）。
 *
 * 只覆盖 /admin 与 /admin/* 路径，不影响 /api 与健康检查。
 * 开发阶段构建产物可能不存在，此时明确报错，不返回模拟页面。
 */

// 构建产物目录：可用 ADMIN_WEB_DIST 覆盖（测试或自定义部署）。
const DIST_DIR = process.env.ADMIN_WEB_DIST || join(process.cwd(), '..', 'admin-web', 'dist');
const INDEX_FILE = join(DIST_DIR, 'index.html');

export const adminSite = new Hono();

/** 构建缺失时的可操作提示（不返回模拟页面）。 */
function notBuiltHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>管理网站未构建</title></head>
<body style="font-family:system-ui;padding:40px;line-height:1.7">
<h2>管理网站尚未构建</h2>
<p>未找到构建产物：<code>${DIST_DIR}</code></p>
<p>请在仓库根目录的 <code>admin-web</code> 目录执行：</p>
<pre>npm install
npm run build</pre>
<p>完成后刷新本页。</p>
</body></html>`;
}

adminSite.get('/admin', (c) => c.redirect('/admin/', 302));

adminSite.get('/admin/', (c) => {
  if (!existsSync(INDEX_FILE)) {
    return c.html(notBuiltHtml(), 503);
  }
  return c.html(readFileSync(INDEX_FILE, 'utf-8'));
});

// Vite 构建产物资源（/admin/assets/*）由静态文件中间件提供。
adminSite.use(
  '/admin/assets/*',
  serveStatic({
    root: DIST_DIR,
    rewriteRequestPath: (path) => path.replace(/^\/admin/, ''),
  }),
);
