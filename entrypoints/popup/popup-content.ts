/**
 * 扩展侧的富文本安全渲染。
 *
 * 服务端已用白名单清洗过一遍；这里再做一次 DOM 遍历式的收紧，
 * 是**纵深防御**：万一后端清洗被改坏、或将来有别的写入路径，
 * 扩展也不会执行注入内容。
 *
 * 为什么不用正则：正则匹配 HTML 必然漏（`<img onerror=` 的引号/大小写变体
 * 就能绕过），必须让浏览器自己解析成 DOM 再按节点白名单删。
 */

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'SPAN', 'DIV', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE',
  'H1', 'H2', 'H3', 'H4', 'UL', 'OL', 'LI', 'A', 'IMG', 'BLOCKQUOTE',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(['href', 'target', 'rel']),
  IMG: new Set(['src', 'alt']),
};

/** 允许的内联样式白名单，防止 style 里塞 url()／expression()。 */
const ALLOWED_STYLE_PROPS = new Set(['color', 'background-color', 'text-align']);

function sanitizeElement(el: Element): void {
  // 先递归处理子节点，再决定自己留不留：倒序删除时索引不会错位。
  const children = Array.from(el.children);
  for (const child of children) {
    if (!ALLOWED_TAGS.has(child.tagName)) {
      // 不允许的标签整体丢弃（连内容一起），避免把 script 的代码当文本留下
      child.remove();
      continue;
    }
    sanitizeElement(child);
  }

  const allowed = ALLOWED_ATTRS[el.tagName];
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (name === 'style') {
      // style 只有 HTMLElement/SVGElement 才有；未知元素直接删掉整个属性。
      if (!(el instanceof HTMLElement)) {
        el.removeAttribute('style');
        continue;
      }
      const safe = Array.from(el.style)
        .filter((prop) => ALLOWED_STYLE_PROPS.has(prop))
        .map((prop) => `${prop}: ${el.style.getPropertyValue(prop)}`)
        .join('; ');
      if (safe) el.setAttribute('style', safe);
      else el.removeAttribute('style');
      continue;
    }
    // 事件属性（onclick/onerror…）一律删除
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (!allowed || !allowed.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    if (name === 'href' || name === 'src') {
      const value = el.getAttribute(name) || '';
      const ok = /^https?:\/\//i.test(value) || value.startsWith('/popup-assets/');
      if (!ok) el.removeAttribute(name);
    }
  }

  if (el.tagName === 'A') {
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
}

/** 把服务端清洗过的 HTML 再收紧一次，返回可安全插入的 HTML 字符串。 */
export function sanitizeForRender(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  sanitizeElement(doc.body);
  return doc.body.innerHTML;
}
