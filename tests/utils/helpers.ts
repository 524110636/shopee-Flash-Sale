import { test as base, type Page, type BrowserContext } from '@playwright/test';

export const test = base.extend<{
  context: BrowserContext;
  popupPage: Page;
}>({
  context: async ({ browser }, use) => {
    const context = await browser.newContext({
      permissions: ['storage', 'cookies', 'scripting'],
    });
    
    await context.grantPermissions(['storage', 'cookies']);
    
    await use(context);
    
    await context.close();
  },

  popupPage: async ({ context, browser: _browser }, use) => {
    const backgroundPage = await context.backgroundPages()[0] ||
      (await context.waitForEvent('backgroundpage'));
    
    const extensionId = backgroundPage.url().split('/')[2];
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    
    const page = await context.newPage();
    await page.goto(popupUrl);
    
    await use(page);
    
    await page.close();
  },
});

export async function waitForPopupLoad(page: Page, timeout = 10000) {
  await page.waitForSelector('body', { timeout });
  await page.waitForTimeout(2000);
}

export async function clearStorage(context: BrowserContext) {
  await context.clearCookies();
  await context.clearPermissions();
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleString('zh-TW');
}

export function buildSkuKey(itemId: string, modelId: string): string {
  return `${itemId}-${modelId}`;
}
