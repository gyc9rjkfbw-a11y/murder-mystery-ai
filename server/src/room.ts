/**
 * 房间与阶段机（服务端权威）
 * ==========================================================================
 * 设计要点：
 *   1. **服务端权威**：轮次、线索发放、搜证抽取、投票统计、提前结算全部在
 *      这里判定，客户端只上报意图（`ClientMsg`）。
 *   2. **对外一律裁剪**：本类内部的 `seats/script/clues/votes` 含未公开信息，
 *      任何下发都必须走 `censorSeat()`（见 censor.ts）。**不允许**
 *      直接 `JSON.stringify(room)`。
 *   3. **只复用前端的既有规则**：轮次数 / 搜证次数 / 时长 / 提前结算阈值全部
 *      来自 `@/services/rules` 的 `pacingFor`，不在这里另写常量
 *      （唯一的例外是「个人整理 300 秒」，与前端 `ORGANIZE_SECONDS` 一致）。
 */

import { randomUUID } from 'node:crypto'
import {
  accelerateText,
  pacingFor,
  roundTheme,
} from '@/services/rules'
import { makeBotStatement, makeBotVoteTarget } from '@/services/bots'
import { AVATARS, makeRoomCode, phaseMeta, type GamePhase, type RoundSummary, type SettlementRow, type Statement, type VoteRecord } from '@/types/game'
import type { ClueItem, Role, ScriptPackage } from '@/types/script'
import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  CHAT_MIN_INTERVAL_MS,
  type ChatMessage,
  type ClientMsg,
  type ServerMsg,
  type TallyRow,
  type VoicePeer,
  type VoiceSignal,
} from '@/services/net/protocol'
import { censorSeat } from './censor'
import { phaseText } from './log'
import { buildScriptPackage } from './script'
import type { RoomOptions, RoomSeat } from './types'
import { validateScriptPackage } from '@/services/validator'

/** 个人整理时长（秒）；与前端 `stores/game.ts` 的 ORGANIZE_SECONDS 保持一致 */
const ORGANIZE_SECONDS = 300

/** 意向投票阶段时长（秒）；与前端一致 */
const POLL_SECONDS = 60

/** 断线座位轮到发言后，自动跳过的等待时长（毫秒） */
const OFFLINE_SKIP_MS = 20_000

/**
 * 公屏限流：每个座位、以及整个房间，每 1 秒最多接受的公屏条数。
 * 单座位的 350ms 间隔（CHAT_MIN_INTERVAL_MS）已经挡住单人刷屏，
 * 这里再兜一层「一群人合起来刷」和「将来有人调小间隔」的情况。
 */
const CHAT_PER_SECOND = 8

/**
 * 语音信令的体积上限。
 * SDP / ICE 里含 IP 与网络细节，服务器只做搬运工：既不看内容，也不落盘，
 * 长度还必须设死 —— 否则这条「中转通道」会变成任人使用的传文件通道。
 */
const VOICE_MAX_SDP = 20_000
const VOICE_MAX_CANDIDATE = 2_000
const VOICE_MAX_SDP_MID = 128

function topOf(tally: Record<string, number>): { top: string | null; votes: number } {
  let top: string | null = null
  let votes = 0
  for (const [name, n] of Object.entries(tally)) {
    if (n > votes) {
      votes = n
      top = name
    }
  }
  return { top, votes }
}

function shuffle<T>(list: T[]): T[] {
  const arr = [...list]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

/** 昵称兜底：去空白、限长、空名给个默认值 */
export function sanitizeName(raw: unknown, fallback: string): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return fallback
  return text.slice(0, 16)
}

/**
 * 公屏文本清洗：
 *   1. 去掉 C0 控制字符（`\u0000` 之类）—— 它们会污染终端日志与前端渲染；
 *   2. 换行 / 制表 / 连续空白折叠成单个空格，避免有人用空行刷屏；
 *   3. trim 后为空 → 返回空串，由调用方拒绝。
 *
 * ⚠️ 故意**不做 HTML 转义**：前端用文本插值渲染（绝不 v-html），
 *    服务端转义反而会让气泡里显示成 `&lt;script&gt;`。
 */
export function sanitizeChatText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 按**码点**截断到 CHAT_MAX_LEN。
 * 不能用 `slice`：它按 UTF-16 码元切，会把 emoji 的代理对切成半个字符
 * （前端渲染成一个孤立的乱码方块）。`[...text]` 才按码点迭代。
 */
export function truncateChatText(text: string): string {
  const points = [...text]
  return points.length <= CHAT_MAX_LEN ? text : points.slice(0, CHAT_MAX_LEN).join('')
}

/**
 * 语音信令的结构校验 + 白名单化。
 * 只挑出协议里定义的字段重新组装（而不是原样转发整个对象），
 * 这样客户端塞进来的任何额外字段都进不了转发通道。
 * 非法一律返回 null → 调用方静默忽略（不报错、不断开连接）。
 */
export function sanitizeVoiceSignal(raw: unknown): VoiceSignal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  switch (data.kind) {
    case 'offer':
    case 'answer': {
      const sdp = data.sdp
      if (typeof sdp !== 'string' || sdp.length === 0 || sdp.length > VOICE_MAX_SDP) return null
      return { kind: data.kind, sdp }
    }
    case 'ice': {
      // candidate 允许空串：ICE 收集结束时浏览器会发一个空 candidate 表示「候选完了」
      const candidate = data.candidate
      if (typeof candidate !== 'string' || candidate.length > VOICE_MAX_CANDIDATE) return null
      const sdpMid =
        typeof data.sdpMid === 'string' && data.sdpMid.length <= VOICE_MAX_SDP_MID ? data.sdpMid : null
      const sdpMLineIndex =
        typeof data.sdpMLineIndex === 'number' && Number.isFinite(data.sdpMLineIndex)
          ? data.sdpMLineIndex
          : null
      return { kind: 'ice', candidate, sdpMid, sdpMLineIndex }
    }
    case 'bye':
      return { kind: 'bye' }
    default:
      return null
  }
}

export class Room {
  readonly code: string
  readonly playerCount: number
  readonly theme: string
  hostSeatId = ''
  seats: RoomSeat[] = []

  phase: GamePhase = 'room'
  started = false
  round = 1
  maxRounds: number
  searchRounds: number
  phaseEndsAt = 0
  /** 视图版本号，每次广播 +1 */
  version = 0

  script: ScriptPackage | null = null
  murdererSeatId: string | null = null
  releasedTiers: number[] = []
  /** 全部线索（含未翻出的搜证线索 —— 绝不下发） */
  clues: ClueItem[] = []

  statements: Statement[] = []
  turnSeatId: string | null = null
  turnOrder: string[] = []
  private spokenSeatIds = new Set<string>()

  strawPoll: VoteRecord[] = []
  strawTally: TallyRow[] = []
  accel: { suggested: boolean; reason: string } = { suggested: false, reason: '' }
  roundSummary: RoundSummary | null = null
  roundSummaries: RoundSummary[] = []
  votes: VoteRecord[] = []
  reveal: import('@/services/net/protocol').RevealView | null = null
  hints: { round: number; text: string }[] = []

  /** 凶手特权解锁时间戳（用于 SelfView.privilege.at） */
  privilegeAt = 0

  /**
   * 公屏文字历史（定长上限 CHAT_HISTORY，先进先出）：
   * 老房间挂一整天也不会无限增长；新加入 / 重连的人拿到的 view.chats
   * 就是最近这些，永远按时间正序（老的在前）。
   */
  chats: ChatMessage[] = []

  lastActivity = Date.now()
  readonly createdAt = Date.now()

  private searchLeft = new Map<string, number>()
  private seatCounter = 0
  /** 房内公屏自增序号（消息 id = c1、c2…；同一房间内不重复即可） */
  private chatSeq = 0
  /** 历史第一次滚动淘汰时是否已经打过日志（避免每条都刷日志） */
  private chatTrimmedOnce = false
  /** 每个座位最后一次被接受的公屏时间（350ms 间隔限流） */
  private chatLastAt = new Map<string, number>()
  /** 每个座位最近 1 秒内被接受的公屏时间戳 */
  private chatTimes = new Map<string, number[]>()
  /** 整个房间最近 1 秒内被接受的公屏时间戳 */
  private chatWindow: number[] = []
  /**
   * 语音通话成员：seatId → 是否静音。
   * ⚠️ 这里只有「谁在麦上」这点公开状态，**不含任何音频数据**：
   *    音频走 WebRTC 端到端，服务器只转发 offer/answer/ice/bye。
   */
  private voiceMembers = new Map<string, boolean>()
  private nowFn: () => number
  private dealing = false
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private phaseTimer: ReturnType<typeof setTimeout> | null = null
  private turnTimer: ReturnType<typeof setTimeout> | null = null
  private hintTimer: ReturnType<typeof setTimeout> | null = null
  private logger: (line: string) => void
  /** 阶段时长压缩系数（测试用，默认 1 = 真实节奏） */
  private phaseScale: number
  /** 这一局的战绩是否已经交给档案库（保证每局每座只记一次） */
  private statsRecorded = false
  /** 房主提供的自定义剧本；存在时不走服务器模板生成。 */
  private customScript: ScriptPackage | null
  /** 复盘结算回调（由 app.ts 注入，用来写玩家档案） */
  private onGameSettled?: (rows: import('./types').SettledPlayerRow[]) => void

  constructor(options: RoomOptions) {
    this.code = options.code
    this.playerCount = options.playerCount
    this.theme = options.theme
    this.logger = options.logger
    this.onGameSettled = options.onGameSettled
    this.phaseScale = options.phaseScale && options.phaseScale > 0 ? options.phaseScale : 1
    this.nowFn = options.now ?? Date.now
    this.customScript = options.script ?? null
    const pacing = pacingFor(options.playerCount)
    this.maxRounds = pacing.maxRounds
    this.searchRounds = pacing.searchRounds
  }

  /** 当前时间（默认 Date.now；测试可以注入假时钟） */
  private clock(): number {
    return this.nowFn()
  }

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  log(line: string): void {
    this.logger(line)
  }

  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const handle = setTimeout(() => {
      this.timers.delete(handle)
      try {
        fn()
      } catch (e) {
        this.log(`定时任务异常：${String(e)}`)
      }
    }, ms)
    this.timers.add(handle)
    return handle
  }

  private clearTimer(handle: ReturnType<typeof setTimeout> | null): void {
    if (!handle) return
    clearTimeout(handle)
    this.timers.delete(handle)
  }

  private clearPhaseTimer(): void {
    this.clearTimer(this.phaseTimer)
    this.phaseTimer = null
  }

  private clearTurnTimer(): void {
    this.clearTimer(this.turnTimer)
    this.turnTimer = null
  }

  /** 清理全部定时器（房间销毁时调用，避免泄漏） */
  dispose(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.phaseTimer = null
    this.turnTimer = null
    this.hintTimer = null
  }

  seatById(seatId: string): RoomSeat | undefined {
    return this.seats.find((s) => s.seatId === seatId)
  }

  seatByToken(token: string): RoomSeat | undefined {
    return this.seats.find((s) => s.token === token && !s.isBot)
  }

  roleByName(name: string | null | undefined): Role | null {
    if (!name || !this.script) return null
    return this.script.roles.find((r) => r.name === name) ?? null
  }

  connectedHumans(): RoomSeat[] {
    return this.seats.filter((s) => !s.isBot && s.connected)
  }

  humanCount(): number {
    return this.seats.filter((s) => !s.isBot).length
  }

  full(): boolean {
    return this.seats.length >= this.playerCount
  }

  searchLeftFor(seatId: string): number {
    return this.searchLeft.get(seatId) ?? 0
  }

  /** 某个座位能看到的私有线索（自己的角色私有线索 + 自己翻出来的线索） */
  privateCluesOf(seatId: string): ClueItem[] {
    const seat = this.seatById(seatId)
    if (!seat) return []
    return this.clues.filter((c) => {
      if (c.isPrivate) return !!seat.roleName && c.ownerRoleName === seat.roleName
      return c.foundBy === seatId
    })
  }

  locationNames(): string[] {
    const names = (this.script?.search_locations ?? []).map((l) => l.name)
    return [...new Set(names)]
  }

  /** 某地点里所有「搜证线索」（系统批次线索不算） */
  private cluesAtLocation(name: string): ClueItem[] {
    return this.clues.filter((c) => !c.isPrivate && c.tier === undefined && c.location === name)
  }

  private allSearchClues(): ClueItem[] {
    return this.clues.filter((c) => !c.isPrivate && c.tier === undefined)
  }

  /** 对外暴露的搜证地点统计（只给数字，不给线索内容） */
  locationStats(): { name: string; used: boolean; total: number; found: number }[] {
    return this.locationNames().map((name) => {
      const items = this.cluesAtLocation(name)
      const found = items.filter((c) => c.revealed).length
      return { name, used: items.length > 0 && found >= items.length, total: items.length, found }
    })
  }

  private releasedClueTexts(): string[] {
    const batches = this.script?.clue_batches ?? []
    return batches.filter((b) => this.releasedTiers.includes(b.tier)).flatMap((b) => b.clues)
  }

  /** 某个座位是否在语音通话里 */
  inVoice(seatId: string): boolean {
    return this.voiceMembers.has(seatId)
  }

  /**
   * 正在语音里的人（公开信息）。
   * 顺序 = 座位顺序（而不是加入顺序），前端渲染麦克风列表时不会跳来跳去。
   */
  voicePeers(): VoicePeer[] {
    return this.seats
      .filter((s) => this.voiceMembers.has(s.seatId))
      .map((s) => ({ seatId: s.seatId, name: s.name, muted: this.voiceMembers.get(s.seatId) === true }))
  }

  /* ------------------------------------------------------------------ *
   * 座位管理
   * ------------------------------------------------------------------ */

  addSeat(options: {
    name: string
    isBot: boolean
    connected: boolean
    ready: boolean
    host: boolean
    /** 设备档案 ID：有档案的真人座位复盘时才记战绩 */
    playerId?: string | null
    /** 头像（来自玩家档案；不传就用轮转默认头像） */
    avatar?: string
  }): RoomSeat {
    this.seatCounter += 1
    const seat: RoomSeat = {
      seatId: `s${this.seatCounter}`,
      name: options.name,
      token: randomUUID(),
      avatar: options.avatar?.trim() || AVATARS[this.seats.length % AVATARS.length],
      isBot: options.isBot,
      playerId: options.playerId ?? null,
      connected: options.connected,
      ready: options.ready,
      readConfirmed: false,
      roleName: null,
      socket: null,
    }
    this.seats.push(seat)
    if (options.host || !this.hostSeatId) this.hostSeatId = seat.seatId
    this.searchLeft.set(seat.seatId, 0)
    return seat
  }

  /** 绑定一条新连接（加入 / 重连都走这里） */
  attachSocket(seat: RoomSeat, socket: RoomSeat['socket']): void {
    seat.socket = socket
    seat.connected = true
    this.lastActivity = Date.now()
  }

  /** 连接断开：保留座位与 token，允许 rejoin 回来 */
  markDisconnected(seat: RoomSeat): void {
    seat.connected = false
    seat.socket = null
    this.lastActivity = Date.now()
    // 掉线即离开语音：不能让其他人继续对着一个没人应答的 PeerConnection 说话。
    // 重连后**不自动回到语音**（音频设备要用户重新授权），需要再发一次 voice-join。
    if (this.voiceMembers.delete(seat.seatId)) {
      this.log(`语音：${seat.name} 掉线，已自动移出语音通话（重连后需重新加入）`)
    }
  }

  /** 主动离开：未开局直接移除座位；已开局只标记掉线（不破坏对局） */
  leaveSeat(seat: RoomSeat): void {
    this.lastActivity = Date.now()
    if (this.started) {
      this.markDisconnected(seat)
      this.toastAll(`${seat.name} 离开了房间`, 'warn')
      this.broadcastView()
      return
    }
    this.seats = this.seats.filter((s) => s.seatId !== seat.seatId)
    this.searchLeft.delete(seat.seatId)
    // 座位都没了，公屏限流记录与语音成员也一并清掉（别在主循环之外留垃圾）
    this.voiceMembers.delete(seat.seatId)
    this.chatLastAt.delete(seat.seatId)
    this.chatTimes.delete(seat.seatId)
    if (this.hostSeatId === seat.seatId) {
      const next = this.seats.find((s) => !s.isBot)
      this.hostSeatId = next?.seatId ?? this.seats[0]?.seatId ?? ''
      if (next) this.log(`房主转移给 ${next.name}`)
    }
    this.log(`${seat.name} 离开了房间（剩 ${this.humanCount()} 人）`)
    this.toastAll(`${seat.name} 离开了房间`, 'warn')
    this.broadcastView()
  }

  private removeBots(): void {
    this.seats = this.seats.filter((s) => !s.isBot)
  }

  private fillBots(): void {
    let index = this.humanCount()
    while (this.seats.length < this.playerCount) {
      index += 1
      this.addSeat({ name: `AI 玩家${index}`, isBot: true, connected: true, ready: true, host: false })
    }
  }

  /* ------------------------------------------------------------------ *
   * 下发（**唯一**出口都必须是 censorSeat）
   * ------------------------------------------------------------------ */

  private send(seat: RoomSeat, msg: ServerMsg): void {
    const socket = seat.socket
    if (!socket) return
    // ws 的 OPEN 状态常量是 1（这里不引入 ws 运行时依赖）
    if (socket.readyState !== 1) return
    socket.send(JSON.stringify(msg))
  }

  /** 发给某一个座位的轻提示 */
  toast(seat: RoomSeat, text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
    this.send(seat, { t: 'toast', text, kind })
  }

  toastAll(text: string, kind: 'info' | 'warn' | 'good' = 'info'): void {
    for (const seat of this.seats) {
      if (!seat.isBot && seat.connected) this.send(seat, { t: 'toast', text, kind })
    }
  }

  /** 给一个座位报错 */
  fail(seat: RoomSeat, message: string, code?: string): void {
    this.log(`拒绝操作（${seat.name}）：${message}`)
    this.send(seat, { t: 'error', message, code })
  }

  /**
   * 广播「该座位的完整视图」。
   * ★ 每一帧都经过 censorSeat 裁剪；本文件不出现任何直接把房间对象
   *   序列化下发的地方。
   */
  broadcastView(): void {
    this.version += 1
    for (const seat of this.seats) {
      if (seat.isBot || !seat.connected || !seat.socket) continue
      this.send(seat, { t: 'view', view: censorSeat(this, seat.seatId) })
    }
  }

  /** 只给一个座位补发当前视图（重连时用） */
  sendViewTo(seat: RoomSeat): void {
    this.version += 1
    if (seat.isBot || !seat.socket) return
    this.send(seat, { t: 'view', view: censorSeat(this, seat.seatId) })
  }

  /* ------------------------------------------------------------------ *
   * 阶段机
   * ------------------------------------------------------------------ */

  private systemSay(title: string, text: string, round = this.round): void {
    this.statements.push({
      seatId: 'system',
      roleName: '系统',
      text,
      round,
      kind: 'system',
      simulated: true,
      title,
      at: Date.now(),
    })
  }

  private phaseSeconds(phase: GamePhase): number {
    const pacing = pacingFor(this.playerCount)
    let seconds: number
    switch (phase) {
      case 'reading':
        seconds = pacing.readingSeconds
        break
      case 'statement':
        seconds = pacing.roundSeconds
        break
      case 'search':
        seconds = phaseMeta('search').duration
        break
      case 'poll':
        seconds = POLL_SECONDS
        break
      case 'organize':
        seconds = ORGANIZE_SECONDS
        break
      case 'voting':
        seconds = phaseMeta('voting').duration
        break
      default:
        seconds = 0
    }
    if (seconds <= 0 || this.phaseScale === 1) return seconds
    return Math.max(1, Math.round(seconds * this.phaseScale))
  }

  private setPhase(phase: GamePhase): void {
    this.clearPhaseTimer()
    this.phase = phase
    const seconds = this.phaseSeconds(phase)
    this.phaseEndsAt = seconds > 0 ? Date.now() + seconds * 1000 : 0
    const roundTag =
      phase === 'statement' || phase === 'search' || phase === 'poll' ? `（第 ${this.round} 轮）` : ''
    this.log(
      `阶段推进 → ${phaseText(phase)}${roundTag}` +
        (seconds > 0 ? `，${seconds} 秒后自动推进` : ''),
    )
    if (seconds > 0) {
      this.phaseTimer = this.later(seconds * 1000, () => {
        this.log(`阶段超时（${phaseText(this.phase)}），服务器自动推进`)
        this.advancePhase()
        this.broadcastView()
      })
    }
  }

  /** 推进到下一阶段（房主手动 / 超时自动都走这里） */
  private advancePhase(): void {
    switch (this.phase) {
      case 'lobby':
      case 'room':
      case 'dealing':
      case 'reveal':
        return
      case 'reading':
        this.beginRound(1)
        return
      case 'statement': {
        const missing = this.turnOrder.filter((id) => !this.spokenSeatIds.has(id))
        if (missing.length > 0) {
          const names = missing.map((id) => this.seatById(id)?.name).filter(Boolean).join('、')
          this.systemSay('发言已结束', `本轮陈述结束，${names} 未发言。`)
        }
        this.endStatement()
        return
      }
      case 'search':
        this.enterPoll()
        return
      case 'poll':
        this.leavePoll()
        return
      case 'organize':
        this.enterVoting()
        return
      case 'voting':
        this.settle()
        return
      default:
        return
    }
  }

  /** 开始游戏：补 AI → 生成剧本 → 洗牌分角色 → 进入阅读 */
  async start(seat: RoomSeat): Promise<void> {
    if (this.started || this.dealing) {
      this.fail(seat, '对局已经开始了', 'started')
      return
    }
    if (seat.seatId !== this.hostSeatId) {
      this.fail(seat, '只有房主可以开始游戏', 'not-host')
      return
    }
    if (![4, 5, 6].includes(this.playerCount)) {
      this.fail(seat, `人数只能是 4 / 5 / 6，当前是 ${this.playerCount}`, 'bad-player-count')
      return
    }

    this.dealing = true
    this.fillBots()
    const bots = this.seats.filter((s) => s.isBot).length
    this.log(`开始游戏：${this.playerCount} 人（真人 ${this.humanCount()}，AI 自动补位 ${bots} 个）`)
    this.setPhase('dealing')
    this.broadcastView()

    const built = this.customScript
      ? (() => {
          const checked = validateScriptPackage(this.customScript, this.playerCount)
          return {
            ok: checked.ok && !!checked.data,
            pkg: checked.data ?? null,
            errors: checked.errors,
          }
        })()
      : await buildScriptPackage(this.playerCount, this.theme)
    this.dealing = false
    if (!built.ok || !built.pkg) {
      this.log(`剧本生成失败：${built.errors.join('；')}`)
      this.fail(seat, `剧本生成失败：${built.errors[0] ?? '未知错误'}`, 'script-failed')
      this.removeBots()
      this.setPhase('room')
      this.broadcastView()
      return
    }

    this.applyScript(built.pkg)
    this.started = true
    this.round = 1
    for (const s of this.seats) {
      if (s.isBot) {
        s.ready = true
        s.readConfirmed = true
      }
    }
    this.setPhase('reading')
    const pacing = pacingFor(this.playerCount)
    this.systemSay(
      '剧本已下发',
      `本局 ${this.playerCount} 人，共 ${this.maxRounds} 轮` +
        (this.searchRounds > 0
          ? `，每轮每人可搜证 ${pacing.searchPerRound} 次。`
          : '，线索由系统按轮次发放。') +
        `请先读自己的剧本（${Math.round(pacing.readingSeconds / 60)} 分钟）。`,
    )
    this.toastAll('剧本已下发，请开始阅读', 'good')
    this.broadcastView()
  }

  private applyScript(pkg: ScriptPackage): void {
    this.script = pkg
    this.murdererSeatId = null
    this.releasedTiers = []
    this.statements = []
    this.strawPoll = []
    this.votes = []
    this.reveal = null
    this.hints = []
    this.searchLeft.clear()

    // 线索池：三批系统线索 + 搜证地点线索 + 角色私有线索（与前端 buildClues 一致）
    const clues: ClueItem[] = []
    ;(pkg.clue_batches ?? []).forEach((batch) => {
      batch.clues.forEach((text, ci) => {
        clues.push({
          id: `batch-${batch.tier}-${ci}`,
          text,
          location: batch.title,
          isPrivate: false,
          tier: batch.tier,
          revealed: false,
          published: false,
          pinned: false,
        })
      })
    })
    ;(pkg.search_locations ?? []).forEach((loc, li) => {
      loc.clues.forEach((text, ci) => {
        clues.push({
          id: `srch-${li}-${ci}`,
          text,
          location: loc.name,
          isPrivate: false,
          revealed: false,
          published: false,
          pinned: false,
        })
      })
    })
    ;(pkg.private_clues ?? []).forEach((pc, i) => {
      clues.push({
        id: `prv-${i}`,
        text: pc.text,
        location: '私有线索',
        isPrivate: true,
        ownerRoleName: pc.role_name,
        revealed: true,
        published: false,
        pinned: false,
      })
    })
    this.clues = clues

    // 洗牌分角色：座位顺序随机，避免「按加入顺序拿本」
    const order = shuffle(this.seats.map((_, i) => i))
    pkg.roles.forEach((role, i) => {
      const seat = this.seats[order[i]]
      if (seat) seat.roleName = role.name
    })
    const murdererSeat = this.seats.find((s) => s.roleName === pkg.global_truth.murderer_name)
    this.murdererSeatId = murdererSeat?.seatId ?? null

    // AI 座位改名为「AI·角色名」
    for (const s of this.seats) {
      if (s.isBot && s.roleName) s.name = `AI·${s.roleName}`
      this.searchLeft.set(s.seatId, 0)
    }

    this.log(
      `剧本已生成：${pkg.game_config.theme}，${pkg.roles.length} 个角色，` +
        `${this.maxRounds} 轮，搜证 ${this.searchRounds} 轮，线索 ${this.clues.length} 条`,
    )
  }

  /* ------------------------------------------------------------------ *
   * 轮次
   * ------------------------------------------------------------------ */

  private beginRound(n: number): void {
    const pacing = pacingFor(this.playerCount)
    this.round = Math.min(this.maxRounds, Math.max(1, n))
    this.spokenSeatIds.clear()
    this.strawPoll = []
    this.strawTally = []
    this.accel = { suggested: false, reason: '' }
    this.roundSummary = null
    this.turnOrder = this.seats.map((s) => s.seatId)
    for (const s of this.seats) {
      this.searchLeft.set(s.seatId, this.round <= this.searchRounds ? pacing.searchPerRound : 0)
    }

    // ★ 先把「轮到谁」定下来，再切阶段。
    //   setPhase / systemSay / releaseClueBatch 都会触发一次广播，
    //   如果 turnSeatId 在这之后才赋值，客户端收到的第一帧里就是 null，
    //   连真人都不知道自己该发言（浏览器端没有「轮到我」的输入框），
    //   于是整桌干等到阶段超时。教训：切阶段的广播必须带上完整的新状态。
    this.turnSeatId = this.turnOrder[0] ?? null

    this.setPhase('statement')
    const theme = roundTheme(this.round, this.maxRounds)
    this.systemSay('本轮开始', `${theme.title}\n目标：${theme.goal}\n系统：${theme.systemAction}`)

    // 本轮线索批次 = 轮次序号
    this.releaseClueBatch(this.round)
    if (this.round >= pacing.privilegeRound && this.privilegeAt === 0) {
      this.privilegeAt = Date.now()
      this.log(`凶手特权已解锁（第 ${this.round} 轮，仅凶手端可见）`)
    }

    this.scheduleTurnDriver()
    this.scheduleIdleHint()
    // 保险：无论上面哪一步提前广播，这里再补一次，确保客户端一定收到本轮的首位发言者
    this.broadcastView()
  }

  /** 发放某一批线索（系统播报 + 公开到公共线索板） */
  private releaseClueBatch(tier: number): void {
    if (this.releasedTiers.includes(tier)) return
    const batch = (this.script?.clue_batches ?? []).find((b) => b.tier === tier)
    if (!batch) return
    this.clues
      .filter((c) => c.tier === tier)
      .forEach((c) => {
        c.revealed = true
        c.published = true
      })
    this.releasedTiers.push(tier)
    this.systemSay(
      `第 ${this.round} 轮 · 线索发放`,
      `${batch.title} 已公开（共 ${batch.clues.length} 条）：\n` +
        batch.clues.map((c, i) => `　${i + 1}. ${c}`).join('\n'),
    )
    this.log(`线索发放：第 ${tier} 批（${batch.clues.length} 条）已广播给所有人`)
  }

  private releaseRemainingTiers(): void {
    const tiers = (this.script?.clue_batches ?? []).map((b) => b.tier).sort((a, b) => a - b)
    for (const t of tiers) this.releaseClueBatch(t)
  }

  private endStatement(): void {
    this.clearTurnTimer()
    this.turnSeatId = null
    if (this.round <= this.searchRounds) this.enterSearch()
    else this.enterPoll()
  }

  private scheduleTurnDriver(): void {
    this.clearTurnTimer()
    const seat = this.turnSeatId ? this.seatById(this.turnSeatId) : undefined
    if (!seat) return
    if (seat.isBot) {
      const delay = 1500 + Math.floor(Math.random() * 1500)
      this.turnTimer = this.later(delay, () => this.botSpeak(seat))
      return
    }
    if (!seat.connected) {
      // 掉线的真人座位：等一会儿没人替他说话就自动跳过，别让全桌干等
      this.turnTimer = this.later(OFFLINE_SKIP_MS, () => {
        if (this.phase !== 'statement' || this.turnSeatId !== seat.seatId) return
        this.systemSay('发言跳过', `${seat.name} 掉线，服务器已自动跳过。`)
        this.log(`自动跳过掉线座位：${seat.name}`)
        this.spokenSeatIds.add(seat.seatId)
        this.advanceTurn()
        this.broadcastView()
      })
    }
  }

  private botSpeak(seat: RoomSeat): void {
    if (this.phase !== 'statement' || this.turnSeatId !== seat.seatId) return
    const role = this.roleByName(seat.roleName)
    const roles = this.script?.roles ?? []
    if (!role) {
      this.spokenSeatIds.add(seat.seatId)
      this.advanceTurn()
      this.broadcastView()
      return
    }
    const index = this.seats.findIndex((s) => s.seatId === seat.seatId)
    const text = makeBotStatement(role, roles, index, this.round)
    this.commitStatement(seat, text, true)
    this.broadcastView()
  }

  private commitStatement(seat: RoomSeat, text: string, simulated: boolean): void {
    this.statements.push({
      seatId: seat.seatId,
      roleName: seat.roleName ?? '',
      text,
      round: this.round,
      kind: 'player',
      simulated,
      at: Date.now(),
    })
    this.spokenSeatIds.add(seat.seatId)
    this.log(
      `${simulated ? 'AI 发言' : '玩家发言'}：${seat.name}（${seat.roleName ?? '未分配'}）· 第 ${this.round} 轮`,
    )
    this.advanceTurn()
  }

  private advanceTurn(): void {
    const next = this.turnOrder.find((id) => !this.spokenSeatIds.has(id))
    if (!next) {
      this.turnSeatId = null
      this.endStatement()
      return
    }
    this.turnSeatId = next
    this.scheduleTurnDriver()
  }

  /* ------------------------------------------------------------------ *
   * 搜证
   * ------------------------------------------------------------------ */

  private enterSearch(): void {
    const pacing = pacingFor(this.playerCount)
    for (const s of this.seats) this.searchLeft.set(s.seatId, pacing.searchPerRound)
    this.setPhase('search')
    this.systemSay(
      '搜证开始',
      `本轮每人的搜证次数：${pacing.searchPerRound} 次。翻出来的东西可以选择公开或私藏。`,
    )
    this.log(`进入自由搜证：每人 ${pacing.searchPerRound} 次，共 ${this.locationNames().length} 个地点`)
    this.scheduleBotSearch()
  }

  private scheduleBotSearch(): void {
    const bots = this.seats.filter((s) => s.isBot)
    const pacing = pacingFor(this.playerCount)
    bots.forEach((bot, i) => {
      for (let attempt = 0; attempt < pacing.searchPerRound; attempt += 1) {
        const delay = 900 + i * 350 + attempt * 1400
        this.later(delay, () => {
          if (this.phase !== 'search') return
          if (this.searchLeftFor(bot.seatId) <= 0) return
          const candidates = this.locationNames().filter((name) =>
            this.cluesAtLocation(name).some((c) => !c.revealed),
          )
          if (candidates.length === 0) return
          const name = candidates[Math.floor(Math.random() * candidates.length)]
          this.revealClueAt(bot, name)
          this.broadcastView()
          this.maybeEndSearch()
        })
      }
    })
  }

  /** 在某地点抽一条尚未被任何人翻出的线索，私下交给搜证者 */
  private revealClueAt(seat: RoomSeat, location: string): ClueItem | null {
    const pending = this.cluesAtLocation(location).filter((c) => !c.revealed)
    if (pending.length === 0) return null
    const clue = pending[Math.floor(Math.random() * pending.length)]
    clue.revealed = true
    clue.foundBy = seat.seatId
    const left = Math.max(0, this.searchLeftFor(seat.seatId) - 1)
    this.searchLeft.set(seat.seatId, left)
    this.log(`搜证：${seat.name} 在「${location}」翻出一条线索（本轮剩 ${left} 次）`)
    return clue
  }

  private handleSearch(seat: RoomSeat, location: string): void {
    if (this.phase !== 'search') {
      this.fail(seat, '现在不是搜证环节', 'bad-phase')
      return
    }
    const name = this.locationNames().find((n) => n === location)
    if (!name) {
      this.fail(seat, `没有这个搜证地点：${location}`, 'no-location')
      return
    }
    const pacing = pacingFor(this.playerCount)
    const left = this.searchLeftFor(seat.seatId)
    if (left <= 0) {
      this.fail(seat, `本轮搜证次数已用完（每人每轮 ${pacing.searchPerRound} 次）`, 'search-limit')
      return
    }
    const clue = this.revealClueAt(seat, name)
    if (!clue) {
      this.fail(seat, `「${name}」已经被翻空了`, 'location-empty')
      this.broadcastView()
      return
    }
    this.toast(seat, `你在「${name}」翻到了：${clue.text}`, 'good')
    // 只播报「有人搜过」，线索内容绝不外泄
    this.systemSay('搜证', `${seat.name} 在「${name}」搜查了一番。`)
    this.broadcastView()
    this.maybeEndSearch()
  }

  private maybeEndSearch(): void {
    if (this.phase !== 'search') return
    const humans = this.connectedHumans()
    const allUsed = humans.length > 0 && humans.every((s) => this.searchLeftFor(s.seatId) <= 0)
    const allFound = this.allSearchClues().every((c) => c.revealed)
    if (allUsed || allFound) {
      this.log(
        allFound ? '现场线索已被全部翻出，搜证提前结束' : '所有在线玩家都用完了搜证次数，搜证结束',
      )
      this.enterPoll()
      this.broadcastView()
    }
  }

  private handleClueDecision(seat: RoomSeat, clueId: string, isPublic: boolean): void {
    const clue = this.clues.find((c) => c.id === clueId)
    if (!clue) {
      this.fail(seat, `没有这条线索：${clueId}`, 'no-clue')
      return
    }
    const mine =
      clue.foundBy === seat.seatId ||
      (clue.isPrivate && !!seat.roleName && clue.ownerRoleName === seat.roleName)
    if (!mine) {
      this.fail(seat, '这不是你翻出来的线索', 'not-yours')
      return
    }
    clue.published = isPublic
    clue.pinned = true
    if (isPublic) {
      this.systemSay('线索公开', `${seat.name} 公开了一条线索：${clue.text}`)
      this.log(`线索公开：${seat.name} 把「${clue.location}」的一条线索放上了公共线索板`)
    } else {
      this.log(`线索私藏：${seat.name} 把「${clue.location}」的一条线索留在自己手里`)
    }
    this.broadcastView()
  }

  /* ------------------------------------------------------------------ *
   * 意向投票 / 最终投票
   * ------------------------------------------------------------------ */

  private enterPoll(): void {
    this.clearTurnTimer()
    this.strawPoll = []
    this.strawTally = []
    this.accel = { suggested: false, reason: '' }
    this.roundSummary = null
    this.setPhase('poll')
    this.recomputeStraw()
    this.log(`进入轮间摸底（第 ${this.round} 轮），等待 ${this.seats.length} 人投票`)
    this.scheduleBotStrawVotes()
  }

  private recomputeStraw(): void {
    const counts = new Map<string, string[]>()
    for (const vote of this.strawPoll) {
      const seat = this.seatById(vote.voterSeatId)
      const list = counts.get(vote.targetRoleName) ?? []
      list.push(seat?.name ?? vote.voterSeatId)
      counts.set(vote.targetRoleName, list)
    }
    this.strawTally = [...counts.entries()]
      .map(([roleName, voters]) => ({ roleName, count: voters.length, voters }))
      .sort((a, b) => b.count - a.count || a.roleName.localeCompare(b.roleName))
  }

  private handleStrawVote(seat: RoomSeat, targetRoleName: string): void {
    if (this.phase !== 'poll') {
      this.fail(seat, '现在不是轮间摸底环节', 'bad-phase')
      return
    }
    if (!this.roleByName(targetRoleName)) {
      this.fail(seat, `没有这个角色：${targetRoleName}`, 'bad-target')
      return
    }
    this.strawPoll = this.strawPoll.filter((v) => v.voterSeatId !== seat.seatId)
    this.strawPoll.push({ voterSeatId: seat.seatId, targetRoleName, at: Date.now() })
    this.log(`摸底投票：${seat.name} → ${targetRoleName}`)
    this.recomputeStraw()
    this.maybeEndPoll()
    this.broadcastView()
  }

  private maybeEndPoll(): void {
    if (this.phase !== 'poll') return
    const voted = new Set(this.strawPoll.map((v) => v.voterSeatId))
    if (!this.seats.every((s) => voted.has(s.seatId))) return

    const tally: Record<string, number> = {}
    for (const row of this.strawTally) tally[row.roleName] = row.count
    const { top, votes } = topOf(tally)
    const pacing = pacingFor(this.playerCount)
    // 提前结算条件一：只在**倒数第二轮**达到票数阈值
    const isPenultimate = this.round === this.maxRounds - 1
    let accel: { suggested: boolean; reason: string } = { suggested: false, reason: '' }
    if (isPenultimate && top && votes >= pacing.accelerateVotes) {
      accel = {
        suggested: true,
        reason: `已有 ${votes} 人指认「${top}」，达到提前结算阈值（${accelerateText(this.playerCount)}）`,
      }
    } else {
      // 条件二：三批线索都发完，且（无搜证环节 或 所有地点都翻完）
      const totalTiers = (this.script?.clue_batches ?? []).length
      const allTiersOut = totalTiers > 0 && this.releasedTiers.length >= totalTiers
      const searchable = this.allSearchClues()
      const allSearched =
        this.searchRounds === 0 || searchable.length === 0 || searchable.every((c) => c.revealed)
      if (allTiersOut && allSearched) {
        accel = { suggested: true, reason: '所有关键线索均已曝光，可以提前结算' }
      }
    }

    this.accel = accel
    const summary: RoundSummary = {
      round: this.round,
      tally: { ...tally },
      top,
      topVotes: votes,
      accelerate: accel.suggested,
      reason: accel.reason,
    }
    this.roundSummary = summary
    const idx = this.roundSummaries.findIndex((s) => s.round === this.round)
    if (idx >= 0) this.roundSummaries[idx] = summary
    else this.roundSummaries.push(summary)

    this.log(
      `票型统计（第 ${this.round} 轮）：` +
        (this.strawTally.map((r) => `${r.roleName} ${r.count} 票`).join('、') || '暂无') +
        (accel.suggested ? `；建议提前结算：${accel.reason}` : '；未达到提前结算条件'),
    )
  }

  private leavePoll(): void {
    if (this.accel.suggested) {
      this.systemSay(
        '系统提示 · 提前结算',
        `满足提前结算条件：${this.accel.reason || '关键信息已经足够'}。跳过剩余轮次，直接进入个人整理与最终投票。`,
      )
      this.log('提前结算：跳过剩余轮次，直接进入个人整理与最终投票')
      this.releaseRemainingTiers()
      this.enterOrganize()
      return
    }
    if (this.round < this.maxRounds) {
      this.beginRound(this.round + 1)
      return
    }
    this.releaseRemainingTiers()
    this.systemSay(
      '发言已关闭',
      '本轮陈述结束，所有人的发言通道已关闭。请进入个人整理，5 分钟后进行最终投票。',
    )
    this.enterOrganize()
  }

  private enterOrganize(): void {
    this.clearTurnTimer()
    this.turnSeatId = null
    this.setPhase('organize')
  }

  private enterVoting(): void {
    this.votes = []
    this.setPhase('voting')
    this.systemSay('最终投票', '请指认你心中的凶手。所有人投完后自动结算。')
    this.log(`进入最终投票，等待 ${this.seats.length} 人投票`)
    this.scheduleBotFinalVotes()
  }

  private handleVote(seat: RoomSeat, targetRoleName: string): void {
    if (this.phase !== 'voting') {
      this.fail(seat, '现在不是最终投票环节', 'bad-phase')
      return
    }
    if (!this.roleByName(targetRoleName)) {
      this.fail(seat, `没有这个角色：${targetRoleName}`, 'bad-target')
      return
    }
    this.votes = this.votes.filter((v) => v.voterSeatId !== seat.seatId)
    this.votes.push({ voterSeatId: seat.seatId, targetRoleName, at: Date.now() })
    this.log(`最终投票：${seat.name} → ${targetRoleName}`)
    this.maybeEndVoting()
    this.broadcastView()
  }

  private maybeEndVoting(): void {
    if (this.phase !== 'voting') return
    const voted = new Set(this.votes.map((v) => v.voterSeatId))
    if (!this.seats.every((s) => voted.has(s.seatId))) return
    this.settle()
  }

  private voteCounts(): Record<string, number> {
    const tally: Record<string, number> = {}
    for (const vote of this.votes) {
      tally[vote.targetRoleName] = (tally[vote.targetRoleName] ?? 0) + 1
    }
    return tally
  }

  /** 结算：凶手是唯一最高票 → 平民胜；否则（含平票）凶手逃脱 */
  /**
   * 把这一局的胜负交给档案库（服务端权威，客户端说了不算）。
   * 只记「真人 + 有 playerId + 已拿到角色」的座位；每局只记一次
   * （statsRecorded），settle 被重复调用也不会把战绩刷成两局。
   */
  private recordStats(settlement: SettlementRow[]): void {
    if (this.statsRecorded) return
    this.statsRecorded = true
    if (!this.onGameSettled) return
    const rows: import('./types').SettledPlayerRow[] = []
    const seen = new Set<string>()
    for (const seat of this.seats) {
      if (seat.isBot || !seat.playerId || !seat.roleName) continue
      // 同一台设备 / 同一个档案在这局里占了两个座位（同一个浏览器开两个标签就会这样），
      // 这一局只给他记一次 —— 否则打一局会变成战绩 +2。
      if (seen.has(seat.playerId)) {
        this.log(`档案 ${seat.playerId.slice(0, 8)}… 在这局里有多个座位，战绩只记一次`)
        continue
      }
      seen.add(seat.playerId)
      const row = settlement.find((s) => s.roleName === seat.roleName)
      if (!row) continue
      rows.push({
        playerId: seat.playerId,
        name: seat.name,
        role: seat.roleName,
        isMurderer: row.isMurderer === true,
        win: row.win === true,
      })
    }
    if (rows.length) this.onGameSettled(rows)
  }

  private settle(): void {
    if (this.phase === 'reveal') return
    const script = this.script
    if (!script) {
      this.setPhase('reveal')
      return
    }
    const roles = script.roles
    const tally = this.voteCounts()
    const maxVotes = Math.max(0, ...Object.values(tally))
    const topRoles = roles.filter((r) => (tally[r.name] ?? 0) === maxVotes && maxVotes > 0)
    const murdererName = script.global_truth.murderer_name
    const crowdWins = maxVotes > 0 && topRoles.length === 1 && topRoles[0].name === murdererName

    const settlement: SettlementRow[] = roles.map((role) => ({
      roleName: role.name,
      identity: role.identity,
      isMurderer: role.is_murderer,
      votes: tally[role.name] ?? 0,
      surfaceDone: (tally[role.name] ?? 0) <= Math.floor(roles.length / 2),
      deepDone: role.is_murderer ? !crowdWins : crowdWins,
      win: role.is_murderer ? !crowdWins : crowdWins,
    }))

    const found = this.clues.filter((c) => c.revealed).length
    const review = [
      {
        label: '本局人数',
        value: `${this.playerCount} 人（真人在线 ${this.humanCount()}，AI 补位 ${this.seats.filter((s) => s.isBot).length}）`,
      },
      { label: '实际轮次', value: `第 ${this.round} 轮 / 共 ${this.maxRounds} 轮` },
      {
        label: '线索发放',
        value: `已发放 ${this.releasedTiers.length} 批系统线索，场上共翻出 ${found} 条线索`,
      },
      {
        label: '是否提前结算',
        value: this.accel.suggested
          ? `是（${this.accel.reason || '关键信息已经足够'}）`
          : '否，按既定轮次走完',
      },
    ]

    this.reveal = {
      murdererRoleName: murdererName,
      truth: { ...script.global_truth },
      settlement,
      votes: this.votes.map((v) => ({ ...v })),
      review,
    }
    // 先把战绩交给档案库（每局只记一次），再切阶段广播 —— 顺序反了的话
    // 复盘页可能比档案先到，玩家会看到「这局没记上」。
    this.recordStats(settlement)
    this.setPhase('reveal')
    this.clearTurnTimer()
    this.turnSeatId = null
    this.log(
      `结算：凶手是「${murdererName}」，` +
        (crowdWins ? '唯一最高票 → 平民胜利' : '未被唯一指认 → 凶手逃脱'),
    )
    this.systemSay(
      '真相揭晓',
      `凶手是「${murdererName}」。${crowdWins ? '平民阵营获胜。' : '凶手成功逃脱。'}详见复盘页。`,
    )
  }

  /* ------------------------------------------------------------------ *
   * Bot 自动行动
   * ------------------------------------------------------------------ */

  private botVoteTarget(seat: RoomSeat, round: number): string {
    const roles = this.script?.roles ?? []
    const murdererName = this.script?.global_truth.murderer_name ?? ''
    const index = this.seats.findIndex((s) => s.seatId === seat.seatId)
    const seed = index * 3 + round * 5 + this.code.length + this.round
    return makeBotVoteTarget(roles, murdererName, seat.roleName ?? undefined, seed)
  }

  private scheduleBotStrawVotes(): void {
    this.seats
      .filter((s) => s.isBot)
      .forEach((bot, i) => {
        this.later(700 + i * 300, () => {
          if (this.phase !== 'poll') return
          if (this.strawPoll.some((v) => v.voterSeatId === bot.seatId)) return
          this.strawPoll.push({
            voterSeatId: bot.seatId,
            targetRoleName: this.botVoteTarget(bot, this.round),
            at: Date.now(),
          })
          this.recomputeStraw()
          this.maybeEndPoll()
          this.broadcastView()
        })
      })
  }

  private scheduleBotFinalVotes(): void {
    this.seats
      .filter((s) => s.isBot)
      .forEach((bot, i) => {
        this.later(900 + i * 400, () => {
          if (this.phase !== 'voting') return
          if (this.votes.some((v) => v.voterSeatId === bot.seatId)) return
          this.votes.push({
            voterSeatId: bot.seatId,
            targetRoleName: this.botVoteTarget(bot, this.round),
            at: Date.now(),
          })
          this.log(`最终投票：${bot.name} → ${this.votes[this.votes.length - 1].targetRoleName}`)
          this.maybeEndVoting()
          this.broadcastView()
        })
      })
  }

  /** 防冷场：6 人局半场无人发言时给一次 AI 侦探提示 */
  private scheduleIdleHint(): void {
    const pacing = pacingFor(this.playerCount)
    const seconds = pacing.idleHintSeconds
    if (seconds <= 0) return
    const round = this.round
    this.clearTimer(this.hintTimer)
    this.hintTimer = this.later(seconds * 1000, () => {
      if (this.phase !== 'statement' || this.round !== round) return
      if (this.statements.some((s) => s.round === round && s.kind === 'player')) return
      if (this.hints.some((h) => h.round === round)) return
      const hooks = this.releasedClueTexts().slice(0, 2)
      const text =
        `已经过去 ${seconds} 秒，还没有人开口。给几个具体的抓手：\n` +
        (hooks.length
          ? hooks.map((c, i) => `　${i + 1}. 关于「${c}」，谁最先能说清？`).join('\n')
          : '　1. 先让每个人说清案发前后 30 分钟在哪里。') +
        '\n建议从时间线入手：让每个人按顺序复述自己的行动轨迹，再对着矛盾点追问。'
      this.hints.push({ round, text })
      this.systemSay('AI 侦探提示', text)
      this.log('防冷场：已广播 AI 侦探提示')
      this.broadcastView()
    })
  }

  /* ------------------------------------------------------------------ *
   * 公屏文字 + 实时语音（信令中转）
   * ------------------------------------------------------------------ */

  /**
   * 公屏文字：清洗 → 限流 → 存历史 → 广播。
   *
   * 为什么收到 chat 不重新广播整份 view：
   *   公屏是全房间最高频的操作（限流允许每秒十几条），而 view 是完整快照
   *   （含剧本包）。每条消息都给 6 个人各推一份 view 是纯浪费；
   *   即时刷新靠 `t:'chat'` 这一帧，`view.chats` 只在加入 / 重连 /
   *   其它状态变化导致的广播里补齐历史。
   */
  private handleChat(seat: RoomSeat, raw: unknown): void {
    const text = sanitizeChatText(raw)
    if (!text) {
      this.fail(seat, '公屏消息不能为空', 'chat-empty')
      return
    }

    const now = this.clock()
    // ① 同一座位两条之间至少 CHAT_MIN_INTERVAL_MS
    const last = this.chatLastAt.get(seat.seatId)
    if (last !== undefined && now - last < CHAT_MIN_INTERVAL_MS) {
      this.fail(seat, `发得太快了，两条公屏之间至少间隔 ${CHAT_MIN_INTERVAL_MS} 毫秒`, 'chat-too-fast')
      return
    }
    // ② 每秒上限：座位级 + 房间级，超了就丢（只回一条 error，绝不攒队列刷爆服务器）
    const mine = (this.chatTimes.get(seat.seatId) ?? []).filter((t) => now - t < 1000)
    const roomWindow = this.chatWindow.filter((t) => now - t < 1000)
    if (mine.length >= CHAT_PER_SECOND || roomWindow.length >= CHAT_PER_SECOND) {
      this.fail(seat, '公屏消息过于频繁，请稍后再发', 'chat-flood')
      return
    }

    this.chatSeq += 1
    const msg: ChatMessage = {
      id: `c${this.chatSeq}`,
      seatId: seat.seatId,
      name: seat.name,
      text: truncateChatText(text),
      at: now,
    }
    // 定长历史：超出上限从头部丢掉最老的（先进先出，永远是时间正序）
    const willEvict = this.chats.length >= CHAT_HISTORY
    this.chats.push(msg)
    if (this.chats.length > CHAT_HISTORY) this.chats.splice(0, this.chats.length - CHAT_HISTORY)

    mine.push(now)
    this.chatTimes.set(seat.seatId, mine)
    roomWindow.push(now)
    this.chatWindow = roomWindow
    this.chatLastAt.set(seat.seatId, now)

    // 日志**不记公屏正文**（终端是公开可见的），只在刚开始滚动淘汰时提一句
    if (willEvict && !this.chatTrimmedOnce) {
      this.chatTrimmedOnce = true
      this.log(`公屏历史已达上限（${CHAT_HISTORY} 条），最老的开始滚动淘汰`)
    }
    for (const s of this.seats) {
      if (s.isBot || !s.connected) continue
      this.send(s, { t: 'chat', msg })
    }
  }

  /** 加入语音：幂等（已在里面就什么都不做），广播 view 让别人来连我 */
  private handleVoiceJoin(seat: RoomSeat): void {
    if (this.voiceMembers.has(seat.seatId)) return
    this.voiceMembers.set(seat.seatId, false)
    this.log(`语音：${seat.name} 加入了语音通话（在麦 ${this.voiceMembers.size} 人）`)
    this.toastAll(`${seat.name} 加入了语音`, 'info')
    this.broadcastView()
  }

  /** 退出语音：把所有人对我的 PeerConnection 拆掉（各端按新 view 自行处理） */
  private handleVoiceLeave(seat: RoomSeat): void {
    if (!this.voiceMembers.delete(seat.seatId)) return
    this.log(`语音：${seat.name} 退出了语音通话（在麦 ${this.voiceMembers.size} 人）`)
    this.toastAll(`${seat.name} 退出了语音`, 'info')
    this.broadcastView()
  }

  /** 静音切换：只是公开状态（让别人看到 🔇），不影响音频流本身 */
  private handleVoiceMute(seat: RoomSeat, muted: boolean): void {
    if (!this.voiceMembers.has(seat.seatId)) return
    if (this.voiceMembers.get(seat.seatId) === muted) return
    this.voiceMembers.set(seat.seatId, muted)
    this.log(`语音：${seat.name} ${muted ? '已静音' : '取消了静音'}`)
    this.broadcastView()
  }

  /**
   * 语音信令中转：服务器只做搬运工。
   *   - 音频本身走 WebRTC 端到端（P2P），服务器**不做 SFU/MCU、不录音、不落盘**；
   *   - 信令不进 view、不存历史、不进日志正文（SDP 里带 IP 与网络细节）；
   *   - 目标不存在 / 发送者不在语音里 / 结构非法 → 一律静默忽略（不报错、不断线）。
   */
  private handleVoiceSignal(seat: RoomSeat, toSeatId: unknown, data: unknown): void {
    if (typeof toSeatId !== 'string' || !toSeatId) return
    const target = this.seatById(toSeatId)
    // 发给自己没有意义（也不会有人接），直接忽略
    if (!target || target.seatId === seat.seatId) return
    // 不在语音里就没有资格占用这条通道
    if (!this.voiceMembers.has(seat.seatId)) return
    const signal = sanitizeVoiceSignal(data)
    if (!signal) return
    // ⚠️ 只记「谁的什么信令转给谁」这类元信息，绝不记 sdp / candidate 内容
    this.log(`语音信令：${seat.name} 的 ${signal.kind} 转给 ${target.name}`)
    if (target.isBot || !target.connected || !target.socket) return
    this.send(target, { t: 'voice-signal', fromSeatId: seat.seatId, data: signal })
  }

  /* ------------------------------------------------------------------ *
   * 消息入口
   * ------------------------------------------------------------------ */

  /** 处理一条客户端消息（create / join / rejoin / ping 由 app.ts 处理） */
  handle(seat: RoomSeat, msg: ClientMsg): void {
    this.lastActivity = Date.now()
    switch (msg.t) {
      case 'ready':
        seat.ready = msg.ready === true
        if (this.phase === 'reading') seat.readConfirmed = seat.ready
        this.log(`${seat.name} ${seat.ready ? '已就绪' : '取消就绪'}`)
        this.toastAll(`${seat.name} ${seat.ready ? '已就绪' : '取消就绪'}`, 'info')
        this.broadcastView()
        return

      case 'start':
        void this.start(seat)
        return

      case 'advance':
        if (seat.seatId !== this.hostSeatId) {
          this.fail(seat, '只有房主可以推进阶段', 'not-host')
          return
        }
        this.log(`房主手动推进阶段：${phaseText(this.phase)}`)
        this.advancePhase()
        this.broadcastView()
        return

      case 'speak': {
        if (this.phase !== 'statement') {
          this.fail(seat, '现在不是发言环节', 'bad-phase')
          return
        }
        if (this.turnSeatId !== seat.seatId) {
          this.fail(seat, '还没轮到你发言', 'not-your-turn')
          return
        }
        const text = String(msg.text ?? '').trim()
        if (!text) {
          this.fail(seat, '发言内容不能为空', 'empty-text')
          return
        }
        this.commitStatement(seat, text.slice(0, 2000), false)
        this.broadcastView()
        return
      }

      case 'pass': {
        if (seat.seatId !== this.hostSeatId) {
          this.fail(seat, '只有房主可以跳过发言人', 'not-host')
          return
        }
        if (this.phase !== 'statement') {
          this.fail(seat, '现在不是发言环节', 'bad-phase')
          return
        }
        const current = this.turnSeatId ? this.seatById(this.turnSeatId) : undefined
        if (!current) {
          this.fail(seat, '当前没有发言人', 'no-speaker')
          return
        }
        this.clearTurnTimer()
        this.systemSay('发言跳过', `房主跳过了 ${current.name} 的发言。`)
        this.log(`房主跳过发言：${current.name}`)
        this.spokenSeatIds.add(current.seatId)
        this.advanceTurn()
        this.broadcastView()
        return
      }

      case 'search':
        this.handleSearch(seat, String(msg.location ?? ''))
        return

      case 'clue':
        this.handleClueDecision(seat, String(msg.clueId ?? ''), msg.public === true)
        return

      case 'straw-vote':
        this.handleStrawVote(seat, String(msg.targetRoleName ?? ''))
        return

      case 'vote':
        this.handleVote(seat, String(msg.targetRoleName ?? ''))
        return

      case 'add-bot': {
        if (seat.seatId !== this.hostSeatId) {
          this.fail(seat, '只有房主可以补 AI 玩家', 'not-host')
          return
        }
        if (this.started) {
          this.fail(seat, '对局已经开始，不能补 AI 玩家', 'started')
          return
        }
        if (this.full()) {
          this.fail(seat, `房间已满（${this.playerCount} 人）`, 'room-full')
          return
        }
        const bot = this.addSeat({
          name: `AI 玩家${this.humanCount() + 1}`,
          isBot: true,
          connected: true,
          ready: true,
          host: false,
        })
        this.log(`房主补了一个 AI 玩家：${bot.name}`)
        this.toastAll(`${bot.name} 加入了房间`, 'info')
        this.broadcastView()
        return
      }

      case 'leave':
        this.leaveSeat(seat)
        return

      case 'chat':
        this.handleChat(seat, msg.text)
        return

      case 'voice-join':
        this.handleVoiceJoin(seat)
        return

      case 'voice-leave':
        this.handleVoiceLeave(seat)
        return

      case 'voice-mute':
        this.handleVoiceMute(seat, msg.muted === true)
        return

      case 'voice-signal':
        this.handleVoiceSignal(seat, msg.toSeatId, msg.data)
        return

      default:
        this.fail(seat, '房间服务器不认识这条指令', 'unknown-msg')
        return
    }
  }
}

/** 生成一个当前房间表里没有用过的房号 */
export function uniqueRoomCode(rooms: Map<string, Room>): string {
  for (let i = 0; i < 50; i += 1) {
    const code = makeRoomCode()
    if (!rooms.has(code)) return code
  }
  return `${makeRoomCode()}${Math.floor(Math.random() * 10)}`
}
