import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    watch: {
      /**
       * 这些目录不参与前端热更新，但会被 chokidar 扫到：
       * `server/`（服务端源码与打包产物）、`.verify/`（自检脚本）、
       * `.tools/`（联调用的外部工具，比如几十 MB 的 cloudflared.exe）。
       * 踩过的坑：cloudflared.exe 下载到 `.tools/` 时被 watch 到，
       * Windows 上直接 `EBUSY: resource busy or locked` 把 dev server 打挂。
       */
      ignored: ['**/server/**', '**/.verify/**', '**/.tools/**', '**/dist/**'],
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
})