import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
