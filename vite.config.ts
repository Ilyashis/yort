import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // Cesium — большой пакет; предупреждение о размере чанка здесь ожидаемо.
    chunkSizeWarningLimit: 6000,
  },
});
