import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';
import * as backendApi from '@/entrypoints/popup/backend-api';

type AuthView = 'login' | 'register' | 'verify';

export function AuthPanel() {
  const { isLoggedIn, authUser, loginUser, logoutUser, setBackendUrl, backendUrl } = useAppStore();
  const [view, setView] = useState<AuthView>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [displayedCode, setDisplayedCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (isLoggedIn && authUser) {
    if (view === 'settings') {
      return (
        <div className="px-3 py-3 border-b space-y-3">
          {error && (
            <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{error}</div>
          )}
          <div className="text-xs font-medium text-muted-foreground">后端服务地址</div>
          <input
            type="url"
            placeholder="http://localhost:3001"
            value={backendUrl}
            onChange={e => setBackendUrl(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={async () => {
                setLoading(true); setError('');
                try {
                  const hasAuth = await backendApi.loadAuthFromStorage();
                  if (hasAuth) {
                    await backendApi.checkAdmin();
                    const user = backendApi.getAuthUser();
                    useAppStore.setState({ isLoggedIn: true, authUser: user });
                    setView('login');
                  } else {
                    setView('login');
                  }
                } catch (e: any) {
                  setError(`无法连接后端: ${e.message}`);
                }
                setLoading(false);
              }}
            >
              测试连接
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={() => setView('login')}>
              返回
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b text-xs">
        <div className="flex items-center gap-2">
          <span className="text-green-600 font-medium">✓</span>
          <span className="text-muted-foreground">{authUser.email}</span>
          {authUser.role === 'admin' && (
            <span className="px-1 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-700 rounded">管理员</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href="#"
            className="text-blue-600 hover:underline"
            onClick={(e) => { e.preventDefault(); setView('settings'); }}
          >
            设置
          </a>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs font-normal" onClick={logoutUser}>
            退出
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-3 py-3 border-b space-y-3">
      {error && (
        <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{error}</div>
      )}

      {view === 'login' && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">登录 / 注册</div>
          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 h-7 text-xs"
              disabled={loading || !email || !password}
              onClick={async () => {
                setLoading(true); setError('');
                try {
                  await loginUser(email, password);
                } catch (e: any) {
                  setError(e.message);
                }
                setLoading(false);
              }}
            >
              {loading ? '登录中...' : '登录'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => { setView('register'); setError(''); }}
            >
              注册
            </Button>
          </div>
        </div>
      )}

      {view === 'register' && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">注册</div>
          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="password"
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button
            size="sm"
            className="w-full h-7 text-xs"
            disabled={loading || !email || password.length < 6}
            onClick={async () => {
              setLoading(true); setError('');
              try {
                const result = await backendApi.register(email, password);
                setDisplayedCode(result.code);
                setView('verify');
              } catch (e: any) {
                setError(e.message);
              }
              setLoading(false);
            }}
          >
            {loading ? '注册中...' : '注册'}
          </Button>
          <div className="flex justify-end">
            <button
              className="text-xs text-blue-600 hover:underline"
              onClick={() => { setView('login'); setError(''); }}
            >
              已有账号？登录
            </button>
          </div>
        </div>
      )}

      {view === 'verify' && (
        <div className="space-y-3">
          <div className="text-xs font-medium text-muted-foreground">验证邮箱</div>
          <div className="text-xs text-muted-foreground">
            验证码已发送到 <span className="font-medium">{email}</span>
          </div>
          <div className="py-3 text-center">
            <div className="text-3xl font-bold tracking-widest text-blue-600 select-all">{displayedCode}</div>
            <div className="mt-1 text-[10px] text-muted-foreground">请记录此验证码，关闭后无法找回</div>
          </div>
          <input
            type="text"
            placeholder="输入验证码"
            maxLength={6}
            value={verifyCode}
            onChange={e => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-full px-2 py-1.5 text-xs border rounded text-center text-lg tracking-widest focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button
            size="sm"
            className="w-full h-7 text-xs"
            disabled={loading || verifyCode.length !== 6}
            onClick={async () => {
              setLoading(true); setError('');
              try {
                await backendApi.verify(email, verifyCode);
                setView('login');
                setPassword('');
                setError('验证成功，请登录');
              } catch (e: any) {
                setError(e.message);
              }
              setLoading(false);
            }}
          >
            {loading ? '验证中...' : '确认验证'}
          </Button>
        </div>
      )}

      {view === 'settings' && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">后端服务地址</div>
          <input
            type="url"
            placeholder="http://localhost:3001"
            value={backendUrl}
            onChange={e => setBackendUrl(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={async () => {
                setLoading(true); setError('');
                try {
                  const hasAuth = await backendApi.loadAuthFromStorage();
                  if (hasAuth) {
                    await backendApi.checkAdmin();
                    const user = backendApi.getAuthUser();
                    useAppStore.setState({ isLoggedIn: true, authUser: user });
                    setView('login');
                  } else {
                    setView('login');
                  }
                } catch (e: any) {
                  setError(`无法连接后端: ${e.message}`);
                }
                setLoading(false);
              }}
            >
              测试连接
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={() => setView('login')}>
              返回
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
