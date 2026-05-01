import type { ShopeeProduct, ProductsQueryResponse, ShopeeApiResponse } from './types';

const GRAPHQL_URL = 'https://seller.shopee.tw/api/marketing/v4/graphql/query/';

const PRODUCTS_QUERY = `query Products($productIds: [String], $statusType: Int) {
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
}`;

export interface FetchProductsOptions {
  spcCds: string;
  spcCdsVer: string;
  productIds: string[];
}

/**
 * 调用虾皮 GraphQL API 获取商品详情
 * 注意：此函数应在 content script 的页面上下文中执行（同源请求）
 * 不要在 background 或 popup 中直接调用
 */
export async function fetchProducts(options: FetchProductsOptions): Promise<ShopeeProduct[]> {
  const { spcCds, spcCdsVer, productIds } = options;

  const url = `${GRAPHQL_URL}?SPC_CDS=${spcCds}&SPC_CDS_VER=${spcCdsVer}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'content-type': 'application/json',
      'priority': 'u=1, i',
      'x-sz-sdk-version': '1.12.33-sc.3',
      'sc-fe-session': 'BFFB5DB1CB99D05E',
      'sc-fe-ver': '21.146220',
    },
    credentials: 'include',
    body: JSON.stringify({
      query: PRODUCTS_QUERY,
      variables: {
        productIds,
        statusType: 0,
      },
    }),
  });

  const data: ShopeeApiResponse<ProductsQueryResponse> = await response.json();

  if (data.code !== 0) {
    throw new Error(`API 错误: ${data.message} (code: ${data.code})`);
  }

  return data.data.products.items;
}
