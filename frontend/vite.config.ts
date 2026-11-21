import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Demo config: wide open on purpose. No CORS/host checks, reachable on LAN.
// Anything under /api is proxied to a backend on :8000 (FastAPI / Express / whatever),
// so the browser always talks same-origin and CORS never matters.
const open = {
  host: true, // 0.0.0.0
  port: 5173,
  strictPort: true,
  cors: true,
  allowedHosts: true as const,
  proxy: {
    '/api': {
      target: 'http://localhost:8000',
      changeOrigin: true,
    },
  },
}

export default defineConfig({
  plugins: [react()],
  server: open,
  preview: { ...open, port: 4173 },
})
