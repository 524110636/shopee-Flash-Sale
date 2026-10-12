import type { BrowserContext } from 'playwright';
import type { PopupReport, ConsoleEntry } from '../report/report-types';

export async function observePopup(
  context: BrowserContext,
  extensionId: string,
  popupPath: string,
  outDir: string,
  popupWait: number,
): Promise<PopupReport> {
  const popupUrl = `chrome-extension://${extensionId}/${popupPath}`;
  const popup = await context.newPage();

  const consoleEntries: ConsoleEntry[] = [];
  const pageErrors: string[] = [];

  popup.on('console', (msg) => {
    consoleEntries.push({
      level: msg.type(),
      text: msg.text(),
      timestamp: new Date().toISOString(),
    });
  });

  popup.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  try {
    await popup.goto(popupUrl, {
      waitUntil: 'domcontentloaded',
      timeout: popupWait,
    });
    // Allow React rendering to complete
    await popup.waitForTimeout(2000);

    const title = await popup.title().catch(() => '');
    const visibleText = await popup
      .locator('body')
      .innerText()
      .catch(() => '');
    const screenshotPath = `${outDir}/popup.png`;
    await popup.screenshot({ path: screenshotPath, fullPage: true });

    await popup.close().catch(() => {});

    return {
      opened: true,
      url: popupUrl,
      title,
      visibleText: visibleText.trim(),
      console: consoleEntries,
      pageErrors,
      screenshot: screenshotPath,
    };
  } catch (err: any) {
    await popup.close().catch(() => {});
    return {
      opened: false,
      url: popupUrl,
      title: '',
      visibleText: '',
      console: consoleEntries,
      pageErrors: [...pageErrors, err.message],
      screenshot: null,
    };
  }
}
