/**
 * 隔离验收脚本：使用独立 SQLite 库（DB_PATH 指向 .agent-tmp）验证管理接口鉴权与脱敏。
 * 不读取正式数据库、不访问虾皮、不调用真实店铺接口。
 */
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';

const BASE = `http://localhost:${process.env.PORT || '5725'}`;
const DB_PATH = process.env.DB_PATH as string;
const JWT_SECRET = process.env.JWT_SECRET as string;

const client = createClient({ url: `file:${DB_PATH}` });
const secret = new TextEncoder().encode(JWT_SECRET);

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

async function req(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text };
}

async function sign(payload: {
  userId: number;
  email: string;
  role: string;
}): Promise<string> {
  return new SignJWT({
    userId: payload.userId,
    email: payload.email,
    role: payload.role,
    autoModeEnabled: 0,
    trialUsed: 0,
    trialEnabled: 1,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .setIssuedAt()
    .sign(secret);
}

async function insertUser(
  email: string,
  role: string,
  isActive: number,
  password: string,
): Promise<number> {
  const hash = await bcrypt.hash(password, 10);
  await client.execute({
    sql: 'INSERT INTO users (email, password_hash, role, is_active, trial_enabled) VALUES (?, ?, ?, ?, 1)',
    args: [email, hash, role, isActive],
  });
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return Number(row.rows[0].id);
}

async function main() {
  const ADMIN_PASSWORD = 'AdminPass123!';

  const adminId = await insertUser('admin@test.local', 'admin', 1, ADMIN_PASSWORD);
  const normalId = await insertUser('normal@test.local', 'user', 1, 'UserPass123!');
  const inactiveId = await insertUser('inactive@test.local', 'user', 0, 'UserPass123!');
  const demotedId = await insertUser('demoted@test.local', 'user', 1, 'UserPass123!');
  const deletedId = await insertUser('deleted@test.local', 'admin', 1, 'UserPass123!');
  await client.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [deletedId] });

  await client.execute({
    sql: 'INSERT INTO store_bindings (user_id, spc_cds, shop_id, shop_name, max_stores, is_active) VALUES (?, ?, ?, ?, 1, 1)',
    args: [normalId, 'SECRET_SPC_CDS_VALUE_1234567890', 777, '测试店铺'],
  });
  await client.execute({
    sql: 'INSERT INTO store_bindings (user_id, spc_cds, max_stores, is_active) VALUES (?, ?, 1, 1)',
    args: [normalId, 'ANOTHER_SECRET_SPC_CDS_0987654321'],
  });

  let adminToken = '';
  await check('管理员登录返回 token', async () => {
    const res = await req('POST', '/api/auth/login', undefined, {
      email: 'admin@test.local',
      password: ADMIN_PASSWORD,
    });
    assert.equal(res.status, 200, `status=${res.status} body=${res.text}`);
    assert.ok(res.json.token, '缺少 token');
    assert.equal(res.json.user.role, 'admin');
    adminToken = res.json.token;
  });

  await check('未激活账号登录被拒', async () => {
    const res = await req('POST', '/api/auth/login', undefined, {
      email: 'inactive@test.local',
      password: 'UserPass123!',
    });
    assert.equal(res.status, 401, `status=${res.status}`);
  });

  await check('密码错误被拒', async () => {
    const res = await req('POST', '/api/auth/login', undefined, {
      email: 'admin@test.local',
      password: 'wrong-password',
    });
    assert.equal(res.status, 401, `status=${res.status}`);
  });

  await check('无 token 访问管理接口被拒 401', async () => {
    const res = await req('GET', '/api/admin/users');
    assert.equal(res.status, 401, `status=${res.status}`);
  });

  await check('普通用户 token 被拒 403', async () => {
    const token = await sign({ userId: normalId, email: 'normal@test.local', role: 'user' });
    const res = await req('GET', '/api/admin/users', token);
    assert.equal(res.status, 403, `status=${res.status}`);
  });

  await check('普通用户伪造 role=admin 的 token 被拒 403', async () => {
    const token = await sign({ userId: normalId, email: 'normal@test.local', role: 'admin' });
    const res = await req('GET', '/api/admin/users', token);
    assert.equal(res.status, 403, `status=${res.status}`);
  });

  await check('未激活账号 token 被拒 403', async () => {
    const token = await sign({ userId: inactiveId, email: 'inactive@test.local', role: 'admin' });
    const res = await req('GET', '/api/admin/users', token);
    assert.equal(res.status, 403, `status=${res.status}`);
  });

  await check('已删除账号旧 token 被拒 403', async () => {
    const token = await sign({ userId: deletedId, email: 'deleted@test.local', role: 'admin' });
    const res = await req('GET', '/api/admin/users', token);
    assert.equal(res.status, 403, `status=${res.status}`);
  });

  await check('撤权后的旧 admin token 被拒 403', async () => {
    const token = await sign({ userId: demotedId, email: 'demoted@test.local', role: 'admin' });
    const res = await req('GET', '/api/admin/users', token);
    assert.equal(res.status, 403, `status=${res.status}`);
  });

  await check('无效 token 被拒 401', async () => {
    const res = await req('GET', '/api/admin/users', 'not-a-real-token');
    assert.equal(res.status, 401, `status=${res.status}`);
  });

  await check('管理员可读取用户列表且含 maxStores 与 bindingCount', async () => {
    const res = await req('GET', '/api/admin/users', adminToken);
    assert.equal(res.status, 200, `status=${res.status}`);
    const target = res.json.users.find((u: any) => u.id === normalId);
    assert.ok(target, '未找到测试用户');
    assert.equal(typeof target.maxStores, 'number', 'maxStores 缺失');
    assert.equal(target.bindingCount, 2, `bindingCount=${target.bindingCount}`);
    assert.ok(!res.text.includes('password'), '响应不应包含密码字段');
  });

  await check('用户列表不包含已删除账号', async () => {
    const res = await req('GET', '/api/admin/users', adminToken);
    assert.ok(!res.json.users.some((u: any) => u.id === deletedId), '已删除账号仍出现');
  });

  await check('绑定列表不返回 SPC_CDS', async () => {
    const res = await req('GET', '/api/admin/bindings', adminToken);
    assert.equal(res.status, 200, `status=${res.status}`);
    assert.ok(!res.text.includes('SECRET_SPC_CDS'), '响应正文泄露了 SPC_CDS');
    assert.ok(!res.text.includes('spcCds'), '响应含 spcCds 字段');
    const missingShop = res.json.bindings.find((b: any) => b.shopId === null);
    assert.ok(missingShop, '未找到缺 shopId 的绑定');
  });

  await check('按 userId 查询可看到已解绑记录', async () => {
    const bindings = await client.execute({
      sql: 'SELECT id FROM store_bindings WHERE user_id = ? ORDER BY id LIMIT 1',
      args: [normalId],
    });
    const bindingId = Number(bindings.rows[0].id);
    const del = await req('DELETE', `/api/admin/bindings/${bindingId}`, adminToken);
    assert.equal(del.status, 200, `解绑 status=${del.status}`);

    const res = await req('GET', `/api/admin/bindings?userId=${normalId}`, adminToken);
    const target = res.json.bindings.find((b: any) => b.id === bindingId);
    assert.ok(target, '按 userId 未查到记录');
    assert.equal(target.isActive, 0, '解绑后 isActive 应为 0');

    const activeOnly = await req('GET', '/api/admin/bindings', adminToken);
    assert.ok(!activeOnly.json.bindings.some((b: any) => b.id === bindingId), '默认列表仍含已解绑');
  });

  await check('管理员不能删除自身（userId 校验）', async () => {
    const res = await req('DELETE', `/api/admin/users/${adminId}`, adminToken);
    assert.equal(res.status, 400, `status=${res.status} body=${res.text}`);
    const still = await req('GET', '/api/admin/users', adminToken);
    assert.ok(still.json.users.some((u: any) => u.id === adminId), '管理员账号被删除');
  });

  await check('调整店铺限额并回读一致', async () => {
    const res = await req('PATCH', `/api/admin/users/${normalId}/store-limit`, adminToken, {
      maxStores: 5,
    });
    assert.equal(res.status, 200, `status=${res.status}`);
    const list = await req('GET', '/api/admin/users', adminToken);
    assert.equal(list.json.users.find((u: any) => u.id === normalId).maxStores, 5);
  });

  await check('限额非法值被拒 400', async () => {
    const res = await req('PATCH', `/api/admin/users/${normalId}/store-limit`, adminToken, {
      maxStores: 0,
    });
    assert.equal(res.status, 400, `status=${res.status}`);
  });

  await check('自动模式权限开关生效', async () => {
    const on = await req('PATCH', `/api/admin/users/${normalId}/auto-mode`, adminToken, {
      autoModeEnabled: 1,
    });
    assert.equal(on.status, 200, `status=${on.status}`);
    const list = await req('GET', '/api/admin/users', adminToken);
    assert.equal(list.json.users.find((u: any) => u.id === normalId).autoModeEnabled, 1);
  });

  await check('试用标记已用与重置生效', async () => {
    await req('PATCH', `/api/admin/users/${normalId}/trial`, adminToken, { trialUsed: 1 });
    let list = await req('GET', '/api/admin/users', adminToken);
    assert.equal(list.json.users.find((u: any) => u.id === normalId).trialUsed, 1);
    await req('PATCH', `/api/admin/users/${normalId}/trial`, adminToken, { trialUsed: 0 });
    list = await req('GET', '/api/admin/users', adminToken);
    assert.equal(list.json.users.find((u: any) => u.id === normalId).trialUsed, 0);
  });

  await check('试用限制开关生效且非法值被拒', async () => {
    const off = await req('PATCH', `/api/admin/users/${normalId}/trial-enabled`, adminToken, {
      trialEnabled: 0,
    });
    assert.equal(off.status, 200, `status=${off.status}`);
    let list = await req('GET', '/api/admin/users', adminToken);
    assert.equal(list.json.users.find((u: any) => u.id === normalId).trialEnabled, 0);

    const bad = await req('PATCH', `/api/admin/users/${normalId}/trial-enabled`, adminToken, {
      trialEnabled: 2,
    });
    assert.equal(bad.status, 400, `status=${bad.status}`);

    await req('PATCH', `/api/admin/users/${normalId}/trial-enabled`, adminToken, {
      trialEnabled: 1,
    });
    list = await req('GET', '/api/admin/users', adminToken);
    assert.equal(list.json.users.find((u: any) => u.id === normalId).trialEnabled, 1);
  });

  await check('生成邀请码超过上限被截断为 20', async () => {
    const res = await req('POST', '/api/admin/invite-codes', adminToken, { count: 25 });
    assert.equal(res.status, 201, `status=${res.status}`);
    assert.equal(res.json.count, 20, `count=${res.json.count}`);
    const one = await req('POST', '/api/admin/invite-codes', adminToken, { count: 1 });
    assert.equal(one.json.count, 1);
  });

  await check('邀请码列表含使用状态字段', async () => {
    const res = await req('GET', '/api/admin/invite-codes', adminToken);
    assert.equal(res.status, 200, `status=${res.status}`);
    assert.ok(res.json.inviteCodes.length >= 21, '邀请码数量不符');
    const first = res.json.inviteCodes[0];
    assert.ok('isUsed' in first && 'createdAt' in first && 'usedAt' in first);
  });

  await check('删除未使用邀请码成功', async () => {
    const list = await req('GET', '/api/admin/invite-codes', adminToken);
    const unused = list.json.inviteCodes.find((c: any) => c.isUsed === 0);
    const res = await req('DELETE', `/api/admin/invite-codes/${unused.id}`, adminToken);
    assert.equal(res.status, 200, `status=${res.status}`);
    const after = await req('GET', '/api/admin/invite-codes', adminToken);
    assert.ok(!after.json.inviteCodes.some((c: any) => c.id === unused.id), '删除未生效');
  });

  await check('删除已使用邀请码被服务端拒绝 400', async () => {
    await client.execute({
      sql: "UPDATE invite_codes SET is_used = 1, used_by = ?, used_at = datetime('now') WHERE id = (SELECT id FROM invite_codes WHERE is_used = 0 LIMIT 1)",
      args: [normalId],
    });
    const refreshed = await req('GET', '/api/admin/invite-codes', adminToken);
    const target = refreshed.json.inviteCodes.find((c: any) => c.isUsed === 1);
    assert.ok(target, '没有可用的已使用邀请码');
    const res = await req('DELETE', `/api/admin/invite-codes/${target.id}`, adminToken);
    assert.equal(res.status, 400, `status=${res.status}`);
  });

  await check('删除不存在的邀请码 404', async () => {
    const res = await req('DELETE', '/api/admin/invite-codes/999999', adminToken);
    assert.equal(res.status, 404, `status=${res.status}`);
  });

  await check('统计返回真实计数', async () => {
    const res = await req('GET', '/api/admin/analytics', adminToken);
    assert.equal(res.status, 200, `status=${res.status}`);
    assert.equal(typeof res.json.totalUsers, 'number');
    assert.equal(typeof res.json.totalBindings, 'number');
    assert.ok(Array.isArray(res.json.events));
    assert.equal(res.json.totalUsers, 4, `totalUsers=${res.json.totalUsers}`);
  });

  await check('事件明细上限 100 条且按类型过滤', async () => {
    for (let i = 0; i < 120; i++) {
      await client.execute({
        sql: 'INSERT INTO analytics_events (user_id, event_type, event_data) VALUES (?, ?, ?)',
        args: [normalId, i % 2 === 0 ? 'enable_loop' : 'copy_flow', JSON.stringify({ i })],
      });
    }
    const all = await req('GET', '/api/admin/analytics/events', adminToken);
    assert.equal(all.status, 200, `status=${all.status}`);
    assert.equal(all.json.events.length, 100, `events=${all.json.events.length}`);

    const filtered = await req('GET', '/api/admin/analytics/events?type=enable_loop', adminToken);
    assert.ok(
      filtered.json.events.every((e: any) => e.eventType === 'enable_loop'),
      '类型过滤失效',
    );
    assert.ok(filtered.json.events.length > 0, '过滤后无数据');
  });

  await check('事件明细按类型白名单脱敏，不泄露未知字段', async () => {
    const FAKE_TOKEN = 'FAKE_REGRESSION_TOKEN_NOT_A_SECRET';
    const FAKE_SPC = 'FAKE_REGRESSION_SPC_NOT_A_SECRET';
    const FAKE_COOKIE = 'FAKE_REGRESSION_COOKIE_NOT_A_SECRET';

    await client.execute({
      sql: 'INSERT INTO analytics_events (user_id, event_type, event_data) VALUES (?, ?, ?)',
      args: [
        adminId,
        'enable_loop',
        JSON.stringify({
          totalSkus: 7,
          successSkus: 6,
          failedSkus: 1,
          rounds: 2,
          token: FAKE_TOKEN,
          spcCds: FAKE_SPC,
          cookie: FAKE_COOKIE,
          nested: { token: FAKE_TOKEN },
        }),
      ],
    });
    await client.execute({
      sql: 'INSERT INTO analytics_events (user_id, event_type, event_data) VALUES (?, ?, ?)',
      args: [adminId, 'unknown_type', JSON.stringify({ token: FAKE_TOKEN, spcCds: FAKE_SPC })],
    });

    const res = await req('GET', '/api/admin/analytics/events', adminToken);
    assert.equal(res.status, 200, `status=${res.status}`);

    for (const fake of [FAKE_TOKEN, FAKE_SPC, FAKE_COOKIE]) {
      assert.ok(!res.text.includes(fake), `响应泄露了虚构凭据值 ${fake}`);
    }
    assert.ok(!res.text.includes('spcCds'), '响应仍保留 spcCds 字段名');
    assert.ok(!res.text.includes('cookie'), '响应仍保留 cookie 字段名');

    const known = res.json.events.find((e: any) => e.eventType === 'enable_loop');
    assert.ok(known, '未找到 enable_loop 事件');
    assert.deepEqual(
      known.eventData,
      { totalSkus: 7, successSkus: 6, failedSkus: 1, rounds: 2 },
      `白名单字段丢失或被扩写：${JSON.stringify(known.eventData)}`,
    );

    const unknown = res.json.events.find((e: any) => e.eventType === 'unknown_type');
    assert.ok(unknown, '未找到未知类型事件');
    assert.equal(unknown.eventData, null, '未知类型仍透传了事件数据');
  });

  await check('继承成员名的事件不使接口报错，且整页仍可读取', async () => {
    // `constructor` / `__proto__` / `toString` 会命中对象继承成员，曾导致 500 并拖垮整页。
    const INHERITED_NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

    for (const name of INHERITED_NAMES) {
      const posted = await req('POST', '/api/analytics/events', adminToken, {
        eventType: name,
        eventData: { probe: true, token: 'FAKE_INHERITED_TOKEN_NOT_A_SECRET' },
      });
      assert.equal(posted.status, 201, `上报 ${name} status=${posted.status}`);
    }

    for (const name of INHERITED_NAMES) {
      const one = await req(
        'GET',
        `/api/admin/analytics/events?type=${encodeURIComponent(name)}`,
        adminToken,
      );
      assert.equal(one.status, 200, `按 ${name} 过滤 status=${one.status}`);
      const hit = one.json.events.find((e: any) => e.eventType === name);
      assert.ok(hit, `未返回 ${name} 的记录`);
      assert.equal(hit.eventData, null, `${name} 的 eventData 未收敛为 null`);
      assert.ok(
        !one.text.includes('FAKE_INHERITED_TOKEN_NOT_A_SECRET'),
        `${name} 的响应泄露了虚构凭据`,
      );
    }

    // 关键：一条这类脏数据不能让整张明细列表读不出来。
    const all = await req('GET', '/api/admin/analytics/events', adminToken);
    assert.equal(all.status, 200, `整页查询 status=${all.status}`);
    assert.ok(all.json.events.length > 0, '整页查询返回空列表');
  });

  await check('删除测试用户并级联清理绑定与事件', async () => {
    const res = await req('DELETE', `/api/admin/users/${normalId}`, adminToken);
    assert.equal(res.status, 200, `status=${res.status} body=${res.text}`);

    const list = await req('GET', '/api/admin/users', adminToken);
    assert.ok(!list.json.users.some((u: any) => u.id === normalId), '用户未被删除');

    const bindings = await client.execute({
      sql: 'SELECT COUNT(*) AS c FROM store_bindings WHERE user_id = ?',
      args: [normalId],
    });
    assert.equal(Number(bindings.rows[0].c), 0, '绑定未被级联删除');

    const events = await client.execute({
      sql: 'SELECT COUNT(*) AS c FROM analytics_events WHERE user_id = ?',
      args: [normalId],
    });
    assert.equal(Number(events.rows[0].c), 0, '事件未被级联删除');
  });

  await check('删除不存在用户 404', async () => {
    const res = await req('DELETE', '/api/admin/users/999999', adminToken);
    assert.equal(res.status, 404, `status=${res.status}`);
  });

  await check('创建记录的 created_at 是真实时间而非字面量', async () => {
    // 邀请码经 Drizzle insert 写入，created_at 必须由 SQLite 求值为时间文本。
    const rows = await client.execute('SELECT created_at FROM invite_codes LIMIT 5');
    assert.ok(rows.rows.length > 0, '没有邀请码可检查');
    for (const row of rows.rows) {
      assert.notEqual(row.created_at, 'CURRENT_TIMESTAMP', 'created_at 存成了字面量字符串');
      assert.match(
        String(row.created_at),
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
        `created_at 格式异常：${row.created_at}`,
      );
    }
  });

  await check('事件与绑定的 created_at 是真实时间（走真实插入路径）', async () => {
    // 通过真实接口触发 Drizzle 插入，验证 schema 默认值是否正确求值。
    const evt = await req('POST', '/api/analytics/events', adminToken, {
      eventType: 'timestamp_check',
      eventData: { probe: true },
    });
    assert.equal(evt.status, 201, `事件上报 status=${evt.status}`);

    const bind = await req('POST', '/api/stores/bind', adminToken, {
      spcCds: 'TIMESTAMP_CHECK_SPC_CDS_FIXTURE',
      shopId: 424242,
      shopName: '时间戳自检店铺',
    });
    assert.ok(bind.status === 200 || bind.status === 201, `绑定 status=${bind.status}`);

    for (const [table, where] of [
      ['analytics_events', "event_type = 'timestamp_check'"],
      ['store_bindings', 'shop_id = 424242'],
    ] as const) {
      const rows = await client.execute(`SELECT created_at FROM ${table} WHERE ${where}`);
      assert.ok(rows.rows.length > 0, `${table} 没有记录可检查`);
      for (const row of rows.rows) {
        assert.notEqual(row.created_at, 'CURRENT_TIMESTAMP', `${table} 存成字面量`);
        assert.match(
          String(row.created_at),
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
          `${table} created_at 格式异常：${row.created_at}`,
        );
      }
    }
  });

  await check('注册路径的用户与验证码 created_at 是真实时间', async () => {
    // 走真实注册接口，验证 users / verification_codes 的默认值
    const invite = await req('POST', '/api/admin/invite-codes', adminToken, { count: 1 });
    const code = invite.json.codes[0];
    const reg = await req('POST', '/api/auth/register', undefined, {
      email: 'newreg@test.local',
      password: 'NewReg123!',
      inviteCode: code,
    });
    assert.ok(reg.status === 201, `注册 status=${reg.status} body=${reg.text}`);

    const userRows = await client.execute({
      sql: 'SELECT created_at, updated_at FROM users WHERE email = ?',
      args: ['newreg@test.local'],
    });
    assert.notEqual(userRows.rows[0].created_at, 'CURRENT_TIMESTAMP', 'users.created_at 是字面量');
    assert.notEqual(userRows.rows[0].updated_at, 'CURRENT_TIMESTAMP', 'users.updated_at 是字面量');

    const codeRows = await client.execute({
      sql: 'SELECT created_at FROM verification_codes WHERE email = ?',
      args: ['newreg@test.local'],
    });
    assert.notEqual(
      codeRows.rows[0].created_at,
      'CURRENT_TIMESTAMP',
      'verification_codes.created_at 是字面量',
    );
  });

  await check('/api/health 正常', async () => {
    const res = await req('GET', '/api/health');
    assert.equal(res.status, 200, `status=${res.status}`);
  });

  console.log('\n===== 隔离验收结果 =====');
  for (const line of results) console.log(line);
  console.log(`\n合计：${results.length} 项，失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[verify] 脚本异常:', e);
  process.exit(2);
});
