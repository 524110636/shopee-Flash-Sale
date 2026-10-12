import type { BrowserContext, Page } from 'playwright';

/**
 * A realistic Chrome 130 Windows User-Agent string for use with Shopee domains.
 */
export const SHOPEE_UA: string =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Taipei geolocation coordinates.
 */
const TAIPEI_COORDS = { latitude: 25.033, longitude: 121.565 };

/**
 * Common extra HTTP headers that a real browser sends.
 */
const COMMON_HEADERS: Record<string, string> = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * A Playwright launch-config fragment that can be merged directly into
 * `launchPersistentContext` (or `browserType.launch`) options.
 *
 * Contains viewport, locale, timezone, geolocation, extra HTTP headers,
 * and bypassCSP tailored for seller.shopee.tw.
 */
export const shopeeLaunchConfig = {
  viewport: { width: 1920, height: 1080 },
  locale: 'zh-TW' as const,
  timezoneId: 'Asia/Taipei' as const,
  geolocation: TAIPEI_COORDS,
  bypassCSP: true,
  extraHTTPHeaders: COMMON_HEADERS,
};

/**
 * Checks whether a given URL belongs to a Shopee domain.
 *
 * @param url - The URL to test.
 * @returns `true` if the hostname ends with `.shopee.tw` or is `shopee.tw`.
 */
export function isShopeeUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === 'shopee.tw' || hostname.endsWith('.shopee.tw');
  } catch {
    return false;
  }
}

/**
 * Applies Shopee-specific anti-detection optimisations to a Playwright
 * {@link BrowserContext}.
 *
 * This includes:
 * - Realistic User-Agent, viewport, locale, timezone & geolocation.
 * - `navigator.webdriver` override via `addInitScript`.
 * - Extra HTTP headers mimicking a real Chrome browser.
 * - Automatic per-page anti-detection setup via the `page` event.
 *
 * @param context - The Playwright `BrowserContext` to patch.
 */
export function createShopeeContext(context: BrowserContext): void {
  // --- Context-level setup ---------------------------------------------------

  // 1. Realistic User-Agent
  context.setExtraHTTPHeaders({
    'User-Agent': SHOPEE_UA,
  });

  // 2. Override navigator.webdriver on every page load
  context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // 3. Per-page anti-detection setup
  context.on('page', async (page: Page) => {
    // Set viewport on every new page
    await page.setViewportSize({ width: 1920, height: 1080 });

    // Set locale & timezone via CDP if available (Playwright CDPSession)
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setLocaleOverride', { locale: 'zh-TW' });
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Taipei' });
      await cdp.send('Emulation.setGeolocationOverride', {
        latitude: TAIPEI_COORDS.latitude,
        longitude: TAIPEI_COORDS.longitude,
        accuracy: 1,
      });
      await cdp.detach().catch(() => {});
    } catch {
      // CDP session may not be available in all environments; silently skip.
    }
  });
}

/**
 * Waits for a Shopee page to stabilise after navigation.
 *
 * The function:
 * 1. Waits for `domcontentloaded`.
 * 2. Waits for `networkidle` with a 10-second timeout (non-fatal).
 * 3. Detects Cloudflare challenge / block pages – returns `false` if found.
 * 4. Detects login forms – returns `true` but logs a warning via `console.warn`.
 * 5. Pauses 3 extra seconds for JS execution to complete.
 *
 * @param page    - The Playwright `Page` to monitor.
 * @param timeout - Maximum time (ms) to wait for initial page load.
 * @returns `true` if the page appears usable; `false` if it was intercepted.
 */
export async function waitForShopeePage(page: Page, timeout: number): Promise<boolean> {
  try {
    // 1. Wait for DOM content to be loaded
    await page.waitForLoadState('domcontentloaded', { timeout });
  } catch {
    return false;
  }

  // 2. Wait for network idle but with a short timeout (non-fatal)
  try {
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
  } catch {
    // Network may never go fully idle; continue.
  }

  try {
    // 3. Detect Cloudflare / anti-bot pages
    const pageTitle = await page.title().catch(() => '');
    const pageContent = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');

    const cloudflareKeywords = [
      'just a moment',
      'checking your browser',
      'cloudflare',
      'attention required',
      'enable javascript',
      'err_connection_closed',
      '403 forbidden',
    ];

    const isCloudflare = cloudflareKeywords.some(
      (kw) => pageTitle.toLowerCase().includes(kw) || pageContent.toLowerCase().includes(kw),
    );

    if (isCloudflare) {
      return false;
    }

    // 4. Detect login form (still usable, but warn)
    const hasLoginForm = await page
      .evaluate(() => {
        const lower = document.body?.innerHTML?.toLowerCase() ?? '';
        return (
          lower.includes('login') ||
          lower.includes('登入') ||
          lower.includes('signin') ||
          lower.includes('password') ||
          lower.includes('密碼')
        );
      })
      .catch(() => false);

    if (hasLoginForm) {
      console.warn('[shopee-hooks] Login form detected on page – continuing with limited access.');
    }
  } catch {
    // If evaluation fails, proceed anyway.
  }

  // 5. Allow JS to settle
  await page.waitForTimeout(3000);

  return true;
}

/**
 * Checks whether the `SPC_CDS` cookie exists on the current page and returns
 * its value (truncated to the first 10 characters) for confirmation purposes.
 *
 * @param page - The Playwright `Page` to inspect.
 * @returns An object with `exists` and optionally a `value` prefix.
 */
export async function getSpcCdsStatus(
  page: Page,
): Promise<{ exists: boolean; value?: string }> {
  try {
    const cookies = await page.context().cookies();
    const spcCds = cookies.find((c) => c.name === 'SPC_CDS');
    if (spcCds) {
      return {
        exists: true,
        value: spcCds.value.slice(0, 10),
      };
    }

    // Fallback: check via document.cookie
    const docCookie = await page.evaluate(() => document.cookie).catch(() => '');
    const match = docCookie.match(/(?:^|;\s*)SPC_CDS=([^;]*)/);
    if (match) {
      return {
        exists: true,
        value: match[1].slice(0, 10),
      };
    }

    return { exists: false };
  } catch {
    return { exists: false };
  }
}
