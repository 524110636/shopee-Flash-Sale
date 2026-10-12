import { http, HttpResponse } from 'msw';
import products from '../fixtures/products.json';
import flashSales from '../fixtures/flash-sales.json';

export const handlers = [
  http.post('https://seller.shopee.tw/api/marketing/v4/graphql/query/', () => {
    return HttpResponse.json({
      data: {
        products: {
          items: [products.validProduct, products.multipleSkusProduct]
        }
      }
    });
  }),

  http.post('https://seller.shopee.tw/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_list', () => {
    return HttpResponse.json({
      code: 0,
      message: 'success',
      user_message: '',
      data: {
        flash_sale_list: [
          flashSales.activeSale,
          flashSales.upcomingSale,
          flashSales.endedSale
        ]
      }
    });
  }),

  http.post('https://seller.shopee.tw/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_item_id_list', ({ request: _request }) => {
    return HttpResponse.json({
      code: 0,
      message: 'success',
      user_message: '',
      data: {
        item_ids: [123456789, 456789012]
      }
    });
  }),

  http.post('https://seller.shopee.tw/api/marketing/v4/shop_flash_sale/get_shop_flash_sale_item', ({ request: _request }) => {
    return HttpResponse.json({
      code: 0,
      message: 'success',
      user_message: '',
      data: {
        items: [
          { item_id: 123456789, model_id: 1, stock: 50, purchase_limit: 5, promotion_price: 60 },
          { item_id: 123456789, model_id: 2, stock: 50, purchase_limit: 5, promotion_price: 72 },
          { item_id: 456789012, model_id: 1, stock: 80, purchase_limit: 5, promotion_price: 30 },
          { item_id: 456789012, model_id: 2, stock: 80, purchase_limit: 5, promotion_price: 30 },
          { item_id: 456789012, model_id: 3, stock: 70, purchase_limit: 5, promotion_price: 30 }
        ],
        model_info_str: JSON.stringify({
          '123456789': [
            { modelid: '1', price: 100 },
            { modelid: '2', price: 120 }
          ],
          '456789012': [
            { modelid: '1', price: 50 },
            { modelid: '2', price: 50 },
            { modelid: '3', price: 50 }
          ]
        })
      }
    });
  }),

  http.post('https://seller.shopee.tw/api/marketing/v4/shop_flash_sale/set_shop_flash_sale_items', () => {
    return HttpResponse.json({
      code: 0,
      message: 'success',
      user_message: '',
      data: [
        { item_id: 123456789, model_id: 1 },
        { item_id: 123456789, model_id: 2 },
        { item_id: 456789012, model_id: 1 },
        { item_id: 456789012, model_id: 2 },
        { item_id: 456789012, model_id: 3 }
      ]
    });
  }),

  http.post('https://seller.shopee.tw/api/marketing/v4/shop_flash_sale/set_shop_flash_sale', () => {
    const newSaleId = 100000 + Math.floor(Math.random() * 10000);
    return HttpResponse.json({
      code: 0,
      message: 'success',
      user_message: '',
      data: {
        flash_sale_id: newSaleId,
        time_slot_id: 12345
      }
    });
  }),

  http.post('https://seller.shopee.tw/api/marketing/v4/shop_flash_sale/get_time_slot_id', () => {
    const now = Math.floor(Date.now() / 1000);
    const slots = [];
    for (let i = 0; i < 5; i++) {
      slots.push({
        timeslot_id: 1000 + i,
        start_time: now + (i + 1) * 3600,
        end_time: now + (i + 1) * 3600 + 3600
      });
    }
    return HttpResponse.json({
      code: 0,
      message: 'success',
      user_message: '',
      data: {
        time_slot_list: slots
      }
    });
  }),

  http.post('https://seller.shopee.tw/api/marketing/v4/shop_flash_sale/close_flash_sale', () => {
    return HttpResponse.json({
      code: 0,
      message: 'success',
      user_message: ''
    });
  })
];
