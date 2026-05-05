import React, { useEffect, useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/entrypoints/popup/store';
import type { FlashSaleTemplate, SkuOverride } from '@/entrypoints/popup/types';

const PAGE_SIZE = 8;

interface TemplateEditDialogProps {
  templateName: string;
  onClose: () => void;
  onSaved: () => void;
}

interface OverrideRow {
  key: string;
  modelId: string;
  discountRate: string;
  promoPrice: string;
  stock: string;
  purchaseLimit: string;
}

interface ItemGroup {
  itemId: string;
  productName: string;
  models: OverrideRow[];
}

function buildProductNameMap(template: FlashSaleTemplate): Map<string, string> {
  const map = new Map<string, string>();
  for (const pi of template.productInfo) {
    map.set(pi.itemId, pi.name);
  }
  return map;
}

export function TemplateEditDialog({ templateName, onClose, onSaved }: TemplateEditDialogProps) {
  const { getTemplate, updateTemplate } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [template, setTemplate] = useState<FlashSaleTemplate | null>(null);

  const [discountRate, setDiscountRate] = useState(60);
  const [flashSaleStock, setFlashSaleStock] = useState(200);
  const [purchaseLimit, setPurchaseLimit] = useState(0);

  const [groups, setGroups] = useState<ItemGroup[]>([]);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [expandedAll, setExpandedAll] = useState(false);

  const [newItemId, setNewItemId] = useState('');
  const [newModelId, setNewModelId] = useState('');

  useEffect(() => {
    getTemplate(templateName).then((t) => {
      if (!t) {
        onClose();
        return;
      }
      setTemplate(t);
      setDiscountRate(t.discountRate);
      setFlashSaleStock(t.flashSaleStock);
      setPurchaseLimit(t.purchaseLimit);

      const nameMap = buildProductNameMap(t);
      const groupMap = new Map<string, ItemGroup>();

      for (const [key, ov] of Object.entries(t.skuOverrides)) {
        const [itemId, modelId] = key.split('-');
        if (!itemId || !modelId) continue;
        if (!groupMap.has(itemId)) {
          groupMap.set(itemId, {
            itemId,
            productName: nameMap.get(itemId) || '',
            models: [],
          });
        }
        groupMap.get(itemId)!.models.push({
          key,
          modelId,
          discountRate: ov.discountRate?.toString() ?? '',
          promoPrice: ov.promoPrice?.toString() ?? '',
          stock: ov.stock?.toString() ?? '',
          purchaseLimit: ov.purchaseLimit?.toString() ?? '',
        });
      }

      for (const group of groupMap.values()) {
        group.models.sort((a, b) => a.modelId.localeCompare(b.modelId));
      }

      const sorted = Array.from(groupMap.values()).sort((a, b) => a.itemId.localeCompare(b.itemId));
      setGroups(sorted);
      setLoading(false);
    });
  }, [templateName, getTemplate, onClose]);

  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageGroups = useMemo(
    () => groups.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [groups, safePage]
  );

  const toggleItem = (itemId: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const toggleExpandAll = () => {
    if (expandedAll) {
      setExpandedItems(new Set());
      setExpandedAll(false);
    } else {
      const allIds = new Set(pageGroups.map((g) => g.itemId));
      setExpandedItems(allIds);
      setExpandedAll(true);
    }
  };

  const updateGroupCell = (itemId: string, modelKey: string, field: keyof OverrideRow, value: string) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.itemId !== itemId) return g;
        return {
          ...g,
          models: g.models.map((m) => (m.key === modelKey ? { ...m, [field]: value } : m)),
        };
      })
    );
  };

  const removeGroupModel = (itemId: string, modelKey: string) => {
    setGroups((prev) =>
      prev
        .map((g) => {
          if (g.itemId !== itemId) return g;
          return { ...g, models: g.models.filter((m) => m.key !== modelKey) };
        })
        .filter((g) => g.models.length > 0)
    );
  };

  const addModelToGroup = (itemId: string, modelId: string) => {
    const key = `${itemId}-${modelId}`;
    setGroups((prev) => {
      const existing = prev.find((g) => g.itemId === itemId);
      if (existing && existing.models.some((m) => m.key === key)) return prev;
      const newModel: OverrideRow = {
        key,
        modelId,
        discountRate: '',
        promoPrice: '',
        stock: '',
        purchaseLimit: '',
      };
      if (existing) {
        return prev.map((g) =>
          g.itemId === itemId
            ? { ...g, models: [...g.models, newModel].sort((a, b) => a.modelId.localeCompare(b.modelId)) }
            : g
        );
      }
      const nameMap = template ? buildProductNameMap(template) : new Map();
      const newGroup: ItemGroup = {
        itemId,
        productName: nameMap.get(itemId) || '',
        models: [newModel],
      };
      return [...prev, newGroup].sort((a, b) => a.itemId.localeCompare(b.itemId));
    });
    setExpandedItems((prev) => new Set(prev).add(itemId));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const skuOverrides: Record<string, SkuOverride> = {};
      for (const group of groups) {
        for (const m of group.models) {
          const override: SkuOverride = {};
          const dr = parseInt(m.discountRate);
          const pp = parseInt(m.promoPrice);
          const st = parseInt(m.stock);
          const pl = parseInt(m.purchaseLimit);
          if (!isNaN(dr) && m.discountRate !== '') override.discountRate = dr;
          if (!isNaN(pp) && m.promoPrice !== '') override.promoPrice = pp;
          if (!isNaN(st) && m.stock !== '') override.stock = st;
          if (!isNaN(pl) && m.purchaseLimit !== '') override.purchaseLimit = pl;
          if (Object.keys(override).length > 0) {
            skuOverrides[m.key] = override;
          }
        }
      }
      await updateTemplate(templateName, {
        discountRate,
        flashSaleStock,
        purchaseLimit,
        skuOverrides,
      });
      onSaved();
    } catch (e: any) {
      alert(`保存失败: ${e.message || '未知错误'}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50'>
        <div className='bg-white rounded-lg p-6 text-sm'>加载中...</div>
      </div>
    );
  }

  const totalSkuCount = groups.reduce((s, g) => s + g.models.length, 0);

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50'>
      <div className='bg-white rounded-lg shadow-xl w-[680px] max-w-[95vw] flex flex-col max-h-[85vh]'>
        <div className='flex items-center justify-between p-4 border-b shrink-0'>
          <div>
            <h3 className='text-sm font-medium'>编辑模板</h3>
            <p className='text-[11px] text-muted-foreground mt-0.5'>{templateName}</p>
          </div>
          <button className='text-lg leading-none text-muted-foreground hover:text-foreground' onClick={onClose}>
            ×
          </button>
        </div>

        <div className='flex-1 min-h-0 overflow-y-auto p-4 space-y-4'>
          <div className='flex items-center gap-4 flex-wrap'>
            <div className='flex items-center gap-1.5'>
              <label className='text-[11px] text-muted-foreground whitespace-nowrap'>折扣率%</label>
              <input
                type='number'
                min={1}
                max={100}
                value={discountRate}
                onChange={(e) => setDiscountRate(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                className='w-16 px-1.5 py-1 text-[11px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary'
              />
            </div>
            <div className='flex items-center gap-1.5'>
              <label className='text-[11px] text-muted-foreground whitespace-nowrap'>活动库存</label>
              <input
                type='number'
                min={1}
                value={flashSaleStock}
                onChange={(e) => setFlashSaleStock(Math.max(1, Number(e.target.value) || 1))}
                className='w-20 px-1.5 py-1 text-[11px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary'
              />
            </div>
            <div className='flex items-center gap-1.5'>
              <label className='text-[11px] text-muted-foreground whitespace-nowrap'>限购数量</label>
              <input
                type='number'
                min={0}
                value={purchaseLimit}
                onChange={(e) => setPurchaseLimit(Math.max(0, Number(e.target.value) || 0))}
                className='w-20 px-1.5 py-1 text-[11px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary'
              />
            </div>
          </div>

          <div>
            <div className='flex items-center justify-between mb-1.5'>
              <span className='text-[11px] font-medium'>SKU 覆盖参数</span>
              <div className='flex items-center gap-2'>
                <span className='text-[10px] text-muted-foreground'>留空 = 使用全局默认</span>
                {pageGroups.length > 0 && (
                  <Button
                    variant='outline'
                    size='sm'
                    className='h-5 px-1.5 text-[10px] font-normal'
                    onClick={toggleExpandAll}
                  >
                    {expandedAll ? '全部收起' : '全部展开'}
                  </Button>
                )}
              </div>
            </div>

            <div className='border rounded overflow-hidden'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className='text-[10px] w-[20%]'>Item ID</TableHead>
                    <TableHead className='text-[10px] w-[30%]'>商品名</TableHead>
                    <TableHead className='text-[10px] w-[15%]'>SKU 数</TableHead>
                    <TableHead className='text-[10px] w-[35%]'>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className='text-center text-[11px] text-muted-foreground py-4'>
                        暂无 SKU 覆盖参数
                      </TableCell>
                    </TableRow>
                  ) : pageGroups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className='text-center text-[11px] text-muted-foreground py-4'>
                        当前页无数据
                      </TableCell>
                    </TableRow>
                  ) : (
                    pageGroups.map((group) => {
                      const isExpanded = expandedItems.has(group.itemId);
                      return (
                        <React.Fragment key={group.itemId}>
                          <TableRow
                            className='cursor-pointer hover:bg-muted/50'
                            onClick={() => toggleItem(group.itemId)}
                          >
                            <TableCell className='text-[10px] p-1 font-mono'>
                              <span className='mr-1'>{isExpanded ? '▼' : '▶'}</span>
                              {group.itemId}
                            </TableCell>
                            <TableCell className='text-[10px] p-1 truncate max-w-[180px]' title={group.productName}>
                              {group.productName || '-'}
                            </TableCell>
                            <TableCell className='text-[10px] p-1'>{group.models.length}</TableCell>
                            <TableCell className='text-[10px] p-1' onClick={(e) => e.stopPropagation()}>
                              <div className='flex items-center gap-1'>
                                <input
                                  type='text'
                                  placeholder='Model ID'
                                  className='w-20 px-1 py-0.5 text-[10px] border rounded focus:outline-none focus:ring-1 focus:ring-primary font-mono'
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      addModelToGroup(group.itemId, (e.target as HTMLInputElement).value);
                                      (e.target as HTMLInputElement).value = '';
                                    }
                                  }}
                                />
                                <Button
                                  variant='outline'
                                  size='sm'
                                  className='h-5 px-1.5 text-[10px] font-normal text-blue-600 border-blue-200 hover:bg-blue-50'
                                  onClick={(e) => {
                                    const input = (e.currentTarget as HTMLElement).parentElement?.querySelector(
                                      'input'
                                    ) as HTMLInputElement;
                                    if (input) {
                                      addModelToGroup(group.itemId, input.value);
                                      input.value = '';
                                    }
                                  }}
                                >
                                  +SKU
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                          {isExpanded &&
                            group.models.map((m) => (
                              <TableRow key={m.key} className='bg-sky-50/40'>
                                <TableCell className='text-[10px] p-1 pl-6 text-muted-foreground' colSpan={1}>
                                  └ {m.modelId}
                                </TableCell>
                                <TableCell className='text-[10px] p-1' colSpan={3}>
                                  <div className='flex items-center gap-1.5'>
                                    <input
                                      type='number'
                                      min={1}
                                      max={100}
                                      placeholder={`${discountRate}`}
                                      value={m.discountRate}
                                      onChange={(e) =>
                                        updateGroupCell(group.itemId, m.key, 'discountRate', e.target.value)
                                      }
                                      className='w-14 px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary'
                                    />
                                    <input
                                      type='number'
                                      min={1}
                                      placeholder='限时价'
                                      value={m.promoPrice}
                                      onChange={(e) =>
                                        updateGroupCell(group.itemId, m.key, 'promoPrice', e.target.value)
                                      }
                                      className='w-16 px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary'
                                    />
                                    <input
                                      type='number'
                                      min={1}
                                      placeholder={`${flashSaleStock}`}
                                      value={m.stock}
                                      onChange={(e) => updateGroupCell(group.itemId, m.key, 'stock', e.target.value)}
                                      className='w-14 px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary'
                                    />
                                    <input
                                      type='number'
                                      min={0}
                                      placeholder={`${purchaseLimit}`}
                                      value={m.purchaseLimit}
                                      onChange={(e) =>
                                        updateGroupCell(group.itemId, m.key, 'purchaseLimit', e.target.value)
                                      }
                                      className='w-14 px-1 py-0.5 text-[10px] border rounded text-center focus:outline-none focus:ring-1 focus:ring-primary'
                                    />
                                    <Button
                                      variant='outline'
                                      size='sm'
                                      className='h-5 px-1.5 text-[10px] font-normal text-red-400 border-red-200 hover:bg-red-50 hover:text-red-600 ml-auto'
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        removeGroupModel(group.itemId, m.key);
                                      }}
                                    >
                                      移除
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                        </React.Fragment>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <div className='flex items-center justify-center gap-2 mt-2'>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-5 px-1.5 text-[10px] font-normal'
                  disabled={safePage === 0}
                  onClick={() => setPage(safePage - 1)}
                >
                  ‹ 上一页
                </Button>
                <span className='text-[10px] text-muted-foreground'>
                  {safePage + 1} / {totalPages}
                </span>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-5 px-1.5 text-[10px] font-normal'
                  disabled={safePage >= totalPages - 1}
                  onClick={() => setPage(safePage + 1)}
                >
                  下一页 ›
                </Button>
              </div>
            )}

            <div className='flex items-center gap-1.5 mt-2'>
              <input
                type='text'
                placeholder='Item ID'
                value={newItemId}
                onChange={(e) => setNewItemId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newModelId.trim()) {
                    addModelToGroup(newItemId.trim(), newModelId.trim());
                    setNewItemId('');
                    setNewModelId('');
                  }
                }}
                className='w-24 px-1.5 py-1 text-[10px] border rounded focus:outline-none focus:ring-1 focus:ring-primary font-mono'
              />
              <input
                type='text'
                placeholder='Model ID'
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newItemId.trim()) {
                    addModelToGroup(newItemId.trim(), newModelId.trim());
                    setNewItemId('');
                    setNewModelId('');
                  }
                }}
                className='w-24 px-1.5 py-1 text-[10px] border rounded focus:outline-none focus:ring-1 focus:ring-primary font-mono'
              />
              <Button
                variant='outline'
                size='sm'
                className='h-5 px-1.5 text-[10px] font-normal text-blue-600 border-blue-200 hover:bg-blue-50'
                disabled={!newItemId.trim() || !newModelId.trim()}
                onClick={() => {
                  addModelToGroup(newItemId.trim(), newModelId.trim());
                  setNewItemId('');
                  setNewModelId('');
                }}
              >
                + 新增覆盖
              </Button>
            </div>
          </div>
        </div>

        <div className='p-4 border-t flex items-center justify-between shrink-0'>
          <span className='text-[10px] text-muted-foreground'>
            {groups.length} 个商品 / {totalSkuCount} 条 SKU 覆盖规则
          </span>
          <div className='flex items-center gap-2'>
            <Button variant='outline' size='sm' className='h-6 px-2 text-xs font-normal' onClick={onClose}>
              取消
            </Button>
            <Button
              variant='outline'
              size='sm'
              className='h-6 px-2 text-xs font-normal text-green-700 border-green-300 hover:bg-green-50'
              disabled={saving}
              onClick={handleSave}
            >
              {saving ? '保存中...' : '保存'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
