import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 玩家端 SPA（04_FOLDER_STRUCTURE §2）：開發代理 /api 與 /socket.io 到後端 :3000
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
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
