/**
 * 房间服务器内部类型
 * ------------------------------------------------------------------
 * 这里只描述**服务端自己的**运行时状态（房间 / 座位 / 定时器）。
 * 所有对外契约一律来自 `@/services/net/protocol`，不要在这里另立协议。
 *
 * 注意：内部状态里包含凶手座位、未翻出的线索文本等**绝不能下发**的字段，
 * 对外一律经过 `censorSeat()`（见 censor.ts）裁剪后才允许序列化。
 */

import type { WebSocket } from 'ws'
import type { GamePhase, RoundSummary, SettlementRow, Statement, VoteRecord } from '@/types/game'
import type { ClueItem, ScriptPackage } from '@/types/script'
import type { RevealView, TallyRow } from '@/services/net/protocol'

/** 房间内的一个座位（玩家或 AI） */
export interface RoomSeat {
  seatId: string
  /** 昵称；AI 座位在剧本下发后会改成「AI·角色名」 */
  name: string
  /** 断线重连凭证（只发给本人） */
  token: string
  avatar: string
  isBot: boolean
  /**
   * 设备档案 ID（客户端本机生成的稳定标识，见 store.ts）。
   * 空 = 这个座位没有档案（老客户端 / 客人不填），复盘时就不记战绩。
   */
  playerId: string | null
  /** 当前是否有一条活着的连接 */
  connected: boolean
  /** 大厅准备 / 阅读已读完 */
  ready: boolean
  readConfirmed: boolean
  /** 座位绑定的角色姓名；剧本下发前为 null */
  roleName: string | null
  socket: WebSocket | null
}

/**
 * 复盘时交给「档案库」的一行结果。
 * 由房间算出（服务器权威），客户端上报的胜负一律不采信。
 */
export interface SettledPlayerRow {
  playerId: string
  name: string
  role: string
  isMurderer: boolean
  win: boolean
}

/** 房间创建参数 */
export interface RoomOptions {
  code: string
  playerCount: number
  theme: string
  /** 房主导入的自定义剧本；存在时跳过服务器本地生成。 */
  script?: ScriptPackage | null
  /** 打一行中文日志用的回调（已带房间号前缀） */
  logger: (line: string) => void
  /**
   * 复盘结算完成时的回调（每局只调一次），用来给玩家档案记战绩。
   * 这里只交出「谁赢谁输」，不碰存储实现 —— room.ts 不依赖 store.ts。
   */
  onGameSettled?: (rows: SettledPlayerRow[]) => void
  /**
   * 阶段时长压缩系数（默认 1，仅测试用）：
   * 真实时长都是几分钟，测试里按比例压缩后才能在几秒内验证
   * 「phaseEndsAt 到时服务器自动推进」这条路径。
   */
  phaseScale?: number
  /**
   * 时间源（默认 Date.now，仅测试用）：
   * 公屏限流窗口（350ms / 每秒 8 条）与历史环形缓冲都需要跨秒推进，
   * 用假时钟可以在毫秒内验证完，不必真的 sleep 十几秒。
   */
  now?: () => number
}

/** 房间内部状态（对客户端不可见） */
export interface RoomSnapshot {
  code: string
  playerCount: number
  theme: string
  hostSeatId: string
  phase: GamePhase
  started: boolean
  round: number
  maxRounds: number
  searchRounds: number
  script: ScriptPackage | null
  murdererSeatId: string | null
  releasedTiers: number[]
  clues: ClueItem[]
  statements: Statement[]
  strawTally: TallyRow[]
  accel: { suggested: boolean; reason: string }
  roundSummary: RoundSummary | null
  votes: VoteRecord[]
  reveal: RevealView | null
  settlement: SettlementRow[]
}
