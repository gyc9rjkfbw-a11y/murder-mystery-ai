/**
 * 玩家档案（服务端的业务层）
 * ==================================================================
 * 为什么需要这一层：房间和座位全是内存状态，服务器一重启 / 房间一回收，
 * 玩家的昵称、头像、战绩就全没了。这里给「设备档案」一个落盘的家。
 *
 * 存储已经换成 **SQLite 数据库**（`players.db`，见 db.ts）：
 *   整份 JSON 全量重写那套不抗并发、也没法保证「一局战绩 + 统计」的原子性，
 *   而玩家的战绩是只会变多的账，必须由带事务与约束的数据库来管。
 *
 * 这一层只做**清洗与业务规则**，完整性交给数据库：
 *   1. **绝不存密钥**：`ai.apiKey` 无论客户端发什么都丢弃，既不落盘也不回显。
 *      数据库里根本没有放密钥的列。
 *   2. **战绩以服务器为准**：房间在复盘时调用 `recordGame()`，
 *      不接受客户端上报的胜负（客户端说什么都不算）。
 *   3. **重复结算不重复记账**：同一玩家 + 同一房间 2 秒内的同一条记录视为重试。
 *   4. **有界**：档案数、历史条数、单字段长度全都有上限。
 *   5. **老数据不丢**：首次启动若发现旧的 `profiles.json`，自动整库导入并改名留档。
 *
 * 坏库不致命：integrity 检查失败 → 隔离 → 从 `players.db.bak` 恢复 → 最后才空库启动。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  DB_BACKUP,
  DB_FILE,
  DB_SCHEMA_VERSION,
  PlayersDb,
  type AiRow,
  type GameRow,
  type IntegrityReport,
  type PlayerBundle,
} from './db'

/** 旧版 JSON 文件名（只用于首次迁移） */
export const PROFILE_FILE = 'profiles.json'
/** 旧版备份文件名（只用于首次迁移） */
export const PROFILE_BACKUP = 'profiles.json.bak'
export { DB_FILE, DB_BACKUP }

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
  /** 偏好题材最多记几个、每个最长多少字 */
  genresLen: 6,
  genreLen: 24,
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
  /** 偏好题材（喜欢哪几类剧本；服务端也存一份，换设备才带得走） */
  genres: string[]
}

/** 旧版落盘结构（只用于迁移读取） */
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

/** 清洗偏好题材：去重、限量、保序 */
export function sanitizeGenres(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const label = cleanText(item, PROFILE_LIMITS.genreLen)
    if (!label || out.includes(label)) continue
    out.push(label)
    if (out.length >= PROFILE_LIMITS.genresLen) break
  }
  return out
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
    genres: [],
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

/** 从旧版 JSON 内容还原成 Map；任何一条坏数据都跳过而不是整体失败 */
function parseLegacyFile(raw: string): { players: Map<string, PlayerProfile>; skipped: number } {
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
      genres: sanitizeGenres(obj.genres),
    })
  }
  return { players, skipped }
}

/** 数据库行 → 对外形状 */
function toProfile(bundle: PlayerBundle): PlayerProfile {
  const { player, stats, ai, genres, games } = bundle
  return {
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    createdAt: Number(player.created_at) || 0,
    updatedAt: Number(player.updated_at) || 0,
    lastSeenAt: Number(player.last_seen_at) || 0,
    stats: {
      games: Number(stats.games) || 0,
      wins: Number(stats.wins) || 0,
      losses: Number(stats.losses) || 0,
      asMurderer: Number(stats.as_murderer) || 0,
      murdererWins: Number(stats.murderer_wins) || 0,
    },
    history: games.map((g: GameRow) => ({
      at: Number(g.played_at) || 0,
      roomCode: g.room_code,
      theme: g.theme,
      playerCount: Number(g.player_count) || 0,
      result: g.result === 'win' ? 'win' : 'lose',
      role: g.role,
      isMurderer: g.is_murderer === 1,
    })),
    ai: { provider: ai.provider, model: ai.model, baseUrl: ai.base_url },
    genres: [...genres],
  }
}

/** 落盘状态（健康检查 / 测试用） */
export interface StoreSnapshot {
  profileCount: number
  fileBytes: number
  writes: number
  filePath: string
  backupPath: string
  backupBytes: number
  games: number
  schemaVersion: number
  engine: 'sqlite'
  integrity: IntegrityReport
}

/**
 * 档案库。
 * 每次写都是**一个 SQLite 事务**（提交即落盘，WAL + synchronous=FULL），
 * 所以不再需要「去抖 + 全量重写」；`flush()` 只负责 checkpoint 与备份。
 */
export class ProfileStore {
  readonly dir: string
  readonly filePath: string
  readonly backupPath: string
  private readonly db: PlayersDb
  private readonly now: () => number
  private readonly maxProfiles: number
  private readonly quiet: boolean
  private closed = false

  constructor(options: StoreOptions = {}) {
    this.dir = path.resolve(options.dir ?? path.join(process.cwd(), 'server', 'data'))
    this.filePath = path.join(this.dir, DB_FILE)
    this.backupPath = path.join(this.dir, DB_BACKUP)
    this.now = options.now ?? (() => Date.now())
    this.maxProfiles = Math.max(1, options.maxProfiles ?? PROFILE_LIMITS.profiles)
    this.quiet = options.quiet === true
    this.db = new PlayersDb({
      file: this.filePath,
      now: this.now,
      onLog: (line) => this.say(line),
    })
    this.migrateLegacy()
    this.say(`玩家数据库就绪（${this.db.count()} 份档案 · ${this.db.gameCount()} 条对局）`)
  }

  private say(line: string): void {
    if (!this.quiet) console.log(`[档案] ${line}`)
  }

  /** 对外只读的数据库句柄信息（健康检查 / 运维用） */
  get engine(): PlayersDb {
    return this.db
  }

  /**
   * 首次启动时把旧的 `profiles.json` 整库导入 SQLite。
   * 导入成功后把旧文件改名成 `profiles.json.migrated-<时间>` 留档 —— 不删任何东西。
   */
  private migrateLegacy(): void {
    if (this.db.count() > 0) return
    let source = ''
    for (const name of [PROFILE_FILE, PROFILE_BACKUP]) {
      const candidate = path.join(this.dir, name)
      if (!fs.existsSync(candidate)) continue
      try {
        source = fs.readFileSync(candidate, 'utf8')
      } catch {
        continue
      }
      if (source.trim()) break
      source = ''
    }
    if (!source.trim()) return

    let parsed: { players: Map<string, PlayerProfile>; skipped: number }
    try {
      parsed = parseLegacyFile(source)
    } catch (e) {
      this.say(`旧版档案解析失败（${(e as Error).message}），跳过迁移`)
      return
    }
    let imported = 0
    for (const profile of parsed.players.values()) {
      try {
        this.db.importProfile({
          id: profile.id,
          name: profile.name,
          avatar: profile.avatar,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
          lastSeenAt: profile.lastSeenAt,
          stats: {
            games: profile.stats.games,
            wins: profile.stats.wins,
            losses: profile.stats.losses,
            as_murderer: profile.stats.asMurderer,
            murderer_wins: profile.stats.murdererWins,
          },
          ai: profile.ai,
          genres: profile.genres,
          games: profile.history.map((g) => ({
            played_at: g.at,
            room_code: g.roomCode,
            theme: g.theme,
            player_count: g.playerCount,
            result: g.result,
            role: g.role,
            is_murderer: g.isMurderer ? 1 : 0,
          })),
        })
        imported += 1
      } catch (e) {
        this.say(`迁移档案 ${profile.id} 失败（${(e as Error).message}），跳过这一条`)
      }
    }
    if (parsed.skipped > 0) this.say(`旧版档案里有 ${parsed.skipped} 条格式不对，已跳过`)
    if (imported > 0) {
      const stamp = this.now()
      try {
        fs.renameSync(path.join(this.dir, PROFILE_FILE), path.join(this.dir, `${PROFILE_FILE}.migrated-${stamp}`))
      } catch {
        /* 旧文件改不了名不影响已经导入的数据 */
      }
      this.say(`已把 ${imported} 份旧版档案迁移进数据库（原文件已改名留档）`)
    }
  }

  /** 从磁盘重新装载（模拟重启；已有连接会先关掉） */
  load(): void {
    this.db.reopen()
  }

  get(id: unknown): PlayerProfile | null {
    const key = normalizePlayerId(id)
    if (!key) return null
    const bundle = this.db.read(key, PROFILE_LIMITS.historyLen)
    return bundle ? toProfile(bundle) : null
  }

  count(): number {
    return this.db.count()
  }

  /** 完整性对账（同步跑一次，返回报告） */
  checkIntegrity(): IntegrityReport {
    return this.db.checkIntegrity()
  }

  statsSnapshot(): StoreSnapshot {
    return {
      profileCount: this.db.count(),
      fileBytes: this.db.bytes(),
      writes: this.db.writes,
      filePath: this.filePath,
      backupPath: this.backupPath,
      backupBytes: this.db.backupBytes(),
      games: this.db.gameCount(),
      schemaVersion: DB_SCHEMA_VERSION,
      engine: 'sqlite',
      integrity: this.db.integrityReport,
    }
  }

  /**
   * 创建或更新档案（昵称 / 头像 / AI 偏好 / 偏好题材）。
   * 只有显式传进来的字段才会被改，`undefined` 表示「这次不动」。
   */
  upsert(input: { id: unknown; name?: unknown; avatar?: unknown; ai?: unknown; genres?: unknown }): PlayerProfile | null {
    const id = normalizePlayerId(input.id)
    if (!id) return null
    const now = this.now()
    const existing = this.db.read(id, PROFILE_LIMITS.historyLen)

    const name = input.name === undefined ? undefined : cleanText(input.name, PROFILE_LIMITS.nameLen) || undefined
    const avatar =
      input.avatar === undefined
        ? undefined
        : sanitizeAvatar(input.avatar, existing ? existing.player.avatar : '🖤')
    const ai = input.ai === undefined ? undefined : sanitizeAi(input.ai)
    const genres = input.genres === undefined ? undefined : sanitizeGenres(input.genres)

    this.db.savePlayer({ id, name, avatar, ai, genres, now })
    this.trimOverflow()
    return this.get(id)
  }

  /** 入座 / 重连时刷新「最近上线」与昵称头像（不改 AI 偏好、偏好题材与战绩） */
  touch(input: { id: unknown; name?: unknown; avatar?: unknown }): PlayerProfile | null {
    const id = normalizePlayerId(input.id)
    if (!id) return null
    const existing = this.db.read(id, PROFILE_LIMITS.historyLen)
    if (!existing) return null
    const name = input.name === undefined ? undefined : cleanText(input.name, PROFILE_LIMITS.nameLen) || undefined
    const avatar = input.avatar === undefined ? undefined : sanitizeAvatar(input.avatar, existing.player.avatar)
    const changed = this.db.touch({ id, name, avatar, now: this.now() })
    return changed ? this.get(id) : null
  }

  /**
   * 记一局战绩。**由服务器在复盘时调用**，客户端上报的胜负一律不采信。
   * 每局每个座位只应该调用一次（房间侧用 `statsRecorded` 保证，数据库再兜一层去重）。
   */
  recordGame(
    id: unknown,
    record: Omit<GameRecord, 'at'> & { at?: number },
  ): PlayerProfile | null {
    const key = normalizePlayerId(id)
    if (!key) return null
    const now = this.now()
    const result: 'win' | 'lose' = record.result === 'win' ? 'win' : 'lose'
    this.db.addGame({
      playerId: key,
      at: Number.isFinite(record.at) ? Number(record.at) : now,
      roomCode: cleanText(record.roomCode, 8),
      theme: cleanText(record.theme, 40),
      playerCount: Number(record.playerCount) || 0,
      result,
      role: cleanText(record.role, 24),
      isMurderer: record.isMurderer === true,
      keep: PROFILE_LIMITS.historyLen,
      now,
    })
    this.trimOverflow()
    return this.get(key)
  }

  /** 超出上限时按「最久没上线」淘汰，避免库无限长大 */
  private trimOverflow(): void {
    const total = this.db.count()
    if (total <= this.maxProfiles) return
    const victims = this.db.oldestIds(total - this.maxProfiles)
    const removed = this.db.deletePlayers(victims)
    if (removed > 0) this.say(`档案数超过上限 ${this.maxProfiles}，淘汰了 ${removed} 个最久未上线的档案`)
  }

  /**
   * 把 WAL 合并回主文件并留一份一致性备份。
   * 注意：SQLite 的每次写**已经提交落盘**了，这里不是「补写」，只是收尾 + 备份。
   */
  flush(): void {
    if (this.closed) return
    this.db.checkpoint()
    this.db.backup()
    this.db.checkIntegrity()
  }

  /** 关服前调用：checkpoint + 备份 + 关闭连接 */
  close(): void {
    if (this.closed) return
    this.db.checkpoint()
    this.db.backup()
    this.db.close()
    this.closed = true
  }
}

/** 便于测试/运维：把 AI 行转成偏好（保留导出，避免别处重复写） */
export function aiFromRow(row: AiRow): AiPrefs {
  return { provider: row.provider, model: row.model, baseUrl: row.base_url }
}
