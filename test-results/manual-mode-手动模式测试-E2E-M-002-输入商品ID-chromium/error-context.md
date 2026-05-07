# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: manual-mode.test.ts >> 手动模式测试 >> E2E-M-002: 输入商品ID
- Location: tests\e2e\manual-mode.test.ts:118:3

# Error details

```
TimeoutError: browserContext.waitForEvent: Timeout 15000ms exceeded while waiting for event "serviceworker"
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { join } from 'path';
  3   | import { fileURLToPath } from 'url';
  4   | 
  5   | const __dirname = fileURLToPath(new URL('.', import.meta.url));
  6   | 
  7   | async function getExtensionId(context: any): Promise<string> {
  8   |   // MV3: the service worker URL contains the extension ID
  9   |   const existing = context.serviceWorkers()[0];
  10  |   if (existing) return existing.url().split('/')[2];
> 11  |   const worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
      |                                ^ TimeoutError: browserContext.waitForEvent: Timeout 15000ms exceeded while waiting for event "serviceworker"
  12  |   return worker.url().split('/')[2];
  13  | }
  14  | 
  15  | test.describe('手动模式测试', () => {
  16  |   test('E2E-M-001: 设置全局折扣参数', async ({ browser }) => {
  17  |     const extensionPath = join(__dirname, '..', '..', '.output', 'chrome-mv3');
  18  |     const context = await browser.newContext({
  19  |       args: [
  20  |         `--disable-extensions-except=${extensionPath}`,
  21  |         `--load-extension=${extensionPath}`,
  22  |       ],
  23  |     });
  24  | 
  25  |     const extensionId = await getExtensionId(context);
  26  |     const page = await context.newPage();
  27  |     await page.goto(`chrome-extension://${extensionId}/popup.html`);
  28  |     await page.waitForSelector('#root');
  29  | 
  30  |     // 预填充缓存数据让 store 加载商品和活动，使折扣参数输入区可见
  31  |     await page.evaluate(() => {
  32  |       return chrome.storage.local.set({
  33  |         flashSaleCache: {
  34  |           timestamp: Date.now(),
  35  |           products: [{
  36  |             itemid: '123456789',
  37  |             name: '测试商品',
  38  |             images: [''],
  39  |             variationImages: [],
  40  |             transparentBackgroundImage: '',
  41  |             status: 0,
  42  |             inputOriginPrice: '1000',
  43  |             originPrice: '1000',
  44  |             normalStock: 100,
  45  |             localPrice: '1000',
  46  |             pffTag: false,
  47  |             normalSellerStock: 100,
  48  |             normalWmsStock: 0,
  49  |             minPurchaseLimit: 1,
  50  |             itemSellerSellableStock: 100,
  51  |             itemWmsSellableStock: 0,
  52  |             itemTotalReservedStock: 0,
  53  |             itemNormalStock: 100,
  54  |             modelList: [{
  55  |               modelid: '1',
  56  |               name: '默认规格',
  57  |               inputOriginPrice: '1000',
  58  |               originPrice: '1000',
  59  |               normalStock: 100,
  60  |               localPrice: '1000',
  61  |               pffTag: false,
  62  |               normalSellerStock: 100,
  63  |               normalWmsStock: 0,
  64  |               modelNormalStock: 100,
  65  |               modelSellerSellableStock: 100,
  66  |               modelWmsSellableStock: 0,
  67  |               modelTotalReservedStock: 0,
  68  |               enableShopFlashSaleNewStock: true,
  69  |               totalNormalStock: 100,
  70  |             }],
  71  |           }],
  72  |           flashSaleList: [{
  73  |             flash_sale_id: 999,
  74  |             name: '测试活动',
  75  |             start_time: Math.floor(Date.now() / 1000) - 3600,
  76  |             end_time: Math.floor(Date.now() / 1000) + 3600,
  77  |             status: 1,
  78  |           }],
  79  |           flashSaleId: 999,
  80  |           flashSaleInfo: '',
  81  |           skuOverrides: {},
  82  |           discountRate: 60,
  83  |           flashSaleStock: 200,
  84  |           purchaseLimit: 5,
  85  |           maxRetries: 10,
  86  |           infiniteRetry: false,
  87  |           enableProgress: null,
  88  |         },
  89  |       });
  90  |     });
  91  | 
  92  |     // 重新加载让 loadCache() 读取缓存数据
  93  |     await page.reload();
  94  |     await page.waitForSelector('#root');
  95  | 
  96  |     // 折扣率 input (type="number") 在 "折扣率 (%)" span 旁边
  97  |     const discountInput = page.locator('div').filter({ has: page.locator('span', { hasText: '折扣率' }) }).locator('input[type="number"]');
  98  |     await expect(discountInput).toBeVisible();
  99  |     await discountInput.fill('60');
  100 |     await expect(discountInput).toHaveValue('60');
  101 | 
  102 |     // 活动库存 input
  103 |     const stockInput = page.locator('div').filter({ has: page.locator('span', { hasText: '活动库存' }) }).locator('input[type="number"]');
  104 |     await expect(stockInput).toBeVisible();
  105 |     await stockInput.fill('100');
  106 |     await expect(stockInput).toHaveValue('100');
  107 | 
  108 |     // 限购数量 input
  109 |     const limitInput = page.locator('div').filter({ has: page.locator('span', { hasText: '限购数量' }) }).locator('input[type="number"]');
  110 |     await expect(limitInput).toBeVisible();
  111 |     await limitInput.fill('5');
```