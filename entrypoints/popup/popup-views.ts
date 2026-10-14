import { getAuthUser, getToken, onAuthReady } from './backend-api';

/**
 * 弹窗「查看」上报（扩展侧独立模块）。
 *
 * 设计约束（对应任务书第 8 节 U2 与第 13 节 U4 的接入要求）：
 * - 只给**实际显示**的那一条上报。强制优先时被遮住的通知、已确认不再显示的
 *   通知、版本已达标而未显示的强制都不调这里 —— 由宿主只在渲染时调用保证。
 * - 使用**当次策略的后端地址**，单独有限超时；不进入 `checkPolicy()` 的 5 秒预算。
 * - 任何失败（网络／超时／storage 卡住／401）都**静默吞掉**：不能阻断弹窗、
 *   不能解除已知强制缓存、不能触发登出。
 * - 不新增后台队列或 alarms，不做高频重试；离线或关闭过快允许漏记。
 */

/** 单次上报上限。比策略检查短，保证它不会拖住用户看到弹窗。 */
export const VIEW_REPORT_TIMEOUT_MS = 3000;

/**
 * 已经报过的组合，避免同一次会话里重复发请求。
 *
 * 键里**必须带当次上报使用的账号 ID**：这个集合是模块级的，宿主卸载不会重置它，
 * 而用户可以在同一个 popup 里退出再换账号登录。若键只有「后端 + 记录 + 修订」，
 * 账号 A 报过一次之后，B 看同一条同修订会被直接判定「报过了」而跳过 ——
 * 服务端永远收不到 B 的展示，人数就少一位（F3）。
 *
 * 用 userId 而不是 token 全文：token 会刷新／换发，用全文会把同一个人算成两个键，
 * 反而重复上报。userId 才是「账号」这个语义。
 */
const reported = new Set<string>();

function reportKey(
  backendUrl: string,
  recordId: string,
  revision: number,
  userId: number | null,
): string {
  return `${backendUrl}|${recordId}|${revision}|${userId ?? 'anonymous'}`;
}

/**
 * 上报一次展示。
 *
 * 身份未就绪时的处理：订阅 `onAuthReady`，等身份真正就绪且弹窗**仍在显示**时补报一次。
 * 为什么不能只看调用瞬间的 `getToken()`：策略检查早于身份恢复完成，
 * 那一刻取到的 token 是 null，会把每次冷启动的首次展示都误判成匿名。
 *
 * @param stillVisible 回调式判定；补报前再问一次「这条现在还显示着吗」。
 * @returns 解除订阅的函数，组件卸载时调用。
 */
export function reportPopupView(
  backendUrl: string,
  recordId: string | null,
  mode: string,
  revision: number,
  stillVisible: () => boolean,
): () => void {
  // 旧缓存／旧后端没有 recordId：跳过统计，但绝不影响已显示的弹窗。
  if (!recordId || !backendUrl) return () => undefined;

  let cancelled = false;
  let unsubscribe: (() => void) | null = null;

  const send = (userId: number | null, token: string) => {
    if (cancelled) return;
    const key = reportKey(backendUrl, recordId, revision, userId);
    if (reported.has(key)) return;
    reported.add(key);
    // 把 key 一起交给请求：失败时要删的是**这一次**用的键。
    // 不能失败后再按当前账号重算 —— 期间账号可能已经换成别人，删错键会让
    // 真正的那个账号下次被误判成「报过了」。
    void postView(backendUrl, recordId, mode, revision, token, key);
  };

  // 身份已就绪：直接上报。否则等就绪回调（晚到的身份恢复也要补报一次）。
  const token = getToken();
  if (token) {
    send(getAuthUser()?.id ?? null, token);
  } else {
    unsubscribe = onAuthReady((userId, readyToken) => {
      // 身份就绪时这条可能已经被关掉或已被强制遮住 —— 只在仍显示时补报。
      if (!cancelled && stillVisible()) send(userId, readyToken);
    });
  }

  return () => {
    cancelled = true;
    unsubscribe?.();
  };
}

/**
 * 真正发请求。全程吞异常 —— 统计失败不属于用户可见错误。
 */
async function postView(
  backendUrl: string,
  recordId: string,
  mode: string,
  revision: number,
  token: string,
  key: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIEW_REPORT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    headers['Authorization'] = `Bearer ${token}`;

    await fetch(`${backendUrl.replace(/\/+$/, '')}/api/extension/popup-views`, {
      method: 'POST',
      headers,
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({ recordId, mode, revision }),
    });
    // 不看响应体：服务端拒绝（草稿／未发布／匿名／过期修订）不需要前端做任何事。
  } catch {
    // 网络／超时／中止：允许漏记，不重试、不提示、不影响弹窗。
    // 删掉**这次**的键，让下次展示还能再试一次（否则一次网络抖动就永久漏记该账号）。
    reported.delete(key);
  } finally {
    clearTimeout(timer);
  }
}
