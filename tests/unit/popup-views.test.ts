import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 弹窗查看上报（扩展侧）的单元测试。
 *
 * 这里测的是**最容易出错的四个点**，而不是复述实现：
 * 1. 旧缓存／旧后端没有 recordId 时必须**跳过统计且不影响弹窗**（早返回，
 *    不能抛错，也不能补造历史人数）。
 * 2. 身份未就绪时不能把这次展示误判成匿名 —— 必须等身份就绪后补报一次。
 * 3. 补报前要复查「这条现在还显示着吗」：用户已经点了「我知道了」就不该补报。
 * 4. 任何失败（网络／超时／服务端拒绝）都必须静默，不能阻断弹窗、不能重试轰炸。
 */

const storageData: Record<string, unknown> = {};

const browserStub = {
  storage: {
    local: {
      get: async (key: string) => (key in storageData ? { [key]: storageData[key] } : {}),
      set: async (items: Record<string, unknown>) => {
        Object.assign(storageData, items);
      },
      remove: async (key: string) => {
        delete storageData[key];
      },
    },
  },
  runtime: { getManifest: () => ({ version: '1.15.1' }) },
};

(globalThis as Record<string, unknown>).browser = browserStub;

const backendApi = await import('@/entrypoints/popup/backend-api');
const { reportPopupView } = await import('@/entrypoints/popup/popup-views');

const BACKEND = 'http://localhost:5799';
const RECORD_ID = '11111111-2222-3333-4444-555555555555';

/** 造一个结构合法、未过期的 JWT（payload 里 exp 在未来）。 */
function makeToken(userId: number, email = 'viewer@example.invalid'): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    userId,
    email,
    role: 'user',
    iat: now,
    exp: now + 3600,
  })}.signature`;
}

/** 已经发生过的上报请求。 */
let calls: Array<{ url: string; body: any; headers: Record<string, string> }>;

describe('reportPopupView', () => {
  beforeEach(async () => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    calls = [];
    await backendApi.clearAuth();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
          headers: (init?.headers as Record<string, string>) ?? {},
        });
        return new Response(JSON.stringify({ counted: true, isNewView: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('没有 recordId 时不发请求也不抛错（旧缓存兼容）', async () => {
    const unsubscribe = reportPopupView(BACKEND, null, 'notice', 1, () => true);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
    unsubscribe();
  });

  it('身份已就绪时带上 token 直接上报', async () => {
    await backendApi.saveAuthToStorage(makeToken(7), {
      id: 7,
      email: 'viewer@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });

    const unsubscribe = reportPopupView(BACKEND, RECORD_ID, 'notice', 5, () => true);
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BACKEND}/api/extension/popup-views`);
    expect(calls[0].headers.Authorization).toMatch(/^Bearer /);
    expect(calls[0].body).toEqual({ recordId: RECORD_ID, mode: 'notice', revision: 5 });
    unsubscribe();
  });

  it('身份未就绪时等就绪后补报一次，不误判成匿名', async () => {
    // 模拟「策略检查早于身份恢复」：先上报，此时内存里没有 token
    const unsubscribe = reportPopupView(BACKEND, RECORD_ID, 'forced_update', 9, () => true);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls, '身份未就绪时不应发出无账号请求').toHaveLength(0);

    // 之后身份才恢复（等价于 popup 稍后 loadAuthFromStorage）
    await backendApi.saveAuthToStorage(makeToken(11), {
      id: 11,
      email: 'late@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toMatch(/^Bearer /);
    unsubscribe();
  });

  it('补报前复查可见性：弹窗已关掉就不补报', async () => {
    let visible = true;
    const unsubscribe = reportPopupView(BACKEND, RECORD_ID, 'notice', 2, () => visible);
    await new Promise((r) => setTimeout(r, 20));

    // 用户先点了「我知道了」/ 记录被撤下
    visible = false;
    await backendApi.saveAuthToStorage(makeToken(3), {
      id: 3,
      email: 'closed@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toHaveLength(0);
    unsubscribe();
  });

  it('同一组合不重复上报（StrictMode 重复 effect 不会多计）', async () => {
    await backendApi.saveAuthToStorage(makeToken(4), {
      id: 4,
      email: 'dup@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });

    const a = reportPopupView(BACKEND, RECORD_ID, 'notice', 3, () => true);
    const b = reportPopupView(BACKEND, RECORD_ID, 'notice', 3, () => true);
    await new Promise((r) => setTimeout(r, 20));

    expect(calls).toHaveLength(1);
    a();
    b();
  });

  it('网络失败静默吞掉，不抛出、不影响弹窗', async () => {
    await backendApi.saveAuthToStorage(makeToken(5), {
      id: 5,
      email: 'offline@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    // 关键断言：调用方（宿主）不会因为统计失败而拿到 rejected promise
    expect(() => reportPopupView(BACKEND, RECORD_ID, 'notice', 6, () => true)).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
  });

  it('服务端拒绝（匿名／草稿）不产生用户可见错误', async () => {
    await backendApi.saveAuthToStorage(makeToken(6), {
      id: 6,
      email: 'rejected@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ counted: false, reason: 'not-published' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    );

    const unsubscribe = reportPopupView(BACKEND, RECORD_ID, 'notice', 7, () => true);
    await new Promise((r) => setTimeout(r, 20));
    unsubscribe();
  });

  /**
   * F3：同一 popup 会话里换账号，另一个账号的展示**不能被去重吞掉**。
   *
   * 去重键原先只有 `backendUrl|recordId|revision`，与账号无关。模块级的 `reported`
   * 是跨挂载存活的（宿主卸载不重置它），于是账号 A 报过一次之后，B 看同一条
   * 同修订会被直接判定「报过了」而跳过 —— 服务端永远收不到 B 的展示，
   * 人数就少一位。这是用户独立复现的失败项。
   */
  it('F3 同一会话换账号：B 的展示必须照样上报（不能只算 A）', async () => {
    const signIn = (id: number, email: string) =>
      backendApi.saveAuthToStorage(makeToken(id, email), {
        id, email, role: 'user', autoModeEnabled: 0, trialUsed: 0, trialEnabled: 1,
      });

    // 账号 A 展示
    await signIn(105, 'a@example.invalid');
    const unsubA = reportPopupView(BACKEND, RECORD_ID, 'forced_update', 11, () => true);
    await new Promise((r) => setTimeout(r, 20));
    unsubA();
    expect(calls, 'A 应先上报一次').toHaveLength(1);

    // 用户退出并换账号 B（不刷新整页、模块不重建），同一条记录同一修订
    await signIn(106, 'b@example.invalid');
    const unsubB = reportPopupView(BACKEND, RECORD_ID, 'forced_update', 11, () => true);
    await new Promise((r) => setTimeout(r, 20));
    unsubB();

    const userIdOf = (call: { headers: Record<string, string> }) =>
      JSON.parse(Buffer.from(call.headers.Authorization.slice(7).split('.')[1], 'base64').toString()).userId;

    expect(calls, 'B 也必须发出自己的展示请求').toHaveLength(2);
    expect(calls.map(userIdOf), '两次请求应分别带上 A、B 的账号').toEqual([105, 106]);
  });

  it('F3 换回账号 A 仍不重复上报（去重仍按账号生效）', async () => {
    const signIn = (id: number, email: string) =>
      backendApi.saveAuthToStorage(makeToken(id, email), {
        id, email, role: 'user', autoModeEnabled: 0, trialUsed: 0, trialEnabled: 1,
      });

    await signIn(201, 'a2@example.invalid');
    reportPopupView(BACKEND, RECORD_ID, 'notice', 3, () => true)();
    await new Promise((r) => setTimeout(r, 20));

    await signIn(202, 'b2@example.invalid');
    reportPopupView(BACKEND, RECORD_ID, 'notice', 3, () => true)();
    await new Promise((r) => setTimeout(r, 20));

    // 再回到 A：A 这一轮已经报过，不应再多算
    await signIn(201, 'a2@example.invalid');
    reportPopupView(BACKEND, RECORD_ID, 'notice', 3, () => true)();
    await new Promise((r) => setTimeout(r, 20));

    expect(calls, 'A、B 各一次；A 第二次不再增加').toHaveLength(2);
  });
});

describe('onAuthReady', () => {
  beforeEach(async () => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    await backendApi.clearAuth();
  });

  it('已登录时立即回调，并在登录后再次通知', async () => {
    await backendApi.saveAuthToStorage(makeToken(21), {
      id: 21,
      email: 'ready@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });

    const seen: number[] = [];
    const unsubscribe = backendApi.onAuthReady((userId) => seen.push(userId));
    expect(seen, '已就绪应同步回调').toEqual([21]);

    await backendApi.saveAuthToStorage(makeToken(22), {
      id: 22,
      email: 'second@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });
    expect(seen).toEqual([21, 22]);

    unsubscribe();
    await backendApi.saveAuthToStorage(makeToken(23), {
      id: 23,
      email: 'third@example.invalid',
      role: 'user',
      autoModeEnabled: 0,
      trialUsed: 0,
      trialEnabled: 1,
    });
    expect(seen, '取消订阅后不应再收到通知').toEqual([21, 22]);
  });

  it('未登录时不回调', async () => {
    const seen: number[] = [];
    const unsubscribe = backendApi.onAuthReady((userId) => seen.push(userId));
    expect(seen).toEqual([]);
    unsubscribe();
  });
});
