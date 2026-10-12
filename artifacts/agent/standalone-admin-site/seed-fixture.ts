/**
 * 浏览器手测用的隔离数据：独立账号与绑定，只写入 .agent-tmp 下的隔离库。
 * 不读取、不修改正式数据库。
 */
import { createClient } from '@libsql/client';
import bcrypt from 'bcryptjs';

const DB_PATH = process.env.DB_PATH as string;
const client = createClient({ url: `file:${DB_PATH}` });

async function upsertUser(
  email: string,
  role: string,
  isActive: number,
  password: string,
  extra: Record<string, number> = {},
): Promise<number> {
  const hash = await bcrypt.hash(password, 10);
  const existing = await client.execute({
    sql: 'SELECT id FROM users WHERE email = ?',
    args: [email],
  });
  if (existing.rows.length > 0) {
    const id = Number(existing.rows[0].id);
    await client.execute({
      sql: 'UPDATE users SET role = ?, is_active = ?, password_hash = ? WHERE id = ?',
      args: [role, isActive, hash, id],
    });
    return id;
  }
  await client.execute({
    sql: 'INSERT INTO users (email, password_hash, role, is_active, trial_enabled, auto_mode_enabled, trial_used, max_stores) VALUES (?, ?, ?, ?, 1, ?, ?, 1)',
    args: [
      email,
      hash,
      role,
      isActive,
      extra.autoModeEnabled ?? 0,
      extra.trialUsed ?? 0,
    ],
  });
  const row = await client.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
  return Number(row.rows[0].id);
}

async function main() {
  const adminId = await upsertUser('admin@test.local', 'admin', 1, 'AdminPass123!');
  const demoId = await upsertUser('demo@test.local', 'user', 1, 'DemoPass123!');
  const pendingId = await upsertUser('pending@test.local', 'user', 0, 'PendingPass123!');

  const count = await client.execute({
    sql: 'SELECT COUNT(*) AS c FROM store_bindings WHERE user_id = ?',
    args: [demoId],
  });
  if (Number(count.rows[0].c) === 0) {
    await client.execute({
      sql: 'INSERT INTO store_bindings (user_id, spc_cds, shop_id, account_id, shop_username, shop_name, max_stores, is_active) VALUES (?, ?, 700001, 900001, ?, ?, 1, 1)',
      args: [demoId, 'FIXTURE_SPC_CDS_AAAA_BBBB_CCCC_DDDD', 'demo_shop', '示例店铺A'],
    });
    await client.execute({
      sql: 'INSERT INTO store_bindings (user_id, spc_cds, max_stores, is_active) VALUES (?, ?, 1, 1)',
      args: [demoId, 'FIXTURE_SPC_CDS_NO_SHOP_ID_1111'],
    });
  }

  const inviteCount = await client.execute({
    sql: 'SELECT COUNT(*) AS c FROM invite_codes',
    args: [],
  });
  if (Number(inviteCount.rows[0].c) === 0) {
    for (const code of ['INV-testaa01', 'INV-testaa02', 'INV-testaa03']) {
      await client.execute({ sql: 'INSERT INTO invite_codes (code) VALUES (?)', args: [code] });
    }
  }

  const eventCount = await client.execute({
    sql: 'SELECT COUNT(*) AS c FROM analytics_events',
    args: [],
  });
  if (Number(eventCount.rows[0].c) === 0) {
    for (const [type, n] of [
      ['enable_loop', 12],
      ['copy_flow', 5],
      ['auto_mode_round', 3],
    ] as const) {
      for (let i = 0; i < n; i++) {
        await client.execute({
          sql: 'INSERT INTO analytics_events (user_id, event_type, event_data) VALUES (?, ?, ?)',
          args: [demoId, type, JSON.stringify({ seq: i + 1, note: 'fixture' })],
        });
      }
    }
  }

  console.log('fixture ready:', { adminId, demoId, pendingId });
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
