import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import * as schema from './schema.js';

// 数据库位置默认 backend/data/sale.db；可用 DB_PATH 指向隔离库（测试/验收用），
// 避免把测试数据写进正式库。
const DB_PATH = process.env.DB_PATH
  ? process.env.DB_PATH
  : join(process.cwd(), 'data', 'sale.db');

let client: ReturnType<typeof createClient>;
let db: ReturnType<typeof drizzle<typeof schema>>;

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return db;
}

export function getClient() {
  if (!client) {
    throw new Error('Database not initialized. Call initializeDatabase() first.');
  }
  return client;
}

export async function initializeDatabase() {
  const dbDir = dirname(DB_PATH);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  client = createClient({
    url: `file:${DB_PATH}`,
  });

  db = drizzle(client, { schema });

  await createTables();
  console.log(`[DB] Initialized at ${DB_PATH}`);
  return { db, client };
}

async function createTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_active INTEGER NOT NULL DEFAULT 0,
      max_stores INTEGER NOT NULL DEFAULT 1,
      auto_mode_enabled INTEGER NOT NULL DEFAULT 0,
      trial_used INTEGER NOT NULL DEFAULT 0,
      trial_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      is_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS store_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      spc_cds TEXT NOT NULL,
      shop_name TEXT,
      max_stores INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      is_used INTEGER NOT NULL DEFAULT 0,
      used_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      event_type TEXT NOT NULL,
      event_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `;

  for (const statement of sql.split(';').filter(s => s.trim())) {
    await client.execute(statement + ';');
  }

  // 迁移：为旧数据库添加 max_stores 列
  try {
    await client.execute('ALTER TABLE users ADD COLUMN max_stores INTEGER NOT NULL DEFAULT 1;');
  } catch {
    // 列已存在，忽略
  }

  // 迁移：为旧数据库添加 shop_id / account_id / shop_username 列
  try {
    await client.execute('ALTER TABLE store_bindings ADD COLUMN shop_id INTEGER;');
  } catch { /* 列已存在 */ }
  try {
    await client.execute('ALTER TABLE store_bindings ADD COLUMN account_id INTEGER;');
  } catch { /* 列已存在 */ }
  try {
    await client.execute('ALTER TABLE store_bindings ADD COLUMN shop_username TEXT;');
  } catch { /* 列已存在 */ }

  // 迁移：为旧数据库添加 auto_mode_enabled 列
  try {
    await client.execute('ALTER TABLE users ADD COLUMN auto_mode_enabled INTEGER NOT NULL DEFAULT 0;');
  } catch { /* 列已存在 */ }

  // 迁移：为旧数据库添加 trial_used 列
  try {
    await client.execute('ALTER TABLE users ADD COLUMN trial_used INTEGER NOT NULL DEFAULT 0;');
  } catch { /* 列已存在 */ }

  // 迁移：为旧数据库添加 trial_enabled 列
  try {
    await client.execute('ALTER TABLE users ADD COLUMN trial_enabled INTEGER NOT NULL DEFAULT 1;');
  } catch { /* 列已存在 */ }

  // 弹窗记录表：多条独立记录，每条有自己的草稿与生效快照。
  await client.execute(`
    CREATE TABLE IF NOT EXISTS popup_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL,
      draft_title TEXT NOT NULL DEFAULT '',
      draft_content_html TEXT NOT NULL DEFAULT '',
      draft_required_version TEXT,
      draft_download_url TEXT,
      draft_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_revision INTEGER NOT NULL DEFAULT 0,
      published_mode TEXT,
      published_title TEXT,
      published_content_html TEXT,
      published_required_version TEXT,
      published_download_url TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 迁移：为已建立的新结构补 published_mode（旧数据按当时的 mode 回填）。
  try {
    await client.execute('ALTER TABLE popup_policies ADD COLUMN published_mode TEXT;');
  } catch { /* 列已存在 */ }
  await client.execute(
    `UPDATE popup_policies SET published_mode = mode
     WHERE published_mode IS NULL AND published_content_html IS NOT NULL;`,
  ).catch(() => undefined);

  // 每模式一个生效槽。
  await client.execute(`
    CREATE TABLE IF NOT EXISTS popup_active_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL UNIQUE,
      active_record_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS popup_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      opaque_id TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 弹窗查看统计。唯一索引在库层面挡住「同账号同记录多计」，
  // 并发插入也不会产生第二行；不加计数列是因为计数可随时聚合，加列反而要维护一致性。
  await client.execute(`
    CREATE TABLE IF NOT EXISTS popup_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      revision INTEGER NOT NULL,
      first_viewed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_popup_views_record_user ON popup_views (record_id, user_id);',
  );

  for (const mode of ['notice', 'forced_update']) {
    await client.execute({
      sql: 'INSERT OR IGNORE INTO popup_active_slots (mode) VALUES (?);',
      args: [mode],
    });
  }

  await migrateLegacyPopupSlots(client);
}

/**
 * 增量迁移：把旧版「每模式一行固定记录」升级为多条记录 + 生效槽。
 *
 * 旧库的 popup_policies 里 mode 是 UNIQUE，一行同时装草稿与生效快照；
 * 新库要求一个 mode 可以有多行、由 popup_active_slots 指定生效哪一条。
 *
 * 做法（幂等，可重复执行，不删库重建）：
 * 1. 检测旧的 `draft_content_html TEXT NOT NULL DEFAULT ''` 结构是否存在；
 *    SQLite 无法直接 DROP 掉 UNIQUE 约束，所以走「新建表 → 搬数据 → 换名」。
 * 2. 若该 mode 行有草稿或生效内容，为它建一条记录行，保证内容不丢。
 * 3. 把旧行的 published_revision 原样搬到生效槽（**不回退**），并关联记录 ID。
 *
 * 已迁移过的库会因为「没有旧结构」直接返回，因此重复运行安全。
 */
async function migrateLegacyPopupSlots(client: ReturnType<typeof createClient>) {
  const columns = await client.execute(`PRAGMA table_info(popup_policies);`);
  const hasRecordId = columns.rows.some((r) => String(r.name) === 'record_id');
  if (hasRecordId) return; // 已是新结构

  console.log('[DB] 检测到旧弹窗结构，执行增量迁移（保留草稿与生效快照）');

  const legacy = await client.execute(
    `SELECT mode, draft_title, draft_content_html, draft_required_version, draft_download_url,
            published_revision, published_title, published_content_html,
            published_required_version, published_download_url, published_at
     FROM popup_policies;`,
  );

  await client.execute(`
    CREATE TABLE popup_policies_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL,
      draft_title TEXT NOT NULL DEFAULT '',
      draft_content_html TEXT NOT NULL DEFAULT '',
      draft_required_version TEXT,
      draft_download_url TEXT,
      draft_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_revision INTEGER NOT NULL DEFAULT 0,
      published_mode TEXT,
      published_title TEXT,
      published_content_html TEXT,
      published_required_version TEXT,
      published_download_url TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  for (const row of legacy.rows) {
    const mode = String(row.mode);
    const recordId = `legacy-${mode}`;
    const revision = Number(row.published_revision ?? 0);
    const hasPublished = !!row.published_content_html;

    await client.execute({
      sql: `INSERT INTO popup_policies_new
            (record_id, mode, published_revision, published_mode, published_title, published_content_html,
             published_required_version, published_download_url, published_at,
             draft_title, draft_content_html, draft_required_version, draft_download_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      args: [
        recordId, mode, revision,
        // 旧结构里生效快照的类型就是该行的 mode
        hasPublished ? mode : null,
        row.published_title ?? null, row.published_content_html ?? null,
        row.published_required_version ?? null, row.published_download_url ?? null,
        row.published_at ?? null,
        String(row.draft_title ?? ''), String(row.draft_content_html ?? ''),
        row.draft_required_version ?? null, row.draft_download_url ?? null,
      ],
    });

    // 生效槽：修订号原样搬过来（保持单调，新记录通知不会被旧已读吞掉）。
    await client.execute({
      sql: `UPDATE popup_active_slots SET active_record_id = ?, revision = ? WHERE mode = ?;`,
      args: [hasPublished ? recordId : null, revision, mode],
    });
  }

  await client.execute(`DROP TABLE popup_policies;`);
  await client.execute(`ALTER TABLE popup_policies_new RENAME TO popup_policies;`);
  console.log('[DB] 旧弹窗结构迁移完成');
}
