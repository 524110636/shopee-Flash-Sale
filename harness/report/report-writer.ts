import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  HarnessReport,
  HarnessManifest,
  PopupReport,
  TargetPageReport,
  ServiceWorkerReport,
  NetworkReport,
} from './report-types';
import { categorizeFailure } from '../observers/network-observer';

export interface DiagnosticsInput {
  manifest: HarnessManifest;
  popup: PopupReport;
  targetPage: TargetPageReport;
  serviceWorker: ServiceWorkerReport;
  network: NetworkReport;
  targetUrl: string;
  visualRegression?: {
    popup: { hasDiff: boolean; diffPercent: number; diffPath: string | null } | null;
    targetPage: { hasDiff: boolean; diffPercent: number; diffPath: string | null } | null;
  };
}

function runDiagnostics(input: DiagnosticsInput) {
  const summary: string[] = [];
  const probableCauses: string[] = [];
  const suggestedNextChecks: string[] = [];
  let status: 'pass' | 'warning' | 'error' | 'harness-error' = 'pass';

  // ── Service Worker ──────────────────────────────────────────────
  if (!input.serviceWorker.detected) {
    status = 'error';
    summary.push('Service worker not detected');
    probableCauses.push(
      'manifest background.service_worker is missing, the file is not in build output, or the SW has a runtime error during registration',
    );
    suggestedNextChecks.push('Check manifest.json for background.service_worker');
    suggestedNextChecks.push('Verify background.js exists in the build directory');
    suggestedNextChecks.push('Open chrome://extensions and check for errors on the extension card');
  }

  // Check SW console for startup errors
  if (input.serviceWorker.detected) {
    const swErrors = input.serviceWorker.console.filter(
      (e) => e.level === 'error' || e.level === 'assert',
    );
    const swStartupErrors = input.serviceWorker.errors;
    if (swErrors.length > 0 || swStartupErrors.length > 0) {
      status = 'error';
      summary.push('Service worker reported errors during startup');
      for (const e of swErrors) {
        probableCauses.push(`SW console error: ${e.text.slice(0, 200)}`);
      }
      for (const e of swStartupErrors) {
        probableCauses.push(`SW runtime error: ${e.slice(0, 200)}`);
      }
      suggestedNextChecks.push('Review service worker console output in report');
    }
  }

  // ── Popup ───────────────────────────────────────────────────────
  if (!input.popup.opened) {
    status = 'error';
    summary.push('Popup failed to open');
    probableCauses.push('Popup HTML or JS may have errors, or the popup path in manifest is wrong');
    suggestedNextChecks.push('Check manifest action.default_popup path');
    suggestedNextChecks.push('Verify popup.html exists in the build directory');
  } else if (!input.popup.visibleText && input.popup.pageErrors.length > 0) {
    status = 'error';
    summary.push('Popup rendered but appears blank with JS errors');
    probableCauses.push('React/Vue mount failed due to import error, CSP, or missing dependency');
    for (const err of input.popup.pageErrors) {
      probableCauses.push(`Popup page error: ${err.slice(0, 200)}`);
    }
    suggestedNextChecks.push('Review popup pageErrors and console errors in report');
    suggestedNextChecks.push('Check CSP headers in popup.html');
  } else if (!input.popup.visibleText) {
    status = 'warning';
    summary.push('Popup rendered but has no visible text (may rely on async data)');
    probableCauses.push('Popup content depends on an API call or chrome.storage data that did not resolve yet');
    suggestedNextChecks.push('Increase --popup-wait timeout and retry');
    suggestedNextChecks.push('Check if popup has a loading state that blocks text rendering');
  }

  // ── Target Page ─────────────────────────────────────────────────
  if (!input.targetPage.opened) {
    status = 'error';
    summary.push('Target page failed to load');
    probableCauses.push('URL is unreachable, requires authentication, or page load exceeded timeout');
    suggestedNextChecks.push('Verify target URL is accessible from a regular browser');
    suggestedNextChecks.push('If the page requires login, ensure session cookies are available');
  } else {
    // Check target page for JS errors
    if (input.targetPage.pageErrors.length > 0) {
      status = 'warning';
      summary.push(`Target page has ${input.targetPage.pageErrors.length} JS error(s)`);
      for (const err of input.targetPage.pageErrors) {
        probableCauses.push(`Target page error: ${err.slice(0, 200)}`);
      }
    }
  }

  // ── Content Script ──────────────────────────────────────────────
  if (
    !input.targetPage.contentScriptDetected &&
    input.manifest.contentScripts.length > 0
  ) {
    const shouldMatch = input.manifest.contentScripts.some((cs) =>
      cs.matches.some((m) => {
        const escaped = m.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${escaped}$`).test(input.targetUrl);
      }),
    );
    if (shouldMatch) {
      status = 'warning';
      summary.push('Content script not detected on a matching target page');
      probableCauses.push(
        'The URL matches content_scripts.matches, but the script either has a runtime error, ' +
          'the build output is missing, or the injection marker is not present',
      );
      suggestedNextChecks.push('Verify content script build output exists in the extension directory');
      suggestedNextChecks.push('Open browser DevTools on the target page and check for content script errors');
      suggestedNextChecks.push('Consider adding a dev-only DOM marker (data-extension-root) to the content script');
    }
  }

  // ── Network: Failed Requests ────────────────────────────────────
  const corsFailures: string[] = [];
  const otherFailures: string[] = [];

  for (const req of input.network.failedRequests) {
    const category = categorizeFailure(req.url, req.failure);
    if (category === 'cors') {
      corsFailures.push(req.url);
    } else {
      otherFailures.push(req.url);
    }
  }

  if (corsFailures.length > 0) {
    status = 'error';
    summary.push(`${corsFailures.length} CORS error(s) detected`);
    probableCauses.push(
      `CORS errors typically occur when a content script makes fetch() calls to a different origin. ` +
        `In MV3, content script fetch() requests are subject to the page's CORS policy, not the extension's.`,
    );
    for (const url of corsFailures.slice(0, 3)) {
      probableCauses.push(`CORS failure URL: ${url.slice(0, 150)}`);
    }
    suggestedNextChecks.push(
      'For CORS errors from content scripts: move the fetch() call to the background service worker ' +
        'and use chrome.runtime.sendMessage to relay results',
    );
    suggestedNextChecks.push('Ensure host_permissions covers the target API domain');
  }

  if (otherFailures.length > 0) {
    status = 'error';
    summary.push(`${otherFailures.length} request(s) failed to load`);
    for (const url of otherFailures.slice(0, 5)) {
      probableCauses.push(`Failed request: ${url.slice(0, 150)}`);
    }
    suggestedNextChecks.push('Check if these URLs are accessible and if host_permissions covers them');
  }

  // ── Network: 4xx / 5xx ──────────────────────────────────────────
  const bad403 = input.network.badResponses.filter((r) => r.status === 403);
  const bad401 = input.network.badResponses.filter((r) => r.status === 401);
  const badOther4xx = input.network.badResponses.filter(
    (r) => r.status >= 400 && r.status < 500 && r.status !== 403 && r.status !== 401,
  );
  const bad5xx = input.network.badResponses.filter((r) => r.status >= 500);

  if (bad401.length > 0) {
    status = 'error';
    summary.push(`${bad401.length} 401 Unauthorized response(s)`);
    probableCauses.push('Authentication token (cookie/header) is missing or expired');
    suggestedNextChecks.push('Verify login state for the target domain');
    suggestedNextChecks.push('Check if SPC_CDS cookie exists and is valid for shopee.tw');
  }

  if (bad403.length > 0) {
    status = 'error';
    summary.push(`${bad403.length} 403 Forbidden response(s)`);
    probableCauses.push(
      '403 errors suggest missing host_permissions in manifest.json, ' +
        'or the server is rejecting the request based on origin/referer headers',
    );
    for (const r of bad403.slice(0, 3)) {
      probableCauses.push(`403 URL: ${r.url.slice(0, 150)} (${r.method})`);
    }
    suggestedNextChecks.push('Check host_permissions includes the API domain');
    suggestedNextChecks.push(
      'If the request is from a content script (Origin = page origin), consider moving it to the background SW',
    );
    suggestedNextChecks.push('Verify SPC_CDS cookie is valid and not expired');
  }

  if (badOther4xx.length > 0) {
    status = 'warning';
    summary.push(`${badOther4xx.length} other 4xx response(s)`);
    suggestedNextChecks.push('Review 4xx response URLs to determine if they are expected');
  }

  if (bad5xx.length > 0) {
    status = 'warning';
    summary.push(`${bad5xx.length} server error(s) (5xx)`);
    suggestedNextChecks.push('Server errors suggest the API endpoint is down or unstable, not an extension issue');
  }

  // ── Check: Popup console for SPC_CDS errors (Shopee-specific) ───
  const popupCdsErrors = input.popup.console.filter(
    (c) =>
      c.level === 'error' &&
      (c.text.includes('SPC_CDS') || c.text.includes('spcCds')),
  );
  if (popupCdsErrors.length > 0) {
    status = 'error';
    summary.push('Popup reports SPC_CDS cookie issues');
    probableCauses.push('The extension needs SPC_CDS cookie from seller.shopee.tw but it is missing or expired');
    suggestedNextChecks.push('Open seller.shopee.tw in the same browser session and ensure you are logged in');
    suggestedNextChecks.push('Check that cookies permission is declared in manifest permissions');
  }

  // ── Visual Regression ────────────────────────────────────────────
  const vr = input.visualRegression;
  if (vr) {
    if (vr.popup?.hasDiff) {
      status = 'warning';
      summary.push(
        `Popup screenshot differs from baseline (${vr.popup.diffPercent.toFixed(2)}%)`,
      );
      if (vr.popup.diffPath) {
        probableCauses.push(`Visual diff saved at: ${vr.popup.diffPath}`);
      }
      suggestedNextChecks.push(
        'Review popup screenshot changes — expected UI update or regression?',
      );
    }
    if (vr.targetPage?.hasDiff) {
      status = 'warning';
      summary.push(
        `Target page screenshot differs from baseline (${vr.targetPage.diffPercent.toFixed(2)}%)`,
      );
      if (vr.targetPage.diffPath) {
        probableCauses.push(`Visual diff saved at: ${vr.targetPage.diffPath}`);
      }
      suggestedNextChecks.push(
        'Review target page screenshot changes — expected UI update or regression?',
      );
    }
  }

  if (status === 'pass') {
    summary.push('All checks passed');
  }

  return { status, summary, probableCauses, suggestedNextChecks };
}

export function writeReport(outDir: string, report: HarnessReport): void {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const reportPath = join(outDir, 'latest-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
}

export function generateDiagnostics(input: DiagnosticsInput) {
  return runDiagnostics(input);
}
