import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { users, storeBindings, analyticsEvents, verificationCodes, inviteCodes } from '../db/schema.js';
import crypto from 'crypto';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';

const admin = new Hono();

admin.use('*', authMiddleware, adminMiddleware);

/**
 * 事件明细的字段白名单，与扩展 `reportAnalyticsEvent()` 的上报字段一一对应。
 * 未列入的类型一律不输出事件数据：统计接口接受任意 eventData，
 * 原样透传会把 token / spcCds / Cookie 之类的历史脏数据带到管理页面。
 */
const EVENT_DATA_FIELDS: Record<string, readonly string[]> = {
  enable_loop: ['totalSkus', 'successSkus', 'failedSkus', 'rounds'],
  auto_mode_round: ['round', 'totalRounds', 'flashSaleId'],
  auto_mode_stop: ['currentRound', 'totalRounds'],
  copy_flow: ['flashSaleId', 'hasSkuOverrides', 'source'],
};

/**
 * 只保留白名单内的标量字段；未知类型、非对象 JSON、嵌套结构一律丢弃。
 * 返回 null 表示“无可展示数据”，不是“零值”。
 *
 * 为什么用 `Object.hasOwn` 而不是 `EVENT_DATA_FIELDS[eventType] ? ... : null`：
 * 事件名来自上报接口，可以是任意字符串。`constructor`、`__proto__`、`toString`
 * 这类名字会命中对象**继承**来的成员，绕开 `!allowed` 判断；随后对非数组值做
 * `for...of` 会抛错，使事件明细接口返回 500。由于不带类型过滤的列表要遍历全部
 * 记录，一条这类脏数据就会让整个页面读不出数据。只接受白名单自身的键即可避免。
 */
function redactEventData(
  eventType: string,
  eventData: string | null
): Record<string, string | number | boolean> | null {
  if (!Object.hasOwn(EVENT_DATA_FIELDS, eventType)) return null;
  const allowed = EVENT_DATA_FIELDS[eventType];
  if (!Array.isArray(allowed) || !eventData) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(eventData);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const source = parsed as Record<string, unknown>;
  const safe: Record<string, string | number | boolean> = {};
  for (const key of allowed) {
    const value = source[key];
    const isScalar = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (isScalar) safe[key] = value as string | number | boolean;
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

/** 用户列表（含绑定店铺数） */
admin.get('/users', async (c) => {
  const db = getDb();

  const userList = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      isActive: users.isActive,
      maxStores: users.maxStores,
      autoModeEnabled: users.autoModeEnabled,
      trialUsed: users.trialUsed,
      trialEnabled: users.trialEnabled,
      createdAt: users.createdAt,
      bindingCount: sql<number>`(
      SELECT COUNT(*) FROM store_bindings
      WHERE store_bindings.user_id = users.id AND store_bindings.is_active = 1
    )`,
    })
    .from(users)
    .orderBy(desc(users.createdAt), desc(users.id));

  return c.json({ users: userList });
});

/** 调整用户店铺绑定限额 */
admin.patch('/users/:id/store-limit', async (c) => {
  const userId = parseInt(c.req.param('id'), 10);
  const { maxStores } = await c.req.json<{ maxStores: number }>();

  if (!maxStores || maxStores < 1) {
    return c.json({ error: '限额必须大于 0' }, 400);
  }

  const db = getDb();

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    return c.json({ error: '用户不存在' }, 404);
  }

  // 更新用户级限额
  await db.update(users).set({ maxStores }).where(eq(users.id, userId));
  // 同时更新已有绑定的 maxStores（用于前端展示）
  await db.update(storeBindings).set({ maxStores }).where(eq(storeBindings.userId, userId));

  return c.json({ message: `用户 ${user[0].email} 的店铺限额已更新为 ${maxStores}` });
});

/** 切换用户自动模式权限 */
admin.patch('/users/:id/auto-mode', async (c) => {
  const userId = parseInt(c.req.param('id'), 10);
  const { autoModeEnabled } = await c.req.json<{ autoModeEnabled: number }>();

  if (autoModeEnabled !== 0 && autoModeEnabled !== 1) {
    return c.json({ error: 'autoModeEnabled 必须为 0 或 1' }, 400);
  }

  const db = getDb();

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    return c.json({ error: '用户不存在' }, 404);
  }

  await db.update(users).set({ autoModeEnabled }).where(eq(users.id, userId));

  return c.json({
    message: `用户 ${user[0].email} 的自动模式权限已${autoModeEnabled ? '开启' : '关闭'}`,
    autoModeEnabled,
  });
});

/** 重置用户试用状态 */
admin.patch('/users/:id/trial', async (c) => {
  const userId = parseInt(c.req.param('id'), 10);
  const { trialUsed } = await c.req.json<{ trialUsed: number }>();

  if (trialUsed !== 0 && trialUsed !== 1) {
    return c.json({ error: 'trialUsed 必须为 0 或 1' }, 400);
  }

  const db = getDb();

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    return c.json({ error: '用户不存在' }, 404);
  }

  await db.update(users).set({ trialUsed }).where(eq(users.id, userId));

  return c.json({
    message: `用户 ${user[0].email} 的试用状态已${trialUsed ? '标记为已使用' : '重置'}`,
    trialUsed,
  });
});

/** 切换用户试用限制开关（关闭后用户可永久使用手动模式） */
admin.patch('/users/:id/trial-enabled', async (c) => {
  const userId = parseInt(c.req.param('id'), 10);
  const { trialEnabled } = await c.req.json<{ trialEnabled: number }>();

  if (trialEnabled !== 0 && trialEnabled !== 1) {
    return c.json({ error: 'trialEnabled 必须为 0 或 1' }, 400);
  }

  const db = getDb();

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    return c.json({ error: '用户不存在' }, 404);
  }

  await db.update(users).set({ trialEnabled }).where(eq(users.id, userId));

  return c.json({
    message: `用户 ${user[0].email} 的试用限制已${trialEnabled ? '启用' : '关闭'}`,
    trialEnabled,
  });
});

/** 管理员删除用户（级联删除绑定、事件、验证码） */
admin.delete('/users/:id', async (c) => {
  const userId = parseInt(c.req.param('id'), 10);
  const db = getDb();

  // 当前操作的管理员 ID：token 的 payload 里是 userId（不是 id）
  const payload = c.get('user');
  if (payload.userId === userId) {
    return c.json({ error: '不能删除自己的账号' }, 400);
  }

  const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (user.length === 0) {
    return c.json({ error: '用户不存在' }, 404);
  }

  // 级联删除关联数据
  await db.delete(storeBindings).where(eq(storeBindings.userId, userId));
  await db.delete(analyticsEvents).where(eq(analyticsEvents.userId, userId));
  await db.delete(verificationCodes).where(eq(verificationCodes.email, user[0].email));
  await db.delete(users).where(eq(users.id, userId));

  return c.json({ message: `用户 ${user[0].email} 已删除` });
});

/** 获取所有绑定记录（可按 userId 过滤）。
 *  响应刻意不包含 spc_cds：管理后台不需要店铺登录凭据，
 *  避免凭据出现在网络响应、浏览器缓存或前端内存中。 */
admin.get('/bindings', async (c) => {
  const db = getDb();
  const userIdParam = c.req.query('userId');

  const baseQuery = db
    .select({
      id: storeBindings.id,
      userId: storeBindings.userId,
      shopId: storeBindings.shopId,
      accountId: storeBindings.accountId,
      shopUsername: storeBindings.shopUsername,
      shopName: storeBindings.shopName,
      isActive: storeBindings.isActive,
      maxStores: storeBindings.maxStores,
      createdAt: storeBindings.createdAt,
      userEmail: users.email,
    })
    .from(storeBindings)
    .leftJoin(users, eq(storeBindings.userId, users.id));

  let bindings;
  if (userIdParam) {
    const userId = parseInt(userIdParam, 10);
    bindings = await baseQuery
      .where(eq(storeBindings.userId, userId))
      .orderBy(desc(storeBindings.createdAt), desc(storeBindings.id));
  } else {
    bindings = await baseQuery
      .where(eq(storeBindings.isActive, 1))
      .orderBy(desc(storeBindings.createdAt), desc(storeBindings.id));
  }

  return c.json({ bindings });
});

/** 管理员强制解绑 */
admin.delete('/bindings/:id', async (c) => {
  const db = getDb();
  const id = parseInt(c.req.param('id'), 10);

  const binding = await db.select().from(storeBindings).where(eq(storeBindings.id, id)).limit(1);

  if (binding.length === 0) {
    return c.json({ error: '未找到该绑定记录' }, 404);
  }

  await db.update(storeBindings).set({ isActive: 0 }).where(eq(storeBindings.id, id));

  return c.json({ message: `已解绑店铺绑定 (ID: ${id})` });
});

/** 全局统计概览 */
admin.get('/analytics', async (c) => {
  const db = getDb();

  const result = await db
    .select({
      eventType: analyticsEvents.eventType,
      count: sql<number>`COUNT(*)`,
    })
    .from(analyticsEvents)
    .groupBy(analyticsEvents.eventType)
    .orderBy(analyticsEvents.eventType);

  const totalUsers = (await db.select({ count: sql<number>`COUNT(*)` }).from(users))[0].count;
  const totalBindings = (
    await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(storeBindings)
      .where(eq(storeBindings.isActive, 1))
  )[0].count;

  return c.json({
    totalUsers,
    totalBindings,
    events: result,
  });
});

/**
 * 事件明细查询：固定返回最近 100 条，避免先全量排序再过滤。
 * eventData 按类型白名单脱敏后返回，不原样透传原始 JSON。
 */
admin.get('/analytics/events', async (c) => {
  const db = getDb();
  const eventType = c.req.query('type');

  const rows = await db
    .select({
      id: analyticsEvents.id,
      userId: analyticsEvents.userId,
      eventType: analyticsEvents.eventType,
      eventData: analyticsEvents.eventData,
      createdAt: analyticsEvents.createdAt,
      email: users.email,
    })
    .from(analyticsEvents)
    .leftJoin(users, eq(analyticsEvents.userId, users.id))
    .where(eventType ? eq(analyticsEvents.eventType, eventType) : undefined)
    .orderBy(desc(analyticsEvents.createdAt), desc(analyticsEvents.id))
    .limit(100);

  const events = rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    eventType: row.eventType,
    eventData: redactEventData(row.eventType, row.eventData),
    createdAt: row.createdAt,
    email: row.email,
  }));

  return c.json({ events });
});

/** 邀请码列表 */
admin.get('/invite-codes', async (c) => {
  const db = getDb();
  const codes = await db
    .select({
      id: inviteCodes.id,
      code: inviteCodes.code,
      isUsed: inviteCodes.isUsed,
      usedBy: inviteCodes.usedBy,
      createdAt: inviteCodes.createdAt,
      usedAt: inviteCodes.usedAt,
      userEmail: users.email,
    })
    .from(inviteCodes)
    .leftJoin(users, eq(inviteCodes.usedBy, users.id))
    .orderBy(desc(inviteCodes.createdAt), desc(inviteCodes.id));

  return c.json({ inviteCodes: codes });
});

/** 生成邀请码 */
admin.post('/invite-codes', async (c) => {
  const { count } = await c.req.json<{ count?: number }>();
  const num = Math.min(Math.max(count || 1, 1), 20);

  const db = getDb();
  const codes: string[] = [];

  for (let i = 0; i < num; i++) {
    const code = 'INV-' + crypto.randomBytes(4).toString('hex');
    await db.insert(inviteCodes).values({ code });
    codes.push(code);
  }

  return c.json({ codes, count: codes.length }, 201);
});

/** 删除未使用的邀请码 */
admin.delete('/invite-codes/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const db = getDb();

  const code = await db.select().from(inviteCodes).where(eq(inviteCodes.id, id)).limit(1);
  if (code.length === 0) {
    return c.json({ error: '邀请码不存在' }, 404);
  }
  if (code[0].isUsed) {
    return c.json({ error: '不能删除已使用的邀请码' }, 400);
  }

  await db.delete(inviteCodes).where(eq(inviteCodes.id, id));
  return c.json({ message: '邀请码已删除' });
});

export default admin;
