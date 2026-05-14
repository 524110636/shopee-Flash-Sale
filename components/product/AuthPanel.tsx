import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';
import * as backendApi from '@/entrypoints/popup/backend-api';

type AuthView = 'login' | 'register' | 'settings';

export function AuthPanel() {
  const { isLoggedIn, authUser, loginUser, logoutUser, setBackendUrl, backendUrl } = useAppStore();
  const [view, setView] = useState<AuthView>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [displayedCode, setDisplayedCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [isRegistered, setIsRegistered] = useState(false);
  const [regVerified, setRegVerified] = useState(false);

  const handleRegister = async () => {
    setLoading(true); setError('');
    try {
      const result = await backendApi.register(email, password, inviteCode);
      setDisplayedCode(result.code);
      setIsRegistered(true);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const handleVerify = async () => {
    if (verifyCode.length !== 6) return;
    setLoading(true); setError('');
    try {
      await backendApi.verify(email, verifyCode);
      setRegVerified(true);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  if (isLoggedIn && authUser) {
    if (view === 'settings') {
      return (
        <div className="px-3 py-3 border-b space-y-3">
          {error && (
            <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{error}</div>
          )}
          {connected && (
            <div className="p-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded">✅ 后端连接正常</div>
          )}
          {authUser.role === 'admin' && (
            <>
              <div className="text-xs font-medium text-muted-foreground">后端服务地址</div>
              <input
                type="url"
                placeholder="http://localhost:5724"
                value={backendUrl}
                onChange={e => setBackendUrl(e.target.value)}
                className="w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={loading}
              onClick={async () => {
                setLoading(true); setError(''); setConnected(false);
                try {
                  await backendApi.healthCheck();
                  setConnected(true);
                } catch (e: any) {
                  setError(`无法连接后端: ${e.message}`);
                }
                setLoading(false);
              }}
            >
              {loading ? '检测中...' : '测试连接'}
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={() => setView('login')}>
              返回
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="flex items-center justify-between px-3 py-2 border-b border-shopee-brand/10 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-shopee-green shrink-0" />
          <span className="text-muted-foreground">{authUser.email}</span>
          {authUser.role === 'admin' && (
            <span className="px-1.5 py-0.5 text-[10px] font-medium bg-shopee-brand-light text-shopee-brand rounded">管理员</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href="#"
            className="text-shopee-brand hover:text-shopee-brand-dark hover:underline text-xs"
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
    <div className="w-full max-w-sm mx-auto space-y-4">
      {error && (
        <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{error}</div>
      )}

      {view === 'login' && (
        <div className="space-y-3">
          <div className="text-center">
            <div className="w-10 h-10 rounded-xl bg-shopee-brand/10 flex items-center justify-center mx-auto mb-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-shopee-brand">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </div>
            <h2 className="text-base font-semibold">欢迎使用</h2>
            <p className="text-xs text-muted-foreground mt-0.5">请登录你的账号</p>
          </div>
          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="password"
            placeholder="密码"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            size="sm"
            className="w-full h-9 text-sm"
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
          <div className="flex justify-center">
            <button
              className="text-xs text-shopee-brand hover:text-shopee-brand-dark hover:underline"
              onClick={() => { setView('register'); setIsRegistered(false); setRegVerified(false); setVerifyCode(''); setDisplayedCode(''); setInviteCode(''); setError(''); }}
            >
              {'没有账号 → 注册'}
            </button>
          </div>
        </div>
      )}

      {view === 'register' && (
        <div className="space-y-3">
          <div className="text-center">
            <div className="w-10 h-10 rounded-xl bg-shopee-brand/10 flex items-center justify-center mx-auto mb-2">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-shopee-brand">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="8.5" cy="7" r="4"/>
                <line x1="20" y1="8" x2="20" y2="14"/>
                <line x1="23" y1="11" x2="17" y2="11"/>
              </svg>
            </div>
            <h2 className="text-base font-semibold">注册账号</h2>
            <p className="text-xs text-muted-foreground mt-0.5">创建你的账号以使用扩展功能</p>
          </div>

          <input
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="password"
            placeholder="密码（至少 6 位）"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="text"
            placeholder="邀请码（联系管理员获取）"
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value)}
            className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
          />

          {/* 验证码显示 + 输入框 — 同一行 */}
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div
                className="px-3 py-2 text-sm border rounded-lg bg-muted/30 text-center tracking-widest font-bold text-shopee-brand select-all cursor-pointer hover:bg-muted/50 transition-colors"
                onClick={() => {
                  if (displayedCode) return;
                  if (!email || password.length < 6) { setError('请先输入邮箱和密码（至少 6 位）'); return; }
                  if (!inviteCode) { setError('请输入邀请码'); return; }
                  handleRegister();
                }}
              >
                {displayedCode || <span className="text-xs font-normal text-muted-foreground tracking-normal">点击获取验证码</span>}
              </div>
            </div>
            <input
              type="text"
              placeholder="输入验证码"
              maxLength={6}
              value={verifyCode}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                setVerifyCode(val);
                if (isRegistered && val.length === 6 && !loading) {
                  backendApi.verify(email, val).then(() => {
                    setRegVerified(true);
                  }).catch(err => {
                    setError(err.message);
                  });
                }
              }}
              className="flex-1 px-3 py-2 text-sm border rounded-lg text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {/* 已注册但未验证时显示提示 */}
          {isRegistered && !regVerified && !loading && (
            <p className="text-xs text-muted-foreground text-center">请输入上方的验证码完成验证</p>
          )}

          {/* 注册 / 验证 按钮 */}
          {regVerified ? (
            <div className="text-center space-y-2 rounded-lg border bg-card p-4">
              <svg className="w-8 h-8 text-shopee-green mx-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              <p className="text-sm font-medium text-shopee-green">验证成功</p>
              <p className="text-xs text-muted-foreground">请使用你的账号登录</p>
              <Button size="sm" className="h-8 text-xs" onClick={() => { setView('login'); setPassword(''); setInviteCode(''); }}>
                前往登录
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              className="w-full h-9 text-sm"
              disabled={loading || !email || password.length < 6 || !inviteCode || (isRegistered && verifyCode.length !== 6)}
              onClick={isRegistered ? handleVerify : handleRegister}
            >
              {loading ? (isRegistered ? '验证中...' : '注册中...') : (isRegistered ? '验证' : '注册')}
            </Button>
          )}

          <div className="flex justify-center">
            <span
              className="text-xs text-shopee-brand cursor-pointer hover:text-shopee-brand-dark hover:underline"
              onClick={() => { setView('login'); setIsRegistered(false); setRegVerified(false); setVerifyCode(''); setDisplayedCode(''); setInviteCode(''); setError(''); }}
            >
              已有账号，去登录
            </span>
          </div>
        </div>
      )}

      {view === 'settings' && (
        <div className="space-y-2">
          {error && (
            <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{error}</div>
          )}
          {connected && (
            <div className="p-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded">✅ 后端连接正常</div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs w-full"
            disabled={loading}
            onClick={async () => {
              setLoading(true); setError(''); setConnected(false);
              try {
                await backendApi.healthCheck();
                setConnected(true);
              } catch (e: any) {
                setError(`无法连接后端: ${e.message}`);
              }
              setLoading(false);
            }}
          >
            {loading ? '检测中...' : '测试连接'}
          </Button>
          <Button size="sm" className="h-7 text-xs w-full" onClick={() => setView('login')}>
            返回
          </Button>
        </div>
      )}
    </div>
  );
}
