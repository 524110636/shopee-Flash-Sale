import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// 注意：`.default('CURRENT_TIMESTAMP')` 会被 Drizzle 当成字面量字符串写入，
// 导致该列永远存字符串 "CURRENT_TIMESTAMP"。必须用 sql 模板让 SQLite 求值。
const now = sql`(datetime('now'))`;

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  isActive: integer('is_active').notNull().default(0),
  maxStores: integer('max_stores').notNull().default(1),
  autoModeEnabled: integer('auto_mode_enabled').notNull().default(0),
  trialUsed: integer('trial_used').notNull().default(0),
  trialEnabled: integer('trial_enabled').notNull().default(1),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const verificationCodes = sqliteTable('verification_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull(),
  code: text('code').notNull(),
  expiresAt: text('expires_at').notNull(),
  isUsed: integer('is_used').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
});

export const storeBindings = sqliteTable('store_bindings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  spcCds: text('spc_cds').notNull(),
  shopId: integer('shop_id'),
  accountId: integer('account_id'),
  shopUsername: text('shop_username'),
  shopName: text('shop_name'),
  maxStores: integer('max_stores').notNull().default(1),
  isActive: integer('is_active').notNull().default(1),
  createdAt: text('created_at').notNull().default(now),
});

export const inviteCodes = sqliteTable('invite_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  isUsed: integer('is_used').notNull().default(0),
  usedBy: integer('used_by'),
  createdAt: text('created_at').notNull().default(now),
  usedAt: text('used_at'),
});

export const analyticsEvents = sqliteTable('analytics_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  eventType: text('event_type').notNull(),
  eventData: text('event_data'),
  createdAt: text('created_at').notNull().default(now),
});

// 弹窗记录：每条独立记录一行，管理员可连续新建多条（用户 2026-10-13 补充）。
// 草稿字段与生效快照字段同放一行：发布是「单行 UPDATE」，不会出现正文已换、
// 版本还没换的中间态被读到。
//
// 为什么保留 mode + published_revision 这套字段名：
// 旧两模式固定行要能增量迁移进来（不覆盖、不丢草稿），字段沿用可让迁移变成
// 「补 record 行 + 关联生效槽」，而不是重写数据。
export const popupPolicies = sqliteTable('popup_policies', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** 稳定记录 ID，用 UUID：管理端按 ID 定位，不能用自增序列当外部契约。 */
  recordId: text('record_id').notNull().unique(),
  mode: text('mode').notNull(),
  draftTitle: text('draft_title').notNull().default(''),
  draftContentHtml: text('draft_content_html').notNull().default(''),
  draftRequiredVersion: text('draft_required_version'),
  draftDownloadUrl: text('draft_download_url'),
  draftUpdatedAt: text('draft_updated_at').notNull().default(now),
  /** 0 表示该记录尚未发布过（草稿态）；发布后单调递增，撤回不归零。
   *  这就是 B4 的判定依据：「曾经发布过」不能因为撤回而变回草稿。 */
  publishedRevision: integer('published_revision').notNull().default(0),
  /**
   * 当前生效快照所属的类型。
   *
   * 为什么必须与 `mode`（草稿类型）分开：草稿可以改类型，但**已发布快照的类型
   * 不会因为改草稿而变**。若只看 `mode`，一条「先按强制发布、再改成通知草稿」的
   * 记录会同时被两个生效槽认为是自己的内容（B3），公开接口两模式都返回同一条，
   * 且强制的 requiredVersion 被清空导致整份响应被判非法。
   */
  publishedMode: text('published_mode'),
  publishedTitle: text('published_title'),
  publishedContentHtml: text('published_content_html'),
  publishedRequiredVersion: text('published_required_version'),
  publishedDownloadUrl: text('published_download_url'),
  publishedAt: text('published_at'),
  createdAt: text('created_at').notNull().default(now),
});

// 每模式一个生效槽：指向当前生效的记录，并保存该模式全局递增的发布计数。
//
// 为什么单独一张表而不是「在记录表里加 is_active 布尔」：布尔方案在并发发布时
// 可能出现两条都 active（两条 UPDATE 之间没有互斥），而单行槽位 + 事务写
// 天然只有一条生效。槽位的 revision 是**每模式全局递增**，不随记录 ID 重置 ——
// 这是「新通知不被旧已读标记吞掉」的关键。
export const popupActiveSlots = sqliteTable('popup_active_slots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  mode: text('mode').notNull().unique(),
  activeRecordId: text('active_record_id'),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull().default(now),
});

// 弹窗图片资源：数据库只存元数据，字节落在 POPUP_ASSETS_DIR 下的 opaque_id 文件。
// 为什么用生成的 opaqueId 而不是用户文件名：用户文件名可能含 ../ 或路径分隔符，
// 拼进磁盘路径会越界写到目录外。
export const popupAssets = sqliteTable('popup_assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  opaqueId: text('opaque_id').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

// 弹窗查看统计：一行 = 「某个登录账号看过某条记录一次」。
//
// 为什么要「(record_id, user_id) 唯一」而不是「一条记录一行计数」：
// 同账号重复打开、多设备、多安装、StrictMode 重复 effect、并发请求都会重复上报，
// 用自增计数会在并发下多计。唯一约束让 SQLite 自己保证「只算一位」。
//
// 账号主体是**项目后端登录账号**（userId），不是店铺／设备／IP ——
// 所以上报接口必须从 token 反查账号，绝不接受客户端传来的 userId／邮箱。
export const popupViews = sqliteTable('popup_views', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recordId: text('record_id').notNull(),
  userId: integer('user_id').notNull(),
  /** 首次上报时该弹窗的生效类型，仅作追溯，不参与判定。 */
  mode: text('mode').notNull(),
  /** 首次上报时看到的修订号，仅作追溯。 */
  revision: integer('revision').notNull(),
  /** 首次查看时间由服务端记，客户端不能指定。 */
  firstViewedAt: text('first_viewed_at').notNull().default(now),
});

export type PopupPolicy = typeof popupPolicies.$inferSelect;
export type PopupActiveSlot = typeof popupActiveSlots.$inferSelect;
export type PopupAsset = typeof popupAssets.$inferSelect;
export type PopupView = typeof popupViews.$inferSelect;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type VerificationCode = typeof verificationCodes.$inferSelect;
export type StoreBinding = typeof storeBindings.$inferSelect;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
