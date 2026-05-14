import 'dotenv/config';
import { initializeDatabase, getDb } from './db/index.js';
import { users, inviteCodes } from './db/schema.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

async function seed() {
  await initializeDatabase();
  const db = getDb();

  // 1. 创建初始管理员
  const adminEmail = process.env.INIT_ADMIN_EMAIL;
  const adminPassword = process.env.INIT_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.error('[Seed] 请在 .env 中设置 INIT_ADMIN_EMAIL 和 INIT_ADMIN_PASSWORD');
    process.exit(1);
  }

  const existing = await db.select().from(users).where(eq(users.email, adminEmail)).limit(1);

  if (existing.length > 0) {
    console.log(`[Seed] 管理员 ${adminEmail} 已存在，跳过创建`);
  } else {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await db.insert(users).values({
      email: adminEmail,
      passwordHash,
      role: 'admin',
      isActive: 1,
      autoModeEnabled: 1,
      trialUsed: 0,
      trialEnabled: 1,
    });
    console.log(`[Seed] 管理员 ${adminEmail} 创建成功`);
  }

  // 2. 生成初始邀请码
  const existingCodes = await db.select().from(inviteCodes).limit(1);

  if (existingCodes.length > 0) {
    console.log('[Seed] 已有邀请码，跳过生成');
  } else {
    const initCount = parseInt(process.env.INIT_INVITE_CODES || '5', 10);
    const codes: string[] = [];

    for (let i = 0; i < initCount; i++) {
      const code = 'INV-' + crypto.randomBytes(4).toString('hex');
      await db.insert(inviteCodes).values({ code });
      codes.push(code);
    }

    console.log('[Seed] 初始邀请码已生成：');
    codes.forEach(c => console.log(`  ${c}`));
  }

  console.log('[Seed] 初始化完成');
  process.exit(0);
}

seed().catch((err) => {
  console.error('[Seed] 失败:', err);
  process.exit(1);
});
