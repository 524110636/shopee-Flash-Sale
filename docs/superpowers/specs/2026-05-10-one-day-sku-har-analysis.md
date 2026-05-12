# One Day SKU HAR Analysis

## Confirmed Requests

### Add 1-Day SKU / Product Update

- HAR: `docs/shopee_api/添加一天SKU规格.har`
- Method: `POST`
- URL: `https://seller.shopee.tw/api/v3/product/update_product_info?SPC_CDS=...&SPC_CDS_VER=2`
- Key request fields:
  - `product_id`
  - `product_info.enable_model_level_dts`
  - `product_info.std_tier_variation_list`
  - `product_info.model_list`
  - each model includes `price`, `stock_setting_list`, and `pre_order_info.days_to_ship`
- Key response fields:
  - `code`
  - `msg`
  - `data.product_id`

Safety note: this HAR only captures the update request. The corresponding full product detail read is available in `读取完整商品详情.har` — the extension should call `get_product_info` first to get the complete `product_info` before constructing the update payload.

### Search Seller Discount By Item

- HAR: `docs/shopee_api/搜索商品折扣.har`
- Method: `POST`
- URL: `https://seller.shopee.tw/api/marketing/v3/public/discount/search/?SPC_CDS=...&SPC_CDS_VER=2`
- Request body:
  - `discount_type: 0`
  - `time_status: 0`
  - `keyword: <item_id>`
  - `search_type: 2`
- Key response fields:
  - `data.discounts[].seller_discount.discount_id`
  - `data.discounts[].seller_discount.name`
  - `data.discounts[].seller_discount.start_time`
  - `data.discounts[].seller_discount.end_time`

### Remove Item From Seller Discount

- HAR: `docs/shopee_api/关闭商品折扣活动.har`
- Method: `POST`
- URL: `https://seller.shopee.tw/api/marketing/v4/discount/delete_abnormal_seller_discount_items/?SPC_CDS=...&SPC_CDS_VER=2`
- Request body:
  - `promotion_id`
  - `item_id_list`
- Key response fields:
  - `error`
  - `data.total_count`
  - `data.success_count`
  - `data.failed_item_list`
  - `data.error_list`

## Resolved: Full Product Detail Read

### GET /api/v3/product/get_product_info

- HAR: `docs/shopee_api/读取完整商品详情.har`
- Method: `GET`
- URL: `https://seller.shopee.tw/api/v3/product/get_product_info?SPC_CDS=...&SPC_CDS_VER=2&product_id=41730430114&is_draft=false`
- Query params:
  - `product_id` — required
  - `is_draft` — `false` (published product)
- Response structure: `{ code: 0, msg: "success", data: { product_info: { ... } } }`
- Key response fields in `product_info`:
  - `model_list[]` — each model has `id`, `name`, `tier_index`, `price_info.input_normal_price`, `pre_order_info.days_to_ship`
  - `tier_variation[]` — variation name + options
  - `std_tier_variation_list[]` — standardized variation list (needed for `update_product_info`)
  - `enable_model_level_dts` — boolean
  - `description_info`, `images`, `weight`, `dimension`, `brand_info`, `attributes`, etc.

**Safety confirmation**: This response provides the complete `product_info` structure needed to safely construct `update_product_info` requests without overwriting existing product data. The `model_list` + `std_tier_variation_list` together enable reliable SKU append/update.

## Resolved: Restore Item To Seller Discount

### POST /api/marketing/v4/discount/update_seller_discount_items

- HAR: `docs/shopee_api/重新添加商品折扣.har` (re-captured, replaces the earlier `discount/list` capture)
- Method: `POST`
- URL: `https://seller.shopee.tw/api/marketing/v4/discount/update_seller_discount_items/?SPC_CDS=...&SPC_CDS_VER=2`
- Request body:
  ```json
  {
    "promotion_id": 888629212790784,
    "discount_model_list": [
      {
        "item_id": 41730430114,
        "model_id": 395846995169,
        "promotion_price": 213000000,
        "user_item_limit": 0,
        "status": 1,
        "promotion_stock": 0
      }
    ]
  }
  ```
- Key request fields:
  - `promotion_id` — the discount campaign to add items to
  - `discount_model_list[]` — array of SKU-level entries:
    - `item_id` — product ID
    - `model_id` — SKU model ID
    - `promotion_price` — discount price (in minor units, e.g. 213000000 = 2130.00)
    - `user_item_limit` — per-user purchase limit (0 = unlimited)
    - `status` — 1 = active
    - `promotion_stock` — 0 = unlimited
- Response: `{ error: 0, data: { total_count, success_count, failed_item_list, error_list } }`

## Implementation Boundary (Updated)

Both previously missing endpoints are now available:

- ✅ `GET /api/v3/product/get_product_info` — full product detail read for safe `update_product_info` construction
- ✅ `POST /api/marketing/v4/discount/update_seller_discount_items` — real restore endpoint for re-adding items to discount campaigns

The implementation can proceed with full automation. The existing code already provides:

- Product selection UI (checkbox + select-all in ProductList/ProductCard)
- `getHighestModelPrice()` / `hasDedicatedOneDaySku()` / `buildOneDaySkuProductInfo()` helpers
- `extractSellerDiscounts()` discount search parser
- `isFiveTimesPriceError()` price gap detector
- `runOneDaySkuAndEnable()` flow with phase tracking, progress display, error handling
- Full phase state machine: idle → preparing_sku → publishing_product → searching_discount → removing_discount → restoring_discount → starting_flash_sale → success/failed

The next step is to integrate the two new endpoints into `runOneDaySkuAndEnable()`:
1. Call `get_product_info` before SKU append to get complete product data
2. Call `update_product_info` after SKU append to publish
3. Call `update_seller_discount_items` after price-fix publish to restore discounts

## Phase 2 Implementation Status (Completed)

### ✅ Completed
- `one-day-sku.ts` core builder with `buildOneDaySkuProductInfo()`
- Multi-variation support: `generateTierCombinations()` Cartesian product for all tier combinations
- Stock extraction from both `stock_setting_list` and `stock_detail` formats
- Model count safety check (Shopee 100-model limit)
- `cleanModel()` strips response-only fields, preserves request-required fields
- UI: selection checkboxes, progress bar, error details, item status list
- `runOneDaySkuAndEnable()` loop in store.ts
- Types: `OneDaySkuFlowState`, `OneDaySkuItemStatus`, `OneDaySkuDiscountInfo`, `OneDaySkuFlowPhase`
- **Discount search + remove + restore flow** for ALL products (not just 5× price errors)
- **`getDiscountRatio()`** — computes highest discount ratio from existing models for new SKU pricing
- **`buildDiscountRestoreList()` with `discountRatio` param** — includes new 1-day SKUs in restore entries
- **Post-publish re-fetch with retry** — re-fetches `get_product_info` (up to 3 retries, 1s delay) to get new model IDs
- **`failed_item_list`/`error_list` checking** in restore response (individual model failures)
- **Console logging** with `[一键修复]` prefix at every step
- HAR confirmation for `delete_abnormal_seller_discount_items` and `update_seller_discount_items` flows
- `get_product_info` re-fetch API and 3-endpoint discount flow confirmed working

### ⏳ Pending (Phase 3+)
- Flash sale auto-start after SKU creation

### ⚠️ Known Issues
- Products with >100 model combinations (including new one-day SKU variants) are skipped with a clear error message
- Products without variations (no tier_variation list) are handled via name-based matching (not tier_index)
