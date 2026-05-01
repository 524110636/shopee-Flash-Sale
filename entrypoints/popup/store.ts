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

      // background 返回了结构化错误
      if (response?.error) {
        set({
          error: response.error,
          isExtracting: false,
          isConnected: false,
        });
        return;
      }

      if (response?.spcCds) {
        set({
          spcCds: response.spcCds,
          spcCdsVer: response.spcCdsVer || '2',
          isConnected: true,
          isExtracting: false,
          error: null,
        });
      } else {
        set({
          error: '未能获取到 SPC_CDS（返回值为空），请确认已登录虾皮卖家中心',
          isExtracting: false,
          isConnected: false,
        });
      }
    } catch (e: any) {
      // runtime.sendMessage 失败（没有 background 监听等）
      const msg = e?.message || String(e);
      if (msg.includes('Could not establish connection')) {
        set({
          error: 'Background Service Worker 未响应，请重新加载扩展后重试',
          isExtracting: false,
          isConnected: false,
        });
      } else {
        set({
          error: `SPC_CDS 提取失败: ${msg}`,
          isExtracting: false,
          isConnected: false,
        });
      }
    }
  },

  fetchProducts: async () => {
    const { productIds, spcCds } = get();
    if (!spcCds) {
      set({ error: '请先点击右上角"未连接"获取 SPC_CDS' });
      return;
    }
    if (productIds.length === 0) {
      set({ error: '请先在输入框中粘贴商品 ID' });
      return;
    }

    set({ isLoading: true, error: null });
    try {
      const response = await browser.runtime.sendMessage({
        type: 'FETCH_PRODUCTS',
        productIds,
      });

      if (!response) {
        set({ error: '扩展未响应（返回为空），请重新加载扩展', isLoading: false });
        return;
      }

      if (response.type === 'FETCH_PRODUCTS_RESULT') {
        set({ products: response.products, isLoading: false, error: null });
      } else if (response.type === 'FETCH_PRODUCTS_ERROR') {
        set({ error: response.error || '请求失败（未知错误）', isLoading: false });
      } else {
        set({ error: `意外的响应类型: ${response.type}`, isLoading: false });
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes('Could not establish connection')) {
        set({ error: 'Background 未响应，请重新加载扩展后重试', isLoading: false });
      } else {
        set({ error: `请求失败: ${msg}`, isLoading: false });
      }
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
