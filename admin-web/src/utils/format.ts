/** 统一的时间展示：数据库中存 UTC 文本，展示为本地时间。 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  // 历史数据里可能存有字面量字符串（Drizzle 默认值渲染问题，见后端 schema.ts 说明）；
  // 这类值无法解析为时间，显示为“时间待补全”而不是原样输出。
  if (value === 'CURRENT_TIMESTAMP') return '时间待补全';
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(value)
    ? value
    : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '时间待补全';
  return date.toLocaleString('zh-CN', { hour12: false });
}
