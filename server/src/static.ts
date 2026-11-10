/**
 * 静态站点托管（把前端 `dist/` 挂在同一个端口上）
 * ------------------------------------------------------------------
 * 手机只用一个地址 `http://<ip>:5274/` 就能同时打开页面 + 连 WS
 * （配了证书就是 `https://<ip>:5274/` + `wss://`，见 tls.ts）：
 *   · 普通 HTTP 请求走这里，读 `dist/`
 *   · WebSocket 升级请求由 `ws` 在 upgrade 事件里接管，两者互不干扰
 * 找不到 `dist/index.html` 时给出友好提示页，服务器继续只提供 WS。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  // PWA 清单：必须用 application/manifest+json，否则部分浏览器只当普通 JSON 下载
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.manifest': 'application/manifest+json; charset=utf-8',
}

/** 前端站点入口 */
export function distEntry(distDir: string): string {
  return path.join(distDir, 'index.html')
}

/** dist 是否可用（决定启动日志与请求行为） */
export function staticAvailable(distDir: string): boolean {
  return fs.existsSync(distEntry(distDir))
}

function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/** 找不到 dist 时的友好提示页（只提供 WS 也照样能用） */
function fallbackPage(secure: boolean): string {
  const scheme = secure ? 'https' : 'http'
  const wsScheme = secure ? 'wss' : 'ws'
  const mic = secure
    ? '<p>已启用 HTTPS/WSS：手机用同一个地址打开就能开麦通话。</p>'
    : '<p>⚠️ 现在是 http：手机浏览器不会给麦克风权限，<b>只能打字、不能开麦</b>；要开麦请配证书或走隧道（见 README）。</p>'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AI 剧本杀 · 房间服务器</title>
<style>
  body{margin:0;padding:32px 20px;background:#14110f;color:#f3ece5;
       font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  h1{font-size:20px;margin:0 0 16px}
  code{background:#2a2420;padding:2px 6px;border-radius:6px;color:#ffd9a0}
  .box{max-width:640px;margin:0 auto;background:#1d1917;border:1px solid #332c27;
       border-radius:14px;padding:24px}
  ol{padding-left:20px} li{margin:8px 0}
  .ok{color:#7ed957}
</style></head><body><div class="box">
<h1>🕯️ AI 剧本杀 · 房间服务器已启动</h1>
<p class="ok">WebSocket 服务正常：<code>${wsScheme}://本机地址:端口/</code></p>
<p>但没有找到前端网页（缺少 <code>dist/index.html</code>），所以这个地址暂时只提供联机服务。</p>
${mic}
<ol>
  <li>在项目根目录执行 <code>pnpm build</code>（或 <code>npm run build</code>）生成 <code>dist/</code>；</li>
  <li>刷新本页面，就会看到游戏界面；</li>
  <li>手机与电脑连同一个 Wi-Fi，用启动日志里打印的 <code>${scheme}://192.168.x.x:端口/</code> 打开即可。</li>
</ol>
<p>现在也可以直接用联机客户端连接本端口的 WebSocket 开一局。</p>
</div></body></html>`
}

function sendText(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.end(body)
}

/**
 * 生成 HTTP(S) 请求处理器。
 * 只处理 GET / HEAD，未知路径回落到 index.html（SPA 兜底）。
 *
 * @param secure 当前是不是 https：只影响提示页里「用哪个地址打开」的文案
 */
export function createRequestHandler(
  distDir: string,
  available: boolean,
  secure = false,
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = path.resolve(distDir)

  return (req, res) => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(res, 405, 'text/plain; charset=utf-8', '只支持 GET / HEAD')
      return
    }
    if (!available) {
      sendText(res, 200, 'text/html; charset=utf-8', fallbackPage(secure))
      return
    }

    let pathname = '/'
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      sendText(res, 400, 'text/plain; charset=utf-8', 'URL 无法解析')
      return
    }

    let target = path.resolve(root, `.${pathname}`)
    // 目录穿越防护：解析后的绝对路径必须仍在 dist 目录内
    if (target !== root && !target.startsWith(root + path.sep)) {
      sendText(res, 403, 'text/plain; charset=utf-8', '禁止访问')
      return
    }

    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, 'index.html')
      }
    } catch {
      /* 忽略，走下面的兜底 */
    }

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      // 带扩展名的资源找不到 → 404；其余（前端路由）回落到 index.html
      if (path.extname(pathname)) {
        sendText(res, 404, 'text/plain; charset=utf-8', `未找到资源：${pathname}`)
        return
      }
      target = distEntry(root)
    }

    try {
      const body = fs.readFileSync(target)
      const type = mimeOf(target)
      // sw.js / manifest 必须每次回源校验，否则装了桌面的人会长期停在旧版本；
      // 带内容 hash 的 /assets/* 反过来要长缓存
      const base = path.basename(target).toLowerCase()
      const noCache =
        type.startsWith('text/html') || base === 'sw.js' || base.endsWith('.webmanifest')
      res.statusCode = 200
      res.setHeader('Content-Type', type)
      res.setHeader('Content-Length', body.length)
      res.setHeader('Cache-Control', noCache ? 'no-cache' : 'public, max-age=3600')
      // SW 的作用域默认就是它所在目录，放在根目录即可覆盖整个站点
      if (base === 'sw.js') res.setHeader('Service-Worker-Allowed', '/')
      res.end(method === 'HEAD' ? undefined : body)
    } catch (e) {
      sendText(res, 500, 'text/plain; charset=utf-8', `读取文件失败：${String(e)}`)
    }
  }
}