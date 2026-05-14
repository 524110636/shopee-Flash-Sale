import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';

export function FirstUseWarningModal() {
  const { firstUseWarningOpen, confirmFirstUseWarning } = useAppStore();
  const [dontShowAgain, setDontShowAgain] = useState(false);

  if (!firstUseWarningOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-[400px] max-w-[92vw] flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-2">
          <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
            <svg className="w-4.5 h-4.5 text-amber-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </div>
          <h2 className="text-base font-bold text-gray-900">请仔细查看使用规则</h2>
        </div>

        {/* Body */}
        <div className="px-5 py-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
            <p className="text-sm text-gray-800 leading-relaxed">
              在开始前，请务必将想要卡限时特卖的商品从各种促销活动中
              <span className="text-red-600 font-semibold">全部移出</span>（
              <span className="text-green-700 font-medium">折扣活动除外</span>），
              例如<span className="font-medium text-gray-900">多件折扣</span>、
              <span className="font-medium text-gray-900">免运促销</span>、
              <span className="font-medium text-gray-900">加价购</span>、
              <span cspasName="font-medium text-gray-900">满额赠</span>、
              <span className="font-medium text-gray-900">套装优惠</span>等。
            </p>

            <div className="mt-3 flex items-start gap-2 bg-red-50 border border-red-200 rounded-md px-3 py-2.5">
              <svg className="w-4 h-4 text-red-500 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p className="text-[13px] text-red-700 leading-relaxed font-medium">
                如果商品正在参与这些促销活动，将无法被添加到限时特卖中。请先在虾皮卖家中心手动移出后再使用此插件。
              </p>
            </div>
          </div>

          {/* Don't show again checkbox */}
          <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="w-3.5 h-3.5 shrink-0 accent-shopee-brand rounded"
            />
            <span className="text-xs text-muted-foreground">以后不再提示</span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex justify-end px-5 pb-5 pt-2">
          <Button
            size="sm"
            className="h-8 px-5 text-xs bg-shopee-brand hover:bg-shopee-brand/90"
            onClick={() => confirmFirstUseWarning(dontShowAgain)}
          >
            我知道了
          </Button>
        </div>
      </div>
    </div>
  );
}
