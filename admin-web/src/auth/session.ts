/**
 * 会话状态：token 与登录用户仅保存在内存变量中。
 * 刷新页面即重新登录（不做 localStorage / sessionStorage / Cookie 持久化）。
 */

export interface SessionUser {
  id: number;
  email: string;
  role: 'user' | 'admin';
  autoModeEnabled: number;
  trialUsed: number;
  trialEnabled: number;
}

let token: string | null = null;
let user: SessionUser | null = null;

export function getToken(): string | null {
  return token;
}

export function getUser(): SessionUser | null {
  return user;
}

export function setSession(nextToken: string, nextUser: SessionUser): void {
  token = nextToken;
  user = nextUser;
}

export function clearSession(): void {
  token = null;
  user = null;
}
