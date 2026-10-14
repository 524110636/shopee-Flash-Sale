import { useEffect, type ReactNode } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { Button, Space, Tooltip, message } from 'antd';
import {
  BoldOutlined,
  ItalicOutlined,
  UnderlineOutlined,
  StrikethroughOutlined,
  UnorderedListOutlined,
  OrderedListOutlined,
  LinkOutlined,
  PictureOutlined,
  UndoOutlined,
  RedoOutlined,
} from '@ant-design/icons';

/**
 * 富文本编辑器（仅管理网站使用）。
 *
 * 为什么选 TipTap：它输出标准 HTML，且 extension 是显式引入的 —— 能确保
 * 扩展包不会意外带上编辑器代码（本组件只在 admin-web，扩展侧只做安全渲染）。
 *
 * 颜色只提供固定几个色值，不做自由取色：后端白名单只放行 hex/rgb/具名色，
 * 自由取色会生成 rgba(...) 这类可能被拒的值，管理员会看到「保存成功但颜色没了」。
 */

const COLORS = ['#000000', '#ee4d2d', '#1677ff', '#52c41a', '#faad14', '#8c8c8c'];

interface Props {
  value: string;
  onChange: (html: string) => void;
  onUploadImage: (file: File) => Promise<string>;
}

export function RichTextEditor({ value, onChange, onUploadImage }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      TextStyle,
      Color,
      Link.configure({ openOnClick: false, autolink: true }),
      Image,
    ],
    content: value,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
  });

  // 外部切换模式（通知 ↔ 强制升级）时把编辑器内容换成该模式的草稿。
  // 只在 value 与编辑器当前内容真的不同才 setContent，否则每次输入都会重置光标。
  useEffect(() => {
    if (!editor) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [editor, value]);

  if (!editor) return null;

  const handleLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('链接地址（http/https）', previous ?? 'https://');
    if (url === null) return;
    if (!/^https?:\/\//i.test(url)) {
      message.error('链接必须以 http:// 或 https:// 开头');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const handleImage = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const url = await onUploadImage(file);
        editor.chain().focus().setImage({ src: url }).run();
      } catch (e) {
        message.error(e instanceof Error ? e.message : '图片上传失败');
      }
    };
    input.click();
  };

  const btn = (
    key: string,
    icon: ReactNode,
    title: string,
    active: boolean,
    onClick: () => void,
  ) => (
    <Tooltip title={title} key={key}>
      <Button
        size="small"
        type={active ? 'primary' : 'default'}
        icon={icon}
        onClick={onClick}
        onMouseDown={(e) => e.preventDefault()}
      />
    </Tooltip>
  );

  return (
    <div style={{ border: '1px solid #d9d9d9', borderRadius: 6, overflow: 'hidden' }}>
      <Space size={4} wrap style={{ padding: 8, borderBottom: '1px solid #f0f0f0', width: '100%' }}>
        {btn('bold', <BoldOutlined />, '加粗', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
        {btn('italic', <ItalicOutlined />, '斜体', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
        {btn('underline', <UnderlineOutlined />, '下划线', editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run())}
        {btn('strike', <StrikethroughOutlined />, '删除线', editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run())}
        {btn('ul', <UnorderedListOutlined />, '无序列表', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
        {btn('ol', <OrderedListOutlined />, '有序列表', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
        {btn('link', <LinkOutlined />, '插入链接', editor.isActive('link'), handleLink)}
        {btn('img', <PictureOutlined />, '插入图片', false, handleImage)}
        {btn('undo', <UndoOutlined />, '撤销', false, () => editor.chain().focus().undo().run())}
        {btn('redo', <RedoOutlined />, '重做', false, () => editor.chain().focus().redo().run())}
        <Space size={4} style={{ marginInlineStart: 8 }}>
          {COLORS.map((color) => (
            <Tooltip title={`文字颜色 ${color}`} key={color}>
              <button
                type="button"
                aria-label={`文字颜色 ${color}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor.chain().focus().setColor(color).run()}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 3,
                  background: color,
                  border: '1px solid #d9d9d9',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            </Tooltip>
          ))}
        </Space>
      </Space>
      <EditorContent
        editor={editor}
        style={{ padding: '8px 12px', minHeight: 160, maxHeight: 320, overflowY: 'auto' }}
      />
    </div>
  );
}
