import React, { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAppStore } from '@/entrypoints/popup/store';
import type { ShopeeModel } from '@/entrypoints/popup/types';

interface SkuTableProps {
  itemId: string;
  models: ShopeeModel[];
  productName: string;
  onClose: () => void;
}

export function SkuTable({ itemId, models, productName, onClose }: SkuTableProps) {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-[640px] max-w-[95vw] flex flex-col max-h-[80vh]">
        {/* 头部 */}
        <div className="flex items-center justify-between p-3 border-b shrink-0">
          <h3 className="text-sm font-medium truncate flex-1">{productName}</h3>
          <button
            className="ml-2 text-lg leading-none text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* SKU 列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs w-[20%]">规格</TableHead>
                <TableHead className="text-xs w-[10%]">原价</TableHead>
                <TableHead className="text-xs w-[8%]">库存</TableHead>
                <TableHead className="text-xs w-[14%]">折扣%</TableHead>
                <TableHead className="text-xs w-[14%]">活动库存</TableHead>
                <TableHead className="text-xs w-[14%]">限时价</TableHead>
                <TableHead className="text-xs w-[20%]">限购数量</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => {
                const key = `${itemId}-${model.modelid}`;
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
                            setSkuOverride(itemId, model.modelid, {
                              stock: override?.stock,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          } else {
                            const n = Math.max(1, Math.min(100, Number(v) || 1));
                            setSkuOverride(itemId, model.modelid, {
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
                            setSkuOverride(itemId, model.modelid, {
                              discountRate: override?.discountRate,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          } else {
                            const n = Math.max(1, Number(v) || 1);
                            setSkuOverride(itemId, model.modelid, {
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
                            setSkuOverride(itemId, model.modelid, {
                              stock: override?.stock,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          } else {
                            const origin = Number(model.originPrice || 0);
                            const price = Math.max(1, Number(v) || 1);
                            const rate = origin > 0 ? Math.max(1, Math.min(100, Math.round(price / origin * 100))) : globalDiscount;
                            setSkuOverride(itemId, model.modelid, {
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
                            setSkuOverride(itemId, model.modelid, {
                              discountRate: override?.discountRate,
                              stock: override?.stock,
                            });
                          } else {
                            const n = Math.max(0, Number(v) || 0);
                            setSkuOverride(itemId, model.modelid, {
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

        {/* 底部统计 + 提示 */}
        <div className="p-3 border-t text-[10px] text-muted-foreground space-y-0.5 shrink-0">
          <div>共 {models.length} 个 SKU</div>
          <div>留空 = 使用全局默认值（折扣 {globalDiscount}% / 库存 {globalStock} / 限购 {globalPurchaseLimit}）</div>
        </div>
      </div>
    </div>
  );
}
