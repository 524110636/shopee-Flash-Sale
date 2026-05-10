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
        <CardHeader className='pb-2'>
          <CardTitle className='text-base text-shopee-green'>复制成功！</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <div className='text-sm space-y-1'>
            <p>
              新活动 ID: <span className='font-mono'>{status.newFlashSaleId}</span>
            </p>
            {status.warning && (
              <div className='mt-2 p-2 text-xs text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-md whitespace-pre-wrap break-all'>
                <span className='font-medium'>警告：</span>
                {status.warning}
              </div>
            )}
            <p className='text-muted-foreground mt-2'>新活动已创建。返回活动列表后，在活动中选中此活动并点击「开启限时特卖」提交商品参数到虾皮。</p>
          </div>
          <Button className='w-full' onClick={onBack}>
            返回活动列表
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (status.success === false) {
    return (
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-base text-destructive'>复制失败</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3'>
          <div className='text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2 whitespace-pre-wrap break-all'>
            {status.error || '未知错误'}
          </div>
          <div className='flex gap-2'>
            <Button variant='outline' className='flex-1' onClick={onBack}>
              返回
            </Button>
            {onRetry && (
              <Button className='flex-1' onClick={onRetry}>
                重试
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // success === null → pending / scheduled
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-base text-shopee-brand'>复制任务已安排</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <div className='text-sm space-y-1'>
          <p>系统将在活动开始前 5 分钟自动创建场次。</p>
          <p className='text-muted-foreground mt-2'>场次创建后，需要手动点击「开启限时特卖」来提交商品到虾皮。</p>
        </div>
        <Button className='w-full' onClick={onBack}>
          返回活动列表
        </Button>
      </CardContent>
    </Card>
  );
}
