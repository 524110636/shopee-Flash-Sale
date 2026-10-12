import { test, expect, chromium } from '@playwright/test';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function setupExtension() {
  const extensionPath = join(__dirname, '..', '..', '.output', 'chrome-mv3');
  const userDataDir = mkdtempSync(join(tmpdir(), 'e2e-test-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      `--no-sandbox`,
    ],
  });

  const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = sw.url().split('/')[2];

  return { context, extensionId };
}

test.describe('手动模式测试', () => {
  test('E2E-M-001: 设置全局折扣参数', async () => {
    const { context, extensionId } = await setupExtension();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForSelector('#root');

    // 预填充缓存数据让 store 加载商品和活动，使折扣参数输入区可见
    await page.evaluate(() => {
      return chrome.storage.local.set({
        flashSaleCache: {
          timestamp: Date.now(),
          products: [{
            itemid: '123456789',
            name: '测试商品',
            images: [''],
            variationImages: [],
            transparentBackgroundImage: '',
            status: 0,
            inputOriginPrice: '1000',
            originPrice: '1000',
            normalStock: 100,
            localPrice: '1000',
            pffTag: false,
            normalSellerStock: 100,
            normalWmsStock: 0,
            minPurchaseLimit: 1,
            itemSellerSellableStock: 100,
            itemWmsSellableStock: 0,
            itemTotalReservedStock: 0,
            itemNormalStock: 100,
            modelList: [{
              modelid: '1',
              name: '默认规格',
              inputOriginPrice: '1000',
              originPrice: '1000',
              normalStock: 100,
              localPrice: '1000',
              pffTag: false,
              normalSellerStock: 100,
              normalWmsStock: 0,
              modelNormalStock: 100,
              modelSellerSellableStock: 100,
              modelWmsSellableStock: 0,
              modelTotalReservedStock: 0,
              enableShopFlashSaleNewStock: true,
              totalNormalStock: 100,
            }],
          }],
          flashSaleList: [{
            flash_sale_id: 999,
            name: '测试活动',
            start_time: Math.floor(Date.now() / 1000) - 3600,
            end_time: Math.floor(Date.now() / 1000) + 3600,
            status: 1,
          }],
          flashSaleId: 999,
          flashSaleInfo: '',
          skuOverrides: {},
          discountRate: 60,
          flashSaleStock: 200,
          purchaseLimit: 5,
          maxRetries: 10,
          infiniteRetry: false,
          enableProgress: null,
        },
      });
    });

    // 重新加载让 loadCache() 读取缓存数据
    await page.reload();
    await page.waitForSelector('#root');

    const discountInput = page.locator('span:has-text("折扣率") + input[type="number"]');
    await expect(discountInput).toBeVisible();
    await discountInput.fill('60');
    await expect(discountInput).toHaveValue('60');

    const stockInput = page.locator('span:has-text("活动库存") + input[type="number"]');
    await expect(stockInput).toBeVisible();
    await stockInput.fill('100');
    await expect(stockInput).toHaveValue('100');

    const limitInput = page.locator('span:has-text("限购数量") + input[type="number"]');
    await expect(limitInput).toBeVisible();
    await limitInput.fill('5');
    await expect(limitInput).toHaveValue('5');

    await page.close();
    await context.close();
  });

  test('E2E-M-002: 输入商品ID', async () => {
    const { context, extensionId } = await setupExtension();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForSelector('#root');

    await page.locator('summary', { hasText: '更多' }).click();
    await page.waitForTimeout(300);

    const textarea = page.locator('textarea[placeholder*="商品 ID"]');
    await expect(textarea).toBeVisible();
    await textarea.fill('123456789');
    await expect(textarea).toHaveValue('123456789');

    await page.close();
    await context.close();
  });
});
