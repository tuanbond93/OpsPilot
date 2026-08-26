import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    testTimeout: 600000,
    hookTimeout: 60000,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
