import React, { useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SpcStatus } from '@/components/product/SpcStatus';
import { Button } from '@/components/ui/button';
import { ProductList } from '@/components/product/ProductList';
import { TemplateManager } from '@/components/product/TemplateManager';
import { CopyConfirmPanel } from '@/components/product/CopyConfirmPanel';
import { CopyResultPanel } from '@/components/product/CopyResultPanel';
import { useAppStore, setupBackgroundListener } from './store';

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
    isEnabling, enableProgress, enableFlashSaleItems, stopEnabling,
    copyMode, copySource, copyTaskStatus, isCopying,
    savedTemplates, selectedTemplate,
    enterCopyMode, executeCopy, exitCopyMode,
    checkCopyTaskStatus, setSelectedTemplate, fetchTimeSlots,
    checkBackgroundStatus,
    loadCache, clearCache, reset,
  } = useAppStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [flashSaleListOpen, setFlashSaleListOpen] = useState(true);

  // 进入时如果已有上次的 SPC_CDS，尝试连接；加载缓存；检查后台状态
  useEffect(() => {
    setupBackgroundListener();
    if (!isConnected && !spcCds) {
      extractSpcCds();
    }
    loadCache();
    checkBackgroundStatus();
    checkCopyTaskStatus();
  }, []);

  // 限时特卖活动列表加载后自动展开
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
      // 粘贴失败时聚焦输入框让用户手动粘贴
      textareaRef.current?.focus();
    }
  };

  const handleFetch = () => {
    if (isConnected) {
      fetchProducts();
    }
  };

  return (
    <div className="w-[500px] min-h-[500px] p-4 bg-background">
      {copyMode === 'confirm' && copySource ? (
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
      ) : copyMode === 'result' && copyTaskStatus ? (
        <CopyResultPanel
          status={copyTaskStatus}
          onBack={exitCopyMode}
          onRetry={() => {
            if (copySource) enterCopyMode(copySource.flashSale);
          }}
        />
      ) : (
        <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">限时特卖助手</CardTitle>
            <div className="flex items-center gap-2">
                <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[10px] font-normal"
                onClick={async () => {
                  await clearCache();
                  reset();
                  extractSpcCds();
                }}
              >
                清除缓存
              </Button>
              <SpcStatus />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 商品 ID（标签展示，不常用） */}
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
                className="h-5 px-1.5 text-[10px] font-normal text-muted-foreground/40 border-muted-foreground/20 hover:text-primary hover:border-primary/30"
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

          {/* 获取商品按钮 */}
          <div className="space-y-2">
            <button
              className="w-full py-2 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={!isConnected || isLoading || inputText.trim().length === 0}
              onClick={handleFetch}
            >
              {isLoading ? '加载中...' : '获取商品信息'}
            </button>

            {/* 加载限时特卖列表 */}
            {isConnected && flashSaleList.length === 0 && (
              <button
                className="w-full py-1.5 text-sm font-medium border border-primary text-primary rounded-md hover:bg-primary/5 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={isLoadingFlashSaleList || isLoading}
                onClick={() => fetchFlashSaleList()}
              >
                {isLoadingFlashSaleList ? '加载中...' : '加载限时特卖列表'}
              </button>
            )}

            {/* 限时特卖活动列表（可折叠） */}
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
                        <span className="text-xs text-primary truncate">{sel.name || `活动 #${sel.flash_sale_id}`}</span>
                      ) : null;
                    })()}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs font-normal"
                      onClick={e => { e.stopPropagation(); fetchFlashSaleList(); setFlashSaleListOpen(true); }}
                    >
                      刷新
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
                      if (isActive) { statusLabel = '进行中'; statusClass = 'text-green-600 bg-green-50 border-green-200'; }
                      else if (isUpcoming) { statusLabel = '即将开始'; statusClass = 'text-blue-600 bg-blue-50 border-blue-200'; }

                      const fmtTime = (ts: number) => {
                        const d = new Date(ts * 1000);
                        const mm = String(d.getMonth() + 1).padStart(2, '0');
                        const dd = String(d.getDate()).padStart(2, '0');
                        const hh = String(d.getHours()).padStart(2, '0');
                        const mi = String(d.getMinutes()).padStart(2, '0');
                        return `${mm}/${dd} ${hh}:${mi}`;
                      };

                      return (
                        <div
                          key={sale.flash_sale_id}
                          className={`w-full flex items-center justify-between px-3 py-2 text-xs border rounded-md transition-colors cursor-pointer ${
                            isSelected
                              ? 'border-primary bg-primary/5'
                              : 'hover:bg-accent/50'
                          } ${isLoadingFlashSales ? 'opacity-50 pointer-events-none' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            loadFlashSaleProducts(sale.flash_sale_id);
                            setFlashSaleListOpen(false);
                          }}
                        >
                          <div className="flex flex-col items-start min-w-0">
                            <span className={`font-medium truncate w-full text-left ${isSelected ? 'text-primary' : ''}`}>
                              {sale.name || `活动 #${sale.flash_sale_id}`}
                            </span>
                            <span className="text-[10px] text-muted-foreground mt-0.5">
                              {fmtTime(sale.start_time)} ~ {fmtTime(sale.end_time)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-5 px-1.5 text-[10px] font-normal text-primary border-primary/30 hover:bg-primary/5"
                              onClick={(e) => { e.stopPropagation(); enterCopyMode(sale); }}
                              title="复制此限时特卖"
                            >
                              复制
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
            )}

            {/* 限时特卖信息 */}
            {flashSaleInfo && (
              <div className="px-2 py-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded-md">
                {flashSaleInfo}
              </div>
            )}
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md whitespace-pre-line">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">⚠</span>
                <div>
                  <p className="font-medium">错误</p>
                  <p className="mt-1 text-red-600">{error}</p>
                  {error.includes('SPC_CDS') && (
                    <div className="mt-2 space-y-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs font-normal"
                        onClick={() => extractSpcCds()}
                      >
                        重新获取 SPC_CDS
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

          <Separator />

          {/* 商品列表（可滚动） */}
          {products.length > 0 && (
            <div className="max-h-48 overflow-y-auto space-y-1">
              <ProductList products={products} />
            </div>
          )}

          {/* 模板 */}
          {products.length > 0 && <TemplateManager />}

          {/* 开启限时特卖（需要已加载商品且已选活动） */}
          {products.length > 0 && flashSaleId && (
            <div className="space-y-3 pt-1">
              <Separator />
              <div className="text-sm font-medium">开启限时特卖</div>

              {/* 折扣率 + 活动库存 + 限购数量（同一行） */}
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
                    disabled={isEnabling}
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
                    disabled={isEnabling}
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
                    disabled={isEnabling}
                  />
                </div>
              </div>

              {/* 重试次数设置 */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>最大重试次数</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxRetries}
                  onChange={e => setMaxRetries(Math.max(1, Number(e.target.value) || 1))}
                  className="w-16 px-2 py-1 border rounded text-center"
                  disabled={isEnabling || infiniteRetry}
                />
                <label className="flex items-center gap-1 ml-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={infiniteRetry}
                    onChange={e => setInfiniteRetry(e.target.checked)}
                    disabled={isEnabling}
                    className="cursor-pointer"
                  />
                  <span>无限重试</span>
                </label>
              </div>

              {/* 开启 / 停止按钮 */}
              {!isEnabling ? (
                <button
                  className="w-full py-2 text-sm font-medium text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isEnabling}
                  onClick={() => enableFlashSaleItems()}
                >
                  🚀 开启限时特卖
                </button>
              ) : (
                <button
                  className="w-full py-2 text-sm font-medium text-white bg-red-500 rounded-md hover:bg-red-600"
                  onClick={() => stopEnabling()}
                >
                  ⏹ 停止
                </button>
              )}

              {/* 进度显示 */}
              {enableProgress && (
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span>第 {enableProgress.currentRound}/{infiniteRetry ? '∞' : enableProgress.maxRetries} 轮</span>
                    <span>成功 {enableProgress.successSkus} / 失败 {enableProgress.failedSkus} / 共 {enableProgress.totalSkus}</span>
                  </div>
                  <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 rounded-full transition-all"
                      style={{ width: `${(enableProgress.successSkus / enableProgress.totalSkus) * 100}%` }}
                    />
                  </div>
                  {enableProgress.isComplete && (
                    <p className="text-green-700 font-medium">
                      {enableProgress.failedSkus === 0
                        ? '✅ 全部 SKU 开启成功！'
                        : `⚠️ 已完成，剩余 ${enableProgress.failedSkus} 个 SKU 无法开启`}
                    </p>
                  )}
                  {/* 失败详情（调试用） */}
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
                  {/* 原始响应预览 */}
                  {enableProgress.lastResponsePreview && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        API 响应预览
                      </summary>
                      <pre className="mt-1 p-2 text-[10px] bg-gray-50 border rounded max-h-32 overflow-auto whitespace-pre-wrap break-all">
                        {enableProgress.lastResponsePreview}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 空状态 */}
          {!isLoading && !error && products.length === 0 && isConnected && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <p>输入商品 ID 并点击"获取商品信息"</p>
              <p className="mt-1 text-xs">商品 ID 可从虾皮后台商品列表页获取</p>
            </div>
          )}
        </CardContent>
      </Card>
      )}
    </div>
  );
}
