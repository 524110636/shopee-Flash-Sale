# 虾皮限时特卖 API 文档

> 本文件记录了虾皮卖家中心限时特卖（Flash Sale）相关的 API 端点、请求格式和响应格式，供开发参考。

---

## 基本信息

- **Base URL:** `https://seller.shopee.tw/api/marketing/v4/shop_flash_sale`
- **GraphQL URL:** `https://seller.shopee.tw/api/marketing/v4/graphql/query/`
- **认证方式:** `SPC_CDS` + `SPC_CDS_VER` 作为 query 参数
- **CSRF 令牌:** `sc-fe-session` header（从页面 window/ meta / cookie 中获取）
- **Content-Type:** `application/json;charset=UTF-8`
- **站点映射:** 所有 API 均支持多站点（如 `seller.shopee.tw`、`seller.shopee.com.my` 等）

---

## 限时特卖 API 总览

| # | API | 方法 | 用途 | 来源 |
|---|-----|------|------|------|
| 1 | `get_shop_flash_sale_list/` | GET | 获取活动列表 | 原有 + 皮具工匠 |
| 2 | `get_shop_flash_sale/` | GET | 获取单个活动详情 | **新发现** |
| 3 | `get_shop_flash_sale_item_id_list/` | GET | 获取活动中的商品 ID 列表 | 原有 |
| 4 | `get_shop_flash_sale_item/` | GET | **获取活动中的商品完整配置（价格/库存/限购）** | 皮具工匠 + 抓包确认 |
| 5 | `get_abnormal_items/` | GET | 检查活动中的异常商品 | **新发现** |
| 6 | `get_item_criteria/` | GET | 获取商品上架条件/规则 | **新发现** |
| 7 | `get_time_slot_id/` | GET | 获取可用时间段 | 皮具工匠 + 抓包确认 |
| 8 | `set_shop_flash_sale/` | POST | 创建/关闭/删除活动 | 皮具工匠 + 抓包确认 |
| 9 | `set_shop_flash_sale_items/` | POST | 设置活动商品（开启限时特卖） | 原有 |
| 10 | GraphQL `query/` | POST | 查询商品详细信息 | 原有 |

---

## API 详情

### 1. 获取限时特卖活动列表

获取当前商家的所有限时特卖活动。

**端点:** `GET /api/marketing/v4/shop_flash_sale/get_shop_flash_sale_list/`

**参数:**

| 参数 | 必填 | 说明 |
|------|------|------|
| `SPC_CDS` | 是 | Cookie 认证 |
| `SPC_CDS_VER` | 是 | Cookie 版本 |
| `offset` | 否 | 分页偏移（默认 0） |
| `limit` | 否 | 每页数量（默认 50） |
| `type` | 否 | 活动类型（默认 0） |

**响应:**

```json
{
  "code": 0,
  "data": {
    "flash_sale_list": [
      {
        "flash_sale_id": "267381650243584",
        "timeslot_id": "...",
        "name": "活动名称",
        "status": 1,
        "start_time": 1777704983,
        "end_time": 1777737600,
        "type": 3
      }
    ]
  }
}
```

**状态说明:**

- `status: 1` — 进行中
- `status: 2` — 已结束/关闭
- `start_time` / `end_time` — Unix 时间戳（秒）

---

### 2. 获取单个活动详情

获取指定限时特卖活动的详细信息。

**端点:** `GET /api/marketing/v4/shop_flash_sale/get_shop_flash_sale/`

**参数:**

| 参数 | 必填 | 说明 |
|------|------|------|
| `SPC_CDS` | 是 | Cookie 认证 |
| `SPC_CDS_VER` | 是 | Cookie 版本 |
| `flash_sale_id` | 是 | 活动 ID |

**响应:** （待补充完整字段）

```json
{
  "code": 0,
  "data": {
    "flash_sale_id": "267381650243584",
    "timeslot_id": "...",
    "start_time": 1777704983,
    "end_time": 1777737600,
    "status": 1,
    "item_count": 14,
    "type": 1
  }
}
```

---

### 3. 获取活动中的商品 ID 列表

只返回商品 ID，不含价格/库存配置信息。

**端点:** `GET /api/marketing/v4/shop_flash_sale/get_shop_flash_sale_item_id_list/`

**参数:**

| 参数 | 必填 | 说明 |
|------|------|------|
| `SPC_CDS` | 是 | Cookie 认证 |
| `SPC_CDS_VER` | 是 | Cookie 版本 |
| `flash_sale_id` | 是 | 活动 ID |

**响应:**

```json
{
  "code": 0,
  "data": {
    "item_ids": ["40929214553", "45356770184", "51707202143", "..."]
  }
}
```

---

### 4. 获取活动中的商品完整配置（关键！）

返回活动中每个商品的详细配置，包括促销价格、活动库存、限购数量等。

> 这是**复制限时特卖最关键的 API**，能拿到当前活动中所有商品的完整设置。

**端点:** `GET /api/marketing/v4/shop_flash_sale/get_shop_flash_sale_item/`

**参数:**

| 参数 | 必填 | 说明 |
|------|------|------|
| `SPC_CDS` | 是 | Cookie 认证 |
| `SPC_CDS_VER` | 是 | Cookie 版本 |
| `flash_sale_id` | 是 | 活动 ID |
| `offset` | 否 | 分页偏移 |
| `limit` | 否 | 每页数量（建议 100） |

**响应:**

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "item_id": "商品ID",
        "model_id": "SKU-ID",
        "item_display_image": "图片URL",
        "purchase_limit": 5,
        "stock": 200,
        "status": 1
      }
    ],
    "model_info_str": "{\"商品ID\":{\"456\":{\"price\":99}}}"
  }
}
```

**关键字段说明:**

- `items[].stock` — 该 SKU 在此活动中的活动库存
- `items[].purchase_limit` — 限购数量
- `model_info_str` — JSON 字符串，包含每个 item_id 下每个 model_id 对应的 `price`（促销价）
- 通过 `model_info_str` 可以获取到每个 SKU 在活动中的实际促销价格

---

### 5. 检查活动中的异常商品

检查指定限时特卖活动中是否有异常商品。

**端点:** `GET /api/marketing/v4/shop_flash_sale/get_abnormal_items/`

**参数:**

| 参数 | 必填 | 说明 |
|------|------|------|
| `SPC_CDS` | 是 | Cookie 认证 |
| `SPC_CDS_VER` | 是 | Cookie 版本 |
| `flash_sale_id` | 是 | 活动 ID |

**响应:**

```json
{
  "code": 0,
  "data": {
    "total_count": 0,
    "item_id_list": []
  }
}
```

- `total_count` — 异常商品数量
- `item_id_list` — 异常商品的 ID 列表

---

### 6. 获取商品上架条件/规则

获取限时特卖商品的上架条件和规则。

**端点:** `GET /api/marketing/v4/shop_flash_sale/get_item_criteria/`

**参数:**

| 参数 | 必填 | 说明 |
|------|------|------|
| `SPC_CDS` | 是 | Cookie 认证 |
| `SPC_CDS_VER` | 是 | Cookie 版本 |

**响应:** （待补充完整字段）

```json
{
  "code": 0,
  "data": { }
}
```

---

### 7. 获取可用时间段

创建新活动前需要先获取可用的时间段 ID。

**端点:** `GET /api/marketing/v4/shop_flash_sale/get_time_slot_id/`

**参数:**

| 参数 | 必填 | 说明 |
|------|------|------|
| `SPC_CDS` | 是 | Cookie 认证 |
| `SPC_CDS_VER` | 是 | Cookie 版本 |
| `start_time` | 是 | 起始时间（Unix 时间戳，秒） |
| `end_time` | 是 | 结束时间（Unix 时间戳，秒） |

**时间计算:**

```js
startTime = Math.floor(Date.now() / 1000) - 1800  // 当前时间前 30 分钟（容差）
endTime = 下个月第一天 - 1 秒                        // 到月底
// 优先选择最近的未来时间段
```

**响应:**

```json
{
  "code": 0,
  "data": [
    {
      "timeslot_id": 253245990121473,
      "start_time": 1777716000,
      "end_time": 1777737600
    }
  ]
}
```

- `data` 数组可能返回**数十到上百个**可用时间段
- 每个时间段有唯一 `timeslot_id`、开始时间和结束时间

---

### 8. 创建/关闭/删除限时特卖活动

同一个端点，不同 payload 实现不同操作。

**端点:** `POST /api/marketing/v4/shop_flash_sale/set_shop_flash_sale/`

#### 8a. 创建新活动

**请求:**

```json
{
  "time_slot_id": "253245990121473"
}
```

**响应:**

```json
{
  "code": 0,
  "data": {
    "flash_sale_id": "267428227989504",
    "ctime": 0,
    "enabled_item_count": 0,
    "end_time": 1777737600,
    "item_count": 0,
    "mtime": 0,
    "start_time": 1777716000,
    "status": 1,
    "timeslot_id": 253245990121473,
    "type": 1
  }
}
```

**关键字段说明:**

- `flash_sale_id` — 新创建的活动 ID
- `item_count: 0` — 刚创建时商品数为 0（服务端随后自动复制）
- `status: 1` — 创建后立即生效（进行中）

#### 8b. 关闭活动

**请求:**

```json
{
  "flash_sale_id": "活动ID",
  "time_slot_id": "时段ID",
  "status": 2
}
```

**响应:**

```json
{
  "code": 0,
  "message": "success"
}
```

---

### 9. 设置活动商品（开启限时特卖）

将商品添加到限时特卖活动中并设置价格、库存、限购等。

**端点:** `POST /api/marketing/v4/shop_flash_sale/set_shop_flash_sale_items/`

**请求:**

```json
{
  "flash_sale_id": "活动ID",
  "items": [
    {
      "item_id": "商品ID",
      "model_id": "SKU-ID",
      "status": 1,
      "item_display_image": "图片URL",
      "input_promo_price": 99,
      "stock": 200,
      "purchase_limit": 5
    }
  ],
  "use_global_category": true
}
```

**响应:**

```json
{
  "code": 0,
  "data": {
    "failed_items": []
  }
}
```

**说明:**

- `status: 1` — 启用
- `input_promo_price` — 促销价（整数，必须低于原价）
- `stock` — 活动库存
- `purchase_limit` — 限购数量（0=不限购）
- `use_global_category: true` — **必须设置**，否则报 code 1001 错误
- `failed_items` 数组包含失败的 item 及错误信息

---

### 10. GraphQL 商品查询

查询商品的详细信息（原价、库存、SKU 列表等）。

**端点:** `POST /api/marketing/v4/graphql/query/`

**参数（query params）:**

| 参数 | 必填 | 说明 |
|------|------|------|
| `SPC_CDS` | 是 | Cookie 认证 |
| `SPC_CDS_VER` | 是 | Cookie 版本 |

**请求体:**

```json
{
  "query": "query Products($productIds: [String], $statusType: Int) {
    products(productIds: $productIds, statusType: $statusType) {
      items {
        itemid, name, images, status, inputOriginPrice, originPrice,
        normalStock, modelList {
          modelid, name, originPrice, normalStock, totalNormalStock
        }
      }
    }
  }",
  "variables": {
    "productIds": ["商品ID1", "商品ID2"],
    "statusType": 0
  }
}
```

**复制页面使用的完整查询（含更多字段）:**

```json
{
  "query": "query Products($productIds: [String], $statusType: Int) {
    products(productIds: $productIds, statusType: $statusType) {
      items {
        itemid, name, images, variationImages, transparentBackgroundImage,
        status, inputOriginPrice, originPrice, normalStock, localPrice,
        pffTag, normalSellerStock, normalWmsStock, minPurchaseLimit,
        itemSellerSellableStock, itemWmsSellableStock,
        itemTotalReservedStock, itemNormalStock,
        modelList {
          modelid, name, inputOriginPrice, originPrice, normalStock,
          localPrice, pffTag, normalSellerStock, normalWmsStock,
          modelNormalStock, modelSellerSellableStock,
          modelWmsSellableStock, modelTotalReservedStock,
          enableShopFlashSaleNewStock, totalNormalStock
        }
      }
    }
  }",
  "variables": {
    "productIds": ["商品ID1", "商品ID2"],
    "statusType": 0
  }
}
```

---

## 复制限时特卖完整流程

通过抓包确认的虾皮"复制限时特卖"完整流程。

### 阶段 1：点击"复制" → 创建页面加载（自动触发）

```
1. GET  get_shop_flash_sale/?flash_sale_id=源活动ID
   → 获取源活动的详细信息

2. GET  get_shop_flash_sale_item_id_list/?flash_sale_id=源活动ID
   → 获取源活动的商品 ID 列表

3. GET  get_shop_flash_sale_item/?flash_sale_id=源活动ID&offset=0&limit=100
   → 获取源活动中每个 SKU 的完整配置（促销价、库存、限购数量）★

4. GET  get_abnormal_items/?flash_sale_id=源活动ID
   → 检查源活动是否有异常商品

5. GET  get_item_criteria/
   → 获取商品上架条件/规则

6. GET  check shops/
   → 检查店铺信息
```

### 阶段 2：选择时间段 → 点击"创建"

```
7. GET  get_time_slot_id/?start_time=...&end_time=...
   → 获取可用时间段列表

8. POST set_shop_flash_sale/  {"time_slot_id": "..."}
   → 创建新活动（Referrer 中的 from=源活动ID 告知服务器自动复制商品）
   → 响应返回新的 flash_sale_id
```

### 关键发现

- **不需要前端调用 `set_shop_flash_sale_items/`** — 虾皮在服务端自动完成商品复制
- 创建页面 URL 中的 `from=源活动ID` 参数通过 Referrer header 传递给服务器
- 服务器在创建新活动的同时，自动将源活动的商品配置克隆到新活动中

### 对比：手动"开启限时特卖"流程

当使用 `set_shop_flash_sale_items/` 时，需要自行构建 `EnableItem[]` 并调用：

```
1. GraphQL query/              → 获取商品详情（原价、库存）
2. POST set_shop_flash_sale_items/
   → 自行计算促销价、设置库存和限购
   → 需要通过 failed_items 处理失败重试
```

---

## 其他发现的 API

以下 API 在复制过程中出现，但作用较小：

### check shops

**端点:** `GET /api/marketing/v4/shop_flash_sale/check shops/`

检查店铺是否满足限时特卖条件。URL 中的空格可能是编码问题（`check%20shops/`）。

### 用户行为追踪（无关）

**端点:** `POST /api/report/miscellaneous/last_active`

```json
{
  "platform_id": 1,
  "shop_id": 65806468,
  "timestamp": 1777705332,
  "action_type": "click",
  "page_url": "https://seller.shopee.tw/portal/marketing/shop-flash-sale/create"
}
```

仅为埋点日志，与功能无关。

---

## API 调用时序图

```
点击"复制"                       选择时间段 → 点击"创建"
    │                                  │
    ├─ get_shop_flash_sale/             ├─ get_time_slot_id/
    ├─ get_shop_flash_sale_item_id_list/│
    ├─ get_shop_flash_sale_item/        ├─ POST set_shop_flash_sale/
    ├─ get_abnormal_items/              │  (服务端自动复制商品)
    ├─ get_item_criteria/               │
    └─ check shops/                     └─ 页面跳转到活动详情
```

## 断点续查

如后续需要补充 API 信息，可通过以下方式抓包：

1. 打开 seller.shopee.tw → 行销中心 → 限时特卖
2. F12 → Network → Fetch/XHR 过滤
3. 操作前清空（点 🚫），操作后观察新请求
4. 过滤关键字：`flash_sale`、`shop_flash`、`api/marketing`
