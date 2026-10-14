import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  include: ['tests/unit/**/*.test.?(c|m)[jt]s?(x)'],
  resolve: {
    alias: {
      '@': resolve(__dirname, '.'),
    },
  },
  coverage: {
    reporter: ['text', 'html'],
    exclude: [
      'node_modules/',
      'dist/',
      '.output/',
      'harness/',
      'tests/',
    ],
  },
  // 弹窗策略宿主的用例在 jsdom 里跑真实组件（文件顶部有 @vitest-environment jsdom），
  // 其余用例保持 node 环境不引入额外开销。
  testTimeout: 10000,
});
