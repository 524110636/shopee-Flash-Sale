import React, { useState } from 'react';
import { ProductCard } from './ProductCard';
import { SkuTable } from './SkuTable';
import type { ShopeeProduct } from '@/entrypoints/popup/types';

interface ProductListProps {
  products: ShopeeProduct[];
}

export function ProductList({ products }: ProductListProps) {
  const [selectedProduct, setSelectedProduct] = useState<ShopeeProduct | null>(null);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">商品列表（{products.length}）</h3>
      <div className="space-y-2">
        {products.map((product) => (
          <ProductCard
            key={product.itemid}
            product={product}
            onViewSkus={setSelectedProduct}
          />
        ))}
      </div>

      {/* SKU 弹窗 */}
      {selectedProduct && (
        <SkuTable
          models={selectedProduct.modelList}
          productName={selectedProduct.name}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}
