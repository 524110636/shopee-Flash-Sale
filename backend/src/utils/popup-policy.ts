import sanitizeHtml from 'sanitize-html';

/**
 * 弹窗策略的校验、清洗与图片检查。
 *
 * 这里是后端唯一的判定来源：管理员保存草稿、发布、上传图片都经过本模块，
 * 扩展侧只做安全渲染，不重复实现白名单（避免两套规则不一致）。
 */

export const POPUP_MODES = ['notice', 'forced_update'] as const;
export type PopupMode = (typeof POPUP_MODES)[number];

export function isPopupMode(value: unknown): value is PopupMode {
  return typeof value === 'string' && (POPUP_MODES as readonly string[]).includes(value);
}

/** 正文 UTF-8 上限 100 KiB；单张图片 5 MiB；每条正文最多 5 张上传图片。 */
export const MAX_CONTENT_BYTES = 100 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_BODY = 5;
export const MAX_TITLE_LENGTH = 120;

/** 允许的图片类型（服务端按实际字节签名二次确认，不信任上传声明的 MIME）。 */
export const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number];

/**
 * 图片资源路径前缀。扩展与服务端都用它区分「自有上传图片」与外部链接，
 * 防止正文里塞 `<img src="https://evil/">` 造成外链追踪。
 */
export const ASSET_PATH_PREFIX = '/popup-assets/';

/** Chrome 版本格式：1～4 段数字，每段 0～65535，无非零前导零，整体不全零。 */
export function validateVersion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(value)) return null;
  const parts = value.split('.');
  if (parts.length > 4) return null;
  for (const part of parts) {
    // 拒绝 01、007 这类前导零（Chrome 会直接判定 manifest 非法）
    if (part.length > 1 && part.startsWith('0')) return null;
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 65535) return null;
  }
  if (parts.every((p) => Number(p) === 0)) return null;
  return value;
}

/** 下载地址：只接受 http(s)，拒绝 javascript:/data:/file: 等危险协议。 */
export function validateDownloadUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return value;
}

/**
 * 富文本白名单清洗。
 *
 * 允许：标题、加粗、斜体、下划线、删除线、颜色、列表、链接、自有图片、段落与引用。
 * 拒绝：script/style/iframe/object、事件属性（onclick 等）、危险协议。
 * 颜色只允许 hex／rgb／rgba 与具名色，防止 `expression()`、`url()` 之类注入。
 */
export function sanitizeContentHtml(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return sanitizeHtml(raw, {
    allowedTags: [
      'p', 'br', 'span', 'div', 'strong', 'b', 'em', 'i', 'u', 's', 'strike',
      'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'img', 'blockquote',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      span: ['style'],
      p: ['style'],
      div: ['style'],
      h1: ['style'], h2: ['style'], h3: ['style'], h4: ['style'],
      li: ['style'], ul: ['style'], ol: ['style'],
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    allowProtocolRelative: false,
    // 图片只允许自有资源路径或 http(s)，其余（data:、file:、javascript:）一律丢弃
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href && /^https?:\/\//i.test(attribs.href) ? attribs.href : '';
        if (!href) return { tagName: 'a', attribs: {} as Record<string, string> };
        return {
          tagName: 'a',
          attribs: { href, target: '_blank', rel: 'noopener noreferrer' } as Record<string, string>,
        };
      },
      img: (tagName, attribs) => {
        const src = typeof attribs.src === 'string' ? attribs.src : '';
        const isOwnAsset = src.startsWith(ASSET_PATH_PREFIX);
        const isExternal = /^https?:\/\//i.test(src);
        if (!isOwnAsset && !isExternal) {
          return { tagName: 'img', attribs: {} as Record<string, string> };
        }
        const next: Record<string, string> = { src };
        if (typeof attribs.alt === 'string') next.alt = attribs.alt;
        return { tagName: 'img', attribs: next };
      },
    },
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgba?\([\d\s.,%]+\)$/i, /^[a-z]+$/i],
        'text-align': [/^(left|right|center|justify)$/i],
      },
    },
    disallowedTagsMode: 'discard',
  });
}

/** 正文按 UTF-8 计算字节数（中文字符不能按字符数算）。 */
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** 统计正文中引用自有资源图片的数量。 */
export function countOwnAssets(html: string): number {
  const matches = html.match(new RegExp(ASSET_PATH_PREFIX.replace(/\//g, '\\/'), 'g'));
  return matches ? matches.length : 0;
}

/**
 * 按实际字节签名判断图片类型。上传接口声明的 Content-Type 不可信
 * （改个扩展名就能绕过），必须以文件头为准。
 */
export function detectImageMime(bytes: Uint8Array): AllowedImageMime | null {
  if (bytes.length >= 8) {
    const isPng =
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
    if (isPng) return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}
