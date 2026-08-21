import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5188,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4620',
        changeOrigin: false,
      },
    },
  },
});
