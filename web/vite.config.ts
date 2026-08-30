import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The dashboard talks to the API through this proxy, so there is no CORS setup.
      '/api': {
        target: process.env['VITE_API_TARGET'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
