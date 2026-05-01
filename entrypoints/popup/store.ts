import { create } from 'zustand';
import type { ShopeeProduct } from './types';

interface AppState {
  // SPC_CDS 状态
  spcCds: string;
  spcCdsVer: string;
  isConnected: boolean;
  isExtracting: boolean;

  // 商品列表状态
  productIds: string[];
  products: ShopeeProduct[];
  isLoading: boolean;
  error: string | null;

  // 输入状态
  inputText: string;

  // Actions
  setSpcCds: (spcCds: string, spcCdsVer: string) => void;
  setConnected: (connected: boolean) => void;
  setExtracting: (extracting: boolean) => void;
  setInputText: (text: string) => void;
  setProductIds: (ids: string[]) => void;
  setProducts: (products: ShopeeProduct[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  extractSpcCds: () => Promise<void>;
  fetchProducts: () => Promise<void>;
  reset: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  spcCds: '',
  spcCdsVer: '2',
  isConnected: false,
  isExtracting: false,
  productIds: [],
  products: [],
  isLoading: false,
  error: null,
  inputText: '',

  setSpcCds: (spcCds, spcCdsVer) => set({ spcCds, spcCdsVer }),
  setConnected: (isConnected) => set({ isConnected }),
  setExtracting: (isExtracting) => set({ isExtracting }),
  setInputText: (inputText) => set({ inputText }),
  setProductIds: (productIds) => set({ productIds }),
  setProducts: (products) => set({ products }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

  extractSpcCds: async () => {
    set({ isExtracting: true, error: null });
    try {
      const response = await browser.runtime.sendMessage({ type: 'SPC_CDS_REQUEST' });
      if (response?.spcCds) {
        set({
          spcCds: response.spcCds,
          spcCdsVer: response.spcCdsVer || '2',
          isConnected: true,
          isExtracting: false,
        });
      } else {
        set({
          error: '无法获取 SPC_CDS，请确保已在虾皮卖家中心登录',
          isExtracting: false,
          isConnected: false,
        });
      }
    } catch (e) {
      set({
        error: `SPC_CDS 提取失败: ${e}`,
        isExtracting: false,
        isConnected: false,
      });
    }
  },

  fetchProducts: async () => {
    const { productIds, spcCds } = get();
    if (!spcCds) {
      set({ error: '请先提取 SPC_CDS' });
      return;
    }
    if (productIds.length === 0) {
      set({ error: '请先输入商品 ID' });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const response = await browser.runtime.sendMessage({
        type: 'FETCH_PRODUCTS',
        productIds,
      });
      if (response.type === 'FETCH_PRODUCTS_RESULT') {
        set({ products: response.products, isLoading: false });
      } else {
        set({ error: response.error, isLoading: false });
      }
    } catch (e) {
      set({ error: `请求失败: ${e}`, isLoading: false });
    }
  },

  reset: () => set({
    spcCds: '',
    spcCdsVer: '2',
    isConnected: false,
    productIds: [],
    products: [],
    isLoading: false,
    error: null,
    inputText: '',
  }),
}));
