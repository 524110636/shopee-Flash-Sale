import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';
import type { UndiscountedSku } from '@/entrypoints/popup/types';

interface UndiscountedSkuModalProps {
  skus: UndiscountedSku[];
  onClose: () => void;
  autoSkipSeconds?: number;
  onResolve?: (editedPrices: Record<string, number>, skippedKeys: string[]) => void;
}

function normalizeImageUrl(img: string): string {
  if (!img) return '';
  if (img.startsWith('http://') || img.startsWith('https://') || img.startsWith('data:')) return img;
  return `https://cf.shopee.tw/file/${img}`;
}

export function UndiscountedSkuModal({ skus, onClose, autoSkipSeconds, onResolve }: UndiscountedSkuModalProps) {
  const { resolveUndiscountedSkus } = useAppStore();
  const [editedPrices, setEditedPrices] = useState<Record<string, string>>(
    Object.fromEntries(skus.map(s => [s.key, String(s.promoPrice)]))
  );
  const [skippedKeys, setSkippedKeys] = useState<Set<string>>(new Set(skus.map(s => s.key)));
  const [isSubmitting, setIsSubmitting] = useState(false);

  const autoMode = autoSkipSeconds !== undefined;
  const [countdown, setCountdown] = useState(autoSkipSeconds ?? 0);
  const hasTriggered = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // countdown intentionally omitted from deps — re-creating the interval every second would break the countdown
  useEffect(() => {
    if (!autoMode || countdown <= 0) return;
    timerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode]);

  useEffect(() => {
    if (countdown === 0 && autoMode && !hasTriggered.current) {
      hasTriggered.current = true;
      setIsSubmitting(true);
      if (onResolve) {
        onResolve({}, Array.from(skippedKeys));
      } else {
        resolveUndiscountedSkus({}, Array.from(skippedKeys));
      }
    }
  }, [countdown, autoMode, skippedKeys, onResolve, resolveUndiscountedSkus]);

  const allSkipped = skippedKeys.size === skus.length;
  const anyEdited = skus.some(s => {
    const edited = editedPrices[s.key];
    return edited !== undefined && Number(edited) !== s.promoPrice;
  });

  const toggleSkip = useCallback((key: string) => {
    setSkippedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (autoMode) setCountdown(autoSkipSeconds!);
  }, [autoMode, autoSkipSeconds]);

  const skipAll = useCallback(() => {
    setSkippedKeys(new Set(skus.map(s => s.key)));
    if (autoMode) setCountdown(autoSkipSeconds!);
  }, [skus, autoMode, autoSkipSeconds]);

  const unskipAll = useCallback(() => {
    setSkippedKeys(new Set());
    if (autoMode) setCountdown(autoSkipSeconds!);
  }, [autoMode, autoSkipSeconds]);

  const doResolve = useCallback((editedPrices: Record<string, number>, skippedKeys: string[]) => {
    setIsSubmitting(true);
    if (onResolve) {
      onResolve(editedPrices, skippedKeys);
    } else {
      resolveUndiscountedSkus(editedPrices, skippedKeys);
    }
  }, [onResolve, resolveUndiscountedSkus]);

  const handleApplyAndContinue = useCallback(() => {
    const priceMap: Record<string, number> = {};
    for (const s of skus) {
      if (!skippedKeys.has(s.key)) {
        const val = Number(editedPrices[s.key]);
        if (!isNaN(val) && val >= 1 && val < s.originPrice) {
          priceMap[s.key] = Math.floor(val);
        }
      }
    }
    doResolve(priceMap, Array.from(skippedKeys));
  }, [skus, skippedKeys, editedPrices, doResolve]);

  const handleSkipAndContinue = useCallback(() => {
    doResolve({}, Array.from(skippedKeys));
  }, [skippedKeys, doResolve]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-[520px] max-w-[95vw] flex flex-col max-h-[85vh]">
        {/* 标题栏 */}
        <div className="flex items-center justify-between gap-3 p-4 border-b shrink-0">
          <div>
            <h3 className="text-sm font-medium">检测到未打折商品</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              以下 {skus.length} 个 SKU 的折扣率为100%（原价无折扣），请选择编辑价格或跳过
            </p>
          </div>
          <button
            className="text-lg leading-none text-muted-foreground hover:text-foreground shrink-0"
            onClick={onClose}
            disabled={isSubmitting}
          >
            ×
          </button>
        </div>

        {/* 自动模式倒计时 */}
        {autoMode && countdown > 0 && (
          <div className="flex items-center justify-between px-4 py-2 border-b bg-red-50 shrink-0">
            <span className="text-xs text-red-600 font-medium">
              ⏱ 自动模式：{countdown} 秒后自动跳过全部未打折商品
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10px] text-red-500 hover:text-red-700"
              onClick={() => setCountdown(0)}
            >
              立即跳过
            </Button>
          </div>
        )}

        {/* 全部跳过/全部参与 */}
        <div className="flex items-center gap-2 px-4 py-2 border-b shrink-0 bg-amber-50/50">
          <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={skipAll}>
            全部跳过
          </Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={unskipAll} disabled={allSkipped}>
            全部参与
          </Button>
          <span className="text-[11px] text-muted-foreground ml-auto">
            {skippedKeys.size} 个跳过 / {skus.length - skippedKeys.size} 个参与
          </span>
        </div>

        {/* SKU 列表 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <div className="space-y-2">
            {skus.map(sku => {
              const isSkipped = skippedKeys.has(sku.key);
              return (
                <div
                  key={sku.key}
                  className={`flex items-center gap-3 px-3 py-2 border rounded-md transition-colors ${
                    isSkipped ? 'bg-gray-50 border-gray-200 opacity-60' : 'bg-white border-amber-200'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSkipped}
                    onChange={() => toggleSkip(sku.key)}
                    className="shrink-0 w-4 h-4 cursor-pointer accent-amber-500"
                  />

                  {sku.image ? (
                    <img
                      src={normalizeImageUrl(sku.image) + '_tn'}
                      alt=""
                      className="w-12 h-12 rounded object-cover shrink-0 bg-muted"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="w-12 h-12 rounded bg-muted shrink-0 flex items-center justify-center text-[10px] text-muted-foreground">无图</div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{sku.productName}</div>
                    <div className="text-[11px] text-muted-foreground truncate">SKU: {sku.skuName}</div>
                    <div className="text-[11px] text-muted-foreground">商品ID: {sku.itemId} / ModelID: {sku.modelId}</div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-right">
                      <div className="text-[10px] text-muted-foreground">原价</div>
                      <div className="text-xs font-medium">NT${sku.originPrice.toLocaleString()}</div>
                    </div>
                    <span className="text-muted-foreground text-xs">→</span>
                    <div className="text-right">
                      <div className="text-[10px] text-muted-foreground">{isSkipped ? '跳过' : '限时价'}</div>
                      {isSkipped ? (
                        <div className="text-xs text-gray-400 font-medium">—</div>
                      ) : (
                        <input
                          type="number"
                          min={1}
                          max={sku.originPrice - 1}
                          value={editedPrices[sku.key] ?? String(sku.promoPrice)}
                          onChange={e => {
                            setEditedPrices(prev => ({ ...prev, [sku.key]: e.target.value }));
                            if (autoMode) setCountdown(autoSkipSeconds!);
                          }}
                          onFocus={() => { if (autoMode) setCountdown(autoSkipSeconds!); }}
                          className="w-20 px-1.5 py-0.5 text-xs border border-amber-300 rounded text-center bg-amber-50 focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t shrink-0 bg-gray-50">
          <Button variant="outline" size="sm" className="h-7 px-3 text-xs" onClick={onClose} disabled={isSubmitting}>
            取消
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
              onClick={handleSkipAndContinue}
              disabled={isSubmitting}
            >
              {isSubmitting ? '处理中...' : '确认跳过并继续'}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="h-7 px-3 text-xs bg-green-600 hover:bg-green-700"
              onClick={handleApplyAndContinue}
              disabled={isSubmitting || !anyEdited}
            >
              {isSubmitting ? '处理中...' : '应用编辑并继续'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
