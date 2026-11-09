import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const { PORT = '8787', WEB_PORT = '5173' } = loadEnv(mode, process.cwd(), ['PORT', 'WEB_PORT'])
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: Number(process.env.WEB_PORT || WEB_PORT),
      strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${process.env.PORT || PORT}` },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/three/')) return 'three'
          },
        },
      },
    },
  }
})
