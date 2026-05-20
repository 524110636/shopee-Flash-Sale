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

### First Deployment

New deployments have no admin account or invite codes (chicken-and-egg: registration needs invite codes, only admins can generate them). Run the seed script once:

```bash
cd backend
# Edit .env and set INIT_ADMIN_EMAIL, INIT_ADMIN_PASSWORD, JWT_SECRET
npm run seed
```

This creates the admin user (from `INIT_ADMIN_EMAIL`/`INIT_ADMIN_PASSWORD`) and generates initial invite codes (`INIT_INVITE_CODES`, default 5). The seed is idempotent — safe to run multiple times. After init, remove `INIT_ADMIN_*` lines from `.env`.

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
| `cd backend && npm run seed` | Initialize first admin + invite codes (first deployment only) |
| `git config core.hooksPath .githooks` | Enable pre-commit build check hook |

## Project Structure

```
├── public/                     # WXT public assets (contact QR code, etc.)
├── USER_MANUAL.md              # User manual (Feishu-style, Chinese)
├── entrypoints/                  # WXT entrypoints
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
    ├── AuthPanel.tsx          # Login/register with inline verification/settings UI (login gate, terms of service modal)
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
│   │   ├── schema.ts         # Drizzle ORM schema (users, verification_codes, store_bindings, analytics_events, invite_codes)
│   │   └── index.ts          # SQLite init + migration (ALTER TABLE for schema upgrades)
│   ├── routes/
│   │   ├── auth.ts           # POST /register (invite code), /verify, /login, /check-admin (returns trialEnabled), /check-auto-mode
│   │   ├── stores.ts         # GET /, POST /bind, POST /validate (trialEnabled-aware, read-only), POST /consume-trial, DELETE /:id (JWT-protected)
│   │   ├── analytics.ts      # POST /events, GET /summary (JWT-protected)
│   │   └── admin.ts          # GET /users, PATCH /:id/store-limit, PATCH /:id/auto-mode, PATCH /:id/trial, PATCH /:id/trial-enabled, DELETE /:id, GET /analytics, GET /analytics/events, GET /bindings, DELETE /bindings/:id, GET/POST/DELETE /invite-codes (admin-only)
│   ├── seed.ts                # First-deployment bootstrap: creates admin user + initial invite codes from env vars
│   ├── middleware/
│   │   └── auth.ts           # JWT verification + admin role guard
│   └── utils/
│       ├── jwt.ts            # JWT sign/verify (jose, HS256, 7-day expiry, rejects default JWT_SECRET at startup)
│       └── code.ts           # 6-digit verification code generator (5-min expiry)
├── package.json
└── tsconfig.json
```

## Backend Architecture

### Authentication Flow
1. User registers with email/username + password + **invite code** → backend validates code against `invite_codes` table (one-time use) → returns 6-digit verification code
2. User enters code → clicks verify button (manual; auto-verify removed to enforce terms agreement) → activates account (`isActive=1`)
3. User logs in → receives JWT (7-day expiry, includes `trialUsed`, `autoModeEnabled`)
4. Extension stores JWT in `chrome.storage.local` via `backend-api.ts`
5. All subsequent API calls auto-attach `Authorization: Bearer` header
6. On 401 response, auth is cleared and user is redirected to login
7. **Terms of Service**: Registration requires explicit checkbox agreement (`agreedToTerms`). A ~1500-word terms document includes Shopee-specific disclaimers (traffic penalties, API instability) mixed into standard boilerplate — legally present but practically unread. Modal accessible via link in the checkbox label.

### Invite Code + Trial Limit
- 管理员在 AdminPanel「邀请码」标签页生成一次性邀请码（格式 `INV-xxxxxxxx`）
- 注册时需提供有效邀请码，使用后立即标记 `is_used=1`，同一邀请码不可重复使用
- 管理员可删除未使用的邀请码，已使用的不可删除
- 新用户 `trial_used = 0`、`trial_enabled = 1`（默认启用试用检查）
- `trial_used >= 1` 的非管理员用户再次操作 → `403 "试用已结束，"`
- 管理员（role=admin）不受试用限制
- **`trialEnabled` 永久关闭试用**: 管理员在 AdminPanel 用户列表点击「关闭试用」→ `trialEnabled = 0`，该用户后续所有操作跳过试用检查（适用于已升级套餐的用户）。`trialEnabled=0` 时也不会自动标记 `trialUsed`
- 管理员可「重置试用」（`trialUsed=0`）或「标记已用」（`trialUsed=1`）
- 覆盖 9 个操作点：`enable` / `copy` / `auto_mode_enable` / `scheduled_copy` / `scheduled_enable` / `wizard_flow` / `scheduled_copy`(alarm) / `scheduled_copy_enable` / `scheduled_enable`(alarm)
- **试用校验与消耗分离 (v1.14.0)**: `/validate` 仅做只读检查（`trialUsed` 状态），不再标记试用。`POST /api/stores/consume-trial` 在操作成功后由 `background.ts` `consumeTrial()` 调用，独立标记 `trialUsed=1`。所有操作路径（手动 enable、向导加入、定时开售、自动模式、复制流程）最终走 `runEnableLoop` → `consumeTrial()`，fire-and-forget 不阻塞操作
- **`consumeTrial()` 调试**: 结果写入 `_consumeTrialLog` storage key（含 `status`/`consumed`/`error`/`ts`），popup 控制台可读取排查指纹浏览器等无法看 SW 日志的场景
- **试用到期通知**: 任何操作触发 403 试用错误时，`trialExpiredBanner` 状态设值，App.tsx 顶部渲染醒目红底横幅（含图标 + 升级引导文案 + 关闭按钮）。5 个检测点：`checkBackgroundStatus`、`executeCopy` instant/scheduled 路径、`runOneDaySkuAndEnable` 异常、`scheduleEnableForFlashSale` 异常
- **Wizard 试用错误就地显示**: `checkBackgroundStatus` 检测到试用错误且 `oneDaySkuFlow.phase === 'starting_flash_sale'` 时，同步更新 `oneDaySkuFlow` 为 failed 状态，错误直接显示在 wizard 界面中，无需用户向上滚动

### Store Binding
- **shop_id** is the stable binding anchor (from `GET /api/v2/login/`), SPC_CDS is only for API calls
- `storeBindings` table has `shop_id`, `account_id`, `shop_username` for stable identification
- Same shop_id + same user = auto-update SPC_CDS (session refresh, no re-binding needed)
- `isCurrentStoreBound` in App.tsx: **shop_id first, SPC_CDS fallback** for old records
- Each user has `max_stores` limit on the `users` table (default 1)
- Admin can adjust per-user limits and **force-unbind** any user's store
- `StoreStatus` component: when current shop is not bound and capacity remains, shows inline "绑定当前店铺" button
- **Auto-refresh binding**: When `fetchShopInfo` or `refreshStoreBindings` detects SPC_CDS changed but shopId still matches a binding, silently calls `bindCurrentStore()` to update SPC_CDS on the backend. `isAutoRefreshingBinding` flag shows a blue syncing card ("正在同步店铺信息...") in place of the amber "当前店铺未绑定" warning. Handles fingerprint browser (速销易) SPC_CDS rotation on every restart
- Backend `/validate` endpoint: matches by `spcCds` first, falls back to `shopId` match with automatic SPC_CDS update when found
- All validation call sites in background.ts pass `shopId` through: `enable`, `auto_mode_create`, `auto_mode_enable`, `scheduled_copy_enable`, `scheduled_enable`, `wizard_flow`, `wizard_create`

### Analytics
- Background SW reports events after enable loop, copy flow, and auto mode rounds
- Fire-and-forget pattern: `reportAnalyticsEvent()` reads auth from storage, POSTs to backend, ignores errors
- Reported events: `enable_loop`, `copy_flow`, `auto_mode_round`, `auto_mode_stop`

### CORS
- Hono CORS middleware uses a function to dynamically return the exact `chrome-extension://<id>` origin
- Also allows `https://seller.shopee.tw`
- No wildcard pattern; the function checks `origin.startsWith('chrome-extension://')`

### Security Hardening (Anti-Cracking Phase 2)
- **Client-side hardening**: `backend-api.ts` `request()` fails hard on all errors (no silent success paths). JWT structure validation (`isValidJwtStructure()`) checks 3-segment base64url format + required payload fields (`userId`, `email`, `role`, `exp`, `iat`). Token expiry checked in `isLoggedIn()` and `getAuthUser()`.
- **Startup auth via backend**: `checkAuthOnStartup()` uses `checkAdmin()` response for mutable fields (`autoModeEnabled`, `trialUsed`, `trialEnabled`), not `getAuthUser()` storage data. Distinguishes 401 (clear auth) from network errors (`backendUnreachable` flag).
- **Store binding hardening**: `refreshStoreBindings()` handles 401 by syncing auth/state to logged-out. `bindCurrentStore()` sanitizes error messages (no raw `e.message`).
- **Background validation gap closure**: `wizard_create` alarm handler and `handleAutoModeCreate()` now call `validateShopAccess()` before Shopee API calls. `SCHEDULE_COPY`, `scheduled_copy_enable`, `scheduled_enable` handlers: spcCds missing → abort with error (was: skip validation). `runEnableLoop()` calls changed from fire-and-forget `.catch()` to `await` with try/catch.
- **Backend**: `jwt.ts` rejects startup if `JWT_SECRET` matches `.env.example` default value. `auth.ts` `/check-admin` reads `users.role` from DB (not JWT claim) for `isAdmin` determination.
- **Background backend URL**: `background.ts` `DEFAULT_BACKEND_URL` uses `import.meta.env.VITE_BACKEND_URL` (build-time replacement), so production builds automatically point to the correct server. Fallback is `http://localhost:5724` for dev.
- **Backend port conflict**: `index.ts` server catches `EADDRINUSE` and auto-runs `npx kill-port` to free the port before re-listening.
- **401 error passthrough**: `backend-api.ts` `request()` on 401 now reads `response.json()` first to extract the backend's `error` field (e.g. `"邮箱或密码错误"`). Falls back to `'认证已过期，请重新登录'` only when the response body is empty or unparseable. `clearAuth()` still called on all 401s.
- **Trial consume hardening**: `background.ts` `consumeTrial()` checks `response.ok` (fetch doesn't throw on non-2xx), extracts error from response body on failure, writes all outcomes to `_consumeTrialLog` storage key for debugging in fingerprint browsers where SW console is inaccessible
- **IP fallback for VPN users**: `backend-api.ts` `tryFetch()` wraps the primary `request()` call. On network error, retries with `_fallbackUrl` (from `VITE_BACKEND_FALLBACK_URL` env var, e.g. `http://43.99.86.228:5724`). Both URLs configured in `.env.example`.

## Login Gate (Extension)
- `App.tsx` checks `isCheckingAuth` on mount → shows loading spinner
- If `!isLoggedIn` → full-screen AuthPanel (login/register)
- If `!storeBindingsLoaded` → spinner with "正在加载店铺信息..." (prevents flash of unbound UI on slow networks)
- If logged in but no store bindings → blocking "请先绑定店铺" message, or red error card if `storeBindingsError` is set with a retry button
- If logged in + has bindings + current shop SPC_CDS/shop_id NOT in bindings → amber "当前店铺未绑定" hint (no longer a hard block)
- Admin panel is accessible even without personal store bindings
- `isCurrentStoreBound` uses `shopId` match first, falls back to `spcCds` match for legacy data
- Diagnostic logging: `[init]` prefix in store.ts traces `checkAuthOnStartup` / `refreshStoreBindings` paths; `[render]` prefix in App.tsx traces render gate state changes

## Important Patterns

- **SKU Override System**: `Record<string, SkuOverride>` keyed by `{itemId}-{modelId}`
- **`injectedFetch()`**: Uses `scripting.executeScript({ world: 'MAIN' })` to bypass CSP
- **Storage-based communication**: `storage.onChanged` for critical flows when `sendMessage` is unreliable
- **Fire-and-forget analytics**: Background SW reports events without awaiting or error handling
- **Pre-operation validation (anti-cracking)**: Background SW calls `POST /api/stores/validate` before every critical operation (enable, copy, auto-mode, scheduled copy) via `validateShopAccess()` inline function — reads auth from storage, validates binding+user status+trial limit on backend, cannot be bypassed by modifying frontend code. Now includes detailed `[bg:validate]` console logging at each step (request → response → pass/fail). **Trial check is read-only** — actual trial consumption happens separately via `POST /api/stores/consume-trial` after operation success
- **Trial consumption (`consumeTrial()`)**: `background.ts` `consumeTrial()` called fire-and-forget after `runEnableLoop` success. Checks `response.ok`, reads response body for error details, writes result to `_consumeTrialLog` storage for debugging. All 4 call sites (enable loop, auto mode, direct copy, scheduled copy) follow `reportAnalyticsEvent` → `consumeTrial()` pattern
- **SPC_CDS source in background**: Background handlers that run without popup context (alarms, scheduled tasks) MUST use `getSpcCdsFromCookies()` to read SPC_CDS from browser cookies. Do NOT read from `browser.storage.local` — popup store only holds SPC_CDS in Zustand memory state, never persists it
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
- **One-day SKU feature**: `one-day-sku.ts` provides SKU builder functions for adding/updating a dedicated "批發客戶下訂-請勿下單" SKU with 1-day shipping. Full flow: `get_product_info` → `buildOneDaySkuProductInfo()` → search discounts → remove from discounts → `update_product_info` → re-fetch product info (with retry) → restore discounts. **All user-facing progress messages are obfuscated** to generic "正在优化商品 (X/N)..." — phase labels (检查SKU/发布商品/查询折扣/移除折扣/恢复折扣) are all shown as "优化中". Technical details only appear in `[一键修复]` console logs for developer debugging. Runs in popup (not background) via `runOneDaySkuAndEnable()` in store.ts. Discount restore now applies to ALL products including the newly created SKUs. After fix, enters 3-phase wizard: `editing_params` (edit SKU params + global defaults, **green hint guides user to click product cards to edit prices/stock/limit**) → `selecting_flash_sale` (pick existing flash sale or create new) → `starting_flash_sale` (submit via `addToExistingFlashSale` or `createNewFlashSaleAndAdd`). Discount rate is auto-detected from actual product discounts during the fix flow and synced to global `discountRate`.
- **Discount rate auto-detection**: During `runOneDaySkuAndEnable`, `collectedRatios: number[]` captures `getDiscountRatio()` from each product (both newly fixed and already-has-SKU). After the loop, if all ratios match, sets `discountRate` to that value; if different, uses the average. This ensures the post-fix wizard shows the actual product discount (e.g., 5.4折 → 54%) instead of the default 60%.
- **Wizard post-fix phases**: `editing_params` shows fix results with editable global params (折扣率/库存/限购) and per-product SkuTable. `selecting_flash_sale` lists existing active/upcoming sales with "定时" button (calls `scheduleEnableForFlashSale`) and "加入" button (calls `addToExistingFlashSale`), plus time slot selection (via `fetchTimeSlots`) for creating new sales. Top of phase shows two timing inputs: `wizardAdvanceMin` (提前N分钟创建空活动) and `wizardDelayMin` (活动开始后N分钟提交商品). Slot list uses radio-style selection with a unified "开始" button. Debug button "立即创建 Demo" forces immediate creation+enable by passing `now` as slotStartTime with advanceMin=delayMin=0. `addToExistingFlashSale` now goes through Background SW `runEnableLoop` (not direct popup API call) with full retry/error handling. `createNewFlashSaleAndAdd` supports two-phase: when advanceMin>0, sends `SCHEDULE_WIZARD_FLOW` to background for deferred creation via `wizard_create` alarm, then `scheduled_enable` alarm for timed enable. Empty activity product display is handled by `_pendingFlashSaleData` (in-memory) and `_copiedSaleData` (storage) pre-population.
- **First Use flow**: `FirstUseWarningModal` appears first (unless dismissed via "以后不再提示" checkbox, persisted in `_firstUseWarningDismissed` storage key), warning users to remove products from all promotional activities (multi-buy, free shipping, bundle, add-on) except discount promotions before using the plugin. After confirming, `FirstUseModal` opens for product selection. `FirstUseModal` lets users fetch all shop products via `search_product_list` API (paginated, `fetchShopProductsPage`), search by keyword, select up to 20 products, and trigger `runFirstUseFlow`. `runFirstUseFlow` converts `ShopProductListItem[]` to `ShopeeProduct[]` (with empty modelList), sets `oneDaySkuSelectedIds`, and auto-calls `runOneDaySkuAndEnable`. `getHighestModelPrice()` accepts optional `productInfoModels` param for when ShopeeProduct.modelList is empty (FirstUse scenario).
- **`buildOneDaySkuProductInfo()` data flow**: Takes `ShopeeProduct` (GraphQL camelCase) + `ProductInfoPayload` (REST snake_case from `get_product_info`). Adds/updates a variation option in `std_tier_variation_list`, then generates new models for ALL existing tier combinations via `generateTierCombinations()` (Cartesian product). Existing models are cleaned (`cleanModel()`) to strip response-only fields while preserving `stock_setting_list` and `pre_order_info`.
- **`getDiscountRatio(modelList)`**: Iterates existing models' `price_info.input_promotion_price / input_normal_price` to find the highest ratio (mildest discount, e.g. 6.5折 > 5.4折). Used to compute discount price for newly created 1-day SKU models that have no `input_promotion_price`.
- **`buildDiscountRestoreList(modelList, productId, discountRatio?)`**: Converts model_list to `discount_model_list` entries for `update_seller_discount_items`. For models with existing `input_promotion_price`, uses that directly. For models without (new 1-day SKUs), computes `normalPrice * discountRatio` when `discountRatio` is provided.
- **Discount flow (Phase 2)**: Publish step restructured to: always search discounts → remove if found → **(debounce 2s)** → publish → (if 5× price error & no discounts found, re-search → remove → **(debounce 2s)** → retry publish) → re-fetch product info (up to 3 retries with 1s delay) → **(debounce 2s)** → restore discounts including new SKUs, with 2s gap between multiple discount operations. `failed_item_list`/`error_list` in restore response are checked even when top-level `error: 0`.
- **Console logging**: Every step emits `[一键修复]` prefixed logs with product name, action, and result data for debugging in DevTools Console.
- **Model count safety**: Shopee limits models to 100 per product. `buildOneDaySkuProductInfo()` checks `nextModelList.length + tierCombinations.length > 100` before creating new SKUs, throwing a clear error if exceeded.
- **Stock extraction**: `extractSellableStock()` handles both `stock_setting_list` (request format) and `stock_detail` (response format) to extract sellable stock for new models.
- **Content script unified floating panel**: `content.ts` uses a single `createPanel()` that builds three sections: `autoSectionEl` (auto mode status), `progressSectionEl` (enable progress, built lazily by `buildProgressSection()`), `copySectionEl` (copy countdown/progress). The old competing `createProgressUI()` that destroyed other sections was removed. `showComplete()` auto-hides the progress section after 3s and removes the full panel only when no other sections are visible. All three flows (manual enable, wizard enable, auto mode) now share the same floating panel.
- **Auto mode real-time countdown**: `renderAutoSection()` renders a `#__auto_countdown__` element that ticks every second via `updateAutoCountdown()`, showing minutes:seconds remaining until `nextActionTime` (operation time) or `nextTargetTime` (flash sale start). Timer clears automatically when auto mode stops.
- **Auto mode alarm lifecycle (v1.14.2)**: Phase state machine `idle → waiting_create → creating → waiting_enable → enabling → idle`. `scheduleNextRound()` creates `auto_mode_create` alarm + repeating `auto_mode_heartbeat` (every 5 min). `handleAutoModeCreate()` creates empty flash sale → creates `auto_mode_enable` alarm. `handleAutoModeEnable()` calls `runEnableLoop()` → increments round → `scheduleNextRound()`. All alarm exits also create heartbeat for monitoring. `clearAutoModeAlarms()` clears all 3 auto_mode alarms on stop/complete/error.
- **Auto mode SW recovery (v1.14.2)**: SW startup clears stale alarms before recovery via `clearAutoModeAlarms()` then `scheduleNextRound()`. `scheduleNextRound()` recognizes `waiting_enable` phase (SW died after create but before enable) and directly rebuilds `auto_mode_enable` alarm without re-creating the flash sale. `handleAutoModeHeartbeat()` detects lost alarms (via `chrome.alarms.get()`) and triggers re-scheduling. Stale `auto_mode_enable` cleared when entering `waiting_create` phase. Debug mode also clears stale enable alarm.
- **Auto mode re-entry protection (v1.14.2)**: `_autoModeStarting` module-level mutex prevents concurrent START_AUTO_MODE handling (double-click or message re-delivery). `_autoModeStopRequested` flag signals running loops to abort.
- **Auto mode persistent logging (v1.14.2)**: `logAutoMode()` writes structured entries to `_autoModeLogs` storage key (max 500, prepend). Each entry has `iso` readable timestamp, `type` (info/warning/success/error), `message`, optional `data` record. Serialized via `_logLock` promise chain to prevent write races. `sendAutoModeLog()` broadcasts to popup + content script for real-time display. `EXPORT_AUTO_MODE_LOGS` message handler formats all logs as text and triggers browser download. Popup `AutoModePanel` has "导出日志" button. Log points cover: alarm triggers, SW startup, heartbeat, schedule/recovery, create/enable phases, stop events.
- **Minimize/restore buttons**: Unified panel has a `−` minimize button (top-right). `toggleMinimize()` collapses the panel to a thin right-side strip showing `◀` arrow + one-line countdown/status summary, updating in real-time. Click the arrow to restore. Copy UI has separate `toggleCopyMinimize()` with the same behavior. `panelMinimized` / `copyMinimized` flags track state; `updateMinimizedContent()` / `updateCopyMinimizedContent()` refresh the compact display.
- **`showComplete()` initialization fix**: `showComplete()` now calls `createPanel()` + `buildProgressSection()` before checking `headerEl`, preventing silent failure when `ENABLE_COMPLETE` arrives without a preceding `ENABLE_PROGRESS` (e.g., zero items or immediate error).
- **Wizard duplicate-click prevention**: "立即加入"/"定时"/"开始"/"调试" buttons disabled when `isEnabling || oneDaySkuFlow.running || !!oneDaySkuFlow.message`. Store-level guards in `addToExistingFlashSale`, `scheduleEnableForFlashSale`, `createNewFlashSaleAndAdd` reject re-entry: `if (state.isEnabling || oneDaySkuFlow.running || oneDaySkuFlow.message) return`. `goToFlashSaleSelection` clears `message` and `error` so guide text doesn't block buttons.
- **Minimize/restore copy visibility fix**: `toggleMinimize()` in content.ts now saves/restores `wasCopyVisible` alongside `wasAutoVisible` and `wasProgressVisible`, preventing copy section from staying hidden after expand.
- **"使用说明" button**: Non-admin users see a "使用说明" button (left of "定制开发") that opens the Feishu user manual wiki in a new tab via `window.open()`.
- **QR code contact modal**: "定制开发" modal contact section has a "查看二维码" button that opens a centered overlay showing `contact-qr.png` (作者微信二维码) from `public/`, using `browser.runtime.getURL()`.

## Backend API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | Public | Register with invite code (returns verification code) |
| POST | `/api/auth/verify` | Public | Activate account with code |
| POST | `/api/auth/login` | Public | Login, returns JWT |
| POST | `/api/auth/check-admin` | JWT | Check admin role + autoModeEnabled + trialUsed |
| POST | `/api/auth/check-auto-mode` | JWT | Check if user can use auto mode |
| GET | `/api/stores` | JWT | List user's store bindings |
| POST | `/api/stores/bind` | JWT | Bind a store (SPC_CDS + shop_id) |
| POST | `/api/stores/validate` | JWT | Validate store binding + user is active + trial limit (read-only, anti-cracking) |
| POST | `/api/stores/consume-trial` | JWT | Mark trial used after operation success |
| DELETE | `/api/stores/:id` | JWT | Unbind store |
| POST | `/api/analytics/events` | JWT | Report usage event |
| GET | `/api/analytics/summary` | JWT | Personal usage summary |
| GET | `/api/admin/users` | Admin | User list with binding counts |
| PATCH | `/api/admin/users/:id/store-limit` | Admin | Adjust store binding limit |
| PATCH | `/api/admin/users/:id/auto-mode` | Admin | Toggle auto mode permission |
| PATCH | `/api/admin/users/:id/trial` | Admin | Reset/mark trial used status |
| PATCH | `/api/admin/users/:id/trial-enabled` | Admin | Toggle trial restriction (0=permanently bypass, 1=enabled) |
| DELETE | `/api/admin/users/:id` | Admin | Delete user (cascade: bindings, events, verification codes) |
| GET | `/api/admin/analytics` | Admin | Global analytics |
| GET | `/api/admin/analytics/events` | Admin | Event details |
| GET | `/api/admin/bindings` | Admin | List all store bindings (optional `?userId=`) |
| DELETE | `/api/admin/bindings/:id` | Admin | Force-unbind any store |
| GET | `/api/admin/invite-codes` | Admin | List all invite codes with usage status |
| POST | `/api/admin/invite-codes` | Admin | Generate invite codes (`{ count }`, default 1, max 20) |
| DELETE | `/api/admin/invite-codes/:id` | Admin | Delete unused invite code |
| GET | `/api/health` | Public | Health check |

## Config Files

- `wxt.config.ts`: `extensionApi: 'chrome'`, permissions `['storage','cookies','scripting','alarms','unlimitedStorage']`, host_permissions `['https://*.shopee.tw/*']`
- `tsconfig.json` (root): `strict=true`, `moduleResolution=Bundler`, `baseUrl=.`, `paths: @/* → ./*`
- `tsconfig.json` (backend): `strict=true`, `moduleResolution=Bundler`, `outDir: ./dist`
- `tailwind.config.ts`: Content paths `entrypoints/**/*.{ts,tsx}`, `components/**/*.{ts,tsx}`

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **limited-time-sale** (1779 symbols, 2799 relationships, 112 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/limited-time-sale/context` | Codebase overview, check index freshness |
| `gitnexus://repo/limited-time-sale/clusters` | All functional areas |
| `gitnexus://repo/limited-time-sale/processes` | All execution flows |
| `gitnexus://repo/limited-time-sale/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
| Work in the Popup area (98 symbols) | `.claude/skills/generated/popup/SKILL.md` |
| Work in the Product area (76 symbols) | `.claude/skills/generated/product/SKILL.md` |
| Work in the Entrypoints area (55 symbols) | `.claude/skills/generated/entrypoints/SKILL.md` |
| Work in the Ui area (16 symbols) | `.claude/skills/generated/ui/SKILL.md` |

<!-- gitnexus:end -->
