import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import * as backendApi from '@/entrypoints/popup/backend-api';
import type { BackendUser, BackendAdminAnalytics, BackendStoreBinding } from '@/entrypoints/popup/types';

type AdminTab = 'users' | 'analytics' | 'bindings';

export function AdminPanel() {
  const [tab, setTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<BackendUser[]>([]);
  const [analytics, setAnalytics] = useState<BackendAdminAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [adjustingUserId, setAdjustingUserId] = useState<number | null>(null);
  const [adjustLimit, setAdjustLimit] = useState(1);

  // 绑定管理状态
  const [bindings, setBindings] = useState<(BackendStoreBinding & { userEmail?: string })[]>([]);
  const [unbindingId, setUnbindingId] = useState<number | null>(null);

  const [deletingUserId, setDeletingUserId] = useState<number | null>(null);

  const loadUsers = async () => {
    setLoading(true); setError('');
    try {
      const result = await backendApi.getUsers();
      setUsers(result.users);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const loadAnalytics = async () => {
    setLoading(true); setError('');
    try {
      const result = await backendApi.getAdminAnalytics();
      setAnalytics(result);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  const loadBindings = async () => {
    setLoading(true); setError('');
    try {
      const result = await backendApi.getAdminBindings();
      setBindings(result.bindings);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (tab === 'users') loadUsers();
    else if (tab === 'analytics') loadAnalytics();
    else loadBindings();
  }, [tab]);

  const handleUnbind = async (bindingId: number) => {
    if (!confirm('确定要解绑该店铺吗？')) return;
    setUnbindingId(bindingId);
    setError('');
    try {
      await backendApi.adminUnbindStore(bindingId);
      loadBindings();
    } catch (e: any) {
      setError(e.message);
    }
    setUnbindingId(null);
  };

  const handleDeleteUser = async (userId: number) => {
    if (!confirm('确定要删除该用户吗？该用户的所有绑定和操作记录将被永久删除，此操作不可恢复！')) return;
    setDeletingUserId(userId);
    setError('');
    try {
      await backendApi.adminDeleteUser(userId);
      setDeletingUserId(null);
      loadUsers();
    } catch (e: any) {
      setError(e.message);
      setDeletingUserId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <Button
          variant={tab === 'users' ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => setTab('users')}
        >
          用户管理
        </Button>
        <Button
          variant={tab === 'bindings' ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => setTab('bindings')}
        >
          绑定管理
        </Button>
        <Button
          variant={tab === 'analytics' ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => setTab('analytics')}
        >
          使用统计
        </Button>
      </div>

      {error && (
        <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">{error}</div>
      )}

      {tab === 'users' && (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {loading ? (
            <div className="py-4 text-center text-xs text-muted-foreground">加载中...</div>
          ) : users.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">暂无用户</div>
          ) : (
            users.map(user => (
              <div key={user.id} className="flex items-center justify-between p-2 rounded-md border text-xs">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate">{user.email}</span>
                    {user.role === 'admin' && (
                      <span className="px-1 py-0.5 text-[10px] bg-shopee-brand-light text-shopee-brand rounded">管理员</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    已绑定 {user.bindingCount ?? 0} 个店铺 · {user.isActive ? '已激活' : '未激活'}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {adjustingUserId === user.id ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        value={adjustLimit}
                        onChange={e => setAdjustLimit(Math.max(1, Number(e.target.value) || 1))}
                        className="w-14 px-1 py-0.5 text-xs border rounded text-center"
                      />
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={async () => {
                          try {
                            await backendApi.updateStoreLimit(user.id, adjustLimit);
                            setAdjustingUserId(null);
                            loadUsers();
                          } catch (e: any) {
                            setError(e.message);
                          }
                        }}
                      >
                        确认
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => setAdjustingUserId(null)}
                      >
                        取消
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px] font-normal"
                        onClick={() => {
                          setAdjustingUserId(user.id);
                          setAdjustLimit(user.bindingCount ?? 1);
                        }}
                      >
                        调整限额
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px] font-normal text-red-500 border-red-200 hover:bg-red-50"
                        disabled={deletingUserId === user.id}
                        onClick={() => handleDeleteUser(user.id)}
                      >
                        {deletingUserId === user.id ? '删除中...' : '删除'}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'bindings' && (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {loading ? (
            <div className="py-4 text-center text-xs text-muted-foreground">加载中...</div>
          ) : bindings.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">暂无绑定记录</div>
          ) : (
            bindings.map(b => (
              <div key={b.id} className="flex items-center justify-between p-2 rounded-md border text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate">{b.userEmail || `用户 #${b.userId}`}</span>
                    {!b.isActive && (
                      <span className="px-1 py-0.5 text-[10px] bg-gray-100 text-muted-foreground rounded">已解绑</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-muted-foreground space-x-2">
                    {b.shopId && <span>店铺 ID: {b.shopId}</span>}
                    {b.shopUsername && <span>用户名: {b.shopUsername}</span>}
                    {b.shopName && <span>{b.shopName}</span>}
                    {!b.shopId && <span>SPC_CDS: {b.spcCds.slice(0, 16)}...</span>}
                  </div>
                </div>
                {b.isActive && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px] font-normal text-red-500 border-red-200 hover:bg-red-50 shrink-0 ml-2"
                    disabled={unbindingId === b.id}
                    onClick={() => handleUnbind(b.id)}
                  >
                    {unbindingId === b.id ? '解绑中...' : '解绑'}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'analytics' && (
        <div className="space-y-3">
          {analytics && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-3 rounded-md border text-center">
                  <div className="text-2xl font-bold text-shopee-brand">{analytics.totalUsers}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">注册用户</div>
                </div>
                <div className="p-3 rounded-md border text-center">
                  <div className="text-2xl font-bold text-shopee-green">{analytics.totalBindings}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">店铺绑定</div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">操作统计</div>
                {analytics.events.length === 0 ? (
                  <div className="text-xs text-muted-foreground">暂无操作记录</div>
                ) : (
                  analytics.events.map(evt => (
                    <div key={evt.eventType} className="flex items-center justify-between px-2 py-1.5 rounded-md border text-xs">
                      <span className="font-medium">{eventTypeLabel(evt.eventType)}</span>
                      <span className="text-muted-foreground">{evt.count} 次</span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
          {!analytics && !loading && (
            <div className="py-4 text-center text-xs text-muted-foreground">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={loadAnalytics}>
                加载统计
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function eventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    enable_loop: '开启限时特卖',
    copy_flow: '复制活动',
    auto_mode_round: '自动模式',
  };
  return labels[type] || type;
}
