import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { publishEdits } from './scripts/vite-publish.mjs';

export default defineConfig({
  plugins: [react(), publishEdits()],
  server: {
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // Основное приложение и мастерская моделей домов (/houses.html).
      input: { main: 'index.html', houses: 'houses.html' },
    },
  },
});
