import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SpcStatus } from '@/components/product/SpcStatus';
import { ProductList } from '@/components/product/ProductList';
import { useAppStore } from './store';

export default function App() {
  const {
    inputText, setInputText,
    setProductIds,
    fetchProducts,
    products, isLoading, error,
    isConnected,
  } = useAppStore();

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setInputText(text);
    const ids = text
      .split(/[\n,，]/)
      .map(id => id.trim())
      .filter(id => id.length > 0);
    setProductIds(ids);
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
              className="w-full h-24 px-3 py-2 text-sm border rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="46707018327&#10;51707202143&#10;52257211580"
              value={inputText}
              onChange={handleInputChange}
            />
          </div>

          {/* 获取商品按钮 */}
          <button
            className="w-full py-2 text-sm font-medium text-white bg-primary rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!isConnected || isLoading || inputText.trim().length === 0}
            onClick={handleFetch}
          >
            {isLoading ? '加载中...' : '获取商品信息'}
          </button>

          {/* 错误提示 */}
          {error && (
            <div className="p-2 text-sm text-red-600 bg-red-50 rounded-md">
              {error}
            </div>
          )}

          <Separator />

          {/* 商品列表 */}
          {products.length > 0 && <ProductList products={products} />}
        </CardContent>
      </Card>
    </div>
  );
}
