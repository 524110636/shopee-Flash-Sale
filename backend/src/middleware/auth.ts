import { createMiddleware } from 'hono/factory';
import { eq } from 'drizzle-orm';
import { verifyToken, type TokenPayload } from '../utils/jwt.js';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';

declare module 'hono' {
  interface ContextVariableMap {
    user: TokenPayload;
  }
}

/** JWT 鉴权中间件：从 Authorization header 提取并验证 token */
export const authMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: '未提供认证令牌' }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token);
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: '认证令牌无效或已过期' }, 401);
  }
});

/** Admin 角色守卫：在 authMiddleware 之后使用。
 *  不能只看 token 里的 role —— token 是签发时的快照，账号被删除、
 *  停用或撤销管理员权限后旧 token 仍然有效。这里按 userId 查库判定当前身份。 */
export const adminMiddleware = createMiddleware(async (c, next) => {
  const user = c.get('user');
  const db = getDb();
  const record = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, user.userId))
    .limit(1);

  const current = record[0];
  if (!current || !current.isActive || current.role !== 'admin') {
    return c.json({ error: '无权限，需要管理员角色' }, 403);
  }
  await next();
});
