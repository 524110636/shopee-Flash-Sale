import type { BackendUser, BackendStoreBinding, BackendAnalyticsSummary, BackendAdminAnalytics } from './types';

const STORAGE_KEY = 'backendAuth';

interface AuthData {
  token: string;
  user: { id: number; email: string; role: string; autoModeEnabled: number; trialUsed: number };
}

let _baseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5724';
let _auth: AuthData | null = null;

export function getBaseUrl() {
  return _baseUrl;
}

export function setBaseUrl(url: string) {
  _baseUrl = url.replace(/\/+$/, '');
}

export function getAuthUser() {
  return _auth?.user ?? null;
}

export function getToken() {
  return _auth?.token ?? null;
}

export function isLoggedIn() {
  return _auth !== null;
}

export function isAdmin() {
  return _auth?.user?.role === 'admin';
}

export function canUseAutoMode(): boolean {
  if (!_auth?.user) return false;
  return _auth.user.role === 'admin' || _auth.user.autoModeEnabled === 1;
}

export async function loadAuthFromStorage() {
  try {
    const result = await browser.storage.local.get(STORAGE_KEY);
    const data = result[STORAGE_KEY] as AuthData | undefined;
    if (data?.token && data?.user) {
      _auth = data;
      return true;
    }
  } catch {}
  return false;
}

export async function saveAuthToStorage(token: string, user: { id: number; email: string; role: string; autoModeEnabled: number; trialUsed: number }) {
  _auth = { token, user };
  await browser.storage.local.set({ [STORAGE_KEY]: _auth });
}

export async function clearAuth() {
  _auth = null;
  await browser.storage.local.remove(STORAGE_KEY);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_auth?.token) {
    headers['Authorization'] = `Bearer ${_auth.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${_baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e: any) {
    // fetch 网络错误（后端未启动、DNS 失败、连接被拒绝等）
    throw new Error(`无法连接后端服务 (${_baseUrl})，请确认后端已启动: ${e.message}`);
  }

  if (response.status === 401) {
    await clearAuth();
    throw new Error('认证已过期，请重新登录');
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `请求失败 (${response.status})`);
  }
  return data as T;
}

// ===== Auth API =====

export async function register(email: string, password: string, inviteCode: string) {
  return request<{ message: string; code: string; expiresAt: string }>('POST', '/api/auth/register', { email, password, inviteCode });
}

export async function verify(email: string, code: string) {
  return request<{ message: string }>('POST', '/api/auth/verify', { email, code });
}

export async function login(email: string, password: string) {
  const data = await request<{ token: string; user: { id: number; email: string; role: string; autoModeEnabled: number; trialUsed: number } }>('POST', '/api/auth/login', { email, password });
  await saveAuthToStorage(data.token, data.user);
  return data;
}

export async function checkAdmin() {
  const data = await request<{ isAdmin: boolean; autoModeEnabled: number; trialUsed: number }>('POST', '/api/auth/check-admin');
  if (_auth) {
    if (data.autoModeEnabled !== undefined) {
      _auth.user.autoModeEnabled = data.autoModeEnabled;
    }
    if (data.trialUsed !== undefined) {
      _auth.user.trialUsed = data.trialUsed;
    }
    await browser.storage.local.set({ [STORAGE_KEY]: _auth });
  }
  return data;
}

// ===== Store API =====

export async function bindStore(spcCds: string, shopId?: number, accountId?: number, shopUsername?: string, shopName?: string) {
  return request<{ message: string }>('POST', '/api/stores/bind', { spcCds, shopId, accountId, shopUsername, shopName });
}

export async function getStores() {
  return request<{ stores: BackendStoreBinding[] }>('GET', '/api/stores');
}

export async function unbindStore(id: number) {
  return request<{ message: string }>('DELETE', `/api/stores/${id}`);
}

export async function validateShopAccess(spcCds: string, action: string) {
  return request<{ allowed: boolean }>('POST', '/api/stores/validate', { spcCds, action });
}

// ===== Analytics API =====

export async function reportEvent(eventType: string, eventData?: Record<string, unknown>) {
  return request<{ message: string }>('POST', '/api/analytics/events', { eventType, eventData });
}

export async function getAnalyticsSummary() {
  return request<BackendAnalyticsSummary>('GET', '/api/analytics/summary');
}

// ===== Admin API =====

export async function getUsers() {
  return request<{ users: BackendUser[] }>('GET', '/api/admin/users');
}

export async function updateStoreLimit(userId: number, maxStores: number) {
  return request<{ message: string }>('PATCH', `/api/admin/users/${userId}/store-limit`, { maxStores });
}

export async function toggleAutoMode(userId: number, autoModeEnabled: number) {
  return request<{ message: string; autoModeEnabled: number }>('PATCH', `/api/admin/users/${userId}/auto-mode`, { autoModeEnabled });
}

export async function resetTrial(userId: number, trialUsed: number) {
  return request<{ message: string; trialUsed: number }>('PATCH', `/api/admin/users/${userId}/trial`, { trialUsed });
}

export async function getAdminAnalytics() {
  return request<BackendAdminAnalytics>('GET', '/api/admin/analytics');
}

export async function getAdminAnalyticsEvents(type?: string) {
  const query = type ? `?type=${encodeURIComponent(type)}` : '';
  return request<{ events: Array<{ id: number; userId: number; eventType: string; eventData: string | null; createdAt: string; email: string }> }>('GET', `/api/admin/analytics/events${query}`);
}

// ===== Health Check =====

export async function healthCheck(): Promise<void> {
  const response = await fetch(`${_baseUrl}/api/health`);
  if (!response.ok) {
    throw new Error(`后端返回错误状态 (HTTP ${response.status})`);
  }
}

// ===== Admin Binding Management API =====

export async function getAdminBindings(userId?: number) {
  const query = userId ? `?userId=${userId}` : '';
  return request<{ bindings: BackendStoreBinding[] }>('GET', `/api/admin/bindings${query}`);
}

export async function adminUnbindStore(bindingId: number) {
  return request<{ message: string }>('DELETE', `/api/admin/bindings/${bindingId}`);
}

export async function adminDeleteUser(userId: number) {
  return request<{ message: string }>('DELETE', `/api/admin/users/${userId}`);
}

// ===== Invite Code API =====

export async function getInviteCodes() {
  return request<{ inviteCodes: Array<{ id: number; code: string; isUsed: number; usedBy: number | null; createdAt: string; usedAt: string | null; userEmail: string | null }> }>('GET', '/api/admin/invite-codes');
}

export async function createInviteCodes(count?: number) {
  return request<{ codes: string[]; count: number }>('POST', '/api/admin/invite-codes', { count: count || 1 });
}

export async function deleteInviteCode(id: number) {
  return request<{ message: string }>('DELETE', `/api/admin/invite-codes/${id}`);
}
