/**
 * @vitest-environment jsdom
 *
 * 第 40.5 节 R7：保存与候选列表的**归属隔离**（真实 store 路径）。
 *
 * 为什么不只在浏览器里测：这两条缺陷都发生在 store 的**时序**细节上
 * （第一次刷新就换店、迟到响应回灌），用真实 store 才能稳定构造，
 * 而且不受界面自动重载的掩盖。
 *
 * 两个场景与验收 `standards/store-results.json` 的两条失败一一对应：
 *   1. `saveGroup`：A 店草稿 → **第一次** refreshOwner 就变 B → 必须整次拒绝、零保存；
 *   2. `loadPickList`：A 店列表在途 → 切 B → A 响应迟到 → 不得回灌新店。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storageData: Record<string, unknown> = {};

/** 让 `SHIPPING_IDENTITY` / `SHIPPING_PRODUCT_LIST` 的返回可控 */
let identityReply: { shopId: number | null; userId: number | null } | null = { shopId: 101, userId: 1 };
let pickListReply: { ok: boolean; products: Array<{ itemId: string; name: string; sold: number | null }> } = {
  ok: true,
  products: [{ itemId: '111', name: 'A 店商品', sold: 10 }],
};
/** 列表响应的延迟（用来把"在途"窗口留出来） */
let pickListDelayMs = 0;
let messageLog: string[] = [];

const browserStub = {
  storage: {
    local: {
      get: async (key: string | string[]) => {
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) if (k in storageData) out[k] = storageData[k];
          return out;
        }
        return key in storageData ? { [key]: storageData[key] } : {};
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(storageData, items);
      },
      remove: async (key: string) => {
        delete storageData[key];
      },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    getManifest: () => ({ version: '1.15.2' }),
    sendMessage: async (msg: { type?: string; requestId?: string }) => {
      messageLog.push(String(msg?.type));
      if (msg?.type === 'SHIPPING_IDENTITY') {
        const reply = identityReply;
        storageData['_shippingIdentity'] = reply ? { ...reply, at: Date.now() } : undefined;
        return reply;
      }
      if (msg?.type === 'SHIPPING_PRODUCT_LIST') {
        // 请求发出时就固定这份响应的内容（真实后台也是发起时取的那份数据）
        const reply = pickListReply;
        if (pickListDelayMs > 0) await new Promise(r => setTimeout(r, pickListDelayMs));
        storageData['_shippingPickList'] = { requestId: msg.requestId, at: Date.now(), result: reply };
        return { ok: reply.ok };
      }
      if (msg?.type === 'SHIPPING_GROUP_SAVE') {
        // 后台会拒绝/接受；这里模拟"后台接受了"，用来证明界面**自己**先挡住了
        storageData['_shippingGroups'] = {
          active: { groupId: 'grp-should-not-exist' },
          lastFinished: null,
          updatedAt: Date.now(),
        };
        return { success: true };
      }
      return undefined;
    },
  },
};

(globalThis as Record<string, unknown>).browser = browserStub;

const { useShippingStore, SHIPPING_DEFAULT_GROUP_DRAFT } = await import('@/features/shipping/store');
const { SHIPPING_DEFAULT_PLANS } = await import('@/features/shipping/types');
const { meaningfulPlans } = await import('@/features/shipping/rules');

/** 一份真正的空白安排（默认草稿本身时刻为空，这里显式再清一次日期／排除） */
function emptyDraft() {
  return {
    ...SHIPPING_DEFAULT_GROUP_DRAFT,
    startDate: '',
    startTime: '',
    restoreDate: '',
    restoreTime: '',
    excludeIds: '',
  };
}

/** 台湾时区的"未来一小时"写成日期／时间串（store 需要合法输入才能走到归属判断） */
function futureSlot(offsetMs: number): { date: string; time: string } {
  const d = new Date(Date.now() + offsetMs + 8 * 3600_000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

beforeEach(() => {
  for (const k of Object.keys(storageData)) delete storageData[k];
  messageLog = [];
  identityReply = { shopId: 101, userId: 1 };
  pickListReply = { ok: true, products: [{ itemId: '111', name: 'A 店商品', sold: 10 }] };
  pickListDelayMs = 0;
  useShippingStore.setState({
    ownerShopId: null,
    ownerUserId: null,
    pickList: [],
    pickListShopId: null,
    pickListLoading: false,
    pickListError: null,
    groupDraft: { ...SHIPPING_DEFAULT_GROUP_DRAFT },
    group: null,
    groupSaving: false,
    error: null,
    notice: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R7 保存：第一次身份刷新就换店必须拒绝', () => {
  it('A 草稿 → 首次 refreshOwner 变 B → 零保存并给出可读原因', async () => {
    const store = useShippingStore;
    // A 店已核实，草稿含 A 店排除
    store.getState().setOwner(101, 1);
    const s = futureSlot(3600_000);
    const r = futureSlot(7200_000);
    store.getState().updateGroupDraft({
      startDate: s.date,
      startTime: s.time,
      restoreDate: r.date,
      restoreTime: r.time,
      regularDays: 8,
      excludeIds: '111',
    });
    expect(store.getState().groupDraft.excludeIds).toBe('111');

    // 关键时序：**第一次** refreshOwner 就把归属换成 B（真实路径里由 setOwner 完成清理）
    identityReply = { shopId: 202, userId: 2 };

    const result = await store.getState().saveGroup();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/不同|重新设置|重新选择/);
    // 不得落盘任何新组：消息里也不应该出现过保存请求
    expect(storageData['_shippingGroups']).toBeUndefined();
    expect(messageLog).not.toContain('SHIPPING_GROUP_SAVE');
    expect(store.getState().group).toBeNull();
  });

  it('同店正常保存仍然通过（正向对照）', async () => {
    const store = useShippingStore;
    store.getState().setOwner(101, 1);
    const s = futureSlot(3600_000);
    const r = futureSlot(7200_000);
    store.getState().updateGroupDraft({
      startDate: s.date,
      startTime: s.time,
      restoreDate: r.date,
      restoreTime: r.time,
      regularDays: 8,
      excludeIds: '111',
    });
    const result = await store.getState().saveGroup();
    expect(result.success).toBe(true);
    expect(messageLog).toContain('SHIPPING_GROUP_SAVE');
  });

  it('账号读不到（userId 为 null）时拒绝保存', async () => {
    const store = useShippingStore;
    store.getState().setOwner(101, 1);
    const s = futureSlot(3600_000);
    const r = futureSlot(7200_000);
    store.getState().updateGroupDraft({
      startDate: s.date,
      startTime: s.time,
      restoreDate: r.date,
      restoreTime: r.time,
      regularDays: 8,
      excludeIds: '111',
    });
    identityReply = { shopId: 101, userId: null };
    const result = await store.getState().saveGroup();
    expect(result.success).toBe(false);
    expect(logicalSaveSent()).toBe(false);
  });

  function logicalSaveSent() {
    return messageLog.includes('SHIPPING_GROUP_SAVE');
  }

  it('尚未核实归属时拒绝保存（不能用"未知归属"的草稿）', async () => {
    const store = useShippingStore;
    const s = futureSlot(3600_000);
    const r = futureSlot(7200_000);
    store.getState().updateGroupDraft({
      startDate: s.date,
      startTime: s.time,
      restoreDate: r.date,
      restoreTime: r.time,
      regularDays: 8,
      excludeIds: '111',
    });
    const result = await store.getState().saveGroup();
    expect(result.success).toBe(false);
    expect(messageLog).not.toContain('SHIPPING_GROUP_SAVE');
  });
});

describe('R7 候选列表：迟到响应不得回灌新店', () => {
  it('A 店列表在途 → 切 B → A 响应迟到时必须丢弃', async () => {
    const store = useShippingStore;
    store.getState().setOwner(101, 1);
    pickListDelayMs = 600;
    const pending = store.getState().loadPickList();
    // 列表还没回来就切到 B 店
    store.getState().setOwner(202, 2);
    await pending;

    const state = store.getState();
    expect(state.ownerShopId).toBe(202);
    expect(state.pickList, 'A 店的商品不得回灌给 B 店').toHaveLength(0);
    expect(state.pickListShopId).toBeNull();
    expect(state.pickListError).toMatch(/已切换店铺|重新加载/);
  });

  it('同店正常加载可用（正向对照）', async () => {
    const store = useShippingStore;
    store.getState().setOwner(101, 1);
    await store.getState().loadPickList();
    const state = store.getState();
    expect(state.pickList).toHaveLength(1);
    expect(state.pickListShopId).toBe(101);
    expect(state.pickListError).toBeNull();
  });
});

/**
 * 第 43.2 节 R7：**同店换账号**的迟到列表。
 *
 * 为什么单列一组：早先的隔离判据只比店铺（`pickListShopId === ownerShopId`），
 * 于是"同一家店换账号"这条路径整条漏掉 —— store 认为 A 账号的列表还是当前列表，
 * 弹窗也认为它可信，用户能把旧账号的商品确认进新账号的安排（验收在真实 store 上复现）。
 */
describe('R7 候选列表：同店换账号的迟到响应也不得回流', () => {
  it('店不变、账号 1 → 账号 2：旧账号列表必须整份丢弃', async () => {
    const store = useShippingStore;
    store.getState().setOwner(101, 1);
    pickListDelayMs = 600;
    const pending = store.getState().loadPickList();
    // 同一家店，换成另一个账号
    store.getState().setOwner(101, 2);
    await pending;

    const state = store.getState();
    expect(state.ownerShopId).toBe(101);
    expect(state.ownerUserId).toBe(2);
    expect(state.pickList, '旧账号的商品不得回流给新账号').toHaveLength(0);
    expect(state.pickListShopId, '归属标记也不得留下').toBeNull();
    expect(state.pickListOwnerUserId).toBeNull();
    expect(state.pickListError).toMatch(/已切换店铺|账号|重新加载/);
  });

  it('同店同账号正常加载仍可用，并记录账号归属（正向对照）', async () => {
    const store = useShippingStore;
    store.getState().setOwner(101, 1);
    await store.getState().loadPickList();
    const state = store.getState();
    expect(state.pickList).toHaveLength(1);
    expect(state.pickListShopId).toBe(101);
    expect(state.pickListOwnerUserId).toBe(1);
  });

  it('旧账号响应迟到时不得抹掉新账号已加载好的列表', async () => {
    const store = useShippingStore;
    store.getState().setOwner(101, 1);

    /**
     * 关键布置：**同店同账号**（否则请求发起时就已是别的归属，走的是"已切换"分支，
     * 测不到"迟到响应覆盖新结果"这条路径）。两份响应都是账号 1 的：
     * 先发起的那份内容旧（`111`），后发起的那份是用户刷新得到的新内容（`222`）。
     * 旧响应迟到回来时不得覆盖新结果。
     */
    pickListReply = { ok: true, products: [{ itemId: '111', name: '旧一次的结果', sold: 10 }] };
    pickListDelayMs = 900;
    const first = store.getState().loadPickList();

    // 用户点了「刷新列表」：内容已经是新的
    pickListReply = { ok: true, products: [{ itemId: '222', name: '刷新后的结果', sold: 20 }] };
    pickListDelayMs = 0;
    await store.getState().loadPickList();
    expect(store.getState().pickList.map(p => p.itemId)).toEqual(['222']);

    // 第一次的响应这时才回来
    await first;

    const state = store.getState();
    expect(state.pickList.map(p => p.itemId), '先发起的旧响应必须失效，不得覆盖刷新结果').toEqual(['222']);
    expect(state.pickListShopId).toBe(101);
    expect(state.pickListOwnerUserId).toBe(1);
    expect(state.pickListError).toBeNull();
  });
});

/**
 * 第 53.3 节 U14：默认时刻的**写入时机**。
 *
 * 为什么必须在 store 上测而不只在规则里测：规则只回答"默认值是什么"，
 * 而验收关心的是"什么时候**不该**被套上默认值" —— 已有草稿、活跃安排、
 * 明确「再次安排」这三条路径都从 store 走，错一处用户填好的时间就会被动改。
 */
describe('U14 默认时刻：只在全新空白安排上落地', () => {
  it('空白草稿 → 补上今天 23:30／次日 01:30', () => {
    const store = useShippingStore;
    store.setState({ groupDraft: emptyDraft() });
    store.getState().seedDefaultSchedule();
    const d = store.getState().groupDraft;
    expect(d.startTime).toBe('23:30');
    expect(d.restoreTime).toBe('01:30');
    expect(d.restoreDate).not.toBe('');
    expect(d.restoreDate).not.toBe(d.startDate);
  });

  it('已经有日期的草稿不受影响（用户填过就不动）', () => {
    const store = useShippingStore;
    store.setState({
      groupDraft: { ...emptyDraft(), startDate: '2026-11-01', startTime: '22:00' },
    });
    store.getState().seedDefaultSchedule();
    const d = store.getState().groupDraft;
    expect(d.startDate).toBe('2026-11-01');
    expect(d.startTime).toBe('22:00');
  });

  it('已有排除集合的草稿也不受影响的（复用路径不能被当成空白）', () => {
    const store = useShippingStore;
    store.setState({ groupDraft: { ...emptyDraft(), excludeIds: '111' } });
    store.getState().seedDefaultSchedule();
    expect(store.getState().groupDraft.startTime).toBe('');
  });

  it('换店／换账号会重置为一份新的空白安排并带默认时刻', () => {
    const store = useShippingStore;
    store.setState({ ownerShopId: 101, ownerUserId: 1, groupDraft: emptyDraft() });
    store.getState().updateGroupDraft({ startDate: '2026-11-01', startTime: '22:00', excludeIds: '111' });
    // 换成另一家店
    store.getState().setOwner(202, 2);
    const d = store.getState().groupDraft;
    expect(d.excludeIds, '上一家店的排除不得留下').toBe('');
    expect(d.startTime, '新空白安排应带默认时刻').toBe('23:30');
    expect(d.restoreTime).toBe('01:30');
  });

  it('改开始日期联动恢复日期，但保留用户上次设的恢复时刻', () => {
    const store = useShippingStore;
    // 「再次安排」带出的形态：日期空、时刻是上次的、恢复未手动编辑
    store.setState({
      groupDraft: {
        ...emptyDraft(),
        regularDays: 8,
        startTime: '22:00',
        restoreTime: '02:15',
        restoreTouched: false,
      },
    });
    store.getState().updateGroupDraft({ startDate: '2026-11-01' });
    const d = store.getState().groupDraft;
    expect(d.restoreDate).toBe('2026-11-02');
    expect(d.restoreTime, '沿用上次的 02:15，不得被写回默认 01:30').toBe('02:15');
  });

  it('用户手动改过恢复日期后，再改开始日期不得覆盖它', () => {
    const store = useShippingStore;
    store.setState({ groupDraft: { ...emptyDraft(), startDate: '2026-11-01', restoreDate: '2026-11-05' } });
    store.getState().updateGroupDraft({ restoreDate: '2026-11-05' }); // 记为已手动编辑
    store.getState().updateGroupDraft({ startDate: '2026-12-01' });
    const d = store.getState().groupDraft;
    expect(d.restoreDate, '用户特意设的跨多天恢复不得被联动改掉').toBe('2026-11-05');
  });

  /**
   * 第 56.2 节返工的核心用例（验收复现的那一条）。
   *
   * 复现：默认开始 10-16／恢复 10-17 → 只改恢复时刻 04:15 → 再改开始日 10-21。
   * 修前恢复日期停在 10-17（因为改恢复**时刻**也被当成"已编辑恢复日期"而锁住了日期），
   * 预期 10-22 04:15。验收在原生 popup 上同样复现（开始 2100-01-02、恢复仍 2100-01-01 04:15）。
   */
  it('只改恢复时刻后改开始日期 → 恢复日期仍跟到次日，时刻保留用户值（第 56.2 节）', () => {
    const store = useShippingStore;
    // 全新空白安排 seed 出默认：10-16 23:30 → 10-17 01:30
    store.setState({
      groupDraft: { ...emptyDraft(), startDate: '2026-10-16', startTime: '23:30', restoreDate: '2026-10-17', restoreTime: '01:30' },
    });
    // 只改恢复**时刻**
    store.getState().updateGroupDraft({ restoreTime: '04:15' });
    expect(store.getState().groupDraft.restoreDate, '只改时刻不应锁住日期').toBe('2026-10-17');

    // 再改开始日期
    store.getState().updateGroupDraft({ startDate: '2026-10-21' });
    const d = store.getState().groupDraft;
    expect(d.restoreDate, '未被用户编辑的恢复日期必须跟到开始日次日').toBe('2026-10-22');
    expect(d.restoreTime, '用户设的 04:15 必须保留').toBe('04:15');
  });

  it('只改恢复时刻后改开始日期，恢复到昨天时也不会留下已过去的恢复日', () => {
    const store = useShippingStore;
    // 默认是"今天 → 明天"，把开始日往前挪一天会让旧的恢复日变成过去
    store.setState({
      groupDraft: { ...emptyDraft(), startDate: '2100-01-01', startTime: '23:30', restoreDate: '2100-01-02', restoreTime: '01:30' },
    });
    store.getState().updateGroupDraft({ restoreTime: '04:15' });
    store.getState().updateGroupDraft({ startDate: '2100-01-02' });
    const d = store.getState().groupDraft;
    expect(d.restoreDate, '预期 2100-01-03（验收的原生 popup 复现值）').toBe('2100-01-03');
    expect(d.restoreTime).toBe('04:15');
  });

  it('改过恢复日期后，该日期与时刻都不再被联动覆盖', () => {
    const store = useShippingStore;
    store.setState({
      groupDraft: { ...emptyDraft(), startDate: '2026-11-01', restoreDate: '2026-11-02', restoreTime: '01:30' },
    });
    store.getState().updateGroupDraft({ restoreDate: '2026-11-09' });
    store.getState().updateGroupDraft({ restoreTime: '03:45' });
    store.getState().updateGroupDraft({ startDate: '2026-12-01' });
    const d = store.getState().groupDraft;
    expect(d.restoreDate, '用户明确编辑过的恢复日期不得被覆盖').toBe('2026-11-09');
    expect(d.restoreTime, '用户明确编辑过的恢复时刻不得被覆盖').toBe('03:45');
  });

  it('30 秒心跳式重复 seed 不会改用户已设置的值', () => {
    const store = useShippingStore;
    store.setState({ groupDraft: emptyDraft() });
    store.getState().seedDefaultSchedule();
    const first = store.getState().groupDraft;
    store.getState().updateGroupDraft({ startDate: '2027-01-05', startTime: '21:00', restoreDate: '2027-01-06' });
    const after = store.getState().groupDraft;
    store.getState().seedDefaultSchedule();
    store.getState().seedDefaultSchedule();
    expect(store.getState().groupDraft).toEqual(after);
    expect(store.getState().groupDraft.startDate).toBe('2027-01-05');
    expect(first.startTime).toBe('23:30');
  });
});

/**
 * 第 53.3 节 U14 第 4 点：**明确「再次安排」仍沿用上次时刻**，不因换店被清掉义务之外的东西。
 * 这里只验证"同店复用"这条正向路径仍能带出上次时刻与排除。
 */
describe('U14 明确复用：同归属沿用上次时刻，日期仍留空', () => {
  it('同店同账号复用带出时刻／排除／天数，但日期为空', () => {
    const store = useShippingStore;
    const future = Date.now() + 3 * 3600_000;
    const finished = {
      groupId: 'g1',
      phase: 'done' as const,
      schedule: { startAt: future, restoreAt: future + 7200_000, spotDays: 1, regularDays: 8 },
      config: { range: 'all' as const, excludeIds: '111', toggleLogistics: false },
      ownerShopId: 101,
      ownerUserId: 1,
      updatedAt: Date.now(),
    };
    store.setState({
      ownerShopId: 101,
      ownerUserId: 1,
      groupDraft: emptyDraft(),
      groupLastFinished: finished as never,
    });
    store.getState().reuseLastGroup();
    const d = store.getState().groupDraft;
    expect(d.startDate, '日期必须留空，强制用户重新确认').toBe('');
    expect(d.restoreDate).toBe('');
    expect(d.excludeIds).toBe('111');
    expect(d.regularDays).toBe(8);
    expect(d.startTime).not.toBe('');
  });
});

/**
 * 第 56.3 节：旧计划**不能再被启用**。
 *
 * 为什么在 store 上测而不只看界面：界面不是唯一入口（消息、旧版本页面、
 * 残留调用都可能走到 `savePlan`）。一条 `enabled` 的旧计划会写 `_shippingPlans`
 * 并让 `shipping_plan_check` 重新调度，绕过"切到 1 天后必须有恢复安排"的主路径。
 */
describe('第 56.3 节 旧计划不得被重新启用', () => {
  /** 造一条"真实"旧计划（有日期与归属，因此不是空白占位，见第 59.2 节） */
  function legacyPlan(patch: Record<string, unknown> = {}) {
    return {
      ...SHIPPING_DEFAULT_PLANS[0],
      date: '2100-01-05',
      time: '09:00',
      ownerShopId: 101,
      ownerUserId: 1,
      ...patch,
    };
  }

  it('savePlan 拒绝 enabled 的旧计划，记录不变', async () => {
    const store = useShippingStore;
    // 先满足归属条件，否则会被"无法核实身份"那条提前拒绝 —— 那样就测不到 enabled 这条闸门
    store.setState({ ownerShopId: 101, ownerUserId: 1, plans: [legacyPlan()] });
    const before = store.getState().plans.map(p => JSON.stringify(p));
    await store.getState().savePlan(legacyPlan({ enabled: true }) as never);

    const state = store.getState();
    expect(state.plans.map(p => JSON.stringify(p)), '被拒绝时不得改动任何计划记录').toEqual(before);
    expect(messageLog, '不得发出同步 alarm 的请求').not.toContain('SHIPPING_SYNC_ALARMS');
    expect(state.error ?? '', '拒绝原因必须来自 enabled 闸门，而不是归属检查').toMatch(
      /旧版计划入口已下线|不能再启用/,
    );
    expect(state.error ?? '').not.toMatch(/无法核实/);
  });

  it('关闭状态下仍可写（记录要能保留／更新历史）', async () => {
    const store = useShippingStore;
    store.setState({ ownerShopId: 101, ownerUserId: 1, plans: [legacyPlan()] });
    await store.getState().savePlan(legacyPlan({ enabled: false, days: 3 }) as never);

    const stored = store.getState().plans[0];
    expect(store.getState().error ?? '', '关闭旧计划不应被拒').toBe('');
    expect(stored.enabled, '关闭状态应被写入').toBe(false);
    expect(stored.days, '历史字段应可更新').toBe(3);
  });
});

/**
 * 第 59.2 节：**真空白用户不该看到两条不存在的旧计划**。
 *
 * 为什么单列一组：连续两轮的"新用户隐藏旧计划"都漏在同一个地方 ——
 * 加载兜底与初始 state 都给出 `SHIPPING_DEFAULT_PLANS` 两张空白占位，
 * 而呈现判定只用了 `plans.length > 0`。这里从**真实加载路径**验证，
 * 不直接把 `store.plans` 置空来代替。
 */
describe('第 59.2 节 空白用户不显示默认旧计划占位', () => {
  it('缺 _shippingPlans 键：loadFromStorage 后 plans 为空，不是两张默认占位', async () => {
    const store = useShippingStore;
    store.setState({ plans: [] });
    expect('_shippingPlans' in storageData, '前置条件：键必须不存在').toBe(false);

    await store.getState().loadFromStorage();
    const plans = store.getState().plans;
    expect(plans, '无键时不得给空白占位').toEqual([]);
    expect(meaningfulPlans(plans), '呈现层同样应为空').toEqual([]);
  });

  it('显式空数组 []：同样为空，不得复活默认槽位', async () => {
    const store = useShippingStore;
    storageData['_shippingPlans'] = [];
    await store.getState().loadFromStorage();
    expect(store.getState().plans).toEqual([]);
  });

  it('blank 默认占位即便出现也不被当成历史（判据本身）', () => {
    expect(meaningfulPlans(SHIPPING_DEFAULT_PLANS), '两张默认占位都不是历史').toEqual([]);
  });

  it('已配置日期但从未运行的真实记录必须保留（不能按 lastRunAt 过滤）', async () => {
    const store = useShippingStore;
    storageData['_shippingPlans'] = [{ ...SHIPPING_DEFAULT_PLANS[0], date: '2100-03-08', ownerShopId: 101, ownerUserId: 1 }];
    await store.getState().loadFromStorage();
    const plans = store.getState().plans;
    expect(plans, '真实记录不应被丢弃').toHaveLength(1);
    expect(meaningfulPlans(plans)).toHaveLength(1);
    expect(plans[0].date).toBe('2100-03-08');
  });

  it('已运行／retired／enabled 遗留／绑定归属的记录都算真实历史', () => {
    const base = { ...SHIPPING_DEFAULT_PLANS[0] };
    expect(meaningfulPlans([{ ...base, lastRunAt: Date.now() }]), '已运行').toHaveLength(1);
    expect(meaningfulPlans([{ ...base, lastResult: 'completed' }]), '有结果').toHaveLength(1);
    expect(meaningfulPlans([{ ...base, retired: true }]), '迁移过').toHaveLength(1);
    expect(meaningfulPlans([{ ...base, missed: true }]), '错过过').toHaveLength(1);
    expect(meaningfulPlans([{ ...base, enabled: true }]), '仍启用').toHaveLength(1);
    expect(meaningfulPlans([{ ...base, ownerShopId: 101 }]), '绑定过归属').toHaveLength(1);
    expect(meaningfulPlans([base]), '全空占位').toEqual([]);
  });

  it('syncPlans 在键被清掉时同步为空（不沿用上一次的值）', async () => {
    const store = useShippingStore;
    storageData['_shippingPlans'] = [{ ...SHIPPING_DEFAULT_PLANS[0], date: '2100-03-08' }];
    await store.getState().syncPlans();
    expect(store.getState().plans).toHaveLength(1);

    delete storageData['_shippingPlans'];
    await store.getState().syncPlans();
    expect(store.getState().plans, '键不存在时不得保留已经不存在的历史').toEqual([]);
  });
});
