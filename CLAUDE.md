# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 限时特卖助手 (Limited Time Sale Helper)

**版本:** 1.1.0
**状态:** 功能完善阶段

## 相关文档
- `docs/shopee-flash-sale-api.md` — Shopee API endpoints and response formats
- `docs/superpowers/specs/2026-05-02-copy-flash-sale-design.md` — Copy flash sale design spec
- `docs/superpowers/plans/2026-05-02-copy-flash-sale-plan.md` — Copy flash sale implementation plan

## Project Overview
Chrome extension (MV3) for automating Shopee Taiwan seller center flash sale operations. Built with WXT + React 19 + TypeScript + Tailwind CSS + shadcn/ui + Zustand.

## Development Commands
- `npm run dev` — Start dev server with hot reload (WXT)
- `npm run build` — Production build
- `npm run zip` — Build + create zip for Chrome Web Store
- `npm run compile` — TypeScript compilation only (no bundling)
- `npm run postinstall` — Run `wxt prepare` after install

## Tech Stack & Key Versions
- **WXT** 0.20.25 — Chrome MV3 extension framework (Vite 8 under the hood)
- **React** 19.2.5 + **TypeScript** 6.0
- **Zustand** 5.0.12 — State management (single store for all business logic)
- **Tailwind CSS** 3.4 + shadcn/ui (`components/ui/`) — UI
- Extension API: `chrome` (configured in `wxt.config.ts` via `extensionApi: 'chrome'`)

## Architecture

### Entrypoints (WXT convention)
- **`entrypoints/popup/`** — Popup UI: App.tsx (layout), store.ts (Zustand + all business logic), types.ts
- **`entrypoints/background.ts`** — Service Worker: SPC_CDS cookie extraction, flash sale enable loop (`runEnableLoop` with `injectedFetch`), copy flash sale flows (EXECUTE_COPY/SCHEDULE_COPY/COPY_FLASH_SALE), message relay
- **`entrypoints/content.ts`** — Content script: floating progress bar UI on seller.shopee.tw with stop button, listens for ENABLE_PROGRESS/ENABLE_COMPLETE messages

### Critical Design Decisions
1. **Enable loop runs in background Service Worker** — `runEnableLoop` is in `background.ts`, not popup. Popup builds items, saves params via `storage.local`, sends `START_ENABLE` message. Background sends `ENABLE_PROGRESS`/`ENABLE_COMPLETE` messages back. Loop continues after popup closes. Uses `_enableRunning` flag + try/finally to prevent concurrent loops.
2. **Data loading still in popup** — Uses `browser.scripting.executeScript({ world: 'MAIN' })` via `injectedFetch()`. Background's `injectedFetch` finds seller tab by URL (not active tab), allowing loop to run while user switches tabs.
3. **SPC_CDS cookie extraction** — `browser.cookies.get()` with multi-domain fallback chain: `seller.shopee.tw` → `shopee.tw` → `www.shopee.tw` → `cookies.getAll({ domain: '.shopee.tw' })`
4. **All business logic in Zustand store** — `store.ts` is the single source of truth; React components are thin wrappers
5. **Optimistic UI updates** — `isEnabling` set to true before START_ENABLE response, button changes immediately. On reopen, `checkBackgroundStatus` reads `_enableProgress` directly from `storage.local` instead of messaging.
6. **Storage-based communication** — `browser.runtime.sendMessage` responses in MV3 can return `undefined` even on success. For critical flows (EXECUTE_COPY) and status checks (GET_ENABLE_STATUS), use `browser.storage.onChanged` or direct storage reads instead of relying on `sendMessage` response.
7. **Copy flow uses `get_shop_flash_sale_item/`** — Source item config is fetched via API, then applied to new flash sale via `set_shop_flash_sale_items/`. The `from` parameter via Referrer header approach (server-side auto-copy) is unreliable in fetch API context.
8. **Button pattern for inline actions** — All text-style links (`underline hover:underline`) are converted to `<Button variant="outline" size="sm">` with compact custom sizing (`h-5 px-1.5 text-[10px]` for inline, `h-6 px-2 text-xs` for normal). Color-coded variants: green for positive actions (应用, 保存), red for destructive (删除, 停止), blue/primary for navigation (复制, 查看), neutral for cancel/close. Custom classes override the `h-9` default from `size="sm"`. Selected/highlighted states use `border-l-4 border-l-blue-500 bg-blue-50/50` matching ProductCard's modified-item indicator style.
9. **Stale product state guard** — `loadFlashSaleProducts` clears `products`, `productIds`, `inputText` when the source flash sale has 0 items (early return), preventing stale data from previous queries. `handleOpenView` in CopyConfirmPanel always reloads source products regardless of current `products.length`.

### Data Flow
```
Data loading (popup):
  User Input → App.tsx → store.ts actions → injectedFetch() →
    scripting.executeScript(MAIN world) → fetch() →
    response → store state update → React re-render

Enable loop (background):
  Popup: build items → storage.local(params) → isEnabling=true → START_ENABLE message
  Background: retry-read params → runEnableLoop() → saveProgress(running=true immediately) →
    loop(injectedFetch on any seller tab) → storage.local(progress) →
    ENABLE_PROGRESS → runtime.sendMessage(popup) + tabs.sendMessage(content script)
  (Popup can close; loop continues; reopen: GET_ENABLE_STATUS restores isEnabling state)

Copy flash sale (background):
  Popup: executeCopy() → clear _copyTaskStatus → send EXECUTE_COPY message (fire-and-forget) →
    waitForStorage() listens for storage.onChanged('_copyTaskStatus')
  Background: EXECUTE_COPY handler → step1(close active) → step2(get time slots) →
    step3(create empty sale) → step4a(apply template) or step4b(fetch source items + apply) →
    save _copyTaskStatus to storage → storage.onChanged triggers popup resolve
```

### Message Protocol
- **Popup → Background:** `START_ENABLE`, `STOP_ENABLE`, `GET_ENABLE_STATUS`, `CLEAR_ENABLE_STATE`, `SPC_CDS_REQUEST`, `EXECUTE_COPY`, `SCHEDULE_COPY`, `GET_TIME_SLOTS`, `GET_FLASH_SALE_ITEM_COUNT`, `CLOSE_FLASH_SALE`, `COPY_FLASH_SALE`, `APPLY_TEMPLATE_ITEMS`
- **Background → Popup:** `ENABLE_PROGRESS`, `ENABLE_COMPLETE`
- **Background → Content Script:** `ENABLE_PROGRESS`, `ENABLE_COMPLETE`
- **Content Script → Background:** `STOP_ENABLE` (via stop button in progress UI)
- **Storage-based (reliable):** `_copyTaskStatus`, `_enableProgress`, `_enableParams` — used when `sendMessage` response is unreliable (MV3 bug)

### Key API Endpoints
- **GraphQL:** `POST /api/marketing/v4/graphql/query/` — product/SKU details
- **Flash Sale:** `/api/marketing/v4/shop_flash_sale/{get_shop_flash_sale_list,get_shop_flash_sale_item_id_list,set_shop_flash_sale_items,set_shop_flash_sale,get_time_slot_id,get_shop_flash_sale_item}`
- **Required header:** `sc-fe-session` (CSRF token, extracted from page DOM/window)
- **Required body field:** `use_global_category: true` (missing this causes code 1001 error)
- **Price rules:** Must be integer, strictly less than origin price

### Copy Flash Sale Flow
1. `enterCopyMode(flashSale)` — loads source item count and products into store
2. `executeCopy(targetTime, templateName)` — one-stop-shop execution:
   - **Step 1:** Close any active flash sales (status=1)
   - **Step 2:** Fetch available time slots via `get_time_slot_id/`
   - **Step 3:** Create empty flash sale via `set_shop_flash_sale/` with `{ time_slot_id }`
   - **Step 4a (with template):** Build `EnableItem[]` from `products` + template params, apply via `set_shop_flash_sale_items/`
   - **Step 4b (no template):** Fetch source items via `get_shop_flash_sale_item/`, parse `item_info` items + `price`, apply via `set_shop_flash_sale_items/`
   - Results saved to `_copyTaskStatus` in storage (reliable communication)
3. `SCHEDULE_COPY` — uses `chrome.alarms` for timed execution
   - Scheduled via `chrome.alarms.create('scheduled_copy', { delayInMinutes })`
   - On alarm, same flow as EXECUTE_COPY (close → slots → create → apply)

### `get_shop_flash_sale_item/` Response Format
The API returns two possible formats (check both):
- `data.items` — SKU-level array with `item_id`, `model_id`, `stock`, `purchase_limit`
- `data.item_info` — Product-level array with `itemid`, `price`, `stock`, `images`
- `data.model_info_str` — JSON string with per-SKU prices: `{"itemId":{"modelId":{"price":99}}}`
- If `model_info_str` is missing, use `item_info[].price` as fallback

### Caching
- 30-minute cache via `browser.storage.local` (`flashSaleCache` key)
- Persists: products, flashSaleList, flashSaleId, enableProgress, skuOverrides, global params
- Auto-loads on popup open; auto-saves after fetch/enable operations

### Flash Sale Enable Flow (background.ts `runEnableLoop`)
1. Build `EnableItem[]` from params, filtering out 0-stock SKUs
2. Save initial progress with `running: true` immediately (so popup reopen sees correct state)
3. POST to `set_shop_flash_sale_items` with `use_global_category: true`
4. Parse failed items from `response.data.failed_items`
5. Retry failures (with adaptive stock halving for `NOT_ENOUGH_STOCK` errors)
6. Run diagnosis query for small batches (≤10 failed items at a time)
7. Track progress via `EnableProgress` interface (round/success/failure counts)
8. Fatal errors (missing seller tab) auto-stop the loop

### Enable Loop Guards
- `_enableRunning` flag prevents concurrent loops (checked at function entry, always reset in finally)
- `_enableStopRequested` flag enables clean stop via STOP_ENABLE message
- Fatal errors (no seller tab) stop loop immediately
- Storage read retries (5 attempts) handle SW cold-start timing

### State Shape (Store)
- **SPC_CDS:** spcCds, spcCdsVer, isConnected, isExtracting
- **Products:** productIds[], products[], inputText, isLoading, error
- **Flash Sales:** flashSaleList[], flashSaleId, flashSaleInfo, isLoadingFlashSales
- **Enable:** maxRetries, infiniteRetry, discountRate, flashSaleStock, purchaseLimit, isEnabling, enableProgress
- **Copy:** copySource (flashSale + itemCount), copyMode, copyTaskStatus, isCopying, savedTemplates[], selectedTemplate
- **SKU Overrides:** `Record<string, SkuOverride>` keyed by `${itemId}-${modelId}`

### SKU Override System
- Per-SKU discount rate, activity stock, or promo price and purchase limit
- Overrides stored in `skuOverrides` record keyed by `${itemId}-${modelId}`
- Empty fields = use global defaults

### Template System
- Save/load full configuration (discount rate, stock, purchase limit, SKU overrides)
- Product diff on apply: warns about removed (yellow) and added (blue) products
- Templates stored in `browser.storage.local` under `flashSaleTemplates` key

### Content Script Progress UI
- Fixed position on right side of seller page (z-index 99999)
- Semi-transparent with backdrop-filter blur
- Shows success/failed counts, round number, progress bar
- Stop button sends STOP_ENABLE to background
- Auto-fades 3s after completion

## Important Patterns & Gotchas
- **injectedFetch timeout:** 30s default (vs 10s for sc-fe-session, 15s in background)
- **Adaptive stock:** Failed SKUs with `NOT_ENOUGH_STOCK` get stock halved (min 1) on retry
- **Background injectedFetch:** Queries `tabs.query({ url: '*://seller.shopee.tw/*' })` — finds any seller tab, not just active one
- **Debug logging:** Uses `[bg:enable]`, `[bg:injectedFetch]`, `[START_ENABLE]`, `[enable]`, `[SPC_CDS]`, `[bg:executeCopy]` tag prefixes
- **Price calculation:** `Math.floor(price * discountRate / 100)`
- **Component split:** `components/ui/` = generic shadcn/ui; `components/product/` = domain-specific (ProductCard, SkuTable, TemplateManager, CopyConfirmPanel, CopyResultPanel, SpcStatus)
- **Cache clearing:** `clearCache()` + `reset()` + `extractSpcCds()` chained on "清除缓存" button
- **No test files** — testing is manual via Chrome extension reload
- **Copy flow debug button:** `CopyConfirmPanel.tsx:191` has a "🛠 立即创建 Demo" button (debug only, remove before release)
- **`enterCopyMode` loads products:** Always loads source flash sale's products into store for template path. Without this, `state.products` would be empty/stale and template application fails 100%.
- **`get_shop_flash_sale_item/` response format varies:** Sometimes returns `data.items` (SKU-level), sometimes `data.item_info` (product-level). Always handle both. `model_info_str` (per-SKU prices) is optional.
- **Referrer header approach unreliable:** The `from=sourceId` via Referrer header (server auto-copy) does NOT work with `fetch` API's `referrer` option in `executeScript` context. Always use manual copy (fetch items → apply via `set_shop_flash_sale_items/`).

## Conventions
- Use `@/` path alias for all imports (maps to project root)
- Use `browser.*` extension API (WXT shims to `chrome.*` under the hood)
