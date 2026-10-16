/**
 * 「设定排除商品」二级弹窗（任务书第 31 节 31.4）。
 *
 * 为什么不把列表铺在一级页面：一级页面要留给三步主流程，商品列表会把它挤满，
 * 用户也分不清"哪些是这次要排除的"。因此一级只留一个按钮 + 已排除数量。
 *
 * 为什么草稿在本地而不是直接改配置：31.4 明确要求"取消、关闭、Escape 不提交，
 * 确认才落入本次配置"。若边勾边写，用户关掉弹窗就会以为自己取消了实际上没有。
 *
 * 排行必须基于**完整店铺列表**：界面可见的只是当前检索结果，
 * 用它算"全店销量前 5"会给出错的商品。排序／取前 N 都在 `rules.ts` 的纯函数里，
 * 这里只负责把结果渲染出来。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoaderCircle, Search, X } from 'lucide-react';
import { useShippingStore } from '@/features/shipping/store';
import {
  addPickedIds,
  isPickListOwnedBy,
  parseExcludeIds,
  searchByItemId,
  sortProductsBySold,
  topSoldItemIds,
} from '@/features/shipping/rules';

/** 弹窗一次最多渲染多少行（完整列表可能上千条，全渲染会卡住弹窗）。 */
const MAX_RENDERED_ROWS = 200;

/** 完整归属的可比较字符串（店铺＋账号；任一未知都算不可比较）。 */
function ownerKey(owner: { shopId: number | null; userId: number | null }): string | null {
  if (owner.shopId === null || owner.userId === null) return null;
  return `${owner.shopId}:${owner.userId}`;
}

export function ShippingExcludeModal({
  open,
  onClose,
  confirming,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  /** 当前已确认的排除集合（打开时据此初始化草稿） */
  confirming: string[];
  /** 确认：只把草稿交给调用方，取消／关闭不会调用它 */
  onConfirm: (ids: string[]) => void;
}) {
  const pickList = useShippingStore(s => s.pickList);
  const pickListLoading = useShippingStore(s => s.pickListLoading);
  const pickListError = useShippingStore(s => s.pickListError);
  const pickListShopId = useShippingStore(s => s.pickListShopId);
  const pickListOwnerUserId = useShippingStore(s => s.pickListOwnerUserId);
  const ownerShopId = useShippingStore(s => s.ownerShopId);
  const ownerUserId = useShippingStore(s => s.ownerUserId);
  const loadPickList = useShippingStore(s => s.loadPickList);
  /**
   * 候选列表是否属于当前**完整**归属（店铺＋账号，第 37.4／43.2 节 R7）。
   *
   * 判据与 store 的返回分支共用同一条纯函数，避免"store 修好了、弹窗还按旧判据
   * 认为可用"。只比店铺时，同一家店换账号后旧账号的候选仍显示为"可信"，
   * 用户就能把它确认进新账号的安排里（验收在真实 store 上复现）。
   */
  const pickListTrusted = isPickListOwnedBy(
    { shopId: pickListShopId, userId: pickListOwnerUserId },
    { shopId: ownerShopId, userId: ownerUserId },
  );

  /**
   * 弹窗**本地未确认勾选**所依据的完整归属（第 46.2／49.2 节 R7）。
   *
   * 为什么本地草稿也必须带归属：早先 `picked` 只随 `open`／`confirming` 重置，
   * 而父组件的 `confirming` 是 `parseExcludeIds(draft.excludeIds)` 的 memo ——
   * 归属变化把草稿清成 `''` 时，若原本也是 `''`，这个数组**引用不变**，
   * 上面的重置 effect 就不会触发。于是列表行已消失、本地 111 还在，
   * 点「确认排除」就把旧归属的选择写进了新归属的安排（验收在真实父页面复现）。
   *
   * `draftInvalidated` 是**独立的失效状态**（第 49.2 节）：清空 `picked` 之后
   * 「有没有东西」已经不再是判据 —— 早先就是因此放行了"提交空集合当成功"，
   * 把本次安排悄悄变成"不排除任何商品"。所以失效这件事必须自己记一笔，
   * 直到用户在当前归属下**重新操作**（重新勾选，或主动点「清空选择」）才解除。
   *
   * 判据（确认那一刻）：
   * - `draftInvalidated` 为真 → 拒绝，不调用 `onConfirm`，弹窗保持打开、提示仍明确；
   * - 已绑定归属的勾选与当前归属不一致 → 拒绝（防"换归属与点确认落在同一批渲染"的竞态）；
   * - 其余情况一律放行 —— 包括"从来没失效过、本来就不排除商品"的空集合。
   */
  const currentOwner = { shopId: ownerShopId, userId: ownerUserId };
  const currentOwnerKey = ownerKey(currentOwner);
  const [draftOwnerKey, setDraftOwnerKey] = useState<string | null>(null);
  const [draftInvalidated, setDraftInvalidated] = useState(false);
  const [draftNotice, setDraftNotice] = useState<string | null>(null);

  const [keyword, setKeyword] = useState('');
  const [picked, setPicked] = useState<string[]>(confirming);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  /** 已确认集合的内容指纹：内容没变就不重置本地草稿（避免父组件重渲染抹掉正在勾的选择） */
  const confirmingKey = confirming.join('\n');

  // 每次打开都以**已确认的集合**重新初始化草稿：上次取消的勾选不该留下来
  useEffect(() => {
    if (!open) return;
    setPicked(confirming);
    setKeyword('');
    // 打开时草稿归属就是当前归属；之后的任何归属变化都会让它失效
    setDraftOwnerKey(currentOwnerKey);
    setDraftInvalidated(false);
    setDraftNotice(null);
    // 只在打开或"已确认内容"真正变化时重置；不依赖数组引用，避免归属变化时漏重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, confirmingKey]);

  /**
   * 归属变化 → 本地草稿立即失效（第 46.2／49.2 节 R7）。
   *
   * 清空勾选、**记下独立的失效状态**、给出可读提示，要求用户在当前归属下重新选择。
   * 只清空是不够的：清空之后"没有勾选"看起来和"本来就不排除商品"一模一样，
   * 确认入口就会把它当成功提交（验收复现）。
   *
   * 为什么排除 `draftOwnerKey === null`：那表示这份草稿从未绑定过归属
   * （打开时归属还没核实出来，或刚刚已被清掉）。前者时候选行点不到、无勾选可失去；
   * 后者已由 `draftInvalidated` 表达，不需要重复判定。
   */
  useEffect(() => {
    if (!open) return;
    if (draftOwnerKey === null || draftOwnerKey === currentOwnerKey) return;
    setPicked([]);
    setDraftOwnerKey(null);
    setDraftInvalidated(true);
    setDraftNotice(
      '已切换店铺／账号，之前的勾选已失效并清空，请按当前店铺重新选择后再确认',
    );
  }, [open, draftOwnerKey, currentOwnerKey]);

  useEffect(() => {
    if (!open) return;
    /**
     * 打开时若候选列表**不属于当前店铺／账号**，先清掉再重新拉（第 37.4／43.2 节 R7）。
     *
     * 为什么不能只看"列表是否为空"：换店或同店换账号后列表可能还有上一份归属的数据，
     * 用户会看到并勾选到不属于当前归属的商品，甚至把旧归属的筛选结果当成当前的。
     * 判据与"可信"完全一致（同一条纯函数），避免两处判据分叉。
     */
    if (!open) return;
    if (!pickListTrusted && !pickListLoading) {
      void loadPickList();
      return;
    }
    if (pickList.length === 0 && !pickListLoading) void loadPickList();
    // 只在打开时判定一次，避免每次输入都触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape 关闭（不提交）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const pickedSet = useMemo(() => new Set(picked), [picked]);
  // 归属不可信时不用这份候选：宁可显示"请刷新"，也不让用户勾选到别家店的商品（R7）
  const usableList = useMemo(() => (pickListTrusted ? pickList : []), [pickListTrusted, pickList]);
  const ranked = useMemo(() => sortProductsBySold(usableList), [usableList]);
  const results = useMemo(() => searchByItemId(ranked, keyword), [ranked, keyword]);
  const visible = results.slice(0, MAX_RENDERED_ROWS);
  const knownSoldCount = useMemo(
    () => usableList.filter(p => typeof p.sold === 'number' && Number.isFinite(p.sold)).length,
    [usableList],
  );

  if (!open) return null;

  const toggle = (itemId: string, on: boolean) => {
    // 勾选属于"形成它的那一刻"的归属；取消勾选不改归属绑定（见 unpick）
    if (on) {
      setDraftOwnerKey(currentOwnerKey);
      markDraftValid();
    }
    setPicked(prev => (on ? addPickedIds(prev, [itemId]) : prev.filter(id => id !== itemId)));
  };
  /** 快捷勾选：基于完整列表的销量前 N，追加且去重（不替换已有选择） */
  const pickTop = (n: number) => {
    appendPicked(topSoldItemIds(usableList, n));
  };

  /**
   * 用户在当前归属下**重新操作**了这份草稿 → 解除失效状态（第 49.2 节）。
   * 这是"失效"的唯一出口，所以所有主动操作都要走它。
   */
  const markDraftValid = () => {
    setDraftInvalidated(false);
    setDraftNotice(null);
  };

  /**
   * 所有"新增勾选"入口统一走这里，避免漏绑归属。
   * 漏绑的后果是这份选择看上去属于某个归属、实际没有归属依据，确认时无法判定有效性。
   */
  const appendPicked = (ids: string[]) => {
    if (ids.length === 0) return;
    setDraftOwnerKey(currentOwnerKey);
    markDraftValid();
    setPicked(prev => addPickedIds(prev, ids));
  };

  /**
   * 清空勾选。**这是用户的明确新操作**：在当前归属下选择"不排除任何商品"，
   * 因此解除失效状态 —— 否则用户想表达"这次不排除"，却被失效闸门一直挡住（第 49.2 节）。
   */
  const clearPicked = () => {
    setDraftOwnerKey(currentOwnerKey);
    markDraftValid();
    setPicked([]);
  };

  /**
   * 取消勾选（单个或"全选当前结果"的反选）。
   *
   * 取消**不会**产生"跨归属的旧选择"，因此不改归属绑定：
   * 若此前已绑定当前归属，保持绑定（列表刷新后剩下的勾选仍然有效）；
   * 若此前未绑定（例如勾选来自父组件带入的已确认集合），仍保持未绑定。
   * 这样避免"取消一个商品"反而把整份选择重新绑定到刚变化的归属上。
   */
  const unpick = (ids: string[]) => {
    const drop = new Set(ids);
    setPicked(prev => prev.filter(id => !drop.has(id)));
  };

  const pickedSummary = `${picked.length} 个`;
  const rankNotice =
    keyword.trim().length > 0
      ? `快捷勾选按全店销量排名（与当前检索无关）；已知销量 ${knownSoldCount} 个，销量未知的不参与。`
      : `快捷勾选按全店销量排名；已知销量 ${knownSoldCount} 个，销量未知的不参与。`;

  /**
   * 确认排除（第 46.2／49.2 节 R7）。
   *
   * 两道闸门，都必须在**提交那一刻**判定：
   * 1. `draftInvalidated` —— 本次草稿因归属变化被判失效，用户还没在当前归属重新操作。
   *    此时**拒绝提交**，不调用 `onConfirm`、不关窗、提示保持。
   *    不能因为"勾选已被清空"就放行：那会把"原本要排除商品"变成"不排除任何商品"，
   *    而且是在用户没做任何决定的情况下悄悄改掉安排（验收复现）。
   * 2. 已绑定归属的勾选与当前归属不符 —— 防"换归属与点确认落在同一批渲染"的竞态。
   *
   * 反过来，"从来没失效过、本来就不排除商品"的空集合必须照常可确认；
   * 失效后用户主动点了「清空选择」，也视为在当前归属下明确选择空集合（`clearPicked` 会解除失效）。
   */
  const confirmPicked = () => {
    if (draftInvalidated) {
      setDraftNotice(
        '本次勾选已失效（店铺／账号已切换），请按当前店铺重新选择；如确认本次不排除任何商品，请点「清空选择」',
      );
      return;
    }
    if (draftOwnerKey !== null && draftOwnerKey !== currentOwnerKey) {
      setPicked([]);
      setDraftOwnerKey(null);
      setDraftInvalidated(true);
      setDraftNotice(
        '已切换店铺／账号，之前的勾选已失效，请按当前店铺重新选择；如确认本次不排除任何商品，请点「清空选择」',
      );
      return;
    }
    onConfirm(picked);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3"
      role="presentation"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="设定排除商品"
        className="flex max-h-[85vh] w-full max-w-[420px] min-w-0 flex-col overflow-hidden rounded-lg border bg-background shadow-lg"
      >
        <div className="flex items-start justify-between gap-2 border-b px-3 py-2">
          <div>
            <h3 className="text-sm font-medium">设定排除商品</h3>
            <p className="text-[11px] text-muted-foreground">
              勾选后不参与本次两次修改，可多选。两阶段使用同一份排除集合。
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0"
            aria-label="关闭排除商品弹窗"
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>

        <div className="space-y-1.5 border-b px-3 py-2">
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                placeholder="输入商品 ID 检索"
                aria-label="按商品 ID 检索"
                className="h-7 pl-7 text-[11px]"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 text-[11px]"
              onClick={() => setKeyword('')}
              disabled={!keyword}
            >
              清除检索
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => pickTop(5)}>
              勾选销量前5
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => pickTop(10)}>
              勾选销量前10
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => appendPicked(results.map(p => p.itemId))}
              disabled={results.length === 0}
            >
              勾选当前结果
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={clearPicked}
            >
              清空选择
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => void loadPickList()}
              disabled={pickListLoading}
            >
              {pickListLoading ? '读取中…' : '刷新列表'}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">{rankNotice}</p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {pickListError && (
            <p className="text-[11px] text-destructive break-all">
              读取商品列表失败：{pickListError}
              <span className="block text-muted-foreground">
                已保留原有排除选择，不会被空列表覆盖。
              </span>
            </p>
          )}
          {!pickListTrusted && !pickListLoading && (
            <p className="text-[11px] text-amber-800">
              当前店铺／账号还没核实，或这份列表属于切换前的店铺／账号，已暂停显示。
              请点「刷新列表」按当前店铺重新读取。
            </p>
          )}
          {draftNotice && (
            <p className="mb-1 text-[11px] text-amber-800" role="status">
              {draftNotice}
            </p>
          )}
          {pickListTrusted && pickListLoading && usableList.length === 0 && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              正在读取商品列表…
            </p>
          )}
          {pickListTrusted && !pickListLoading && !pickListError && usableList.length === 0 && (
            <p className="text-[11px] text-muted-foreground">点「刷新列表」读取店铺商品。</p>
          )}
          {usableList.length > 0 && results.length === 0 && (
            <p className="text-[11px] text-muted-foreground">没有匹配「{keyword}」的商品。</p>
          )}
          {visible.length > 0 && (
            <>
              <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={visible.length > 0 && visible.every(p => pickedSet.has(p.itemId))}
                    onChange={e =>
                      e.target.checked
                        ? appendPicked(results.map(p => p.itemId))
                        : unpick(results.map(p => p.itemId))
                    }
                  />
                  全选当前结果（{results.length} 个）
                </label>
                <span>
                  共 {results.length} 个
                  {results.length > MAX_RENDERED_ROWS ? `（列表只显示前 ${MAX_RENDERED_ROWS} 个，勾选覆盖全部匹配）` : ''}
                </span>
              </div>
              <ul className="space-y-0.5">
                {visible.map(p => (
                  <li key={p.itemId} className="flex items-center gap-1.5 text-[11px]">
                    <input
                      type="checkbox"
                      checked={pickedSet.has(p.itemId)}
                      onChange={e => toggle(p.itemId, e.target.checked)}
                      aria-label={`排除商品 ${p.itemId}`}
                    />
                    <span className="font-mono">{p.itemId}</span>
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      销量 {p.sold ?? '未知'} ·{p.status === 1 ? '在线' : '下架'}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <span className="text-[11px] text-muted-foreground" aria-live="polite">
            已勾选 <strong>{pickedSummary}</strong>
          </span>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={onClose}>
              取消
            </Button>
            <Button
              size="sm"
              className="h-7 text-[11px]"
              onClick={confirmPicked}
            >
              确认排除
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 供调用方把 ID 数组换算回存储用的换行文本（与 `parseExcludeIds` 互逆）。 */
export function excludeIdsToText(ids: string[]): string {
  return parseExcludeIds(ids.join('\n')).join('\n');
}
