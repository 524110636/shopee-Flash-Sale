import React, { useEffect, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SpcStatus } from '@/components/product/SpcStatus';
import { ProductList } from '@/components/product/ProductList';
import { useAppStore } from './store';

export default function App() {
  const {
    inputText, setInputText,
    setProductIds,
    extractSpcCds, fetchProducts,
    products, isLoading, error, isConnected,
    spcCds, productIds,
  } = useAppStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 进入时如果已有上次的 SPC_CDS，尝试连接
  useEffect(() => {
    if (!isConnected && !spcCds) {
      extractSpcCds();
    }
  }, []);

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
    <div className="w-[420px] min-h-[500px] p-4 bg-background">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">限时特卖助手</CardTitle>
            <SpcStatus />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 商品 ID 输入 */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">
              商品 ID（每行一个，或逗号分隔）
            </label>
            <textarea
              ref={textareaRef}
              className="w-full h-24 px-3 py-2 text-sm border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="46707018327&#10;51707202143&#10;52257211580"
              value={inputText}
              onChange={handleInputChange}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{productIds.length > 0 ? `已识别 ${productIds.length} 个商品 ID` : '粘贴商品 ID 后将自动识别'}</span>
              <button
                className="text-primary hover:underline"
                onClick={handlePaste}
              >
                从剪贴板粘贴
              </button>
            </div>
          </div>

          {/* 获取商品按钮 */}
          <button
            className="w-full py-2 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!isConnected || isLoading || inputText.trim().length === 0}
            onClick={handleFetch}
          >
            {isLoading ? '加载中...' : isLoading ? `请求中 (${productIds.length} 个商品)` : '获取商品信息'}
          </button>

          {/* 错误提示 */}
          {error && (
            <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md whitespace-pre-line">
              <div className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0">⚠</span>
                <div>
                  <p className="font-medium">错误</p>
                  <p className="mt-1 text-red-600">{error}</p>
                  {error.includes('SPC_CDS') && (
                    <button
                      className="mt-2 text-xs text-primary hover:underline"
                      onClick={() => extractSpcCds()}
                    >
                      重新获取 SPC_CDS
                    </button>
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

          {/* 商品列表 */}
          {products.length > 0 && <ProductList products={products} />}

          {/* 空状态 */}
          {!isLoading && !error && products.length === 0 && isConnected && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <p>输入商品 ID 并点击"获取商品信息"</p>
              <p className="mt-1 text-xs">商品 ID 可从虾皮后台商品列表页获取</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
