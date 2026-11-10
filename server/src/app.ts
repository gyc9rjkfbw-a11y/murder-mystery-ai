/**
 * HTTP(S) + WebSocket 服务器
 * ------------------------------------------------------------------
 * 同一个端口同时提供：
 *   1. `dist/` 静态站点（手机打开 `http://<ip>:5274/` 直接玩）
 *   2. WebSocket 房间服务（升级请求由 ws 接管）
 *
 * 可选 HTTPS/WSS（见 tls.ts）：配了证书就走 https，手机才能在安全上下文里
 * 拿到麦克风权限（实时语音必需）；证书有问题只警告并**软着陆回 http**，
 * 绝不因此起不来。
 *
 * ⚠️ 所有下发都经 `Room.broadcastView()` → `censorSeat()`，
 *    这里绝不直接序列化房间内部状态。
 */

import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { NET_PORT, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@/services/net/protocol'
import { PRESET_THEMES } from '@/services/templates'
import { createApiHandler } from './api'
import { createLogger } from './log'
import { Room, sanitizeName, uniqueRoomCode } from './room'
import { createRequestHandler, distEntry, staticAvailable } from './static'
import { normalizePlayerId, ProfileStore, sanitizeAvatar } from './store'
import { loadTlsMaterial, materialToServerOptions, tlsFallbackWarning, tlsRequested, type TlsArgs } from './tls'
import type { RoomSeat } from './types'

export interface StartServerOptions {
  /** 监听端口；0 = 由系统分配（测试用） */
  port?: number
  /** 监听地址，默认 0.0.0.0（手机可访问） */
  host?: string
  /** 静态站点目录，默认项目根的 dist/ */
  distDir?: string
  /** 不打印启动横幅（测试用） */
  quiet?: boolean
  /**
   * 阶段时长压缩系数（默认 1，仅测试用）：
   * 把阅读/陈述/摸底/整理的时长按比例压到几秒，用于验证
   * 「phaseEndsAt 到时服务器自动推进」这条路径。
   */
  phaseScale?: number
  /**
   * HTTPS/WSS 证书来源（默认不传 = 纯 http，与以前完全一致）。
   * 一般由 index.ts 用 `parseTlsArgs(process.argv, process.env)` 传进来；
   * 直接传路径也支持（测试用）。
   */
  tls?: TlsArgs
  /**
   * 玩家档案落盘目录（默认 <项目根>/server/data）。
   * 传一个临时目录就能让测试之间互不污染。
   */
  dataDir?: string
  /** 档案库最多存多少份（默认 PROFILE_LIMITS.profiles = 5000） */
  maxProfiles?: number
}

export interface ServerHandle {
  port: number
  host: string
  /** 实际对外协议（证书配坏时会软着陆回 http） */
  protocol: 'http' | 'https'
  /** TLS 配置失败时的中文警告；空字符串 = 没出问题 */
  tlsWarning: string
  rooms: Map<string, Room>
  /** 玩家档案库（落盘在 dataDir/profiles.json） */
  profiles: ProfileStore
  server: http.Server | https.Server
  /** WebSocket 地址（https 下是 wss://） */
  wsUrl: string
  /** 网页地址（https 下是 https://） */
  httpUrl: string
  close(): Promise<void>
}

interface SocketCtx {
  code: string
  seatId: string
}

/** 从打包产物位置反推项目根目录（server/dist/server.mjs → 项目根） */
function findProjectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(here, '..', '..'),
    path.resolve(here, '..'),
    process.cwd(),
  ]
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
  }
  return process.cwd()
}

/** 列出局域网 IPv4 地址，方便手机访问 */
export function lanAddresses(): string[] {
  const out: string[] = []
  const interfaces = os.networkInterfaces()
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address)
    }
  }
  return out
}

export async function startServer(options: StartServerOptions = {}): Promise<ServerHandle> {
  const port = options.port ?? Number(process.env.PORT ?? NET_PORT)
  const host = options.host ?? '0.0.0.0'
  const quiet = options.quiet === true
  const log = createLogger(!quiet, '房间服务')
  const distDir = path.resolve(options.distDir ?? path.join(findProjectRoot(), 'dist'))

  const rooms = new Map<string, Room>()
  const contexts = new Map<WebSocket, SocketCtx>()

  // ---- 可选的 HTTPS/WSS：任何一步失败都退回 http，绝不因此起不来 ----
  let protocol: 'http' | 'https' = 'http'
  let serverOptions: https.ServerOptions | null = null
  let tlsWarning = ''
  if (tlsRequested(options.tls)) {
    const loaded = loadTlsMaterial(options.tls as TlsArgs)
    if (!loaded.ok) {
      tlsWarning = loaded.reason
    } else {
      const candidate = materialToServerOptions(loaded.material)
      try {
        // 先单独建一次安全上下文：口令错 / 证书损坏会在这里当场抛，
        // 这样我们能在**开始监听之前**确定地软着陆回 http。
        tls.createSecureContext(candidate)
        serverOptions = candidate
        protocol = 'https'
      } catch (e) {
        tlsWarning = `证书无法使用（口令错误或文件损坏）：${String((e as Error).message ?? e)}`
        serverOptions = null
      }
    }
  }
  if (tlsWarning) {
    // 警告既打到终端（醒目），也留在 handle 上供调用方 / 测试断言
    tlsWarning = tlsFallbackWarning(tlsWarning).join('\n')
    log(tlsWarning)
  }

  const siteReady = staticAvailable(distDir)
  // ---- 玩家档案库：纯 JSON 落盘，服务器重启后昵称/头像/战绩都还在 ----
  const dataDir = options.dataDir ?? path.join(findProjectRoot(), 'server', 'data')
  const profiles = new ProfileStore({
    dir: dataDir,
    maxProfiles: options.maxProfiles,
    quiet,
  })
  // 静态页里的「用哪个地址打开」文案要跟实际协议一致（http / https）
  const staticHandler = createRequestHandler(distDir, siteReady, protocol === 'https')
  // /api/* 先交给档案接口，其余照旧走静态文件
  const apiHandler = createApiHandler({
    store: profiles,
    version: PROTOCOL_VERSION,
    quiet,
  })
  const requestHandler: http.RequestListener = (req, res) => {
    if (apiHandler(req, res)) return
    staticHandler(req, res)
  }
  const httpServer =
    protocol === 'https' && serverOptions
      ? https.createServer(serverOptions, requestHandler)
      : http.createServer(requestHandler)
  const wss = new WebSocketServer({ server: httpServer })

  const send = (socket: WebSocket, msg: ServerMsg): void => {
    if (socket.readyState !== 1) return
    socket.send(JSON.stringify(msg))
  }
  const fail = (socket: WebSocket, message: string, code?: string): void => {
    send(socket, { t: 'error', message, code })
  }
  const roomOf = (socket: WebSocket): { room: Room; seat: RoomSeat } | null => {
    const ctx = contexts.get(socket)
    if (!ctx) return null
    const room = rooms.get(ctx.code)
    if (!room) return null
    const seat = room.seatById(ctx.seatId)
    if (!seat) return null
    return { room, seat }
  }

  /**
   * 记住这个座位的玩家档案：昵称 / 头像落进档案库，「最近上线」刷新。
   * 没有档案就顺手建一个 —— 这样「只玩了一局」的人也有战绩可查。
   */
  const rememberPlayer = (playerId: string, seat: RoomSeat): void => {
    if (!playerId) return
    if (profiles.get(playerId)) profiles.touch({ id: playerId, name: seat.name, avatar: seat.avatar })
    else profiles.upsert({ id: playerId, name: seat.name, avatar: seat.avatar })
  }

  wss.on('connection', (socket: WebSocket) => {
    socket.on('error', () => {
      /* 连接层错误按掉线处理即可 */
    })

    socket.on('close', () => {
      const ctx = contexts.get(socket)
      contexts.delete(socket)
      if (!ctx) return
      const room = rooms.get(ctx.code)
      const seat = room?.seatById(ctx.seatId)
      if (!room || !seat) return
      // 座位已经被新连接接管时，旧连接的关闭事件必须忽略
      if (seat.socket && seat.socket !== socket) return
      room.log(`掉线：${seat.name} 连接断开（座位仍保留，可用 token 重连）`)
      room.markDisconnected(seat)
      room.toastAll(`${seat.name} 掉线了`, 'warn')
      room.broadcastView()
    })

    socket.on('message', (raw: unknown) => {
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(raw)) as ClientMsg
      } catch {
        fail(socket, '收到的消息不是合法 JSON', 'bad-json')
        return
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
        fail(socket, '消息缺少 t 字段', 'bad-msg')
        return
      }

      switch (msg.t) {
        case 'ping':
          send(socket, { t: 'pong', at: Number(msg.at) || 0, serverAt: Date.now() })
          return

        case 'create': {
          if (contexts.has(socket)) {
            fail(socket, '你已经在房间里了，先离开再建房', 'already-in-room')
            return
          }
          if (Number(msg.proto) !== PROTOCOL_VERSION) {
            fail(socket, `协议版本不一致（客户端 ${msg.proto} / 服务器 ${PROTOCOL_VERSION}），请刷新页面`, 'proto')
            return
          }
          const playerCount = Number(msg.playerCount)
          if (![4, 5, 6].includes(playerCount)) {
            fail(socket, `人数只能是 4 / 5 / 6，收到 ${String(msg.playerCount)}`, 'bad-player-count')
            return
          }
          const theme = String(msg.theme ?? '').trim() || PRESET_THEMES[0].theme
          const code = uniqueRoomCode(rooms)
          const logger = createLogger(!quiet, `房间 ${code}`)
          const room = new Room({
            code,
            playerCount,
            theme,
            logger,
            phaseScale: options.phaseScale,
            // 复盘结算 → 给每个有档案的真人记一局战绩（服务器权威，客户端说了不算）
            onGameSettled: (rows) => {
              for (const row of rows) {
                profiles.recordGame(row.playerId, {
                  at: Date.now(),
                  roomCode: code,
                  theme,
                  playerCount,
                  result: row.win ? 'win' : 'lose',
                  role: row.role,
                  isMurderer: row.isMurderer,
                })
              }
              logger(
                `战绩入档：${rows.map((r) => `${r.name}（${r.isMurderer ? '凶手' : '平民'}·${r.win ? '胜' : '负'}）`).join('、')}`,
              )
            },
          })
          rooms.set(code, room)
          const playerId = normalizePlayerId(msg.playerId)
          const seat = room.addSeat({
            name: sanitizeName(msg.name, '房主'),
            isBot: false,
            connected: true,
            ready: false,
            host: true,
            playerId: playerId || null,
            avatar: sanitizeAvatar(msg.avatar, ''),
          })
          contexts.set(socket, { code, seatId: seat.seatId })
          room.attachSocket(seat, socket)
          rememberPlayer(playerId, seat)
          room.log(`建房：${seat.name} 创建了 ${playerCount} 人房间 ${code}（题材：${theme}）`)
          send(socket, {
            t: 'welcome',
            seatId: seat.seatId,
            token: seat.token,
            roomCode: code,
            isHost: true,
          })
          room.sendViewTo(seat)
          return
        }

        case 'join': {
          if (contexts.has(socket)) {
            fail(socket, '你已经在房间里了', 'already-in-room')
            return
          }
          if (Number(msg.proto) !== PROTOCOL_VERSION) {
            fail(socket, `协议版本不一致（客户端 ${msg.proto} / 服务器 ${PROTOCOL_VERSION}），请刷新页面`, 'proto')
            return
          }
          const code = String(msg.roomCode ?? '').trim().toUpperCase()
          const room = rooms.get(code)
          if (!room) {
            fail(socket, `没有找到房间「${code}」，请确认房号是否正确`, 'room-not-found')
            return
          }
          if (room.started) {
            fail(socket, '该房间已经开局，无法中途加入（可以等下一局）', 'game-started')
            return
          }
          if (room.full()) {
            fail(socket, `房间已满（${room.playerCount} 人）`, 'room-full')
            return
          }
          const playerId = normalizePlayerId(msg.playerId)
          const seat = room.addSeat({
            name: sanitizeName(msg.name, `玩家${room.seats.length + 1}`),
            isBot: false,
            connected: true,
            ready: false,
            host: false,
            playerId: playerId || null,
            avatar: sanitizeAvatar(msg.avatar, ''),
          })
          contexts.set(socket, { code, seatId: seat.seatId })
          room.attachSocket(seat, socket)
          rememberPlayer(playerId, seat)
          room.log(
            `加入：${seat.name} 加入了房间 ${code}（${room.seats.length}/${room.playerCount} 人）`,
          )
          send(socket, {
            t: 'welcome',
            seatId: seat.seatId,
            token: seat.token,
            roomCode: code,
            isHost: false,
          })
          room.sendViewTo(seat)
          room.toastAll(`${seat.name} 加入了房间`, 'good')
          room.broadcastView()
          return
        }

        case 'rejoin': {
          if (contexts.has(socket)) {
            fail(socket, '你已经在房间里了', 'already-in-room')
            return
          }
          if (Number(msg.proto) !== PROTOCOL_VERSION) {
            fail(socket, `协议版本不一致（客户端 ${msg.proto} / 服务器 ${PROTOCOL_VERSION}），请刷新页面`, 'proto')
            return
          }
          const code = String(msg.roomCode ?? '').trim().toUpperCase()
          const room = rooms.get(code)
          if (!room) {
            fail(socket, `没有找到房间「${code}」，重连失败`, 'room-not-found')
            return
          }
          const seat = room.seatByToken(String(msg.token ?? ''))
          if (!seat) {
            fail(socket, '重连凭证无效，请重新加入房间', 'bad-token')
            return
          }
          const previous = seat.socket
          contexts.set(socket, { code, seatId: seat.seatId })
          room.attachSocket(seat, socket)
          // 重连也算「上线」，顺手把档案里的最近上线时间刷新一下
          if (seat.playerId) rememberPlayer(seat.playerId, seat)
          if (previous && previous !== socket) {
            try {
              previous.close(4001, '已被新的连接取代')
            } catch {
              /* 忽略 */
            }
          }
          room.log(`重连：${seat.name} 回到房间 ${code} 的座位 ${seat.seatId}，已补发当前视图`)
          send(socket, {
            t: 'welcome',
            seatId: seat.seatId,
            token: seat.token,
            roomCode: code,
            isHost: seat.seatId === room.hostSeatId,
          })
          room.sendViewTo(seat)
          room.toastAll(`${seat.name} 重新连接`, 'good')
          room.broadcastView()
          return
        }

        case 'leave': {
          const current = roomOf(socket)
          if (!current) {
            fail(socket, '你还没有加入任何房间', 'no-room')
            return
          }
          current.room.leaveSeat(current.seat)
          contexts.delete(socket)
          return
        }

        default: {
          const current = roomOf(socket)
          if (!current) {
            fail(socket, '请先建房或加入房间', 'no-room')
            return
          }
          current.room.handle(current.seat, msg)
        }
      }
    })
  })

  // 无人连接超过 10 分钟的空房间回收（避免内存与定时器泄漏）
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [code, room] of rooms) {
      const noHumans = room.connectedHumans().length === 0
      if (noHumans && now - room.lastActivity > 10 * 60_000) {
        room.dispose()
        rooms.delete(code)
        if (!quiet) console.log(`[房间服务] 回收空房间 ${code}（无人连接已 10 分钟）`)
      }
    }
  }, 60_000)
  sweeper.unref?.()

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  const actualPort = (httpServer.address() as AddressInfo).port
  const scheme = protocol === 'https' ? 'https' : 'http'
  const wsScheme = protocol === 'https' ? 'wss' : 'ws'

  if (!quiet) {
    const lines = [
      '======================================================',
      '🕯️  AI 剧本杀 · 真联机房间服务器已启动',
      `    监听地址：${host}:${actualPort}（网页与 WebSocket 同一端口）`,
      `    本机打开：${scheme}://127.0.0.1:${actualPort}/`,
    ]
    for (const ip of lanAddresses()) {
      lines.push(`    手机同 Wi-Fi 打开：${scheme}://${ip}:${actualPort}/  ← 用这个联机`)
    }
    if (protocol === 'https') {
      lines.push(`    🎙️ 已启用 HTTPS/WSS：手机用这个 https 地址打开才能开麦通话（自签证书需点「继续访问」）`)
    } else {
      lines.push('    🎙️ 现在是 http：手机无法开麦，只能打字；要开麦请配证书或走隧道（见 README）')
    }
    lines.push(
      siteReady
        ? `    静态站点：${distDir}（已找到 ${path.basename(distEntry(distDir))}）`
        : `    ⚠️ 没找到 ${distEntry(distDir)}，本端口暂时只提供 WebSocket；先在项目根执行 pnpm build 生成网页`,
    )
    lines.push('    提示：房主建房后把 5 位房号告诉朋友，朋友在同一地址「加入房间」即可')
    const snapshot = profiles.statsSnapshot()
    lines.push(
      `    📇 玩家档案：${dataDir}（${snapshot.profileCount} 份 · ${snapshot.fileBytes} 字节，重启后仍在）`,
    )
    lines.push('======================================================')
    console.log(lines.join('\n'))
  }

  return {
    port: actualPort,
    host,
    protocol,
    tlsWarning,
    rooms,
    profiles,
    server: httpServer,
    wsUrl: `${wsScheme}://127.0.0.1:${actualPort}/`,
    httpUrl: `${scheme}://127.0.0.1:${actualPort}/`,
    async close(): Promise<void> {
      clearInterval(sweeper)
      for (const room of rooms.values()) room.dispose()
      rooms.clear()
      // 关服前把档案刷盘，别让最后几秒的改动丢在内存里
      profiles.close()
      for (const client of wss.clients) {
        try {
          client.terminate()
        } catch {
          /* 忽略 */
        }
      }
      ;(httpServer as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      log('房间服务器已关闭')
    },
  }
}