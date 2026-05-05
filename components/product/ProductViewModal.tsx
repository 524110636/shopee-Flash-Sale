import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SkuTable } from '@/components/product/SkuTable';
import { useAppStore } from '@/entrypoints/popup/store';
import type { FlashSale, ShopeeProduct } from '@/entrypoints/popup/types';

interface ProductViewModalProps {
  sale: FlashSale;
  onClose: () => void;
}

export function ProductViewModal({ sale, onClose }: ProductViewModalProps) {
  const { loadFlashSaleProducts, products, isLoadingFlashSales } = useAppStore();
  const [editingProduct, setEditingProduct] = useState<ShopeeProduct | null>(null);

  useEffect(() => {
    loadFlashSaleProducts(sale.flash_sale_id);
  }, [sale.flash_sale_id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-[500px] max-w-[95vw] flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between gap-3 p-4 border-b shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-medium truncate">
              {sale.name || `活动 #${sale.flash_sale_id}`}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">商品列表</p>
          </div>
          <button
            className="text-lg leading-none text-muted-foreground hover:text-foreground shrink-0"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4">
          {isLoadingFlashSales ? (
            <div className="text-xs text-muted-foreground text-center py-8">加载中...</div>
          ) : products.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-8">该活动无商品数据</div>
          ) : (
            <div className="space-y-2">
              {products.map(product => (
                <div
                  key={product.itemid}
                  className="flex items-center justify-between px-3 py-2 text-xs border rounded-md hover:bg-accent/30 cursor-pointer transition-colors"
                  onClick={() => setEditingProduct(product)}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {product.images?.[0] ? (
                      <img
                        src={`https://cf.shopee.tw/file/${product.images[0]}_tn`}
                        alt=""
                        className="w-10 h-10 rounded object-cover shrink-0 bg-muted"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-10 h-10 rounded bg-muted shrink-0 flex items-center justify-center text-[10px] text-muted-foreground">无图</div>
                    )}
                    <div className="min-w-0">
                      <div className="font-medium truncate max-w-[280px]">{product.name}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        ID: {product.itemid} · {product.modelList?.length || 0} 个 SKU · 原价 ${product.inputOriginPrice ? parseInt(product.inputOriginPrice).toLocaleString() : '-'}
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs font-normal shrink-0 ml-2"
                    onClick={e => { e.stopPropagation(); setEditingProduct(product); }}
                  >
                    查看 SKU
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {products.length > 0 && !isLoadingFlashSales && (
          <div className="p-3 border-t text-[10px] text-muted-foreground shrink-0">
            共 {products.length} 个商品 · 点击商品或「查看 SKU」可编辑价格和库存
          </div>
        )}
      </div>

      {editingProduct && (
        <SkuTable product={editingProduct} onClose={() => setEditingProduct(null)} />
      )}
    </div>
  );
}
