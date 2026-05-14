import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SpcStatus } from '@/components/product/SpcStatus';
import { Button } from '@/components/ui/button';
import { ProductList } from '@/components/product/ProductList';
import { TemplateManager } from '@/components/product/TemplateManager';
import { CopyConfirmPanel } from '@/components/product/CopyConfirmPanel';
import { CopyResultPanel } from '@/components/product/CopyResultPanel';
import { AutoModePanel } from '@/components/product/AutoModePanel';
import { FirstUseModal } from '@/components/product/FirstUseModal';
import { FirstUseWarningModal } from '@/components/product/FirstUseWarningModal';
import { SkuTable } from '@/components/product/SkuTable';
import { AuthPanel } from '@/components/product/AuthPanel';
import { StoreStatus } from '@/components/product/StoreStatus';
import { AdminPanel } from '@/components/product/AdminPanel';
import { UndiscountedSkuModal } from '@/components/product/UndiscountedSkuModal';
import { ScheduledTaskCard } from '@/components/product/ScheduledTaskCard';
import { useAppStore, setupBackgroundListener } from './store';
import type { ShopeeProduct, TimeSlot } from './types';
import * as backendApi from './backend-api';

export default function App() {
  const {
    inputText, setInputText,
    setProductIds,
    extractSpcCds, fetchProducts,
    flashSaleList, isLoadingFlashSaleList,
    fetchFlashSaleList, loadFlashSaleProducts,
    products, isLoading, error, isConnected,
    spcCds, productIds,
    isLoadingFlashSales, flashSaleInfo,
    flashSaleId, maxRetries, setMaxRetries,
    infiniteRetry, setInfiniteRetry,
    discountRate, setDiscountRate,
    flashSaleStock, setFlashSaleStock,
    purchaseLimit, setPurchaseLimit,
    skuOverrides,
    isEnabling, isExtracting, enableProgress, enableFlashSaleItems, stopEnabling,
    copyMode, copySource, copyTaskStatus, isCopying,
    savedTemplates, selectedTemplate,
    enterCopyMode, executeCopy, exitCopyMode,
    checkCopyTaskStatus, setSelectedTemplate, fetchTimeSlots,
    checkBackgroundStatus,
    loadCache, clearCache, reset,
    hasScheduledCopy, checkScheduledCopy, triggerScheduledCopyNow,
    _completedCopyInfo, acknowledgeCompletedCopy,
    autoModeActive, autoModeStatus, enterAutoMode, exitAutoMode,
    autoModeDeniedMessage, clearAutoModeDeniedMessage,
    loadAutoModeStatus,
    oneDaySkuSelectedIds, oneDaySkuFlow,
    toggleOneDaySkuSelection, setOneDaySkuSelection, runOneDaySkuAndEnable,
    openFirstUse,
    goToFlashSaleSelection, addToExistingFlashSale, createNewFlashSaleAndAdd, scheduleEnableForFlashSale,
  } = useAppStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [flashSaleListOpen, setFlashSaleListOpen] = useState(true);
  const [selectedFailedProduct, setSelectedFailedProduct] = useState<ShopeeProduct | null>(null);
  const [overrideDetailOpen, setOverrideDetailOpen] = useState(false);
  const [overrideSearchInput, setOverrideSearchInput] = useState('');
  const [overrideSearchQuery, setOverrideSearchQuery] = useState('');
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [isTriggeringScheduled, setIsTriggeringScheduled] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showCustomDev, setShowCustomDev] = useState(false);
  const [phase3Slots, setPhase3Slots] = useState<TimeSlot[] | null>(null);
  const [phase3SlotsLoading, setPhase3SlotsLoading] = useState(false);
  const [wizardEditProduct, setWizardEditProduct] = useState<ShopeeProduct | null>(null);
  const [wizardAdvanceMin, setWizardAdvanceMin] = useState('5');
  const [wizardDelayMin, setWizardDelayMin] = useState('5');
  const [selectedWizardSlotId, setSelectedWizardSlotId] = useState<number | null>(null);
  const { checkAuthOnStartup, isLoggedIn, isCheckingAuth, storeBindings, shopId, pendingUndiscountedSkus, showUndiscountedModal } = useAppStore();

  // 检测当前店铺 SPC_CDS 是否在用户绑定列表中
  const isCurrentStoreBound = useMemo(() => {
    if (!isConnected || !spcCds) return null;
    // 优先用 shopId 匹配（稳定标识）
    if (shopId) {
      const matchByShopId = storeBindings.some(b => b.isActive && b.shopId === shopId);
      if (matchByShopId) return true;
    }
    // 无 shopId 或未匹配到，回退到 spcCds 匹配（兼容旧数据）
    return storeBindings.some(b => b.isActive && b.spcCds === spcCds);
  }, [isConnected, spcCds, shopId, storeBindings]);

  const fmtTime = (ts: number) => {
    const d = new Date(ts * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}/${dd} ${hh}:${mi}`;
  };

  const overrideSummary = useMemo(() => {
    const productMap = new Map<string, { product: ShopeeProduct; skus: Array<{ modelid: string; name: string }> }>();
    let skuCount = 0;

    for (const product of products) {
      for (const model of product.modelList || []) {
        const key = `${product.itemid}-${model.modelid}`;
        if (!(key in skuOverrides)) continue;

        skuCount++;
        const entry = productMap.get(product.itemid) || { product, skus: [] };
        entry.skus.push({ modelid: model.modelid, name: model.name });
        productMap.set(product.itemid, entry);
      }
    }

    return {
      productCount: productMap.size,
      skuCount,
      products: Array.from(productMap.values()),
    };
  }, [products, skuOverrides]);

  const filteredOverrideProducts = useMemo(() => {
    const query = overrideSearchQuery.trim().toLowerCase();
    if (!query) return overrideSummary.products;

    return overrideSummary.products
      .map(({ product, skus }) => {
        const productMatched =
          product.itemid.includes(query) ||
          product.name.toLowerCase().includes(query);
        const matchedSkus = productMatched
          ? skus
          : skus.filter(sku =>
              sku.modelid.includes(query) ||
              sku.name.toLowerCase().includes(query)
            );

        return { product, skus: matchedSkus };
      })
      .filter(({ skus }) => skus.length > 0);
  }, [overrideSearchQuery, overrideSummary.products]);

  const oneDaySkuPhaseLabel = useMemo(() => {
    const labels: Record<string, string> = {
      idle: '待处理',
      preparing_sku: '检查 SKU',
      publishing_product: '发布商品',
      searching_discount: '查询折扣',
      removing_discount: '移除折扣',
      restoring_discount: '恢复折扣',
      starting_flash_sale: '开启特卖',
      editing_params: '编辑参数',
      selecting_flash_sale: '选择场次',
      success: '已完成',
      failed: '已停止',
    };
    return labels[oneDaySkuFlow.phase] || oneDaySkuFlow.phase;
  }, [oneDaySkuFlow.phase]);

  useEffect(() => {
    setupBackgroundListener();
    if (!isConnected && !spcCds) {
      extractSpcCds();
    }
    loadCache();
    checkBackgroundStatus();
    checkCopyTaskStatus();
    checkScheduledCopy();
    loadAutoModeStatus();
    checkAuthOnStartup();
  }, [isConnected, spcCds, extractSpcCds, loadCache, checkBackgroundStatus, checkCopyTaskStatus, checkScheduledCopy, loadAutoModeStatus, checkAuthOnStartup]);

  useEffect(() => {
    if (flashSaleList.length > 0) {
      setFlashSaleListOpen(true);
    }
  }, [flashSaleList.length]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setInputText(text);
    const ids = text
      .split(/[\n,，]/)
      .map(id => id.trim())
      .filter(id => id.length > 0);
    setProductIds(ids);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      handleInputChange({ target: { value: text } } as any);
    } catch {
      textareaRef.current?.focus();
    }
  };

  const handleFetch = async () => {
    if (!isConnected) return;

    const { flashSaleId: currentFsId, products: currentProducts } = useAppStore.getState();
    const wasEmpty = currentProducts.length === 0 && currentFsId !== null;

    await fetchProducts();

    if (wasEmpty && currentFsId) {
      const state = useAppStore.getState();
      const currentSale = state.flashSaleList.find(s => s.flash_sale_id === currentFsId);
      if (currentSale && state.products.length > 0 && Math.floor(Date.now() / 1000) >= currentSale.start_time) {
        const sortedSales = [...state.flashSaleList]
          .filter(s => s.flash_sale_id !== currentFsId && s.start_time < currentSale.start_time)
          .sort((a, b) => b.start_time - a.start_time);

        for (const prevSale of sortedSales) {
          try {
            const result = await browser.storage.local.get('_copiedSaleData');
            const allData: Record<string, any> = result._copiedSaleData || {};
            const prevData = allData[String(prevSale.flash_sale_id)];
            if (prevData?.skuOverrides) {
              const currentIdSet = new Set(state.productIds);
              const inherited: Record<string, any> = {};
              for (const [key, override] of Object.entries(prevData.skuOverrides)) {
                if (currentIdSet.has(key.split('-')[0])) {
                  inherited[key] = override;
                }
              }
              if (Object.keys(inherited).length > 0) {
                const merged = { ...state.skuOverrides, ...inherited };
                useAppStore.setState({ skuOverrides: merged });
                useAppStore.getState().saveCache();
                console.log(`[handleFetch] 自动匹配: 从 ${prevData.sourceFlashSaleName || '历史活动'} 继承 ${Object.keys(inherited).length} 个 SKU 覆盖参数`);
              }
              break;
            }
          } catch {}
        }
      }
    }
  };

  // 登录门控：未登录时只显示认证界面
  if (isCheckingAuth) {
    return (
      <div className="w-[500px] min-h-[500px] p-4 bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-6 h-6 border-2 border-shopee-brand border-t-transparent rounded-full mx-auto"></div>
          <p className="mt-2 text-xs text-muted-foreground">检查登录状态...</p>
        </div>
      </div>
    );
  }

  if (!isLoggedIn) {
    return (
      <div className="w-[500px] min-h-[500px] bg-background flex items-center justify-center">
        <AuthPanel />
      </div>
    );
  }

  return (
    <div className="w-[500px] min-h-[500px] bg-background" style={{ perspective: '1000px' }}>
      {/* Brand Header */}
      <div className="sticky top-0 z-30 bg-shopee-brand px-4 py-2.5 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-white/20 flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
          </div>
          <span className="text-sm font-semibold text-white tracking-wide">限时特卖助手</span>
        </div>
        <div className="flex items-center gap-1.5">
          {!autoModeActive && <SpcStatus />}
          {backendApi.isAdmin() && !autoModeActive && (
            <button
              className="text-[10px] px-2 py-1 rounded text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              onClick={() => setShowAdminPanel(true)}
            >
              管理
            </button>
          )}
          {!backendApi.isAdmin() && !autoModeActive && (
            <button
              className="text-[10px] px-2 py-1 rounded bg-gradient-to-r from-orange-400 to-amber-500 text-white hover:from-orange-500 hover:to-amber-600 transition-colors shadow-sm"
              onClick={() => setShowCustomDev(true)}
            >
              定制开发
            </button>
          )}
        </div>
      </div>

      <div
        className="relative"
        style={{
          transformStyle: 'preserve-3d',
          transition: 'transform 0.6s ease-in-out',
          transform: autoModeActive ? 'rotateY(180deg)' : 'rotateY(0deg)',
        }}
      >
        <div style={{ backfaceVisibility: 'hidden' }}>
          <AuthPanel />
          {isLoggedIn && <StoreStatus />}

          {autoModeDeniedMessage && (
            <div className="mx-4 mt-2 p-2.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded flex items-center justify-between">
              <span>{autoModeDeniedMessage}</span>
              <button
                className="ml-2 text-amber-500 hover:text-amber-700 shrink-0"
                onClick={clearAutoModeDeniedMessage}
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>
          )}

          {isLoggedIn && storeBindings.filter(b => b.isActive).length === 0 && !showAdminPanel ? (
            <Card className="mx-4 mt-3">
              <CardContent className="py-8">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-shopee-brand-light flex items-center justify-center mx-auto">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#EE4D2D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                  </div>
                  <div className="text-sm font-medium text-shopee-brand">请先绑定店铺</div>
                  <div className="text-xs text-muted-foreground max-w-[280px] mx-auto">使用扩展功能前需要先绑定一个 Shopee 店铺</div>
                </div>
              </CardContent>
            </Card>
          ) : isLoggedIn && isCurrentStoreBound === false && !showAdminPanel ? (
            <Card className="mx-4 mt-3 border-amber-200">
              <CardContent className="py-8">
                <div className="text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center mx-auto">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                    </svg>
                  </div>
                  <div className="text-sm font-medium text-amber-700">当前店铺未绑定</div>
                  <div className="text-xs text-muted-foreground max-w-[280px] mx-auto">请在上方点击「绑定当前店铺」将此店铺加入绑定列表</div>
                </div>
              </CardContent>
            </Card>
          ) : showAdminPanel ? (
            <div className="p-4">
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold">管理后台</CardTitle>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-xs font-normal" onClick={() => setShowAdminPanel(false)}>
                      返回
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <AdminPanel />
                </CardContent>
              </Card>
            </div>
          ) : copyMode === 'confirm' && copySource ? (
            <div className="p-4">
              <CopyConfirmPanel
                source={copySource}
                savedTemplates={savedTemplates}
                selectedTemplate={selectedTemplate}
                isCopying={isCopying}
                onConfirm={(targetTime, templateName) => executeCopy(targetTime, templateName)}
                onCancel={exitCopyMode}
                onSelectTemplate={setSelectedTemplate}
                onFetchTimeSlots={fetchTimeSlots}
              />
            </div>
          ) : copyMode === 'result' && copyTaskStatus ? (
            <div className="p-4">
              <CopyResultPanel
                status={copyTaskStatus}
                onBack={exitCopyMode}
                onRetry={() => {
                  if (copySource) enterCopyMode(copySource.flashSale);
                }}
              />
            </div>
          ) : (
            <div className="p-4">
            <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs font-normal border-shopee-brand/30 text-shopee-brand hover:bg-shopee-brand-light"
                    onClick={() => enterAutoMode()}
                  >
                    <svg className="w-3 h-3 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                    自动模式
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs font-normal border-green-300 text-green-700 hover:bg-green-50"
                    onClick={() => openFirstUse()}
                  >
                    <svg className="w-3 h-3 mr-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M12 16v-4M12 8h.01"/>
                    </svg>
                    第一次使用
                  </Button>
                  {autoModeActive && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full bg-shopee-green/10 text-shopee-green border border-shopee-green/20">
                      <span className="w-1.5 h-1.5 rounded-full bg-shopee-green animate-pulse-dot" />
                      {autoModeStatus?.currentRound ? `第 ${autoModeStatus.currentRound} 轮` : '运行中'}
                    </span>
                  )}
                </div>
              </div>
            </CardHeader>
        <CardContent className="space-y-3">
          {/* ===== P0: 当前活动上下文 — 首屏第一眼 ===== */}
          {flashSaleId && !copyMode && (() => {
            const currentSale = flashSaleList.find(s => s.flash_sale_id === flashSaleId);
            if (!currentSale) return null;
            const now = Math.floor(Date.now() / 1000);
            const isActive = now >= currentSale.start_time && now < currentSale.end_time;
            const isUpcoming = currentSale.start_time > now;
            const statusText = isActive ? '进行中' : isUpcoming ? '即将开始' : '已结束';
            const statusDot = isActive ? 'bg-shopee-green' : isUpcoming ? 'bg-shopee-brand' : 'bg-muted-foreground';
            return (
              <div className="bg-shopee-brand-light border border-shopee-brand/15 rounded-lg px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${statusDot} shrink-0`} />
                  <span className="text-xs font-medium text-shopee-brand-dark">{currentSale.name || `活动 #${currentSale.flash_sale_id}`}</span>
                  <span className="text-[10px] text-muted-foreground">·</span>
                  <span className="text-[10px] text-muted-foreground">{fmtTime(currentSale.start_time)} ~ {fmtTime(currentSale.end_time)}</span>
                  <span className="text-[10px] text-muted-foreground">·</span>
                  <span className="text-[10px] font-medium text-foreground/70">{statusText}</span>
                  <span className="text-[10px] text-muted-foreground">·</span>
                  <span className="text-[10px] text-muted-foreground">{products.length} 个商品</span>
                </div>
              </div>
            );
          })()}

          {/* ===== P0: 复制完成通知 ===== */}
          {_completedCopyInfo && _completedCopyInfo.isNew && (
            <div className="bg-gradient-to-r from-shopee-green/10 to-shopee-brand-light border border-shopee-green/30 rounded-lg px-3 py-2.5 shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-shopee-green/15 flex items-center justify-center shrink-0">
                    <svg className="w-3.5 h-3.5 text-shopee-green" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-shopee-green">复制完成</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      来自 {_completedCopyInfo.sourceFlashSaleName || '历史活动'} · 活动 #{_completedCopyInfo.newFlashSaleId}
                    </p>
                  </div>
                </div>
                <button
                  className="h-7 px-3 text-xs font-medium text-white bg-shopee-brand rounded-md hover:bg-shopee-brand-dark shadow-sm shrink-0 ml-2"
                  onClick={async () => {
                    await fetchFlashSaleList(true);
                    await loadFlashSaleProducts(_completedCopyInfo.newFlashSaleId);
                    acknowledgeCompletedCopy();
                  }}
                >
                  立即查看
                </button>
              </div>
            </div>
          )}

          {/* ===== P1: 定时任务状态 ===== */}
          <ScheduledTaskCard />

          {/* ===== 错误提示 — 紧跟上下文（有错误时这是最高优先级信息）===== */}
          {error && (
            <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md whitespace-pre-line">
                <div className="flex items-start gap-2">
                <svg className="w-4 h-4 mt-0.5 shrink-0 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <div>
                  <p className="font-medium">错误</p>
                  <p className="mt-1 text-red-600">{error}</p>
                  {error.includes('SPC_CDS') && (
                    <div className="mt-2 space-y-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs font-normal"
                        disabled={isExtracting}
                        onClick={() => extractSpcCds()}
                      >
                        {isExtracting ? '获取中...' : '重新获取 SPC_CDS'}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        查看后台日志: chrome://extensions → 点击"Service Worker"
                      </p>
                    </div>
                  )}
                  {error.includes('刷新页面') && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      提示：刷新 seller.shopee.tw 页面后，重新打开扩展即可
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ===== 限时特卖活动列表（紧凑）===== */}
          {flashSaleList.length > 0 && (
            <div className="space-y-1.5">
              <div
                className="flex items-center justify-between cursor-pointer select-none"
                onClick={() => setFlashSaleListOpen(!flashSaleListOpen)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <label className="text-xs font-medium text-muted-foreground shrink-0">限时特卖活动</label>
                  {flashSaleId && !flashSaleListOpen && (() => {
                    const sel = flashSaleList.find(s => s.flash_sale_id === flashSaleId);
                    return sel ? (
                      <span className="text-xs text-shopee-brand truncate font-medium">{sel.name || `活动 #${sel.flash_sale_id}`}</span>
                    ) : null;
                  })()}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs font-normal border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-50"
                    disabled={isClearingCache}
                    onClick={e => {
                      e.stopPropagation();
                      setIsClearingCache(true);
                      clearCache().then(() => { reset(); extractSpcCds(); }).finally(() => setIsClearingCache(false));
                    }}
                  >
                    <span className="mr-1">
                      <svg className={`w-3 h-3 ${isClearingCache ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        {isClearingCache
                          ? <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                          : <><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></>
                        }
                      </svg>
                    </span>
                    {isClearingCache ? '清除中' : '清除缓存'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs font-normal"
                    disabled={isLoadingFlashSaleList}
                    onClick={e => { e.stopPropagation(); fetchFlashSaleList(true); setFlashSaleListOpen(true); }}
                  >
                    <span className={isLoadingFlashSaleList ? 'mr-1' : 'mr-1'}>
                      <svg className={`w-3 h-3 ${isLoadingFlashSaleList ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                      </svg>
                    </span>
                    {isLoadingFlashSaleList ? '刷新中' : '刷新'}
                  </Button>
                  <span className={`text-muted-foreground transition-transform ${flashSaleListOpen ? 'rotate-180' : ''}`}>▼</span>
                </div>
              </div>

              {flashSaleListOpen && (
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {flashSaleList.map(sale => {
                    const now = Math.floor(Date.now() / 1000);
                    const isActive = now >= sale.start_time && now < sale.end_time;
                    const isUpcoming = sale.start_time > now;
                    const isEnded = now >= sale.end_time;
                    const isSelected = flashSaleId === sale.flash_sale_id;

                    let statusLabel = '已结束';
                    let statusClass = 'text-gray-500 bg-gray-50 border-gray-200';
                    if (isActive) { statusLabel = '进行中'; statusClass = 'text-shopee-green bg-shopee-green/5 border-shopee-green/20'; }
                    else if (isUpcoming) { statusLabel = '即将开始'; statusClass = 'text-shopee-brand bg-shopee-brand-light border-shopee-brand/20'; }

                    return (
                      <div
                        key={sale.flash_sale_id}
                        className={`w-full flex items-center justify-between px-3 py-2 text-xs border rounded-md transition-colors ${
                          isEnded
                            ? 'opacity-50 border-dashed'
                            : 'cursor-pointer hover:bg-accent/50'
                        } ${
                          isSelected && !isEnded
                            ? 'border-l-4 border-l-shopee-brand bg-shopee-brand-light/50'
                            : ''
                        } ${isLoadingFlashSales ? 'opacity-50 pointer-events-none' : ''}`}
                        aria-current={isSelected ? 'true' : undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (isEnded) return;
                          loadFlashSaleProducts(sale.flash_sale_id);
                          setFlashSaleListOpen(false);
                        }}
                      >
                        <div className="flex flex-col items-start min-w-0">
                          <span className={`font-medium truncate w-full text-left ${isSelected ? 'text-shopee-brand' : ''}`}>
                            {sale.name || `活动 #${sale.flash_sale_id}`}
                          </span>
                          <span className="text-[10px] text-muted-foreground mt-0.5">
                            {fmtTime(sale.start_time)} ~ {fmtTime(sale.end_time)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {isSelected && (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full border border-shopee-brand/30 bg-shopee-brand-light text-shopee-brand">
                              当前选中
                            </span>
                          )}
                          <Button
                            variant="default"
                            size="sm"
                            className="h-6 px-2 text-[11px] font-semibold bg-shopee-brand text-white hover:bg-shopee-brand-dark shadow-sm"
                            onClick={(e) => { e.stopPropagation(); enterCopyMode(sale); }}
                            title="复制此限时特卖到新的时间段"
                          >
                            复制
                          </Button>
                          {_completedCopyInfo && sale.flash_sale_id === _completedCopyInfo.newFlashSaleId && _completedCopyInfo.isNew && (
                            <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-50 text-amber-700 border border-amber-300">
                              新/待开启
                            </span>
                          )}
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
          )}

          {/* ===== 复制引导提示 ===== */}
          {flashSaleList.length > 0 && !hasScheduledCopy && !copyMode && !_completedCopyInfo && (
            <div className="bg-gradient-to-r from-shopee-brand-light to-teal-50 border border-shopee-brand/20 rounded-lg px-3 py-2.5 text-xs text-shopee-brand-dark">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 mt-0.5 shrink-0 text-shopee-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                </svg>
                <div>
                  <p className="font-medium">复制活动到新时间段</p>
                  <p className="mt-0.5 text-shopee-brand-dark/70">点击活动右侧的「复制」按钮，将此活动的商品复制到新的时间段</p>
                </div>
              </div>
            </div>
          )}

          {/* 限时特卖信息 */}
          {flashSaleInfo && (
            <div className="px-2 py-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded-md">
              {flashSaleInfo}
            </div>
          )}

          {/* ===== P1: 连贯操作区 — 商品列表 + 开启 ===== */}
          {/* 商品列表 */}
          {products.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-1">
              {overrideSummary.skuCount > 0 && (
                <div className="flex items-center justify-between text-xs text-shopee-brand-dark bg-shopee-brand-light border border-shopee-brand/15 rounded px-2 py-1.5 mb-1">
                  <span>已手动编辑 {overrideSummary.productCount} 个商品 / {overrideSummary.skuCount} 个 SKU</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-5 px-1.5 text-[10px] font-normal border-shopee-brand/30 text-shopee-brand hover:bg-shopee-brand-light"
                    onClick={() => setOverrideDetailOpen(true)}
                  >
                    查看详情
                  </Button>
                </div>
              )}
              <ProductList
                products={products}
                oneDaySkuSelectedIds={oneDaySkuSelectedIds}
                onToggleOneDaySku={toggleOneDaySkuSelection}
                onSelectAllOneDaySku={setOneDaySkuSelection}
              />
            </div>
          )}

          {/* ===== P1.5: 1 天备货 SKU 修复（无需选中活动即可使用）===== */}
          {products.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50/70 px-2.5 py-2 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-amber-900">1 天备货 SKU 修复</div>
                  <div className="text-[11px] text-amber-700">
                    已选 {oneDaySkuSelectedIds.length} 个商品，系统将修复这些商品，使其能够开启限时特卖。
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 border-amber-300 bg-white px-2 text-xs text-amber-800 hover:bg-amber-100"
                  disabled={oneDaySkuFlow.running || isEnabling || oneDaySkuSelectedIds.length === 0}
                  onClick={() => runOneDaySkuAndEnable()}
                >
                  {oneDaySkuFlow.running ? '处理中...' : '一键修复并开启'}
                </Button>
              </div>

              {oneDaySkuFlow.phase !== 'idle' && (
                <div className="space-y-1 text-[11px] text-amber-900">
                  <div className="flex items-center justify-between">
                    <span className="shrink-0 rounded border border-amber-200 bg-white px-1.5 py-0.5 text-[10px] text-amber-800">
                      {oneDaySkuPhaseLabel}
                    </span>
                    <span className="min-w-0 flex-1 truncate px-2">{oneDaySkuFlow.message || '等待处理'}</span>
                    <span>{oneDaySkuFlow.currentIndex}/{oneDaySkuFlow.total}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-amber-100">
                    <div
                      className="h-full rounded-full bg-amber-500 transition-all"
                      style={{ width: `${oneDaySkuFlow.total ? Math.round(oneDaySkuFlow.currentIndex / oneDaySkuFlow.total * 100) : 0}%` }}
                    />
                  </div>
                  {oneDaySkuFlow.error && (
                    <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-700 space-y-1">
                      <div>{oneDaySkuFlow.error}</div>
                      {oneDaySkuFlow.phase === 'failed' && (
                        <div className="text-[10px] text-red-600">
                          部分商品处理失败，详情见下方列表。
                        </div>
                      )}
                    </div>
                  )}
                  {oneDaySkuFlow.items.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-amber-700 hover:text-amber-900">
                        处理详情 ({oneDaySkuFlow.items.length})
                      </summary>
                      <div className="mt-1 max-h-28 space-y-1 overflow-y-auto">
                        {oneDaySkuFlow.items.map(item => (
                          <div key={item.itemId} className="rounded border border-amber-100 bg-white px-2 py-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-medium">{item.itemName}</span>
                              <span className={item.publishStatus === 'failed' ? 'text-red-600' : 'text-green-600'}>
                                {item.publishStatus === 'failed' ? '处理失败' : item.hasOneDaySku ? '已有专用 SKU' : '待补充 SKU'}
                              </span>
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              ID: {item.itemId} · 最高价: {item.highestPrice ?? '-'}
                            </div>
                            {item.discounts && item.discounts.length > 0 && (
                              <div className="text-[10px] text-amber-700">
                                折扣活动: {item.discounts.map(d => `${d.name} (#${d.promotionId})`).join('，')}
                                {item.discountRestored && <span className="text-green-600"> · 已恢复</span>}
                                {item.discountRemoved && !item.discountRestored && <span className="text-red-600"> · 恢复失败</span>}
                              </div>
                            )}
                            {item.error && <div className="text-[10px] text-red-600">{item.error}</div>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )}

              {/* Wizard Phase 1: 编辑参数 */}
              {oneDaySkuFlow.phase === 'editing_params' && (
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-green-800">{oneDaySkuFlow.message}</div>

                  {/* 修复成功的商品卡片 */}
                  <div className="max-h-36 space-y-1 overflow-y-auto">
                    {products.filter(p => oneDaySkuFlow.items.some(
                      i => i.itemId === p.itemid && i.publishStatus === 'success'
                    )).map(p => {
                      const hasOverrides = p.modelList.some(m => `${p.itemid}-${m.modelid}` in skuOverrides);
                      return (
                        <div
                          key={p.itemid}
                          className={`flex items-center gap-2 rounded border bg-white px-2 py-1.5 cursor-pointer hover:bg-accent transition-colors ${hasOverrides ? 'border-l-2 border-l-shopee-brand' : 'border-green-200'}`}
                          onClick={() => setWizardEditProduct(p)}
                        >
                          <div className="w-7 h-7 rounded overflow-hidden bg-muted shrink-0">
                            {p.images?.[0] ? (
                              <img src={`https://cf.shopee.tw/file/${p.images[0]}_tn`} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-[8px] text-muted-foreground">无图</div>
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-medium truncate">{p.name}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {p.modelList.length} SKU · 价格: NT${Number(p.originPrice || p.inputOriginPrice || 0).toLocaleString()}
                              {hasOverrides && <span className="ml-1 text-shopee-brand font-medium">已编辑</span>}
                            </div>
                          </div>
                          <svg className="w-3 h-3 shrink-0 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                        </div>
                      );
                    })}
                  </div>
                  {products.length === 0 && (
                    <div className="text-[10px] text-muted-foreground text-center py-2">正在加载商品数据...</div>
                  )}

                  {/* 全局参数 */}
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <span>折扣率</span>
                      <input type="number" min={1} max={100} value={discountRate} onChange={e => setDiscountRate(Math.max(1, Math.min(100, Number(e.target.value) || 60)))} className="w-10 px-1 py-0.5 border rounded text-center text-[10px]" />
                      <span>%</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span>库存</span>
                      <input type="number" min={1} value={flashSaleStock} onChange={e => setFlashSaleStock(Math.max(1, Number(e.target.value) || 200))} className="w-10 px-1 py-0.5 border rounded text-center text-[10px]" />
                    </div>
                    <div className="flex items-center gap-1">
                      <span>限购</span>
                      <input type="number" min={0} value={purchaseLimit} onChange={e => setPurchaseLimit(Math.max(0, Number(e.target.value) || 0))} className="w-10 px-1 py-0.5 border rounded text-center text-[10px]" />
                    </div>
                  </div>

                  <Button
                    size="sm"
                    className="w-full h-7 text-xs bg-shopee-brand hover:bg-shopee-brand/90"
                    onClick={() => goToFlashSaleSelection()}
                  >
                    下一步：选择限时特卖
                  </Button>
                </div>
              )}

              {/* Wizard Phase 2: 选择闪购 */}
              {oneDaySkuFlow.phase === 'selecting_flash_sale' && (
                <div className="space-y-2 rounded border border-blue-200 bg-blue-50/60 px-2 py-2">
                  <div className="text-[11px] font-medium text-blue-900">选择目标限时特卖</div>

                  {/* 时间控制 */}
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <div className="flex items-center gap-1">
                      <span className="whitespace-nowrap">提前</span>
                      <input
                        type="number"
                        min={0}
                        max={120}
                        value={wizardAdvanceMin}
                        onChange={e => setWizardAdvanceMin(e.target.value.replace(/^0+/, '') || '0')}
                        className="w-8 px-1 py-0.5 border rounded text-center text-[10px]"
                        title="提前 N 分钟创建空活动（0 = 立即创建）"
                      />
                      <span className="whitespace-nowrap">分钟创建空活动</span>
                    </div>
                    <span className="text-muted-foreground/40">|</span>
                    <div className="flex items-center gap-1">
                      <span className="whitespace-nowrap">活动开始后</span>
                      <input
                        type="number"
                        min={1}
                        max={120}
                        value={wizardDelayMin}
                        onChange={e => setWizardDelayMin(e.target.value.replace(/^0+/, '') || '1')}
                        className="w-8 px-1 py-0.5 border rounded text-center text-[10px]"
                        title="活动开始后 N 分钟提交商品"
                      />
                      <span className="whitespace-nowrap">分钟提交商品</span>
                    </div>
                  </div>

                  {/* 定时开启状态消息 */}
                  {oneDaySkuFlow.message && (
                    <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-800">
                      {oneDaySkuFlow.message}
                    </div>
                  )}

                  {/* 已有闪购列表 */}
                  {flashSaleList.filter(s => s.status === 0 || s.status === 1).length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] text-blue-700">添加到已有场次：</div>
                      {flashSaleList
                        .filter(s => s.status === 0 || s.status === 1)
                        .slice(0, 5)
                        .map(sale => {
                          const now = Math.floor(Date.now() / 1000);
                          const isActive = now >= sale.start_time && now < sale.end_time;
                          const isUpcoming = sale.start_time > now;
                          return (
                            <div key={sale.flash_sale_id} className="flex items-center gap-1">
                              <div className="flex-1 min-w-0 rounded border border-blue-200 bg-white px-2 py-1.5">
                                <div className="text-[11px] font-medium truncate">{sale.name || `限时特卖 #${sale.flash_sale_id}`}</div>
                                <div className="text-[10px] text-muted-foreground">
                                  {fmtTime(sale.start_time)}
                                  {isActive ? <span className="text-shopee-green font-medium"> 进行中</span> : <span className="text-blue-600"> 即将开始</span>}
                                </div>
                              </div>
                              <Button
                                size="sm"
                                className="h-7 shrink-0 px-2 text-[10px] bg-green-600 hover:bg-green-700 text-white"
                                onClick={() => addToExistingFlashSale(sale.flash_sale_id)}
                              >
                                立即加入
                              </Button>
                              {isUpcoming && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 shrink-0 px-1.5 text-[10px] border-amber-300 text-amber-700 hover:bg-amber-50"
                                  title={`活动开始后 ${wizardDelayMin} 分钟自动提交 (${fmtTime(sale.start_time + Math.max(1, parseInt(wizardDelayMin) || 5) * 60)})`}
                                  onClick={() => {
                                    const dm = Math.max(1, parseInt(wizardDelayMin) || 5);
                                    scheduleEnableForFlashSale(sale.flash_sale_id, sale.start_time, sale.name || `活动 #${sale.flash_sale_id}`, dm);
                                  }}
                                >
                                  <svg className="w-3 h-3 mr-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                                  </svg>
                                  定时
                                </Button>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}

                  {/* 创建新场次 */}
                  <div className="space-y-1">
                    <div className="text-[10px] text-blue-700">
                      {flashSaleList.filter(s => s.status === 0 || s.status === 1).length > 0 ? '或创建新场次：' : '创建新场次：'}
                    </div>
                    {!phase3Slots ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full h-7 text-[11px] border-blue-300 text-blue-700 hover:bg-blue-50"
                        disabled={phase3SlotsLoading}
                        onClick={async () => {
                          setPhase3SlotsLoading(true);
                          try {
                            const slots = await fetchTimeSlots();
                            setPhase3Slots(slots);
                            // 自动选中第一个未来场次
                            const firstFuture = slots.find((s: TimeSlot) => s.start_time > Math.floor(Date.now() / 1000));
                            if (firstFuture) setSelectedWizardSlotId(firstFuture.timeslot_id);
                          } finally {
                            setPhase3SlotsLoading(false);
                          }
                        }}
                      >
                        {phase3SlotsLoading ? '加载中...' : '+ 创建新限时特卖场次'}
                      </Button>
                    ) : (
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {phase3Slots
                          .filter(s => s.start_time > Math.floor(Date.now() / 1000))
                          .slice(0, 5)
                          .map(slot => {
                            const isSelected = selectedWizardSlotId === slot.timeslot_id;
                            return (
                              <div
                                key={slot.timeslot_id}
                                className={`flex items-center gap-1 rounded border px-2 py-1.5 cursor-pointer transition-colors ${
                                  isSelected
                                    ? 'border-shopee-brand bg-shopee-brand-light'
                                    : 'border-blue-200 bg-white hover:border-shopee-brand/50'
                                }`}
                                onClick={() => setSelectedWizardSlotId(slot.timeslot_id)}
                              >
                                <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                  isSelected ? 'border-shopee-brand' : 'border-muted-foreground/30'
                                }`}>
                                  {isSelected && <div className="w-2 h-2 rounded-full bg-shopee-brand" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="text-[11px] font-medium">{fmtTime(slot.start_time)}</div>
                                  <div className="text-[10px] text-muted-foreground">ID: {slot.timeslot_id}</div>
                                </div>
                              </div>
                            );
                          })}
                      </div>
                    )}
                  </div>

                  {/* 统一的开始按钮 */}
                  {phase3Slots && (
                    <Button
                      size="sm"
                      className="w-full h-8 text-xs bg-shopee-brand hover:bg-shopee-brand/90 text-white disabled:opacity-50"
                      disabled={!selectedWizardSlotId || isEnabling || oneDaySkuFlow.running}
                      onClick={() => {
                        const slot = phase3Slots.find(s => s.timeslot_id === selectedWizardSlotId);
                        if (!slot) return;
                        const am = Math.max(0, parseInt(wizardAdvanceMin) || 0);
                        const dm = Math.max(1, parseInt(wizardDelayMin) || 5);
                        createNewFlashSaleAndAdd(slot.timeslot_id, slot.start_time, am, dm);
                      }}
                    >
                      {selectedWizardSlotId ? '开始' : '请先选择一个场次'}
                    </Button>
                  )}


                  {/* 折叠处理详情 */}
                  {oneDaySkuFlow.items.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-[10px] text-blue-600 hover:text-blue-800">
                        查看处理详情 ({oneDaySkuFlow.items.length})
                      </summary>
                      <div className="mt-1 max-h-24 space-y-1 overflow-y-auto">
                        {oneDaySkuFlow.items.filter(i => i.publishStatus === 'success').map(item => (
                          <div key={item.itemId} className="rounded border border-amber-100 bg-white px-2 py-1 text-[10px]">
                            <span className="truncate font-medium">{item.itemName}</span>
                            <span className="text-muted-foreground"> · ID: {item.itemId}</span>
                            {item.skuCreated && <span className="text-green-600"> · 新增SKU</span>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  <button
                    className="w-full text-center text-[10px] text-muted-foreground hover:text-foreground py-0.5"
                    onClick={() => {
                      useAppStore.setState(state2 => ({
                        oneDaySkuFlow: { ...state2.oneDaySkuFlow, phase: 'editing_params' as const },
                      }));
                    }}
                  >
                    ← 返回编辑参数
                  </button>
                </div>
              )}

              {/* Wizard Phase 3: 正在开启限时特卖 */}
              {oneDaySkuFlow.phase === 'starting_flash_sale' && (
                <div className="space-y-2 rounded border border-green-200 bg-green-50/60 px-2 py-2">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full border-2 border-green-500 border-t-transparent animate-spin shrink-0" />
                    <span className="text-[11px] font-medium text-green-800">{oneDaySkuFlow.message || '正在提交...'}</span>
                  </div>

                  {enableProgress && (
                    <div className="space-y-1 text-[10px]">
                      <div className="flex justify-between text-muted-foreground">
                        <span>第 {enableProgress.currentRound}/{infiniteRetry ? '∞' : enableProgress.maxRetries} 轮</span>
                        <span>成功 {enableProgress.successSkus} / 失败 {enableProgress.failedSkus} / 共 {enableProgress.totalSkus}</span>
                      </div>
                      <div className="w-full h-1.5 bg-green-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-green-500 rounded-full transition-all"
                          style={{ width: `${enableProgress.totalSkus ? Math.round(enableProgress.successSkus / enableProgress.totalSkus * 100) : 0}%` }}
                        />
                      </div>
                      {enableProgress.isComplete && (
                        <p className={enableProgress.failedSkus === 0 ? 'text-green-700 font-medium' : 'text-amber-700'}>
                          {enableProgress.failedSkus === 0
                            ? '全部 SKU 开启成功！'
                            : `已完成，剩余 ${enableProgress.failedSkus} 个 SKU 未成功`}
                        </p>
                      )}
                    </div>
                  )}

                  {!enableProgress && !oneDaySkuFlow.error && (
                    <p className="text-[10px] text-muted-foreground">等待 Background Service Worker 响应...</p>
                  )}

                  {oneDaySkuFlow.error && (
                    <div className="rounded border border-red-200 bg-red-50 px-2 py-1 text-[10px] text-red-700">{oneDaySkuFlow.error}</div>
                  )}

                  {isEnabling && (
                    <button
                      className="w-full text-center text-[10px] text-red-500 hover:text-red-700 py-0.5"
                      onClick={() => stopEnabling()}
                    >
                      停止并返回
                    </button>
                  )}

                  {!isEnabling && oneDaySkuFlow.phase === 'starting_flash_sale' && (
                    <button
                      className="w-full text-center text-[10px] text-muted-foreground hover:text-foreground py-0.5"
                      onClick={() => {
                        useAppStore.setState(state2 => ({
                          oneDaySkuFlow: { ...state2.oneDaySkuFlow, phase: 'selecting_flash_sale' as const, error: null },
                        }));
                      }}
                    >
                      ← 返回选择场次
                    </button>
                  )}
                </div>
              )}

              {/* Wizard SkuTable 弹窗 */}
              {wizardEditProduct && (
                <SkuTable key={wizardEditProduct.itemid} product={wizardEditProduct} onClose={() => setWizardEditProduct(null)} />
              )}
            </div>
          )}

          {/* 空状态 */}
          {!isLoading && !error && products.length === 0 && isConnected && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <p>输入商品 ID 并点击"加载限时特卖列表"</p>
              <p className="mt-1 text-xs">或在下方「更多」中手动输入商品 ID</p>
            </div>
          )}

          {/* ===== 开启限时特卖 — 紧连商品列表 ===== */}
          {products.length > 0 && flashSaleId && (
            <div className="space-y-3 pt-1">
              <Separator />
              <div className="text-sm font-medium">开启限时特卖</div>

              {overrideSummary.skuCount > 0 && (
                <div className="flex items-center justify-between gap-2 rounded-md border border-shopee-brand/15 bg-shopee-brand-light px-2 py-1.5 text-xs text-shopee-brand-dark">
                  <span>
                    已有 {overrideSummary.productCount} 个商品 / {overrideSummary.skuCount} 个 SKU 手动修改过，不会使用下列折扣
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs font-normal border-shopee-brand/30 bg-white text-shopee-brand hover:bg-shopee-brand-light"
                    onClick={() => setOverrideDetailOpen(true)}
                  >
                    查看
                  </Button>
                </div>
              )}

              {/* 折扣率 + 活动库存 + 限购数量 */}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <span className="whitespace-nowrap">折扣率 (%)</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={discountRate}
                    onChange={e => setDiscountRate(Math.max(1, Math.min(100, Number(e.target.value) || 60)))}
                    className="w-14 px-1.5 py-1 border rounded text-center"
                    disabled={isEnabling || oneDaySkuFlow.running}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="whitespace-nowrap">活动库存</span>
                  <input
                    type="number"
                    min={1}
                    value={flashSaleStock}
                    onChange={e => setFlashSaleStock(Math.max(1, Number(e.target.value) || 200))}
                    className="w-14 px-1.5 py-1 border rounded text-center"
                    disabled={isEnabling || oneDaySkuFlow.running}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="whitespace-nowrap">限购数量</span>
                  <input
                    type="number"
                    min={0}
                    value={purchaseLimit}
                    onChange={e => setPurchaseLimit(Math.max(0, Number(e.target.value) || 0))}
                    className="w-14 px-1.5 py-1 border rounded text-center"
                    disabled={isEnabling || oneDaySkuFlow.running}
                  />
                </div>
              </div>

              {/* 重试次数 */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>最大重试次数</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxRetries}
                  onChange={e => setMaxRetries(Math.max(1, Number(e.target.value) || 1))}
                  className="w-16 px-2 py-1 border rounded text-center"
                  disabled={isEnabling || oneDaySkuFlow.running || infiniteRetry}
                />
                <label className="flex items-center gap-1 ml-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={infiniteRetry}
                    onChange={e => setInfiniteRetry(e.target.checked)}
                    disabled={isEnabling || oneDaySkuFlow.running}
                    className="cursor-pointer"
                  />
                  <span>无限重试</span>
                </label>
              </div>

              {/* 开启 / 停止 */}
              {!isEnabling ? (
                <button
                  className="w-full py-2.5 text-sm font-semibold text-white bg-shopee-brand rounded-md hover:bg-shopee-brand-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  disabled={isEnabling || oneDaySkuFlow.running}
                  onClick={() => enableFlashSaleItems()}
                >
                  开启限时特卖
                </button>
              ) : (
                <button
                  className="w-full py-2 text-sm font-medium border-2 border-red-400 text-red-600 bg-white rounded-md hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isStopping}
                  onClick={async () => {
                    setIsStopping(true);
                    await stopEnabling();
                    setIsStopping(false);
                  }}
                >
                  {isStopping ? '停止中...' : '停止'}
                </button>
              )}

              {/* 已结束活动提示 */}
              {(() => {
                const currentSale = flashSaleList.find(s => s.flash_sale_id === flashSaleId);
                if (!currentSale) return null;
                if (Math.floor(Date.now() / 1000) < currentSale.end_time) return null;
                return (
                  <div className="p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
                    该活动已结束无法开启，请点击「复制」复制此活动而不是选中此活动
                  </div>
                );
              })()}

              {/* 进度 */}
              {enableProgress && (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span>第 {enableProgress.currentRound}/{infiniteRetry ? '∞' : enableProgress.maxRetries} 轮</span>
                    <span>成功 {enableProgress.successSkus} / 失败 {enableProgress.failedSkus} / 共 {enableProgress.totalSkus}</span>
                  </div>
                  <div className="w-full h-2 bg-shopee-brand/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-shopee-brand rounded-full transition-all"
                      style={{ width: `${(enableProgress.successSkus / enableProgress.totalSkus) * 100}%` }}
                    />
                  </div>
                  {enableProgress.isComplete && (
                    <p className="text-shopee-green font-medium">
                      {enableProgress.failedSkus === 0
                        ? '全部 SKU 开启成功！'
                        : `已完成，剩余 ${enableProgress.failedSkus} 个 SKU 无法开启`}
                    </p>
                  )}
                  {enableProgress.nextRetryItems.length > 0 && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        失败详情 ({enableProgress.nextRetryItems.length} 个 SKU)
                      </summary>
                      <div className="mt-1 max-h-32 overflow-y-auto space-y-1">
                        {enableProgress.nextRetryItems.slice(0, 20).map((item, i) => (
                          <div key={i} className="p-1.5 text-[10px] bg-red-50 border border-red-100 rounded">
                            <div className="font-medium text-red-800">item {item.item_id} / model {item.model_id}</div>
                            {item.err_msg && <div className="text-red-600">{item.err_msg}</div>}
                            {item.unqualified_conditions?.map((u, j) => (
                              <div key={j} className="mt-0.5 text-yellow-700">
                                不符合条件: code={u.unqualified_code} value={u.value}{u.params?.length > 0 ? ` params=${u.params.join(',')}` : ''}
                              </div>
                            ))}
                          </div>
                        ))}
                        {enableProgress.nextRetryItems.length > 20 && (
                          <div className="text-[10px] text-muted-foreground text-center">
                            ...还有 {enableProgress.nextRetryItems.length - 20} 个
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                  {enableProgress.hardFailedSkus && enableProgress.hardFailedSkus.length > 0 && (
                    <div className="mt-2 p-2 text-xs bg-orange-50 border border-orange-200 rounded-md">
                      <div className="flex items-start gap-1.5">
                        <svg className="w-4 h-4 mt-0.5 shrink-0 text-orange-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                          </svg>
                        <div>
                          <p className="font-medium text-orange-800">价格超出限时特卖上限</p>
                          <p className="mt-0.5 text-orange-700">
                            {enableProgress.hardFailedSkus.length} 个 SKU 促销价过高，已自动排除。
                          </p>
                        </div>
                      </div>
                      <details className="mt-1">
                        <summary className="cursor-pointer text-orange-700 hover:text-orange-800">
                          查看详情 ({enableProgress.hardFailedSkus.length} 个 SKU)
                        </summary>
                        <div className="mt-1 max-h-24 overflow-y-auto space-y-1">
                          {enableProgress.hardFailedSkus.slice(0, 20).map((item, i) => {
                            const priceCond = item.unqualified_conditions?.find(c => c.unqualified_code === 10010);
                            const promoPrice = priceCond ? Math.floor(Number(priceCond.value) / 100000) : 0;
                            const floorPrice = priceCond ? Math.floor(Number(priceCond.params?.[0] || 0) / 100000) : 0;
                            return (
                              <div
                                key={i}
                                className="p-1.5 text-[10px] bg-white border border-orange-100 rounded cursor-pointer hover:bg-orange-50/50 transition-colors"
                                onClick={() => {
                                  const product = products.find(p => p.itemid === String(item.item_id));
                                  if (product) setSelectedFailedProduct(product);
                                }}
                              >
                                <div className="font-medium text-orange-800">item {item.item_id} / model {item.model_id}</div>
                                {priceCond && (
                                  <div className="text-orange-600">
                                    促销价: {promoPrice} &gt; 最低价: {floorPrice}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </details>
                    </div>
                  )}
                  {enableProgress.lastResponsePreview && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">API 响应预览</summary>
                      <pre className="mt-1 p-2 text-[10px] bg-gray-50 border rounded max-h-32 overflow-auto whitespace-pre-wrap break-all">
                        {enableProgress.lastResponsePreview}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ===== P2: 更多（低频功能折叠）===== */}
          <details className="-mb-1">
            <summary className="cursor-pointer text-xs text-gray-400 hover:text-gray-600 select-none">
              更多
            </summary>
            <div className="mt-2 space-y-3">
              {/* 商品 ID 输入 */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground/60">商品 ID</span>
                    {productIds.length > 0 && (
                      <span className="text-[10px] bg-muted text-muted-foreground px-1.5 py-0.5 rounded">{productIds.length}</span>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-5 px-1.5 text-[10px] font-normal text-muted-foreground/40 border-muted-foreground/20 hover:bg-shopee-brand-light hover:text-shopee-brand hover:border-shopee-brand/30"
                    onClick={handlePaste}
                  >
                    粘贴
                  </Button>
                </div>
                <textarea
                  ref={textareaRef}
                  className="w-full h-16 px-2 py-1 text-[11px] border border-dashed border-muted-foreground/20 rounded-md resize-none focus:outline-none focus:ring-1 focus:ring-primary focus:border-solid text-muted-foreground/60 placeholder-muted-foreground/30"
                  placeholder="粘贴商品 ID 后将自动识别"
                  value={inputText}
                  onChange={handleInputChange}
                />
              </div>

              {/* 获取商品信息 */}
              <button
                className="w-full py-2 text-sm font-medium text-white bg-shopee-brand rounded-md hover:bg-shopee-brand-dark shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!isConnected || isLoading || inputText.trim().length === 0}
                onClick={handleFetch}
              >
                {isLoading ? '加载中...' : '获取商品信息'}
              </button>

              {/* 加载限时特卖列表（无列表时） */}
              {isConnected && flashSaleList.length === 0 && (
                <button
                  className="w-full py-2 text-sm font-medium border border-shopee-brand/30 text-shopee-brand rounded-md hover:bg-shopee-brand-light disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isLoadingFlashSaleList || isLoading}
                  onClick={() => fetchFlashSaleList()}
                >
                  {isLoadingFlashSaleList ? '加载中...' : '加载限时特卖列表'}
                </button>
              )}

              {/* 模板（仅在有商品时） */}
              {products.length > 0 && <TemplateManager />}

              {/* 高级操作 */}
              <div className="pt-1 space-y-2">
                <button
                  className="w-full py-2 text-sm font-medium border border-dashed border-muted-foreground/30 text-muted-foreground/60 rounded-md hover:border-shopee-brand/30 hover:text-shopee-brand hover:bg-shopee-brand-light/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  disabled={!hasScheduledCopy || isEnabling || isTriggeringScheduled}
                  onClick={async () => {
                    setIsTriggeringScheduled(true);
                    try {
                      await triggerScheduledCopyNow();
                    } finally {
                      setIsTriggeringScheduled(false);
                    }
                  }}
                >
                  {isTriggeringScheduled ? '执行中...' : (isEnabling ? '限时特卖进行中...' : '手动触发定时任务')}
                </button>
              </div>
            </div>
          </details>
        </CardContent>
      </Card>
      </div>
      )}
        </div>

        <div style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)', position: 'absolute', inset: 0 }}>
          <AutoModePanel onBack={exitAutoMode} />
        </div>
      </div>

      {/* 弹窗 */}
      {selectedFailedProduct && (
        <SkuTable
          key={selectedFailedProduct.itemid}
          product={selectedFailedProduct}
          onClose={() => setSelectedFailedProduct(null)}
        />
      )}

      {showUndiscountedModal && pendingUndiscountedSkus.length > 0 && (
        <UndiscountedSkuModal
          skus={pendingUndiscountedSkus}
          onClose={() => useAppStore.setState({
            showUndiscountedModal: false,
            pendingUndiscountedSkus: [],
            _enableSkipSkuKeys: [],
          })}
        />
      )}

      {overrideDetailOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl w-[460px] max-w-[95vw] max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between gap-3 p-3 border-b">
              <div>
                <h3 className="text-sm font-medium">手动修改的商品和 SKU</h3>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  共 {overrideSummary.productCount} 个商品 / {overrideSummary.skuCount} 个 SKU
                </p>
              </div>
              <button
                className="text-lg leading-none text-muted-foreground hover:text-foreground"
                onClick={() => setOverrideDetailOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="flex items-center gap-2 p-3 border-b">
              <input
                type="text"
                placeholder="搜索商品标题、商品 ID、SKU、SKU ID"
                value={overrideSearchInput}
                onChange={e => setOverrideSearchInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') setOverrideSearchQuery(overrideSearchInput);
                }}
                className="flex-1 min-w-0 px-2 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs font-normal shrink-0"
                onClick={() => setOverrideSearchQuery(overrideSearchInput)}
              >
                搜索
              </Button>
              {overrideSearchQuery.trim() && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs font-normal shrink-0"
                  onClick={() => {
                    setOverrideSearchInput('');
                    setOverrideSearchQuery('');
                  }}
                >
                  清除
                </Button>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
              {filteredOverrideProducts.map(({ product, skus }) => (
                <div key={product.itemid} className="rounded-md border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{product.name}</div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">ID: {product.itemid}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs font-normal shrink-0"
                      onClick={() => setSelectedFailedProduct(product)}
                    >
                      查看 SKU
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {skus.map(sku => (
                      <span
                        key={sku.modelid}
                        className="max-w-full truncate rounded border border-shopee-brand/15 bg-shopee-brand-light px-1.5 py-0.5 text-[10px] text-shopee-brand-dark"
                        title={`${sku.name || '默认规格'} / ${sku.modelid}`}
                      >
                        {sku.name || '默认规格'} ({sku.modelid})
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {filteredOverrideProducts.length === 0 && (
                <p className="py-6 text-center text-xs text-muted-foreground">无匹配商品或 SKU</p>
              )}
            </div>
          </div>
        </div>
      )}

      <FirstUseWarningModal />
      <FirstUseModal />

      {showCustomDev && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCustomDev(false)}>
          <div
            className="bg-white rounded-xl shadow-2xl w-[400px] max-w-[92vw] max-h-[85vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="bg-gradient-to-r from-shopee-brand to-orange-500 px-6 py-5 rounded-t-xl">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-white">定制虾皮台湾本土各种插件</h2>
                <button
                  className="text-white/70 hover:text-white text-xl leading-none"
                  onClick={() => setShowCustomDev(false)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm font-medium text-foreground">专注虾皮生态定制开发，打造专属运营利器</p>
              <p className="text-sm text-muted-foreground">我们提供一站式插件解决方案，涵盖：</p>
              <ul className="space-y-2.5">
                {[
                  'AI赋能店铺运营',
                  '热搜词深度挖掘与趋势分析',
                  '全店铺智能化管理系统',
                  '广告投放自动优化引擎',
                  '运营数据可视化报表',
                  '各类重复流程自动化定制',
                ].map((item, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-sm">
                    <span className="w-5 h-5 rounded-full bg-shopee-brand/10 text-shopee-brand flex items-center justify-center shrink-0 mt-0.5">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </span>
                    <span className="text-foreground/80">{item}</span>
                  </li>
                ))}
              </ul>
              <div className="rounded-lg bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 px-4 py-3">
                <p className="text-sm text-amber-800 leading-relaxed">
                  限时特惠活动进行中，无论你遇到什么繁琐的运营难题，都可以告诉我们，我们将为你量身定制高效解决方案，助力店铺快速增长。联系方式：微信：aluvivip
                </p>
              </div>
              <button
                className="w-full py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-shopee-brand to-orange-500 rounded-lg hover:opacity-90 transition-opacity shadow-md"
                onClick={() => setShowCustomDev(false)}
              >
                我知道了
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
