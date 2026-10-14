import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 弹窗策略模块的纯逻辑与判定测试。
 *
 * 覆盖三类最容易出错的地方：
 * 1. 版本比较必须按数字段（1.14.10 是升级，不是降级）
 * 2. 网络失败不等于撤回（有缓存要沿用，无缓存才提示连接问题）
 * 3. 已读记录按后端地址隔离（切后端不能沿用另一后端的确认）
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
  runtime: {
    getManifest: () => ({ version: '1.14.3' }),
  },
};

(globalThis as Record<string, unknown>).browser = browserStub;

const {
  compareVersions,
  isForcedUpdateHit,
  fetchPolicy,
  acknowledgeNotice,
  getAcknowledgedRevision,
  getActualVersion,
} = await import('@/entrypoints/popup/popup-policy');

const BACKEND_A = 'http://localhost:5724';
const BACKEND_B = 'http://localhost:9999';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const forcedEntry = {
  mode: 'forced_update' as const,
  revision: 3,
  title: '必须升级',
  contentHtml: '<p>请升级</p>',
  requiredVersion: '1.15.0',
  downloadUrl: 'https://example.com/app.zip',
  publishedAt: '2026-10-13T00:00:00.000Z',
};

describe('compareVersions', () => {
  it('逐段按数字比较，1.14.10 比 1.14.9 新', () => {
    expect(compareVersions('1.14.10', '1.14.9')).toBeGreaterThan(0);
    expect(compareVersions('1.14.9', '1.14.10')).toBeLessThan(0);
  });

  it('缺失段补零，1.15 与 1.15.0 相等', () => {
    expect(compareVersions('1.15', '1.15.0')).toBe(0);
    expect(compareVersions('1.15.0.0', '1.15')).toBe(0);
  });

  it('相等返回 0，更高返回正数', () => {
    expect(compareVersions('1.14.3', '1.14.3')).toBe(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });
});

describe('isForcedUpdateHit', () => {
  it('实际版本低于要求时命中', () => {
    expect(isForcedUpdateHit(forcedEntry, '1.14.3')).toBe(true);
  });

  it('相等或更高时不命中', () => {
    expect(isForcedUpdateHit(forcedEntry, '1.15.0')).toBe(false);
    expect(isForcedUpdateHit(forcedEntry, '1.15.1')).toBe(false);
  });

  it('无策略或无要求版本时不命中', () => {
    expect(isForcedUpdateHit(null, '1.0.0')).toBe(false);
    expect(isForcedUpdateHit({ ...forcedEntry, requiredVersion: null }, '1.0.0')).toBe(false);
  });
});

describe('getActualVersion', () => {
  it('取 runtime manifest 的版本', () => {
    expect(getActualVersion()).toBe('1.14.3');
  });
});

describe('fetchPolicy', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功响应写入缓存并标记来源为 network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));

    const result = await fetchPolicy(BACKEND_A);
    expect(result.source).toBe('network');
    expect(result.payload.forcedUpdate?.revision).toBe(3);
    expect(result.connectionError).toBeNull();
  });

  it('服务端明确返回空策略时清除旧生效状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));
    await fetchPolicy(BACKEND_A);

    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: null }),
    ));
    const result = await fetchPolicy(BACKEND_A);

    expect(result.payload.forcedUpdate).toBeNull();

    // 后续断网时应拿不到缓存（已被空格子覆盖），而不是沿用旧强制策略
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const afterOffline = await fetchPolicy(BACKEND_A);
    expect(afterOffline.source).toBe('none');
    expect(afterOffline.payload.forcedUpdate).toBeNull();
  });

  it('失败但同后端有缓存时沿用缓存并报连接问题', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));
    await fetchPolicy(BACKEND_A);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const result = await fetchPolicy(BACKEND_A);

    expect(result.source).toBe('cache');
    expect(result.connectionError).toBeTruthy();
    expect(result.payload.forcedUpdate?.revision).toBe(3);
  });

  it('无缓存且失败时不产生强制策略，只报连接问题', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const result = await fetchPolicy(BACKEND_A);

    expect(result.source).toBe('none');
    expect(result.payload).toEqual({ notice: null, forcedUpdate: null });
    expect(result.connectionError).toBeTruthy();
  });

  it('500 响应不被当作撤回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));
    await fetchPolicy(BACKEND_A);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'boom' }, 500)));
    const result = await fetchPolicy(BACKEND_A);
    expect(result.source).toBe('cache');
    expect(result.payload.forcedUpdate?.revision).toBe(3);
  });

  it('结构无效的响应不被当作空策略', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));
    await fetchPolicy(BACKEND_A);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ notice: { bad: true }, forcedUpdate: null })));
    const result = await fetchPolicy(BACKEND_A);
    expect(result.source).toBe('cache');
    expect(result.payload.forcedUpdate?.revision).toBe(3);
  });

  // R3：Codex 独立复现的阻断项。`{}` 缺字段却被当成「成功空策略」，
  // 结果把已知强制缓存删掉 —— 用户断网期间要求升级，服务端返回半截 JSON
  // 反而会解除阻挡。
  it('HTTP 200 返回 {} 时保留已知强制缓存，不当成撤回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));
    await fetchPolicy(BACKEND_A);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    const result = await fetchPolicy(BACKEND_A);

    expect(result.source, '缺字段响应必须按失败处理').not.toBe('network');
    expect(result.payload.forcedUpdate?.revision, '不能因 {} 清掉已知强制策略').toBe(3);
    expect(result.connectionError).toBeTruthy();
  });

  it('HTTP 200 返回缺 requiredVersion 的强制条目时不解除阻挡', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));
    await fetchPolicy(BACKEND_A);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      notice: null,
      // 非法生效条目：没有要求版本，无法用于判定是否达标
      forcedUpdate: { mode: 'forced_update', revision: 4, title: 'x', contentHtml: '<p>x</p>' },
    })));
    const result = await fetchPolicy(BACKEND_A);

    expect(result.source).not.toBe('network');
    expect(result.payload.forcedUpdate?.revision).toBe(3);
  });

  it('HTTP 200 返回非法要求版本／下载地址的强制条目时不解除阻挡', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));
    await fetchPolicy(BACKEND_A);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      notice: null,
      forcedUpdate: {
        mode: 'forced_update',
        revision: 5,
        title: 'x',
        contentHtml: '<p>x</p>',
        requiredVersion: '1.015.0',
        downloadUrl: 'javascript:alert(1)',
      },
    })));
    const result = await fetchPolicy(BACKEND_A);

    expect(result.source).not.toBe('network');
    expect(result.payload.forcedUpdate?.revision).toBe(3);
  });

  it('只有明确同时返回 notice:null 与 forcedUpdate:null 才算有效撤回', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: forcedEntry }),
    ));
    await fetchPolicy(BACKEND_A);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ notice: null, forcedUpdate: null })));
    const result = await fetchPolicy(BACKEND_A);

    expect(result.source).toBe('network');
    expect(result.payload.forcedUpdate).toBeNull();
  });
});

/**
 * B1／B2：整轮终态与「超时不能解除已知强制阻挡」。
 *
 * 这两条必须在 `checkPolicy()` 这一层验证，不能只测 `fetchPolicy` ——
 * 上一轮只测了 fetchPolicy，结果外层 deadline 抢先返回时把缓存结果丢了。
 */
describe('checkPolicy 整轮终态（B1）与超时保留强制（B2）', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('地址 storage 读取不返回时，整轮仍在 5 秒上限内进入终态（B1）', async () => {
    // 只让 backendUrl 的读取永不返回；策略缓存读取仍正常。
    // 旧实现在 checkPolicy 之后又 await 一次地址解析，于是永远到不了 done。
    const realGet = browserStub.storage.local.get;
    browserStub.storage.local.get = async (key: string) => {
      if (key === 'backendUrl') return new Promise(() => {});
      return realGet(key);
    };
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    const { checkPolicy } = await import('@/entrypoints/popup/popup-policy');
    const started = Date.now();
    const decision = await checkPolicy();
    const elapsed = Date.now() - started;

    browserStub.storage.local.get = realGet;

    expect(elapsed, `checkPolicy 耗时 ${elapsed}ms，超过 5 秒上限`).toBeLessThan(6500);
    expect(decision.backendUrl, '结论里必须带一个可用地址').toMatch(/^https?:\/\//);
    expect(decision.connectionError, '必须给出可理解的错误提示').toBeTruthy();
  }, 20000);

  it('网络一直等待时，已知同后端强制缓存仍然阻挡（B2）', async () => {
    // 让地址解析落到与本用例缓存同一个地址上（不写 backendUrl 会用构建期默认值）
    storageData.backendUrl = BACKEND_A;

    // 先正常拿到并缓存「要求 99.0.0」的强制策略
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: { ...forcedEntry, requiredVersion: '99.0.0' } }),
    ));
    const { checkPolicy, fetchPolicy } = await import('@/entrypoints/popup/popup-policy');
    await fetchPolicy(BACKEND_A);

    // 再让策略网络永不返回
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const decision = await checkPolicy();

    expect(decision.forced, '超时不得解除已知强制阻挡').not.toBeNull();
    expect(decision.forced?.requiredVersion).toBe('99.0.0');
    expect(decision.connectionError, '同时仍应提示连接问题').toBeTruthy();
  }, 20000);

  it('超时但无缓存时不凭空造出强制升级（只提示问题）', async () => {
    storageData.backendUrl = BACKEND_A;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { checkPolicy } = await import('@/entrypoints/popup/popup-policy');
    const decision = await checkPolicy();

    expect(decision.forced).toBeNull();
    expect(decision.connectionError).toBeTruthy();
  }, 20000);

  it('地址读取卡住 + 有强制缓存时，仍在本后端地址上保住阻挡（B1+B2 组合）', async () => {
    // 缓存写在**构建期默认地址**上：地址读取完全卡死时只能用兜底地址，
    // 所以这里的缓存必须落在兜底地址上才符合真实情况。
    const { fallbackBackendUrl } = await import('@/entrypoints/popup/popup-policy');
    const fallback = fallbackBackendUrl();

    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ notice: null, forcedUpdate: { ...forcedEntry, requiredVersion: '99.0.0' } }),
    ));
    const { checkPolicy, fetchPolicy } = await import('@/entrypoints/popup/popup-policy');
    await fetchPolicy(fallback);

    const realGet = browserStub.storage.local.get;
    browserStub.storage.local.get = async (key: string) => {
      if (key === 'backendUrl') return new Promise(() => {});
      return realGet(key);
    };
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    const started = Date.now();
    const decision = await checkPolicy();
    const elapsed = Date.now() - started;
    browserStub.storage.local.get = realGet;

    expect(elapsed).toBeLessThan(6500);
    expect(decision.forced, '地址卡住也不能丢已知强制阻挡').not.toBeNull();
  }, 20000);
});

describe('通知确认记录', () => {

  it('未确认时修订号为 0', async () => {
    expect(await getAcknowledgedRevision(BACKEND_A)).toBe(0);
  });

  it('按后端地址隔离，切后端不串确认', async () => {
    await acknowledgeNotice(BACKEND_A, 5);

    expect(await getAcknowledgedRevision(BACKEND_A)).toBe(5);
    expect(await getAcknowledgedRevision(BACKEND_B)).toBe(0);
  });
});
