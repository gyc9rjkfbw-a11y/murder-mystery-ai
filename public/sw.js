/**
 * 迷案 · AI 剧本杀 —— Service Worker（PWA：装到桌面 / 断网也能打开外壳）
 * ==================================================================
 * 目标很小，只做三件事，够用且不会给自己挖坑：
 *   1. 预缓存应用外壳（index.html / manifest / 图标），让「已安装」的 App 断网时也能打开；
 *   2. 导航请求**网络优先**（有新版本立刻生效，不会把旧页面焊死在缓存里）；
 *   3. 带 hash 的构建产物（/assets/*）缓存优先（文件名一变就是新资源，永远安全）。
 *
 * 明确不做的事：
 *   · 不碰 /api/*：玩家档案与战绩必须实时，缓存它等于让战绩看起来「没更新」；
 *   · 不碰 WebSocket：房间是实时对局，请求根本不会走 fetch 事件；
 *   · 不缓存任何一帧剧本 / 线索：那是每局临时下发的内容，落盘反而有泄密风险。
 *
 * 想强制换代：改下面的 VERSION，旧缓存会在 activate 时被清掉。
 */

const VERSION = 'mmai-shell-v2'
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION)
      // 逐个加：某个文件 404 也不至于让整个安装失败（addAll 是全或无）
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {
            /* 缺一个就算了，运行时还会补 */
          }),
        ),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const kept = new Set([VERSION])
      const names = await caches.keys()
      await Promise.all(names.map((n) => (kept.has(n) ? null : caches.delete(n))))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  let url
  try {
    url = new URL(req.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  if (url.pathname === '/sw.js') return

  // ---- 页面导航：网络优先，断网才回落到缓存的外壳 ----
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req)
          if (fresh && fresh.ok) {
            const cache = await caches.open(VERSION)
            cache.put('/', fresh.clone()).catch(() => {})
          }
          return fresh
        } catch {
          const cache = await caches.open(VERSION)
          const cached = (await cache.match('/')) || (await cache.match('/index.html'))
          return cached || Response.error()
        }
      })(),
    )
    return
  }

  // ---- 构建产物（带内容 hash）：缓存优先，命中就不用再问网络 ----
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(VERSION)
        const hit = await cache.match(req)
        if (hit) return hit
        const fresh = await fetch(req)
        if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {})
        return fresh
      })(),
    )
    return
  }

  // ---- 其它同源静态资源（图标 / manifest）：先给缓存，再后台更新 ----
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION)
      const hit = await cache.match(req)
      const network = fetch(req)
        .then((fresh) => {
          if (fresh && fresh.ok) cache.put(req, fresh.clone()).catch(() => {})
          return fresh
        })
        .catch(() => null)
      return hit || (await network) || Response.error()
    })(),
  )
})
