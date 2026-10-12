/**
 * 第 6 阶段浏览器验收：扩展加载后
 * 1) 扩展包内已无旧管理面板（DOM 无「管理后台」）
 * 2) 管理员顶栏「管理」按钮打开已配置后端的 /admin/ 新标签页
 * 3) 卖家登录态与店铺绑定展示仍正常（本地隔离后端 5725）
 *
 * 前置：隔离后端在 5725 运行（见同目录 start-iso-backend.ps1），扩展已 npm run build。
 * 运行：在仓库根目录执行 npx tsx artifacts/agent/standalone-admin-site/verify-stage6-entry.ts
 * 每次运行都重建 profile，避免旧 token 在首次加载时打到生产后端。
 * 不访问虾皮、不连生产库、不执行店铺写操作。
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const BACKEND = 'http://localhost:5725';
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'AdminPass123!';
const EXT = resolve(process.cwd(), '.output', 'chrome-mv3');
const SHOT_DIR = resolve(process.cwd(), 'artifacts', 'agent', 'standalone-admin-site', 'stage6');
mkdirSync(SHOT_DIR, { recursive: true });

const results: string[] = [];
let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    failures += 1;
    results.push(`FAIL  ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 隔离库需要普通用户才能验证「非管理员看不到管理入口」。 */
await check('准备隔离库普通用户账号', async () => {
  const { createClient } = (await import(
    'file:///D:/shopee_xm/%E8%99%BE%E7%9A%AE%E9%99%90%E6%97%B6%E7%89%B9%E5%8D%96-%E6%9B%B4%E6%96%B0%E8%BF%AD%E4%BB%A3/backend/node_modules/@libsql/client/lib-esm/node.js'
  )) as typeof import('@libsql/client');
  const bcrypt = (
    await import(
      'file:///D:/shopee_xm/%E8%99%BE%E7%9A%AE%E9%99%90%E6%97%B6%E7%89%B9%E5%8D%96-%E6%9B%B4%E6%96%B0%E8%BF%AD%E4%BB%A3/backend/node_modules/bcryptjs/index.js'
    )
  ).default;
  const dbPath = resolve(process.cwd(), '.agent-tmp', 'standalone-admin-site', 'data', 'sale.db');
  const client = createClient({ url: `file:${dbPath}` });
  const hash = await bcrypt.hash('DemoPass123!', 10);
  const found = await client.execute({
    sql: 'SELECT id FROM users WHERE email = ?',
    args: ['demo@test.local'],
  });
  if (found.rows.length === 0) {
    await client.execute({
      sql: 'INSERT INTO users (email, password_hash, role, is_active, trial_enabled, auto_mode_enabled, trial_used, max_stores) VALUES (?, ?, ?, ?, 1, 0, 0, 1)',
      args: ['demo@test.local', hash, 'user', 1],
    });
  } else {
    await client.execute({
      sql: 'UPDATE users SET password_hash = ?, role = ?, is_active = 1 WHERE id = ?',
      args: [hash, 'user', Number(found.rows[0].id)],
    });
  }
  client.close();
});

const userDataDir = resolve(process.cwd(), '.agent-tmp', 'stage6', 'profile');
rmSync(userDataDir, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(userDataDir, {
  executablePath:
    'C:\\Users\\52411\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe',
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'],
});

let sw = ctx.serviceWorkers()[0];
for (let i = 0; i < 40 && !sw; i++) {
  await new Promise((r) => setTimeout(r, 500));
  sw = ctx.serviceWorkers()[0];
}
if (!sw) throw new Error('扩展 Service Worker 未注册');
const extId = sw.url().split('/')[2];
console.log('extension id:', extId);

const page = await ctx.newPage();
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() === 401) console.log('[diag] 401 来自:', r.url());
});

await page.goto(`chrome-extension://${extId}/popup.html`);
// 持久化 profile 会保留上一轮的登录态，先清干净再验「未登录」场景
await page.evaluate(async () => {
  await chrome.storage.local.clear();
});
await page.reload();
await page.waitForTimeout(1500);

const adminBtn = () => page.getByRole('button', { name: '管理', exact: true });

await check('旧管理面板已移除（弹窗内无「管理后台」）', async () => {
  const html = await page.content();
  assert.ok(!html.includes('管理后台'), '弹窗仍渲染旧管理面板');
});

await check('未登录时不显示顶栏「管理」按钮', async () => {
  assert.equal(await adminBtn().count(), 0, '未登录却出现「管理」按钮');
});

// 用隔离后端的真实管理员登录（走后端接口取得 token，再写入扩展存储）
const loginRes = await fetch(`${BACKEND}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
});
const loginData = (await loginRes.json()) as { token: string; user: Record<string, unknown> };
assert.ok(loginData.token, '隔离后端未返回 token');

await page.evaluate(
  async ([token, user, backend]) => {
    await chrome.storage.local.set({ backendAuth: { token, user }, backendUrl: backend });
  },
  [loginData.token, loginData.user, BACKEND] as const,
);
await page.reload();
await page.waitForTimeout(2500);

await check('管理员登录后显示顶栏「管理」按钮', async () => {
  await adminBtn().first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: resolve(SHOT_DIR, 'popup-admin-entry.png') });
});

await check('登录态正常（显示管理员邮箱）', async () => {
  const body = await page.locator('body').innerText();
  assert.ok(body.includes(ADMIN_EMAIL), `未显示登录邮箱：${body.slice(0, 300)}`);
});

let newPageUrl = '';
await check('点「管理」在新标签页打开已配置后端的 /admin/', async () => {
  const popupPromise = ctx.waitForEvent('page', { timeout: 15000 });
  await adminBtn().first().click();
  const newPage = await popupPromise;
  await newPage.waitForLoadState('domcontentloaded');
  await newPage.waitForURL(/\/admin\/?$/, { timeout: 15000 });
  newPageUrl = newPage.url();
  await newPage.screenshot({ path: resolve(SHOT_DIR, 'admin-site-opened.png') });
  assert.equal(newPageUrl, `${BACKEND}/admin/`, `打开的地址不对：${newPageUrl}`);
  const title = await newPage.title();
  assert.ok(title.includes('管理后台'), `新页面标题异常：${title}`);
  await newPage.close();
});

await check('打开成功时不误显示失败提示', async () => {
  const body = await page.locator('body').innerText();
  assert.ok(!body.includes('无法打开管理网站'), '正常打开却显示了失败提示');
});

await check('卖家流程入口仍在（自动模式 / 第一次使用）', async () => {
  const body = await page.locator('body').innerText();
  assert.ok(body.includes('自动模式'), '缺少自动模式入口');
  assert.ok(body.includes('第一次使用'), '缺少第一次使用入口');
});

// ---- 新窗口被拦截：应给出可复制的地址（仍在管理员登录态下验证）----
await check('新窗口被拦截时提示可手动打开的地址', async () => {
  await page.evaluate(() => {
    (window as unknown as { open: unknown }).open = () => null;
  });
  await adminBtn().first().click();
  await page.waitForTimeout(500);
  const body = await page.locator('body').innerText();
  assert.ok(body.includes('无法打开管理网站'), '未显示失败提示');
  assert.ok(body.includes(`${BACKEND}/admin/`), '提示中没有可手动打开的地址');
  await page.screenshot({ path: resolve(SHOT_DIR, 'popup-blocked-notice.png') });
});

await check('无页面级报错', async () => {
  const real = pageErrors.filter((t) => !/favicon|ERR_CONNECTION_REFUSED/.test(t));
  assert.equal(real.length, 0, `页面报错：${real.join(' | ')}`);
});

// ---- 普通用户：不应出现「管理」按钮 ----
const demoRes = await fetch(`${BACKEND}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'demo@test.local', password: 'DemoPass123!' }),
});
const demoData = (await demoRes.json()) as { token?: string; user?: Record<string, unknown> };

await check('普通用户登录后不显示「管理」按钮', async () => {
  assert.ok(demoData.token && demoData.user, '隔离库普通用户登录失败');
  await page.evaluate(
    async ([token, user, backend]) => {
      await chrome.storage.local.set({ backendAuth: { token, user }, backendUrl: backend });
    },
    [demoData.token, demoData.user, BACKEND] as const,
  );
  await page.reload();
  await page.waitForTimeout(2500);
  assert.equal(await adminBtn().count(), 0, '普通用户却看到「管理」按钮');
  const body = await page.locator('body').innerText();
  assert.ok(body.includes('使用说明'), '普通用户侧按钮缺失');
});

// ---- 管理员没有任何绑定：管理入口与失败提示都必须可见（旧门控 !showAdminPanel 已移除，需守住这条）----
/** 把隔离库里管理员的有效绑定临时置为无效，返回复原函数。 */
async function deactivateAdminBindings(): Promise<() => Promise<void>> {
  const { createClient } = (await import(
    'file:///D:/shopee_xm/%E8%99%BE%E7%9A%AE%E9%99%90%E6%97%B6%E7%89%B9%E5%8D%96-%E6%9B%B4%E6%96%B0%E8%BF%AD%E4%BB%A3/backend/node_modules/@libsql/client/lib-esm/node.js'
  )) as typeof import('@libsql/client');
  const dbPath = resolve(process.cwd(), '.agent-tmp', 'standalone-admin-site', 'data', 'sale.db');
  const client = createClient({ url: `file:${dbPath}` });
  const before = await client.execute({
    sql: 'SELECT id FROM store_bindings WHERE user_id = 1 AND is_active = 1',
    args: [],
  });
  assert.ok(before.rows.length > 0, '前置条件不满足：隔离库里管理员本就没有有效绑定');
  const ids = before.rows.map((r) => Number(r.id));
  await client.execute({
    sql: 'UPDATE store_bindings SET is_active = 0 WHERE user_id = 1',
    args: [],
  });
  return async () => {
    for (const id of ids) {
      await client.execute({
        sql: 'UPDATE store_bindings SET is_active = 1 WHERE id = ?',
        args: [id],
      });
    }
    client.close();
  };
}

const restoreBindings = await deactivateAdminBindings();
try {
  await page.evaluate(
    async ([token, user, backend]) => {
      await chrome.storage.local.set({ backendAuth: { token, user }, backendUrl: backend });
    },
    [loginData.token, loginData.user, BACKEND] as const,
  );
  await page.reload();
  await page.waitForTimeout(2500);

  await check('无绑定管理员：页面进入「请先绑定店铺」状态', async () => {
    const body = await page.locator('body').innerText();
    assert.ok(body.includes('请先绑定店铺'), `未进入未绑定状态，实际：${body.slice(0, 300)}`);
  });

  await check('无绑定管理员：顶栏「管理」按钮仍可用并能打开网站', async () => {
    await adminBtn().first().waitFor({ timeout: 10000 });
    const popupPromise = ctx.waitForEvent('page', { timeout: 15000 });
    await adminBtn().first().click();
    const newPage = await popupPromise;
    await newPage.waitForURL(/\/admin\/?$/, { timeout: 15000 });
    assert.equal(newPage.url(), `${BACKEND}/admin/`);
    await newPage.close();
    await page.waitForTimeout(300);
  });

  // 6.5 回归：未绑定状态下窗口被拦截，提示必须可见（此前提示被放在店铺状态分支内，不渲染）
  await check('无绑定管理员 + 新窗口被拦截：显示错误与可手动打开的地址', async () => {
    await page.evaluate(() => {
      (window as unknown as { open: unknown }).open = () => null;
    });
    await adminBtn().first().click();
    await page.waitForTimeout(500);
    const body = await page.locator('body').innerText();
    assert.ok(body.includes('无法打开管理网站'), `未显示失败标题：${body.slice(0, 400)}`);
    assert.ok(body.includes(`${BACKEND}/admin/`), `未显示可手动打开的地址：${body.slice(0, 400)}`);
    await page.screenshot({ path: resolve(SHOT_DIR, 'popup-blocked-no-binding.png') });
  });
} finally {
  await restoreBindings();
}

// 复原后：正常打开不应误显示错误提示
await check('恢复绑定后正常打开，不误显示错误提示', async () => {
  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).open;
  });
  await page.reload();
  await page.waitForTimeout(2500);
  assert.equal(await page.getByText('无法打开管理网站').count(), 0, '正常状态却显示了失败提示');
});

await ctx.close();

console.log('\n' + results.join('\n'));
console.log(`\n新标签页地址: ${newPageUrl}`);
console.log(`\n合计 ${results.length} 项，失败 ${failures} 项`);
process.exit(failures > 0 ? 1 : 0);
