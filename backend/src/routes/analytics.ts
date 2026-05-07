import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { analyticsEvents } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';

const analytics = new Hono();

analytics.use('*', authMiddleware);

/** 上报使用事件 */
analytics.post('/events', async (c) => {
  const user = c.get('user');
  const { eventType, eventData } = await c.req.json<{
    eventType: string;
    eventData?: Record<string, unknown>;
  }>();

  if (!eventType) {
    return c.json({ error: '事件类型不能为空' }, 400);
  }

  const db = getDb();
  await db.insert(analyticsEvents).values({
    userId: user.userId,
    eventType,
    eventData: eventData ? JSON.stringify(eventData) : null,
  });

  return c.json({ message: '事件上报成功' }, 201);
});

/** 获取个人使用摘要 */
analytics.get('/summary', async (c) => {
  const user = c.get('user');
  const db = getDb();

  const events = await db.select()
    .from(analyticsEvents)
    .where(eq(analyticsEvents.userId, user.userId))
    .orderBy(analyticsEvents.createdAt);

  // 按事件类型聚合
  const summary: Record<string, number> = {};
  for (const event of events) {
    summary[event.eventType] = (summary[event.eventType] || 0) + 1;
  }

  return c.json({ summary, total: events.length });
});

export default analytics;
