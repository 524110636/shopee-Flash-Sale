import React, { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';
import { ProductCard } from './ProductCard';
import { SkuTable } from './SkuTable';
import type { FlashSale, ShopeeProduct, TimeSlot } from '@/entrypoints/popup/types';

interface CopyConfirmPanelProps {
  source: { flashSale: FlashSale; itemCount: number | null };
  savedTemplates: string[];
  selectedTemplate: string | null;
  isCopying: boolean;
  onConfirm: (targetTime: number, templateName: string | null) => void;
  onCancel: () => void;
  onSelectTemplate: (name: string | null) => void;
  onFetchTimeSlots: () => Promise<TimeSlot[]>;
}

export function CopyConfirmPanel({
  source, savedTemplates, selectedTemplate,
  isCopying, onConfirm, onCancel, onSelectTemplate, onFetchTimeSlots,
}: CopyConfirmPanelProps) {
  const [timeSlots, setTimeSlots] = useState<TimeSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(true);
  const [selectedSlotId, setSelectedSlotId] = useState<number | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [viewingProducts, setViewingProducts] = useState(false);
  const [loadingViewProducts, setLoadingViewProducts] = useState(false);
  const [selectedViewProduct, setSelectedViewProduct] = useState<ShopeeProduct | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const products = useAppStore(s => s.products);
  const isLoadingFlashSales = useAppStore(s => s.isLoadingFlashSales);
  const skuOverrides = useAppStore(s => s.skuOverrides);
  const loadFlashSaleProducts = useAppStore(s => s.loadFlashSaleProducts);

  // 进入面板时自动获取可用时间段
  useEffect(() => {
    (async () => {
      try {
        setLoadingSlots(true);
        const slots = await onFetchTimeSlots();
        setTimeSlots(slots);
        if (slots.length > 0) {
          setSelectedSlotId(slots[0].timeslot_id);
        }
      } catch (e: any) {
        console.error('[CopyConfirmPanel] 获取时间段失败:', e?.message || e);
        setSlotsError(e.message || String(e));
      } finally {
        setLoadingSlots(false);
      }
    })();
  }, [onFetchTimeSlots]);

  const fmtTime = (ts: number) => {
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  const handleConfirm = () => {
    const slot = timeSlots.find(s => s.timeslot_id === selectedSlotId);
    if (!slot) {
      alert('请选择一个活动时间段');
      return;
    }
    onConfirm(slot.start_time, selectedTemplate);
  };

  const handleOpenView = async () => {
    if (loadingViewProducts) return;

    const saleId = source.flashSale.flash_sale_id;
    const saleName = source.flashSale.name || `活动 #${saleId}`;
    console.log(`[CopyConfirmPanel:查看] 点击查看源活动商品, flash_sale_id=${saleId}, name=${saleName}`);
    setLoadingViewProducts(true);
    setViewError(null);
    try {
      await loadFlashSaleProducts(saleId);
      console.log(`[CopyConfirmPanel:查看] loadFlashSaleProducts 完成, products=${products.length}, skuOverrides=${Object.keys(skuOverrides).length}`);
      // 检查前 3 条覆盖参数样例
      const overrideKeys = Object.keys(skuOverrides);
      if (overrideKeys.length > 0) {
        const samples = overrideKeys.slice(0, 3).map(k => ({ key: k, ...skuOverrides[k] }));
        console.log(`[CopyConfirmPanel:查看] skuOverrides 前3条样例:`, JSON.stringify(samples));
      }
    } catch (e: any) {
      console.error(`[CopyConfirmPanel:查看] 失败:`, e?.message || e);
      setViewError(e?.message || '查看失败');
    } finally {
      setLoadingViewProducts(false);
    }
    setViewingProducts(true);
  };

  const selectedSlot = timeSlots.find(s => s.timeslot_id === selectedSlotId);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Button variant="outline" size="sm" className="h-7 px-3 text-xs font-normal" onClick={onCancel}>
          <svg className="w-3 h-3 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5m7-7-7 7 7 7"/>
          </svg>
          返回活动列表
        </Button>
      </div>

      {/* 步骤提示 */}
      <div className="flex items-center justify-center gap-2 text-xs">
        <span className="text-shopee-brand font-medium flex items-center gap-1">
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>
          选择源活动
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="text-shopee-brand font-medium flex items-center gap-1">
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>
          选择目标时间
        </span>
        <span className="text-muted-foreground">→</span>
        <span className="text-muted-foreground flex items-center gap-1">
          <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="6"/></svg>
          创建复制任务
        </span>
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          {/* 源活动信息 */}
          <div className="text-sm space-y-1.5">
            <h3 className="font-medium">复制限时特卖</h3>
            <div className="flex justify-between">
              <span className="text-muted-foreground">源活动:</span>
              <span className="font-medium text-right">{source.flashSale.name || `活动 #${source.flashSale.flash_sale_id}`}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">活动时间:</span>
              <span>{fmtTime(source.flashSale.start_time)} ~ {fmtTime(source.flashSale.end_time)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">商品数量:</span>
              <span>
                {source.itemCount !== null ? (
                  <>
                    {source.itemCount} 个
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-1.5 h-5 px-1.5 text-[10px] font-normal text-shopee-brand border-shopee-brand/30 hover:bg-shopee-brand-light"
                      disabled={loadingViewProducts}
                      onClick={(e) => { e.stopPropagation(); handleOpenView(); }}
                    >
                      {loadingViewProducts ? (
                        <>
                          <span className="inline-block animate-spin mr-1">↻</span>
                          查看中
                        </>
                      ) : (
                        '查看'
                      )}
                    </Button>
                    {viewError && (
                      <span className="ml-1 text-[10px] text-red-500">{viewError}</span>
                    )}
                  </>
                ) : '加载中...'}
              </span>
            </div>
          </div>

          {/* 时间段选择 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">目标活动时间段</label>
            {loadingSlots ? (
              <p className="text-xs text-muted-foreground">加载可用时间段...</p>
            ) : slotsError ? (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md p-2">
                获取失败: {slotsError}
              </div>
            ) : timeSlots.length === 0 ? (
              <p className="text-xs text-red-600">当前没有可用的时间段，请稍后再试</p>
            ) : (
              <div className="max-h-48 overflow-y-auto space-y-1">
                {timeSlots.map(slot => (
                  <button
                    key={slot.timeslot_id}
                    className={`w-full text-left px-3 py-2 text-xs border rounded-md transition-colors ${
                      slot.timeslot_id === selectedSlotId
                        ? 'border-l-4 border-l-shopee-brand bg-shopee-brand-light/50'
                        : 'hover:bg-accent/50'
                    }`}
                    onClick={() => setSelectedSlotId(slot.timeslot_id)}
                    disabled={isCopying}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium">
                        {fmtTime(slot.start_time)} ~ {fmtTime(slot.end_time)}
                      </div>
                      {slot.timeslot_id === selectedSlotId && (
                        <span className="text-[10px] text-shopee-brand font-medium ml-2 shrink-0">已选中</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {selectedSlot && (
              <p className="text-xs text-muted-foreground">
                系统将在 {fmtTime(selectedSlot.start_time - 300)} 自动执行复制
              </p>
            )}
          </div>

          {/* 模板选择 */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">使用模板（可选）</label>
            {savedTemplates.length > 0 ? (
              <select
                className="w-full px-2 py-1.5 text-sm border rounded-md"
                value={selectedTemplate || ''}
                onChange={e => onSelectTemplate(e.target.value || null)}
                disabled={isCopying}
              >
                <option value="">不使用模板（沿用源活动配置）</option>
                {savedTemplates.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-muted-foreground">暂无已保存的模板，将沿用源活动配置</p>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-2 pt-1">
            <Button variant="outline" className="flex-1" onClick={onCancel} disabled={isCopying}>
              取消
            </Button>
            <Button
              className="flex-1 bg-green-600 hover:bg-green-700"
              onClick={handleConfirm}
              disabled={isCopying || loadingSlots || timeSlots.length === 0 || !selectedSlotId}
            >
              {isCopying ? '⏳ 正在创建任务...' : '创建复制任务'}
            </Button>
          </div>
          {/* TODO: 调试按钮，上线前删除 */}
          <button
            className="w-full py-1.5 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-300 rounded-md hover:bg-amber-100 disabled:opacity-50"
            onClick={() => onConfirm(Math.floor(Date.now() / 1000), selectedTemplate)}
            disabled={isCopying}
          >
            🛠 立即创建 Demo（调试用，跳过等待时间）
          </button>
        </CardContent>
      </Card>

      {/* 商品查看弹窗 */}
      {viewingProducts && (
        <div className="fixed inset-0 z-50 bg-black/20 flex items-center justify-center p-4" onClick={() => setViewingProducts(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-[460px] max-h-[75vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b shrink-0">
              <h3 className="text-sm font-medium">源活动商品 ({products.length})</h3>
              <button className="text-muted-foreground hover:text-foreground text-lg leading-none" onClick={() => setViewingProducts(false)}>×</button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2">
              {products.length > 0 ? (
                products.map(p => (
                  <ProductCard key={p.itemid} product={p} onViewSkus={setSelectedViewProduct} />
                ))
              ) : isLoadingFlashSales ? (
                <p className="text-xs text-muted-foreground text-center py-8">正在加载商品数据...</p>
              ) : (
                <p className="text-xs text-muted-foreground text-center py-8">该活动无任何商品</p>
              )}
            </div>
          </div>
        </div>
      )}
      {selectedViewProduct && (
        <SkuTable key={selectedViewProduct.itemid} product={selectedViewProduct} onClose={() => setSelectedViewProduct(null)} />
      )}
    </div>
  );
}
