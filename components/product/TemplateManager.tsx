import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '@/entrypoints/popup/store';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { TemplateEditDialog } from '@/components/product/TemplateEditDialog';
import type { FlashSaleTemplate } from '@/entrypoints/popup/types';

type ViewState = 'idle' | 'saving' | 'loading';

export function TemplateManager() {
  const { products, saveTemplate, importTemplate, deleteTemplate, getTemplateNames, getTemplate, applyTemplate } = useAppStore();

  const [view, setView] = useState<ViewState>('idle');
  const [templateNameInput, setTemplateNameInput] = useState('');
  const [templateNames, setTemplateNames] = useState<string[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [applyMessage, setApplyMessage] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);

  // Comparison dialog state
  const [compareDialog, setCompareDialog] = useState<{
    template: FlashSaleTemplate;
    missingInCurrent: { itemId: string; name: string }[];
    extraInCurrent: { itemId: string; name: string }[];
  } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasProducts = products.length > 0;

  useEffect(() => {
    if (view === 'saving') {
      inputRef.current?.focus();
    }
  }, [view]);

  const countValidOverrides = (template: FlashSaleTemplate) => {
    const currentProductIds = new Set(products.map(p => p.itemid));
    return Object.keys(template.skuOverrides).filter(key => {
      const itemId = key.split('-')[0];
      return currentProductIds.has(itemId);
    }).length;
  };

  const showApplyMessage = (msg: string) => {
    setApplyMessage(msg);
    setTimeout(() => setApplyMessage(''), 2500);
  };

  const refreshTemplateList = async () => {
    setLoadingTemplates(true);
    const names = await getTemplateNames();
    setTemplateNames(names);
    setLoadingTemplates(false);
  };

  const handleSave = async () => {
    const name = templateNameInput.trim();
    if (!name) return;
    setSaving(true);
    try {
      await saveTemplate(name);
      setTemplateNameInput('');
      setSaveSuccess(true);
      setTimeout(() => { setSaveSuccess(false); setView('idle'); }, 1200);
    } catch {
      // Error handled in store
    } finally {
      setSaving(false);
    }
  };

  const handleLoadList = async () => {
    setView('loading');
    await refreshTemplateList();
  };

  const handleApply = async (name: string) => {
    const template = await getTemplate(name);
    if (!template) return;

    const currentProductIds = new Set(products.map(p => p.itemid));

    const missingInCurrent = template.productInfo.filter(
      pi => !currentProductIds.has(pi.itemId)
    );
    const extraInCurrent = products
      .filter(p => !template.productInfo.some(pi => pi.itemId === p.itemid))
      .map(p => ({ itemId: p.itemid, name: p.name }));

    if (missingInCurrent.length > 0 || extraInCurrent.length > 0) {
      setCompareDialog({ template, missingInCurrent, extraInCurrent });
    } else {
      const count = countValidOverrides(template);
      applyTemplate(template);
      setView('idle');
      showApplyMessage(`已应用模板，更新了 ${count} 个 SKU 的覆盖参数`);
    }
  };

  const handleConfirmApply = () => {
    if (compareDialog) {
      const count = countValidOverrides(compareDialog.template);
      applyTemplate(compareDialog.template);
      setCompareDialog(null);
      setView('idle');
      showApplyMessage(`已应用模板，更新了 ${count} 个 SKU 的覆盖参数`);
    }
  };

  const handleDelete = async (name: string) => {
    await deleteTemplate(name);
    await refreshTemplateList();
  };

  const handleExport = async (name: string) => {
    const template = await getTemplate(name);
    if (!template) return;
    const exportData = {
      version: 1,
      type: 'flash_sale_template',
      name: template.name,
      exportedAt: new Date().toISOString(),
      data: {
        discountRate: template.discountRate,
        flashSaleStock: template.flashSaleStock,
        purchaseLimit: template.purchaseLimit,
        skuOverrides: template.skuOverrides,
        productInfo: template.productInfo,
      },
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.version !== 1 || data.type !== 'flash_sale_template' || !data.data) {
        throw new Error('无效的模板文件格式');
      }
      const template: FlashSaleTemplate = {
        name: data.name || file.name.replace('.json', ''),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        discountRate: data.data.discountRate ?? 60,
        flashSaleStock: data.data.flashSaleStock ?? 200,
        purchaseLimit: data.data.purchaseLimit ?? 0,
        skuOverrides: data.data.skuOverrides || {},
        productInfo: data.data.productInfo || [],
      };
      await importTemplate(template);
      setImportMessage(`已导入模板「${template.name}」`);
      setTimeout(() => setImportMessage(''), 2500);
    } catch (err: any) {
      alert(`导入失败: ${err.message || '文件格式错误'}`);
    }
    e.target.value = '';
  };



  if (!hasProducts) return null;

  return (
    <>
      {/* Comparison Dialog Overlay */}
      {compareDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl w-[480px] max-w-[90vw] p-4 space-y-3">
            <h3 className="text-sm font-medium">模板比对结果</h3>
            <p className="text-xs text-muted-foreground">模板：{compareDialog.template.name}</p>

            {compareDialog.missingInCurrent.length > 0 && (
              <div className="p-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded">
                <p className="font-medium mb-1">
                  ⚠ 以下 {compareDialog.missingInCurrent.length} 个商品模板中存在但当前数据不存在（可能已移除）：
                </p>
                {compareDialog.missingInCurrent.map(m => (
                  <div key={m.itemId} className="font-mono truncate">
                    {m.itemId} - {m.name}
                  </div>
                ))}
              </div>
            )}

            {compareDialog.extraInCurrent.length > 0 && (
              <div className="p-2 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded">
                <p className="font-medium mb-1">
                  ℹ 以下 {compareDialog.extraInCurrent.length} 个商品当前存在但模板中不存在（新增）：
                </p>
                {compareDialog.extraInCurrent.map(e => (
                  <div key={e.itemId} className="font-mono truncate">
                    {e.itemId} - {e.name}
                  </div>
                ))}
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              应用模板后，不匹配商品的覆盖参数将被忽略。
            </p>

            <div className="flex justify-end gap-2 pt-1">
              <button
                className="text-xs px-3 py-1.5 border border-input rounded-md text-muted-foreground hover:bg-accent"
                onClick={() => setCompareDialog(null)}
              >
                取消
              </button>
              <button
                className="text-xs px-3 py-1.5 bg-shopee-brand hover:bg-shopee-brand-dark text-white rounded-md shadow-sm"
                onClick={handleConfirmApply}
              >
                确认应用
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template Controls */}
      <Separator className="my-2" />

      {view === 'idle' && (
        <div>
          {applyMessage && (
            <div className="text-xs text-green-600 mb-1.5">{applyMessage}</div>
          )}
          {importMessage && (
            <div className="text-xs text-green-600 mb-1.5">{importMessage}</div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="text-xs px-3 py-1.5 bg-shopee-brand hover:bg-shopee-brand-dark text-white rounded-md shadow-sm"
              onClick={() => setView('saving')}
            >
              保存模板
            </button>
            <button
              className="text-xs px-3 py-1.5 border border-shopee-brand/30 text-shopee-brand rounded-md hover:bg-shopee-brand-light"
              onClick={() => fileInputRef.current?.click()}
            >
              导入模板
            </button>
            <button
              className="text-xs px-3 py-1.5 border border-shopee-brand/30 text-shopee-brand rounded-md hover:bg-shopee-brand-light"
              onClick={handleLoadList}
            >
              加载模板
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
        </div>
      )}

      {view === 'saving' && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">模板名称</span>
            <input
              ref={inputRef}
              type="text"
              value={templateNameInput}
              onChange={e => setTemplateNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
              placeholder="例：618 配置"
              className="flex-1 px-2 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex items-center gap-2">
            {saveSuccess ? (
              <span className="text-xs text-green-600">已保存</span>
            ) : (
              <>
                <button
                  className="text-xs px-3 py-1.5 bg-shopee-brand hover:bg-shopee-brand-dark text-white rounded-md shadow-sm disabled:opacity-50"
                  disabled={!templateNameInput.trim() || saving}
                  onClick={handleSave}
                >
                  保存
                </button>
                <button
                  className="text-xs px-3 py-1.5 border border-input rounded-md text-muted-foreground hover:bg-accent"
                  onClick={() => { setView('idle'); setTemplateNameInput(''); }}
                >
                  取消
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {view === 'loading' && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              已保存的模板（{templateNames.length}）
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal"
              onClick={() => setView('idle')}
            >
              关闭
            </Button>
          </div>

          {loadingTemplates ? (
            <p className="text-[10px] text-muted-foreground">加载中...</p>
          ) : templateNames.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">暂无保存的模板</p>
          ) : (
            <div className="max-h-32 overflow-y-auto space-y-1">
              {templateNames.map(name => (
                <TemplateRow
                  key={name}
                  name={name}
                  onApply={() => handleApply(name)}
                  onExport={() => handleExport(name)}
                  onDelete={() => handleDelete(name)}
                  onEdit={() => setEditingTemplate(name)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {editingTemplate && (
        <TemplateEditDialog
          templateName={editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSaved={() => {
            setEditingTemplate(null);
            refreshTemplateList();
          }}
        />
      )}
    </>
  );
}

function TemplateRow({ name, onApply, onExport, onDelete, onEdit }: { name: string; onApply: () => void; onExport: () => void; onDelete: () => void; onEdit: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  return (
    <div className="flex items-center justify-between px-2 py-1.5 bg-gray-50 border rounded text-[10px]">
      <span className="truncate flex-1">{name}</span>
      <div className="flex items-center gap-1.5 shrink-0 ml-2">
        {confirmDelete ? (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal text-red-600 border-red-300 hover:bg-red-50"
              disabled={isDeleting}
              onClick={async () => {
                setIsDeleting(true);
                try { await onDelete(); } finally { setIsDeleting(false); }
              }}
            >
              {isDeleting ? '删除中...' : '确认删除'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal"
              disabled={isDeleting}
              onClick={() => setConfirmDelete(false)}
            >
              取消
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal text-shopee-brand border-shopee-brand/20 hover:bg-shopee-brand-light"
              onClick={onExport}
            >
              导出
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal text-shopee-brand border-shopee-brand/30 hover:bg-shopee-brand-light"
              disabled={isApplying}
              onClick={async () => {
                setIsApplying(true);
                try { await onApply(); } finally { setIsApplying(false); }
              }}
            >
              {isApplying ? '应用中...' : '应用'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal text-shopee-brand-dark border-shopee-brand/15 hover:bg-shopee-brand-light/50"
              onClick={onEdit}
            >
              编辑
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal text-red-400 border-red-200 hover:bg-red-50"
              onClick={() => setConfirmDelete(true)}
            >
              删除
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
