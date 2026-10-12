import type { BrowserContext } from 'playwright';
import type { TargetPageReport, ConsoleEntry, HarnessManifest } from '../report/report-types';

export async function observeTargetPage(
  context: BrowserContext,
  targetUrl: string,
  outDir: string,
  timeout: number,
  manifest: HarnessManifest,
): Promise<TargetPageReport> {
  const target = await context.newPage();

  const consoleEntries: ConsoleEntry[] = [];
  const pageErrors: string[] = [];

  target.on('console', (msg) => {
    consoleEntries.push({
      level: msg.type(),
      text: msg.text(),
      timestamp: new Date().toISOString(),
    });
  });

  target.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  try {
    await target.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout,
    });
    // Wait for content scripts to inject and render
    await target.waitForTimeout(3000);

    const screenshotPath = `${outDir}/target-page.png`;
    await target.screenshot({ path: screenshotPath, fullPage: true });

    // Multi-strategy content script detection
    let contentScriptDetected = false;

    // Strategy A: DOM marker
    const domMarkers = await target
      .locator('[data-extension-root]')
      .count()
      .catch(() => 0);
    if (domMarkers > 0) contentScriptDetected = true;

    // Strategy B: Global variable
    if (!contentScriptDetected) {
      contentScriptDetected = await target
        .evaluate(() => {
          return Boolean(
            (window as any).__EXTENSION_MARKER__ ||
              (window as any).__EXTENSION_HARNESS_READY__,
          );
        })
        .catch(() => false);
    }

    // Strategy D: Known content script element IDs (extension-specific)
    if (!contentScriptDetected) {
      const knownIds = [
        '__flash_sale_progress__',
        '__flash_sale_panel__',
        '__flash_sale_copy_progress__',
      ];
      for (const id of knownIds) {
        const count = await target.locator(`#${id}`).count().catch(() => 0);
        if (count > 0) {
          contentScriptDetected = true;
          consoleEntries.push({
            level: 'info',
            text: `[harness] Content script detected via known element ID: #${id}`,
            timestamp: new Date().toISOString(),
          });
          break;
        }
      }
    }

    // Strategy C: manifest match pattern vs target URL
    if (!contentScriptDetected && manifest.contentScripts.length > 0) {
      try {
        const _targetHost = new URL(targetUrl).hostname;
        const urlMatches = manifest.contentScripts.some((cs) =>
          cs.matches.some((m) => {
            const escaped = m
              .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*');
            return new RegExp(`^${escaped}$`).test(targetUrl);
          }),
        );
        if (urlMatches) {
          consoleEntries.push({
            level: 'info',
            text: `[harness] URL matches content_scripts pattern, but no injection marker detected`,
            timestamp: new Date().toISOString(),
          });
        }
      } catch {}
    }

    await target.close().catch(() => {});

    return {
      opened: true,
      url: targetUrl,
      console: consoleEntries,
      pageErrors,
      contentScriptDetected,
      screenshot: screenshotPath,
    };
  } catch (err: any) {
    await target.close().catch(() => {});
    return {
      opened: false,
      url: targetUrl,
      console: consoleEntries,
      pageErrors: [...pageErrors, err.message],
      contentScriptDetected: false,
      screenshot: null,
    };
  }
}
