/**
 * 玩家档案 HTTP 接口
 * ==================================================================
 * 和房间服务同端口，走 `/api/*`：
 *
 *   GET  /api/health                  服务器与玩家数据库健康状况（只读）
 *   GET  /api/profile?id=<玩家ID>      读一个档案（不存在返回 profile:null）
 *   PUT  /api/profile                 写昵称 / 头像 / AI 偏好 / 偏好题材（其余字段一律忽略）
 *
 * 几条硬规则：
 *   - **只认 JSON**，请求体有上限（`PROFILE_LIMITS.bodyBytes`），超了 413；
 *   - **按 IP 限流**，防止有人拿它当免费存储刷；
 *   - **API 密钥永不接收**：客户端就算发了 `ai.apiKey` 也会被丢弃，并回报一条 warning；
 *   - **战绩不在这里改**：胜负由服务器在复盘时自己结算（见 store.recordGame），
 *     客户端上报的胜负一律不采信；
 *   - 响应一律 `no-store`，不缓存。
 *
 * 处理不了（不是 `/api/*`）就返回 false，交回静态文件处理器。
 */

import type http from 'node:http'
import path from 'node:path'
import { PROFILE_LIMITS, normalizePlayerId, type PlayerProfile, type ProfileStore } from './store'

export interface ApiDeps {
  store: ProfileStore
  /** 对外协议版本号，健康检查里回显（默认 2） */
  version?: number
  /** 进程启动时间，用于 uptime */
  startedAt?: number
  now?: () => number
  /** 限流窗口（默认 10 秒内最多 120 次 / 每 IP） */
  limit?: { windowMs: number; max: number }
  /** 安静模式（测试用） */
  quiet?: boolean
}

interface Bucket {
  count: number
  resetAt: number
}

const JSON_TYPE = 'application/json; charset=utf-8'

/**
 * 跨域头。
 * 为什么需要：`pnpm dev` 时页面在 5273、房间服务器在 5274，属于**不同的 origin**，
 * 没有这几个头浏览器会直接把 PUT 拦掉（自检脚本和本地开发都会踩）。
 * 这里没有任何 cookie / 凭据，玩家 ID 只在请求体或 query 里，所以用 `*` 是安全的。
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
} as const

function reply(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': JSON_TYPE,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(payload)
}

/** 玩家档案对外的形状（和内部一致，但这里显式列一遍，防止哪天内部字段被顺手带出去） */
function publicProfile(p: PlayerProfile): PlayerProfile {
  return p
}

/**
 * 读请求体并做长度限制。
 * 超限时**先把剩下的字节读完再回 413**：直接 destroy 会让客户端收到 ECONNRESET，
 * 拿不到那条 413（第一版就是这么写的，自检当场抓到 socket hang up）。
 */
function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(Object.assign(new Error('too-large'), { code: 'too-large' }))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    let draining = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      fn()
    }
    /** 超限之后把剩余字节丢弃（有界），让连接能正常收尾、客户端能读到 413 */
    const drain = (): void => {
      draining = true
      let extra = 0
      req.removeAllListeners('data')
      req.on('data', (chunk: Buffer) => {
        extra += chunk.length
        if (extra > maxBytes * 8) req.destroy()
      })
      req.resume()
    }
    req.on('data', (chunk: Buffer) => {
      if (draining) return
      size += chunk.length
      if (size > maxBytes) {
        drain()
        finish(() => reject(Object.assign(new Error('too-large'), { code: 'too-large' })))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', (e) => finish(() => reject(e)))
  })
}

export function createApiHandler(deps: ApiDeps): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  const store = deps.store
  const now = deps.now ?? (() => Date.now())
  const startedAt = deps.startedAt ?? now()
  const version = deps.version ?? 2
  const windowMs = Math.max(1000, deps.limit?.windowMs ?? 10_000)
  const maxPerWindow = Math.max(1, deps.limit?.max ?? 120)
  const buckets = new Map<string, Bucket>()

  function clientIp(req: http.IncomingMessage): string {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    return forwarded || req.socket.remoteAddress || 'unknown'
  }

  /** 简单窗口限流；窗口过了自动重置 */
  function rateLimited(req: http.IncomingMessage): boolean {
    const ip = clientIp(req)
    const at = now()
    const bucket = buckets.get(ip)
    if (!bucket || at >= bucket.resetAt) {
      buckets.set(ip, { count: 1, resetAt: at + windowMs })
      // 顺手清理过期桶，避免 Map 无限增长
      if (buckets.size > 2048) {
        for (const [key, value] of buckets) if (at >= value.resetAt) buckets.delete(key)
      }
      return false
    }
    bucket.count += 1
    return bucket.count > maxPerWindow
  }

  return (req, res): boolean => {
    const rawUrl = req.url ?? ''
    if (!rawUrl.startsWith('/api/')) return false

    const url = new URL(rawUrl, 'http://internal')
    const route = url.pathname.replace(/\/+$/, '')
    const method = (req.method ?? 'GET').toUpperCase()

    // 跨域预检：直接放行（不占限流额度，否则一个正常的 PUT 会被自己的预检吃掉次数）
    if (method === 'OPTIONS') {
      res.writeHead(204, { ...CORS_HEADERS, 'Content-Length': '0' })
      res.end()
      return true
    }

    if (rateLimited(req)) {
      reply(res, 429, { error: 'too-many-requests', message: '请求太频繁了，缓一下再来' }, { 'Retry-After': String(Math.ceil(windowMs / 1000)) })
      return true
    }

    // ---------------- 健康检查 ----------------
    if (route === '/api/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        reply(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, HEAD' })
        return true
      }
      const snapshot = store.statsSnapshot()
      reply(res, 200, {
        ok: true,
        version,
        // —— 前四个是老字段，自检脚本与运维面板都在用，保持不变 ——
        profileCount: snapshot.profileCount,
        fileBytes: snapshot.fileBytes,
        writes: snapshot.writes,
        // —— 数据库信息：一眼能看出用的是 SQLite、结构版本、对局数与完整性 ——
        db: {
          engine: snapshot.engine,
          file: path.basename(snapshot.filePath),
          schemaVersion: snapshot.schemaVersion,
          games: snapshot.games,
          backupBytes: snapshot.backupBytes,
          integrity: snapshot.integrity.ok ? 'ok' : 'issues',
        },
        integrity: {
          ok: snapshot.integrity.ok,
          checkedAt: snapshot.integrity.checkedAt,
          foreignKeyIssues: snapshot.integrity.foreignKeyIssues,
          statMismatches: snapshot.integrity.statMismatches.length,
          issues: snapshot.integrity.issues,
        },
        uptimeMs: now() - startedAt,
        now: now(),
      })
      return true
    }

    // ---------------- 读档案 ----------------
    if (route === '/api/profile' && (method === 'GET' || method === 'HEAD')) {
      const id = normalizePlayerId(url.searchParams.get('id'))
      if (!id) {
        reply(res, 400, { error: 'bad-id', message: '玩家 ID 不合法（8-40 位字母/数字/-/_）' })
        return true
      }
      const profile = store.get(id)
      reply(res, 200, { profile: profile ? publicProfile(profile) : null })
      return true
    }

    // ---------------- 写档案 ----------------
    if (route === '/api/profile' && method === 'PUT') {
      void handlePut(req, res)
      return true
    }

    if (route === '/api/profile') {
      reply(res, 405, { error: 'method-not-allowed' }, { Allow: 'GET, HEAD, PUT' })
      return true
    }

    reply(res, 404, { error: 'unknown-api', message: `没有这个接口：${route}` })
    return true

    async function handlePut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
      let raw = ''
      try {
        raw = await readBody(req, PROFILE_LIMITS.bodyBytes)
      } catch (e) {
        if ((e as { code?: string }).code === 'too-large') {
          reply(res, 413, { error: 'body-too-large', message: `请求体超过 ${PROFILE_LIMITS.bodyBytes} 字节` })
          return
        }
        reply(res, 400, { error: 'bad-body', message: '读取请求体失败' })
        return
      }
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw || '{}') as Record<string, unknown>
      } catch {
        reply(res, 400, { error: 'bad-json', message: '请求体不是合法 JSON' })
        return
      }
      if (!body || typeof body !== 'object') {
        reply(res, 400, { error: 'bad-json', message: '请求体必须是 JSON 对象' })
        return
      }
      const id = normalizePlayerId(body.id)
      if (!id) {
        reply(res, 400, { error: 'bad-id', message: '玩家 ID 不合法（8-40 位字母/数字/-/_）' })
        return
      }
      const warnings: string[] = []
      // 客户端把整个 ai 配置发上来的话，密钥字段必须被摘掉
      let ai: unknown
      if (body.ai !== undefined) {
        const obj = (body.ai && typeof body.ai === 'object' ? { ...(body.ai as Record<string, unknown>) } : {}) as Record<string, unknown>
        if (Object.prototype.hasOwnProperty.call(obj, 'apiKey')) {
          warnings.push('API 密钥不会被服务器保存，请只留在本机浏览器')
          delete obj.apiKey
        }
        ai = obj
      }
      const profile = store.upsert({ id, name: body.name, avatar: body.avatar, ai, genres: body.genres })
      if (!profile) {
        reply(res, 400, { error: 'bad-id', message: '玩家 ID 不合法' })
        return
      }
      reply(res, 200, { profile: publicProfile(profile), warnings })
    }
  }
}