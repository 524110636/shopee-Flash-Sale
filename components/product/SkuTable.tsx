import React, { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAppStore } from '@/entrypoints/popup/store';
import type { ShopeeProduct } from '@/entrypoints/popup/types';

interface SkuTableProps {
  product: ShopeeProduct;
  onClose: () => void;
}

export function SkuTable({ product, onClose }: SkuTableProps) {
  const { skuOverrides, setSkuOverride, discountRate: globalDiscount, flashSaleStock: globalStock, purchaseLimit: globalPurchaseLimit } = useAppStore();
  const [priceEditValues, setPriceEditValues] = useState<Record<string, string>>({});

  const formatPrice = (price: string) => {
    const num = parseInt(price);
    return isNaN(num) ? price : `NT$${num.toLocaleString()}`;
  };

  const calcPromoPrice = (originPrice: string, overrideDiscount?: number) => {
    const rate = overrideDiscount ?? globalDiscount;
    return Math.floor(Number(originPrice || 0) * rate / 100);
  };

  // 计算商品级汇总
  const totalStock = product.modelList.reduce((sum, m) => sum + (m.totalNormalStock || 0), 0);
  const totalSkuOverrideStock = product.modelList.reduce((sum, m) => {
    const key = `${product.itemid}-${m.modelid}`;
    const ov = skuOverrides[key];
    return sum + (ov?.stock ?? globalStock);
  }, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-[680px] max-w-[95vw] flex flex-col max-h-[85vh]">
        {/* 头部：商品图片 + 摘要信息 */}
        <div className="flex items-start gap-4 p-4 border-b shrink-0">
          {/* 商品图片 */}
          <div className="w-20 h-20 rounded-lg overflow-hidden bg-muted flex-shrink-0 border">
            {product.images[0] ? (
              <img
                src={`https://cf.shopee.tw/file/${product.images[0]}_tn`}
                alt={product.name}
                className="w-full h-full object-cover"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">无图</div>
            )}
          </div>

          {/* 商品信息 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-sm font-medium truncate">{product.name}</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">ID: {product.itemid}</p>
              </div>
              <button
                className="text-lg leading-none text-muted-foreground hover:text-foreground shrink-0 ml-2"
                onClick={onClose}
              >
                ×
              </button>
            </div>

            {/* 价格摘要 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs">
              <span className="text-muted-foreground">
                原价: <span className="text-foreground">{formatPrice(product.inputOriginPrice)}</span>
              </span>
              <span className="text-muted-foreground">
                折扣: <span className="text-foreground font-medium">{globalDiscount}%</span>
              </span>
              <span className="text-orange-600 font-medium">
                限时价: {formatPrice(String(calcPromoPrice(product.inputOriginPrice)))}
              </span>
              <span className="text-muted-foreground">
                商品库存: <span className="text-foreground">{totalStock}</span>
              </span>
              <span className="text-muted-foreground">
                活动库存: <span className={`font-medium ${totalSkuOverrideStock > 0 ? 'text-green-600' : 'text-muted-foreground'}`}>{totalSkuOverrideStock}</span>
              </span>
            </div>
          </div>
        </div>

        {/* SKU 列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs w-[18%]">规格</TableHead>
                <TableHead className="text-xs w-[10%]">原价</TableHead>
                <TableHead className="text-xs w-[8%]">库存</TableHead>
                <TableHead className="text-xs w-[14%]">折扣%</TableHead>
                <TableHead className="text-xs w-[14%]">活动库存</TableHead>
                <TableHead className="text-xs w-[16%]">限时价</TableHead>
                <TableHead className="text-xs w-[20%]">限购数量</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {product.modelList.map((model) => {
                const key = `${product.itemid}-${model.modelid}`;
                const override = skuOverrides[key];
                const discountVal = override?.discountRate?.toString() ?? '';
                const stockVal = override?.stock?.toString() ?? '';
                const purchaseLimitVal = override?.purchaseLimit?.toString() ?? '';
                const promoPrice = calcPromoPrice(model.originPrice, override?.discountRate);

                return (
                  <TableRow key={model.modelid}>
                    <TableCell className="text-xs truncate max-w-[120px]" title={model.name}>
                      {model.name}
                    </TableCell>
                    <TableCell className="text-xs">{formatPrice(model.originPrice)}</TableCell>
                    <TableCell className="text-xs">{model.totalNormalStock}</TableCell>
                    <TableCell className="text-xs p-1">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        placeholder={`${globalDiscount}`}
                        value={discountVal}
                        onChange={e => {
                          const v = e.target.value;
                          if (v === '') {
                            setSkuOverride(product.itemid, model.modelid, {
                              stock: override?.stock,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          } else {
                            const n = Math.max(1, Math.min(100, Number(v) || 1));
                            setSkuOverride(product.itemid, model.modelid, {
                              discountRate: n,
                              stock: override?.stock,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          }
                        }}
                        className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </TableCell>
                    <TableCell className="text-xs p-1">
                      <input
                        type="number"
                        min={1}
                        placeholder={`${globalStock}`}
                        value={stockVal}
                        onChange={e => {
                          const v = e.target.value;
                          if (v === '') {
                            setSkuOverride(product.itemid, model.modelid, {
                              discountRate: override?.discountRate,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          } else {
                            const n = Math.max(1, Number(v) || 1);
                            setSkuOverride(product.itemid, model.modelid, {
                              stock: n,
                              discountRate: override?.discountRate,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          }
                        }}
                        className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </TableCell>
                    <TableCell className="text-xs p-1">
                      <input
                        type="number"
                        min={1}
                        placeholder={String(calcPromoPrice(model.originPrice))}
                        value={priceEditValues[model.modelid] ?? (promoPrice > 0 ? String(promoPrice) : '')}
                        onChange={e => {
                          setPriceEditValues(prev => ({ ...prev, [model.modelid]: e.target.value }));
                        }}
                        onBlur={e => {
                          const v = e.target.value;
                          setPriceEditValues(prev => {
                            const { [model.modelid]: _, ...rest } = prev;
                            return rest;
                          });
                          if (v === '') {
                            setSkuOverride(product.itemid, model.modelid, {
                              stock: override?.stock,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          } else {
                            const origin = Number(model.originPrice || 0);
                            const price = Math.max(1, Number(v) || 1);
                            const rate = origin > 0 ? Math.max(1, Math.min(100, Math.round(price / origin * 100))) : globalDiscount;
                            setSkuOverride(product.itemid, model.modelid, {
                              discountRate: rate,
                              stock: override?.stock,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          }
                        }}
                        className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </TableCell>
                    <TableCell className="text-xs p-1">
                      <input
                        type="number"
                        min={0}
                        placeholder={`${globalPurchaseLimit}`}
                        value={purchaseLimitVal}
                        onChange={e => {
                          const v = e.target.value;
                          if (v === '') {
                            setSkuOverride(product.itemid, model.modelid, {
                              discountRate: override?.discountRate,
                              stock: override?.stock,
                            });
                          } else {
                            const n = Math.max(0, Number(v) || 0);
                            setSkuOverride(product.itemid, model.modelid, {
                              purchaseLimit: n,
                              discountRate: override?.discountRate,
                              stock: override?.stock,
                            });
                          }
                        }}
                        className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* 底部统计 */}
        <div className="p-3 border-t text-[10px] text-muted-foreground space-y-0.5 shrink-0">
          <div>共 {product.modelList.length} 个 SKU / 总计原库存 {totalStock} / 活动库存 {totalSkuOverrideStock}</div>
          <div>留空 = 使用全局默认值（折扣 {globalDiscount}% / 库存 {globalStock} / 限购 {globalPurchaseLimit}）</div>
        </div>
      </div>
    </div>
  );
}
