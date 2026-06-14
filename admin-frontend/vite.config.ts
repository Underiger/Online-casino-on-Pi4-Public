import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 管理後台 SPA（04_FOLDER_STRUCTURE §3）：構建產物部署於 /admin 路徑（Nginx 另設 location）
export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
