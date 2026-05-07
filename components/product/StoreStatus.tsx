import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';

export function StoreStatus() {
  const { isLoggedIn, storeBindings, bindCurrentStore, spcCds, refreshStoreBindings } = useAppStore();
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState('');

  if (!isLoggedIn) return null;

  const activeBindings = storeBindings.filter(b => b.isActive);
  const maxStores = activeBindings[0]?.maxStores ?? 1;

  return (
    <div className="px-3 py-2 bg-blue-50/50 border-b text-xs space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-medium text-blue-800">店铺绑定</span>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {activeBindings.length} / {maxStores}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[10px] font-normal"
            onClick={() => refreshStoreBindings()}
          >
            刷新
          </Button>
        </div>
      </div>

      {activeBindings.length === 0 && (
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">尚未绑定店铺</span>
          <Button
            size="sm"
            className="h-6 px-2 text-[10px]"
            disabled={binding || !spcCds}
            onClick={async () => {
              setBinding(true); setError('');
              const err = await bindCurrentStore();
              if (err) setError(err);
              setBinding(false);
            }}
          >
            {binding ? '绑定中...' : '绑定当前店铺'}
          </Button>
        </div>
      )}

      {error && <div className="text-red-600">{error}</div>}

      {activeBindings.length > 0 && (
        <div className="space-y-1">
          {activeBindings.map(b => (
            <div key={b.id} className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-green-600 shrink-0">●</span>
                <span className="truncate text-muted-foreground">
                  {b.shopName || b.spcCds.slice(0, 20)}...
                </span>
              </div>
              {b.spcCds === spcCds && (
                <span className="text-[10px] text-green-600 shrink-0 ml-1">当前</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
