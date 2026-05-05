import React from 'react';
import { Badge } from '@/components/ui/badge';
import { useAppStore } from '@/entrypoints/popup/store';

export function SpcStatus() {
  const { isConnected, isExtracting, spcCds, extractSpcCds } = useAppStore();

  const handleClick = () => {
    if (!isConnected && !isExtracting) {
      extractSpcCds();
    }
  };

  if (isExtracting) {
    return (
      <Badge variant='outline' className='text-yellow-600'>
        提取中...
      </Badge>
    );
  }

  if (isConnected) {
    return (
      <Badge variant='outline' className='text-green-600 cursor-default' title={spcCds}>
        已连接
      </Badge>
    );
  }

  return (
    <Badge variant='outline' className='text-red-500 cursor-pointer hover:bg-red-50' onClick={handleClick}>
      未连接 (点击重试)
    </Badge>
  );
}
