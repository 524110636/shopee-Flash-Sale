import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { users, storeBindings, analyticsEvents } from '../db/schema.js';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';

const admin = new Hono();

admin.use('*', authMiddleware, adminMiddleware);

/** 用户列表（含绑定店铺数） */
admin.get('/users', async (c) => {
  const db = getDb();

  const userList = await db.select({
    id: users.id,
    email: users.email,
    role: users.role,
    isActive: users.isActive,
    createdAt: users.createdAt,
    bindingCount: sql<number>`(
      SELECT COUNT(*) FROM store_bindings
      WHERE store_bindings.user_id = users.id AND store_bindings.is_active = 1
    )`,
  })
    .from(users)
    .orderBy(users.createdAt);

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
  await db.update(users)
    .set({ maxStores })
    .where(eq(users.id, userId));
  // 同时更新已有绑定的 maxStores（用于前端展示）
  await db.update(storeBindings)
    .set({ maxStores })
    .where(eq(storeBindings.userId, userId));

  return c.json({ message: `用户 ${user[0].email} 的店铺限额已更新为 ${maxStores}` });
});

/** 全局统计概览 */
admin.get('/analytics', async (c) => {
  const db = getDb();

  const result = await db.select({
    eventType: analyticsEvents.eventType,
    count: sql<number>`COUNT(*)`,
  })
    .from(analyticsEvents)
    .groupBy(analyticsEvents.eventType)
    .orderBy(analyticsEvents.eventType);

  const totalUsers = (await db.select({ count: sql<number>`COUNT(*)` }).from(users))[0].count;
  const totalBindings = (await db.select({ count: sql<number>`COUNT(*)` }).from(storeBindings).where(eq(storeBindings.isActive, 1)))[0].count;

  return c.json({
    totalUsers,
    totalBindings,
    events: result,
  });
});

/** 事件明细查询 */
admin.get('/analytics/events', async (c) => {
  const db = getDb();
  const eventType = c.req.query('type');

  let query = db.select({
    id: analyticsEvents.id,
    userId: analyticsEvents.userId,
    eventType: analyticsEvents.eventType,
    eventData: analyticsEvents.eventData,
    createdAt: analyticsEvents.createdAt,
    email: users.email,
  })
    .from(analyticsEvents)
    .leftJoin(users, eq(analyticsEvents.userId, users.id));

  if (eventType) {
    query = query.where(eq(analyticsEvents.eventType, eventType));
  }

  const events = await query.orderBy(analyticsEvents.createdAt).limit(100);

  return c.json({ events });
});

export default admin;
