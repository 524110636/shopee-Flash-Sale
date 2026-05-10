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
      <Badge variant='outline' className='text-amber-200 border-amber-300/30 bg-amber-500/10 cursor-default'>
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
      <Badge variant='outline' className='text-white border-white/30 bg-white/10 cursor-default' title={spcCds}>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-white" />
          已连接
        </span>
      </Badge>
    );
  }

  return (
    <Badge variant='outline' className='text-red-300 border-red-400/40 bg-red-500/10 cursor-pointer hover:bg-red-500/20 transition-colors' onClick={handleClick}>
      <span className="flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-red-300" />
        未连接
      </span>
    </Badge>
  );
}
