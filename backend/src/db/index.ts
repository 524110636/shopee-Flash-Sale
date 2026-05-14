import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import * as schema from './schema.js';

const DB_PATH = join(process.cwd(), 'data', 'sale.db');

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
}
