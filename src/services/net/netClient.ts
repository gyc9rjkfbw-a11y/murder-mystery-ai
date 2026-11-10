/**
 * 房间服务器的浏览器客户端（网络层）
 * ------------------------------------------------------------------
 * 只做三件事：连接、发消息、把收到的消息交给 `stores/net.ts`。
 * 不碰任何游戏逻辑 —— 状态投影统一在 `stores/net.ts` + `stores/game.ts` 里做。
 *
 * 服务器地址推导规则：
 *   1. 有 `VITE_WS_URL` 就用它；
 *   2. **页面是 https 时**：用页面自己的 host（`wss://<host>`，端口保持不变）。
 *      这一条同时覆盖两种情况 ——
 *        · 服务器自己开了 TLS：`https://10.0.0.5:5274/` → `wss://10.0.0.5:5274`；
 *        · 页面挂在隧道后面（Cloudflare 等，443 端口、域名与 LAN IP 无关）：
 *          `https://xxx.trycloudflare.com/` → `wss://xxx.trycloudflare.com`
 *          （隧道会把这个 wss 转发回本机 5274）。**不能写成 hostname:5274**，那样隧道域名根本连不上。
 *   3. 其余情况（http）：`ws://<hostname>:5274` ——
 *      手机用 http://10.x.x.x:5274/ 打开时，WS 指向同一台机器；
 *      开发时用 5273 打开，WS 走 5274，同样是对的。
 *
 * 为什么要在意 https：浏览器的安全上下文策略规定，只有 https / localhost
 * 才允许调麦克风。实时语音必须在安全上下文里才能工作，所以服务器要能以
 * https/wss 对外服务（见 README「语音通话」一节）。
 */

import { NET_PORT, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from './protocol'

export type NetStatus = 'idle' | 'connecting' | 'open' | 'closed'

export interface NetHooks {
  onMessage: (msg: ServerMsg) => void
  onStatus: (status: NetStatus, detail: string) => void
}

/** 推导房间服务器地址 */
export function defaultWsUrl(): string {
  const env = import.meta.env.VITE_WS_URL as string | undefined
  if (env) return env
  if (location.protocol === 'https:') return `wss://${location.host}`
  return `ws://${location.hostname}:${NET_PORT}`
}

/**
 * 当前页面能不能用麦克风（实时语音的前提）。
 * `navigator.mediaDevices` 在非安全上下文里**根本不存在**，
 * 所以用它来判断比判断 `isSecureContext` 更贴近真实可用性。
 */
export function micSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  )
}

/** 页面是不是安全上下文（https / localhost），用于给用户解释「为什么开不了麦」 */
export function isSecure(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext !== false
}

/** 调试开关：localStorage.dsh_net_debug = '1'（手机上不好开控制台，默认静默） */
function debugOn(): boolean {
  try {
    return localStorage.getItem('dsh_net_debug') === '1'
  } catch {
    return false
  }
}

export class NetClient {
  readonly url: string
  status: NetStatus = 'idle'
  /** 最近一次断开的原因（展示给用户） */
  lastError = ''

  private ws: WebSocket | null = null
  private retryTimer = 0
  private attempts = 0
  private wantOpen = false
  private debug = debugOn()

  constructor(private hooks: NetHooks, url = defaultWsUrl()) {
    this.url = url
  }

  get isOpen(): boolean {
    return this.status === 'open' && this.ws?.readyState === WebSocket.OPEN
  }

  connect() {
    if (this.ws && (this.status === 'open' || this.status === 'connecting')) return
    this.wantOpen = true
    this.setStatus('connecting', '正在连接房间服务器…')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      this.setStatus('closed', `无法连接房间服务器：${(e as Error).message}`)
      this.scheduleRetry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempts = 0
      this.lastError = ''
      this.setStatus('open', '已连接')
      this.log('open', this.url)
    }

    ws.onmessage = (ev) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg
      } catch {
        this.log('bad-frame', String(ev.data).slice(0, 120))
        return
      }
      this.log('<<', msg.t)
      this.hooks.onMessage(msg)
    }

    ws.onclose = (ev) => {
      this.ws = null
      if (!this.wantOpen) {
        this.setStatus('idle', '已断开')
        return
      }
      this.lastError = ev.reason || '与服务器的连接断开了'
      this.setStatus('closed', this.lastError)
      this.scheduleRetry()
    }

    ws.onerror = () => {
      // 具体原因由 onclose 给出（浏览器不允许读 error 详情）
      this.log('error', this.url)
    }
  }

  /** 主动断开（离开房间），不再自动重连 */
  close() {
    this.wantOpen = false
    if (this.retryTimer) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = 0
    }
    this.attempts = 0
    this.ws?.close()
    this.ws = null
    this.setStatus('idle', '已断开')
  }

  /** 发送一条命令；未连接时返回 false（由 store 决定要不要暂存） */
  send(msg: ClientMsg): boolean {
    if (!this.isOpen) return false
    this.log('>>', msg.t)
    this.ws!.send(JSON.stringify(msg))
    return true
  }

  /** 心跳：顺便让服务器把时间戳带回来（用于校正倒计时） */
  ping() {
    this.send({ t: 'ping', at: Date.now() })
  }

  private scheduleRetry() {
    if (!this.wantOpen || this.retryTimer) return
    const delay = Math.min(500 * 2 ** this.attempts, 5000)
    this.attempts += 1
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0
      this.connect()
    }, delay)
  }

  private setStatus(s: NetStatus, detail: string) {
    this.status = s
    this.hooks.onStatus(s, detail)
  }

  private log(kind: string, extra: string) {
    if (this.debug) console.debug(`[net] ${kind} ${extra}`)
  }
}

export { PROTOCOL_VERSION }