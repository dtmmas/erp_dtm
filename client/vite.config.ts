import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const viteRoot = resolve(fileURLToPath(new URL('.', import.meta.url)))
const indexHtmlPath = resolve(viteRoot, 'index.html')

export default defineConfig({
  root: viteRoot,
  base: '/',
  publicDir: resolve(viteRoot, 'public'),
  clearScreen: false,
  plugins: [
    {
      name: 'resolve-spaced-root-index',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const rawUrl = req.url || '/'
          const url = rawUrl.split('?')[0]
          if (url !== '/' && url !== '/index.html') return next()

          try {
            const rawHtml = await readFile(indexHtmlPath, 'utf8')
            const transformed = await server.transformIndexHtml(url, rawHtml)
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(transformed)
            server.config.logger.info(`[root-index] served ${rawUrl} -> ${indexHtmlPath} (${Buffer.byteLength(transformed)} bytes)`)
          } catch (err) {
            server.config.logger.error(`[root-index] failed ${rawUrl}: ${(err as Error).message}`)
            next(err)
          }
        })
      },
    },
    {
      name: 'trace-requests',
      configureServer(server) {
        server.httpServer?.on('request', (req) => {
          server.config.logger.info(`[http] ${req.method} ${req.url}`)
        })
      },
    },
    react(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4003',
        changeOrigin: true
      },
      '/uploads': {
        target: 'http://localhost:4003',
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:4003',
        changeOrigin: true
      },
      '/uploads': {
        target: 'http://localhost:4003',
        changeOrigin: true
      }
    }
  }
})