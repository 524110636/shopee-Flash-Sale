import React, { useState, useEffect, useRef } from 'react';
import { useAppStore } from '@/entrypoints/popup/store';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import type { FlashSaleTemplate } from '@/entrypoints/popup/types';

type ViewState = 'idle' | 'saving' | 'loading';

export function TemplateManager() {
  const { products, saveTemplate, deleteTemplate, getTemplateNames, getTemplate, applyTemplate } = useAppStore();

  const [view, setView] = useState<ViewState>('idle');
  const [templateNameInput, setTemplateNameInput] = useState('');
  const [templateNames, setTemplateNames] = useState<string[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [applyMessage, setApplyMessage] = useState('');

  // Comparison dialog state
  const [compareDialog, setCompareDialog] = useState<{
    template: FlashSaleTemplate;
    missingInCurrent: { itemId: string; name: string }[];
    extraInCurrent: { itemId: string; name: string }[];
  } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
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
    const currentProductMap = new Map(products.map(p => [p.itemid, p.name]));

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

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
                className="text-xs px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-md"
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
          <div className="flex items-center gap-2">
            <button
              className="text-xs px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-md"
              onClick={() => setView('saving')}
            >
              保存模板
            </button>
            <button
              className="text-xs px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-md"
              onClick={handleLoadList}
            >
              加载模板
            </button>
          </div>
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
                  className="text-xs px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-md disabled:opacity-50"
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
                  onDelete={() => handleDelete(name)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function TemplateRow({ name, onApply, onDelete }: { name: string; onApply: () => void; onDelete: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);

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
              onClick={onDelete}
            >
              确认删除
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal"
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
              className="h-5 px-1.5 text-[10px] font-normal text-green-700 border-green-300 hover:bg-green-50"
              onClick={onApply}
            >
              应用
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] font-normal text-red-400 border-red-200 hover:bg-red-50 hover:text-red-600"
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
