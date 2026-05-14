import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

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
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const verificationCodes = sqliteTable('verification_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull(),
  code: text('code').notNull(),
  expiresAt: text('expires_at').notNull(),
  isUsed: integer('is_used').notNull().default(0),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
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
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const inviteCodes = sqliteTable('invite_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  isUsed: integer('is_used').notNull().default(0),
  usedBy: integer('used_by'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  usedAt: text('used_at'),
});

export const analyticsEvents = sqliteTable('analytics_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id),
  eventType: text('event_type').notNull(),
  eventData: text('event_data'),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type VerificationCode = typeof verificationCodes.$inferSelect;
export type StoreBinding = typeof storeBindings.$inferSelect;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
