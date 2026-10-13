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

// ===== 定时加入任务（SCHEDULE_ENABLE / WIZARD_FLOW）只读状态 =====

/** 定时加入的来源：`_scheduledEnable`（已有活动）或 `_wizardFlowParams`（向导创建新场次） */
export type ScheduledEnableSource = 'scheduled-enable' | 'wizard-flow';

/** popup 侧只读快照，仅用于首页摘要与查看入口；调度与校验仍在 background */
export interface ScheduledEnableStatus {
  exists: boolean;
  source: ScheduledEnableSource;
  /** 目标提交时间（运行时刻，秒）；向导流程在创建活动前取创建时间 */
  targetTime: number;
  flashSaleName: string;
  flashSaleId: number;
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
    shopId?: number | null;
  };
}

export interface AutoModeLog {
  id: number;
  timestamp: number;
  iso: string;
  type: 'info' | 'success' | 'error' | 'warning';
  message: string;
  data?: Record<string, unknown>;
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
  | 'failed'
  /** 后台执行者消失（worker 意外重启）留下的真实中断；不是失败，也不自动重放 */
  | 'interrupted';

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
  /**
   * 逐折扣活动的处理结果：哪个活动已确认移除成功、哪个结果未知。
   *
   * 多折扣商品上「活动 99 移除成功、活动 100 失败」时，只写一个 `discountRemoved: false`
   * 会把已成功的部分覆盖成"都没动"，用户无法判断要去核对哪一份折扣。
   */
  discountRemovals?: Array<{ promotionId: number; name: string; status: 'success' | 'failed' | 'unknown' }>;
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
  /** 当前任务标识；后台持久记录用它配对，popup 用它判断结果是否已应用过 */
  taskId?: string;
}

// ===== 后台一键修复任务（持久契约，popup 与 background 共用）=====

/** 任务状态：accepted/running 为执行中，其余为终态 */
export type OneDayRepairTaskStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted';

/** 逐商品检查点：记录关键写请求「发送前/后」，用于中断时说明哪些商品可能已被改动 */
export interface OneDaySkuCheckpoint {
  /** 单调递增序号，用于判断新旧 */
  seq: number;
  itemId: string;
  /** 步骤标识（如 update_product_info / delete_abnormal_seller_discount_items） */
  step: string;
  /** 请求是否已发出；已发出即不能在中断后盲目重放 */
  writeSent: boolean;
  at: number;
  /**
   * 本步骤作用于哪个折扣活动（多折扣时会先后处理多个）。
   * 用于区分"哪一份折扣已经改成功"，而不是只留下一句笼统的失败。
   */
  promotionId?: number;
  promotionName?: string;
  /** 该请求的结果：`success` 已确认成功；`unknown` 已发出但结果不明 */
  outcome?: 'success' | 'unknown';
}

export interface OneDayRepairTask {
  taskId: string;
  /** 同一次启动的请求标识；重复投递复用同一任务 */
  requestId: string;
  /** 发起者：普通勾选或首次使用 */
  source: 'manual-selection' | 'first-use';
  status: OneDayRepairTaskStatus;
  /** 归属锚：任务开始时实际核实的店铺与后端账号；不采用客户端自称值 */
  shopId: number | null;
  ownerUserId: number | null;
  /** 开始执行时的凭据指纹，只存指纹不存凭据，用于识别换账号 */
  spcCdsFingerprint: string;
  phase: OneDaySkuFlowPhase;
  currentIndex: number;
  total: number;
  message: string;
  error: string | null;
  items: OneDaySkuItemStatus[];
  /** 正在处理中的商品（含已移除的折扣与恢复资料）；发布失败/中断时靠它保留部分修改证据 */
  workItem: OneDaySkuItemStatus | null;
  /** 后台准备好的可编辑结果（修复结束时读取，不依赖 popup 再取一次） */
  resultProducts: ShopeeProduct[];
  /** 后台检测到的实际折扣率；null 表示无商品带折扣 */
  discountRate: number | null;
  checkpoints: OneDaySkuCheckpoint[];
  /** 是否已有商品写请求发出（中断提示用） */
  writeStarted: boolean;
  /** 中断时的心跳时间（仅作证据，判定不依赖它） */
  heartbeatAt?: number | null;
  /**
   * 记录版本号：每次后台写入自增。
   * 心跳与 popup 的标记写入都带上自己读到的版本，只有版本未变才允许写，
   * 避免用旧整份记录覆盖更新的进度或终态。
   */
  revision: number;
  startedAt: number;
  updatedAt: number;
}

/**
 * 独立的心跳键。
 *
 * 为什么不放在任务记录里：心跳与进度是两条并发写路径，放在同一份记录里就必然出现
 * 「心跳读到 running → runner 写入 completed → 迟到心跳把旧副本写回」的回退。
 * 拆成独立键后心跳只能写自己那份，物理上无法覆盖任务状态。
 */
export interface OneDayRepairHeartbeat {
  taskId: string;
  at: number;
}

/**
 * 独立的「结果已应用」标记键。
 *
 * 为什么不让 popup 写回任务记录：popup 手里的是它读到的那份快照，整对象回写会覆盖
 * 后台在此期间写入的内容。标记单独存，后台权威记录不被 popup 触碰。
 */
export interface OneDayRepairAppliedMarker {
  taskId: string;
  at: number;
}

/**
 * popup → background 的短启动请求。
 * 商品快照与归属锚先写入 storage，再发一条不含大负载的消息，和既有 `_enableParams` + `START_ENABLE` 一致。
 * 刻意不带 Cookie/SPC_CDS：后台自己从 Cookie 读，避免凭据副本落进 storage。
 */
export interface OneDayRepairRequest {
  requestId: string;
  taskId: string;
  source: OneDayRepairTask['source'];
  shopId: number | null;
  ownerUserId: number | null;
  products: ShopeeProduct[];
  createdAt: number;
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
  user: { id: number; email: string; role: string; autoModeEnabled: number; trialUsed: number; trialEnabled: number } | null;
  backendUrl: string;
}

export interface BackendAnalyticsSummary {
  summary: Record<string, number>;
  total: number;
}

