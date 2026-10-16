/**
 * 扩展功能定义（首页卡片数据）。
 *
 * 登记真实存在的工具；新增工具时补一条定义即可，
 * 不要在此注册尚未实现的分类或加载器。
 *
 * 图标：用 `lucide-react` 组件，**不使用 emoji**（用户 2026-10-13 明确要求：
 * emoji 不能作为功能标识）。新增功能时从 lucide 里挑语义接近的图标。
 */
import { Zap, PackageSearch, type LucideIcon } from 'lucide-react';

/** 限时特卖功能 id，导航判断用稳定 id，不用展示文案。 */
export const FLASH_SALE_FEATURE_ID = 'flash-sale';
/** 商品备货与物流功能 id */
export const SHIPPING_FEATURE_ID = 'shipping';

export interface FeatureDefinition {
  /** 稳定标识，不随界面文案变化 */
  id: string;
  /** 所属分类 id */
  categoryId: string;
  title: string;
  description: string;
  /** 卡片图标组件（lucide-react，不用 emoji） */
  Icon: LucideIcon;
  /** 入口标识，导航按此分发 */
  entry: string;
}

export interface FeatureCategory {
  id: string;
  title: string;
}

export const FEATURE_CATEGORIES: FeatureCategory[] = [
  { id: 'shop-operations', title: '店铺运营' },
];

export const FEATURES: FeatureDefinition[] = [
  {
    id: FLASH_SALE_FEATURE_ID,
    categoryId: 'shop-operations',
    title: '限时特卖',
    description: '创建或复制限时特卖活动，也可用自动循环按轮数／天数持续抢占场次。',
    Icon: Zap,
    entry: 'flash-sale-work',
  },
  {
    id: SHIPPING_FEATURE_ID,
    categoryId: 'shop-operations',
    title: '商品备货与物流',
    description: '一次安排完成成对切换：到点把参与商品改为现货 1 天，随后按你选的常规备货天数（2–10 天）恢复；可选在修改期间关闭并恢复店铺物流。',
    Icon: PackageSearch,
    entry: 'shipping-work',
  },
];

/** 按分类分组，只保留有功能登记的分类，避免首页出现空分类。 */
export function groupFeaturesByCategory(
  features: FeatureDefinition[],
  categories: FeatureCategory[] = FEATURE_CATEGORIES,
): Array<{ category: FeatureCategory; features: FeatureDefinition[] }> {
  return categories
    .map(category => ({
      category,
      features: features.filter(feature => feature.categoryId === category.id),
    }))
    .filter(group => group.features.length > 0);
}
