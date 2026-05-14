# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (MV3) for automating Shopee Taiwan seller center flash sale operations. Built with **WXT** + **React 19** + **TypeScript 6.0** + **Tailwind CSS 3.4** + **shadcn/ui** + **Zustand 5**.

Plus a standalone **backend** (Node.js + Hono + Drizzle ORM + SQLite) for user auth, store binding (backed by shop_id), usage analytics, admin management, and pre-operation access validation (anti-cracking).

## Environment

Copy `.env.example` to `.env` to configure the backend URL. The default is `http://localhost:5724`.

```
cp .env.example .env
```

## Development Commands

| Command | Description |
|---------|-------------|
| `cp .env.example .env` | Create local env config (default backend URL `http://localhost:5724`) |
| `npm run dev` | Start WXT dev server with hot reload |
| `npm run build` | Production build |
| `npm run zip` | Build + create zip for Chrome Web Store |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Run ESLint with auto-fix |
| `npm run format` | Format with Prettier |
| `npm run format:check` | Check formatting |
| `npx tsc --noEmit` | TypeScript type checking |
| `cd backend && npm run dev` | Start backend server on port 5724 |
| `cd backend && npx kill-port 5724` | Kill backend if port in use |
| `git config core.hooksPath .githooks` | Enable pre-commit build check hook |

## Project Structure

```
entrypoints/                  # WXT entrypoints
├── popup/                    # Popup UI (React, viewport=420px)
│   ├── App.tsx               # Main React component (layout, conditional panels)
│   ├── main.tsx              # React mount entry
│   ├── store.ts              # Zustand single store (all business logic + API calls)
│   ├── api.ts                # GraphQL product query fetcher
│   ├── backend-api.ts        # Backend REST API client (auth, stores, analytics)
│   ├── one-day-sku.ts        # 1-day-delivery SKU builder (buildOneDaySkuProductInfo, getDiscountRatio, buildDiscountRestoreList, extractSellableStock, generateTierCombinations, getHighestModelPrice [optional productInfoModels param for FirstUse], hasDedicatedOneDaySku, hasAnyOneDayDeliverySku, extractSellerDiscounts [filters ended/timeStatus=3/expired endTime], isFiveTimesPriceError)
│   ├── types.ts              # All shared TypeScript interfaces
│   ├── index.html            # HTML template
│   └── style.css             # Tailwind directives
├── background.ts             # Service Worker (enable loop, copy flows, alarm scheduling, message relay, auto mode, analytics events)
└── content.ts                # Content script (floating progress panel, message relay)

components/
├── ui/                       # shadcn/ui primitives
├── lib/
│   └── utils.ts              # cn() utility
└── product/                  # Business components
    ├── AuthPanel.tsx          # Login/register with inline verification/settings UI (login gate)
    ├── StoreStatus.tsx        # Store binding status + bind button
    ├── AdminPanel.tsx         # Admin: user list, quota adjustment, analytics
    ├── AutoModePanel.tsx      # Auto mode panel
    ├── CopyConfirmPanel.tsx   # Copy flow
    ├── CopyResultPanel.tsx    # Copy result display
    ├── ScheduledTaskCard.tsx  # Live countdown + 4-step progress for scheduled copy
    ├── UndiscountedSkuModal.tsx # Modal for reviewing undiscounted SKUs before auto-mode enable
    ├── ProductCard.tsx        # Single product card
    ├── ProductList.tsx        # Product list with inline SKU table modal
    ├── ProductViewModal.tsx   # Product detail popup for auto mode
    ├── SkuTable.tsx           # SKU parameter table
    ├── SpcStatus.tsx          # SPC_CDS connection status
    ├── TemplateEditDialog.tsx # Template edit dialog
    ├── TemplateManager.tsx    # Template save/load/export/import/edit
    ├── TimeSlotModal.tsx      # Time slot selection modal
    └── FirstUseModal.tsx      # First-use flow: fetch all shop products, search, select, trigger fix

backend/                      # Standalone backend service
├── src/
│   ├── index.ts              # Entry: Hono app with CORS, routes mount, health check
│   ├── db/
│   │   ├── schema.ts         # Drizzle ORM schema (users, verification_codes, store_bindings, analytics_events)
│   │   └── index.ts          # SQLite init + migration (ALTER TABLE for schema upgrades)
│   ├── routes/
│   │   ├── auth.ts           # POST /register, /verify, /login, /check-admin
│   │   ├── stores.ts         # GET /, POST /bind, POST /validate, DELETE /:id (JWT-protected)
│   │   ├── analytics.ts      # POST /events, GET /summary (JWT-protected)
│   │   └── admin.ts          # GET /users, PATCH /:id/store-limit, DELETE /:id, GET /analytics, GET /analytics/events, GET /bindings, DELETE /bindings/:id (admin-only)
│   ├── middleware/
│   │   └── auth.ts           # JWT verification + admin role guard
│   └── utils/
│       ├── jwt.ts            # JWT sign/verify (jose, HS256, 7-day expiry)
│       └── code.ts           # 6-digit verification code generator (5-min expiry)
├── package.json
└── tsconfig.json
```

## Backend Architecture

### Authentication Flow
1. User registers with email/username + password → backend returns 6-digit verification code
2. User enters code to verify → activates account (`isActive=1`)  
3. User logs in → receives JWT (7-day expiry)
4. Extension stores JWT in `chrome.storage.local` via `backend-api.ts`
5. All subsequent API calls auto-attach `Authorization: Bearer` header
6. On 401 response, auth is cleared and user is redirected to login

### Store Binding
- **shop_id** is the stable binding anchor (from `GET /api/v2/login/`), SPC_CDS is only for API calls
- `storeBindings` table has `shop_id`, `account_id`, `shop_username` for stable identification
- Same shop_id + same user = auto-update SPC_CDS (session refresh, no re-binding needed)
- `isCurrentStoreBound` in App.tsx: **shop_id first, SPC_CDS fallback** for old records
- Each user has `max_stores` limit on the `users` table (default 1)
- Admin can adjust per-user limits and **force-unbind** any user's store
- `StoreStatus` component: when current shop is not bound and capacity remains, shows inline "绑定当前店铺" button

### Analytics
- Background SW reports events after enable loop, copy flow, and auto mode rounds
- Fire-and-forget pattern: `reportAnalyticsEvent()` reads auth from storage, POSTs to backend, ignores errors
- Reported events: `enable_loop`, `copy_flow`, `auto_mode_round`, `auto_mode_stop`

### CORS
- Hono CORS middleware uses a function to dynamically return the exact `chrome-extension://<id>` origin
- Also allows `https://seller.shopee.tw`
- No wildcard pattern; the function checks `origin.startsWith('chrome-extension://')`

## Login Gate (Extension)
- `App.tsx` checks `isCheckingAuth` on mount → shows loading spinner
- If `!isLoggedIn` → full-screen AuthPanel (login/register)
- If logged in but no store bindings → blocking "请先绑定店铺" message over main features
- If logged in + has bindings + current shop SPC_CDS/shop_id NOT in bindings → amber "当前店铺未绑定" hint (no longer a hard block)
- Admin panel is accessible even without personal store bindings
- `isCurrentStoreBound` uses `shopId` match first, falls back to `spcCds` match for legacy data

## Important Patterns

- **SKU Override System**: `Record<string, SkuOverride>` keyed by `{itemId}-{modelId}`
- **`injectedFetch()`**: Uses `scripting.executeScript({ world: 'MAIN' })` to bypass CSP
- **Storage-based communication**: `storage.onChanged` for critical flows when `sendMessage` is unreliable
- **Fire-and-forget analytics**: Background SW reports events without awaiting or error handling
- **Pre-operation validation (anti-cracking)**: Background SW calls `POST /api/stores/validate` before every critical operation (enable, copy, auto-mode, scheduled copy) via `validateShopAccess()` inline function — reads auth from storage, validates binding+user status on backend, cannot be bypassed by modifying frontend code
- **Settings security**: AuthPanel settings view shows backend URL only for admin users (`authUser.role === 'admin'`); non-admin users see only a "测试连接" button that calls `healthCheck()`
- **checkAuthOnStartup sync**: `setTimeout(() => refreshStoreBindings(), 500)` removed in favor of `await refreshStoreBindings()` to eliminate 500ms race window where `isLoggedIn=true` but `storeBindings=[]`
- **fetchFlashSaleList force param**: Passing `force=true` bypasses the "API returned fewer items" cache protection, used on user-initiated refresh and after copy flow completes
- **Copy flow auto-load products**: `executeCopy` now calls `loadFlashSaleProducts(newId)` after creating a new activity, so products from `_copiedSaleData` are immediately available when returning to main view
- **Ended activity inline error**: Button-area check shows "该活动已结束无法开启" red banner below the enable button when selected sale has ended
- **`_pendingFlashSaleData` in-memory transfer**: After copy flow creates a new activity, product data is stored directly in Zustand state (not storage) so `loadFlashSaleProducts` reads it immediately, bypassing storage race conditions
- **`_completedCopyInfo` post-copy notification**: When `exitCopyMode` detects a successful copy, it saves `CompletedCopyInfo` to both Zustand state and `browser.storage.local`. The main page shows a green notification card with "立即查看" button that auto-navigates to the new activity
- **`ScheduledTaskCard` live countdown**: Replaces the static amber scheduled-task box. Uses 1-second tick (like AutoModePanel) to show real-time countdown, plus a 4-step visual progress indicator (复制模板 → 创建任务 → 等待开始 → 手动开启)
- **Guide banner**: When the activity list is shown with no scheduled/active copy, a brand-color info banner guides users to click the "复制" button
- **`skipSkuKeys` in auto-mode**: `AutoModePanel` can detect undiscounted SKUs and let user skip them before starting. The `runEnableLoop` in background.ts filters out skipped SKUs via a `skipSet`
- **Copy button visibility**: The "复制" button in the activity list uses filled brand color (`bg-shopee-brand text-white`) instead of outline, with a "新/待开启" badge for newly created activities
- **No test files**: Testing is manual via Chrome extension reload
- **One-day SKU feature**: `one-day-sku.ts` provides SKU builder functions for adding/updating a dedicated "批發客戶下訂-請勿下單" SKU with 1-day shipping. Full flow: `get_product_info` → `buildOneDaySkuProductInfo()` → search discounts → remove from discounts → `update_product_info` → re-fetch product info (with retry) → restore discounts. Runs in popup (not background) via `runOneDaySkuAndEnable()` in store.ts. Discount restore now applies to ALL products including the newly created SKUs. After fix, enters 3-phase wizard: `editing_params` (edit SKU params + global defaults) → `selecting_flash_sale` (pick existing flash sale or create new) → `starting_flash_sale` (submit via `addToExistingFlashSale` or `createNewFlashSaleAndAdd`). Discount rate is auto-detected from actual product discounts during the fix flow and synced to global `discountRate`.
- **Discount rate auto-detection**: During `runOneDaySkuAndEnable`, `collectedRatios: number[]` captures `getDiscountRatio()` from each product (both newly fixed and already-has-SKU). After the loop, if all ratios match, sets `discountRate` to that value; if different, uses the average. This ensures the post-fix wizard shows the actual product discount (e.g., 5.4折 → 54%) instead of the default 60%.
- **Wizard post-fix phases**: `editing_params` shows fix results with editable global params (折扣率/库存/限购) and per-product SkuTable. `selecting_flash_sale` lists existing active/upcoming sales with "定时" button (calls `scheduleEnableForFlashSale`) and "加入" button (calls `addToExistingFlashSale`), plus time slot selection (via `fetchTimeSlots`) for creating new sales. Top of phase shows two timing inputs: `wizardAdvanceMin` (提前N分钟创建空活动) and `wizardDelayMin` (活动开始后N分钟提交商品). Slot list uses radio-style selection with a unified "开始" button. Debug button "立即创建 Demo" forces immediate creation+enable by passing `now` as slotStartTime with advanceMin=delayMin=0. `addToExistingFlashSale` now goes through Background SW `runEnableLoop` (not direct popup API call) with full retry/error handling. `createNewFlashSaleAndAdd` supports two-phase: when advanceMin>0, sends `SCHEDULE_WIZARD_FLOW` to background for deferred creation via `wizard_create` alarm, then `scheduled_enable` alarm for timed enable. Empty activity product display is handled by `_pendingFlashSaleData` (in-memory) and `_copiedSaleData` (storage) pre-population.
- **First Use flow**: `FirstUseModal` lets users fetch all shop products via `search_product_list` API (paginated, `fetchShopProductsPage`), search by keyword, select up to 20 products, and trigger `runFirstUseFlow`. `runFirstUseFlow` converts `ShopProductListItem[]` to `ShopeeProduct[]` (with empty modelList), sets `oneDaySkuSelectedIds`, and auto-calls `runOneDaySkuAndEnable`. `getHighestModelPrice()` accepts optional `productInfoModels` param for when ShopeeProduct.modelList is empty (FirstUse scenario).
- **`buildOneDaySkuProductInfo()` data flow**: Takes `ShopeeProduct` (GraphQL camelCase) + `ProductInfoPayload` (REST snake_case from `get_product_info`). Adds/updates a variation option in `std_tier_variation_list`, then generates new models for ALL existing tier combinations via `generateTierCombinations()` (Cartesian product). Existing models are cleaned (`cleanModel()`) to strip response-only fields while preserving `stock_setting_list` and `pre_order_info`.
- **`getDiscountRatio(modelList)`**: Iterates existing models' `price_info.input_promotion_price / input_normal_price` to find the highest ratio (mildest discount, e.g. 6.5折 > 5.4折). Used to compute discount price for newly created 1-day SKU models that have no `input_promotion_price`.
- **`buildDiscountRestoreList(modelList, productId, discountRatio?)`**: Converts model_list to `discount_model_list` entries for `update_seller_discount_items`. For models with existing `input_promotion_price`, uses that directly. For models without (new 1-day SKUs), computes `normalPrice * discountRatio` when `discountRatio` is provided.
- **Discount flow (Phase 2)**: Publish step restructured to: always search discounts → remove if found → **(debounce 2s)** → publish → (if 5× price error & no discounts found, re-search → remove → **(debounce 2s)** → retry publish) → re-fetch product info (up to 3 retries with 1s delay) → **(debounce 2s)** → restore discounts including new SKUs, with 2s gap between multiple discount operations. `failed_item_list`/`error_list` in restore response are checked even when top-level `error: 0`.
- **Console logging**: Every step emits `[一键修复]` prefixed logs with product name, action, and result data for debugging in DevTools Console.
- **Model count safety**: Shopee limits models to 100 per product. `buildOneDaySkuProductInfo()` checks `nextModelList.length + tierCombinations.length > 100` before creating new SKUs, throwing a clear error if exceeded.
- **Stock extraction**: `extractSellableStock()` handles both `stock_setting_list` (request format) and `stock_detail` (response format) to extract sellable stock for new models.

## Backend API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | Public | Register (returns verification code) |
| POST | `/api/auth/verify` | Public | Activate account with code |
| POST | `/api/auth/login` | Public | Login, returns JWT |
| POST | `/api/auth/check-admin` | JWT | Check admin role |
| GET | `/api/stores` | JWT | List user's store bindings |
| POST | `/api/stores/bind` | JWT | Bind a store (SPC_CDS + shop_id) |
| POST | `/api/stores/validate` | JWT | Validate store binding + user is active (anti-cracking) |
| DELETE | `/api/stores/:id` | JWT | Unbind store |
| POST | `/api/analytics/events` | JWT | Report usage event |
| GET | `/api/health` | Public | Health check (used by `healthCheck()` in backend-api.ts) |
| GET | `/api/analytics/summary` | JWT | Personal usage summary |
| GET | `/api/admin/users` | Admin | User list with binding counts |
| PATCH | `/api/admin/users/:id/store-limit` | Admin | Adjust store binding limit |
| DELETE | `/api/admin/users/:id` | Admin | Delete user (cascade: bindings, events, verification codes) |
| GET | `/api/admin/analytics` | Admin | Global analytics |
| GET | `/api/admin/analytics/events` | Admin | Event details |
| GET | `/api/admin/bindings` | Admin | List all store bindings (optional `?userId=`) |
| DELETE | `/api/admin/bindings/:id` | Admin | Force-unbind any store |
| GET | `/api/health` | Public | Health check |

## Config Files

- `wxt.config.ts`: `extensionApi: 'chrome'`, permissions `['storage','cookies','scripting','alarms','unlimitedStorage']`, host_permissions `['https://*.shopee.tw/*']`
- `tsconfig.json` (root): `strict=true`, `moduleResolution=Bundler`, `baseUrl=.`, `paths: @/* → ./*`
- `tsconfig.json` (backend): `strict=true`, `moduleResolution=Bundler`, `outDir: ./dist`
- `tailwind.config.ts`: Content paths `entrypoints/**/*.{ts,tsx}`, `components/**/*.{ts,tsx}`
