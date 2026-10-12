/**
 * 管理网站请求模块。
 * 不依赖任何扩展（chrome.runtime / chrome.storage / popup）API。
 * token 只保存在内存（由 auth/session.ts 持有），不做持久化。
 */

const BASE_URL = '';

/** 认证失效（401/403）时由 AuthContext 注册的回调，用于强制退回登录页。 */
let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('无法连接管理后端，请确认后端已在运行', 0);
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const message =
      (data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : '') || `请求失败（HTTP ${response.status}）`;
    if (response.status === 401 || response.status === 403) {
      onUnauthorized?.();
    }
    throw new ApiError(message, response.status);
  }

  return data as T;
}

// ---------- 类型（与后端实际响应字段一致） ----------

export interface AdminUser {
  id: number;
  email: string;
  role: 'user' | 'admin';
  isActive: number;
  maxStores: number;
  autoModeEnabled: number;
  trialUsed: number;
  trialEnabled: number;
  createdAt: string;
  bindingCount: number;
}

export interface AdminBinding {
  id: number;
  userId: number;
  shopId: number | null;
  accountId: number | null;
  shopUsername: string | null;
  shopName: string | null;
  isActive: number;
  maxStores: number;
  createdAt: string;
  userEmail: string | null;
}

export interface AdminInviteCode {
  id: number;
  code: string;
  isUsed: number;
  usedBy: number | null;
  createdAt: string;
  usedAt: string | null;
  userEmail: string | null;
}

export interface AdminAnalytics {
  totalUsers: number;
  totalBindings: number;
  events: Array<{ eventType: string; count: number }>;
}

export interface AdminAnalyticsEvent {
  id: number;
  userId: number;
  eventType: string;
  /** 服务端已按事件类型白名单脱敏；未知类型/字段一律为 null，原始 JSON 不下发。 */
  eventData: Record<string, string | number | boolean> | null;
  createdAt: string;
  email: string | null;
}

export interface LoginResult {
  token: string;
  user: {
    id: number;
    email: string;
    role: 'user' | 'admin';
    autoModeEnabled: number;
    trialUsed: number;
    trialEnabled: number;
  };
}

// ---------- 认证 ----------

export function login(email: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('POST', '/api/auth/login', { email, password });
}

/** 用当前 token 向服务端确认管理员身份（服务端按 userId 查库判定）。 */
export function checkAdmin(token: string): Promise<{
  isAdmin: boolean;
  autoModeEnabled: number;
  trialUsed: number;
  trialEnabled: number;
}> {
  return request('POST', '/api/auth/check-admin', undefined, token);
}

// ---------- 用户 ----------

export function getUsers(token: string): Promise<{ users: AdminUser[] }> {
  return request('GET', '/api/admin/users', undefined, token);
}

export function updateStoreLimit(
  token: string,
  userId: number,
  maxStores: number,
): Promise<{ message: string }> {
  return request('PATCH', `/api/admin/users/${userId}/store-limit`, { maxStores }, token);
}

export function toggleAutoMode(
  token: string,
  userId: number,
  autoModeEnabled: number,
): Promise<{ message: string }> {
  return request('PATCH', `/api/admin/users/${userId}/auto-mode`, { autoModeEnabled }, token);
}

export function setTrialUsed(
  token: string,
  userId: number,
  trialUsed: number,
): Promise<{ message: string }> {
  return request('PATCH', `/api/admin/users/${userId}/trial`, { trialUsed }, token);
}

export function setTrialEnabled(
  token: string,
  userId: number,
  trialEnabled: number,
): Promise<{ message: string }> {
  return request('PATCH', `/api/admin/users/${userId}/trial-enabled`, { trialEnabled }, token);
}

export function deleteUser(token: string, userId: number): Promise<{ message: string }> {
  return request('DELETE', `/api/admin/users/${userId}`, undefined, token);
}

// ---------- 绑定 ----------

export function getBindings(
  token: string,
  userId?: number,
): Promise<{ bindings: AdminBinding[] }> {
  const query = userId === undefined ? '' : `?userId=${encodeURIComponent(String(userId))}`;
  return request('GET', `/api/admin/bindings${query}`, undefined, token);
}

export function unbindStore(token: string, bindingId: number): Promise<{ message: string }> {
  return request('DELETE', `/api/admin/bindings/${bindingId}`, undefined, token);
}

// ---------- 邀请码 ----------

export function getInviteCodes(token: string): Promise<{ inviteCodes: AdminInviteCode[] }> {
  return request('GET', '/api/admin/invite-codes', undefined, token);
}

export function createInviteCodes(
  token: string,
  count: number,
): Promise<{ codes: string[]; count: number }> {
  return request('POST', '/api/admin/invite-codes', { count }, token);
}

export function deleteInviteCode(token: string, id: number): Promise<{ message: string }> {
  return request('DELETE', `/api/admin/invite-codes/${id}`, undefined, token);
}

// ---------- 统计 ----------

export function getAnalytics(token: string): Promise<AdminAnalytics> {
  return request('GET', '/api/admin/analytics', undefined, token);
}

export function getAnalyticsEvents(
  token: string,
  type?: string,
): Promise<{ events: AdminAnalyticsEvent[] }> {
  const query = type ? `?type=${encodeURIComponent(type)}` : '';
  return request('GET', `/api/admin/analytics/events${query}`, undefined, token);
}
