// 虾皮返回的 SKU（Model）数据结构
export interface ShopeeModel {
  modelid: string;
  name: string;
  inputOriginPrice: string;
  originPrice: string;
  normalStock: number;
  localPrice: string;
  pffTag: boolean;
  normalSellerStock: number;
  normalWmsStock: number;
  modelNormalStock: number;
  modelSellerSellableStock: number;
  modelWmsSellableStock: number;
  modelTotalReservedStock: number;
  enableShopFlashSaleNewStock: boolean;
  totalNormalStock: number;
}

// 虾皮返回的商品数据结构
export interface ShopeeProduct {
  itemid: string;
  name: string;
  images: string[];
  variationImages: string[];
  transparentBackgroundImage: string;
  status: number;
  inputOriginPrice: string;
  originPrice: string;
  normalStock: number;
  localPrice: string;
  pffTag: boolean;
  normalSellerStock: number;
  normalWmsStock: number;
  minPurchaseLimit: number;
  itemSellerSellableStock: number;
  itemWmsSellableStock: number;
  itemTotalReservedStock: number;
  itemNormalStock: number;
  modelList: ShopeeModel[];
}

// GraphQL 查询的变量参数
export interface ProductsQueryVariables {
  productIds: string[];
  statusType: number;
}

// GraphQL 查询的响应
export interface ProductsQueryResponse {
  products: {
    items: ShopeeProduct[];
  };
}

// 虾皮 API 通用响应包装
export interface ShopeeApiResponse<T> {
  code: number;
  message: string;
  user_message: string;
  data: T;
}

// 限时特卖活动
export interface FlashSale {
  flash_sale_id: number;
  name: string;
  start_time: number;
  end_time: number;
  status: number;
}

// 限时特卖活动列表响应
export interface FlashSaleListData {
  flash_sale_list: FlashSale[];
}

// 限时特卖商品 ID 列表响应
export interface FlashSaleItemIdListData {
  item_ids: number[];
}

// ===== 开启限时特卖相关类型 =====

// 单个 SKU 的限时参数覆盖
export interface SkuOverride {
  discountRate?: number; // 折扣率（百分比），不填则使用全局默认
  promoPrice?: number; // 限时价（直接指定价格，优先级高于 discountRate）
  stock?: number; // 活动库存，不填则使用全局默认
  purchaseLimit?: number; // 限购数量，不填则使用全局默认（0=不限购）
}

// 提交到 set_shop_flash_sale_items 的单条 item
export interface EnableItem {
  item_id: number;
  status: number; // 1=启用
  model_id: number;
  item_display_image: string;
  input_promo_price: number;
  stock: number;
  purchase_limit: number;
}

// 返回结果中单条 item 的状态
export interface EnableResult {
  item_id: number;
  model_id: number;
  err_code?: number;
  err_msg?: string;
  unqualified_conditions?: Array<{ unqualified_code: number; params: string[]; value: string }>;
}

// set_shop_flash_sale_items 的完整响应
export interface EnableResponse {
  code?: number;
  data?: EnableResult[] | EnableResult;
  message?: string;
}

// 进度状态
export interface EnableProgress {
  totalSkus: number;
  successSkus: number;
  failedSkus: number;
  currentRound: number;
  maxRetries: number;
  nextRetryItems: EnableResult[];
  hardFailedSkus?: EnableResult[]; // 不可重试的硬错误（如价格超限），需用户手动处理
  isComplete: boolean;
  lastResponsePreview?: string;
}

// 扩展内部消息类型（content script ↔ popup 通信）
export type MessagePayload =
  | { type: 'SPC_CDS_UPDATE'; spcCds: string; spcCdsVer: string }
  | { type: 'SPC_CDS_REQUEST' }
  | { type: 'SPC_CDS_RESPONSE'; spcCds: string; spcCdsVer: string }
  | { type: 'FETCH_PRODUCTS'; productIds: string[] }
  | { type: 'FETCH_PRODUCTS_RESULT'; products: ShopeeProduct[] }
  | { type: 'FETCH_PRODUCTS_ERROR'; error: string };

// Content script 注入脚本的消息类型（页面主世界 ↔ content script）
export interface InjectionPayload {
  type: 'GET_SPC_CDS' | 'SPC_CDS_FROM_PAGE';
  data?: { spcCds: string; spcCdsVer: string };
}

// 缓存数据（30 分钟有效）
export interface CacheData {
  timestamp: number;
  products: ShopeeProduct[];
  flashSaleList: FlashSale[];
  flashSaleId: number | null;
  flashSaleInfo: string;
  enableProgress: EnableProgress | null;
  skuOverrides: Record<string, SkuOverride>;
  discountRate: number;
  flashSaleStock: number;
  purchaseLimit: number;
  maxRetries: number;
  infiniteRetry: boolean;
}

// ===== 复制限时特卖相关类型 =====

export interface TimeSlot {
  timeslot_id: number;
  start_time: number;
  end_time: number;
}

export interface ScheduledCopyParams {
  sourceFlashSaleId: number;
  sourceFlashSaleName: string;
  targetStartTime: number;
  templateName: string | null;
  templateItems: EnableItem[] | null;
  products: ShopeeProduct[];
  discountRate: number;
  flashSaleStock: number;
  purchaseLimit: number;
  skuOverrides: Record<string, SkuOverride>;
}

export interface CopyTaskStatus {
  scheduled: boolean;
  executed: boolean;
  success: boolean | null;
  newFlashSaleId?: number;
  error?: string;
  warning?: string;
}

// 定时任务存活状态查询结果
export interface ScheduledTaskStatus {
  exists: boolean;
  alarmActive: boolean;
  params: ScheduledCopyParams | null;
  alarmScheduledTime?: number;
  remainingSeconds?: number;
}

// 复制时保存的源活动商品数据，用于新活动展示和开启限时特卖
export interface CopiedSaleData {
  sourceFlashSaleId: number;
  sourceFlashSaleName: string;
  newFlashSaleId: number;
  copiedAt: number;
  products: ShopeeProduct[];
  skuOverrides: Record<string, SkuOverride>;
  discountRate: number;
  flashSaleStock: number;
  purchaseLimit: number;
}

// ===== 模板相关类型 =====

// 模板中保存的商品简要信息（用于比对显示）
export interface TemplateProductInfo {
  itemId: string;
  name: string;
}

// 单个命名模板
export interface FlashSaleTemplate {
  name: string;
  createdAt: number;
  updatedAt: number;
  discountRate: number;
  flashSaleStock: number;
  purchaseLimit: number;
  skuOverrides: Record<string, SkuOverride>;
  productInfo: TemplateProductInfo[];
}

// ===== 自动模式相关类型 =====

export interface AutoModeConfig {
  mode: 'rounds' | 'days';
  value: number;
  advanceMinutes: number;
  delayMinutes: number;
}

export type AutoModePhase =
  | 'idle'
  | 'waiting_create'
  | 'creating'
  | 'waiting_enable'
  | 'enabling'
  | 'completed'
  | 'stopped';

export interface AutoModeStatus {
  isRunning: boolean;
  sourceFlashSaleId: number;
  sourceFlashSaleName: string;
  config: AutoModeConfig;
  currentRound: number;
  totalRounds: number;
  phase: AutoModePhase;
  nextTargetTime?: number;
  nextActionTime?: number;
  currentFlashSaleId?: number;
  lastError?: string;
  startedAt: number;
  debugMode?: boolean;
  selectedSlotId?: number;
  selectedSlotTime?: number;
  enableParams?: {
    products: ShopeeProduct[];
    skuOverrides: Record<string, SkuOverride>;
    discountRate: number;
    flashSaleStock: number;
    purchaseLimit: number;
    skipSkuKeys?: string[];
  };
}

export interface AutoModeLog {
  id: number;
  timestamp: number;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
}

// ===== 复制活动后内存预置商品数据 =====

export interface PendingFlashSaleData {
  flashSaleId: number;
  products: ShopeeProduct[];
  skuOverrides: Record<string, SkuOverride>;
  discountRate: number;
  flashSaleStock: number;
  purchaseLimit: number;
  sourceFlashSaleName: string;
}

// ===== 复制完成后的持久化提示信息 =====

export interface CompletedCopyInfo {
  newFlashSaleId: number;
  sourceFlashSaleName: string;
  isNew: boolean;
}

// ===== 未打折 SKU 拦截相关类型 =====

export interface UndiscountedSku {
  key: string;           // `${itemId}-${modelId}`
  itemId: string;
  modelId: number;
  productName: string;
  skuName: string;
  originPrice: number;
  promoPrice: number;
  image: string;
}

// ===== 一键补充 1 天备货 SKU 相关类型 =====

export type OneDaySkuFlowPhase =
  | 'idle'
  | 'preparing_sku'
  | 'publishing_product'
  | 'searching_discount'
  | 'removing_discount'
  | 'restoring_discount'
  | 'starting_flash_sale'
  | 'editing_params'
  | 'selecting_flash_sale'
  | 'success'
  | 'failed';

export interface OneDaySkuDiscountInfo {
  promotionId: number;
  name: string;
  startTime?: number;
  endTime?: number;
  timeStatus?: number; // 1=upcoming, 2=active, 3=ended
  raw: unknown;
}

export interface OneDaySkuItemStatus {
  itemId: string;
  itemName: string;
  hasOneDaySku: boolean;
  skuCreated: boolean;
  publishStatus: 'idle' | 'success' | 'failed';
  discountRemoved: boolean;
  discountRestored: boolean;
  flashSaleStatus: 'idle' | 'pending' | 'started' | 'failed';
  highestPrice?: number;
  error?: string;
  discounts?: OneDaySkuDiscountInfo[];
}

export interface OneDaySkuFlowState {
  phase: OneDaySkuFlowPhase;
  running: boolean;
  currentIndex: number;
  total: number;
  message: string;
  error: string | null;
  items: OneDaySkuItemStatus[];
  canStartFlashSale: boolean;
}

// ===== 第一次使用（获取全部商品 + 选择修复）类型 =====

export interface ShopProductListItem {
  id: number;
  name: string;
  status: number;
  coverImage: string;
  priceMin: number;
  priceMax: number;
  modelCount: number;
  soldCount: number;
}

export interface FirstUseState {
  open: boolean;
  loading: boolean;
  products: ShopProductListItem[];
  selectedIds: Set<number>;
  searchKeyword: string;
  searchResults: ShopProductListItem[];
  fetchedTotal: number;
  hasMore: boolean;
  cursor: string | null;
}

// ===== 后端管理系统类型 =====

export interface BackendUser {
  id: number;
  email: string;
  role: 'user' | 'admin';
  isActive: number;
  autoModeEnabled: number;
  createdAt: string;
  bindingCount?: number;
}

export interface BackendStoreBinding {
  id: number;
  userId: number;
  spcCds: string;
  shopId: number | null;
  accountId: number | null;
  shopUsername: string | null;
  shopName: string | null;
  maxStores: number;
  isActive: number;
  createdAt: string;
}

export interface BackendAuthState {
  token: string | null;
  user: { id: number; email: string; role: string; autoModeEnabled: number } | null;
  backendUrl: string;
}

export interface BackendAnalyticsSummary {
  summary: Record<string, number>;
  total: number;
}

export interface BackendAdminAnalytics {
  totalUsers: number;
  totalBindings: number;
  events: Array<{ eventType: string; count: number }>;
}
