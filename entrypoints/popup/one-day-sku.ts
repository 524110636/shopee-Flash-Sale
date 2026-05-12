import type { ShopeeProduct, OneDaySkuDiscountInfo } from './types';

export const ONE_DAY_SKU_NAME = '批發客戶下訂-請勿下單';

export interface ProductInfoModel {
  id?: number;
  name?: string;
  price?: string | number;
  pre_order_info?: {
    days_to_ship?: number;
    pre_order?: boolean;
  };
  [key: string]: unknown;
}

export interface ProductInfoPayload {
  enable_model_level_dts?: boolean;
  std_tier_variation_list?: unknown[];
  model_list?: ProductInfoModel[];
  [key: string]: unknown;
}

export interface OneDaySkuBuildResult {
  productInfo: ProductInfoPayload;
  hasOneDaySku: boolean;
  skuCreated: boolean;
  highestPrice: number;
}

/** 从 model 中提取可售库存，支持 stock_setting_list 和 stock_detail 两种格式 */
function extractSellableStock(model: Record<string, unknown>): number {
  // stock_setting_list 格式: [{ sellable_stock: number }]
  if (Array.isArray(model.stock_setting_list) && model.stock_setting_list.length > 0) {
    const stock = Number((model.stock_setting_list as any)[0]?.sellable_stock);
    if (Number.isFinite(stock) && stock >= 0) return stock;
  }
  // stock_detail 格式: { seller_stock_info: [{ sellable_stock: number }] }
  const detail = model.stock_detail as any;
  if (detail && Array.isArray(detail.seller_stock_info) && detail.seller_stock_info.length > 0) {
    const stock = Number(detail.seller_stock_info[0]?.sellable_stock);
    if (Number.isFinite(stock) && stock >= 0) return stock;
  }
  return 0;
}

export function getHighestModelPrice(product: ShopeeProduct): number {
  const prices = (product.modelList || [])
    .map(model => Number(model.originPrice || model.inputOriginPrice || product.originPrice || product.inputOriginPrice || 0))
    .filter(price => Number.isFinite(price) && price > 0);

  return prices.length > 0 ? Math.max(...prices) : 0;
}

export function hasDedicatedOneDaySku(product: ShopeeProduct): boolean {
  return (product.modelList || []).some(model => model.name === ONE_DAY_SKU_NAME);
}

/** 检查商品是否已有任意 1 天备货 SKU（不限名称） */
export function hasAnyOneDayDeliverySku(modelList: Record<string, unknown>[]): boolean {
  return modelList.some(m => m?.pre_order_info && (m.pre_order_info as any)?.days_to_ship === 1);
}

/** 生成多规格组合索引：第一层固定为 newTier0Idx，其他层遍历所有已有选项的笛卡尔积 */
function generateTierCombinations(newTier0Idx: number, tierVariationList: any[]): number[][] {
  const otherTierCounts = tierVariationList.slice(1).map(
    (tier: any) => tier.value_list?.length ?? 0
  );
  // 只有一层规格
  if (otherTierCounts.length === 0) return [[newTier0Idx]];

  const result: number[][] = [];
  function dfs(prefix: number[], depth: number) {
    if (depth === otherTierCounts.length) {
      result.push([newTier0Idx, ...prefix]);
      return;
    }
    for (let i = 0; i < otherTierCounts[depth]; i++) {
      prefix.push(i);
      dfs(prefix, depth + 1);
      prefix.pop();
    }
  }
  dfs([], 0);
  return result;
}

export function buildOneDaySkuProductInfo(product: ShopeeProduct, productInfo: ProductInfoPayload): OneDaySkuBuildResult {
  const modelList = Array.isArray(productInfo.model_list) ? [...productInfo.model_list] : null;
  if (!modelList) {
    throw new Error('缺少完整 product_info.model_list，不能安全构造 update_product_info 请求');
  }

  const highestPrice = getHighestModelPrice(product);
  if (highestPrice <= 0) {
    throw new Error('无法从商品 SKU 中计算最高价格');
  }

  // 深拷贝 std_tier_variation_list，后续可能需要新增选项
  const tierVariationList: any[] | null = Array.isArray(productInfo.std_tier_variation_list)
    ? JSON.parse(JSON.stringify(productInfo.std_tier_variation_list))
    : null;

  // 在第一个规格层中查找或追加"批發客戶下訂-請勿下單"选项
  let oneDaySkuTier1Idx: number | null = null;
  if (tierVariationList && tierVariationList.length > 0 && Array.isArray(tierVariationList[0]?.value_list)) {
    const firstTier = tierVariationList[0];
    const existingVariationIdx = firstTier.value_list.findIndex(
      (v: any) => v.custom_value === ONE_DAY_SKU_NAME
    );
    if (existingVariationIdx >= 0) {
      oneDaySkuTier1Idx = existingVariationIdx;
    } else {
      oneDaySkuTier1Idx = firstTier.value_list.length;
      firstTier.value_list.push({ id: 0, custom_value: ONE_DAY_SKU_NAME });
    }
  }

  // 清理已有 model：保留 update_product_info 需要的字段，转换响应格式为请求格式
  const cleanModel = (m: Record<string, any>): Record<string, any> => {
    const ownPrice = m.price_info?.input_normal_price ?? m.price;
    const entry: Record<string, any> = {
      id: m.id,
      tier_index: m.tier_index,
    };
    if (ownPrice != null) {
      entry.price = String(ownPrice);
    }
    // stock_setting_list 优先（请求格式），否则从 stock_detail 转换
    if (Array.isArray(m.stock_setting_list) && m.stock_setting_list.length > 0) {
      entry.stock_setting_list = m.stock_setting_list;
    } else {
      const sellableStock = extractSellableStock(m);
      if (sellableStock > 0) {
        entry.stock_setting_list = [{ sellable_stock: sellableStock }];
      }
    }
    if (m.pre_order_info) {
      entry.pre_order_info = { ...m.pre_order_info };
    }
    return entry;
  };
  const nextModelList = modelList.map(m => cleanModel(m));
  let skuCreated = false;
  let hasOneDaySku = false;

  if (oneDaySkuTier1Idx !== null && tierVariationList && tierVariationList.length > 0) {
    // === 有规格商品 ===
    // 通过 tier_index 查找已有"批發客戶下訂-請勿下單" SKU（可能有多组组合）
    const existingOneDaySkuModels = nextModelList.filter(
      (m: any) => Array.isArray(m.tier_index) && m.tier_index[0] === oneDaySkuTier1Idx
    );

    if (existingOneDaySkuModels.length > 0) {
      hasOneDaySku = true;
      // 已存在：更新所有组合的价格和备货天数
      for (const model of existingOneDaySkuModels) {
        model.price = String(highestPrice);
        model.pre_order_info = { days_to_ship: 1, pre_order: false };
      }
    } else {
      // 新增：为所有规格组合创建 SKU（笛卡尔积）
      const tierCombinations = generateTierCombinations(oneDaySkuTier1Idx, tierVariationList);
      const totalAfterAdd = nextModelList.length + tierCombinations.length;
      if (totalAfterAdd > 100) {
        throw new Error(`商品规格组合已达 ${nextModelList.length} 组，新增 ${tierCombinations.length} 组后会超过虾皮限制 100 组（上限 100 组），无法新增批發客戶 SKU`);
      }
      const baseModel = modelList[0];
      if (!baseModel) {
        throw new Error('商品没有可复制的 SKU 模板，不能安全新增 SKU');
      }
      const sellableStock = extractSellableStock(baseModel);

      for (const tierIdx of tierCombinations) {
        nextModelList.push({
          id: 0,
          price: String(highestPrice),
          is_default: false,
          gtin_code: '',
          confirm_empty_gtin: false,
          sku: '',
          stock_setting_list: [{ sellable_stock: sellableStock }],
          sku_image: '',
          pre_order_info: { days_to_ship: 1, pre_order: false },
          tier_index: tierIdx,
        });
      }
      skuCreated = true;
    }
  } else {
    // === 无规格商品 ===
    const existingIndex = modelList.findIndex(model => model.name === ONE_DAY_SKU_NAME);

    if (existingIndex >= 0) {
      hasOneDaySku = true;
      // 已有批發客戶 SKU：更新价格和备货天数
      nextModelList[existingIndex] = {
        ...nextModelList[existingIndex],
        price: String(highestPrice),
        pre_order_info: {
          days_to_ship: 1,
          pre_order: false,
        },
      };
    } else {
      const baseModel = modelList[0];
      if (!baseModel) {
        throw new Error('商品没有可复制的 SKU 模板，不能安全新增 SKU');
      }
      const sellableStock = extractSellableStock(baseModel);

      nextModelList.push({
        id: 0,
        name: ONE_DAY_SKU_NAME,
        price: String(highestPrice),
        is_default: false,
        gtin_code: '',
        confirm_empty_gtin: false,
        sku: '',
        stock_setting_list: [{ sellable_stock: sellableStock }],
        sku_image: '',
        pre_order_info: { days_to_ship: 1, pre_order: false },
      });
      skuCreated = true;
    }
  }

  return {
    productInfo: {
      enable_model_level_dts: true,
      std_tier_variation_list: tierVariationList ?? undefined,
      model_list: nextModelList as ProductInfoModel[],
    },
    hasOneDaySku,
    skuCreated,
    highestPrice,
  };
}

export function isFiveTimesPriceError(error: unknown): boolean {
  const text = typeof error === 'string' ? error : JSON.stringify(error ?? '');
  return /5\s*倍|五倍|price.*5|5.*price|價格.*差|价格.*差|price.*difference/i.test(text);
}

/** 从现有 model 列表中计算最高折扣率（最高折数 = mildest discount）。
 *  例如 5.4折(ratio=0.54) vs 6.5折(ratio=0.65) → 返回 0.65 */
export function getDiscountRatio(modelList: Record<string, any>[]): number | null {
  let maxRatio: number | null = null;
  for (const m of modelList) {
    const normal = Number(m?.price_info?.input_normal_price ?? 0);
    const promo = Number(m?.price_info?.input_promotion_price ?? 0);
    if (normal > 0 && promo > 0 && promo < normal) {
      const ratio = promo / normal;
      if (maxRatio === null || ratio > maxRatio) {
        maxRatio = ratio;
      }
    }
  }
  return maxRatio;
}

/** 将产品 model_list 转换为折扣恢复请求体（promotion_price 使用当前折扣价转换为最小单位）。
 *  discountRatio: 可选折扣率，用于没有 input_promotion_price 的 model（如新增的 1 天备货 SKU） */
export function buildDiscountRestoreList(
  modelList: Record<string, any>[],
  productId: number,
  discountRatio?: number,
): Record<string, any>[] {
  return modelList
    .filter(m => m.id != null && m.id > 0)
    .map(m => {
      let price: number;
      const promoPrice = m.price_info?.input_promotion_price;
      const normalPrice = m.price_info?.input_normal_price ?? m.price ?? 0;

      if (promoPrice != null && Number(promoPrice) > 0) {
        price = Number(promoPrice);
      } else if (discountRatio != null && discountRatio > 0 && discountRatio < 1 && Number(normalPrice) > 0) {
        price = Number(normalPrice) * discountRatio;
      } else {
        price = Number(normalPrice);
      }

      const priceInMinor = Math.round(price * 100000);
      return {
        item_id: productId,
        model_id: m.id,
        promotion_price: priceInMinor,
        user_item_limit: 0,
        status: 1,
        promotion_stock: 0,
      };
    });
}

export function extractSellerDiscounts(response: any): OneDaySkuDiscountInfo[] {
  const discounts = response?.data?.discounts;
  if (!Array.isArray(discounts)) return [];

  return discounts
    .map((entry: any) => entry?.seller_discount)
    .filter(Boolean)
    .map((discount: any) => ({
      promotionId: Number(discount.discount_id),
      name: String(discount.name || `折扣活动 #${discount.discount_id}`),
      startTime: typeof discount.start_time === 'number' ? discount.start_time : undefined,
      endTime: typeof discount.end_time === 'number' ? discount.end_time : undefined,
      raw: discount,
    }))
    .filter((discount: OneDaySkuDiscountInfo) => Number.isFinite(discount.promotionId));
}
