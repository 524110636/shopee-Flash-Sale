import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/index.js';
import { users, verificationCodes } from '../db/schema.js';
import { signToken } from '../utils/jwt.js';
import { generateVerificationCode, getExpiresAt, isCodeExpired } from '../utils/code.js';
import { authMiddleware } from '../middleware/auth.js';

const auth = new Hono();

/** 注册：创建未激活账户并返回验证码 */
auth.post('/register', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();

  if (!email || !password) {
    return c.json({ error: '邮箱和密码不能为空' }, 400);
  }

  // 支持邮箱格式或纯用户名（内部系统）
  const isPlainUsername = /^[a-zA-Z0-9_.-]+$/.test(email);
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!isPlainUsername && !isEmail) {
    return c.json({ error: '请输入有效的邮箱或用户名' }, 400);
  }

  if (password.length < 6) {
    return c.json({ error: '密码长度不能少于 6 位' }, 400);
  }

  const db = getDb();

  const existingUser = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existingUser.length > 0) {
    return c.json({ error: '该邮箱已注册' }, 409);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const code = generateVerificationCode();
  const expiresAt = getExpiresAt();

  await db.insert(users).values({
    email,
    passwordHash,
    isActive: 0,
    role: 'user',
  });

  await db.insert(verificationCodes).values({
    email,
    code,
    expiresAt,
  });

  return c.json({
    message: '注册成功，请验证邮箱',
    code,
    expiresAt,
  }, 201);
});

/** 验证：使用验证码激活账户 */
auth.post('/verify', async (c) => {
  const { email, code } = await c.req.json<{ email: string; code: string }>();

  if (!email || !code) {
    return c.json({ error: '邮箱和验证码不能为空' }, 400);
  }

  const db = getDb();

  const codeRecord = await db.select()
    .from(verificationCodes)
    .where(
      and(
        eq(verificationCodes.email, email),
        eq(verificationCodes.code, code),
        eq(verificationCodes.isUsed, 0),
      )
    )
    .limit(1);

  if (codeRecord.length === 0) {
    return c.json({ error: '验证码无效' }, 400);
  }

  if (isCodeExpired(codeRecord[0].expiresAt)) {
    return c.json({ error: '验证码已过期，请重新注册' }, 400);
  }

  await db.update(verificationCodes)
    .set({ isUsed: 1 })
    .where(eq(verificationCodes.id, codeRecord[0].id));

  await db.update(users)
    .set({ isActive: 1 })
    .where(eq(users.email, email));

  return c.json({ message: '验证成功，请登录' });
});

/** 登录：验证凭证并返回 JWT */
auth.post('/login', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();

  if (!email || !password) {
    return c.json({ error: '邮箱和密码不能为空' }, 400);
  }

  const db = getDb();

  const user = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (user.length === 0) {
    return c.json({ error: '邮箱或密码错误' }, 401);
  }

  if (!user[0].isActive) {
    return c.json({ error: '请先验证邮箱' }, 401);
  }

  const validPassword = await bcrypt.compare(password, user[0].passwordHash);
  if (!validPassword) {
    return c.json({ error: '邮箱或密码错误' }, 401);
  }

  const token = await signToken({
    userId: user[0].id,
    email: user[0].email,
    role: user[0].role,
  });

  return c.json({
    token,
    user: {
      id: user[0].id,
      email: user[0].email,
      role: user[0].role,
    },
  });
});

/** 检查当前用户是否为管理员 */
auth.post('/check-admin', authMiddleware, async (c) => {
  const user = c.get('user');
  return c.json({ isAdmin: user.role === 'admin' });
});

export default auth;
