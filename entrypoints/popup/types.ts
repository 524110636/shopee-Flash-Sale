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
