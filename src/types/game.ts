import type { ClueItem, ScriptPackage } from './script'

/**
 * 游戏流程状态机（控制层）
 * ------------------------------------------------------------------
 * 严格遵循《核心系统架构设计》，并按产品给的节奏规范多轮化：
 *
 *   大厅匹配 → 剧本下发 → 阅读剧本
 *   → 第 1 轮陈述 → [搜证] → 意向投票
 *   → 第 2 轮陈述 → [搜证] → 意向投票
 *   → 第 3 轮陈述 → [搜证]        （轮次数按人数：4 人 2 轮 / 5、6 人 3 轮）
 *   → 个人整理 → 投票 → 复盘结算
 *
 * 6 人局每轮之后有搜证环节；4/5 人局的线索由系统按轮次发放。
 * 意向投票后若满足「提前结算」条件，会提示跳过剩余轮次直接进入整理与投票。
 */
export type GamePhase =
  | 'lobby' // 大厅匹配
  | 'room' // 房间准备（剧本下发前）
  | 'dealing' // 剧本下发（AI 生成中）
  | 'reading' // 阅读阶段
  | 'statement' // 集中陈述（按轮次重复）
  | 'search' // 自由搜证（6 人局每轮一次）
  | 'poll' // 意向投票（轮间，用于判断提前结算）
  | 'organize' // 个人整理
  | 'voting' // 最终投票
  | 'reveal' // 复盘结算

export interface PhaseMeta {
  key: GamePhase
  /** 阶段中文名 */
  label: string
  /** 阶段说明 */
  desc: string
  /** 建议时长（秒）；动态时长（阅读、陈述）以 rules.ts 为准 */
  duration: number
}

export const PHASES: PhaseMeta[] = [
  { key: 'lobby', label: '大厅', desc: '创建或加入一个房间', duration: 0 },
  { key: 'room', label: '组局', desc: '等待玩家就位并确认剧本配置', duration: 0 },
  { key: 'dealing', label: '下发剧本', desc: 'AI 引擎生成全局真相与角色剧本', duration: 0 },
  { key: 'reading', label: '阅读剧本', desc: '读你的本，记住你的秘密', duration: 600 },
  { key: 'statement', label: '集中陈述', desc: '轮流开口，谁在撒谎？', duration: 300 },
  { key: 'search', label: '自由搜证', desc: '翻找现场，线索不会自己说话', duration: 240 },
  { key: 'poll', label: '意向投票', desc: '先摸一次底，看看票往哪儿走', duration: 60 },
  { key: 'organize', label: '个人整理', desc: '把线索钉上你自己的推理板', duration: 300 },
  { key: 'voting', label: '最终投票', desc: '指认你心中的凶手', duration: 120 },
  { key: 'reveal', label: '复盘结算', desc: '真相揭晓，任务清算', duration: 0 },
]

export function phaseMeta(phase: GamePhase): PhaseMeta {
  return PHASES.find((p) => p.key === phase) ?? PHASES[0]
}

/** 房内座位（玩家） */
export interface Seat {
  id: string
  /** 昵称 */
  name: string
  /** 头像 emoji */
  avatar: string
  /** 是否是自己 */
  isSelf: boolean
  /** 是否为 AI 补位玩家 */
  isBot: boolean
  /** 是否已准备 */
  ready: boolean
  /** 绑定的角色姓名（下发剧本后填充） */
  roleName?: string
  /** 是否已确认阅读 */
  readConfirmed: boolean
  /** 是否存活（死亡/出局状态，后续版本使用） */
  alive: boolean
}

/** 凶手特权触发结果（第 2 轮开始时下发） */
export interface PrivilegeFeed {
  /** 触发时所在的轮次 */
  round: number
  /** 模糊心理感知文本 */
  hint: string
  /** 生成时间戳 */
  at: number
}

/** 一条发言记录（玩家发言或系统播报） */
export interface Statement {
  seatId: string
  roleName: string
  text: string
  /** 第几轮的发言 */
  round: number
  /** 发言类型：玩家 / 系统播报（线索发放、AI 侦探提示） */
  kind: 'player' | 'system'
  /** 是否为系统代发的模拟发言 */
  simulated: boolean
  /** 系统播报的小标题 */
  title?: string
  at: number
}

/** 投票记录 */
export interface VoteRecord {
  /** 投票人座位 id */
  voterSeatId: string
  /** 被指认的角色姓名 */
  targetRoleName: string
  at: number
}

/** 轮次小结（用于判断提前结算） */
export interface RoundSummary {
  round: number
  /** 意向票型：角色姓名 → 票数 */
  tally: Record<string, number>
  /** 本轮最高票角色 */
  top: string | null
  topVotes: number
  /** 是否满足提前结算条件 */
  accelerate: boolean
  /** 触发原因文案 */
  reason: string
}

/** 复盘结算条目 */
export interface SettlementRow {
  roleName: string
  identity: string
  isMurderer: boolean
  /** 被投票数 */
  votes: number
  /** 表层任务是否达成 */
  surfaceDone: boolean
  /** 深层任务是否达成 */
  deepDone: boolean
  /** 该角色是否获胜 */
  win: boolean
}

/** 一局游戏的完整运行时状态 */
export interface GameState {
  phase: GamePhase
  roomCode: string
  seats: Seat[]
  /** 剧本包 */
  script: ScriptPackage | null
  /** 自己的座位 id */
  selfSeatId: string
  /** 凶手座位 id */
  murdererSeatId: string | null

  // ---- 轮次 ----
  /** 当前轮次（从 1 开始） */
  round: number
  /** 本局最大轮次 */
  maxRounds: number
  /** 需要搜证的轮次数 */
  searchRounds: number
  /** 已发放的线索批次 tier 列表 */
  releasedTiers: number[]
  /** 每轮结束时的意向票型快照 */
  roundSummaries: RoundSummary[]
  /** 系统判定可以提前结算 */
  accelerateSuggested: boolean
  /** 提前结算的提示文案 */
  accelerateReason: string
  /** 凶手特权是否已触发 */
  privilege: PrivilegeFeed | null

  /** 发言记录（含系统播报） */
  statements: Statement[]
  /** 当前发言序号 */
  statementIndex: number

  /** 线索池 */
  clues: ClueItem[]
  /** 本轮剩余的搜证次数 */
  searchLeft: number
  /** 个人笔记 */
  notes: string
  /** 最终投票记录 */
  votes: VoteRecord[]
  /** 意向投票记录 */
  strawPoll: VoteRecord[]
  /** 复盘结算表 */
  settlement: SettlementRow[]
  /** 是否开启上帝视角（单人演示：可切换查看任意角色剧本） */
  godMode: boolean
  /** 正在阅读的角色索引 */
  readingRoleIndex: number
  /** 已触发的 AI 侦探提示次数（防冷场） */
  detectiveHints: number

  // ---- 联机（由 stores/net.ts 维护，联机时一切以服务器下发为准） ----
  /** 是否处于联机模式 */
  online: boolean
  /** 联机时服务器指定的当前发言人座位 id */
  onlineTurnSeatId: string | null
}

/** 生成房间号 */
export function makeRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 5; i += 1) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

/** 座位默认头像 */
export const AVATARS = ['🎭', '🕯️', '🗝️', '🩸', '🃏', '🪞', '⏳', '🖤']