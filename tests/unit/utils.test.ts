import { describe, it, expect } from 'vitest';
import { cn } from '@/components/lib/utils';
import {
  buildOneDaySkuProductInfo,
  extractSellerDiscounts,
  getHighestModelPrice,
  hasDedicatedOneDaySku,
  isFiveTimesPriceError,
  ONE_DAY_SKU_NAME,
} from '@/entrypoints/popup/one-day-sku';
import type { ShopeeProduct } from '@/entrypoints/popup/types';

describe('cn utility function', () => {
  it('should combine multiple class names', () => {
    const result = cn('class1', 'class2', 'class3');
    expect(result).toBe('class1 class2 class3');
  });

  it('should handle conditional class names', () => {
    const result = cn('base', 'active', false);
    expect(result).toBe('base active');
  });

  it('should handle undefined and null values', () => {
    const result = cn('base', undefined, null, 'valid');
    expect(result).toBe('base valid');
  });

  it('should handle nested arrays', () => {
    const result = cn(['class1', 'class2'], ['class3']);
    expect(result).toBe('class1 class2 class3');
  });

  it('should handle mixed conditions and classes', () => {
    const isActive = true;
    const isDisabled = false;
    const result = cn(
      'btn',
      isActive && 'btn-active',
      isDisabled && 'btn-disabled',
      ['btn-primary', 'btn-lg']
    );
    expect(result).toBe('btn btn-active btn-primary btn-lg');
  });
});

describe('price calculation', () => {
  it('should calculate discounted price correctly', () => {
    const originalPrice = 100;
    const discountRate = 60;
    const expectedPrice = Math.floor(originalPrice * discountRate / 100);
    expect(expectedPrice).toBe(60);
  });

  it('should handle zero discount', () => {
    const originalPrice = 200;
    const discountRate = 0;
    const expectedPrice = Math.floor(originalPrice * discountRate / 100);
    expect(expectedPrice).toBe(0);
  });

  it('should handle 100% discount', () => {
    const originalPrice = 150;
    const discountRate = 100;
    const expectedPrice = Math.floor(originalPrice * discountRate / 100);
    expect(expectedPrice).toBe(150);
  });
});

describe('SKU key generation', () => {
  it('should generate correct SKU key', () => {
    const itemId = '123456789';
    const modelId = '1';
    const key = `${itemId}-${modelId}`;
    expect(key).toBe('123456789-1');
  });

  it('should handle different formats', () => {
    const key1 = '987654321-2';
    const key2 = '456789012-3';
    expect(key1).not.toBe(key2);
  });
});

describe('one day SKU helpers', () => {
  const product = {
    itemid: '1001',
    name: '测试商品',
    images: [],
    variationImages: [],
    transparentBackgroundImage: '',
    status: 0,
    inputOriginPrice: '100',
    originPrice: '100',
    normalStock: 10,
    localPrice: '100',
    pffTag: false,
    normalSellerStock: 10,
    normalWmsStock: 0,
    minPurchaseLimit: 0,
    itemSellerSellableStock: 10,
    itemWmsSellableStock: 0,
    itemTotalReservedStock: 0,
    itemNormalStock: 10,
    modelList: [
      { modelid: '1', name: 'A', inputOriginPrice: '120', originPrice: '120', normalStock: 3 },
      { modelid: '2', name: 'B', inputOriginPrice: '250', originPrice: '250', normalStock: 5 },
    ],
  } as ShopeeProduct;

  it('calculates highest SKU price from model list', () => {
    expect(getHighestModelPrice(product)).toBe(250);
  });

  it('detects existing dedicated one day SKU by exact name', () => {
    expect(hasDedicatedOneDaySku(product)).toBe(false);
    expect(hasDedicatedOneDaySku({
      ...product,
      modelList: [...product.modelList, { ...product.modelList[0], modelid: '3', name: ONE_DAY_SKU_NAME }],
    })).toBe(true);
  });

  it('constructs a full product_info payload by appending one SKU', () => {
    const result = buildOneDaySkuProductInfo(product, {
      enable_model_level_dts: true,
      model_list: [
        { id: 11, name: 'A', price: '120', pre_order_info: { days_to_ship: 7, pre_order: true } },
      ],
    });

    expect(result.skuCreated).toBe(true);
    expect(result.highestPrice).toBe(250);
    expect(result.productInfo.model_list).toHaveLength(2);
    expect(result.productInfo.model_list?.[1]).toMatchObject({
      id: 0,
      name: ONE_DAY_SKU_NAME,
      price: '250',
      pre_order_info: { days_to_ship: 1, pre_order: false },
    });
  });

  it('refuses to build update payload without full model_list', () => {
    expect(() => buildOneDaySkuProductInfo(product, {})).toThrow(/model_list/);
  });

  it('refuses unverified multi-tier product update payloads', () => {
    expect(() => buildOneDaySkuProductInfo(product, {
      std_tier_variation_list: [{ custom_value: '颜色' }],
      model_list: [{ id: 11, name: 'A', price: '120' }],
    })).toThrow(/多规格/);
  });

  it('extracts seller discount records from search response', () => {
    const discounts = extractSellerDiscounts({
      data: {
        discounts: [
          { seller_discount: { discount_id: 902333706846208, name: '5折【五】', start_time: 1, end_time: 2 } },
          { bundle_deal: { discount_id: 1 } },
        ],
      },
    });

    expect(discounts).toHaveLength(1);
    expect(discounts[0]).toMatchObject({ promotionId: 902333706846208, name: '5折【五】' });
  });

  it('identifies five-times price validation errors', () => {
    expect(isFiveTimesPriceError('商品價格相差大於 5 倍')).toBe(true);
    expect(isFiveTimesPriceError({ message: 'normal validation error' })).toBe(false);
  });
});
