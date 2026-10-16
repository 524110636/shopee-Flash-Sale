/**
 * @vitest-environment jsdom
 *
 * 第 43.2 节 R7：**排除弹窗真的按完整归属（店铺＋账号）决定是否显示候选**。
 *
 * 为什么不能只断言"文件里 import 了共用判据"：那只证明代码里出现了这个名字，
 * 不证明弹窗**实际用它**。验收反复指出"只验证直接调用正例不算通过"。
 * 这里真的把弹窗渲染出来，检查它渲染出的商品行数：
 * 同店换账号后旧账号的候选必须一行都不显示（而不是仍然显示、只是文件里多了个 import）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const storageData: Record<string, unknown> = {};

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
  runtime: { getManifest: () => ({ version: '1.15.2' }), sendMessage: async () => undefined },
};

(globalThis as Record<string, unknown>).browser = browserStub;

const { useShippingStore } = await import('@/features/shipping/store');
const { ShippingExcludeModal } = await import('@/components/product/shipping/ShippingExcludeModal');

/**
 * 真正挂载一次弹窗（`open` 状态），返回其渲染出的 HTML。
 *
 * 为什么用客户端渲染而不是 `renderToStaticMarkup`：本 store 是 Zustand v5，
 * 它在服务端渲染时会把**初始状态**当作快照（`getServerSnapshot`），
 * 于测试里设置的归属／候选全部读不到，弹窗永远被判为不可信 —— 那是测试手法的假象。
 */
async function mountModal(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(ShippingExcludeModal, {
        open: true,
        onClose: () => {},
        confirming: [],
        onConfirm: () => {},
      }),
    );
  });
  return { container, root };
}

/** 弹窗里渲染出的商品行（每行的复选框 aria-label 带商品 ID） */
function renderedItemIds(html: string): string[] {
  return [...html.matchAll(/aria-label="排除商品 (\d+)"/g)].map(m => m[1]);
}

/** 渲染一次并返回 HTML，随后卸载 */
async function renderModal(): Promise<string> {
  const { container, root } = await mountModal();
  const html = container.innerHTML;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return html;
}

beforeEach(() => {
  for (const k of Object.keys(storageData)) delete storageData[k];
});

afterEach(() => {
  useShippingStore.setState({
    pickList: [],
    pickListShopId: null,
    pickListOwnerUserId: null,
    pickListLoading: false,
    pickListError: null,
    ownerShopId: null,
    ownerUserId: null,
  });
});

describe('R7 排除弹窗：候选列表按完整归属显示', () => {
  it('同店换账号后，旧账号的候选一行都不显示', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 2,
      pickList: [{ itemId: '111', name: '账号 1 的商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 1,
      pickListLoading: false,
      pickListError: null,
    });
    const html = await renderModal();
    expect(renderedItemIds(html), '旧账号商品不得显示').toEqual([]);
  });

  it('店铺与账号都一致时正常显示候选（正向对照）', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 2,
      pickList: [{ itemId: '222', name: '账号 2 的商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 2,
      pickListLoading: false,
      pickListError: null,
    });
    const html = await renderModal();
    expect(renderedItemIds(html)).toEqual(['222']);
    expect(html).not.toMatch(/已暂停显示/);
  });

  it('跨店的候选项同样不显示', async () => {
    useShippingStore.setState({
      ownerShopId: 202,
      ownerUserId: 2,
      pickList: [{ itemId: '111', name: 'A 店商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 2,
      pickListLoading: false,
      pickListError: null,
    });
    expect(renderedItemIds(await renderModal())).toEqual([]);
  });

  it('账号未核实时不显示候选', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: null,
      pickList: [{ itemId: '111', name: '不明归属', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 1,
      pickListLoading: false,
      pickListError: null,
    });
    expect(renderedItemIds(await renderModal())).toEqual([]);
  });

  it('列表缺账号标记（旧缓存）时不显示候选', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 1,
      pickList: [{ itemId: '111', name: '旧缓存', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: null,
      pickListLoading: false,
      pickListError: null,
    });
    expect(renderedItemIds(await renderModal())).toEqual([]);
  });
});

/**
 * 第 46.2 节 R7：**本地未确认勾选**必须属于它的归属。
 *
 * 为什么单列一组：这是"列表行已隐藏"之外的另一条路径。早先 `picked` 只随
 * `open`／`confirming` 重置，而父组件的 `confirming` 是 `parseExcludeIds(draft.excludeIds)`
 * 的 memo —— 归属变化把草稿清成空串时，若原本也是空串，数组**引用不变**，
 * 重置不触发；列表被隐藏了，本地 111 却还在，点「确认排除」就把它写进了新归属。
 * 验收在**真实父页面**复现过，所以这里也按"实际点击确认按钮"来测，不只看行数。
 */
describe('R7 排除弹窗：未确认的本地勾选不能跨归属提交', () => {
  /** 挂载弹窗，返回容器、确认调用次数与"是否仍挂载" */
  async function mountWithConfirm() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    const confirmed: string[][] = [];
    let mounted = true;
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(ShippingExcludeModal, {
          open: true,
          onClose: () => {},
          confirming: [],
          onConfirm: (ids: string[]) => {
            confirmed.push(ids);
            /**
             * 真实父组件确认后会把 `excludeOpen` 置 false，从而卸载弹窗。
             * 这里如实模拟这一点：**只有真的收到确认**才关闭，
             * 这样"无效点击不得成功关闭弹窗"才能被断言（第 49.3 节）。
             */
            mounted = false;
            void act(async () => {
              root.unmount();
            });
          },
        }),
      );
    });
    return {
      container,
      lastConfirmed: () => (confirmed.length ? confirmed[confirmed.length - 1] : null),
      /** onConfirm 被调用的次数：拒绝必须是 0 次，不能用"不含 111"代替 */
      callCount: () => confirmed.length,
      /** 弹窗是否仍挂载（未因无效确认成功关闭） */
      isMounted: () => mounted,
      close: async () => {
        await act(async () => {
          root.unmount();
        });
        container.remove();
      },
    };
  }

  /** 弹窗底部的「确认排除」按钮 */
  function confirmButton(container: HTMLElement): HTMLButtonElement {
    const buttons = [...container.querySelectorAll('button')];
    return buttons[buttons.length - 1] as HTMLButtonElement;
  }

  it('勾选后同店换账号：确认必须被拒绝，不得把旧 111 写出去', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 1,
      pickList: [{ itemId: '111', name: '账号1商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 1,
      pickListLoading: false,
      pickListError: null,
    });
    const modal = await mountWithConfirm();
    // 勾 111（此时归属 101/1）
    const row = modal.container.querySelector('input[aria-label$="111"]') as HTMLInputElement;
    await act(async () => {
      row.click();
    });
    // 同店换账号：101/1 → 101/2（店铺没变，所以父组件 confirming 内容可能不变）
    await act(async () => {
      useShippingStore.getState().setOwner(101, 2);
    });
    await act(async () => {
      confirmButton(modal.container).click();
    });
    expect(modal.callCount(), '失效后点确认不得调用 onConfirm（更不得提交空集合当成功）').toBe(0);
    expect(modal.container.textContent).toMatch(/已失效/);
    expect(modal.isMounted(), '无效确认不得成功关闭弹窗').toBe(true);
    await modal.close();
  });

  it('勾选后跨店：确认同样必须被拒绝（零调用）', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 1,
      pickList: [{ itemId: '111', name: 'A店商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 1,
      pickListLoading: false,
      pickListError: null,
    });
    const modal = await mountWithConfirm();
    const row = modal.container.querySelector('input[aria-label$="111"]') as HTMLInputElement;
    await act(async () => {
      row.click();
    });
    await act(async () => {
      useShippingStore.getState().setOwner(202, 1);
    });
    await act(async () => {
      confirmButton(modal.container).click();
    });
    expect(modal.callCount()).toBe(0);
    expect(modal.isMounted()).toBe(true);
    await modal.close();
  });

  it('原本不排除商品的空集合可正常确认（正向对照：不误挡）', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 2,
      pickList: [{ itemId: '222', name: '账号2商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 2,
      pickListLoading: false,
      pickListError: null,
    });
    const modal = await mountWithConfirm();
    await act(async () => {
      confirmButton(modal.container).click();
    });
    expect(modal.lastConfirmed(), '从未失效的空集合应可确认').toEqual([]);
    expect(modal.container.textContent).not.toMatch(/已失效/);
    await modal.close();
  });

  it('失效后用户主动点「清空选择」→ 视为在当前归属明确选择空集合，可确认', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 1,
      pickList: [{ itemId: '111', name: '账号1商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 1,
      pickListLoading: false,
      pickListError: null,
    });
    const modal = await mountWithConfirm();
    const row = modal.container.querySelector('input[aria-label$="111"]') as HTMLInputElement;
    await act(async () => {
      row.click();
    });
    await act(async () => {
      useShippingStore.getState().setOwner(101, 2);
    });
    expect(modal.container.textContent).toMatch(/已失效/);
    // 用户在当前归属下明确选择"不排除任何商品"
    const clearBtn = [...modal.container.querySelectorAll('button')].find(b =>
      b.textContent?.includes('清空选择'),
    ) as HTMLButtonElement;
    await act(async () => {
      clearBtn.click();
    });
    await act(async () => {
      confirmButton(modal.container).click();
    });
    expect(modal.lastConfirmed(), '明确清空后应可确认空集合').toEqual([]);
    expect(modal.isMounted()).toBe(false);
    await modal.close();
  });

  it('归属变化会清空本地勾选，用户能看到已失效提示', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 1,
      pickList: [{ itemId: '111', name: '账号1商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 1,
      pickListLoading: false,
      pickListError: null,
    });
    const modal = await mountWithConfirm();
    const row = modal.container.querySelector('input[aria-label$="111"]') as HTMLInputElement;
    await act(async () => {
      row.click();
    });
    expect(modal.container.textContent).toMatch(/已勾选 1 个/);
    await act(async () => {
      useShippingStore.getState().setOwner(101, 2);
    });
    expect(modal.container.textContent, '勾选应被清空').toMatch(/已勾选 0 个/);
    expect(modal.container.textContent).toMatch(/已失效/);
    await modal.close();
  });

  it('不切归属时勾选与确认照常（正向对照）', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 2,
      pickList: [{ itemId: '222', name: '账号2商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 2,
      pickListLoading: false,
      pickListError: null,
    });
    const modal = await mountWithConfirm();
    const row = modal.container.querySelector('input[aria-label$="222"]') as HTMLInputElement;
    await act(async () => {
      row.click();
    });
    await act(async () => {
      confirmButton(modal.container).click();
    });
    expect(modal.lastConfirmed()).toEqual(['222']);
    expect(modal.container.textContent).not.toMatch(/已失效/);
    await modal.close();
  });

  it('候选不可点（归属未核实）时，父组件带入的已确认集合仍可确认（正向对照）', async () => {
    /**
     * 布置：归属还没核实出来，但父组件已经带入一份"已确认集合"（例如打开前就设过排除）。
     * 此时候选行不可点，`picked` 只可能来自父组件 —— 它不属于任何"本地勾选"，
     * 不能因为"归属未核实"就被判为失效（否则正常操作会被误挡）。
     */
    useShippingStore.setState({
      ownerShopId: null,
      ownerUserId: null,
      pickList: [],
      pickListShopId: null,
      pickListOwnerUserId: null,
      pickListLoading: false,
      pickListError: null,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    const confirmed: string[][] = [];
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(ShippingExcludeModal, {
          open: true,
          onClose: () => {},
          confirming: ['999'],
          onConfirm: ids => confirmed.push(ids),
        }),
      );
    });
    expect(container.textContent).toMatch(/已勾选 1 个/);
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => {
      (buttons[buttons.length - 1] as HTMLButtonElement).click();
    });
    expect(confirmed, '未绑定的已确认集合应可原样确认').toEqual([['999']]);
    expect(container.textContent).not.toMatch(/已失效/);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('取消勾选不会把整份选择重新绑定到已变化的归属', async () => {
    /**
     * 布置：先勾两个（绑定归属 101/1），换账号后清空；切回 101/1 再勾一个（重新绑定 101/1）。
     * 这里真正要测的是反选分支：**取消**一个商品不应改变归属绑定，
     * 因此剩下的勾选仍属 101/1，仍可确认。
     */
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 1,
      pickList: [
        { itemId: '111', name: '商品A', sold: 20, status: 1, views: 1 },
        { itemId: '112', name: '商品B', sold: 10, status: 1, views: 1 },
      ],
      pickListShopId: 101,
      pickListOwnerUserId: 1,
      pickListLoading: false,
      pickListError: null,
    });
    const modal = await mountWithConfirm();
    const a = modal.container.querySelector('input[aria-label$="111"]') as HTMLInputElement;
    const b = modal.container.querySelector('input[aria-label$="112"]') as HTMLInputElement;
    await act(async () => {
      a.click();
    });
    await act(async () => {
      b.click();
    });
    expect(modal.container.textContent).toMatch(/已勾选 2 个/);
    // 取消其中一个（走反选分支，不重新绑定归属）
    await act(async () => {
      b.click();
    });
    expect(modal.container.textContent).toMatch(/已勾选 1 个/);
    await act(async () => {
      confirmButton(modal.container).click();
    });
    expect(modal.lastConfirmed()).toEqual(['111']);
    expect(modal.container.textContent).not.toMatch(/已失效/);
    await modal.close();
  });

  it('勾选后新归属重新选品并确认，写出的是新归属的商品（正向对照）', async () => {
    useShippingStore.setState({
      ownerShopId: 101,
      ownerUserId: 1,
      pickList: [{ itemId: '111', name: '账号1商品', sold: 10, status: 1, views: 1 }],
      pickListShopId: 101,
      pickListOwnerUserId: 1,
      pickListLoading: false,
      pickListError: null,
    });
    const modal = await mountWithConfirm();
    const oldRow = modal.container.querySelector('input[aria-label$="111"]') as HTMLInputElement;
    await act(async () => {
      oldRow.click();
    });
    // 换账号并加载新归属的候选
    await act(async () => {
      useShippingStore.setState({
        ownerShopId: 101,
        ownerUserId: 2,
        pickList: [{ itemId: '222', name: '账号2商品', sold: 10, status: 1, views: 1 }],
        pickListShopId: 101,
        pickListOwnerUserId: 2,
        pickListLoading: false,
        pickListError: null,
      });
    });
    const newRow = modal.container.querySelector('input[aria-label$="222"]') as HTMLInputElement;
    expect(newRow, '新归属的候选应可勾选').toBeTruthy();
    await act(async () => {
      newRow.click();
    });
    await act(async () => {
      confirmButton(modal.container).click();
    });
    expect(modal.lastConfirmed()).toEqual(['222']);
    await modal.close();
  });
});
