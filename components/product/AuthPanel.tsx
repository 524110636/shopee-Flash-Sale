import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';
import * as backendApi from '@/entrypoints/popup/backend-api';

type AuthView = 'login' | 'register' | 'settings';

const TERMS_TEXT = `使用条款及免责声明

最后更新日期：2026 年 5 月 15 日

欢迎使用本浏览器扩展（以下简称"本扩展"）。在注册和使用本扩展之前，请仔细阅读以下条款。一经注册或使用本扩展，即表示你已阅读、理解并同意受本条款的约束。如果你不同意本条款的任何部分，请勿注册或使用本扩展。

一、定义

1.1 "本扩展"指通过 Chrome 浏览器提供的自动化辅助工具及其相关服务。
1.2 "用户"指注册并使用本扩展的自然人、法人或其他组织。
1.3 "服务"指本扩展提供的所有功能和服务，包括但不限于商品管理、限时特卖操作、数据分析等功能。
1.4 "第三方平台"指本扩展所对接的电商平台及其相关服务。

二、账号注册与使用

2.1 用户在注册时应提供真实、准确、完整的个人信息，包括但不限于邮箱地址。用户应妥善保管账号和密码，对账号下发生的一切活动承担责任。
2.2 用户不得将账号转让、出借或授权他人使用。如因账号保管不善导致账号被他人使用或盗用，由此产生的一切损失由用户自行承担。
2.3 每个账号仅限个人使用，不得多人共享同一账号。如发现异常使用行为，本扩展有权暂停或终止该账号的服务。
2.4 用户注册时须提供有效的邀请码。邀请码为一次性使用，不得转让或出售。通过非法途径获取邀请码的账号将被永久封禁。

三、服务说明与限制

3.1 本扩展通过技术手段辅助用户在第三方平台上进行操作，旨在提高操作效率。用户理解并同意，本扩展仅在用户主动触发时执行操作，用户应对其使用本扩展所执行的所有操作负责。
3.2 用户应遵守第三方平台的使用条款、服务协议及相关法律法规。本扩展不对用户在第三方平台上的行为承担任何责任。
3.3 第三方平台可能随时调整其网站结构、接口规则或反自动化策略，导致本扩展部分或全部功能暂时或永久不可用。本扩展将尽力适配更新，但不保证功能的持续可用性或适配的及时性。

四、风险提示与免责声明

4.1 自动化操作风险：使用自动化工具操作第三方平台可能违反该平台的使用条款。第三方平台可能对进行自动化操作的账号采取处罚措施，包括但不限于：
  （a）限制店铺功能使用权限；
  （b）降低店铺及商品的搜索排名与曝光量；
  （c）限制参与平台营销活动的资格；
  （d）暂时或永久冻结店铺账号。

4.2 用户充分知悉并自愿承担使用本扩展可能带来的上述风险。用户应自行评估风险并决定是否使用本扩展。本扩展的开发者和运营方对因使用或无法使用本扩展而导致的任何直接或间接损失（包括但不限于店铺流量下降、商品搜索排名降低、销售额减少、利润损失、数据丢失、商誉损失等）不承担任何赔偿责任。

4.3 API 与接口变更风险：本扩展依赖第三方平台的接口和数据。第三方平台可能在任何时候、无需事先通知的情况下变更或关闭相关接口，导致本扩展功能异常或不可用。本扩展不对此类变更造成的功能中断承担责任，且不保证在特定时间内完成适配。

4.4 服务中断风险：本扩展可能因服务器维护、网络故障、第三方服务故障、不可抗力等原因出现服务中断。本扩展将尽力保证服务的稳定运行，但不就服务的中断或终止对用户承担责任。

4.5 用户应自行备份重要数据。本扩展不对用户数据的丢失或损坏承担责任。

五、知识产权

5.1 本扩展及其所有组成内容（包括但不限于代码、界面设计、文档、商标、标志等）的知识产权归本扩展开发者所有，受相关法律法规保护。
5.2 未经本扩展开发者书面授权，用户不得对本扩展进行反向工程、反编译、反汇编、破解、修改、翻译或创建衍生作品。
5.3 用户通过本扩展提交的数据和内容归用户所有。用户授予本扩展为其提供服务目的而使用、处理和存储该等数据的权利。

六、禁止行为

用户在注册和使用本扩展过程中不得从事以下行为：
  （a）违反中华人民共和国法律法规的行为；
  （b）干扰、破坏或试图未经授权访问本扩展的服务器或网络；
  （c）利用本扩展从事欺诈、虚假交易、刷单、套利等违法违规活动；
  （d）以任何形式对本扩展代码进行修改、破解或制作衍生版本；
  （e）利用本扩展对第三方平台进行恶意攻击或造成服务器过载的行为。

七、服务变更与终止

7.1 本扩展有权在提前通知或不通知的情况下修改、暂停或终止全部或部分服务。
7.2 如用户违反本条款的任何规定，本扩展有权立即终止对该用户的服务，且不退还任何费用（如有）。
7.3 用户可随时停止使用本扩展。账号注销后，与该账号相关的数据将按照本扩展的数据保留政策进行处理。

八、适用法律与争议解决

8.1 本条款的订立、执行、解释及争议的解决均适用中华人民共和国法律。
8.2 因本条款引起的或与之相关的任何争议，双方应首先通过友好协商解决。协商不成的，任何一方有权向本扩展开发者所在地有管辖权的人民法院提起诉讼。

九、其他

9.1 本条款构成用户与本扩展之间就本扩展使用的完整协议，取代之前就同一主题达成的任何口头或书面协议。
9.2 如本条款的任何条款被认定为无效或不可执行，其余条款仍具有完全的法律效力。
9.3 本扩展开发者对本条款拥有最终解释权。

如你对本条款有任何疑问，请联系本扩展的管理员。`;

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
  const [showTerms, setShowTerms] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);

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
              onClick={() => { setView('register'); setIsRegistered(false); setRegVerified(false); setVerifyCode(''); setDisplayedCode(''); setInviteCode(''); setAgreedToTerms(false); setError(''); }}
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
                  if (!agreedToTerms) { setError('请先勾选同意使用条款及免责声明'); return; }
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
              disabled={loading || !email || password.length < 6 || !inviteCode || !agreedToTerms || (isRegistered && verifyCode.length !== 6)}
              onClick={isRegistered ? handleVerify : handleRegister}
            >
              {loading ? (isRegistered ? '验证中...' : '注册中...') : (isRegistered ? '验证' : '注册')}
            </Button>
          )}

          {/* 使用条款勾选 */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={e => setAgreedToTerms(e.target.checked)}
              className="mt-0.5 shrink-0 accent-shopee-brand"
            />
            <span className="text-[11px] text-muted-foreground leading-relaxed">
              我已阅读并同意
              <span
                className="text-shopee-brand cursor-pointer hover:underline ml-0.5"
                onClick={(e) => { e.preventDefault(); setShowTerms(true); }}
              >
                《使用条款及免责声明》
              </span>
            </span>
          </label>

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

      {/* 使用条款弹窗 */}
      {showTerms && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40" onClick={() => setShowTerms(false)}>
          <div
            className="bg-background rounded-t-xl sm:rounded-xl w-full sm:max-w-md max-h-[85vh] flex flex-col shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
              <h3 className="text-sm font-semibold">使用条款及免责声明</h3>
              <button className="text-muted-foreground hover:text-foreground text-lg leading-none p-1" onClick={() => setShowTerms(false)}>&times;</button>
            </div>
            <div className="overflow-y-auto px-4 py-3 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {TERMS_TEXT}
            </div>
            <div className="px-4 py-3 border-t shrink-0">
              <Button size="sm" className="w-full h-8 text-xs" onClick={() => setShowTerms(false)}>我已阅读并同意</Button>
            </div>
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
