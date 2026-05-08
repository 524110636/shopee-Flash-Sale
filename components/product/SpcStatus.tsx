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
      <Badge variant='outline' className='text-amber-600 border-amber-300 bg-amber-50/50 cursor-default'>
        <span className="flex items-center gap-1">
          <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
          提取中...
        </span>
      </Badge>
    );
  }

  if (isConnected) {
    return (
      <Badge variant='outline' className='text-shopee-green border-shopee-green/30 bg-shopee-green/5 cursor-default' title={spcCds}>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-shopee-green" />
          已连接
        </span>
      </Badge>
    );
  }

  return (
    <Badge variant='outline' className='text-red-500 border-red-300 bg-red-50/50 cursor-pointer hover:bg-red-100 transition-colors' onClick={handleClick}>
      未连接
    </Badge>
  );
}
