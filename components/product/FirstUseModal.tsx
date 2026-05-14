import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';

function normalizeImageUrl(img: string): string {
  if (!img) return '';
  if (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('data:')) return img;
  return `https://cf.shopee.tw/file/${img}`;
}

export function FirstUseModal() {
  const {
    firstUse,
    closeFirstUse,
    fetchFirstUseProducts,
    searchFirstUseProducts,
    toggleFirstUseSelection,
    runFirstUseFlow,
  } = useAppStore();

  const [localSearch, setLocalSearch] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (firstUse.open && firstUse.products.length === 0) {
      fetchFirstUseProducts(12);
    }
  }, [firstUse.open, firstUse.products.length, fetchFirstUseProducts]);

  // Debounced remote search
  useEffect(() => {
    const kw = localSearch.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!kw) {
      // Clear search state immediately when search box is empty
      if (firstUse.searchKeyword) {
        useAppStore.setState(state => ({
          firstUse: { ...state.firstUse, searchKeyword: '', searchResults: [] },
        }));
      }
      return;
    }

    debounceRef.current = setTimeout(() => {
      searchFirstUseProducts(kw);
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [localSearch, firstUse.searchKeyword, searchFirstUseProducts]);

  const isSearching = !!firstUse.searchKeyword;
  const displayProducts = isSearching ? firstUse.searchResults : firstUse.products;

  const selectedCount = firstUse.selectedIds.size;

  if (!firstUse.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40"
         onClick={(e) => { if (e.target === e.currentTarget) closeFirstUse(); }}>
      <div className="bg-white rounded-t-xl sm:rounded-xl shadow-xl w-full sm:max-w-md max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">选择要修复的商品</h2>
            <p className="text-[11px] text-muted-foreground">
              {isSearching
                ? `搜索到 ${firstUse.searchResults.length} 个商品`
                : firstUse.fetchedTotal > 0
                  ? `共 ${firstUse.fetchedTotal} 个商品`
                  : '加载中...'}
              {' · '}最多选择 20 个
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={closeFirstUse}>
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </Button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 shrink-0">
          <input
            type="text"
            placeholder="搜索商品名称或 ID（远程搜索全部商品）..."
            value={localSearch}
            onChange={e => setLocalSearch(e.target.value)}
            className="w-full h-8 rounded-md border px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-shopee-brand"
          />
        </div>

        {/* Product List */}
        <div className="flex-1 overflow-y-auto px-2">
          {firstUse.loading && displayProducts.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-5 h-5 border-2 border-shopee-brand border-t-transparent rounded-full" />
              <span className="ml-2 text-xs text-muted-foreground">
                {isSearching ? '正在搜索...' : '正在加载商品...'}
              </span>
            </div>
          ) : displayProducts.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              {localSearch ? '没有匹配的商品' : '没有商品'}
            </div>
          ) : (
            displayProducts.map(p => {
              const isSelected = firstUse.selectedIds.has(p.id);
              const isMaxed = selectedCount >= 20 && !isSelected;
              return (
                <label
                  key={p.id}
                  className={`flex items-center gap-2.5 px-2 py-2 cursor-pointer rounded-md transition-colors
                    ${isSelected ? 'bg-shopee-brand/5' : 'hover:bg-gray-50'}
                    ${isMaxed ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={isMaxed}
                    onChange={() => toggleFirstUseSelection(p.id)}
                    className="w-3.5 h-3.5 shrink-0 accent-shopee-brand"
                  />
                  <img
                    src={normalizeImageUrl(p.coverImage)}
                    alt=""
                    className="w-10 h-10 shrink-0 rounded border object-cover bg-gray-100"
                    onError={e => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-gray-900 truncate">{p.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {p.priceMin > 0 ? `$${p.priceMin.toFixed(0)}` : ''}
                      {p.priceMax > p.priceMin ? ` - $${p.priceMax.toFixed(0)}` : ''}
                      {' · '}{p.modelCount} 规格
                      {p.soldCount > 0 ? ` · 售出 ${p.soldCount}` : ''}
                    </div>
                  </div>
                  {isSelected && (
                    <svg className="w-4 h-4 shrink-0 text-shopee-brand" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
                    </svg>
                  )}
                </label>
              );
            })
          )}

          {/* Load more — only when browsing (not searching) */}
          {firstUse.hasMore && !isSearching && !localSearch.trim() && (
            <div className="py-3 text-center">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-shopee-brand"
                disabled={firstUse.loading}
                onClick={() => fetchFirstUseProducts(12)}
              >
                {firstUse.loading ? '加载中...' : '加载更多'}
              </Button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t shrink-0">
          <div className="text-xs text-muted-foreground">
            已选 <span className="font-semibold text-shopee-brand">{selectedCount}</span>/20
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={closeFirstUse}>
              取消
            </Button>
            <Button
              size="sm"
              className="h-8 text-xs bg-shopee-brand hover:bg-shopee-brand/90"
              disabled={selectedCount === 0}
              onClick={() => runFirstUseFlow()}
            >
              开始修复 ({selectedCount})
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
