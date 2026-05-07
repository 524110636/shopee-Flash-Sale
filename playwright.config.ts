import { defineConfig, devices } from '@playwright/test';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = resolve(__dirname, '.output', 'chrome-mv3');

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  use: {
    baseURL: 'https://seller.shopee.tw',
    headless: process.env.CI ? true : false,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--no-sandbox`,
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'playwright-report/report.json' }],
    ['list'],
  ],
});
