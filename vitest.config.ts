import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  include: ['tests/unit/**/*.test.ts'],
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
  testTimeout: 10000,
});
