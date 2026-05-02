import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { CopyTaskStatus } from '@/entrypoints/popup/types';

interface CopyResultPanelProps {
  status: CopyTaskStatus;
  onBack: () => void;
  onRetry?: () => void;
}

export function CopyResultPanel({ status, onBack, onRetry }: CopyResultPanelProps) {
  if (status.success === true) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-green-700">✅ 复制成功！</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm space-y-1">
            <p>新活动 ID: <span className="font-mono">{status.newFlashSaleId}</span></p>
            <p className="text-muted-foreground mt-2">
              提示: 活动开始后，可手动点击「开启限时特卖」处理失败 SKU
            </p>
          </div>
          <Button className="w-full" onClick={onBack}>返回活动列表</Button>
        </CardContent>
      </Card>
    );
  }

  if (status.success === false) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-red-700">❌ 复制失败</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2 whitespace-pre-wrap break-all">
            {status.error || '未知错误'}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onBack}>返回</Button>
            {onRetry && <Button className="flex-1" onClick={onRetry}>重试</Button>}
          </div>
        </CardContent>
      </Card>
    );
  }

  // success === null → pending / scheduled
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-blue-700">⏳ 复制任务已安排</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm space-y-1">
          <p>系统将在活动开始前 5 分钟自动执行复制。</p>
          <p className="text-muted-foreground mt-2">
            请保持 seller.shopee.tw 页面打开，执行完成后会显示结果。
          </p>
        </div>
        <Button className="w-full" onClick={onBack}>返回活动列表</Button>
      </CardContent>
    </Card>
  );
}
