import { describe, expect, it } from 'vitest';
import {
  sanitizeContentHtml,
  validateVersion,
  validateDownloadUrl,
  detectImageMime,
  utf8ByteLength,
  countOwnAssets,
  MAX_CONTENT_BYTES,
} from '@/backend/src/utils/popup-policy';

/**
 * 后端策略校验与清洗测试。
 *
 * 这些是「非法内容能不能混进生效策略」的最后一道门，必须每条都有用例：
 * 版本格式、下载地址协议、富文本注入、图片签名。
 */

describe('validateVersion', () => {
  it('接受 1～4 段合法数字', () => {
    expect(validateVersion('1.15.0')).toBe('1.15.0');
    expect(validateVersion('1')).toBe('1');
    expect(validateVersion('1.15')).toBe('1.15');
    expect(validateVersion('1.15.0.1')).toBe('1.15.0.1');
    expect(validateVersion('65535.65535.65535.65535')).toBe('65535.65535.65535.65535');
  });

  it('拒绝前导零、超段、超范围和全零', () => {
    expect(validateVersion('1.015.0')).toBeNull();
    expect(validateVersion('01.2.3')).toBeNull();
    expect(validateVersion('1.2.3.4.5')).toBeNull();
    expect(validateVersion('1.65536.0')).toBeNull();
    expect(validateVersion('0.0.0')).toBeNull();
  });

  it('拒绝非字符串与空值', () => {
    expect(validateVersion('')).toBeNull();
    expect(validateVersion('abc')).toBeNull();
    expect(validateVersion(null)).toBeNull();
    expect(validateVersion(1.15)).toBeNull();
  });
});

describe('validateDownloadUrl', () => {
  it('接受 http(s)', () => {
    expect(validateDownloadUrl('https://example.com/a.zip')).toBe('https://example.com/a.zip');
    expect(validateDownloadUrl('http://43.99.86.228:8080/a.zip')).toBeTruthy();
  });

  it('拒绝危险协议与非法值', () => {
    expect(validateDownloadUrl('javascript:alert(1)')).toBeNull();
    expect(validateDownloadUrl('data:text/html,<script>x</script>')).toBeNull();
    expect(validateDownloadUrl('file:///etc/passwd')).toBeNull();
    expect(validateDownloadUrl('example.com/a.zip')).toBeNull();
    expect(validateDownloadUrl('')).toBeNull();
    expect(validateDownloadUrl(null)).toBeNull();
  });
});

describe('sanitizeContentHtml', () => {
  it('保留允许的标题、加粗、颜色、列表和链接', () => {
    const html = sanitizeContentHtml(
      '<h1>标题</h1><p><strong>粗</strong><span style="color:#ee4d2d">红</span></p><ul><li>项</li></ul><a href="https://a.com/x">链接</a>',
    );
    expect(html).toContain('<h1>标题</h1>');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('color:#ee4d2d');
    expect(html).toContain('<ul><li>项</li></ul>');
    expect(html).toContain('href="https://a.com/x"');
    // 链接必须带 noopener，否则新标签页能通过 window.opener 反向控制 popup
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('删除脚本、iframe、事件属性与危险协议', () => {
    const html = sanitizeContentHtml(
      '<script>alert(1)</script><iframe src="https://evil"></iframe><p onclick="alert(2)">文字</p><a href="javascript:alert(3)">坏链接</a>',
    );
    expect(html).not.toContain('script');
    expect(html).not.toContain('iframe');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('文字');
  });

  it('拒绝非自有资源且非 http(s) 的图片 src', () => {
    const html = sanitizeContentHtml('<img src="data:image/png;base64,AAAA"><img src="file:///c:/x.png">');
    expect(html).not.toContain('data:');
    expect(html).not.toContain('file:');
  });

  it('保留自有资源图片与 http(s) 外链图片', () => {
    const html = sanitizeContentHtml(
      '<img src="/popup-assets/abc"><img src="https://cdn.example.com/a.png">',
    );
    expect(html).toContain('/popup-assets/abc');
    expect(html).toContain('https://cdn.example.com/a.png');
  });

  it('style 中的 url() 与表达式被清除', () => {
    const html = sanitizeContentHtml(
      '<p style="background-image:url(javascript:alert(1));width:expression(alert(2));color:#fff">x</p>',
    );
    expect(html).not.toContain('url(');
    expect(html).not.toContain('expression');
    expect(html).toContain('color:#fff');
  });

  it('非字符串输入返回空串', () => {
    expect(sanitizeContentHtml(null)).toBe('');
    expect(sanitizeContentHtml(123)).toBe('');
  });
});

describe('detectImageMime', () => {
  it('按 PNG 文件头识别', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(detectImageMime(png)).toBe('image/png');
  });

  it('按 JPEG 文件头识别', () => {
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  });

  it('按 WebP 文件头识别', () => {
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectImageMime(webp)).toBe('image/webp');
  });

  it('SVG 与 HTML 不被识别（即使伪装成别的类型）', () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectImageMime(svg)).toBeNull();
    const html = new TextEncoder().encode('<!doctype html><html></html>');
    expect(detectImageMime(html)).toBeNull();
  });

  it('空字节与短字节返回 null', () => {
    expect(detectImageMime(new Uint8Array([]))).toBeNull();
    expect(detectImageMime(new Uint8Array([0xff]))).toBeNull();
  });
});

describe('正文计量', () => {
  it('按 UTF-8 字节数算，中文占 3 字节', () => {
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('ab')).toBe(2);
  });

  it('100 KiB 上限可用于超限判断', () => {
    expect(utf8ByteLength('中'.repeat(40000))).toBeGreaterThan(MAX_CONTENT_BYTES);
  });

  it('统计正文中自有资源图片数量', () => {
    const html = '<img src="/popup-assets/a"><img src="/popup-assets/b"><img src="https://x/y.png">';
    expect(countOwnAssets(html)).toBe(2);
  });
});

describe('F1 查看上报的修订号格式校验', () => {
  /**
   * 这些是纯格式判定，不需要数据库：**任何不是正安全整数的值都不可能是服务端发出去的**。
   * 放行它们等于「任何已登录账号只要知道 recordId 就能给生效记录加人」，统计就不真实了。
   *
   * 注意：这里只覆盖格式那一关；「是否等于当前生效槽修订」见 verify-api.mjs 的真实 HTTP 用例。
   */
  const invalid: Array<[string, unknown]> = [
    ['缺失（undefined）', undefined],
    ['null', null],
    ['零', 0],
    ['负数', -1],
    ['小数', 1.5],
    ['字符串', '1'],
    ['布尔值', true],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['超出安全整数范围', Number.MAX_SAFE_INTEGER + 2],
  ];

  for (const [label, value] of invalid) {
    it(`拒绝${label}`, async () => {
      const { validateViewTarget } = await import('@/backend/src/utils/popup-views');
      // 未初始化数据库也不应抛错：格式校验在查库之前就返回
      const result = await validateViewTarget('11111111-2222-3333-4444-555555555555', 'notice', value);
      expect(result.counted).toBe(false);
      expect(result.reason).toBe('bad-revision');
    });
  }
});
