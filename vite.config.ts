import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

declare const process: { env: Record<string, string | undefined> }

const apiProxyTarget = process.env.OPC_API_PROXY_TARGET ?? 'http://127.0.0.1:8000'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '**/.tmp/**'],
    testTimeout: 30000,
  },
  // FastAPI serves public assets directly in production. Avoid recopying the
  // large model library into dist on every launcher run.
  publicDir: command === 'build' ? false : 'public',
  server: {
    port: 5173,
    proxy: {
      '/api': apiProxyTarget,
    },
  },
  build: {
    // The Three.js runtime is isolated behind lazy 3D routes and is not part of
    // the initial page download. Keep the warning threshold aligned with it.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.indexOf('node_modules') === -1) return undefined
          if (id.indexOf('lucide-react') !== -1) return 'icons'
          if (id.indexOf('/react/') !== -1 || id.indexOf('\\react\\') !== -1 || id.indexOf('react-dom') !== -1 || id.indexOf('scheduler') !== -1) return 'react'
          return undefined
        },
      },
    },
  },
}))
