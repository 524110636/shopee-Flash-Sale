/**
 * 浏览器复核：只针对本轮两项返工，跑在 .agent-tmp 隔离后端（5725）上。
 * 1) 事件明细不泄露虚构凭据，且展示白名单字段
 * 2) 统计首次读取失败时不显示 0 / 不冒充「暂无事件记录」；真实数据正常
 * 不访问虾皮、不连生产库。
 */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = `http://localhost:${process.env.PORT || '5725'}`;
const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'AdminPass123!';

const FAKE_TOKEN = 'FAKE_BROWSER_TOKEN_NOT_A_SECRET';
const FAKE_SPC = 'FAKE_BROWSER_SPC_NOT_A_SECRET';
const FAKE_COOKIE = 'FAKE_BROWSER_COOKIE_NOT_A_SECRET';

// 截图目录固定为仓库内的 artifacts，避免 import.meta.url 对中文路径编码后落到错误位置。
const shotDir = resolve(
  process.cwd(),
  'artifacts',
  'agent',
  'standalone-admin-site',
  'regression',
);
const shotPath = (name: string) => resolve(shotDir, name);

mkdirSync(shotDir, { recursive: true });

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

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
});
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors: string[] = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

async function login() {
  await page.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await page.getByLabel(/邮箱|账号/).or(page.locator('input[type="text"]').first()).first().fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForLoadState('networkidle');
}

/** 登录后默认停在「用户管理」，统计相关断言必须先切到「使用统计」。 */
async function openAnalytics(p: typeof page) {
  await p.getByRole('menuitem', { name: '使用统计' }).click();
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(2000);
}

await check('登录并进入管理界面', async () => {
  await login();
  await page.getByText('使用统计').first().waitFor({ timeout: 15000 });
});

await check('统计页正常加载真实计数（非失败场景）', async () => {
  await openAnalytics(page);
  const body = await page.locator('body').innerText();
  assert.ok(!body.includes('无法读取'), `正常加载却出现「无法读取」：${body.slice(0, 300)}`);
  assert.ok(body.includes('注册用户总数'), '缺少注册用户总数卡片');
});

await check('事件明细不泄露虚构凭据且只显示白名单字段', async () => {
  const body = await page.locator('body').innerText();
  const html = await page.content();
  for (const fake of [FAKE_TOKEN, FAKE_SPC, FAKE_COOKIE]) {
    assert.ok(!body.includes(fake), `页面文本泄露了 ${fake}`);
    assert.ok(!html.includes(fake), `页面 HTML 泄露了 ${fake}`);
  }
  assert.ok(!body.includes('spcCds'), '页面仍出现 spcCds 字段名');
  assert.ok(!body.includes('cookie'), '页面仍出现 cookie 字段名');
  assert.ok(body.includes('商品数: 12'), `未按白名单展示 enable_loop：${body.slice(0, 500)}`);
  assert.ok(body.includes('活动 ID: 998877'), '未按白名单展示 auto_mode_round');
  assert.ok(body.includes('无可展示明细'), '未知类型未标注「无可展示明细」');
  await page.screenshot({ path: shotPath('analytics-redacted.png'), fullPage: true });
});

await check('统计首次读取失败时不显示 0、不冒充暂无记录', async () => {
  const fresh = await browser.newContext();
  const p = await fresh.newPage();
  await p.route('**/api/admin/analytics?*', (route) => route.fulfill({ status: 500, body: 'boom' }));
  await p.route('**/api/admin/analytics', (route) => route.fulfill({ status: 500, body: 'boom' }));

  await p.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await p.locator('input[type="text"]').first().fill(ADMIN_EMAIL);
  await p.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await p.getByRole('button', { name: /登\s*录/ }).click();
  await p.waitForLoadState('networkidle');
  await openAnalytics(p);

  const body = await p.locator('body').innerText();
  assert.ok(body.includes('无法读取'), `失败时未出现「无法读取」：${body.slice(0, 400)}`);
  assert.ok(
    !/注册用户总数[\s\S]{0,40}?\b0\b/.test(body),
    `失败时仍把统计显示为 0：${body.slice(0, 400)}`,
  );
  assert.ok(!body.includes('暂无事件记录'), '失败时冒充「暂无事件记录」');
  await p.screenshot({ path: shotPath('summary-failure-redacted.png'), fullPage: true });
  await fresh.close();
});

await check('真实零事件时仍显示 0，与失败可区分', async () => {
  const fresh = await browser.newContext();
  const p = await fresh.newPage();
  await p.route('**/api/admin/analytics', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ totalUsers: 0, totalBindings: 0, events: [] }),
    }),
  );
  await p.goto(`${BASE}/admin/`, { waitUntil: 'networkidle' });
  await p.locator('input[type="text"]').first().fill(ADMIN_EMAIL);
  await p.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await p.getByRole('button', { name: /登\s*录/ }).click();
  await p.waitForLoadState('networkidle');
  await openAnalytics(p);

  const body = await p.locator('body').innerText();
  assert.ok(!body.includes('无法读取'), '真实零数据被当成失败');
  assert.ok(body.includes('暂无事件记录'), '真实空数据未显示空态');
  await fresh.close();
});

await check('未知与继承成员名事件不使页面崩溃，且不泄露凭据', async () => {
  const body = await page.locator('body').innerText();
  const html = await page.content();
  for (const fake of [FAKE_TOKEN, FAKE_SPC, FAKE_COOKIE, 'FAKE_INHERITED_TOKEN_NOT_A_SECRET']) {
    assert.ok(!body.includes(fake), `页面文本泄露了 ${fake}`);
    assert.ok(!html.includes(fake), `页面 HTML 泄露了 ${fake}`);
  }
  // 继承成员名必须原样显示为事件名，而不是被渲染成函数/对象
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.ok(body.includes(name), `页面未原样显示事件名 ${name}`);
  }
  assert.ok(!body.includes('function'), '页面把继承成员渲染成了函数文本');
  // 整页可读：列表里有数据，且没有出现崩溃空态
  assert.ok(!body.includes('读取失败，无法判断是否有记录'), '整页读取失败');
  await page.screenshot({ path: shotPath('inherited-names.png'), fullPage: true });
});

await check('浏览器无凭据存储且控制台无预期外错误', async () => {
  const storage = await page.evaluate(() => ({
    local: Object.keys(localStorage).length,
    session: Object.keys(sessionStorage).length,
    cookies: document.cookie,
  }));
  assert.equal(storage.local, 0, 'localStorage 非空');
  assert.equal(storage.session, 0, 'sessionStorage 非空');
  assert.equal(storage.cookies, '', '存在 Cookie');
  const unexpected = consoleErrors.filter((t) => !/500|Internal Server Error|Failed to load/i.test(t));
  assert.equal(unexpected.length, 0, `控制台异常：${unexpected.join(' | ')}`);
});

await browser.close();

console.log('\n===== 浏览器复核结果 =====');
for (const line of results) console.log(line);
console.log(`\n合计：${results.length} 项，失败 ${failures} 项`);
process.exit(failures > 0 ? 1 : 0);
