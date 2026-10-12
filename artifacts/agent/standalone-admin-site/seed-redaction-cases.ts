/**
 * 仅为本轮浏览器复核灌入「含虚构凭据」的事件，验证页面不再展示原始 eventData。
 * 只写 .agent-tmp 隔离库，不读取正式库、不访问虾皮。
 */
import { createClient } from '@libsql/client';

const DB_PATH = process.env.DB_PATH as string;
const client = createClient({ url: `file:${DB_PATH}` });

const FAKE_TOKEN = 'FAKE_BROWSER_TOKEN_NOT_A_SECRET';
const FAKE_SPC = 'FAKE_BROWSER_SPC_NOT_A_SECRET';
const FAKE_COOKIE = 'FAKE_BROWSER_COOKIE_NOT_A_SECRET';

const admin = await client.execute({
  sql: 'SELECT id FROM users WHERE email = ?',
  args: ['admin@test.local'],
});
const adminId = Number(admin.rows[0].id);
const demo = await client.execute({
  sql: 'SELECT id FROM users WHERE email = ?',
  args: ['demo@test.local'],
});
const demoId = Number(demo.rows[0].id);

await client.execute('DELETE FROM analytics_events');

await client.execute({
  sql: 'INSERT INTO analytics_events (user_id, event_type, event_data) VALUES (?, ?, ?)',
  args: [
    demoId,
    'enable_loop',
    JSON.stringify({
      totalSkus: 12,
      successSkus: 11,
      failedSkus: 1,
      rounds: 2,
      token: FAKE_TOKEN,
      spcCds: FAKE_SPC,
      cookie: FAKE_COOKIE,
      nested: { spcCds: FAKE_SPC, deep: { token: FAKE_TOKEN } },
    }),
  ],
});

await client.execute({
  sql: 'INSERT INTO analytics_events (user_id, event_type, event_data) VALUES (?, ?, ?)',
  args: [
    demoId,
    'auto_mode_round',
    JSON.stringify({ round: 3, totalRounds: 8, flashSaleId: 998877, spcCds: FAKE_SPC }),
  ],
});

await client.execute({
  sql: 'INSERT INTO analytics_events (user_id, event_type, event_data) VALUES (?, ?, ?)',
  args: [demoId, 'unknown_probe', JSON.stringify({ token: FAKE_TOKEN, spcCds: FAKE_SPC })],
});

console.log('[seed] 已灌入 3 条事件（含虚构凭据）');
console.log(`[seed] 虚构标记：${FAKE_TOKEN} / ${FAKE_SPC} / ${FAKE_COOKIE}`);
