import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SkuTable } from '@/components/product/SkuTable';
import { ProductViewModal } from '@/components/product/ProductViewModal';
import { TimeSlotModal } from '@/components/product/TimeSlotModal';
import { useAppStore } from '@/entrypoints/popup/store';
import type { AutoModeConfig, FlashSale, ShopeeProduct, TimeSlot } from '@/entrypoints/popup/types';

interface AutoModePanelProps {
  onBack: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  idle: '未启动',
  waiting_create: '等待申报时间...',
  creating: '正在创建活动...',
  waiting_enable: '等待传递商品...',
  enabling: '正在传递商品参数...',
  completed: '已完成',
  stopped: '已停止',
};

export function AutoModePanel({ onBack }: AutoModePanelProps) {
  const {
    autoModeStatus, autoModeLogs,
    startAutoMode, stopAutoMode,
    flashSaleList, fetchFlashSaleList, isLoadingFlashSaleList,
    loadFlashSaleProducts, products, isLoadingFlashSales,
  } = useAppStore();

  const [mode, setMode] = useState<'rounds' | 'days'>('rounds');
  const [value, setValue] = useState(10);
  const [advanceMinutes, setAdvanceMinutes] = useState(5);
  const [delayMinutes, setDelayMinutes] = useState(5);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [selectedTemplate, setSelectedTemplate] = useState<FlashSale | null>(null);
  const [editingProduct, setEditingProduct] = useState<ShopeeProduct | null>(null);
  const [productViewSale, setProductViewSale] = useState<FlashSale | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [debugMode, setDebugMode] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [showSlotModal, setShowSlotModal] = useState(false);
  const [editedProductIds, setEditedProductIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (flashSaleList.length === 0) fetchFlashSaleList();
  }, [flashSaleList.length, fetchFlashSaleList]);

  useEffect(() => {
    if (autoModeStatus?.sourceFlashSaleId && flashSaleList.length > 0) {
      const found = flashSaleList.find(s => s.flash_sale_id === autoModeStatus.sourceFlashSaleId);
      if (found && !selectedTemplate) setSelectedTemplate(found);
    }
  }, [autoModeStatus?.sourceFlashSaleId, flashSaleList, selectedTemplate]);

  const isRunning = autoModeStatus?.isRunning ?? false;

  const fmtTime = useCallback((ts: number) => {
    const d = new Date(ts * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
  }, []);

  const countdownText = useCallback((targetTs: number) => {
    const diff = targetTs - Math.floor(now / 1000);
    if (diff <= 0) return '即将开始';
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    const s = diff % 60;
    if (h > 0) return `${h}时${m}分${s}秒`;
    if (m > 0) return `${m}分${s}秒`;
    return `${s}秒`;
  }, [now]);

  const logColorClass = (type: string) => {
    switch (type) {
      case 'success': return 'text-green-600';
      case 'error': return 'text-red-500';
      case 'warning': return 'text-amber-500';
      default: return 'text-gray-400';
    }
  };

  const validate = (): string | null => {
    if (value < 1) return mode === 'rounds' ? '轮数必须至少为 1' : '天数必须至少为 1';
    if (advanceMinutes < 1 || advanceMinutes > 60) return '申报提前量必须在 1~60 分钟之间';
    if (delayMinutes < 0 || delayMinutes > 60) return '传递延迟量必须在 0~60 分钟之间';
    if (!selectedTemplate) return '请选择一个模板活动';
    if (!selectedSlot) return '请选择一个申报场次';
    return null;
  };

  const validationError = validate();

  const handleSelectTemplate = async (sale: FlashSale) => {
    setSelectedTemplate(sale);
    setSelectedSlot(null);
    setEditedProductIds(new Set());
    setStartError(null);
    await loadFlashSaleProducts(sale.flash_sale_id);
  };

  const handleStart = async () => {
    if (validationError || !selectedTemplate || !selectedSlot) return;
    setStartError(null);
    setIsStarting(true);
    console.log('[AutoModePanel] handleStart 触发, 开始启动自动模式...');
    try {
      const config: AutoModeConfig = {
        mode,
        value,
        advanceMinutes,
        delayMinutes,
      };
      const result = await startAutoMode(config, selectedTemplate.flash_sale_id, selectedTemplate.name, debugMode, selectedSlot.timeslot_id, selectedSlot.start_time);
      console.log('[AutoModePanel] startAutoMode 返回:', JSON.stringify(result));
      if (!result?.success) {
        setStartError(result?.error || '启动失败，请查看后台日志');
        console.error('[AutoModePanel] 启动失败:', result?.error);
      }
    } catch (e: any) {
      setStartError(e?.message || '启动异常');
      console.error('[AutoModePanel] handleStart 异常:', e?.message, e?.stack);
    } finally {
      setIsStarting(false);
    }
  };

  const handleStop = async () => {
    if (!confirmStop) {
      setConfirmStop(true);
      return;
    }
    setIsStopping(true);
    try {
      await stopAutoMode();
      setConfirmStop(false);
    } finally {
      setIsStopping(false);
    }
  };

  const nowSec = Math.floor(Date.now() / 1000);

  const filteredProducts = useMemo(() => {
    if (!productSearch.trim()) return products;
    const q = productSearch.toLowerCase();
    return products.filter(p => {
      if (p.name?.toLowerCase().includes(q)) return true;
      if (String(p.itemid).includes(q)) return true;
      if (p.modelList?.some(m => String(m.modelid).includes(q) || m.name?.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [products, productSearch]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Button variant="outline" size="sm" className="h-7 px-3 text-xs font-normal" onClick={onBack}>
          ← 返回
        </Button>
        <span className="font-medium">🤖 自动模式</span>
        {isRunning && (
          <span className="text-xs text-green-600 font-medium ml-1">● 运行中</span>
        )}
        {autoModeStatus?.debugMode && (
          <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 ml-1">⏩ 加速</span>
        )}
      </div>

      <Card>
        <CardContent className="p-4 space-y-4">
          {!isRunning ? (
            <>
              <div className="space-y-3">
                <h3 className="text-sm font-medium">参数设置</h3>

                {/* 模式选择 */}
                <div className="flex gap-3">
                  <label className={`flex items-center gap-1.5 text-sm cursor-pointer ${mode === 'rounds' ? 'text-blue-600' : 'text-gray-400'}`}>
                    <input type="radio" name="autoMode" checked={mode === 'rounds'} onChange={() => setMode('rounds')} />
                    轮数
                  </label>
                  <label className={`flex items-center gap-1.5 text-sm cursor-pointer ${mode === 'days' ? 'text-blue-600' : 'text-gray-400'}`}>
                    <input type="radio" name="autoMode" checked={mode === 'days'} onChange={() => setMode('days')} />
                    天数
                  </label>
                </div>

                {/* 三个输入框同一行 */}
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1">
                    <input
                      type="number" min={1}
                      value={value}
                      onChange={e => setValue(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-16 h-8 rounded-md border border-input bg-background px-2 py-1 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">{mode === 'rounds' ? '轮' : '天'}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground shrink-0">提前</span>
                    <input
                      type="number" min={1} max={60}
                      value={advanceMinutes}
                      onChange={e => setAdvanceMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-14 h-8 rounded-md border border-input bg-background px-2 py-1 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">分钟申报</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground shrink-0">延迟</span>
                    <input
                      type="number" min={0} max={60}
                      value={delayMinutes}
                      onChange={e => setDelayMinutes(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-14 h-8 rounded-md border border-input bg-background px-2 py-1 text-sm"
                    />
                    <span className="text-xs text-muted-foreground">分钟传递</span>
                  </div>
                </div>

                {validationError && (
                  <p className="text-xs text-red-500">{validationError}</p>
                )}

                <label className="flex items-center gap-2 text-xs text-amber-600 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={debugMode}
                    onChange={e => setDebugMode(e.target.checked)}
                  />
                  ⏩ 加速调试模式（延迟单位：秒，用于快速验证）
                </label>
              </div>

              <Separator />

              {/* 模板活动选择 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">选择模板活动</h3>
                  <div className="flex items-center gap-1">
                    {flashSaleList.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px] font-normal"
                        onClick={fetchFlashSaleList}
                        disabled={isLoadingFlashSaleList}
                      >
                        {isLoadingFlashSaleList ? '刷新中...' : '刷新'}
                      </Button>
                    )}
                    {flashSaleList.length === 0 && !isLoadingFlashSaleList && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px] font-normal text-blue-600 border-blue-300"
                        onClick={fetchFlashSaleList}
                      >
                        加载限时特卖
                      </Button>
                    )}
                    {isLoadingFlashSaleList && flashSaleList.length === 0 && (
                      <span className="text-[10px] text-muted-foreground">加载中...</span>
                    )}
                  </div>
                </div>
                {flashSaleList.length === 0 && !isLoadingFlashSaleList ? (
                  <p className="text-xs text-muted-foreground">点击「加载限时特卖」获取活动列表</p>
                ) : (
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {flashSaleList.map(sale => {
                      const isActive = nowSec >= sale.start_time && nowSec < sale.end_time;
                      const isUpcoming = sale.start_time > nowSec;
                      const isSel = selectedTemplate?.flash_sale_id === sale.flash_sale_id;
                      let statusLabel = '已结束';
                      let statusClass = 'text-gray-500 bg-gray-50 border-gray-200';
                      if (isActive) { statusLabel = '进行中'; statusClass = 'text-green-600 bg-green-50 border-green-200'; }
                      else if (isUpcoming) { statusLabel = '即将开始'; statusClass = 'text-blue-600 bg-blue-50 border-blue-200'; }

                      return (
                        <div
                          key={sale.flash_sale_id}
                          className={`flex items-center justify-between px-3 py-2 text-xs border rounded-md transition-colors cursor-pointer ${
                            isSel ? 'border-l-4 border-l-blue-500 bg-blue-50/50' : 'hover:bg-accent/50'
                          }`}
                          onClick={() => handleSelectTemplate(sale)}
                        >
                          <div className="flex flex-col min-w-0">
                            <span className={`font-medium truncate ${isSel ? 'text-blue-600' : ''}`}>
                              {sale.name || `活动 #${sale.flash_sale_id}`}
                            </span>
                            <span className="text-[10px] text-muted-foreground mt-0.5">
                              {fmtTime(sale.start_time)} ~ {fmtTime(sale.end_time)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {isSel && (
                              <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full border border-blue-300 bg-blue-50 text-blue-600">
                                已选择
                              </span>
                            )}
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-5 px-1.5 text-[10px] font-normal text-violet-600 border-violet-300 hover:bg-violet-50"
                              onClick={(e) => { e.stopPropagation(); setProductViewSale(sale); }}
                              title="查看此活动的商品"
                            >
                              查看商品
                            </Button>
                            <span className={`px-1.5 py-0.5 text-[10px] rounded-full border ${statusClass}`}>
                              {statusLabel}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 场次选择 */}
              {selectedTemplate && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">申报场次</h3>
                  {selectedSlot ? (
                    <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50/50 px-3 py-2">
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-medium text-blue-700">
                          场次 #{selectedSlot.timeslot_id}
                        </span>
                        <span className="text-[10px] text-muted-foreground mt-0.5">
                          {fmtTime(selectedSlot.start_time)} ~ {fmtTime(selectedSlot.end_time)}
                        </span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px] font-normal shrink-0"
                        onClick={() => setShowSlotModal(true)}
                      >
                        更改
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between rounded-md border border-amber-200 bg-amber-50/50 px-3 py-2">
                      <span className="text-xs text-amber-700">尚未选择申报场次</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-[10px] font-normal text-blue-600 border-blue-300 shrink-0"
                        onClick={() => setShowSlotModal(true)}
                      >
                        选择场次
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* 已加载商品列表 */}
              {selectedTemplate && products.length > 0 && !isLoadingFlashSales && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">模板商品 ({filteredProducts.length}/{products.length})</h3>
                    {productSearch && products.length !== filteredProducts.length && (
                      <button
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() => setProductSearch('')}
                      >
                        清除筛选
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    placeholder="搜索商品标题/ID/SKUID/SKU名称..."
                    value={productSearch}
                    onChange={e => setProductSearch(e.target.value)}
                    className="w-full h-7 rounded-md border border-input bg-background px-2 py-1 text-xs placeholder:text-muted-foreground/60"
                  />
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {filteredProducts.map(product => {
                      const isEdited = editedProductIds.has(product.itemid);
                      return (
                      <div
                        key={product.itemid}
                        className={`flex items-center justify-between px-3 py-2 text-xs border rounded-md hover:bg-accent/30 cursor-pointer ${isEdited ? 'border-l-4 border-l-blue-500' : ''}`}
                        onClick={() => setEditingProduct(product)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {product.images?.[0] ? (
                            <img
                              src={`https://cf.shopee.tw/file/${product.images[0]}_tn`}
                              alt=""
                              className="w-8 h-8 rounded object-cover shrink-0"
                              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                            />
                          ) : null}
                          <div className="min-w-0">
                            <div className="font-medium truncate">{product.name}</div>
                            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
                              <span>ID: {product.itemid} · {product.modelList?.length || 0} SKU</span>
                              {isEdited && (
                                <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full border border-blue-300 bg-blue-50 text-blue-600">
                                  已编辑
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                        <span className="text-[10px] text-blue-600 shrink-0 ml-2">编辑 →</span>
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedTemplate && isLoadingFlashSales && (
                <div className="text-xs text-muted-foreground text-center py-4">加载商品中...</div>
              )}

              {startError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 font-medium">错误</span>
                    <span>{startError}</span>
                  </div>
                </div>
              )}

              <Button
                className="w-full bg-green-600 hover:bg-green-700 text-white"
                disabled={isStarting || !!validationError}
                onClick={handleStart}
              >
                {isStarting ? '启动中...' : '🚀 启动自动模式'}
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-3">
                <h3 className="text-sm font-medium">📊 任务状态</h3>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">源活动:</span>
                    <span className="italic text-gray-400">{autoModeStatus?.sourceFlashSaleName}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">当前进度:</span>
                    <span className="font-medium">第 {autoModeStatus?.currentRound}/{autoModeStatus?.totalRounds} 轮</span>
                  </div>
                  {autoModeStatus?.nextTargetTime && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">下一场:</span>
                      <span>
                        {fmtTime(autoModeStatus.nextTargetTime)}{' '}
                        <span className="text-xs text-blue-600">({countdownText(autoModeStatus.nextTargetTime)}后开始)</span>
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">当前阶段:</span>
                    <span className="text-blue-600">
                      {autoModeStatus?.phase && PHASE_LABELS[autoModeStatus.phase] || autoModeStatus?.phase}
                    </span>
                  </div>
                  {autoModeStatus?.nextActionTime && autoModeStatus.nextActionTime > Math.floor(Date.now() / 1000) && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">
                        {autoModeStatus.phase === 'waiting_create' ? '申报倒计时:' : '传递倒计时:'}
                      </span>
                      <span className="text-amber-600 font-medium">{countdownText(autoModeStatus.nextActionTime)}</span>
                    </div>
                  )}
                  {autoModeStatus?.currentFlashSaleId && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">当前活动:</span>
                      <span className="text-xs text-muted-foreground">#{autoModeStatus.currentFlashSaleId}</span>
                    </div>
                  )}
                  {autoModeStatus?.lastError && (
                    <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-xs text-red-600 mt-2">
                      {autoModeStatus.lastError}
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              <div className="space-y-2">
                {confirmStop ? (
                  <div className="space-y-2">
                    <p className="text-xs text-red-600">确定要强制停止自动模式吗？已申报的场次不会回退。</p>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1" onClick={() => setConfirmStop(false)} disabled={isStopping}>取消</Button>
                      <Button className="flex-1 bg-red-600 hover:bg-red-700 text-white" onClick={handleStop} disabled={isStopping}>{isStopping ? '停止中...' : '确认停止'}</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="outline" className="w-full border-red-300 text-red-600 hover:bg-red-50" onClick={handleStop}>⏹ 强制停止</Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 日志区 */}
      <Card>
        <CardContent className="p-4 space-y-2">
          {/* 红色信息栏 */}
          {isRunning && autoModeStatus ? (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-medium text-red-600">● 活动信息简览</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] text-red-700">
                <span>
                  选择场次: {selectedSlot ? `#${selectedSlot.timeslot_id} ${fmtTime(selectedSlot.start_time)} ~ ${fmtTime(selectedSlot.end_time)}` : (autoModeStatus.nextTargetTime ? fmtTime(autoModeStatus.nextTargetTime) : '—')}
                </span>
                <span>
                  场次状态: {
                    (() => {
                      const slotStart = selectedSlot?.start_time || autoModeStatus?.nextTargetTime || 0;
                      const slotEnd = selectedSlot?.end_time || (slotStart + 7200);
                      if (nowSec >= slotStart && nowSec < slotEnd) return '进行中';
                      if (nowSec >= slotEnd) return '已结束';
                      return '未开始';
                    })()
                  }
                </span>
                <span>
                  模板商品: {autoModeStatus.enableParams?.products?.length || products.length || 0} 个
                </span>
                <span>
                  当前轮次: 第 {autoModeStatus.currentRound}/{autoModeStatus.totalRounds} 轮
                </span>
                <span className="col-span-2">
                  当前阶段: {autoModeStatus.phase && PHASE_LABELS[autoModeStatus.phase] || '—'}
                </span>
              </div>
            </div>
          ) : (
            <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-[10px] text-red-500">自动模式未启动，暂无活动数据</p>
            </div>
          )}

          <h3 className="text-sm font-medium">运行日志 (最近 {autoModeLogs.length} 条)</h3>
          {autoModeLogs.length > 0 ? (
            <div className="max-h-48 overflow-y-auto space-y-1 text-xs font-mono">
              {autoModeLogs.map(log => (
                <div key={log.id} className="flex gap-2">
                  <span className="text-gray-400 shrink-0">[{fmtTime(log.timestamp)}]</span>
                  <span className={logColorClass(log.type)}>{log.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400">暂无日志</p>
          )}
        </CardContent>
      </Card>

      {/* 编辑商品 SKU 弹窗 */}
      {editingProduct && (
        <SkuTable
          product={editingProduct}
          onClose={() => setEditingProduct(null)}
          onEdit={(itemId) => setEditedProductIds(prev => new Set([...prev, itemId]))}
        />
      )}

      {/* 场次选择弹窗 */}
      {showSlotModal && (
        <TimeSlotModal
          onSelect={(slot) => {
            setSelectedSlot(slot);
            setShowSlotModal(false);
          }}
          onClose={() => setShowSlotModal(false)}
        />
      )}

      {/* 查看商品弹窗 */}
      {productViewSale && (
        <ProductViewModal
          sale={productViewSale}
          onClose={() => setProductViewSale(null)}
        />
      )}
    </div>
  );
}
