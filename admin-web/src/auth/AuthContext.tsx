import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import * as api from '../api/admin';
import * as popupApi from '../api/popup';
import { clearSession, getToken, getUser, setSession } from './session';
import type { SessionUser } from './session';

interface AuthContextValue {
  user: SessionUser | null;
  /** 初始加载状态：会话是内存态的，首屏必然是未登录，这里保留以明确语义。 */
  initializing: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(() => getUser());
  const [initializing, setInitializing] = useState(true);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  // 服务端判定认证失效（401/403）时，立即退回登录页。
  useEffect(() => {
    api.setUnauthorizedHandler(logout);
    popupApi.setPopupUnauthorizedHandler(logout);
    return () => {
      api.setUnauthorizedHandler(null);
      popupApi.setPopupUnauthorizedHandler(null);
    };
  }, [logout]);

  useEffect(() => {
    const current = getToken();
    if (!current) {
      setInitializing(false);
      return;
    }
    // 内存中残留 token（热更新等）时，向服务端复核当前权限。
    api
      .checkAdmin(current)
      .then((result) => {
        if (!result.isAdmin) logout();
      })
      .catch(() => logout())
      .finally(() => setInitializing(false));
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.login(email, password);
    if (result.user.role !== 'admin') {
      throw new api.ApiError('该账号不是管理员，无法访问管理后台', 403);
    }
    setSession(result.token, result.user);
    setUser(result.user);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, initializing, login, logout }),
    [user, initializing, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth 必须在 AuthProvider 内使用');
  }
  return context;
}

/** 取当前 token；用于各页面请求。未登录时抛错，由页面统一处理。 */
export function useToken(): string {
  const token = getToken();
  if (!token) {
    throw new api.ApiError('登录状态已失效，请重新登录', 401);
  }
  return token;
}
