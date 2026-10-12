import { chromium } from 'playwright';
import { mkdtempSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

export async function launchExtension(
  extensionPath: string,
  headed: boolean,
  timeout: number,
) {
  const absPath = resolve(extensionPath);
  if (!existsSync(absPath)) {
    throw new Error(`Extension path not found: ${absPath}`);
  }
  if (!existsSync(join(absPath, 'manifest.json'))) {
    throw new Error(`manifest.json not found in ${absPath}`);
  }

  console.log(`[launcher] Extension path: ${absPath}`);
  console.log(`[launcher] Manifest exists: true`);
  console.log(
    `[launcher] Dir contents: ${readdirSync(absPath).join(', ')}`,
  );

  const userDataDir = mkdtempSync(join(tmpdir(), 'harness-'));
  console.log(`[launcher] User data dir: ${userDataDir}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${absPath}`,
      `--load-extension=${absPath}`,
      `--no-sandbox`,
      `--enable-logging`,
    ],
    timeout,
  });

  return context;
}

export async function getExtensionId(
  context: any,
  timeout: number,
): Promise<string> {
  // Check existing workers first
  let serviceWorker = context.serviceWorkers()[0];

  if (!serviceWorker) {
    console.log('[launcher] No existing SW found, waiting for serviceworker event...');
    // Log all SW registrations
    context.on('serviceworker', (sw: any) => {
      console.log(`[launcher] ServiceWorker event: ${sw.url()}`);
    });

    try {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout });
    } catch {
      // Check if context has any pages
      const pages = context.pages();
      console.log(`[launcher] No SW after ${timeout}ms. Pages: ${pages.length}`);
      for (const p of pages) {
        console.log(`[launcher]   Page: ${p.url()}`);
      }

      // Try creating a page to trigger extension loading
      console.log('[launcher] Creating temporary page to trigger extension...');
      const tempPage = await context.newPage();
      try {
        await tempPage.goto('chrome://version', { waitUntil: 'domcontentloaded', timeout: 5000 });
        console.log(`[launcher] chrome://version loaded`);
      } catch {}
      await tempPage.close().catch(() => {});

      // Wait a bit and check again
      await new Promise((r) => setTimeout(r, 3000));
      serviceWorker = context.serviceWorkers()[0];
      if (!serviceWorker) {
        throw new Error(
          `No service worker detected after ${timeout}ms timeout. The extension may have an initialization error.`,
        );
      }
    }
  }

  const extensionId = serviceWorker.url().split('/')[2];
  console.log(`[launcher] Extension ID: ${extensionId}`);
  console.log(`[launcher] SW URL: ${serviceWorker.url()}`);
  return extensionId;
}
