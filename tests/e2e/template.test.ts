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

/** 预填充缓存使 store 加载商品和活动 */
async function populateCache(page: any) {
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
}

test.describe('模板系统测试', () => {
  test('E2E-T-001: 保存模板', async () => {
    const { context, extensionId } = await setupExtension();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForSelector('#root');

    // 填充缓存后重载，使商品数据出现在 store 中
    await populateCache(page);
    await page.reload();
    await page.waitForSelector('#root');

    // 展开"更多"区域（模板管理器在里面）
    await page.locator('summary', { hasText: '更多' }).click();
    await page.waitForTimeout(300);

    // 验证折扣参数 input 可交互
    const discountInput = page.locator('span:has-text("折扣率") + input[type="number"]');
    await expect(discountInput).toBeVisible();
    await discountInput.fill('50');
    await expect(discountInput).toHaveValue('50');

    // 点击"保存模板"按钮
    const saveButton = page.locator('button', { hasText: '保存模板' });
    await expect(saveButton).toBeVisible();
    await saveButton.click();

    // 输入模板名称
    const nameInput = page.locator('input[placeholder*="例："]');
    await expect(nameInput).toBeVisible();
    await nameInput.fill('测试模板');

    // 点击"保存"确认按钮
    const confirmButton = page.locator('button', { hasText: '保存' });
    await confirmButton.click();

    // 验证保存成功提示
    await expect(page.locator('span', { hasText: '已保存' })).toBeVisible({ timeout: 5000 });

    await page.close();
    await context.close();
  });

  test('E2E-T-002: 加载模板', async () => {
    const { context, extensionId } = await setupExtension();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.waitForSelector('#root');

    // 填充缓存使商品数据可用
    await populateCache(page);

    // 预写入一个已保存的模板到 storage
    await page.evaluate(() => {
      return chrome.storage.local.set({
        flashSaleTemplates: {
          '测试模板': {
            name: '测试模板',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            discountRate: 50,
            flashSaleStock: 200,
            purchaseLimit: 5,
            skuOverrides: {},
            productInfo: [{ itemId: '123456789', name: '测试商品' }],
          },
        },
      });
    });

    // 重载使 store 读取缓存商品
    await page.reload();
    await page.waitForSelector('#root');

    // 展开"更多"区域
    await page.locator('summary', { hasText: '更多' }).click();
    await page.waitForTimeout(300);

    // 点击"加载模板"按钮
    const loadButton = page.locator('button', { hasText: '加载模板' });
    await expect(loadButton).toBeVisible();
    await loadButton.click();

    // 验证模板列表中显示已保存的模板
    await expect(page.locator('text=测试模板').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('button', { hasText: '应用' }).first()).toBeVisible();

    // 点击"应用"按钮
    await page.locator('button', { hasText: '应用' }).first().click();
    await page.waitForTimeout(500);

    // 验证应用后折扣率被更新为模板中的 50
    const discountInput = page.locator('span:has-text("折扣率") + input[type="number"]');
    await expect(discountInput).toHaveValue('50');

    await page.close();
    await context.close();
  });
});
