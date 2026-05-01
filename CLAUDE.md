# 限时特卖助手 (Limited Time Sale Helper)

**版本:** 1.0.0  
**状态:** 限时特卖功能已完成

## Project Overview
Chrome extension for automating Shopee Taiwan seller center flash sale operations.

## Tech Stack
- **Framework:** WXT 0.20.25 (Chrome MV3 extension)
- **UI:** React 19 + TypeScript
- **Styling:** Tailwind CSS 3 + shadcn/ui (`components/ui/`)
- **State:** Zustand 5
- **Build:** Vite (via WXT)

## Project Structure
```
limited-time-sale/
├── CLAUDE.md
├── package.json
├── wxt.config.ts              # WXT 配置（权限、域名）
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── components.json
├── entrypoints/
│   ├── background.ts           # Service Worker（最小化实现）
│   ├── content.ts              # Content Script（页面注入）
│   └── popup/
│       ├── App.tsx             # Popup UI 主布局
│       ├── store.ts            # Zustand store（全部业务逻辑）
│       ├── types.ts            # TypeScript 接口定义
│       ├── api.ts              # API 请求封装
│       ├── main.tsx            # 入口
│       ├── index.html
│       └── style.css
├── components/
│   ├── lib/utils.ts            # 工具函数
│   ├── product/
│   │   ├── ProductCard.tsx     # 商品卡片
│   │   ├── ProductList.tsx     # 商品列表
│   │   ├── SkuTable.tsx        # SKU 表格
│   │   └── SpcStatus.tsx       # SPC_CDS 状态指示器
│   └── ui/                     # shadcn/ui 基础组件
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── input.tsx
│       ├── scroll-area.tsx
│       ├── separator.tsx
│       └── table.tsx
```

## Architecture
- **Popup handles all API calls directly** — bypasses background Service Worker entirely due to MV3 message loss issues
- API calls use `browser.scripting.executeScript({ world: 'MAIN' })` to fetch from page context (avoids TLS/CORS)
- SPC_CDS cookie extracted via `browser.cookies.get()` with multi-domain fallback (`seller.shopee.tw` → `shopee.tw` → `www.shopee.tw` → `cookies.getAll({ domain: '.shopee.tw' })`)
- Background SW is minimal (mostly unused relay hub)

## Key Features
1. 自动获取 SPC_CDS Cookie（多域名回退）
2. GraphQL 查询商品详情和 SKU 列表
3. 限时特卖活动列表展示
4. 批量开启限时特卖（自动重试）
5. 诊断模式 — 检查失败 SKU 的库存/价格变化
6. 自适应库存 — 自动跳过库存为 0 的 SKU

## Important API Details
- **GraphQL:** `POST /api/marketing/v4/graphql/query/` — product/SKU details
- **Flash Sale:** `/api/marketing/v4/shop_flash_sale/` — list, items, enable
- **Required header:** `sc-fe-session` (CSRF token, extracted from page)
- **Required body field:** `use_global_category: true` (missing this causes code 1001 error)
- **Price rules:** Must be integer, strictly less than origin price
- **Batch behavior:** Large batches (400+) get lenient validation; small batches (≤5) get strict validation

## Common Patterns
- `injectedFetch<T>()` — executes fetch in MAIN world via `scripting.executeScript`
- `extractSpcCds()` — reads SPC_CDS via `browser.cookies`
- Progress tracking uses `EnableProgress` interface with round/success/failure counts

## Conventions
- Components in `components/ui/` are generic shadcn/ui, components in `components/product/` are domain-specific
- Price calculation: `Math.floor(price * discountRate / 100)`
- Debug logging uses `[enable]` tag prefix
