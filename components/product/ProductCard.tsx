import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAppStore } from '@/entrypoints/popup/store';
import type { ShopeeProduct } from '@/entrypoints/popup/types';

interface ProductCardProps {
  product: ShopeeProduct;
  onViewSkus: (product: ShopeeProduct) => void;
}

export function ProductCard({ product, onViewSkus }: ProductCardProps) {
  const skuOverrides = useAppStore((s) => s.skuOverrides);
  const hasOverrides = product.modelList.some((m) => `${product.itemid}-${m.modelid}` in skuOverrides);

  const formatPrice = (price: string) => {
    const num = parseInt(price);
    return isNaN(num) ? price : `NT$${num.toLocaleString()}`;
  };

  return (
    <Card
      className={`hover:bg-accent/50 transition-colors cursor-pointer ${hasOverrides ? 'border-l-4 border-l-blue-500' : ''}`}
      onClick={() => onViewSkus(product)}
    >
      <CardContent className='p-3'>
        <div className='flex items-start gap-3'>
          {/* 商品图片 */}
          <div className='w-16 h-16 rounded-md overflow-hidden bg-muted flex-shrink-0'>
            {product.images[0] ? (
              <img
                src={`https://cf.shopee.tw/file/${product.images[0]}_tn`}
                alt={product.name}
                className='w-full h-full object-cover'
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <div className='w-full h-full flex items-center justify-center text-xs text-muted-foreground'>无图</div>
            )}
          </div>

          {/* 商品信息 */}
          <div className='flex-1 min-w-0'>
            <h4 className='text-sm font-medium truncate'>{product.name}</h4>
            <div className='flex items-center gap-2 mt-1'>
              <span className='text-xs text-muted-foreground'>ID: {product.itemid}</span>
              <Badge variant='secondary' className='text-xs'>
                {product.modelList.length} SKU
              </Badge>
              {hasOverrides && (
                <Badge variant='outline' className='text-[10px] text-blue-600 border-blue-300 bg-blue-50'>
                  已编辑
                </Badge>
              )}
            </div>
            <div className='flex items-center gap-2 mt-1 text-xs text-muted-foreground'>
              <span>价格: {formatPrice(product.inputOriginPrice)}</span>
              <span>库存: {product.normalStock}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
