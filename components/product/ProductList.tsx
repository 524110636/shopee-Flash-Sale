import React, { useState } from 'react';
import { ProductCard } from './ProductCard';
import { SkuTable } from './SkuTable';
import type { ShopeeProduct } from '@/entrypoints/popup/types';

interface ProductListProps {
  products: ShopeeProduct[];
}

export function ProductList({ products }: ProductListProps) {
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
          <ProductCard key={product.itemid} product={product} onViewSkus={setSelectedProduct} />
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
