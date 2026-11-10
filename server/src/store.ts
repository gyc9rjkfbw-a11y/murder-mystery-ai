/**
 * 玩家档案（服务端持久化）
 * ==================================================================
 * 为什么需要这一层：房间和座位全是内存状态，服务器一重启 / 房间一回收，
 * 玩家的昵称、头像、战绩就全没了；`create` / `join` 也只带一个昵称字符串，
 * 服务器根本不认识「同一个人」。这里给「设备档案」一个落盘的家。
 *
 * 设计约束（每一条都是刻意的）：
 *   1. **零依赖**：只用 `node:fs`，单文件 JSON + 原子写（tmp → rename）。
 *      顺带做一个 `profiles.json.bak`，rename 之后再抄一份，防手滑删库。
 *   2. **绝不存密钥**：`ai.apiKey` 无论客户端发什么都丢弃，既不落盘也不回显。
 *      服务器没有理由拿到玩家的大模型密钥。
 *   3. **坏文件不致命**：解析失败就把原文件改名成 `.corrupt-<时间>` 备份，
 *      然后从空库开始 —— 服务器必须能起来，不能因为一个坏 JSON 就挂。
 *   4. **有界**：档案数、历史条数、单字段长度全都有上限，防止有人刷爆磁盘。
 *   5. **战绩以服务器为准**：由房间在复盘时结算后调用 `recordGame()`，
 *      不接受客户端上报的胜负（客户端说什么都不算）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 落盘文件名（放在 dataDir 下） */
export const PROFILE_FILE = 'profiles.json'
/** 备份文件名 */
export const PROFILE_BACKUP = 'profiles.json.bak'

/** 各类上限：都按「够用但不失控」取值，改这里就能全局生效 */
export const PROFILE_LIMITS = {
  /** 玩家 ID：只允许这几种字符，长度 8-40（客户端生成的是 uuid） */
  idPattern: /^[A-Za-z0-9_-]{8,40}$/,
  nameLen: 16,
  avatarLen: 8,
  modelLen: 60,
  baseUrlLen: 200,
  providerLen: 16,
  /** 每人保留最近多少局 */
  historyLen: 30,
  /** 最多存多少个档案，超了按「最久没上线」淘汰 */
  profiles: 5000,
  /** 单次请求体上限（字节），超过直接 413 */
  bodyBytes: 4096,
} as const

/** AI 引擎偏好（**不含密钥**；密钥永远只留在玩家自己的浏览器里） */
export interface AiPrefs {
  provider: string
  model: string
  baseUrl: string
}

/** 一局的结果记录 */
export interface GameRecord {
  /** 复盘时间（毫秒时间戳） */
  at: number
  roomCode: string
  theme: string
  playerCount: number
  result: 'win' | 'lose'
  /** 本局扮演的角色名 */
  role: string
  isMurderer: boolean
}

/** 累计战绩 */
export interface PlayerStats {
  games: number
  wins: number
  losses: number
  /** 拿到凶手身份的局数 */
  asMurderer: number
  /** 其中凶手逃脱（赢）的局数 */
  murdererWins: number
}

export interface PlayerProfile {
  id: string
  name: string
  avatar: string
  createdAt: number
  updatedAt: number
  lastSeenAt: number
  stats: PlayerStats
  history: GameRecord[]
  ai: AiPrefs
}

/** 落盘结构（带版本号，将来能平滑升级） */
export interface ProfileFile {
  v: 1
  players: Record<string, PlayerProfile>
}

export interface StoreOptions {
  /** 数据目录，默认 <项目根>/server/data */
  dir?: string
  /** 时间源（测试用） */
  now?: () => number
  /** 最多档案数，默认 PROFILE_LIMITS.profiles */
  maxProfiles?: number
  /** 安静模式：不打印任何提示（测试用） */
  quiet?: boolean
}

/** 去控制字符、折叠空白、trim，并按**码点**截断（不会把 emoji 劈成两半） */
export function cleanText(raw: unknown, max: number): string {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const points = Array.from(text)
  return points.length <= max ? text : points.slice(0, max).join('')
}

/** 校验玩家 ID；不合法返回空串（调用方据此回 400） */
export function normalizePlayerId(raw: unknown): string {
  const id = String(raw ?? '').trim()
  return PROFILE_LIMITS.idPattern.test(id) ? id : ''
}

export function sanitizeAvatar(raw: unknown, fallback = '🖤'): string {
  return cleanText(raw, PROFILE_LIMITS.avatarLen) || fallback
}

/**
 * 清洗 AI 偏好。
 * ⚠️ 只认 provider / model / baseUrl 三个字段，**其它一律丢弃**（尤其是 apiKey）。
 */
export function sanitizeAi(raw: unknown): AiPrefs {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const provider = cleanText(obj.provider, PROFILE_LIMITS.providerLen) || 'offline'
  const allowed = provider === 'openai' ? 'openai' : 'offline'
  return {
    provider: allowed,
    model: cleanText(obj.model, PROFILE_LIMITS.modelLen),
    baseUrl: cleanText(obj.baseUrl, PROFILE_LIMITS.baseUrlLen),
  }
}

export function emptyStats(): PlayerStats {
  return { games: 0, wins: 0, losses: 0, asMurderer: 0, murdererWins: 0 }
}

export function emptyProfile(id: string, now: number, name = '玩家', avatar = '🖤'): PlayerProfile {
  return {
    id,
    name,
    avatar,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    stats: emptyStats(),
    history: [],
    ai: sanitizeAi(null),
  }
}

/** 把客户端发来的一局记录清洗成可信形状（时间戳由服务器给，不信客户端） */
export function sanitizeGameRecord(
  raw: unknown,
  fallback: { at: number; roomCode?: string; theme?: string; playerCount?: number },
): GameRecord | null {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const result = obj.result === 'win' ? 'win' : obj.result === 'lose' ? 'lose' : ''
  if (!result) return null
  return {
    at: Number.isFinite(obj.at) ? Number(obj.at) : fallback.at,
    roomCode: cleanText(obj.roomCode ?? fallback.roomCode, 8),
    theme: cleanText(obj.theme ?? fallback.theme, 40),
    playerCount: Number(obj.playerCount ?? fallback.playerCount) || 0,
    result,
    role: cleanText(obj.role, 24),
    isMurderer: obj.isMurderer === true,
  }
}

/** 从磁盘内容还原成 Map；任何一条坏数据都跳过而不是整体失败 */
function parseFile(raw: string): { players: Map<string, PlayerProfile>; skipped: number } {
  const players = new Map<string, PlayerProfile>()
  const parsed = JSON.parse(raw) as Partial<ProfileFile>
  const source = parsed && typeof parsed === 'object' ? parsed.players : null
  let skipped = 0
  if (!source || typeof source !== 'object') return { players, skipped }
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const id = normalizePlayerId(obj.id ?? key)
    if (!id) {
      skipped += 1
      continue
    }
    const stats = (obj.stats && typeof obj.stats === 'object' ? obj.stats : {}) as Record<string, unknown>
    const history = Array.isArray(obj.history) ? obj.history : []
    players.set(id, {
      id,
      name: cleanText(obj.name, PROFILE_LIMITS.nameLen) || '玩家',
      avatar: sanitizeAvatar(obj.avatar),
      createdAt: Number(obj.createdAt) || 0,
      updatedAt: Number(obj.updatedAt) || 0,
      lastSeenAt: Number(obj.lastSeenAt) || 0,
      stats: {
        games: Math.max(0, Number(stats.games) || 0),
        wins: Math.max(0, Number(stats.wins) || 0),
        losses: Math.max(0, Number(stats.losses) || 0),
        asMurderer: Math.max(0, Number(stats.asMurderer) || 0),
        murdererWins: Math.max(0, Number(stats.murdererWins) || 0),
      },
      history: history
        .map((h) => sanitizeGameRecord(h, { at: 0 }))
        .filter((h): h is GameRecord => h !== null)
        .slice(-PROFILE_LIMITS.historyLen),
      ai: sanitizeAi(obj.ai),
    })
  }
  return { players, skipped }
}

/**
 * 档案库。
 * 读写在内存里完成，落盘是**去抖**的（默认 250ms 内的多次修改合并成一次写），
 * 进程退出 / 关闭服务器时用 `close()` 强制落盘。
 */
export class ProfileStore {
  readonly dir: string
  readonly filePath: string
  private readonly players = new Map<string, PlayerProfile>()
  private readonly now: () => number
  private readonly maxProfiles: number
  private readonly quiet: boolean
  private saveTimer: NodeJS.Timeout | null = null
  private writes = 0
  private closed = false

  constructor(options: StoreOptions = {}) {
    this.dir = path.resolve(options.dir ?? path.join(process.cwd(), 'server', 'data'))
    this.filePath = path.join(this.dir, PROFILE_FILE)
    this.now = options.now ?? (() => Date.now())
    this.maxProfiles = Math.max(1, options.maxProfiles ?? PROFILE_LIMITS.profiles)
    this.quiet = options.quiet === true
    this.load()
  }

  private say(line: string): void {
    if (!this.quiet) console.log(`[档案] ${line}`)
  }

  /** 启动时读一次；文件不存在 / 坏掉都不抛错 */
  load(): void {
    this.players.clear()
    let raw = ''
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch {
      return // 没文件 = 全新安装，正常
    }
    try {
      const { players, skipped } = parseFile(raw)
      for (const [id, p] of players) this.players.set(id, p)
      if (skipped > 0) this.say(`跳过 ${skipped} 条格式不对的档案`)
      if (this.players.size > 0) this.say(`已载入 ${this.players.size} 个玩家档案`)
    } catch (e) {
      const backup = `${this.filePath}.corrupt-${this.now()}`
      try {
        fs.renameSync(this.filePath, backup)
        this.say(`档案文件损坏（${(e as Error).message}），已备份为 ${path.basename(backup)}，从空库开始`)
      } catch {
        this.say(`档案文件损坏且无法备份（${(e as Error).message}），从空库开始`)
      }
      this.players.clear()
    }
  }

  get(id: unknown): PlayerProfile | null {
    const key = normalizePlayerId(id)
    if (!key) return null
    const found = this.players.get(key)
    return found ? cloneProfile(found) : null
  }

  count(): number {
    return this.players.size
  }

  /** 落盘状态（健康检查 / 测试用） */
  statsSnapshot(): { profileCount: number; fileBytes: number; writes: number; filePath: string } {
    let fileBytes = 0
    try {
      fileBytes = fs.statSync(this.filePath).size
    } catch {
      fileBytes = 0
    }
    return { profileCount: this.players.size, fileBytes, writes: this.writes, filePath: this.filePath }
  }

  /**
   * 创建或更新档案（昵称 / 头像 / AI 偏好）。
   * 只有显式传进来的字段才会被改，`undefined` 表示「这次不动」。
   */
  upsert(input: { id: unknown; name?: unknown; avatar?: unknown; ai?: unknown }): PlayerProfile | null {
    const id = normalizePlayerId(input.id)
    if (!id) return null
    const now = this.now()
    const existing = this.players.get(id)
    const profile = existing ? cloneProfile(existing) : emptyProfile(id, now)
    if (input.name !== undefined) profile.name = cleanText(input.name, PROFILE_LIMITS.nameLen) || profile.name
    if (input.avatar !== undefined) profile.avatar = sanitizeAvatar(input.avatar, profile.avatar)
    if (input.ai !== undefined) profile.ai = sanitizeAi(input.ai)
    profile.updatedAt = now
    profile.lastSeenAt = now
    this.players.set(id, profile)
    this.trimOverflow()
    this.scheduleSave()
    return cloneProfile(profile)
  }

  /** 入座 / 重连时刷新「最近上线」与昵称头像（不改 AI 偏好与战绩） */
  touch(input: { id: unknown; name?: unknown; avatar?: unknown }): PlayerProfile | null {
    const id = normalizePlayerId(input.id)
    if (!id) return null
    const existing = this.players.get(id)
    if (!existing) return null
    const profile = cloneProfile(existing)
    if (input.name !== undefined) {
      const name = cleanText(input.name, PROFILE_LIMITS.nameLen)
      if (name) profile.name = name
    }
    if (input.avatar !== undefined) profile.avatar = sanitizeAvatar(input.avatar, profile.avatar)
    profile.lastSeenAt = this.now()
    this.players.set(id, profile)
    this.scheduleSave()
    return cloneProfile(profile)
  }

  /**
   * 记一局战绩。**由服务器在复盘时调用**，客户端上报的胜负一律不采信。
   * 每局每个座位只应该调用一次（房间侧用 `statsRecorded` 保证）。
   */
  recordGame(
    id: unknown,
    record: Omit<GameRecord, 'at'> & { at?: number },
  ): PlayerProfile | null {
    const key = normalizePlayerId(id)
    if (!key) return null
    const now = this.now()
    const existing = this.players.get(key)
    const profile = existing ? cloneProfile(existing) : emptyProfile(key, now)
    const result: 'win' | 'lose' = record.result === 'win' ? 'win' : 'lose'
    const entry: GameRecord = {
      at: Number.isFinite(record.at) ? Number(record.at) : now,
      roomCode: cleanText(record.roomCode, 8),
      theme: cleanText(record.theme, 40),
      playerCount: Number(record.playerCount) || 0,
      result,
      role: cleanText(record.role, 24),
      isMurderer: record.isMurderer === true,
    }
    profile.stats.games += 1
    if (result === 'win') profile.stats.wins += 1
    else profile.stats.losses += 1
    if (entry.isMurderer) {
      profile.stats.asMurderer += 1
      if (result === 'win') profile.stats.murdererWins += 1
    }
    profile.history = [...profile.history, entry].slice(-PROFILE_LIMITS.historyLen)
    profile.lastSeenAt = now
    this.players.set(key, profile)
    this.trimOverflow()
    this.scheduleSave()
    return cloneProfile(profile)
  }

  /** 超出上限时按「最久没上线」淘汰，避免文件无限长大 */
  private trimOverflow(): void {
    if (this.players.size <= this.maxProfiles) return
    const sorted = [...this.players.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)
    const drop = this.players.size - this.maxProfiles
    for (const victim of sorted.slice(0, drop)) this.players.delete(victim.id)
    this.say(`档案数超过上限 ${this.maxProfiles}，淘汰了 ${drop} 个最久未上线的档案`)
  }

  private scheduleSave(): void {
    if (this.closed) return
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 250)
    this.saveTimer.unref?.()
  }

  /** 立即落盘（原子写：先写 .tmp 再 rename，避免半截 JSON） */
  flush(): void {
    if (this.closed) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const payload: ProfileFile = { v: 1, players: Object.fromEntries(this.players) }
    let json = ''
    try {
      json = JSON.stringify(payload)
    } catch (e) {
      this.say(`序列化档案失败：${(e as Error).message}`)
      return
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, json, 'utf8')
      fs.renameSync(tmp, this.filePath)
      // rename 已经是原子的；再抄一份备份，给人一个「手滑也能救」的机会
      try {
        fs.writeFileSync(path.join(this.dir, PROFILE_BACKUP), json, 'utf8')
      } catch {
        /* 备份失败不影响主流程 */
      }
      this.writes += 1
    } catch (e) {
      this.say(`写档案失败（磁盘只读或权限不足？）：${(e as Error).message}`)
    }
  }

  /** 关服前调用：强制落盘并停止去抖计时器 */
  close(): void {
    if (this.closed) return
    this.flush()
    this.closed = true
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }
}

/** 导出副本，别让调用方改到内部状态 */
function cloneProfile(p: PlayerProfile): PlayerProfile {
  return {
    ...p,
    stats: { ...p.stats },
    history: p.history.map((h) => ({ ...h })),
    ai: { ...p.ai },
  }
}