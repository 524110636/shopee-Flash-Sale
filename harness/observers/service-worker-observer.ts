import type { BrowserContext } from 'playwright';
import type { ServiceWorkerReport, ConsoleEntry } from '../report/report-types';

export async function observeServiceWorker(
  context: BrowserContext,
  timeout: number,
): Promise<ServiceWorkerReport> {
  const consoleEntries: ConsoleEntry[] = [];
  const errors: string[] = [];

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await context.waitForEvent('serviceworker', { timeout });
    } catch {
      return {
        detected: false,
        url: null,
        console: [],
        errors: ['Service worker not detected within timeout'],
      };
    }
  }

  sw.on('console', (msg) => {
    consoleEntries.push({
      level: msg.type(),
      text: msg.text(),
      timestamp: new Date().toISOString(),
    });
  });

  const swUrl = sw.url();

  try {
    await sw.evaluate(() => self.location.href);
  } catch (err: any) {
    errors.push(`SW evaluate failed: ${err.message}`);
  }

  return {
    detected: true,
    url: swUrl,
    console: consoleEntries,
    errors,
  };
}
