import { useEffect, useState } from 'react';
import { Modal, Input, Checkbox, Space, Typography, Button, message } from 'antd';
import * as popupApi from '../api/popup';
import type { PopupMode, PopupRecord } from '../api/popup';
import { RichTextEditor } from './RichTextEditor';

/**
 * 新建／编辑弹窗的编辑窗口。
 *
 * 关键行为：
 * - 新建时**始终是空白表单**（不预填上一条的内容），用户不需要手动清空。
 * - 「强制更新」勾选框控制要求版本与下载地址是否显示；未勾选时提交 notice 模式。
 * - 编辑已有记录时载入该记录的草稿，按 recordId 保存回同一条记录。
 */

export interface PopupEditorSubmit {
  mode: PopupMode;
  title: string;
  contentHtml: string;
  requiredVersion: string | null;
  downloadUrl: string | null;
}

interface Props {
  open: boolean;
  /** 有记录 = 编辑该记录；null = 新建空白。 */
  record: PopupRecord | null;
  token: string;
  onCancel: () => void;
  onSubmit: (values: PopupEditorSubmit) => Promise<void>;
}

interface FormState {
  title: string;
  contentHtml: string;
  forced: boolean;
  requiredVersion: string;
  downloadUrl: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  contentHtml: '',
  forced: false,
  requiredVersion: '',
  downloadUrl: '',
};

export function PopupEditorModal({ open, record, token, onCancel, onSubmit }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // 打开时按「新建 / 编辑」重置表单。
  // 依赖里带 record?.recordId：切换到另一条记录必须重新载入，否则会拿旧内容覆盖。
  useEffect(() => {
    if (!open) return;
    if (!record) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm({
      title: record.draft.title,
      contentHtml: record.draft.contentHtml,
      forced: record.mode === 'forced_update',
      requiredVersion: record.draft.requiredVersion ?? '',
      downloadUrl: record.draft.downloadUrl ?? '',
    });
  }, [open, record?.recordId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = async (file: File): Promise<string> => {
    const result = await popupApi.uploadPopupAsset(token, file);
    return result.url;
  };

  const handleOk = async () => {
    if (!form.title.trim()) {
      message.error('请填写标题');
      return;
    }
    if (!form.contentHtml.trim()) {
      message.error('请填写正文');
      return;
    }
    if (form.forced) {
      if (!form.requiredVersion.trim()) {
        message.error('强制更新必须填写要求版本');
        return;
      }
      if (!form.downloadUrl.trim()) {
        message.error('强制更新必须填写下载地址');
        return;
      }
    }

    setSaving(true);
    try {
      await onSubmit({
        mode: form.forced ? 'forced_update' : 'notice',
        title: form.title.trim(),
        contentHtml: form.contentHtml,
        requiredVersion: form.forced ? form.requiredVersion.trim() : null,
        downloadUrl: form.forced ? form.downloadUrl.trim() : null,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={record ? '编辑弹窗' : '新建弹窗'}
      onCancel={onCancel}
      confirmLoading={saving}
      onOk={handleOk}
      okText="保存"
      cancelText="取消"
      width={760}
      maskClosable={false}
      destroyOnHidden
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Typography.Text strong>标题</Typography.Text>
          <Input
            style={{ marginTop: 4 }}
            value={form.title}
            maxLength={120}
            placeholder="例如：重要更新提醒"
            onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))}
          />
        </div>

        <div>
          <Checkbox
            checked={form.forced}
            onChange={(e) => setForm((s) => ({ ...s, forced: e.target.checked }))}
          >
            强制更新
          </Checkbox>
          <Typography.Text type="secondary" style={{ fontSize: 12, marginInlineStart: 8 }}>
            勾选后用户在升级前的界面会被不可取消的弹窗阻挡。
          </Typography.Text>
        </div>

        {form.forced && (
          /*
            两组字段用同一套垂直结构：标签在输入框上方、两者左对齐。
            为什么不用 Space 并排：两个标签字数不同（「要求版本」4 字、「下载地址」4 字，
            但输入框宽度不同），并排时标签高度基准不一致，看起来一高一低。
            统一成「标签行 + 输入行 + 说明行」三行结构，两列顶部对齐就不会错位。
            容器用 grid + minmax：宽窗口两列、窄窗口自动堆成一列，不横向溢出。
          */
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 12,
              alignItems: 'start',
              width: '100%',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <Typography.Text strong style={{ lineHeight: '22px' }}>
                要求版本
              </Typography.Text>
              <Input
                value={form.requiredVersion}
                placeholder="例如 1.15.2"
                onChange={(e) => setForm((s) => ({ ...s, requiredVersion: e.target.value }))}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>
                实际加载版本达到或超过它即解除阻挡
              </Typography.Text>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <Typography.Text strong style={{ lineHeight: '22px' }}>
                下载地址
              </Typography.Text>
              <Input
                value={form.downloadUrl}
                placeholder="https://… （必须指向上面填写的版本）"
                onChange={(e) => setForm((s) => ({ ...s, downloadUrl: e.target.value }))}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>
                点「下载最新版本」时打开的地址
              </Typography.Text>
            </div>
          </div>
        )}

        <div>
          <Typography.Text strong>正文</Typography.Text>
          <div style={{ marginTop: 4 }}>
            <RichTextEditor
              value={form.contentHtml}
              onChange={(html) => setForm((s) => ({ ...s, contentHtml: html }))}
              onUploadImage={handleUpload}
            />
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            支持标题、加粗、颜色、列表、链接与图片；图片仅 PNG／JPEG／WebP，单张不超过 5 MiB，每条正文最多 5 张。
          </Typography.Text>
        </div>

        {/* 扩展尺寸预览：与扩展弹窗同宽（500px），用同一份 HTML 渲染，避免「管理页好看、扩展里溢出」 */}
        <div>
          <Typography.Text strong>扩展内预览</Typography.Text>
          <div
            style={{
              marginTop: 4,
              width: 500,
              maxWidth: '100%',
              border: '1px solid #f0f0f0',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            {form.title && (
              <div
                style={{
                  background: 'linear-gradient(90deg,#ee4d2d,#f97316)',
                  color: '#fff',
                  padding: '10px 16px',
                  fontWeight: 600,
                  wordBreak: 'break-word',
                }}
              >
                {form.title}
              </div>
            )}
            <div
              style={{ padding: '14px 16px', maxHeight: 240, overflowY: 'auto', lineHeight: 1.7, fontSize: 13 }}
              // 预览用 dangerouslySetInnerHTML 只为所见即所得；发布时后端仍会再清洗一遍。
              dangerouslySetInnerHTML={{ __html: form.contentHtml }}
            />
            <div style={{ padding: '10px 16px', borderTop: '1px solid #f0f0f0', background: '#fafafa' }}>
              <Button type="primary" block disabled style={{ pointerEvents: 'none' }}>
                {form.forced ? '下载最新版本' : '我知道了'}
              </Button>
            </div>
          </div>
        </div>
      </Space>
    </Modal>
  );
}
