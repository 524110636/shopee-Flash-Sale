import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAppStore } from '@/entrypoints/popup/store';
import type { ShopeeProduct } from '@/entrypoints/popup/types';

interface ProductCardProps {
  product: ShopeeProduct;
  onViewSkus: (product: ShopeeProduct) => void;
  selectedForOneDaySku?: boolean;
  onToggleOneDaySku?: (itemId: string) => void;
}

export function ProductCard({ product, onViewSkus, selectedForOneDaySku = false, onToggleOneDaySku }: ProductCardProps) {
  const skuOverrides = useAppStore((s) => s.skuOverrides);
  const hasOverrides = product.modelList.some((m) => `${product.itemid}-${m.modelid}` in skuOverrides);

  const formatPrice = (price: string) => {
    const num = parseInt(price);
    return isNaN(num) ? price : `NT$${num.toLocaleString()}`;
  };

  return (
    <Card
      className={`hover:bg-accent/50 transition-colors cursor-pointer ${hasOverrides ? 'border-l-4 border-l-shopee-brand' : ''}`}
      onClick={() => onViewSkus(product)}
    >
      <CardContent className='p-3'>
        <div className='flex items-start gap-3'>
          {onToggleOneDaySku && (
            <input
              type='checkbox'
              checked={selectedForOneDaySku}
              onChange={(e) => {
                e.stopPropagation();
                onToggleOneDaySku(product.itemid);
              }}
              onClick={(e) => e.stopPropagation()}
              className='mt-5 h-4 w-4 shrink-0 cursor-pointer accent-shopee-brand'
              aria-label={`选择 ${product.name} 进行 1 天备货 SKU 修复`}
            />
          )}

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
                <Badge variant='outline' className='text-[10px] text-shopee-brand border-shopee-brand/30 bg-shopee-brand-light'>
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
