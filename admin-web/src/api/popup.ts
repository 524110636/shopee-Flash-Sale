/**
 * 弹窗管理请求模块。
 *
 * 复用 api/admin.ts 的 request 能力不方便（它没导出），这里按同样约定单独实现：
 * token 只在内存、401/403 触发退回登录、错误信息取后端 `error` 字段。
 *
 * 数据模型：多条独立记录（稳定 recordId），每模式同一时间至多一条生效。
 */

const BASE_URL = '';

let onUnauthorized: (() => void) | null = null;

export function setPopupUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/** 后端 mode 取值。UI 上表现为「强制更新」勾选框。 */
export type PopupMode = 'notice' | 'forced_update';

/** 记录状态：draft=草稿，published=当前生效，withdrawn=发布过但已不在生效槽。 */
export type PopupRecordStatus = 'draft' | 'published' | 'withdrawn';

export interface PopupDraft {
  title: string;
  contentHtml: string;
  requiredVersion: string | null;
  downloadUrl: string | null;
  updatedAt: string | null;
}

export interface PopupPublishedSnapshot {
  title: string;
  contentHtml: string;
  requiredVersion: string | null;
  downloadUrl: string | null;
  publishedAt: string | null;
}

export interface PopupRecord {
  recordId: string;
  mode: PopupMode;
  isActive: boolean;
  status: PopupRecordStatus;
  /** 累计去重查看人数（按登录账号，含历史发布；撤回不清零）。 */
  viewCount: number;
  draft: PopupDraft;
  published: PopupPublishedSnapshot | null;
  createdAt: string | null;
}

export interface PopupSlot {
  mode: PopupMode;
  revision: number;
  activeRecordId: string | null;
}

export interface PopupListResult {
  total: number;
  records: PopupRecord[];
  slots: PopupSlot[];
}

export interface PopupAssetResult {
  url: string;
  mimeType: string;
  byteSize: number;
}

async function parseError(response: Response): Promise<Error> {
  let message = `请求失败（HTTP ${response.status}）`;
  try {
    const data = await response.json();
    if (data && typeof data.error === 'string' && data.error) message = data.error;
  } catch { /* 非 JSON 错误体，用默认文案 */ }
  if (response.status === 401 || response.status === 403) onUnauthorized?.();
  return new Error(message);
}

async function requestJson<T>(method: string, path: string, body: unknown, token: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('无法连接管理后端，请确认后端已在运行');
  }
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

export function listPopupRecords(token: string): Promise<PopupListResult> {
  return requestJson('GET', '/api/admin/popup-policies', undefined, token);
}

export function getPopupRecord(token: string, recordId: string): Promise<{ record: PopupRecord }> {
  return requestJson('GET', `/api/admin/popup-policies/${encodeURIComponent(recordId)}`, undefined, token);
}

export interface DraftInput {
  mode: PopupMode;
  title: string;
  contentHtml: string;
  requiredVersion?: string | null;
  downloadUrl?: string | null;
}

/** 新建：服务端生成 recordId，客户端不指定。 */
export function createPopupRecord(token: string, input: DraftInput): Promise<{ record: PopupRecord }> {
  return requestJson('POST', '/api/admin/popup-policies', input, token);
}

export function savePopupDraft(
  token: string,
  recordId: string,
  input: DraftInput,
): Promise<{ message: string; record: PopupRecord }> {
  return requestJson('PATCH', `/api/admin/popup-policies/${encodeURIComponent(recordId)}/draft`, input, token);
}

export function publishPopup(
  token: string,
  recordId: string,
): Promise<{ message: string; revision: number; replacedTitle: string | null }> {
  return requestJson('POST', `/api/admin/popup-policies/${encodeURIComponent(recordId)}/publish`, {}, token);
}

export function withdrawPopup(token: string, recordId: string): Promise<{ message: string }> {
  return requestJson('POST', `/api/admin/popup-policies/${encodeURIComponent(recordId)}/withdraw`, {}, token);
}

/** 一位查看者的明细行。只含账号与首次查看时间，不含 token／店铺信息。 */
export interface PopupViewer {
  email: string;
  firstViewedAt: string;
  mode: PopupMode;
  revision: number;
}

export interface PopupViewersResult {
  recordId: string;
  total: number;
  limit: number;
  offset: number;
  viewers: PopupViewer[];
}

/** 查看明细。仅当前管理员可读；按首次查看时间倒序分页。 */
export function listPopupViewers(
  token: string,
  recordId: string,
  offset = 0,
  limit = 20,
): Promise<PopupViewersResult> {
  const query = `?offset=${encodeURIComponent(String(offset))}&limit=${encodeURIComponent(String(limit))}`;
  return requestJson(
    'GET',
    `/api/admin/popup-policies/${encodeURIComponent(recordId)}/viewers${query}`,
    undefined,
    token,
  );
}

/**
 * 上传图片。
 *
 * 不走 requestJson：multipart 不能手工设 Content-Type（必须让浏览器带上 boundary）。
 */
export async function uploadPopupAsset(token: string, file: File): Promise<PopupAssetResult> {
  const form = new FormData();
  form.append('file', file);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api/admin/popup-assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    throw new Error('无法连接管理后端，请确认后端已在运行');
  }
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as PopupAssetResult;
}
