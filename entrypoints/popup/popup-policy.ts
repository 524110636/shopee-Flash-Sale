/**
 * 弹窗策略：读取、版本比较、确认记录、缓存。
 *
 * 为什么单独成模块：这套判断要在 popup 每次打开时跑一次，且必须能在
 * 认证分支之前执行（未登录也要挡）。放进 store 会和登录/店铺初始化纠缠不清。
 *
 * 关键约定：
 * - 已读记录与缓存**按后端地址分别保存**，切后端不串（设计要求）。
 * - 网络失败**不等于**撤回：有缓存就沿用，无缓存才提示连接问题。
 * - 判定升级只认 `browser.runtime.getManifest().version`，不认下载/已读标记。
 */

export type PopupMode = 'notice' | 'forced_update';

export interface PopupPolicyEntry {
  mode: PopupMode;
  revision: number;
  title: string;
  contentHtml: string;
  requiredVersion: string | null;
  downloadUrl: string | null;
  publishedAt: string | null;
  /**
   * 稳定记录 ID，仅用于查看统计。**可选**：旧后端、旧缓存里没有这个字段，
   * 此时跳过统计但**照常展示**（不能因为缺统计字段就把旧缓存判非法、解除阻挡）。
   */
  recordId: string | null;
}

export interface PopupPolicyPayload {
  notice: PopupPolicyEntry | null;
  forcedUpdate: PopupPolicyEntry | null;
}

export type PolicySource = 'network' | 'cache' | 'none';

export interface PolicyResult {
  payload: PopupPolicyPayload;
  source: PolicySource;
  /** 网络失败或响应无效时非空，用于界面提示「连接问题」。 */
  connectionError: string | null;
}

const CACHE_KEY = '_popupPolicyCache';
const ACK_KEY = '_popupNoticeAck';

/** 打开时策略检查上限，超时按连接失败处理，不无限等待（设计要求最多 5 秒）。 */
export const POLICY_TIMEOUT_MS = 5000;

const EMPTY_PAYLOAD: PopupPolicyPayload = { notice: null, forcedUpdate: null };

/** 与后端 validateVersion 同一套规则：1～4 段数字，每段 0～65535，无非零前导零，整体不全零。 */
export function isValidRequiredVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(trimmed)) return false;
  const parts = trimmed.split('.');
  if (parts.length > 4) return false;
  for (const part of parts) {
    if (part.length > 1 && part.startsWith('0')) return false;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 65535) return false;
  }
  return !parts.every((p) => Number(p) === 0);
}

/** 下载地址只接受 http(s)；危险协议视为非法条目。 */
export function isValidDownloadUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 条目校验。
 *
 * 必须查 mode、revision、要求版本与下载地址（强制模式），不能只看「有没有字符串」：
 * 服务端半截响应或被篡改的响应会让强制策略看起来「合法但无需阻挡」，
 * 从而解除本该保留的阻挡。
 */
function parseEntry(value: unknown, expectedMode: PopupMode): PopupPolicyEntry | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.mode !== expectedMode) return null;
  if (typeof v.revision !== 'number' || !Number.isFinite(v.revision) || v.revision <= 0) return null;
  if (typeof v.title !== 'string' || typeof v.contentHtml !== 'string') return null;

  if (expectedMode === 'forced_update') {
    // 强制模式没有合法的要求版本或下载地址就无法判定是否达标 → 整条无效
    if (!isValidRequiredVersion(v.requiredVersion)) return null;
    if (!isValidDownloadUrl(v.downloadUrl)) return null;
  }

  return {
    mode: expectedMode,
    revision: v.revision,
    title: v.title,
    contentHtml: v.contentHtml,
    requiredVersion: typeof v.requiredVersion === 'string' ? v.requiredVersion : null,
    downloadUrl: typeof v.downloadUrl === 'string' ? v.downloadUrl : null,
    publishedAt: typeof v.publishedAt === 'string' ? v.publishedAt : null,
    // 只接受 UUID 形态；其他值一律当「没有 ID」处理，不影响本条内容的合法性。
    recordId: typeof v.recordId === 'string' && /^[0-9a-f-]{36}$/i.test(v.recordId) ? v.recordId : null,
  };
}

/**
 * 结构校验。
 *
 * 关键约束：**两个字段都必须存在**（显式 `null` 才算「该模式无生效内容」）。
 * 旧实现把 `undefined` 也当 `null`，于是 `{}` 被当成「服务端明确撤回」，
 * 会把已知强制缓存删掉 —— 断网期间服务端返回半截 JSON 就等于解除阻挡。
 */
function parsePayload(raw: unknown): PopupPolicyPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  if (!Object.hasOwn(v, 'notice') || !Object.hasOwn(v, 'forcedUpdate')) return null;

  const parseSide = (value: unknown, mode: PopupMode): PopupPolicyEntry | null | 'invalid' => {
    if (value === null) return null;
    const entry = parseEntry(value, mode);
    return entry ?? 'invalid';
  };

  const notice = parseSide(v.notice, 'notice');
  const forced = parseSide(v.forcedUpdate, 'forced_update');
  if (notice === 'invalid' || forced === 'invalid') return null;

  return { notice, forcedUpdate: forced };
}

/**
 * 版本逐段数字比较。
 *
 * 必须按数字段比较，不能按字符串：`1.14.10` 字符串小于 `1.14.9`，
 * 但数字上 10 > 9，按字符串比会把已升级的包判成旧版本。
 * 缺失段补零，因此 `1.15` 等于 `1.15.0`。
 *
 * @returns 负数表示 a < b，0 表示相等，正数表示 a > b
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number(p) || 0);
  const pb = b.split('.').map((p) => Number(p) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 当前实际加载版本。manifest 是唯一可信来源，不用 package.json 或 zip 名。 */
export function getActualVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

/** 命中强制升级：有生效策略、要求版本合法、且实际版本严格更低。 */
export function isForcedUpdateHit(entry: PopupPolicyEntry | null, actualVersion: string): boolean {
  if (!entry || !entry.requiredVersion) return false;
  return compareVersions(actualVersion, entry.requiredVersion) < 0;
}

interface CachedRecord {
  [backendUrl: string]: PopupPolicyPayload;
}

async function readCacheMap(): Promise<CachedRecord> {
  try {
    const result = await browser.storage.local.get(CACHE_KEY);
    const value = result[CACHE_KEY];
    if (value && typeof value === 'object') return value as CachedRecord;
  } catch { /* 忽略读取失败，按无缓存处理 */ }
  return {};
}

async function writeCache(backendUrl: string, payload: PopupPolicyPayload): Promise<void> {
  const map = await readCacheMap();
  map[backendUrl] = payload;
  await browser.storage.local.set({ [CACHE_KEY]: map });
}

async function clearCacheFor(backendUrl: string): Promise<void> {
  const map = await readCacheMap();
  delete map[backendUrl];
  await browser.storage.local.set({ [CACHE_KEY]: map });
}

async function readCachedPolicy(backendUrl: string): Promise<PopupPolicyPayload | null> {
  const map = await readCacheMap();
  return map[backendUrl] ?? null;
}

/**
 * 读取已确认的通知修订。按「后端地址 → 修订号」保存：
 * 同一后端确认过的修订不再重复弹，新发布（revision 变大）会再次弹出。
 */
async function readNoticeAck(): Promise<Record<string, number>> {
  try {
    const result = await browser.storage.local.get(ACK_KEY);
    const value = result[ACK_KEY];
    if (value && typeof value === 'object') return value as Record<string, number>;
  } catch { /* 忽略 */ }
  return {};
}

export async function getAcknowledgedRevision(backendUrl: string): Promise<number> {
  const map = await readNoticeAck();
  return typeof map[backendUrl] === 'number' ? map[backendUrl] : 0;
}

/** 只有点「我知道了」才调用；直接关掉 popup 不写这里。 */
export async function acknowledgeNotice(backendUrl: string, revision: number): Promise<void> {
  const map = await readNoticeAck();
  map[backendUrl] = revision;
  await browser.storage.local.set({ [ACK_KEY]: map });
}

/** 撤回或换后端后清除该后端的确认记录，避免撤回又发布时旧修订被当作已读。 */
export async function resetNoticeAck(backendUrl: string): Promise<void> {
  const map = await readNoticeAck();
  delete map[backendUrl];
  await browser.storage.local.set({ [ACK_KEY]: map });
}

/**
 * 失败原因分类。
 *
 * 为什么必须分开：三类失败的处置不同 —— 地址/storage 失败通常是本地配置问题，
 * 超时是网络问题，结构错误是服务端或中间层问题。都笼统提示「连接问题」会让
 * 排查时无从下手（验收要求至少区分这四类）。
 */
export type PolicyErrorKind = 'address' | 'timeout' | 'network' | 'response' | 'storage' | 'ack';

export interface PolicyErrorInfo {
  kind: PolicyErrorKind;
  message: string;
}

const ERROR_MESSAGES: Record<PolicyErrorKind, string> = {
  address: '后端地址无效或未配置',
  timeout: `策略检查超时（超过 ${POLICY_TIMEOUT_MS / 1000} 秒）`,
  network: '无法连接弹窗策略服务',
  response: '策略响应格式不正确',
  storage: '无法读取本地缓存',
  ack: '无法保存已读状态',
};

function classifyError(e: unknown): PolicyErrorInfo {
  if (e instanceof PolicyFetchError) {
    return { kind: e.kind, message: ERROR_MESSAGES[e.kind] };
  }
  if (e instanceof Error && e.name === 'AbortError') {
    return { kind: 'timeout', message: ERROR_MESSAGES.timeout };
  }
  return { kind: 'network', message: ERROR_MESSAGES.network };
}

/** 内部错误类型，携带分类。 */
class PolicyFetchError extends Error {
  kind: PolicyErrorKind;
  constructor(kind: PolicyErrorKind) {
    super(kind);
    this.kind = kind;
    this.name = 'PolicyFetchError';
  }
}

/**
 * 给整条异步链加统一上限。
 *
 * 不能只给 `fetch` 设 timeout：地址解析、storage 读写、`response.json()` 都可能挂住，
 * 任何一段没有上限都会让界面停在「正在检查通知」。这里对整个 promise 赛跑。
 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PolicyFetchError('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 拉取策略。
 *
 * 成功且结构有效 → 写入缓存。**只有显式 `notice:null` + `forcedUpdate:null`**
 * 才清除旧生效状态（服务端明确撤回）。失败、超时或结构无效 → 沿用同后端缓存
 * 并附可分类的连接错误，**绝不清缓存**。
 */
export async function fetchPolicy(backendUrl: string): Promise<PolicyResult> {
  const normalized = (backendUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(normalized)) {
    const cached = await safeReadCached(normalized);
    return { payload: cached ?? EMPTY_PAYLOAD, source: cached ? 'cache' : 'none', connectionError: ERROR_MESSAGES.address };
  }

  try {
    const payload = await withDeadline(loadFromNetwork(normalized), POLICY_TIMEOUT_MS);
    if (!payload.notice && !payload.forcedUpdate) {
      // 服务端明确撤回：清掉该后端的生效缓存，避免下次断网又拿旧的挡人。
      await clearCacheFor(normalized).catch(() => undefined);
    } else {
      await writeCache(normalized, payload);
    }
    return { payload, source: 'network', connectionError: null };
  } catch (e) {
    const info = classifyError(e);
    const cached = await safeReadCached(normalized);
    if (cached) {
      return { payload: cached, source: 'cache', connectionError: info.message };
    }
    return { payload: EMPTY_PAYLOAD, source: 'none', connectionError: info.message };
  }
}

/** 读缓存；storage 失败按「无缓存」处理并保留分类信息。
 *  加本地上限：缓存读取本身也可能被 storage 卡住，不能因此把整轮拖过 5 秒。 */
async function safeReadCached(backendUrl: string): Promise<PopupPolicyPayload | null> {
  if (!backendUrl) return null;
  try {
    return await withDeadline(readCachedPolicy(backendUrl), LOCAL_TIMEOUT_MS);
  } catch {
    return null;
  }
}

/** 单次网络请求：非 2xx、非 JSON、结构无效都抛对应分类。 */
async function loadFromNetwork(backendUrl: string): Promise<PopupPolicyPayload> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLICY_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${backendUrl}/api/extension/popup-policy`, {
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof Error && e.name === 'AbortError') throw new PolicyFetchError('timeout');
    throw new PolicyFetchError('network');
  }
  clearTimeout(timer);

  if (!response.ok) throw new PolicyFetchError('response');

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new PolicyFetchError('response');
  }

  const payload = parsePayload(raw);
  if (!payload) throw new PolicyFetchError('response');
  return payload;
}

/**
 * 解析当前生效的后端地址。
 *
 * 为什么不能直接用 backendApi.getBaseUrl()：它的模块变量要到
 * checkAuthOnStartup 里读了 storage 才会被改成用户自定义地址，
 * 而策略检查在挂载时就要发请求 —— 早于那个时刻。用户配了自定义后端时，
 * 会拿默认地址去问策略，表现为「明明发布过却什么都不弹」。
 * 所以这里自己按与 store 相同的规则解析一次。
 */
export async function resolveBackendUrl(): Promise<string> {
  const defaultUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5724';
  try {
    const result = await browser.storage.local.get('backendUrl');
    const stored = result.backendUrl;
    if (typeof stored === 'string' && stored && stored !== defaultUrl) {
      return stored.replace(/\/+$/, '');
    }
  } catch { /* 读不到就用默认地址 */ }
  return defaultUrl.replace(/\/+$/, '');
}

/** 已解析出的地址，供确认/重置等后续操作复用，避免同一轮里解析出不同结果。 */
let resolvedBackendUrl: string | null = null;

/**
 * 同步可得的兜底地址（**不读 storage**）。
 *
 * 为什么需要它：`storage.local.get` 在异常情况下可能永不返回（B1 的复现就是这种）。
 * 地址读取必须有上限，且被拖住时仍需一个地址去读该后端的缓存，否则已知的强制
 * 升级策略会连同地址一起丢掉。
 */
export function fallbackBackendUrl(): string {
  if (resolvedBackendUrl) return resolvedBackendUrl;
  const defaultUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5724';
  return defaultUrl.replace(/\/+$/, '');
}

/** 确保地址已解析；返回解析后的地址。后续所有读写都应以它为准。 */
export async function ensureBackendUrl(): Promise<string> {
  if (!resolvedBackendUrl) {
    resolvedBackendUrl = await resolveBackendUrl();
  }
  return resolvedBackendUrl;
}

/** 一次检查的最终结论。宿主只负责把结论渲染出来。 */
export interface PolicyDecision {
  forced: PopupPolicyEntry | null;
  notice: PopupPolicyEntry | null;
  connectionError: string | null;
  source: PolicySource;
  /**
   * 本轮实际使用的后端地址。
   *
   * 为什么放进 conclusion 而不是让宿主自己再解析一次：宿主原本在
   * `await checkPolicy()`（有 5 秒上限）**之后**又 `await ensureBackendUrl()`，
   * 那一步没有上限 —— 地址读取卡住时整条链照样永远到不了终态（B1）。
   */
  backendUrl: string;
}

/** 判定结论（不含网络来源信息）。 */
type PolicyVerdict = Pick<PolicyDecision, 'forced' | 'notice'>;

const EMPTY_VERDICT: PolicyVerdict = { forced: null, notice: null };

/** 读缓存等本地操作的上限，避免「有上限的链」里再嵌一段没上限的等待。 */
const LOCAL_TIMEOUT_MS = 1000;

/**
 * 完整检查一轮策略（地址解析 → 取策略 → 判版本 → 读已读）。
 *
 * 两个必须满足的约束：
 * 1. **整轮 ≤5 秒**（不是每段 5 秒）：外层只留一个总上限，各段共享这个预算。
 *    上一版给地址解析和后续检查各加了 5 秒，串起来就是 10 秒，不合格（B1）。
 * 2. **超时也要保住已知强制策略**：外层 deadline 抢先返回时，不能让同后端的
 *    有效缓存丢掉 —— 否则断网就等于自动解除升级阻挡（B2）。
 */
export async function checkPolicy(): Promise<PolicyDecision> {
  const startedAt = Date.now();
  // 同步兜底地址：storage 完全卡死时也得有地址去读缓存。
  const fallbackUrl = fallbackBackendUrl();
  let backendUrl = fallbackUrl;

  try {
    const result = await withDeadline(
      (async () => {
        backendUrl = await ensureBackendUrl();
        return runCheck(backendUrl);
      })(),
      POLICY_TIMEOUT_MS,
    );
    return { ...result, backendUrl };
  } catch (e) {
    const info = classifyError(e);
    // 失败/超时路径：在**剩余预算**内沿用该后端的有效缓存。
    // 这条分支是 B2 的修复点 —— 已知强制策略必须继续阻挡。
    const remaining = Math.max(200, POLICY_TIMEOUT_MS - (Date.now() - startedAt));
    const cached = await cachedVerdict(backendUrl || fallbackUrl, remaining);
    if (cached) {
      return { ...cached, connectionError: info.message, source: 'cache', backendUrl: backendUrl || fallbackUrl };
    }
    return { ...EMPTY_VERDICT, connectionError: info.message, source: 'none', backendUrl: backendUrl || fallbackUrl };
  }
}

async function runCheck(backendUrl: string): Promise<Omit<PolicyDecision, 'backendUrl'>> {
  const result = await fetchPolicy(backendUrl);
  const verdict = await evaluate(result.payload, backendUrl);
  return { ...verdict, connectionError: result.connectionError, source: result.source };
}

/**
 * 用一份策略载荷得出「显示强制 / 显示通知 / 都不显示」。
 *
 * 抽成独立函数是为了让「正常路径」与「超时回落缓存路径」走**同一套判定**，
 * 否则两条路径的优先级规则会漂移。
 */
async function evaluate(
  payload: PopupPolicyPayload,
  backendUrl: string,
  budgetMs: number = LOCAL_TIMEOUT_MS,
): Promise<PolicyVerdict> {
  const actual = getActualVersion();

  if (isForcedUpdateHit(payload.forcedUpdate, actual)) {
    // 强制优先：即使有未确认通知也不标记已读。
    return { forced: payload.forcedUpdate, notice: null };
  }
  if (!payload.notice) return EMPTY_VERDICT;

  let acked: number;
  try {
    acked = await withDeadline(getAcknowledgedRevision(backendUrl), budgetMs);
  } catch {
    // 已读状态读不出来时**不能**假设「已读」—— 否则用户再也看不到通知。
    return { forced: null, notice: payload.notice };
  }
  return payload.notice.revision > acked
    ? { forced: null, notice: payload.notice }
    : EMPTY_VERDICT;
}

/** 在给定预算内取该后端的缓存判定；取不到返回 null。 */
async function cachedVerdict(backendUrl: string, budgetMs: number): Promise<PolicyVerdict | null> {
  if (!backendUrl) return null;
  let payload: PopupPolicyPayload | null;
  try {
    payload = await withDeadline(readCachedPolicy(backendUrl), budgetMs);
  } catch {
    return null;
  }
  if (!payload) return null;
  try {
    return await withDeadline(evaluate(payload, backendUrl, budgetMs), budgetMs);
  } catch {
    // 已读读不出来时：至少把已知强制策略保住。这是 B2 的核心要求。
    const actual = getActualVersion();
    return isForcedUpdateHit(payload.forcedUpdate, actual)
      ? { forced: payload.forcedUpdate, notice: null }
      : null;
  }
}

/**
 * 把正文里的自有资源相对路径（`/popup-assets/xxx`）解析成完整 URL。
 *
 * 为什么必须在这里解析：扩展页面的 origin 是 `chrome-extension://<id>`，
 * 相对路径会被解析成扩展自己目录下的文件，表现为图片 `ERR_FILE_NOT_FOUND`、
 * `naturalWidth === 0`。图片实际在后端，必须拼上**读取该策略的后端地址**。
 * 只改写自有资源路径；外部 http(s) 链接原样保留。
 */
export function resolveAssetUrls(html: string, backendUrl: string): string {
  const base = (backendUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return html;
  return html.replace(/(src|href)=(["'])\/popup-assets\//g, (_m, attr: string, quote: string) =>
    `${attr}=${quote}${base}/popup-assets/`);
}
