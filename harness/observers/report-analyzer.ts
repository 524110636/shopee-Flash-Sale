import type { HarnessReport } from '../report/report-types.js';

export interface FixSuggestion {
  /** 源文件路径 (相对项目根目录) */
  file: string;
  /** 建议的行号范围 */
  line?: number;
  /** 问题描述 (中文) */
  description: string;
  /** 修复建议 (中文，可操作) */
  fix: string;
  /** 优先级 */
  priority: 'high' | 'medium' | 'low';
  /** 问题类型 */
  type: 'manifest' | 'source' | 'config' | 'network' | 'dependency';
}

export interface AnalysisResult {
  hasIssues: boolean;
  severity: 'pass' | 'warning' | 'error' | 'harness-error';
  suggestions: FixSuggestion[];
  /** 一句话总结 (中文) */
  summary: string;
  /** 是否可以由 AI 自动修复 */
  canAutoFix: boolean;
}

/**
 * 根据 Popup 错误消息内容尝试匹配具体的源文件。
 */
function mapPopupErrorToFile(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('import') || lower.includes('module')) {
    return 'entrypoints/popup/App.tsx';
  }
  if (lower.includes('store') || lower.includes('state')) {
    return 'entrypoints/popup/store.ts';
  }
  if (lower.includes('api') || lower.includes('fetch')) {
    return 'entrypoints/popup/api.ts';
  }
  // 默认 fallback 到 App.tsx
  return 'entrypoints/popup/App.tsx';
}

/**
 * 将 diagnostics 映射到具体源文件的诊断分析器。
 *
 * 逐一检查 HarnessReport 的各字段，按规则生成 FixSuggestion。
 * 返回的数组按优先级降序排列。
 */
export function analyzeReport(report: HarnessReport): AnalysisResult {
  const suggestions: FixSuggestion[] = [];
  let severity: AnalysisResult['severity'] = 'pass';
  const summaryParts: string[] = [];

  // ── 1. Service Worker 未检测到 ──────────────────────────────────────────────
  if (!report.serviceWorker.detected) {
    suggestions.push({
      file: 'wxt.config.ts',
      line: 8,
      description: 'Service Worker (background) 未被浏览器加载。',
      fix: '检查 wxt.config.ts 中是否配置了 background.service_worker 入口，确保 manifest 中 "background" 字段正确指向 entrypoints/background.ts。',
      priority: 'high',
      type: 'config',
    });
    summaryParts.push('Service Worker 未注册');
  }

  // ── 2. Popup 渲染失败 / 空白 ──────────────────────────────────────────────
  if (report.popup.opened === false) {
    suggestions.push({
      file: 'entrypoints/popup/App.tsx',
      line: 1,
      description: 'Popup 窗口未能打开（opened = false）。',
      fix: '检查 entrypoints/popup/App.tsx 的 mount 逻辑，确认 ReactDOM.createRoot 挂载点正确，且 entrypoints/popup/index.html 中存在对应的容器元素。',
      priority: 'high',
      type: 'source',
    });
    suggestions.push({
      file: 'entrypoints/popup/main.tsx',
      description: 'Popup 主入口可能未正确初始化。',
      fix: '检查 entrypoints/popup/main.tsx 是否正确调用 createRoot 并渲染 <App /> 组件。确认没有运行时错误阻止挂载。',
      priority: 'high',
      type: 'source',
    });
    summaryParts.push('Popup 未打开');
  } else if (report.popup.visibleText === '' && report.popup.pageErrors.length > 0) {
    suggestions.push({
      file: 'entrypoints/popup/App.tsx',
      line: 1,
      description: 'Popup 已打开但页面空白，且存在 JS 报错。',
      fix: '检查 entrypoints/popup/App.tsx 中的 React 组件是否抛出未捕获异常，确认所有 import 路径正确。',
      priority: 'high',
      type: 'source',
    });
    summaryParts.push('Popup 渲染空白');
  }

  // ── 3. Popup JS 报错 ──────────────────────────────────────────────────────
  if (report.popup.pageErrors.length > 0) {
    for (const error of report.popup.pageErrors) {
      const mappedFile = mapPopupErrorToFile(error);
      suggestions.push({
        file: mappedFile,
        description: `Popup 页面 JS 运行时错误：${error}`,
        fix: '根据上述错误信息定位具体代码行，修复类型错误、缺失 import 或 API 调用异常。',
        priority: 'high',
        type: 'source',
      });
    }
    if (!summaryParts.some((p) => p.includes('Popup'))) {
      summaryParts.push('Popup 存在 JS 错误');
    }
  }

  // ── 4. Content Script 未注入 ─────────────────────────────────────────────
  if (!report.targetPage.contentScriptDetected) {
    suggestions.push({
      file: 'wxt.config.ts',
      line: 8,
      description: 'Content Script 未注入到目标页面。',
      fix: '检查 wxt.config.ts 中 content_scripts matches 配置是否覆盖了目标 URL（seller.shopee.tw），确认 content_scripts 的 JS 入口正确。若构建产物中缺少 content-scripts 目录，需检查构建配置是否完整。',
      priority: 'medium',
      type: 'config',
    });
    if (!summaryParts.some((p) => p.includes('Content Script') || p.includes('内容脚本'))) {
      summaryParts.push('Content Script 未注入');
    }
  }

  // ── 5. 403/401 网络错误 ──────────────────────────────────────────────────
  const authErrors = report.network.badResponses.filter(
    (r) => r.status === 401 || r.status === 403,
  );
  if (authErrors.length > 0) {
    const authUrls = authErrors.map((r) => r.url).join('; ');
    suggestions.push({
      file: 'wxt.config.ts',
      description: `扩展请求返回 401/403 状态码。受影响的 URL：${authUrls}`,
      fix: '确认 manifest 中 host_permissions 覆盖了所有 API 域名，且 permissions 包含 "cookies" 及对应站点权限。如果请求涉及 Shopee SPC_CDS Cookie，检查 entrypoints/background.ts 中 getSpcCdsFromCookies 是否正确获取并传递 Cookie。',
      priority: 'high',
      type: 'manifest',
    });
    suggestions.push({
      file: 'entrypoints/background.ts',
      description: 'API 认证失败，需要检查 Cookie 令牌获取逻辑。',
      fix: '检查 entrypoints/background.ts 中 getSpcCdsFromCookies 函数的实现，确认能正确读取 seller.shopee.tw 域下的 SPC_CDS cookie 并附加到 API 请求中。',
      priority: 'high',
      type: 'source',
    });
    if (!summaryParts.some((p) => p.includes('认证') || p.includes('401') || p.includes('403'))) {
      summaryParts.push('API 认证失败（401/403）');
    }
  }

  // ── 6. CORS 错误 ─────────────────────────────────────────────────────────
  const corsErrors = report.network.failedRequests.filter((r) => {
    const lower = r.failure.toLowerCase();
    return lower.includes('cors') || lower.includes('blocked');
  });
  if (corsErrors.length > 0) {
    suggestions.push({
      file: 'entrypoints/background.ts',
      line: 1140,
      description: '检测到 CORS 拦截的网络请求，可能由 Content Script 发起的跨域请求导致。',
      fix: '将所有从 Content Script 发起的 fetch 请求迁移到 Background Service Worker 中，通过 chrome.runtime.sendMessage / onMessage 中转。检查 entrypoints/background.ts 中 onMessage 处理器（约 1140-1200 行）是否能处理相关请求。',
      priority: 'high',
      type: 'source',
    });
    if (!summaryParts.some((p) => p.includes('CORS'))) {
      summaryParts.push('存在 CORS 错误');
    }
  }

  // ── 7. SPC_CDS Cookie 问题 ───────────────────────────────────────────────
  const allConsole = [
    ...report.popup.console,
    ...report.targetPage.console,
    ...report.serviceWorker.console,
  ];
  const spcCdsMentions = allConsole.filter((entry) => {
    const lower = entry.text.toLowerCase();
    return lower.includes('spc_cds') || lower.includes('spccds');
  });
  if (spcCdsMentions.length > 0) {
    const sampleLines = spcCdsMentions
      .slice(0, 3)
      .map((e) => e.text)
      .join(' | ');
    suggestions.push({
      file: 'wxt.config.ts',
      description: `控制台日志中存在 SPC_CDS Cookie 相关输出。示例日志：${sampleLines}`,
      fix: '确认用户已登录 seller.shopee.tw，manifest 中 permissions 包含 "cookies" 和 "host_permissions" 覆盖 seller.shopee.tw。',
      priority: 'high',
      type: 'manifest',
    });
    suggestions.push({
      file: 'entrypoints/background.ts',
      description: 'SPC_CDS Cookie 读取可能存在问题。',
      fix: '检查 entrypoints/background.ts 中从 cookie 读取 SPC_CDS 的实现，确认使用 chrome.cookies.get API 时 domain 和 name 参数正确。',
      priority: 'high',
      type: 'source',
    });
    if (!summaryParts.some((p) => p.includes('SPC_CDS') || p.includes('Cookie'))) {
      summaryParts.push('SPC_CDS Cookie 相关问题');
    }
  }

  // ── 8. 5xx 服务器错误 ────────────────────────────────────────────────────
  const serverErrors = report.network.badResponses.filter((r) => r.status >= 500);
  if (serverErrors.length > 0) {
    const serverUrls = serverErrors.map((r) => `${r.status} ${r.url}`).join('; ');
    suggestions.push({
      file: 'wxt.config.ts',
      description: `服务器返回 5xx 错误。受影响的请求：${serverUrls}`,
      fix: '此为服务器端问题，非扩展自身代码错误。建议检查 Shopee 服务器状态或稍后重试。扩展可考虑增加自动重试逻辑或更友好的错误提示。',
      priority: 'low',
      type: 'network',
    });
    if (!summaryParts.some((p) => p.includes('5xx') || p.includes('服务器'))) {
      summaryParts.push('服务器返回 5xx 错误');
    }
  }

  // ── 9. 网络请求失败 (非 CORS) ────────────────────────────────────────────
  const otherFailures = report.network.failedRequests.filter((r) => {
    const lower = r.failure.toLowerCase();
    return !lower.includes('cors') && !lower.includes('blocked');
  });
  if (otherFailures.length > 0) {
    const failUrls = otherFailures.map((r) => r.url).join('; ');
    suggestions.push({
      file: 'wxt.config.ts',
      description: `存在非 CORS 的网络请求失败。受影响的 URL：${failUrls}`,
      fix: '检查 manifest 中 host_permissions 是否覆盖了所有请求的 URL。如果请求的是扩展内资源，检查 web_accessible_resources 配置。',
      priority: 'medium',
      type: 'manifest',
    });
    if (!summaryParts.some((p) => p.includes('网络请求'))) {
      summaryParts.push('存在网络请求失败');
    }
  }

  // ── 10. 视觉差异 ─────────────────────────────────────────────────────────
  if (report.visualRegression) {
    const visualIssues: string[] = [];
    if (
      report.visualRegression.popup &&
      report.visualRegression.popup.hasDiff
    ) {
      visualIssues.push('Popup 视觉差异');
      suggestions.push({
        file: 'entrypoints/popup/App.tsx',
        description: `Popup 页面与基线截图存在视觉差异（差异比例 ${report.visualRegression.popup.diffPercent.toFixed(1)}%）。`,
        fix: '检查 entrypoints/popup/App.tsx 对应的 CSS 或 DOM 结构是否发生变化，以及相关样式文件 (style.css) 是否被修改。如果是有意变更，请更新基线截图。',
        priority: 'medium',
        type: 'source',
      });
    }
    if (
      report.visualRegression.targetPage &&
      report.visualRegression.targetPage.hasDiff
    ) {
      visualIssues.push('目标页面视觉差异');
      suggestions.push({
        file: 'entrypoints/content.ts',
        description: `目标页面与基线截图存在视觉差异（差异比例 ${report.visualRegression.targetPage.diffPercent.toFixed(1)}%）。`,
        fix: '检查 entrypoints/content.ts 注入的 UI 元素 CSS 或 DOM 结构是否发生变化。如果是有意变更，请更新基线截图。',
        priority: 'medium',
        type: 'source',
      });
    }
    if (visualIssues.length > 0) {
      summaryParts.push(...visualIssues);
    }
  }

  // ── 汇总 severity ─────────────────────────────────────────────────────────
  const hasHigh = suggestions.some((s) => s.priority === 'high');
  const hasMedium = suggestions.some((s) => s.priority === 'medium');
  const hasLow = suggestions.some((s) => s.priority === 'low');

  if (hasHigh) {
    severity = 'error';
  } else if (hasMedium) {
    severity = 'warning';
  } else if (hasLow) {
    severity = 'warning';
  }

  // 给 harness-error 更高的覆盖：如果 diagnostics 报告 status 是 harness-error，采用它
  if (report.diagnostics.status === 'harness-error') {
    severity = 'harness-error';
  }

  const hasIssues = suggestions.length > 0;

  // ── 构建 summary ──────────────────────────────────────────────────────────
  let summary: string;
  if (!hasIssues) {
    summary = '检测通过，未发现问题。';
  } else {
    const uniqueParts = [...new Set(summaryParts)];
    summary = `发现 ${suggestions.length} 个问题：${uniqueParts.join('；')}。`;
  }

  // ── 判断能否自动修复 ─────────────────────────────────────────────────────
  // 可自动修复的条件：所有建议均涉及已知文件（非网络/依赖类型）且无 harness-error
  const canAutoFix =
    severity !== 'harness-error' &&
    suggestions.length > 0 &&
    suggestions.every((s) => s.type !== 'network' && s.type !== 'dependency');

  // ── 按优先级降序排列 ─────────────────────────────────────────────────────
  const priorityWeight = { high: 3, medium: 2, low: 1 };
  suggestions.sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority]);

  return {
    hasIssues,
    severity,
    suggestions,
    summary,
    canAutoFix,
  };
}

export type { HarnessReport } from '../report/report-types.js';
