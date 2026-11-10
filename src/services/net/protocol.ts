/**
 * 联机协议 —— 前端与房间服务器之间**唯一**的契约
 * ==========================================================================
 * 设计原则：
 *
 * 1. **服务端权威**：轮次、线索发放、搜证抽取、投票统计、提前结算全部由服务器判定，
 *    客户端只负责渲染与上报意图。这样多端不会漂移。
 * 2. **按座位裁剪**：服务器对每个连接单独生成一份 `SeatView`（见 `censorSeat`），
 *    任何一帧都不能携带该座位不该知道的信息。这是真正的信息隔离，
 *    而不是前端隐藏（对比离线单机版，离线版整个剧本包都在客户端）。
 * 3. **快照式同步**：状态变化一律广播「该座位的完整视图」(`t:'view'`)，不做增量补丁。
 *    一桌 4-6 人、变化频率很低，快照最简单也最不容易出错；
 *    前端拿到 view 后投影到既有的 `game.state`，11 个页面**一行都不用改**。
 *
 * 该文件必须保持「纯类型 + 常量」，不能引入 Vue / Pinia / DOM，
 * 因为它同时被浏览器包和 Node 服务器包（esbuild 打包）引用。
 */

import type { GamePhase, RoundSummary, SettlementRow, Statement, VoteRecord } from '@/types/game'
import type { ClueItem, Role, ScriptPackage } from '@/types/script'

/** 房间服务器默认端口 */
export const NET_PORT = 5274
/** 协议版本：两端不一致时服务器直接拒绝，避免奇怪的表现 */
export const PROTOCOL_VERSION = 2

/** 公屏单条文字上限（服务端会再校验一次） */
export const CHAT_MAX_LEN = 200
/** 服务端保留的公屏历史条数（新进/重连的人能看到最近这些） */
export const CHAT_HISTORY = 60
/** 一条公屏消息的合法上限（含 emoji 等代理对，按码点算更准，这里用字符长度近似） */
export const CHAT_MIN_INTERVAL_MS = 350

export type Camp = 'murderer' | 'civil'

/* ------------------------------------------------------------------ *
 * 沟通：公屏文字 + 实时语音（WebRTC，服务器只中转信令）
 * ------------------------------------------------------------------ */

/**
 * 公屏文字消息。
 * ⚠️ 故意**不带 roleName**：对局中座位与角色的对应关系不下发（见裁剪规则表），
 * 消息只带发送者昵称（昵称本来就在 seats 里公开）。
 */
export interface ChatMessage {
  id: string
  seatId: string
  name: string
  text: string
  at: number
}

/** 语音通话里的某个人（公开信息：谁在麦上、谁静音了） */
export interface VoicePeer {
  seatId: string
  name: string
  muted: boolean
}

/**
 * WebRTC 信令内容。
 * 故意不用 DOM 的 `RTCIceCandidateInit` / `RTCSessionDescriptionInit`，
 * 因为这个文件也会被 Node 服务器打包引用（服务端没有 DOM 类型）。
 */
export type VoiceSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { kind: 'bye' }

/* ------------------------------------------------------------------ *
 * 服务器 → 客户端
 * ------------------------------------------------------------------ */

/** 大厅/对局中，别人看到的座位信息（**不含**角色身份） */
export interface SeatBrief {
  seatId: string
  name: string
  /**
   * 座位头像（emoji）。
   * 来自玩家档案（见 services/profile.ts），没档案的座位用服务器轮转默认值。
   * 属于公开的装饰信息，和昵称同级，所以照常下发。
   */
  avatar: string
  isSelf: boolean
  isHost: boolean
  isBot: boolean
  ready: boolean
  connected: boolean
  /** 仅两种情况下发：这就是「我」自己，或已经进入复盘阶段 */
  roleName?: string
}

export interface TallyRow {
  roleName: string
  count: number
  voters: string[]
}

/** 我自己的私有信息（只有这一块带身份） */
export interface SelfView {
  seatId: string
  name: string
  roleName: string
  camp: Camp
  /** 仅用于前端渲染「仅你可见」的特权面板 */
  isMurderer: boolean
  /** 我的角色全文；别人拿不到 */
  role: Role | null
  /** 我的私有线索（也可从 script.private_clues 读，这里冗余一份便于校验） */
  privateClues: ClueItem[]
  /** 凶手特权：**只有凶手端**在第 2 轮之后才有值 */
  privilege: { round: number; hint: string; at: number } | null
  strawVote: string | null
  vote: string | null
}

/** 复盘阶段才对所有人公开 */
export interface RevealView {
  murdererRoleName: string
  truth: ScriptPackage['global_truth']
  settlement: SettlementRow[]
  votes: VoteRecord[]
  /** 本局节奏回顾（人数 / 实际轮次 / 线索发放 / 提前结算依据） */
  review: { label: string; value: string }[]
}

/**
 * 某个座位的完整视图。前端 `applyServerView()` 会把它投影到既有的 GameState。
 * ⚠️ 任何新增字段都必须先想清楚：平民能不能看到？
 */
export interface SeatView {
  /** 递增版本号，前端丢弃乱序帧 */
  v: number
  roomCode: string
  playerCount: number
  theme: string
  phase: GamePhase
  /** 是否已经开始（false = 还在大厅选座位） */
  started: boolean
  round: number
  maxRounds: number
  searchRounds: number
  /** 本阶段结束的服务器时间戳（倒计时用，0 = 不限时） */
  phaseEndsAt: number
  /** 服务器当前时间，用于校正客户端时钟偏差 */
  serverAt: number

  seats: SeatBrief[]
  self: SelfView

  /**
   * ★ 按座位裁剪过的剧本包：
   *   - roles：**只有自己**那份是完整的，其他人只留 name / identity 骨架且 is_murderer 恒为 false
   *   - clue_batches：只含已发放批次
   *   - public_clues：只含已公开线索
   *   - private_clues：只含自己的
   *   - search_locations：只有地点名，clues 已清空（抽取由服务器做）
   *   - global_truth：**对局中为空**，复盘阶段才填充
   *   - murderer_privilege：只有凶手端在第 2 轮后才有值
   */
  script: ScriptPackage
  /** 已发放的线索批次 tier 列表 */
  releasedTiers: number[]
  /** 本轮剩余搜证次数（6 人局） */
  searchLeft: number
  /**
   * 搜证地点：只给名字与统计，**绝不下发 clues 内容**（抽取由服务器做）。
   * `total` = 该地点一共藏了几条线索，`found` = 已被翻出几条。
   * 前端用它渲染「剩 N / 已发现 x/y」，因此这两个计数不能省。
   */
  locations: { name: string; used: boolean; total: number; found: number }[]

  /**
   * 投票阶段已提交的最终票（用于「已投 3/5」进度）。
   * 可选：服务器若不实现，前端只显示 0，不影响结算（结算票在 reveal.votes）。
   */
  votes?: VoteRecord[]

  statements: Statement[]
  /** 当前轮到谁发言（seatId），null = 不在发言环节 */
  turnSeatId: string | null
  strawTally: TallyRow[]
  accel: { suggested: boolean; reason: string }
  roundSummary: RoundSummary | null
  /** AI 侦探提示（防冷场，6 人局） */
  hints: { round: number; text: string }[]
  /** 复盘数据：仅 phase === 'reveal' 时存在 */
  reveal: RevealView | null

  /**
   * 公屏文字历史（最新 `CHAT_HISTORY` 条，按时间正序）。
   * 纯公开信息，不需要按座位裁剪 —— 但它**不含**任何身份字段，
   * 所以即使原样广播也不会泄露凶手。
   */
  chats: ChatMessage[]
  /**
   * 正在语音通话里的人。服务端**不碰音频**，只转信令：
   * 音频是端到端（WebRTC）的，房间服务器只负责告诉客户端「谁在麦上」。
   */
  voice: VoicePeer[]
}

export type ServerMsg =
  /** 入座成功。token 用于断线重连 */
  | { t: 'welcome'; seatId: string; token: string; roomCode: string; isHost: boolean }
  | { t: 'view'; view: SeatView }
  /** 轻提示（有人加入、有人发言、系统播报等） */
  | { t: 'toast'; text: string; kind?: 'info' | 'warn' | 'good' }
  | { t: 'error'; message: string; code?: string }
  | { t: 'pong'; at: number; serverAt: number }
  /** 公屏新消息（广播给房间里所有人；历史在 view.chats 里） */
  | { t: 'chat'; msg: ChatMessage }
  /** 语音信令：从某个座位转发给我的 WebRTC 数据 */
  | { t: 'voice-signal'; fromSeatId: string; data: VoiceSignal }

/* ------------------------------------------------------------------ *
 * 客户端 → 服务器
 * ------------------------------------------------------------------ */

export type ClientMsg =
  /**
   * 建房（自动成为房主）；playerCount 只能用 4/5/6。
   * `playerId` / `avatar` 可选：带上后服务器会把昵称头像记进你的档案、
   * 并在复盘时给你记一局战绩（老客户端不带也照常能玩）。
   */
  | { t: 'create'; name: string; playerCount: number; theme: string; proto: number; playerId?: string; avatar?: string }
  /** 用房号加入 */
  | { t: 'join'; name: string; roomCode: string; proto: number; playerId?: string; avatar?: string }
  /** 断线重连（同一个座位换个连接回来） */
  | { t: 'rejoin'; roomCode: string; token: string; proto: number }
  /** 大厅：我读完了没（开始前是「准备」，阅读阶段是「已读完」） */
  | { t: 'ready'; ready: boolean }
  /** 房主：开始游戏（空位自动补 AI 玩家） */
  | { t: 'start' }
  /** 房主：推进到下一阶段（或任意玩家，服务器按 allowAnyAdvance 判定） */
  | { t: 'advance' }
  /** 当前发言人提交发言 */
  | { t: 'speak'; text: string }
  /** 房主：跳过当前发言人（掉线/卡住时用） */
  | { t: 'pass' }
  /** 搜证：翻某个地点（服务器决定抽出哪条线索并私下回给我） */
  | { t: 'search'; location: string }
  /** 搜到线索后：公开到线索板 / 私藏 */
  | { t: 'clue'; clueId: string; public: boolean }
  /** 轮间摸底票 */
  | { t: 'straw-vote'; targetRoleName: string }
  /** 最终投票 */
  | { t: 'vote'; targetRoleName: string }
  /** 房主：补一个 AI 玩家（人不够时） */
  | { t: 'add-bot' }
  /** 离开房间 */
  | { t: 'leave' }
  | { t: 'ping'; at: number }
  /** 公屏文字（不方便开麦时用；服务端会 trim、限长、限流） */
  | { t: 'chat'; text: string }
  /** 加入语音通话：服务端把我的座位加进 view.voice 并通知其他人来连我 */
  | { t: 'voice-join' }
  /** 退出语音通话（关闭所有对等连接） */
  | { t: 'voice-leave' }
  /** 静音切换（公开状态，让别人看到 🔇） */
  | { t: 'voice-mute'; muted: boolean }
  /** 转发给某个座位的 WebRTC 信令（服务器只做搬运，不看内容也不存） */
  | { t: 'voice-signal'; toSeatId: string; data: VoiceSignal }

/* ------------------------------------------------------------------ *
 * 裁剪规则（服务端唯一实现，前端可据此写测试）
 * ------------------------------------------------------------------ */

/**
 * `censorSeat(room, seatId)` 必须遵守的规则 —— 联机的安全性全在这张表上：
 *
 * | 字段 | 自己（平民） | 自己（凶手） | 其他座位 | 复盘时所有人 |
 * | --- | --- | --- | --- | --- |
 * | self.role（剧本全文） | ✅ | ✅ | —（不下发） | ✅ |
 * | self.isMurderer / camp | ✅ 平民 | ✅ 凶手 | — | ✅ |
 * | script.roles[i].is_murderer | 只有自己是 true 才为 true | 同左 | 恒 false | ✅ 真实值 |
 * | script.roles[i].full_script | 只有自己非空 | 同左 | 空字符串 | ✅ |
 * | script.murderer_privilege | ❌ null | ✅ 第 2 轮起 | ❌ null | ✅ |
 * | script.global_truth | ❌ 空壳 | ❌ 空壳 | ❌ 空壳 | ✅ 真实值 |
 * | script.clue_batches | 只含已发放 tier | 同左 | 同左 | ✅ 全部 |
 * | script.private_clues | 只含自己的 | 同左 | 同左 | ✅ 全部 |
 * | script.search_locations[].clues | ❌ 清空 | ❌ 清空 | ❌ 清空 | ✅ 全部 |
 * | seats[].roleName | 只有自己 | 只有自己 | ❌ 不下发 | ✅ 全部 |
 * | reveal | ❌ null | ❌ null | ❌ null | ✅ |
 * | chats[].text（公屏） | ✅ 公开 | ✅ | ✅ | ✅ |
 * | chats[].roleName | 不存在该字段 | 同左 | 同左 | 同左 |
 * | voice[]（谁在麦上） | ✅ 公开 | ✅ | ✅ | ✅ |
 */

/** 前端渲染「阵营」文案时统一走这里 */
export function campText(camp: Camp): string {
  return camp === 'murderer' ? '凶手' : '平民'
}

/**
 * 公屏时间的紧凑写法（今天只显示 时:分）。
 * 放在协议文件里是因为服务端日志与前端气泡都要用同一套格式。
 */
export function chatTimeText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const sameDay = new Date(now).toDateString() === d.toDateString()
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

/** 我自己是否在语音通话里 */
export function selfInVoice(view: SeatView): boolean {
  return view.voice.some((v) => v.seatId === view.self.seatId)
}

/**
 * 阶段 → 页面路由名。
 * 联机时服务器说「现在进入第 2 轮陈述」，所有客户端都按这张表跳到同一页。
 */
export const PHASE_ROUTE: Record<GamePhase, string> = {
  lobby: 'lobby',
  room: 'lobby',
  dealing: 'lobby',
  reading: 'reading',
  statement: 'statement',
  search: 'search',
  poll: 'poll',
  organize: 'organize',
  voting: 'voting',
  reveal: 'reveal',
}

/** 视图里「我」的座位号（找不到时返回空串） */
export function selfSeatId(view: SeatView): string {
  return view.self.seatId
}

/** 大厅里还有几个人没准备 */
export function pendingReady(view: SeatView): string[] {
  return view.seats.filter((s) => !s.ready && !s.isBot).map((s) => s.name)
}