import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

declare const process: { env: Record<string, string | undefined> }

const apiProxyTarget = process.env.OPC_API_PROXY_TARGET ?? 'http://127.0.0.1:8000'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // FastAPI serves public assets directly in production. Avoid recopying the
  // large model library into dist on every launcher run.
  publicDir: command === 'build' ? false : 'public',
  server: {
    port: 5173,
    proxy: {
      '/api': apiProxyTarget,
    },
  },
}))
