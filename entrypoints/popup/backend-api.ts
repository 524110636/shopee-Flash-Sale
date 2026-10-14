import type { BackendStoreBinding, BackendAnalyticsSummary } from './types';

const STORAGE_KEY = 'backendAuth';

interface AuthData {
  token: string;
  user: { id: number; email: string; role: string; autoModeEnabled: number; trialUsed: number; trialEnabled: number };
}

const _fallbackUrl = import.meta.env.VITE_BACKEND_FALLBACK_URL || '';

let _baseUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5724';
let _auth: AuthData | null = null;

function tryFetch(url: string, init?: RequestInit): Promise<Response> {
  // 先尝试用主域名请求
  return fetch(url, init).catch((primaryErr) => {
    if (!_fallbackUrl) throw primaryErr;
    const fallbackUrl = url.replace(_baseUrl, _fallbackUrl);
    if (import.meta.env.VITE_DEBUG_LOGS === 'true') console.warn('[backend-api] 主域名请求失败，尝试 IP 直连:', fallbackUrl);
    // IP 直连兜底
    return fetch(fallbackUrl, init).catch(() => {
      // 兜底也失败了，抛原始错误（主域名的错误信息对用户更有意义）
      throw primaryErr;
    });
  });
}

export function getBaseUrl() {
  return _baseUrl;
}

export function setBaseUrl(url: string) {
  _baseUrl = url.replace(/\/+$/, '');
}

export function getAuthUser() {
  if (!_auth) return null;
  if (isTokenExpired(_auth.token)) return null;
  return _auth.user;
}

export function getToken() {
  return _auth?.token ?? null;
}

function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

function isValidJwtStructure(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return typeof payload.userId === 'number'
      && typeof payload.email === 'string'
      && typeof payload.role === 'string'
      && typeof payload.exp === 'number'
      && typeof payload.iat === 'number';
  } catch {
    return false;
  }
}

function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return payload.exp && payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

export function isLoggedIn() {
  if (!_auth) return false;
  if (isTokenExpired(_auth.token)) return false;
  return true;
}

export function isAdmin() {
  if (!isLoggedIn()) return false;
  return _auth?.user?.role === 'admin';
}

/**
 * 身份就绪订阅（只读接线，供弹窗查看上报等独立模块使用）。
 *
 * 为什么需要它：popup 打开时「策略检查」与「从 storage 恢复登录身份」是两条
 * 并行的异步流程。查看上报必须用真实账号，但**不能**在身份还没恢复时就把这次
 * 展示判成「匿名不看」—— 否则每次冷启动的第一次展示都会漏记。
 * 订阅后：已就绪立即回调，未就绪等就绪那一刻再回调。
 */
type AuthReadyListener = (userId: number, token: string) => void;
const _authReadyListeners = new Set<AuthReadyListener>();

export function onAuthReady(listener: AuthReadyListener): () => void {
  _authReadyListeners.add(listener);
  if (_auth && !isTokenExpired(_auth.token)) {
    listener(_auth.user.id, _auth.token);
  }
  return () => {
    _authReadyListeners.delete(listener);
  };
}

function notifyAuthReady(): void {
  if (!_auth || isTokenExpired(_auth.token)) return;
  // 复制一份再遍历：回调里可能取消订阅，直接遍历原集合会漏掉后面的监听者。
  for (const listener of [..._authReadyListeners]) {
    try {
      listener(_auth.user.id, _auth.token);
    } catch { /* 单个监听者出错不影响其他监听者与登录流程 */ }
  }
}

export function canUseAutoMode(): boolean {
  if (!isLoggedIn()) return false;
  return _auth!.user.role === 'admin' || _auth!.user.autoModeEnabled === 1;
}

export async function loadAuthFromStorage() {
  try {
    const result = await browser.storage.local.get(STORAGE_KEY);
    const data = result[STORAGE_KEY] as AuthData | undefined;
    if (data?.token && data?.user) {
      if (!isValidJwtStructure(data.token)) {
        console.warn('[backend-api] token 结构无效，已清除');
        await browser.storage.local.remove(STORAGE_KEY);
        return false;
      }
      _auth = data;
      notifyAuthReady();
      return true;
    }
  } catch (e) {
    console.error('[backend-api] loadAuthFromStorage 失败:', e);
  }
  return false;
}

export async function saveAuthToStorage(token: string, user: { id: number; email: string; role: string; autoModeEnabled: number; trialUsed: number; trialEnabled: number }) {
  _auth = { token, user };
  await browser.storage.local.set({ [STORAGE_KEY]: _auth });
  notifyAuthReady();
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
    response = await tryFetch(`${_baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e: any) {
    throw new Error('无法连接后端服务，请确认后端已启动', { cause: e });
  }

  if (response.status === 401) {
    let errorMsg = '认证已过期，请重新登录';
    try {
      const data = await response.json();
      if (data.error) errorMsg = data.error;
    } catch {}
    await clearAuth();
    throw new Error(errorMsg);
  }

  if (!response.ok) {
    let errorMsg: string;
    try {
      const contentType = response.headers.get('Content-Type') || '';
      if (contentType.includes('application/json')) {
        const errorData = await response.json();
        errorMsg = errorData.error || `请求失败 (${response.status})`;
      } else {
        errorMsg = `请求失败 (${response.status})`;
      }
    } catch {
      errorMsg = `请求失败 (${response.status})`;
    }
    throw new Error(errorMsg);
  }

  const data = await response.json();
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
  const data = await request<{ token: string; user: { id: number; email: string; role: string; autoModeEnabled: number; trialUsed: number; trialEnabled: number } }>('POST', '/api/auth/login', { email, password });
  await saveAuthToStorage(data.token, data.user);
  return data;
}

export async function checkAdmin() {
  const data = await request<{ isAdmin: boolean; autoModeEnabled: number; trialUsed: number; trialEnabled: number }>('POST', '/api/auth/check-admin');
  if (_auth) {
    if (data.autoModeEnabled !== undefined) {
      _auth.user.autoModeEnabled = data.autoModeEnabled;
    }
    if (data.trialUsed !== undefined) {
      _auth.user.trialUsed = data.trialUsed;
    }
    if (data.trialEnabled !== undefined) {
      _auth.user.trialEnabled = data.trialEnabled;
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

export async function validateShopAccess(spcCds: string, action: string, shopId?: number | null) {
  const body: { spcCds: string; action: string; shopId?: number } = { spcCds, action };
  if (shopId != null) body.shopId = shopId;
  return request<{ allowed: boolean }>('POST', '/api/stores/validate', body);
}

export async function consumeTrial() {
  return request<{ consumed: boolean; reason?: string }>('POST', '/api/stores/consume-trial');
}

// ===== Analytics API =====

export async function reportEvent(eventType: string, eventData?: Record<string, unknown>) {
  return request<{ message: string }>('POST', '/api/analytics/events', { eventType, eventData });
}

export async function getAnalyticsSummary() {
  return request<BackendAnalyticsSummary>('GET', '/api/analytics/summary');
}

// ===== Health Check =====

export async function healthCheck(): Promise<void> {
  const response = await tryFetch(`${_baseUrl}/api/health`);
  if (!response.ok) {
    throw new Error(`后端返回错误状态 (HTTP ${response.status})`);
  }
}
