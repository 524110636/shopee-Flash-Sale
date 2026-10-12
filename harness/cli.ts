import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from './config.js';
import { readManifest, parseManifest } from './manifest-reader.js';
import { launchExtension, getExtensionId } from './launcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Parse cookies from the credentials markdown file.
 * The file contains a JSON array of Chrome cookie objects after "# cookie：".
 */
function loadShopeeCookies(): any[] {
  const credPath = join(__dirname, '账号密码.md');
  if (!existsSync(credPath)) {
    console.warn('[harness] Credentials file not found, skipping cookie import');
    return [];
  }
  const content = readFileSync(credPath, 'utf-8');
  // Extract JSON array: find first '[' and last ']'
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end === -1) {
    console.warn('[harness] No cookie JSON array found in credentials file');
    return [];
  }
  try {
    const raw = JSON.parse(content.slice(start, end + 1));
    // Map to Playwright cookie format (keep only relevant fields)
    return raw.map((c: any) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: c.secure ?? false,
      httpOnly: c.httpOnly ?? false,
      sameSite: c.sameSite || 'Lax',
      expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
    }));
  } catch (e) {
    console.warn('[harness] Failed to parse cookies:', (e as Error).message);
    return [];
  }
}
import { observePopup } from './observers/popup-observer.js';
import { observeServiceWorker } from './observers/service-worker-observer.js';
import { observeTargetPage } from './observers/target-page-observer.js';
import { setupContextNetworkCapture } from './observers/network-observer.js';
import { saveAllLogs } from './observers/file-logger.js';
import { compareScreenshot } from './observers/visual-regression.js';
import { writeReport, generateDiagnostics } from './report/report-writer.js';
import type { HarnessReport } from './report/report-types.js';

async function main() {
  const config = parseArgs(process.argv);

  console.log(`[harness] Extension: ${config.extensionPath}`);
  console.log(`[harness] Target: ${config.targetUrl}`);
  console.log(`[harness] Output: ${config.outDir}`);
  console.log(`[harness] Headed: ${config.headed}`);

  // Validate extension path
  if (!existsSync(join(config.extensionPath, 'manifest.json'))) {
    console.error(
      `[harness] Error: manifest.json not found in ${config.extensionPath}`,
    );
    process.exit(2);
  }

  // Read manifest
  console.log('\n[harness] Reading manifest...');
  const rawManifest = readManifest(config.extensionPath);
  const manifest = parseManifest(rawManifest);
  console.log(`[harness] Extension: ${manifest.name} v${manifest.version}`);
  if (manifest.defaultPopup)
    console.log(`[harness] Popup: ${manifest.defaultPopup}`);
  if (manifest.serviceWorker)
    console.log(`[harness] Service Worker: ${manifest.serviceWorker}`);
  if (manifest.contentScripts.length > 0) {
    console.log(
      `[harness] Content Scripts: ${manifest.contentScripts.map((cs) => cs.matches.join(', ')).join('; ')}`,
    );
  }

  // Launch browser
  console.log('\n[harness] Launching Chromium...');
  const context = await launchExtension(
    config.extensionPath,
    config.headed,
    config.timeout,
  );

  try {
    // Set up context-level network capture (before any pages are created)
    const network = setupContextNetworkCapture(context);

    // Import Shopee cookies before any navigation
    console.log('\n[harness] Importing Shopee cookies...');
    const cookies = loadShopeeCookies();
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      console.log(`[harness] Imported ${cookies.length} cookies`);
    } else {
      console.log('[harness] No cookies to import');
    }

    // Get extension ID
    console.log('\n[harness] Getting extension ID...');
    const extensionId = await getExtensionId(context, config.timeout);
    const serviceWorkerUrl = context.serviceWorkers()[0]?.url() || null;
    console.log(`[harness] Extension ID: ${extensionId}`);

    // Observe service worker
    console.log('\n[harness] Observing service worker...');
    const serviceWorkerReport = await observeServiceWorker(context, 10000);

    // Observe popup
    let popupReport: any = {
      opened: false,
      url: '',
      title: '',
      visibleText: '',
      console: [],
      pageErrors: ['No popup defined (no default_popup in manifest)'],
      screenshot: null,
    };

    if (manifest.defaultPopup) {
      console.log('\n[harness] Opening popup...');
      popupReport = await observePopup(
        context,
        extensionId,
        manifest.defaultPopup,
        config.outDir,
        config.popupWait,
      );
      console.log(
        `[harness] Popup: ${popupReport.opened ? 'opened' : 'failed'}`,
      );
      if (popupReport.pageErrors.length > 0) {
        console.log(
          `[harness] Popup errors: ${popupReport.pageErrors.join(', ')}`,
        );
      }
    } else {
      console.log('\n[harness] No popup defined in manifest, skipping');
    }

    // Observe target page
    console.log('\n[harness] Opening target page...');
    const targetPageReport = await observeTargetPage(
      context,
      config.targetUrl,
      config.outDir,
      config.timeout,
      manifest,
    );
    console.log(
      `[harness] Target page: ${targetPageReport.opened ? 'loaded' : 'failed'}`,
    );
    console.log(
      `[harness] Content script detected: ${targetPageReport.contentScriptDetected}`,
    );

    // Save logs to files
    console.log('\n[harness] Saving logs...');
    const logSources: { console: any[]; prefix: string }[] = [];
    if (popupReport.console?.length > 0) {
      logSources.push({ console: popupReport.console, prefix: 'popup' });
    }
    if (targetPageReport.console?.length > 0) {
      logSources.push({ console: targetPageReport.console, prefix: 'target' });
    }
    if (serviceWorkerReport.console?.length > 0) {
      logSources.push({ console: serviceWorkerReport.console, prefix: 'sw' });
    }
    saveAllLogs(logSources, network, config.outDir);

    // Visual regression: compare screenshots against baseline
    console.log('\n[harness] Visual regression check...');
    const visualRegression: { popup: any; targetPage: any } = {
      popup: null,
      targetPage: null,
    };

    if (popupReport.screenshot && existsSync(popupReport.screenshot)) {
      const vrResult = await compareScreenshot(
        popupReport.screenshot,
        config.outDir,
      );
      visualRegression.popup = vrResult.hasBaseline
        ? {
            checked: true,
            baselineCreated: false,
            hasDiff: vrResult.hasDiff,
            diffPercent: vrResult.diffPercent,
            diffPath: vrResult.diffPath,
          }
        : {
            checked: true,
            baselineCreated: true,
            hasDiff: false,
            diffPercent: 0,
            diffPath: null,
          };
      if (visualRegression.popup.baselineCreated) {
        console.log(
          `[harness] Popup baseline saved (first run, no comparison)`,
        );
      } else if (visualRegression.popup.hasDiff) {
        console.log(
          `[harness] Popup visual diff: ${vrResult.diffPercent.toFixed(2)}% (${vrResult.diffPath})`,
        );
      } else {
        console.log(`[harness] Popup visual: no diff`);
      }
    }

    if (targetPageReport.screenshot && existsSync(targetPageReport.screenshot)) {
      const vrResult = await compareScreenshot(
        targetPageReport.screenshot,
        config.outDir,
      );
      visualRegression.targetPage = vrResult.hasBaseline
        ? {
            checked: true,
            baselineCreated: false,
            hasDiff: vrResult.hasDiff,
            diffPercent: vrResult.diffPercent,
            diffPath: vrResult.diffPath,
          }
        : {
            checked: true,
            baselineCreated: true,
            hasDiff: false,
            diffPercent: 0,
            diffPath: null,
          };
      if (visualRegression.targetPage.baselineCreated) {
        console.log(
          `[harness] Target page baseline saved (first run, no comparison)`,
        );
      } else if (visualRegression.targetPage.hasDiff) {
        console.log(
          `[harness] Target page visual diff: ${vrResult.diffPercent.toFixed(2)}% (${vrResult.diffPath})`,
        );
      } else {
        console.log(`[harness] Target page visual: no diff`);
      }
    }

    // Build network data
    const networkData = {
      failedRequests: network.failedRequests,
      badResponses: network.badResponses,
    };

    // Diagnostics
    console.log('\n[harness] Running diagnostics...');
    const diagnostics = generateDiagnostics({
      manifest,
      popup: popupReport,
      targetPage: targetPageReport,
      serviceWorker: serviceWorkerReport,
      network: networkData,
      targetUrl: config.targetUrl,
      visualRegression: {
        popup: visualRegression.popup,
        targetPage: visualRegression.targetPage,
      },
    });

    // Build report
    const report: HarnessReport = {
      meta: {
        timestamp: new Date().toISOString(),
        harnessVersion: '0.1.0',
        extensionPath: config.extensionPath,
        targetUrl: config.targetUrl,
      },
      manifest,
      runtime: {
        extensionId,
        serviceWorkerUrl,
      },
      popup: popupReport,
      targetPage: targetPageReport,
      serviceWorker: serviceWorkerReport,
      network: networkData,
      visualRegression: visualRegression.popup || visualRegression.targetPage
        ? visualRegression
        : undefined,
      diagnostics,
    };

    // Write report
    writeReport(config.outDir, report);

    // Summary
    console.log('\n========== Harness Results ==========');
    console.log(`  Status:      ${diagnostics.status}`);
    console.log(`  Report:      ${config.outDir}/latest-report.json`);
    if (popupReport.screenshot)
      console.log(`  Popup SS:    ${popupReport.screenshot}`);
    if (targetPageReport.screenshot)
      console.log(`  Target SS:   ${targetPageReport.screenshot}`);
    if (network.failedRequests.length > 0)
      console.log(`  Failed Reqs: ${network.failedRequests.length}`);
    if (network.badResponses.length > 0)
      console.log(`  Bad Resp:    ${network.badResponses.length}`);
    if (visualRegression.popup?.hasDiff)
      console.log(`  Popup Diff:  ${visualRegression.popup.diffPercent.toFixed(2)}%`);
    if (visualRegression.targetPage?.hasDiff)
      console.log(`  Target Diff: ${visualRegression.targetPage.diffPercent.toFixed(2)}%`);
    console.log('');
    for (const msg of diagnostics.summary) {
      console.log(`  - ${msg}`);
    }
    console.log('=====================================\n');

    process.exit(
      diagnostics.status === 'harness-error'
        ? 2
        : diagnostics.status === 'error'
          ? 1
          : 0,
    );
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\n[harness] Fatal error: ${err.message}`);
  process.exit(2);
});
