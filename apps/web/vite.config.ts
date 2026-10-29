import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // Same-origin in dev so the HttpOnly session cookie works without CORS.
    proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:4000' },
  },
});
