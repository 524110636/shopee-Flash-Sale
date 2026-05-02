# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 限时特卖助手 (Limited Time Sale Helper)

**版本:** 1.1.0  
**状态:** 功能完善阶段

## Project Overview
Chrome extension (MV3) for automating Shopee Taiwan seller center flash sale operations. Built with WXT + React 19 + TypeScript + Tailwind CSS + shadcn/ui + Zustand.

## Development Commands
- `npm run dev` — Start dev server with hot reload (WXT)
- `npm run build` — Production build
- `npm run zip` — Build + create zip for Chrome Web Store
- `npm run compile` — TypeScript compilation only (no bundling)
- `npm run postinstall` — Run `wxt prepare` after install

## Tech Stack & Key Versions
- **WXT** 0.20.25 — Chrome MV3 extension framework (Vite under the hood)
- **React** 19.2.5 + **TypeScript** 6.0
- **Zustand** 5.0.12 — State management (single store for all business logic)
- **Tailwind CSS** 3.4 + shadcn/ui (`components/ui/`) — UI
- Extension API: `chrome` (configured in `wxt.config.ts` via `extensionApi: 'chrome'`)

## Architecture

### Entrypoints (WXT convention)
- **`entrypoints/popup/`** — Popup UI: App.tsx (layout), store.ts (Zustand + all business logic), types.ts, api.ts (GraphQL fetch)
- **`entrypoints/background.ts`** — Service Worker: SPC_CDS cookie extraction, flash sale enable loop (`runEnableLoop` with `injectedFetch`), message relay (START_ENABLE/STOP_ENABLE/GET_ENABLE_STATUS/ENABLE_PROGRESS/ENABLE_COMPLETE)
- **`entrypoints/content.ts`** — Content script: currently a no-op placeholder

### Critical Design Decisions
1. **Enable loop runs in background Service Worker** — `enableFlashSaleItems` loop is in `background.ts`, not popup. Popup sends params via `storage.local` and triggers `START_ENABLE` message. Background sends `ENABLE_PROGRESS`/`ENABLE_COMPLETE` messages back. This allows the loop to continue running after popup closes.
2. **Data loading still in popup** — `fetchProducts`, `fetchFlashSaleList`, `loadFlashSaleProducts` use `browser.scripting.executeScript({ world: 'MAIN' })` directly from popup via `injectedFetch()`
3. **SPC_CDS cookie extraction** — `browser.cookies.get()` with multi-domain fallback chain: `seller.shopee.tw` → `shopee.tw` → `www.shopee.tw` → `cookies.getAll({ domain: '.shopee.tw' })`
4. **All business logic in Zustand store** — `store.ts` is the single source of truth; React components are thin wrappers
5. **`injectedFetch<T>()`** — Core abstraction that executes fetch in MAIN world via `scripting.executeScript`, including `sc-fe-session` CSRF token extraction from the seller center page

### Data Flow
```
Data loading (popup):
  User Input → App.tsx → store.ts actions → injectedFetch() → 
    scripting.executeScript(MAIN world) → fetch() → 
    response → store state update → React re-render

Enable loop (background):
  Popup: build items → storage.local(params) → START_ENABLE message
  Background: read params → loop(injectedFetch) → storage.local(progress) → ENABLE_PROGRESS message
  Popup: receives progress → setState → re-render
  (Popup can close; loop continues in background; reopen checks GET_ENABLE_STATUS)
```

### Key API Endpoints
- **GraphQL:** `POST /api/marketing/v4/graphql/query/` — product/SKU details
- **Flash Sale:** `/api/marketing/v4/shop_flash_sale/{get_shop_flash_sale_list,get_shop_flash_sale_item_id_list,set_shop_flash_sale_items}`
- **Required header:** `sc-fe-session` (CSRF token, extracted from page DOM/window)
- **Required body field:** `use_global_category: true` (missing this causes code 1001 error)
- **Price rules:** Must be integer, strictly less than origin price

### Caching
- 30-minute cache via `browser.storage.local` (`flashSaleCache` key)
- Persists: products, flashSaleList, flashSaleId, enableProgress, skuOverrides, global params
- Auto-loads on popup open; auto-saves after fetch/enable operations

### Flash Sale Enable Flow (store.ts `enableFlashSaleItems`)
1. Build `EnableItem[]` from products, applying SKU-level overrides
2. POST to `set_shop_flash_sale_items` with `use_global_category: true`
3. Parse failed items from `response.data.failed_items`
4. Retry failures (with adaptive stock halving for `NOT_ENOUGH_STOCK` errors)
5. Run diagnosis query for small batches (≤10 failed items at a time)
6. Track progress via `EnableProgress` interface (round/success/failure counts)

### State Shape (Store)
- **SPC_CDS:** spcCds, spcCdsVer, isConnected, isExtracting
- **Products:** productIds[], products[], inputText, isLoading, error
- **Flash Sales:** flashSaleList[], flashSaleId, flashSaleInfo, isLoadingFlashSales
- **Enable:** maxRetries, infiniteRetry, discountRate, flashSaleStock, isEnabling, enableProgress
- **SKU Overrides:** `Record<string, SkuOverride>` keyed by `${itemId}-${modelId}`

### SKU Override System
- Per-SKU discount rate, activity stock, or promo price
- Overrides stored in `skuOverrides` record keyed by `${itemId}-${modelId}`
- Promo price input auto-calculates discount rate on blur: `rate = round(price / origin * 100)`
- Empty fields = use global defaults

## Important Patterns & Gotchas
- **injectedFetch timeout:** 30s default (vs 10s for sc-fe-session extraction, 15s in background)
- **Adaptive stock:** Failed SKUs with `NOT_ENOUGH_STOCK` get their stock halved (min 1) on retry
- **Skipped SKUs:** SKUs with 0 normalStock are filtered out before submission
- **Debug logging:** Uses `[enable]`, `[injectedFetch]`, `[SPC_CDS]`, `[extractSpcCds]` tag prefixes
- **Price calculation:** `Math.floor(price * discountRate / 100)`
- **Component split:** `components/ui/` = generic shadcn/ui (badge, button, card, input, scroll-area, separator, table); `components/product/` = domain-specific
- **Cache clearing:** `clearCache()` + `reset()` + `extractSpcCds()` chained on "清除缓存" button

## Conventions
- No dedicated test files — testing is manual via Chrome extension reload
- Use `@/` path alias for all imports (maps to project root)
- Always use `chrome` extension API (not `browser` polyfill in config, though `browser.*` works via WXT shims)
