import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { popupActiveSlots, popupPolicies, popupViews, users } from '../db/schema.js';

/**
 * 弹窗「查看」统计的独立模块。
 *
 * 为什么独立成模块而不是写进 popup.ts：统计与弹窗内容发布是两条互不影响的生命周期 ——
 * 发布接口出错不该影响统计，统计出错也不能影响弹窗展示。分开后两者的失败面不交叉。
 *
 * 口径（与任务书第 8 节 U2 一致）：
 * - 「查看」= 该条生效弹窗在真实扩展界面里被显示并成功上报，
 *   不是「请求过策略接口／管理端预览／点了确认或下载」。
 * - 每个 recordId 按**登录账号**累计去重（唯一键 record_id + user_id）。
 * - 账号只来自服务端 token + 当前数据库状态，客户端传来的 userId／邮箱一律不用。
 * - 撤回、重新发布、改草稿都不清空累计值。
 */

/** 上报校验结果。reason 只用于服务端日志与响应，不对外暴露细节。 */
export interface ViewReportOutcome {
  counted: boolean;
  reason?: 'anonymous' | 'unknown-record' | 'not-published' | 'mode-mismatch' | 'not-active' | 'bad-revision' | 'stale-revision';
}

/**
 * 校验一条上报是否可以计数。
 *
 * 四个条件缺一不可，都是为了让「人数」只反映**真实展示过的生效内容**：
 *
 * 1. `published_revision > 0` —— 草稿从未发布过。没有这一关，一个知道 recordId 的
 *    用户就能给未公开的草稿刷人数（发现接口后枚举即可）。
 * 2. `published_mode === mode` —— 生效快照的类型必须与上报类型一致。否则同一条记录
 *    会同时给两个类型计数，与「每模式至多一条生效」的模型矛盾（B3 同源问题）。
 * 3. 该记录**当前确实占着这个类型的生效槽** —— 撤回后记录行还在（累计人数要保留），
 *    但它已经不在生效槽上了。只看前两条会把「撤回之后晚到的上报」也计进去，
 *    于是管理员撤回后人数还会自己往上涨，与「撤回后保留累计、不再新增」矛盾。
 * 4. 上报的 `revision` 必须**恰好等于该生效槽当前的全局 revision**。
 *
 * 为什么第 4 条必须比对**生效槽的 revision**，而不是记录自己的 `published_revision`：
 * 槽位的 revision 才是公开接口发给客户端、用户实际看到的那一个。用记录自己的发布次数
 * 会漏掉「同类型另一条记录发布后槽位前进了、但本记录自己的次数没变」这种情况，
 * 旧修订就能一直刷人数。两者在单记录场景恰好相等，所以只有比对槽位 revision 才既
 * 覆盖真实场景又不会误伤。
 *
 * 为什么必须拒绝缺失／零／负数／小数／不存在的修订：这些值都不可能是服务端发出去的。
 * 接受它们等于「任何已登录账号都能只用 recordId 就给任意生效记录加人」，统计就不真实了。
 * 拒绝是**温和**的：返回 `counted:false` 而不是错误状态，扩展侧不因此登出或清缓存。
 */
export async function validateViewTarget(
  recordId: string,
  mode: string,
  revision: unknown,
): Promise<ViewReportOutcome> {
  // 先做纯格式校验：必须是正的安全整数。缺省、字符串、小数、0、负数全部挡在这里。
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) {
    return { counted: false, reason: 'bad-revision' };
  }

  const db = getDb();
  const rows = await db
    .select({
      publishedRevision: popupPolicies.publishedRevision,
      publishedMode: popupPolicies.publishedMode,
      activeRecordId: popupActiveSlots.activeRecordId,
      slotRevision: popupActiveSlots.revision,
    })
    .from(popupPolicies)
    .leftJoin(popupActiveSlots, eq(popupActiveSlots.mode, mode))
    .where(eq(popupPolicies.recordId, recordId))
    .limit(1);

  const row = rows[0];
  if (!row) return { counted: false, reason: 'unknown-record' };
  if (!(row.publishedRevision > 0)) return { counted: false, reason: 'not-published' };
  if (row.publishedMode !== mode) return { counted: false, reason: 'mode-mismatch' };
  if (row.activeRecordId !== recordId) return { counted: false, reason: 'not-active' };
  // 只接受「当前生效槽的修订号」：重新发布后旧修订立刻失效，不存在的号也不写库。
  if (row.slotRevision !== revision) return { counted: false, reason: 'stale-revision' };
  return { counted: true };
}

/**
 * 记录一次查看。
 *
 * 用 `ON CONFLICT DO NOTHING` 而不是「先查再插」：并发上报（多设备／StrictMode 重复
 * effect）会同时通过查询判断，然后各插一行。唯一索引 + 冲突忽略让数据库自己保证只算一位。
 *
 * 首次查看时间取库里已有那行的时间：重复上报**不能**刷新它，否则「首次查看」会漂移。
 */
export async function recordView(
  recordId: string,
  userId: number,
  mode: string,
  revision: number,
): Promise<boolean> {
  const db = getDb();
  const inserted = await db
    .insert(popupViews)
    .values({ recordId, userId, mode, revision })
    .onConflictDoNothing()
    .returning({ id: popupViews.id });

  return inserted.length > 0;
}

/** 校验 token 里的账号当前是否仍然有效（停用／删除的账号不能计入统计）。 */
export async function isActiveAccount(userId: number): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.isActive, 1)))
    .limit(1);
  return rows.length > 0;
}

/**
 * 每条记录的累计去重人数，按 recordId 索引。列表页一次取完，避免 N+1 查询。
 *
 * **必须 JOIN users**：查看表里的行在账号被删除后会留下来（统计不随账号删除清理），
 * 但明细列表用 INNER JOIN 取不到已删除账号的邮箱。若人数只数查看表的行，
 * 就会出现「说 2 位、明细只有 1 条」——验收明确要求两者一致。两处用同一个 JOIN。
 */
export async function viewCountsByRecord(): Promise<Map<string, number>> {
  const db = getDb();
  const rows = await db
    .select({ recordId: popupViews.recordId, count: sql<number>`count(*)` })
    .from(popupViews)
    .innerJoin(users, eq(users.id, popupViews.userId))
    .groupBy(popupViews.recordId);
  return new Map(rows.map((r) => [r.recordId, Number(r.count)]));
}

/** 单条记录的累计去重人数。JOIN 口径与 {@link viewCountsByRecord}、{@link listViewers} 一致。 */
export async function viewCountFor(recordId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`count(*)` })
    .from(popupViews)
    .innerJoin(users, eq(users.id, popupViews.userId))
    .where(eq(popupViews.recordId, recordId));
  return Number(rows[0]?.count ?? 0);
}

/**
 * 查看明细（账号 + 首次查看时间），按首次查看时间倒序分页。
 *
 * 只向当前管理员返回邮箱，不返回 token／密码／店铺信息。
 * 排序加 `user_id` 兜底：同一秒内多条记录的顺序必须稳定，否则翻页会漏或重。
 */
export async function listViewers(
  recordId: string,
  limit: number,
  offset: number,
): Promise<Array<{ email: string; firstViewedAt: string; mode: string; revision: number }>> {
  const db = getDb();
  const rows = await db
    .select({
      email: users.email,
      firstViewedAt: popupViews.firstViewedAt,
      mode: popupViews.mode,
      revision: popupViews.revision,
    })
    .from(popupViews)
    .innerJoin(users, eq(users.id, popupViews.userId))
    .where(eq(popupViews.recordId, recordId))
    .orderBy(sql`${popupViews.firstViewedAt} DESC, ${popupViews.userId} DESC`)
    .limit(limit)
    .offset(offset);
  return rows;
}
