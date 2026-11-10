/**
 * 实时通信层接入点（网络层）
 * ------------------------------------------------------------------
 * 《核心系统架构设计》要求：WebSocket 实现多人实时同步，
 * 玩家的发言、线索的获取、投票结果必须毫秒级同步到所有客户端。
 *
 * 前端这一版默认跑在「本地模拟」上（stores/game.ts 内部完成状态推进），
 * 本文件就是留给后端的 **唯一接入点**：
 *
 *   1. 后端按下面的 `RoomEvent` 契约推送事件；
 *   2. 把 `stores/game.ts` 中标注 `TODO(ws)` 的本地动作，
 *      改为 `socket.send({...})`，并在事件回调里调用对应的 store action；
 *   3. UI 与状态机无需任何改动。
 *
 * 协议（建议）：
 *   客户端 → 服务端  { type: 'ready' | 'statement' | 'search' | 'vote' | 'next-phase', ... }
 *   服务端 → 客户端  { type: 'room-state' | 'phase' | 'statement' | 'clue' | 'vote' | 'reveal', ... }
 */

import type { GamePhase, Seat, Statement, VoteRecord } from '@/types/game'
import type { ClueItem, ScriptPackage } from '@/types/script'

export type RoomEvent =
  | { type: 'room-state'; seats: Seat[]; roomCode: string }
  | { type: 'phase'; phase: GamePhase; phaseEndsAt: number }
  /** 剧本下发：每个客户端只会收到属于自己的那一份角色数据 */
  | { type: 'script'; script: ScriptPackage; selfRoleName: string; murderer: boolean }
  /** 凶手特权触发器：服务端在进入陈述环节时单独推给凶手 */
  | { type: 'privilege'; hint: string; atSpeakerIndex: number }
  | { type: 'statement'; statement: Statement }
  | { type: 'clue'; clue: ClueItem }
  | { type: 'vote'; vote: VoteRecord }
  | { type: 'reveal'; truth: ScriptPackage['global_truth']; settlement: unknown[] }
  | { type: 'error'; message: string }

export type ClientCommand =
  | { type: 'ready'; ready: boolean }
  | { type: 'statement'; text: string }
  | { type: 'search'; location: string }
  | { type: 'vote'; targetRoleName: string }
  | { type: 'next-phase' }

export interface GameTransport {
  connect(roomCode: string): void
  close(): void
  send(cmd: ClientCommand): void
  onEvent(handler: (e: RoomEvent) => void): () => void
}

/** 真实可用的 WebSocket 传输实现（配置了 VITE_WS_URL 后启用） */
export function createWebSocketTransport(url: string): GameTransport {
  let socket: WebSocket | null = null
  const handlers = new Set<(e: RoomEvent) => void>()

  return {
    connect(roomCode) {
      socket = new WebSocket(`${url}?room=${encodeURIComponent(roomCode)}`)
      socket.onmessage = (ev) => {
        try {
          const data = JSON.parse(String(ev.data)) as RoomEvent
          handlers.forEach((h) => h(data))
        } catch {
          handlers.forEach((h) => h({ type: 'error', message: '收到无法解析的服务端消息' }))
        }
      }
      socket.onerror = () =>
        handlers.forEach((h) => h({ type: 'error', message: 'WebSocket 连接异常' }))
    },
    close() {
      socket?.close()
      socket = null
    },
    send(cmd) {
      socket?.send(JSON.stringify(cmd))
    },
    onEvent(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}

/**
 * 当前运行模式。
 * 未配置 VITE_WS_URL 时走本地模拟（前端独立可跑）。
 */
export const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? ''
export const IS_LOCAL_MODE = WS_URL.length === 0