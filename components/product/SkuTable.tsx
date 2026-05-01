import React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ShopeeModel } from '@/entrypoints/popup/types';

interface SkuTableProps {
  models: ShopeeModel[];
  productName: string;
  onClose: () => void;
}

export function SkuTable({ models, productName, onClose }: SkuTableProps) {
  const formatPrice = (price: string) => {
    const num = parseInt(price);
    return isNaN(num) ? price : `NT$${num.toLocaleString()}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-lg shadow-xl w-[380px] max-h-[80vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between p-3 border-b">
          <h3 className="text-sm font-medium truncate flex-1">{productName}</h3>
          <button
            className="ml-2 text-lg leading-none text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* SKU 列表 */}
        <ScrollArea className="flex-1 p-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs w-[40%]">规格</TableHead>
                <TableHead className="text-xs w-[20%]">价格</TableHead>
                <TableHead className="text-xs w-[20%]">库存</TableHead>
                <TableHead className="text-xs w-[20%]">SKU ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model) => (
                <TableRow key={model.modelid}>
                  <TableCell className="text-xs truncate max-w-[120px]" title={model.name}>
                    {model.name}
                  </TableCell>
                  <TableCell className="text-xs">{formatPrice(model.originPrice)}</TableCell>
                  <TableCell className="text-xs">{model.totalNormalStock}</TableCell>
                  <TableCell className="text-xs font-mono text-muted-foreground">{model.modelid}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>

        {/* 底部统计 */}
        <div className="p-3 border-t text-xs text-muted-foreground">
          共 {models.length} 个 SKU
        </div>
      </div>
    </div>
  );
}
