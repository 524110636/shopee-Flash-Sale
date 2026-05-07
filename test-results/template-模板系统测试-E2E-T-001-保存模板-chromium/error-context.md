# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: template.test.ts >> 模板系统测试 >> E2E-T-001: 保存模板
- Location: tests\e2e\template.test.ts:79:3

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
  8   |   const existing = context.serviceWorkers()[0];
  9   |   if (existing) return existing.url().split('/')[2];
> 10  |   const worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
      |                                ^ TimeoutError: browserContext.waitForEvent: Timeout 15000ms exceeded while waiting for event "serviceworker"
  11  |   return worker.url().split('/')[2];
  12  | }
  13  | 
  14  | /** 预填充缓存使 store 加载商品和活动，让模板管理器可渲染 */
  15  | async function populateCache(page: any) {
  16  |   await page.evaluate(() => {
  17  |     return chrome.storage.local.set({
  18  |       flashSaleCache: {
  19  |         timestamp: Date.now(),
  20  |         products: [{
  21  |           itemid: '123456789',
  22  |           name: '测试商品',
  23  |           images: [''],
  24  |           variationImages: [],
  25  |           transparentBackgroundImage: '',
  26  |           status: 0,
  27  |           inputOriginPrice: '1000',
  28  |           originPrice: '1000',
  29  |           normalStock: 100,
  30  |           localPrice: '1000',
  31  |           pffTag: false,
  32  |           normalSellerStock: 100,
  33  |           normalWmsStock: 0,
  34  |           minPurchaseLimit: 1,
  35  |           itemSellerSellableStock: 100,
  36  |           itemWmsSellableStock: 0,
  37  |           itemTotalReservedStock: 0,
  38  |           itemNormalStock: 100,
  39  |           modelList: [{
  40  |             modelid: '1',
  41  |             name: '默认规格',
  42  |             inputOriginPrice: '1000',
  43  |             originPrice: '1000',
  44  |             normalStock: 100,
  45  |             localPrice: '1000',
  46  |             pffTag: false,
  47  |             normalSellerStock: 100,
  48  |             normalWmsStock: 0,
  49  |             modelNormalStock: 100,
  50  |             modelSellerSellableStock: 100,
  51  |             modelWmsSellableStock: 0,
  52  |             modelTotalReservedStock: 0,
  53  |             enableShopFlashSaleNewStock: true,
  54  |             totalNormalStock: 100,
  55  |           }],
  56  |         }],
  57  |         flashSaleList: [{
  58  |           flash_sale_id: 999,
  59  |           name: '测试活动',
  60  |           start_time: Math.floor(Date.now() / 1000) - 3600,
  61  |           end_time: Math.floor(Date.now() / 1000) + 3600,
  62  |           status: 1,
  63  |         }],
  64  |         flashSaleId: 999,
  65  |         flashSaleInfo: '',
  66  |         skuOverrides: {},
  67  |         discountRate: 60,
  68  |         flashSaleStock: 200,
  69  |         purchaseLimit: 5,
  70  |         maxRetries: 10,
  71  |         infiniteRetry: false,
  72  |         enableProgress: null,
  73  |       },
  74  |     });
  75  |   });
  76  | }
  77  | 
  78  | test.describe('模板系统测试', () => {
  79  |   test('E2E-T-001: 保存模板', async ({ browser }) => {
  80  |     const extensionPath = join(__dirname, '..', '..', '.output', 'chrome-mv3');
  81  |     const context = await browser.newContext({
  82  |       args: [
  83  |         `--disable-extensions-except=${extensionPath}`,
  84  |         `--load-extension=${extensionPath}`,
  85  |       ],
  86  |     });
  87  | 
  88  |     const extensionId = await getExtensionId(context);
  89  |     const page = await context.newPage();
  90  |     await page.goto(`chrome-extension://${extensionId}/popup.html`);
  91  |     await page.waitForSelector('#root');
  92  | 
  93  |     // 填充缓存后重新加载，使商品数据出现在 store 中
  94  |     await populateCache(page);
  95  |     await page.reload();
  96  |     await page.waitForSelector('#root');
  97  | 
  98  |     // 展开"更多"区域（模板管理器在里面）
  99  |     await page.locator('summary', { hasText: '更多' }).click();
  100 |     await page.waitForTimeout(300);
  101 | 
  102 |     // 折扣参数 input 验证（需要 products + flashSaleId 才渲染）
  103 |     const discountInput = page.locator('div').filter({ has: page.locator('span', { hasText: '折扣率' }) }).locator('input[type="number"]');
  104 |     await expect(discountInput).toBeVisible();
  105 |     await discountInput.fill('50');
  106 |     await expect(discountInput).toHaveValue('50');
  107 | 
  108 |     // 点击"保存模板"按钮
  109 |     const saveButton = page.locator('button', { hasText: '保存模板' });
  110 |     await expect(saveButton).toBeVisible();
```