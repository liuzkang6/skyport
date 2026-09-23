import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 开发态：/api 代理到本地 serve（127.0.0.1:7100），生产由 serve 直接托管 dist
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7100', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
