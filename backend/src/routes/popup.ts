import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import crypto from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { join } from 'path';
import { getDb } from '../db/index.js';
import { popupPolicies, popupActiveSlots, popupAssets } from '../db/schema.js';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';
import { verifyToken } from '../utils/jwt.js';
import {
  isActiveAccount,
  listViewers,
  recordView,
  validateViewTarget,
  viewCountFor,
  viewCountsByRecord,
} from '../utils/popup-views.js';
import {
  POPUP_MODES,
  isPopupMode,
  sanitizeContentHtml,
  validateVersion,
  validateDownloadUrl,
  utf8ByteLength,
  countOwnAssets,
  detectImageMime,
  MAX_CONTENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_BODY,
  MAX_TITLE_LENGTH,
  ASSET_PATH_PREFIX,
} from '../utils/popup-policy.js';

/**
 * 弹窗策略路由。
 *
 * 分两组：
 * - popupPublic：公开只读，扩展读取。只返回生效内容，不含草稿。
 * - popupAdmin：复用 authMiddleware + adminMiddleware（按 userId 查库判定当前身份），
 *   覆盖列表／新建／按 ID 编辑、发布、撤回与图片上传。
 *
 * 为什么要独立文件而不是塞进 admin.ts：admin.ts 的 `admin.use('*')` 会把鉴权挂到
 * 整个子应用上，而公开读取必须免鉴权，两者混在一起迟早有人把公开接口挪进受保护区。
 *
 * 数据模型（v1.15.0 起）：
 * - popup_policies      多条独立记录（用户可连续新建），每条带自己的草稿与生效快照
 * - popup_active_slots  每模式一个生效槽，指向当前生效记录 + 该模式全局递增发布计数
 * 发布 = 事务内「写记录生效快照 + 指向生效槽 + 递增槽位 revision」。
 */

// 图片资源目录。与 DB_PATH 同样的思路：可用 POPUP_ASSETS_DIR 指向隔离目录，
// 避免验收上传的测试图混进正式素材目录。
const ASSETS_DIR = process.env.POPUP_ASSETS_DIR
  ? process.env.POPUP_ASSETS_DIR
  : join(process.cwd(), 'data', 'popup-assets');

let assetsDirReady = false;
function ensureAssetsDir() {
  if (assetsDirReady) return;
  if (!existsSync(ASSETS_DIR)) mkdirSync(ASSETS_DIR, { recursive: true });
  assetsDirReady = true;
}

type PolicyRow = typeof popupPolicies.$inferSelect;
type SlotRow = typeof popupActiveSlots.$inferSelect;

/** 草稿校验结果：ok 为 false 时 reasons 里有管理员能看懂的原因。 */
interface DraftValidation {
  ok: boolean;
  reasons: string[];
  title: string;
  contentHtml: string;
  requiredVersion: string | null;
  downloadUrl: string | null;
}

/**
 * 校验草稿内容。
 *
 * forced_update 的 requiredVersion / downloadUrl 是发布必填项，但**保存草稿时允许为空**
 * （管理员通常先写正文再填版本），只在发布时判定，避免草稿存不下去丢内容。
 */
function validateDraft(mode: string, body: Record<string, unknown>, forPublish: boolean): DraftValidation {
  const reasons: string[] = [];
  const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
  if (!rawTitle) reasons.push('标题不能为空');
  if (rawTitle.length > MAX_TITLE_LENGTH) reasons.push(`标题不能超过 ${MAX_TITLE_LENGTH} 个字符`);

  const contentHtml = sanitizeContentHtml(body.contentHtml);
  if (!contentHtml.trim()) reasons.push('正文不能为空');
  if (utf8ByteLength(contentHtml) > MAX_CONTENT_BYTES) {
    reasons.push(`正文超过 ${Math.floor(MAX_CONTENT_BYTES / 1024)} KiB 上限`);
  }
  if (countOwnAssets(contentHtml) > MAX_IMAGES_PER_BODY) {
    reasons.push(`正文最多包含 ${MAX_IMAGES_PER_BODY} 张图片`);
  }

  let requiredVersion: string | null = null;
  let downloadUrl: string | null = null;

  if (mode === 'forced_update') {
    const hasVersion = body.requiredVersion !== undefined && body.requiredVersion !== null && body.requiredVersion !== '';
    const hasUrl = body.downloadUrl !== undefined && body.downloadUrl !== null && body.downloadUrl !== '';

    if (hasVersion || forPublish) {
      requiredVersion = validateVersion(body.requiredVersion);
      if (!requiredVersion) reasons.push('要求版本必须是 1～4 段数字（如 1.15.0）');
    }
    if (hasUrl || forPublish) {
      downloadUrl = validateDownloadUrl(body.downloadUrl);
      if (!downloadUrl) reasons.push('下载地址必须是合法的 http(s) 链接');
    }
    if (forPublish && !requiredVersion) reasons.push('强制升级必须填写要求版本');
    if (forPublish && !downloadUrl) reasons.push('强制升级必须填写下载地址');
  }

  return { ok: reasons.length === 0, reasons, title: rawTitle, contentHtml, requiredVersion, downloadUrl };
}

/**
 * 记录行的对管理端展示形态（含草稿与生效快照 + 累计查看人数）。
 *
 * `isActive` 必须按**生效快照的类型**（`published_mode`）去查生效槽，不能用草稿
 * `mode`：草稿改了类型但已发布的快照还挂在原类型的槽上，用草稿类型查会漏判（B3 同源）。
 */
function toAdminRecord(row: PolicyRow, slots: Map<string, SlotRow>, viewCount = 0) {
  const hasPublished = !!row.publishedContentHtml;
  const activeRecordId = row.publishedMode ? slots.get(row.publishedMode)?.activeRecordId ?? null : null;
  return {
    recordId: row.recordId,
    /** 草稿当前类型（管理员可以改）。 */
    mode: row.mode,
    /** 生效快照的类型（与草稿类型可能不同，见 schema 注释）。 */
    publishedMode: row.publishedMode,
    isActive: row.recordId === activeRecordId && hasPublished,
    /**
     * 累计去重查看人数（按登录账号）。
     *
     * 来自独立的查看表，**不清随撤回／重新发布／改草稿**；
     * 从未被看过的记录真实显示 0，不补造历史。
     */
    viewCount,
    draft: {
      title: row.draftTitle,
      contentHtml: row.draftContentHtml,
      requiredVersion: row.draftRequiredVersion,
      downloadUrl: row.draftDownloadUrl,
      updatedAt: row.draftUpdatedAt,
    },
    /**
     * 状态：published=当前生效；withdrawn=**曾经发布过**但已不在生效槽；draft=从未发布。
     *
     * 判定「曾经发布过」用 `publishedRevision > 0`（单调递增的计数，撤回不归零），
     * **不能**看「当前有没有生效快照字段」—— 否则主动撤回会被误显示成「草稿」（B4）。
     */
    status: row.publishedRevision > 0
      ? (row.recordId === activeRecordId && hasPublished ? 'published' : 'withdrawn')
      : 'draft',
    published: hasPublished
      ? {
          mode: row.publishedMode,
          title: row.publishedTitle ?? '',
          contentHtml: row.publishedContentHtml ?? '',
          requiredVersion: row.publishedRequiredVersion,
          downloadUrl: row.publishedDownloadUrl,
          publishedAt: row.publishedAt,
        }
      : null,
    createdAt: row.createdAt,
  };
}

/**
 * 生效内容载荷。
 *
 * revision 取**生效槽**的全局计数（不是记录自己的 publishedRevision）：
 * 每模式全局递增才能保证「撤回后重新发布」「发布另一条记录」都产生更大的修订号，
 * 已读记录不会被旧号吞掉。
 *
 * `recordId` 是新增字段：扩展用它做查看统计的定位键。旧客户端不认识它，忽略即可；
 * 仍然只返回生效展示字段，不含草稿、账号或凭据。
 */
function toPublishedPayload(mode: string, row: PolicyRow | null, slot: SlotRow | null) {
  if (!slot?.activeRecordId || !row || !row.publishedContentHtml) return null;
  if (row.recordId !== slot.activeRecordId) return null;
  if (row.publishedMode !== mode) return null;
  return {
    recordId: row.recordId,
    mode,
    revision: slot.revision,
    title: row.publishedTitle ?? '',
    contentHtml: row.publishedContentHtml,
    requiredVersion: row.publishedRequiredVersion ?? null,
    downloadUrl: row.publishedDownloadUrl ?? null,
    publishedAt: row.publishedAt ?? null,
  };
}

async function readSlots(): Promise<Map<string, SlotRow>> {
  const db = getDb();
  const rows = await db.select().from(popupActiveSlots);
  return new Map(rows.map((r) => [r.mode, r]));
}

async function findRecord(recordId: string): Promise<PolicyRow | null> {
  const db = getDb();
  const rows = await db.select().from(popupPolicies).where(eq(popupPolicies.recordId, recordId)).limit(1);
  return rows[0] ?? null;
}

// ==================== 公开读取（扩展用） ====================

export const popupPublic = new Hono();

/**
 * 公开策略读取。
 *
 * 只返回生效展示字段。**绝不能**在这里返回草稿、账号、店铺或凭据 —— 该接口免鉴权，
 * 任何多带的字段都是对外暴露面。两个字段都**必须显式存在**（可为 null），
 * 扩展据此区分「明确撤回」与「服务端半截响应」。
 */
popupPublic.get('/popup-policy', async (c) => {
  const db = getDb();
  const slots = await readSlots();
  const records = await db.select().from(popupPolicies);
  const byRecordId = new Map(records.map((r) => [r.recordId, r]));

  const resolve = (mode: string) => {
    const slot = slots.get(mode) ?? null;
    const row = slot?.activeRecordId ? byRecordId.get(slot.activeRecordId) ?? null : null;
    // 双层校验：槽指向的记录，其**生效快照类型**必须与槽类型一致。
    // 只信槽会被「改过类型的记录占着旧槽」这种情况骗到（B3）。
    if (row && row.publishedMode !== mode) return null;
    return toPublishedPayload(mode, row, slot);
  };

  // no-store：策略变更后不允许中间层缓存住旧内容，否则撤回要等缓存过期才生效。
  c.header('Cache-Control', 'no-store');
  return c.json({ notice: resolve('notice'), forcedUpdate: resolve('forced_update') });
});

/**
 * 展示上报（扩展在真实界面显示了某条弹窗后调用）。
 *
 * 为什么单独挂在同一公开前缀下、且**允许匿名**：任务书要求「不为统计要求先登录」，
 * 且上报失败不能影响已显示的弹窗 —— 所以未登录/无效 token 一律返回 200 并标注未计入，
 * 而不是 401。扩展侧不会因为这里返回错误而登出或清缓存。
 *
 * 账号来源只有服务端：解 token → 查当前数据库账号有效 → 用 userId 写库。
 * 请求体里的 userId／邮箱／revision 一律不采信（revision 只做追溯记录）。
 */
popupPublic.post('/popup-views', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ counted: false, reason: 'bad-request' });
  }

  const recordId = typeof body.recordId === 'string' ? body.recordId : '';
  const mode = typeof body.mode === 'string' ? body.mode : '';
  // revision 原样取出交给校验函数：**不要**在这里把缺失值兜成 0。
  // 兜底会把「没给修订」变成「给了一个合法数字」，校验层再也分辨不出来（F1）。
  const revision = body.revision;

  if (!/^[0-9a-f-]{36}$/i.test(recordId) || !isPopupMode(mode)) {
    return c.json({ counted: false, reason: 'bad-request' });
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ counted: false, reason: 'anonymous' });
  }

  let userId: number;
  try {
    const payload = await verifyToken(authHeader.slice(7));
    userId = payload.userId;
  } catch {
    return c.json({ counted: false, reason: 'anonymous' });
  }

  // 停用／删除的账号不计入，即使 token 本身仍在有效期内。
  if (!(await isActiveAccount(userId))) {
    return c.json({ counted: false, reason: 'anonymous' });
  }

  const target = await validateViewTarget(recordId, mode, revision);
  if (!target.counted) {
    return c.json({ counted: false, reason: target.reason });
  }

  // 到这里 revision 已被校验为正的安全整数；用断言收窄类型而不是再判一次。
  const isNew = await recordView(recordId, userId, mode, revision as number);
  return c.json({ counted: true, isNewView: isNew });
});

// ==================== 图片资源读取（公开只读） ====================

export const popupAssetsRoute = new Hono();

/**
 * 图片资源读取。
 *
 * 路径只接受数据库里存在的 opaqueId，且用白名单字符集过滤，避免
 * `..%2f` 之类的路径穿越读到目录外文件。
 */
popupAssetsRoute.get('/:opaqueId', async (c) => {
  const opaqueId = c.req.param('opaqueId');
  if (!/^[a-f0-9]{32}$/.test(opaqueId)) {
    return c.json({ error: '资源不存在' }, 404);
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(popupAssets)
    .where(eq(popupAssets.opaqueId, opaqueId))
    .limit(1);
  const asset = rows[0];
  if (!asset) {
    return c.json({ error: '资源不存在' }, 404);
  }

  const filePath = join(ASSETS_DIR, asset.opaqueId);
  if (!existsSync(filePath)) {
    return c.json({ error: '资源不存在' }, 404);
  }

  const bytes = await readFile(filePath);
  c.header('Content-Type', asset.mimeType);
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  return c.body(new Uint8Array(bytes));
});

// ==================== 管理员读写 ====================

export const popupAdmin = new Hono();

popupAdmin.use('*', authMiddleware, adminMiddleware);

/** 列表：全部记录 + 总数 + 每模式生效槽状态 + 每条累计去重查看人数。 */
popupAdmin.get('/popup-policies', async (c) => {
  const db = getDb();
  const slots = await readSlots();
  const rows = await db.select().from(popupPolicies).orderBy(desc(popupPolicies.id));
  const counts = await viewCountsByRecord();

  const records = rows.map((row) =>
    toAdminRecord(row, slots, counts.get(row.recordId) ?? 0),
  );

  return c.json({
    total: records.length,
    records,
    slots: POPUP_MODES.map((mode) => ({
      mode,
      revision: slots.get(mode)?.revision ?? 0,
      activeRecordId: slots.get(mode)?.activeRecordId ?? null,
    })),
  });
});

/** 单条记录详情（编辑时按 ID 拉取，避免列表缓存导致的脏读）。 */
popupAdmin.get('/popup-policies/:recordId', async (c) => {
  const row = await findRecord(c.req.param('recordId'));
  if (!row) return c.json({ error: '记录不存在' }, 404);
  const slots = await readSlots();
  const viewCount = await viewCountFor(row.recordId);
  return c.json({ record: toAdminRecord(row, slots, viewCount) });
});

/**
 * 查看明细（当前管理员限定）：账号 + 首次查看时间 + 总数，按首次查看时间倒序分页。
 *
 * 为什么只给管理员：邮箱属于个人信息。这里用 adminMiddleware（查库判定当前身份），
 * 普通用户、匿名、以及已被撤权的旧管理员 token 都拿不到。
 */
popupAdmin.get('/popup-policies/:recordId/viewers', async (c) => {
  const recordId = c.req.param('recordId');
  const row = await findRecord(recordId);
  if (!row) return c.json({ error: '记录不存在' }, 404);

  const rawLimit = Number(c.req.query('limit') ?? '20');
  const rawOffset = Number(c.req.query('offset') ?? '0');
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 100) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;

  const [viewers, total] = await Promise.all([
    listViewers(recordId, limit, offset),
    viewCountFor(recordId),
  ]);

  // 口径写进响应，避免前端各自解释「X 位用户查看过」到底算的是什么。
  return c.json({
    recordId,
    total,
    limit,
    offset,
    /** 累计按登录账号去重，含该记录的历史发布；同账号多设备只算一位。 */
    dedupe: 'by-login-account',
    scope: 'cumulative-including-previous-publishes',
    /** 以服务器已收到的展示上报为准：离线或关闭过快可能漏记。 */
    source: 'server-received-display-reports',
    viewers: viewers.map((v) => ({
      email: v.email,
      firstViewedAt: v.firstViewedAt,
      mode: v.mode,
      revision: v.revision,
    })),
  });
});

/**
 * 新建：开空白记录。记录 ID 由服务端生成，客户端不能指定（避免猜测/覆盖他人记录）。
 *
 * 新建窗口是空白的，所以**允许标题与正文为空**；但只要带了正文，就必须过同一套
 * 内容上限与清洗 —— 否则超长正文可以从新建接口绕过校验存进去。
 */
popupAdmin.post('/popup-policies', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const mode = body.mode ?? 'notice';
  if (!isPopupMode(mode)) return c.json({ error: '未知弹窗模式' }, 400);

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length > MAX_TITLE_LENGTH) {
    return c.json({ error: `标题不能超过 ${MAX_TITLE_LENGTH} 个字符` }, 400);
  }

  const contentHtml = sanitizeContentHtml(body.contentHtml);
  if (utf8ByteLength(contentHtml) > MAX_CONTENT_BYTES) {
    return c.json({ error: `正文超过 ${Math.floor(MAX_CONTENT_BYTES / 1024)} KiB 上限` }, 400);
  }
  if (countOwnAssets(contentHtml) > MAX_IMAGES_PER_BODY) {
    return c.json({ error: `正文最多包含 ${MAX_IMAGES_PER_BODY} 张图片` }, 400);
  }

  // 强制模式若已填版本/地址，同样要校验格式（留空表示稍后再补）。
  let requiredVersion: string | null = null;
  let downloadUrl: string | null = null;
  if (mode === 'forced_update') {
    if (body.requiredVersion) {
      requiredVersion = validateVersion(body.requiredVersion);
      if (!requiredVersion) return c.json({ error: '要求版本必须是 1～4 段数字（如 1.15.0）' }, 400);
    }
    if (body.downloadUrl) {
      downloadUrl = validateDownloadUrl(body.downloadUrl);
      if (!downloadUrl) return c.json({ error: '下载地址必须是合法的 http(s) 链接' }, 400);
    }
  }

  const db = getDb();
  const recordId = crypto.randomUUID();
  await db.insert(popupPolicies).values({
    recordId,
    mode,
    draftTitle: title,
    draftContentHtml: contentHtml,
    draftRequiredVersion: requiredVersion,
    draftDownloadUrl: downloadUrl,
  });

  const row = await findRecord(recordId);
  const slots = await readSlots();
  return c.json({ record: toAdminRecord(row!, slots) }, 201);
});

/** 按 ID 保存草稿。不改变生效内容 —— 这是「草稿不影响正式内容」的实现点。 */
popupAdmin.patch('/popup-policies/:recordId/draft', async (c) => {
  const row = await findRecord(c.req.param('recordId'));
  if (!row) return c.json({ error: '记录不存在' }, 404);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: '请求体必须是 JSON' }, 400);
  }

  // 允许改类型（勾选/取消「强制更新」）。
  const nextMode = body.mode === undefined ? row.mode : body.mode;
  if (!isPopupMode(nextMode)) return c.json({ error: '未知弹窗模式' }, 400);

  const validation = validateDraft(nextMode, body, false);
  if (!validation.ok) {
    return c.json({ error: validation.reasons.join('；'), reasons: validation.reasons }, 400);
  }

  const db = getDb();
  await db
    .update(popupPolicies)
    .set({
      mode: nextMode,
      draftTitle: validation.title,
      draftContentHtml: validation.contentHtml,
      draftRequiredVersion: validation.requiredVersion,
      draftDownloadUrl: validation.downloadUrl,
      draftUpdatedAt: new Date().toISOString(),
    })
    .where(eq(popupPolicies.recordId, row.recordId));

  const updated = await findRecord(row.recordId);
  const slots = await readSlots();
  return c.json({ message: '草稿已保存', record: toAdminRecord(updated!, slots) });
});

/**
 * 按 ID 发布。
 *
 * 一次事务内：写该记录的生效快照（含 `published_mode`）→ 把该模式的生效槽指向这条
 * 记录 → 递增槽位 revision。
 *
 * revision 是**每模式全局递增**，不随记录 ID 重置 —— 否则新记录会复用旧修订号，
 * 已被用户确认过的旧通知修订会把它吞掉。
 *
 * 改过类型的记录（B3）：草稿类型可能已从 forced_update 改成 notice，但旧生效快照
 * 还挂在**原类型**的槽上。发布时必须在同一事务里把**原类型的槽清掉**，否则同一条
 * 记录会同时占两个类型的生效槽，公开接口两模式都返回它。
 */
popupAdmin.post('/popup-policies/:recordId/publish', async (c) => {
  const row = await findRecord(c.req.param('recordId'));
  if (!row) return c.json({ error: '记录不存在' }, 404);

  const newMode = row.mode;
  const validation = validateDraft(
    newMode,
    {
      title: row.draftTitle,
      contentHtml: row.draftContentHtml,
      requiredVersion: row.draftRequiredVersion,
      downloadUrl: row.draftDownloadUrl,
    },
    true,
  );
  if (!validation.ok) {
    return c.json({ error: validation.reasons.join('；'), reasons: validation.reasons }, 400);
  }

  const db = getDb();
  const slots = await readSlots();

  // 老生效槽可能挂在与新类型不同的 mode 上（草稿被改过类型）
  const previousSlot = slots.get(row.publishedMode ?? '') ?? null;
  const previousRecordId = previousSlot?.activeRecordId ?? null;

  const slot = slots.get(newMode);
  const nextRevision = (slot?.revision ?? 0) + 1;

  // 替换提示：同模式已有别的生效记录时，告诉管理员替换了谁
  let replacedTitle: string | null = null;
  if (previousRecordId && previousRecordId !== row.recordId) {
    const previous = await findRecord(previousRecordId);
    replacedTitle = previous?.publishedTitle ?? previous?.draftTitle ?? null;
  } else if (slot?.activeRecordId && slot.activeRecordId !== row.recordId) {
    const previous = await findRecord(slot.activeRecordId);
    replacedTitle = previous?.publishedTitle ?? previous?.draftTitle ?? null;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(popupPolicies)
      .set({
        publishedRevision: nextRevision,
        publishedMode: newMode,
        publishedTitle: validation.title,
        publishedContentHtml: validation.contentHtml,
        publishedRequiredVersion: validation.requiredVersion,
        publishedDownloadUrl: validation.downloadUrl,
        publishedAt: new Date().toISOString(),
      })
      .where(eq(popupPolicies.recordId, row.recordId));

    // 先把本记录可能占着的**其他类型**槽释放，避免一条记录同时生效两种类型
    await tx
      .update(popupActiveSlots)
      .set({ activeRecordId: null, updatedAt: new Date().toISOString() })
      .where(eq(popupActiveSlots.activeRecordId, row.recordId));

    await tx
      .update(popupActiveSlots)
      .set({
        activeRecordId: row.recordId,
        revision: nextRevision,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(popupActiveSlots.mode, newMode));
  });

  return c.json({ message: '已发布', revision: nextRevision, replacedTitle });
});

/**
 * 按 ID 撤回。
 *
 * 只清该记录的生效快照展示字段；`published_revision` 保留（用于「曾发布过」判定），
 * 生效快照的类型（`published_mode`）也保留，便于撤回后再发布时定位。
 *
 * 定位生效槽用 `published_mode`（**不是**可能已被改过的草稿 `mode`），
 * 且只有该槽确实指向本记录时才清 —— 否则会误撤同类型另一条正在生效的记录。
 */
popupAdmin.post('/popup-policies/:recordId/withdraw', async (c) => {
  const row = await findRecord(c.req.param('recordId'));
  if (!row) return c.json({ error: '记录不存在' }, 404);

  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(popupPolicies)
      .set({
        publishedTitle: null,
        publishedContentHtml: null,
        publishedRequiredVersion: null,
        publishedDownloadUrl: null,
        publishedAt: null,
      })
      .where(eq(popupPolicies.recordId, row.recordId));

    // 按「实际挂着本记录的槽」定位，不依赖草稿 mode
    const held = await tx
      .select()
      .from(popupActiveSlots)
      .where(eq(popupActiveSlots.activeRecordId, row.recordId));
    for (const slot of held) {
      await tx
        .update(popupActiveSlots)
        .set({ activeRecordId: null, updatedAt: new Date().toISOString() })
        .where(eq(popupActiveSlots.mode, slot.mode));
    }
  });

  return c.json({ message: '已撤回' });
});

/**
 * 图片上传。
 *
 * 安全检查顺序（任一失败都拒绝，不写文件不写库）：
 * 1. 文件存在且不超过 5 MiB
 * 2. 实际字节签名是 PNG／JPEG／WebP（不信任声明的 Content-Type）
 * 3. 文件名不参与路径拼装 —— 落盘名用随机 hex，用户文件名原样丢弃
 */
popupAdmin.post('/popup-assets', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: '请求必须是 multipart/form-data' }, 400);
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: '缺少上传文件' }, 400);
  }
  if (file.size === 0) {
    return c.json({ error: '文件为空' }, 400);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: `图片不能超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MiB` }, 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectImageMime(bytes);
  if (!mime) {
    return c.json({ error: '只支持 PNG、JPEG、WebP 图片（按实际文件内容判定）' }, 400);
  }

  ensureAssetsDir();
  const opaqueId = crypto.randomBytes(16).toString('hex');
  await writeFile(join(ASSETS_DIR, opaqueId), bytes);

  const db = getDb();
  await db.insert(popupAssets).values({
    opaqueId,
    mimeType: mime,
    byteSize: bytes.byteLength,
  });

  return c.json({ url: `${ASSET_PATH_PREFIX}${opaqueId}`, mimeType: mime, byteSize: bytes.byteLength });
});

export { ASSETS_DIR };
