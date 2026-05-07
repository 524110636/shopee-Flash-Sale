import { Hono } from 'hono';
import { eq, and, count } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { storeBindings, users } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';

const stores = new Hono();

stores.use('*', authMiddleware);

/** 获取当前用户已绑定的店铺列表 */
stores.get('/', async (c) => {
  const user = c.get('user');
  const db = getDb();

  const bindings = await db.select()
    .from(storeBindings)
    .where(
      and(
        eq(storeBindings.userId, user.userId),
        eq(storeBindings.isActive, 1),
      )
    );

  return c.json({ stores: bindings });
});

/** 绑定店铺 */
stores.post('/bind', async (c) => {
  const user = c.get('user');
  const { spcCds, shopName } = await c.req.json<{ spcCds: string; shopName?: string }>();

  if (!spcCds) {
    return c.json({ error: 'SPC_CDS 不能为空' }, 400);
  }

  const db = getDb();

  // 查当前用户绑定数量
  const bindingCount = await db.select({ count: count() })
    .from(storeBindings)
    .where(
      and(
        eq(storeBindings.userId, user.userId),
        eq(storeBindings.isActive, 1),
      )
    );

  // 查用户级限额
  const userRecord = await db.select().from(users).where(eq(users.id, user.userId)).limit(1);
  const maxStores = userRecord[0]?.maxStores ?? 1;

  if (bindingCount[0].count >= maxStores) {
    return c.json({
      error: `已达到最大店铺绑定数量 (${maxStores})，如需扩容请联系管理员`,
    }, 403);
  }

  // 检查 SPC_CDS 是否已被其他用户绑定
  const existingBinding = await db.select()
    .from(storeBindings)
    .where(
      and(
        eq(storeBindings.spcCds, spcCds),
        eq(storeBindings.isActive, 1),
      )
    )
    .limit(1);

  if (existingBinding.length > 0) {
    return c.json({ error: '该店铺已被其他用户绑定' }, 409);
  }

  await db.insert(storeBindings).values({
    userId: user.userId,
    spcCds,
    shopName: shopName || null,
    maxStores,
  });

  return c.json({ message: '店铺绑定成功' }, 201);
});

/** 解绑店铺 */
stores.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'), 10);
  const db = getDb();

  const binding = await db.select()
    .from(storeBindings)
    .where(
      and(
        eq(storeBindings.id, id),
        eq(storeBindings.userId, user.userId),
      )
    )
    .limit(1);

  if (binding.length === 0) {
    return c.json({ error: '未找到该绑定记录' }, 404);
  }

  await db.update(storeBindings)
    .set({ isActive: 0 })
    .where(eq(storeBindings.id, id));

  return c.json({ message: '解绑成功' });
});

export default stores;
