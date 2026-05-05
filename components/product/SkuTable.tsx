import React, { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAppStore } from '@/entrypoints/popup/store';
import type { ShopeeProduct } from '@/entrypoints/popup/types';

interface SkuTableProps {
  product: ShopeeProduct;
  onClose: () => void;
  onEdit?: (itemId: string) => void;
}

export function SkuTable({ product, onClose, onEdit }: SkuTableProps) {
  const { skuOverrides, setSkuOverride, discountRate: globalDiscount, flashSaleStock: globalStock, purchaseLimit: globalPurchaseLimit } = useAppStore();
  const [priceEditValues, setPriceEditValues] = useState<Record<string, string>>({});
  const [batchDiscount, setBatchDiscount] = useState('');
  const [batchStock, setBatchStock] = useState('');
  const [batchPromoPrice, setBatchPromoPrice] = useState('');
  const [batchPurchaseLimit, setBatchPurchaseLimit] = useState('');

  const formatPrice = (price: string) => {
    const num = parseInt(price);
    return isNaN(num) ? price : `NT$${num.toLocaleString()}`;
  };

  const calcPromoPrice = (originPrice: string, override?: { discountRate?: number; promoPrice?: number }) => {
    if (override?.promoPrice !== undefined) return override.promoPrice;
    const rate = override?.discountRate ?? globalDiscount;
    return Math.floor(Number(originPrice || 0) * rate / 100);
  };

  const totalStock = product.modelList.reduce((sum, m) => sum + (m.totalNormalStock || 0), 0);
  const totalSkuOverrideStock = product.modelList.reduce((sum, m) => {
    const key = `${product.itemid}-${m.modelid}`;
    const ov = skuOverrides[key];
    return sum + (ov?.stock ?? globalStock);
  }, 0);

  const applyBatchDiscount = () => {
    const v = batchDiscount.trim();
    if (v === '') return;
    const n = Math.max(1, Math.min(100, Number(v) || 1));
    for (const m of product.modelList) {
      const key = `${product.itemid}-${m.modelid}`;
      const ov = skuOverrides[key];
      setSkuOverride(product.itemid, m.modelid, {
        discountRate: n,
        stock: ov?.stock,
        purchaseLimit: ov?.purchaseLimit,
        promoPrice: undefined,
      });
    }
    setBatchDiscount('');
    onEdit?.(product.itemid);
  };

  const applyBatchStock = () => {
    const v = batchStock.trim();
    if (v === '') return;
    const n = Math.max(1, Number(v) || 1);
    for (const m of product.modelList) {
      const key = `${product.itemid}-${m.modelid}`;
      const ov = skuOverrides[key];
      setSkuOverride(product.itemid, m.modelid, {
        stock: n,
        discountRate: ov?.discountRate,
        purchaseLimit: ov?.purchaseLimit,
        promoPrice: ov?.promoPrice,
      });
    }
    setBatchStock('');
    onEdit?.(product.itemid);
  };

  const applyBatchPromoPrice = () => {
    const v = batchPromoPrice.trim();
    if (v === '') return;
    const price = Math.max(1, Number(v) || 1);
    for (const m of product.modelList) {
      const key = `${product.itemid}-${m.modelid}`;
      const ov = skuOverrides[key];
      setSkuOverride(product.itemid, m.modelid, {
        promoPrice: price,
        stock: ov?.stock,
        purchaseLimit: ov?.purchaseLimit,
      });
    }
    setBatchPromoPrice('');
    onEdit?.(product.itemid);
  };

  const applyBatchPurchaseLimit = () => {
    const v = batchPurchaseLimit.trim();
    if (v === '') return;
    const n = Math.max(0, Number(v) || 0);
    for (const m of product.modelList) {
      const key = `${product.itemid}-${m.modelid}`;
      const ov = skuOverrides[key];
      setSkuOverride(product.itemid, m.modelid, {
        purchaseLimit: n,
        discountRate: ov?.discountRate,
        stock: ov?.stock,
        promoPrice: ov?.promoPrice,
      });
    }
    setBatchPurchaseLimit('');
    onEdit?.(product.itemid);
  };

  const onBatchKeyDown = (e: React.KeyboardEvent, apply: () => void) => {
    if (e.key === 'Enter') apply();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-[680px] max-w-[95vw] flex flex-col max-h-[85vh]">
        <div className="flex items-start gap-4 p-4 border-b shrink-0">
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

        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {/* 批量编辑行 */}
          <div className="flex items-center gap-1.5 mb-2 px-0.5">
            <span className="text-[10px] text-muted-foreground shrink-0 w-[18%]">批量:</span>
            <span className="w-[10%]" />
            <span className="w-[8%]" />
            <div className="w-[14%]">
              <input
                type="number"
                min={1} max={100}
                placeholder="折扣%"
                value={batchDiscount}
                onChange={e => setBatchDiscount(e.target.value)}
                onBlur={applyBatchDiscount}
                onKeyDown={e => onBatchKeyDown(e, applyBatchDiscount)}
                className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-400 bg-blue-50/30"
              />
            </div>
            <div className="w-[14%]">
              <input
                type="number"
                min={1}
                placeholder="活动库存"
                value={batchStock}
                onChange={e => setBatchStock(e.target.value)}
                onBlur={applyBatchStock}
                onKeyDown={e => onBatchKeyDown(e, applyBatchStock)}
                className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-400 bg-blue-50/30"
              />
            </div>
            <div className="w-[16%]">
              <input
                type="number"
                min={1}
                placeholder="限时价"
                value={batchPromoPrice}
                onChange={e => setBatchPromoPrice(e.target.value)}
                onBlur={applyBatchPromoPrice}
                onKeyDown={e => onBatchKeyDown(e, applyBatchPromoPrice)}
                className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-400 bg-blue-50/30"
              />
            </div>
            <div className="w-[20%]">
              <input
                type="number"
                min={0}
                placeholder="限购数量"
                value={batchPurchaseLimit}
                onChange={e => setBatchPurchaseLimit(e.target.value)}
                onBlur={applyBatchPurchaseLimit}
                onKeyDown={e => onBatchKeyDown(e, applyBatchPurchaseLimit)}
                className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-blue-400 bg-blue-50/30"
              />
            </div>
          </div>

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
                const promoPrice = calcPromoPrice(model.originPrice, override);

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
                              promoPrice: undefined,
                            });
                          } else {
                            const n = Math.max(1, Math.min(100, Number(v) || 1));
                            setSkuOverride(product.itemid, model.modelid, {
                              discountRate: n,
                              stock: override?.stock,
                              purchaseLimit: override?.purchaseLimit,
                              promoPrice: undefined,
                            });
                          }
                          onEdit?.(product.itemid);
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
                              promoPrice: override?.promoPrice,
                            });
                          } else {
                            const n = Math.max(1, Number(v) || 1);
                            setSkuOverride(product.itemid, model.modelid, {
                              stock: n,
                              discountRate: override?.discountRate,
                              purchaseLimit: override?.purchaseLimit,
                              promoPrice: override?.promoPrice,
                            });
                          }
                          onEdit?.(product.itemid);
                        }}
                        className="w-full px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </TableCell>
                    <TableCell className="text-xs p-1">
                      <input
                        type="number"
                        min={1}
                        placeholder={String(calcPromoPrice(model.originPrice, override))}
                        value={priceEditValues[model.modelid] ?? (override?.promoPrice !== undefined ? String(override.promoPrice) : (promoPrice > 0 ? String(promoPrice) : ''))}
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
                            const price = Math.max(1, Number(v) || 1);
                            setSkuOverride(product.itemid, model.modelid, {
                              promoPrice: price,
                              stock: override?.stock,
                              purchaseLimit: override?.purchaseLimit,
                            });
                          }
                          onEdit?.(product.itemid);
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
                              promoPrice: override?.promoPrice,
                            });
                          } else {
                            const n = Math.max(0, Number(v) || 0);
                            setSkuOverride(product.itemid, model.modelid, {
                              purchaseLimit: n,
                              discountRate: override?.discountRate,
                              stock: override?.stock,
                              promoPrice: override?.promoPrice,
                            });
                          }
                          onEdit?.(product.itemid);
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

        <div className="p-3 border-t text-[10px] text-muted-foreground space-y-0.5 shrink-0">
          <div>共 {product.modelList.length} 个 SKU / 总计原库存 {totalStock} / 活动库存 {totalSkuOverrideStock}</div>
          <div>留空 = 使用全局默认值（折扣 {globalDiscount}% / 库存 {globalStock} / 限购 {globalPurchaseLimit}）</div>
        </div>
      </div>
    </div>
  );
}
