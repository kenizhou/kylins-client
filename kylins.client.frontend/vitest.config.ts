import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  // Mirror the `@/` alias from vite.config.ts / tsconfig.json so tests resolve
  // `@/*` imports the same way the app build does. Without this, vitest (which
  // prefers vitest.config.ts over vite.config.ts) cannot resolve `@/` paths.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
