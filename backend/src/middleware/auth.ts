import { createMiddleware } from 'hono/factory';
import { verifyToken, type TokenPayload } from '../utils/jwt.js';

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

/** Admin 角色守卫：在 authMiddleware 之后使用 */
export const adminMiddleware = createMiddleware(async (c, next) => {
  const user = c.get('user');
  if (user.role !== 'admin') {
    return c.json({ error: '无权限，需要管理员角色' }, 403);
  }
  await next();
});
