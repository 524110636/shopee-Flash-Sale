import React, { useState } from 'react';
import { ProductCard } from './ProductCard';
import { SkuTable } from './SkuTable';
import type { ShopeeProduct } from '@/entrypoints/popup/types';

interface ProductListProps {
  products: ShopeeProduct[];
  oneDaySkuSelectedIds?: string[];
  onToggleOneDaySku?: (itemId: string) => void;
  onSelectAllOneDaySku?: (itemIds: string[]) => void;
}

export function ProductList({ products, oneDaySkuSelectedIds = [], onToggleOneDaySku, onSelectAllOneDaySku }: ProductListProps) {
  const [selectedProduct, setSelectedProduct] = useState<ShopeeProduct | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filtered = searchQuery.trim()
    ? products.filter(
        (p) => p.itemid.includes(searchQuery.trim()) || p.name.toLowerCase().includes(searchQuery.trim().toLowerCase())
      )
    : products;

  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <h3 className='text-sm font-medium'>
          商品列表（{filtered.length}/{products.length}）
        </h3>
        {onToggleOneDaySku && onSelectAllOneDaySku && (
          <button
            type='button'
            className='h-6 px-2 text-[10px] border rounded text-muted-foreground hover:text-shopee-brand hover:border-shopee-brand/40'
            onClick={() => {
              const filteredIds = filtered.map(product => product.itemid);
              const allSelected = filteredIds.length > 0 && filteredIds.every(id => oneDaySkuSelectedIds.includes(id));
              onSelectAllOneDaySku(allSelected
                ? oneDaySkuSelectedIds.filter(id => !filteredIds.includes(id))
                : Array.from(new Set([...oneDaySkuSelectedIds, ...filteredIds]))
              );
            }}
          >
            {filtered.length > 0 && filtered.every(product => oneDaySkuSelectedIds.includes(product.itemid)) ? '取消全选' : '全选修复'}
          </button>
        )}
        <div className='flex-1' />
        <input
          type='text'
          placeholder='搜索 ID 或名称...'
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className='w-36 px-2 py-1 text-xs border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary'
        />
      </div>
      <div className='space-y-2'>
        {filtered.map((product) => (
          <ProductCard
            key={product.itemid}
            product={product}
            onViewSkus={setSelectedProduct}
            selectedForOneDaySku={oneDaySkuSelectedIds.includes(product.itemid)}
            onToggleOneDaySku={onToggleOneDaySku}
          />
        ))}
      </div>
      {filtered.length === 0 && <p className='text-xs text-muted-foreground text-center py-4'>无匹配商品</p>}

      {/* SKU 弹窗 */}
      {selectedProduct && (
        <SkuTable key={selectedProduct.itemid} product={selectedProduct} onClose={() => setSelectedProduct(null)} />
      )}
    </div>
  );
}
