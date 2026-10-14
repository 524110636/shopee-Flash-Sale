/**
 * @vitest-environment jsdom
 *
 * R1 复现：真实 PopupPolicyHost 在 React StrictMode 下的 effect 生命周期。
 *
 * 为什么必须用真实组件而不是纯逻辑断言：缺陷出在 effect 的 setup/cleanup 配对，
 * 纯函数测试看不到它（Codex 的独立复现也正是用真实源码宿主）。
 *
 * StrictMode 在开发模式下会「setup → cleanup → setup」跑一遍 effect。
 * 原实现用 `started` ref 阻止第二次 setup，同时首次 setup 的异步结果被
 * cleanup 置为 cancelled，两边夹击导致永远停在 checking —— 表现为一直转圈。
 */
import { describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

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
  runtime: { getManifest: () => ({ version: '1.15.0' }) },
};

(globalThis as Record<string, unknown>).browser = browserStub;

const { PopupPolicyHost } = await import('@/entrypoints/popup/PopupPolicyHost');
const backendApi = await import('@/entrypoints/popup/backend-api');

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

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 轮询等待界面离开「检查中」，返回耗时毫秒；超时返回 -1。
 * 用轮询而不是固定 sleep：既跑得快，又能真正证明「及时进入终态」。
 */
async function waitUntilSettled(container: HTMLElement, capMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < capMs) {
    if (!container.textContent?.includes('正在检查通知')) return Date.now() - start;
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  }
  return -1;
}

describe('PopupPolicyHost 在 StrictMode 下的检查终态', () => {
  it('有通知时必须结束检查并显示通知（不能一直转圈）', async () => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse({
      notice: {
        mode: 'notice',
        revision: 1,
        title: 'StrictMode 通知',
        contentHtml: '<p>正文</p>',
        requiredVersion: null,
        downloadUrl: null,
        publishedAt: '2026-10-13T00:00:00.000Z',
      },
      forcedUpdate: null,
    })));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(React.StrictMode, null,
          React.createElement(PopupPolicyHost, null,
            React.createElement('div', { id: 'underlying' }, '底层界面'))),
      );
    });

    // 给足时间：检查上限是 5 秒，这里等 6 秒判定是否进入终态
    const elapsed = await waitUntilSettled(container, 6000);

    const text = container.textContent;
    expect(elapsed, `仍在检查中，未进入终态。当前内容：${text}`).toBeGreaterThanOrEqual(0);
    expect(text).toContain('StrictMode 通知');
    // 整轮上限 5 秒；留 1.5 秒余量覆盖 jsdom 与 CI 抖动
    expect(elapsed, `进入终态耗时 ${elapsed}ms，超过 5 秒上限`).toBeLessThan(6500);

    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  }, 30000);

  it('无通知时同样必须结束检查并恢复正常界面', async () => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse({ notice: null, forcedUpdate: null })));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(React.StrictMode, null,
          React.createElement(PopupPolicyHost, null,
            React.createElement('div', { id: 'underlying' }, '底层界面'))),
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 6000));
    });

    const text = container.textContent;
    expect(text, `仍在检查中。当前内容：${text}`).not.toContain('正在检查通知');
    expect(text).toContain('底层界面');

    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  }, 30000);

  it('网络挂住不返回时必须在上限内结束并提示连接问题（不能只给 fetch 设 timeout）', async () => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    // 这个 fetch 永不 settle：只有「整条链」有上限才能结束检查
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(React.StrictMode, null,
          React.createElement(PopupPolicyHost, null,
            React.createElement('div', null, '底层界面'))),
      );
    });

    const elapsed = await waitUntilSettled(container, 8000);
    expect(elapsed, '超时上限未生效，界面一直停在检查中').toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(7500);
    expect(container.textContent).toContain('超时');

    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  }, 30000);

  it('图片自有资源路径按后端地址解析，不落到 chrome-extension:// 目录', async () => {
    const { resolveAssetUrls } = await import('@/entrypoints/popup/popup-policy');
    const html = '<p>正文</p><img src="/popup-assets/abc"><a href="/popup-assets/x">x</a>'
      + '<img src="https://cdn.example.com/a.png">';

    const resolved = resolveAssetUrls(html, 'http://localhost:5799');

    expect(resolved).toContain('src="http://localhost:5799/popup-assets/abc"');
    expect(resolved).toContain('href="http://localhost:5799/popup-assets/x"');
    // 外部链接必须原样保留，不能被改写
    expect(resolved).toContain('src="https://cdn.example.com/a.png"');
    // 不能残留会被解析到扩展目录的相对路径
    expect(resolved).not.toMatch(/(src|href)="\/popup-assets\//);

    // 换后端地址时图片跟着换，不串缓存
    const other = resolveAssetUrls(html, 'http://43.99.86.228:5724');
    expect(other).toContain('src="http://43.99.86.228:5724/popup-assets/abc"');
  });

  /**
   * 查看上报的门控：**只有实际显示的那一条**才上报。
   *
   * 为什么必须在真实组件上测：判断「显示了哪一条」是渲染分支决定的
   * （强制优先时通知被遮住、已确认后通知不再出现），纯逻辑测不到。
   */
  describe('查看上报只给实际显示的那一条', () => {
    const NOTICE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const FORCED_ID = 'ffffffff-1111-2222-3333-444444444444';

    function noticeEntry(revision = 1) {
      return {
        recordId: NOTICE_ID,
        mode: 'notice',
        revision,
        title: '上报用通知',
        contentHtml: '<p>正文</p>',
        requiredVersion: null,
        downloadUrl: null,
        publishedAt: '2026-10-14T00:00:00.000Z',
      };
    }

    function forcedEntry(requiredVersion = '99.0.0') {
      return {
        recordId: FORCED_ID,
        mode: 'forced_update',
        revision: 4,
        title: '上报用强制',
        contentHtml: '<p>请升级</p>',
        requiredVersion,
        downloadUrl: 'https://example.com/app.zip',
        publishedAt: '2026-10-14T00:00:00.000Z',
      };
    }

    /** 记录所有到 popup-views 的上报体；策略请求照常走原 stub。 */
    function trackViewReports(payload: unknown) {
      const reports: any[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (String(url).includes('/popup-views')) {
            reports.push(init?.body ? JSON.parse(String(init.body)) : null);
            return makeResponse({ counted: true, isNewView: true });
          }
          return makeResponse(payload);
        }),
      );
      return reports;
    }

    /** 预置一个已登录的测试账号：统计只认服务端可确认的登录账号。 */
    async function signedIn(userId = 91) {
      await backendApi.saveAuthToStorage(makeToken(userId), {
        id: userId,
        email: `viewer${userId}@example.invalid`,
        role: 'user',
        autoModeEnabled: 0,
        trialUsed: 0,
        trialEnabled: 1,
      });
    }

    async function signedOut() {
      await backendApi.clearAuth();
    }

    async function renderHost() {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          React.createElement(React.StrictMode, null,
            React.createElement(PopupPolicyHost, null,
              React.createElement('div', { id: 'underlying' }, '底层界面'))),
        );
      });
      return { container, root };
    }

    it('显示通知时只上报该通知的 recordId 与 revision', async () => {
      for (const key of Object.keys(storageData)) delete storageData[key];
      await signedIn();
      const reports = trackViewReports({ notice: noticeEntry(3), forcedUpdate: null });

      const { container, root } = await renderHost();
      await waitUntilSettled(container, 6000);
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      expect(reports, `上报次数应为 1，实际 ${reports.length}`).toHaveLength(1);
      expect(reports[0]).toEqual({ recordId: NOTICE_ID, mode: 'notice', revision: 3 });

      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }, 30000);

    it('强制优先时只上报强制，被遮住的通知不计', async () => {
      for (const key of Object.keys(storageData)) delete storageData[key];
      await signedIn();
      // requiredVersion 99.0.0 远高于测试 manifest，必定命中强制
      const reports = trackViewReports({ notice: noticeEntry(3), forcedUpdate: forcedEntry() });

      const { container, root } = await renderHost();
      await waitUntilSettled(container, 6000);
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      expect(reports).toHaveLength(1);
      expect(reports[0].recordId).toBe(FORCED_ID);
      expect(reports[0].mode).toBe('forced_update');
      expect(reports.map((r) => r.recordId)).not.toContain(NOTICE_ID);

      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }, 30000);

    it('版本已达标而未显示的强制不上报，只上报通知', async () => {
      for (const key of Object.keys(storageData)) delete storageData[key];
      await signedIn();
      // requiredVersion 0.0.1，实际版本一定达标 → 强制不显示
      const reports = trackViewReports({ notice: noticeEntry(5), forcedUpdate: forcedEntry('0.0.1') });

      const { container, root } = await renderHost();
      await waitUntilSettled(container, 6000);
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      expect(reports).toHaveLength(1);
      expect(reports[0].recordId).toBe(NOTICE_ID);

      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }, 30000);

    it('已确认过的通知不再显示，也不上报', async () => {
      for (const key of Object.keys(storageData)) delete storageData[key];
      await signedIn();
      // 不写死后端地址：测试环境里 VITE_BACKEND_URL 由仓库 .env 决定，
      // 写死会把「已确认」记到错误的键上，测试假通过。这里按实际解析结果预置。
      const { ensureBackendUrl } = await import('@/entrypoints/popup/popup-policy');
      const backendUrl = await ensureBackendUrl();
      storageData['_popupNoticeAck'] = { [backendUrl]: 3 };
      const reports = trackViewReports({ notice: noticeEntry(3), forcedUpdate: null });

      const { container, root } = await renderHost();
      await waitUntilSettled(container, 6000);
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      expect(reports, '未显示的弹窗不能产生查看记录').toHaveLength(0);
      expect(container.textContent).toContain('底层界面');

      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }, 30000);

    it('旧缓存没有 recordId 时照常展示且不上报', async () => {
      for (const key of Object.keys(storageData)) delete storageData[key];
      await signedIn();
      const legacy = { ...noticeEntry(9) } as Record<string, unknown>;
      delete legacy.recordId;
      const reports = trackViewReports({ notice: legacy, forcedUpdate: null });

      const { container, root } = await renderHost();
      await waitUntilSettled(container, 6000);
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      expect(container.textContent, '旧内容必须照常展示').toContain('上报用通知');
      expect(reports).toHaveLength(0);

      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }, 30000);

    it('展示时未登录、之后身份才恢复：弹窗仍显示时应补报一次', async () => {
      for (const key of Object.keys(storageData)) delete storageData[key];
      await signedOut();
      const reports = trackViewReports({ notice: noticeEntry(7), forcedUpdate: null });

      const { container, root } = await renderHost();
      await waitUntilSettled(container, 6000);
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
      expect(reports, '身份未就绪时不发无账号请求').toHaveLength(0);

      // 身份稍后才恢复（等价于 popup 的 checkAuthOnStartup 完成）
      await signedIn(93);
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      expect(reports, '身份就绪且弹窗仍显示时必须补报').toHaveLength(1);
      expect(reports[0]).toEqual({ recordId: NOTICE_ID, mode: 'notice', revision: 7 });

      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }, 30000);

    it('展示时未登录且弹窗随后被确认关闭：不补报任何账号', async () => {
      for (const key of Object.keys(storageData)) delete storageData[key];
      await signedOut();
      const reports = trackViewReports({ notice: noticeEntry(8), forcedUpdate: null });

      const { container, root } = await renderHost();
      await waitUntilSettled(container, 6000);

      // 用户先点了「我知道了」把通知关掉
      const button = Array.from(container.querySelectorAll('button'))
        .find((b) => b.textContent?.includes('我知道了'));
      expect(button, '通知应有确认按钮').toBeTruthy();
      await act(async () => { button!.click(); });
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

      await signedIn(94);
      await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

      expect(reports, '已关闭的弹窗不能追溯成某账号查看').toHaveLength(0);

      await act(async () => { root.unmount(); });
      container.remove();
      vi.unstubAllGlobals();
    }, 30000);
  });
});
