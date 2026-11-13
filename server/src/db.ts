/**
 * 玩家数据库（SQLite · 单文件）
 * ==================================================================
 * 为什么换掉原来的 `profiles.json`：
 *   整份 JSON 每次落盘都要**全量重写**，一局结算 + 一个改昵称就可能撞在一起，
 *   而且「写一半断电」只能靠 rename 兜住，跨多个档案的一致性完全没有。
 *   玩家的战绩是只会变多的账本，这种数据该交给带事务的数据库。
 *
 * 用 `node:sqlite`（Node 22.5+ 内置，同步 API），换来这些硬保证：
 *   1. **事务**：一局战绩的「写入对局 + 累加统计 + 裁剪历史」要么全成、要么全不成；
 *   2. **约束**：主键 / 外键 / CHECK 全在 SQL 里，脏数据**根本插不进来**，
 *      连「胜场 + 负场 ≠ 总局数」这种账都过不了 CHECK；
 *   3. **崩溃恢复**：WAL + `synchronous=FULL`，进程被强杀也不丢已提交的写；
 *   4. **自检**：`integrity_check` + `foreign_key_check` + 战绩对账，
 *      启动时跑一遍，坏库自动隔离并从备份恢复。
 *
 * 三条不可妥协的规则：
 *   - **绝不存密钥**：这里根本没有放 `apiKey` 的列（见 store.ts 的清洗逻辑）；
 *   - **坏库不致命**：integrity 失败 → 改名 `players.db.corrupt-<时间>`，
 *     再尝试从 `players.db.bak` 恢复，最后才从空库开始；服务器必须能起来；
 *   - **有界**：每人对局历史裁剪到最近 N 条（统计数字是终身累计，不裁剪）。
 *
 * 这一层只做「读 / 写 / 校验 / 备份」，**不做任何业务清洗**；
 * 昵称截断、ID 白名单、胜负判定都在 store.ts 与房间侧完成。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 数据库文件名 */
export const DB_FILE = 'players.db'
/** 备份文件名（`VACUUM INTO` 出来的完整快照） */
export const DB_BACKUP = 'players.db.bak'
/** 结构版本号，写进 `PRAGMA user_version`；升级表结构就 +1 并补一段迁移 */
export const DB_SCHEMA_VERSION = 1
/** 同一房间 2 秒内的同一条记录视为「客户端/房间重试」，不重复记账 */
export const DUPLICATE_WINDOW_MS = 2000

/** SQL 能接受的标量 */
export type SqlValue = string | number | null

/** 数据库里的玩家主表行 */
export interface PlayerRow {
  id: string
  name: string
  avatar: string
  created_at: number
  updated_at: number
  last_seen_at: number
}

/** 累计战绩行 */
export interface StatsRow {
  games: number
  wins: number
  losses: number
  as_murderer: number
  murderer_wins: number
}

/** 一局记录行 */
export interface GameRow {
  id: number
  player_id: string
  played_at: number
  room_code: string
  theme: string
  player_count: number
  result: 'win' | 'lose'
  role: string
  is_murderer: number
}

/** AI 偏好行（**没有密钥列**） */
export interface AiRow {
  provider: string
  model: string
  base_url: string
}

/** 一个玩家的完整数据包（一次查询装配好，交给 store.ts 转成对外形状） */
export interface PlayerBundle {
  player: PlayerRow
  stats: StatsRow
  ai: AiRow
  genres: string[]
  games: GameRow[]
}

/** 完整性报告 */
export interface IntegrityReport {
  ok: boolean
  /** `PRAGMA integrity_check` 的结果，正常是 'ok' */
  quick: string
  /** 外键违例条数 */
  foreignKeyIssues: number
  /** 战绩与对局表对不上的玩家（正常情况下为 0） */
  statMismatches: string[]
  players: number
  games: number
  checkedAt: number
  issues: string[]
}

/** 打开数据库时的致命错误（不会被当成「坏库」而清空数据） */
export class DbFatalError extends Error {
  readonly code: 'schema-newer' | 'open-failed' | 'disk'
  constructor(code: DbFatalError['code'], message: string) {
    super(message)
    this.code = code
    this.name = 'DbFatalError'
  }
}

export interface PlayersDbOptions {
  /** 数据库文件绝对路径 */
  file: string
  /** 日志回调（默认静默；由 ProfileStore 接 console） */
  onLog?: (line: string) => void
  /** 时间源（测试用） */
  now?: () => number
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL,
  avatar        TEXT NOT NULL,
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
  last_seen_at  INTEGER NOT NULL CHECK (last_seen_at >= 0),
  CHECK (length(id) BETWEEN 8 AND 40),
  CHECK (length(name) BETWEEN 1 AND 64),
  CHECK (length(avatar) BETWEEN 1 AND 32)
) STRICT;

CREATE TABLE IF NOT EXISTS player_stats (
  player_id      TEXT PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  games          INTEGER NOT NULL DEFAULT 0 CHECK (games >= 0),
  wins           INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses         INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  as_murderer    INTEGER NOT NULL DEFAULT 0 CHECK (as_murderer >= 0),
  murderer_wins  INTEGER NOT NULL DEFAULT 0 CHECK (murderer_wins >= 0),
  -- 三条「账必须平」的硬约束：任何绕过业务层的写入都会被数据库直接拒掉
  CHECK (wins + losses = games),
  CHECK (as_murderer <= games),
  CHECK (murderer_wins <= as_murderer),
  CHECK (murderer_wins <= wins)
) STRICT;

CREATE TABLE IF NOT EXISTS games (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  played_at     INTEGER NOT NULL CHECK (played_at >= 0),
  room_code     TEXT NOT NULL DEFAULT '',
  theme         TEXT NOT NULL DEFAULT '',
  player_count  INTEGER NOT NULL DEFAULT 0 CHECK (player_count BETWEEN 0 AND 20),
  result        TEXT NOT NULL CHECK (result IN ('win', 'lose')),
  role          TEXT NOT NULL DEFAULT '',
  is_murderer   INTEGER NOT NULL DEFAULT 0 CHECK (is_murderer IN (0, 1)),
  -- 同一玩家 + 同一房间 + 同一毫秒不该出现两条：房间侧重复结算会被这里拦住
  UNIQUE (player_id, room_code, played_at)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_games_player_time ON games (player_id, played_at DESC);

CREATE TABLE IF NOT EXISTS player_ai (
  player_id  TEXT PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'offline' CHECK (provider IN ('offline', 'openai')),
  model      TEXT NOT NULL DEFAULT '',
  base_url   TEXT NOT NULL DEFAULT '',
  CHECK (length(model) <= 120),
  CHECK (length(base_url) <= 400)
) STRICT;

CREATE TABLE IF NOT EXISTS player_genres (
  player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  genre      TEXT NOT NULL,
  ord        INTEGER NOT NULL DEFAULT 0 CHECK (ord >= 0),
  PRIMARY KEY (player_id, genre),
  CHECK (length(genre) BETWEEN 1 AND 32)
) STRICT;
`

/**
 * 玩家数据库。
 * 所有写操作自己开事务；跨方法的原子性由调用方（ProfileStore）用 `transaction()` 包。
 */
export class PlayersDb {
  readonly filePath: string
  readonly backupPath: string
  readonly dir: string
  private db: DatabaseSync
  private closed = false
  private writeCount = 0
  private readonly onLog: (line: string) => void
  private readonly now: () => number
  /** 最近一次完整性检查结果（健康检查直接读它，避免每次请求都全库扫描） */
  private integrity: IntegrityReport
  /** 上次自检时的写入次数：写过了就重新对账，健康检查不会报旧结果 */
  private checkedWrites = -1

  constructor(options: PlayersDbOptions) {
    this.filePath = path.resolve(options.file)
    this.backupPath = path.join(path.dirname(this.filePath), DB_BACKUP)
    this.dir = path.dirname(this.filePath)
    this.onLog = options.onLog ?? (() => {})
    this.now = options.now ?? (() => Date.now())
    this.db = this.boot() as DatabaseSync
    this.integrity = this.checkIntegrity()
  }

  /* ---------------- 打开 / 自愈 ---------------- */

  private boot(): DatabaseSync {
    try {
      return this.openAndInit()
    } catch (e) {
      if (e instanceof DbFatalError) throw e
      const reason = (e as Error).message || String(e)
      this.onLog(`数据库无法打开（${reason}），进入自愈流程`)
      return this.recover(reason)
    }
  }

  private openAndInit(): DatabaseSync {
    fs.mkdirSync(this.dir, { recursive: true })
    const db = new DatabaseSync(this.filePath, { enableForeignKeyConstraints: true })
    try {
      // WAL：读写不互斥；FULL：提交即落盘，进程被强杀也不丢已提交事务
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = FULL')
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('PRAGMA busy_timeout = 5000')
      db.exec('PRAGMA trusted_schema = OFF')

      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version) || 0
      if (version > DB_SCHEMA_VERSION) {
        db.close()
        throw new DbFatalError(
          'schema-newer',
          `数据库结构版本 ${version} 比当前程序（${DB_SCHEMA_VERSION}）新，拒绝打开以免写坏数据`,
        )
      }
      // 建表是幂等的；user_version 记下来，将来加字段就有地方判断
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(SCHEMA_SQL)
        if (version < DB_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${DB_SCHEMA_VERSION}`)
        db.exec('COMMIT')
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 回滚失败就交给外层关闭 */
        }
        throw e
      }

      const check = this.readIntegrity(db)
      if (check !== 'ok') {
        db.close()
        throw new Error(`完整性检查未通过：${check}`)
      }
      return db
    } catch (e) {
      try {
        db.close()
      } catch {
        /* 已经关了 */
      }
      throw e
    }
  }

  /** 坏库处理：隔离坏文件 → 尝试备份恢复 → 实在不行就从空库开始 */
  private recover(reason: string): DatabaseSync {
    const stamp = this.now()
    this.quarantine(`${this.filePath}.corrupt-${stamp}`)
    if (fs.existsSync(this.backupPath)) {
      try {
        fs.copyFileSync(this.backupPath, this.filePath)
        const restored = this.openAndInit()
        this.onLog(`已从备份 ${DB_BACKUP} 恢复（原因：${reason}）`)
        return restored
      } catch (e) {
        this.onLog(`备份也打不开（${(e as Error).message}），改为从空库开始`)
        this.quarantine(`${this.backupPath}.corrupt-${stamp}`)
      }
    } else {
      this.onLog('没有可用备份，从空库开始')
    }
    try {
      return this.openAndInit()
    } catch (e) {
      throw new DbFatalError('disk', `数据库无法创建（${(e as Error).message}），请检查目录权限：${this.dir}`)
    }
  }

  /** 把坏文件（连同 WAL 边车）改名保留证据，绝不静默删除 */
  private quarantine(target: string): void {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${this.filePath}${suffix}`
      if (!fs.existsSync(from)) continue
      try {
        fs.renameSync(from, `${target}${suffix}`)
      } catch {
        try {
          fs.rmSync(from, { force: true })
        } catch {
          /* 隔离失败不影响后续尝试 */
        }
      }
    }
  }

  private readIntegrity(db: DatabaseSync): string {
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined
    return String(row?.integrity_check ?? 'unknown')
  }

  /* ---------------- 低层读写 ---------------- */

  private one<T>(sql: string, ...params: SqlValue[]): T | null {
    const row = this.db.prepare(sql).get(...params)
    return (row as T | undefined) ?? null
  }

  private all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  private run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.db.prepare(sql).run(...params)
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  /** 显式事务；回调抛错就整体回滚（不会留下半局战绩） */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      this.writeCount += 1
      return out
    } catch (e) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 事务可能已被 SQLite 自动回滚 */
      }
      throw e
    }
  }

  /** 底层句柄（**只给测试与运维**：用来验证约束真的在数据库里生效） */
  raw(): DatabaseSync {
    return this.db
  }

  get writes(): number {
    return this.writeCount
  }

  get integrityReport(): IntegrityReport {
    if (this.checkedWrites !== this.writeCount) return this.checkIntegrity()
    return this.integrity
  }

  /** 数据库文件（含 WAL 边车）在磁盘上占的字节数 */
  bytes(): number {
    let total = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += fs.statSync(`${this.filePath}${suffix}`).size
      } catch {
        /* 没有这个文件 */
      }
    }
    return total
  }

  backupBytes(): number {
    try {
      return fs.statSync(this.backupPath).size
    } catch {
      return 0
    }
  }

  count(): number {
    return Number((this.one<{ n: number }>('SELECT COUNT(*) AS n FROM players') ?? { n: 0 }).n)
  }

  gameCount(): number {
    return Number((this.one<{ n: number }>('SELECT COUNT(*) AS n FROM games') ?? { n: 0 }).n)
  }

  /** 最久没上线的几个玩家 ID（超过上限时淘汰用） */
  oldestIds(limit: number): string[] {
    if (limit <= 0) return []
    return this.all<{ id: string }>('SELECT id FROM players ORDER BY last_seen_at ASC, id ASC LIMIT ?', limit).map((r) => r.id)
  }

  /* ---------------- 读 ---------------- */

  read(id: string, historyLen: number): PlayerBundle | null {
    const player = this.one<PlayerRow>('SELECT * FROM players WHERE id = ?', id)
    if (!player) return null
    const stats =
      this.one<StatsRow>(
        'SELECT games, wins, losses, as_murderer, murderer_wins FROM player_stats WHERE player_id = ?',
        id,
      ) ?? { games: 0, wins: 0, losses: 0, as_murderer: 0, murderer_wins: 0 }
    const ai =
      this.one<AiRow>('SELECT provider, model, base_url FROM player_ai WHERE player_id = ?', id) ??
      { provider: 'offline', model: '', base_url: '' }
    const genres = this.all<{ genre: string }>(
      'SELECT genre FROM player_genres WHERE player_id = ? ORDER BY ord ASC, genre ASC',
      id,
    ).map((r) => r.genre)
    // 历史按时间正序展示；表里存全量（受 historyLen 裁剪），这里再兜一次上限
    const games = this.all<GameRow>(
      'SELECT * FROM games WHERE player_id = ? ORDER BY played_at DESC, id DESC LIMIT ?',
      id,
      Math.max(0, historyLen),
    ).reverse()
    return { player, stats, ai, genres, games }
  }

  /* ---------------- 写 ---------------- */

  /** 建档（幂等）：players / player_stats / player_ai 三张表各一行 */
  private ensurePlayer(id: string, now: number): void {
    this.run(
      'INSERT INTO players (id, name, avatar, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
      id,
      '玩家',
      '🖤',
      now,
      now,
      now,
    )
    this.run('INSERT INTO player_stats (player_id) VALUES (?) ON CONFLICT(player_id) DO NOTHING', id)
    this.run('INSERT INTO player_ai (player_id) VALUES (?) ON CONFLICT(player_id) DO NOTHING', id)
  }

  /**
   * 创建或更新档案。
   * `undefined` = 这次不动这个字段（和原 JSON 版语义完全一致）。
   */
  savePlayer(input: {
    id: string
    name?: string
    avatar?: string
    ai?: { provider: string; model: string; baseUrl: string }
    genres?: string[]
    now: number
  }): void {
    const { id, now } = input
    this.transaction(() => {
      this.ensurePlayer(id, now)
      const sets: string[] = ['updated_at = ?', 'last_seen_at = ?']
      const params: SqlValue[] = [now, now]
      if (input.name !== undefined) {
        sets.push('name = ?')
        params.push(input.name)
      }
      if (input.avatar !== undefined) {
        sets.push('avatar = ?')
        params.push(input.avatar)
      }
      this.run(`UPDATE players SET ${sets.join(', ')} WHERE id = ?`, ...params, id)

      if (input.ai !== undefined) {
        this.run(
          'UPDATE player_ai SET provider = ?, model = ?, base_url = ? WHERE player_id = ?',
          input.ai.provider,
          input.ai.model,
          input.ai.baseUrl,
          id,
        )
      }
      if (input.genres !== undefined) {
        this.run('DELETE FROM player_genres WHERE player_id = ?', id)
        input.genres.forEach((genre, ord) => {
          this.run('INSERT INTO player_genres (player_id, genre, ord) VALUES (?, ?, ?)', id, genre, ord)
        })
      }
    })
  }

  /** 刷新「最近上线」并顺带更新昵称/头像；没有档案返回 false（不新建） */
  touch(input: { id: string; name?: string; avatar?: string; now: number }): boolean {
    return this.transaction(() => {
      const sets: string[] = ['last_seen_at = ?']
      const params: SqlValue[] = [input.now]
      if (input.name !== undefined) {
        sets.push('name = ?')
        params.push(input.name)
      }
      if (input.avatar !== undefined) {
        sets.push('avatar = ?')
        params.push(input.avatar)
      }
      const { changes } = this.run(`UPDATE players SET ${sets.join(', ')} WHERE id = ?`, ...params, input.id)
      return changes > 0
    })
  }

  /**
   * 记一局。
   * @returns `inserted: false` 表示判定为重复结算（同一房间 2 秒内），统计一分不加。
   */
  addGame(input: {
    playerId: string
    at: number
    roomCode: string
    theme: string
    playerCount: number
    result: 'win' | 'lose'
    role: string
    isMurderer: boolean
    keep: number
    now: number
  }): { inserted: boolean; playedAt: number } {
    return this.transaction(() => {
      this.ensurePlayer(input.playerId, input.now)
      // 重复结算判定：同一玩家 + 同一房间 + 2 秒内 + **业务字段完全一致** 才算重试。
      // 只要有一项不同就是另一局（重开一局至少几分钟，不可能落在同一个窗口里）。
      const recent = this.all<GameRow>(
        'SELECT * FROM games WHERE player_id = ? AND room_code = ? AND played_at BETWEEN ? AND ?',
        input.playerId,
        input.roomCode,
        input.at - DUPLICATE_WINDOW_MS,
        input.at + DUPLICATE_WINDOW_MS,
      )
      const duplicated = recent.some(
        (row) =>
          row.result === input.result &&
          row.role === input.role &&
          row.theme === input.theme &&
          Number(row.player_count) === input.playerCount &&
          (row.is_murderer === 1) === input.isMurderer,
      )
      if (duplicated) return { inserted: false, playedAt: input.at }

      // 时间戳保持严格递增：同一毫秒连打两局（压力测试 / 重开）也不会撞唯一索引
      const maxAt = Number(
        (this.one<{ m: number }>('SELECT COALESCE(MAX(played_at), 0) AS m FROM games WHERE player_id = ?', input.playerId) ?? { m: 0 }).m,
      )
      const playedAt = Math.max(input.at, maxAt + 1)
      const win = input.result === 'win'
      this.run(
        'INSERT INTO games (player_id, played_at, room_code, theme, player_count, result, role, is_murderer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        input.playerId,
        playedAt,
        input.roomCode,
        input.theme,
        input.playerCount,
        input.result,
        input.role,
        input.isMurderer ? 1 : 0,
      )
      this.run(
        `UPDATE player_stats SET
           games = games + 1,
           wins = wins + ?,
           losses = losses + ?,
           as_murderer = as_murderer + ?,
           murderer_wins = murderer_wins + ?
         WHERE player_id = ?`,
        win ? 1 : 0,
        win ? 0 : 1,
        input.isMurderer ? 1 : 0,
        input.isMurderer && win ? 1 : 0,
        input.playerId,
      )
      this.run('UPDATE players SET last_seen_at = ? WHERE id = ?', input.now, input.playerId)
      this.pruneGames(input.playerId, input.keep)
      return { inserted: true, playedAt }
    })
  }

  /** 只保留最近 `keep` 局（统计数字是终身的，不动） */
  private pruneGames(playerId: string, keep: number): void {
    const limit = Math.max(1, Math.floor(keep))
    this.run(
      `DELETE FROM games
       WHERE player_id = ?1
         AND id NOT IN (SELECT id FROM games WHERE player_id = ?1 ORDER BY played_at DESC, id DESC LIMIT ?2)`,
      playerId,
      limit,
    )
  }

  /** 淘汰最久没上线的档案（连带 stats / games / ai / genres 一起 CASCADE） */
  deletePlayers(ids: string[]): number {
    if (ids.length === 0) return 0
    return this.transaction(() => {
      let removed = 0
      for (const id of ids) removed += this.run('DELETE FROM players WHERE id = ?', id).changes
      return removed
    })
  }

  /**
   * 迁移用：按给定数字原样写入一份档案（含历史与统计），不做业务清洗。
   * 统计若与历史对不上，这里先按「账要平」的规则修正，否则 CHECK 会拒收。
   */
  importProfile(input: {
    id: string
    name: string
    avatar: string
    createdAt: number
    updatedAt: number
    lastSeenAt: number
    stats: StatsRow
    ai: { provider: string; model: string; baseUrl: string }
    genres: string[]
    games: Array<Omit<GameRow, 'id' | 'player_id'>>
  }): void {
    const { id } = input
    const games = Math.max(0, Math.floor(input.stats.games))
    let wins = Math.max(0, Math.floor(input.stats.wins))
    if (wins > games) wins = games
    // games > wins + losses 时把差额记成负场：总数不丢，账也能对上
    const losses = games - wins
    const asMurderer = Math.min(games, Math.max(0, Math.floor(input.stats.as_murderer)))
    const murdererWins = Math.min(asMurderer, wins, Math.max(0, Math.floor(input.stats.murderer_wins)))

    this.transaction(() => {
      this.run(
        'INSERT INTO players (id, name, avatar, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
        id,
        input.name,
        input.avatar,
        Math.max(0, input.createdAt),
        Math.max(0, input.updatedAt),
        Math.max(0, input.lastSeenAt),
      )
      this.run(
        'INSERT INTO player_stats (player_id, games, wins, losses, as_murderer, murderer_wins) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO NOTHING',
        id,
        games,
        wins,
        losses,
        asMurderer,
        murdererWins,
      )
      this.run(
        'INSERT INTO player_ai (player_id, provider, model, base_url) VALUES (?, ?, ?, ?) ON CONFLICT(player_id) DO NOTHING',
        id,
        input.ai.provider,
        input.ai.model,
        input.ai.baseUrl,
      )
      input.genres.forEach((genre, ord) => {
        this.run('INSERT OR IGNORE INTO player_genres (player_id, genre, ord) VALUES (?, ?, ?)', id, genre, ord)
      })
      let last = 0
      for (const g of input.games) {
        const at = Math.max(last + 1, Math.max(0, Math.floor(g.played_at)), 0)
        last = at
        this.run(
          'INSERT OR IGNORE INTO games (player_id, played_at, room_code, theme, player_count, result, role, is_murderer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          id,
          at,
          g.room_code,
          g.theme,
          Math.max(0, Math.min(20, Math.floor(g.player_count))),
          g.result === 'win' ? 'win' : 'lose',
          g.role,
          g.is_murderer ? 1 : 0,
        )
      }
    })
  }

  /* ---------------- 校验 / 落盘 ---------------- */

  /**
   * 完整性对账。
   * 三层：SQLite 自己的一致性 → 外键 → 业务账（战绩 vs 对局表）。
   */
  checkIntegrity(): IntegrityReport {
    const issues: string[] = []
    const quick = this.readIntegrity(this.db)
    if (quick !== 'ok') issues.push(`integrity_check: ${quick}`)

    let foreignKeyIssues = 0
    try {
      foreignKeyIssues = this.all<Record<string, unknown>>('PRAGMA foreign_key_check').length
    } catch (e) {
      issues.push(`foreign_key_check 失败：${(e as Error).message}`)
      foreignKeyIssues = -1
    }
    if (foreignKeyIssues > 0) issues.push(`外键违例 ${foreignKeyIssues} 条`)

    // 历史被裁剪过的玩家（stats.games > 可见行数）只校验「统计不小于可见行」；
    // 没被裁剪过的必须逐项对上，这样任何一次少加/多加都能被抓出来。
    const keep = 30
    const mismatchRows = this.all<{
      id: string
      stat_games: number
      game_rows: number
      stat_wins: number
      row_wins: number
      stat_losses: number
      row_losses: number
    }>(
      `SELECT p.id AS id,
              s.games AS stat_games,
              COALESCE(g.n, 0) AS game_rows,
              s.wins AS stat_wins,
              COALESCE(g.w, 0) AS row_wins,
              s.losses AS stat_losses,
              COALESCE(g.l, 0) AS row_losses
         FROM players p
         JOIN player_stats s ON s.player_id = p.id
         LEFT JOIN (
           SELECT player_id,
                  COUNT(*) AS n,
                  SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS w,
                  SUM(CASE WHEN result = 'lose' THEN 1 ELSE 0 END) AS l
             FROM games GROUP BY player_id
         ) g ON g.player_id = p.id
        WHERE s.games < COALESCE(g.n, 0)
           OR (s.games <= ? AND (s.games <> COALESCE(g.n, 0)
                              OR s.wins <> COALESCE(g.w, 0)
                              OR s.losses <> COALESCE(g.l, 0)))
        ORDER BY p.id`,
      keep,
    )
    const statMismatches = mismatchRows.map((r) => r.id)
    if (statMismatches.length > 0) issues.push(`${statMismatches.length} 个玩家的战绩与对局记录对不上`)

    this.checkedWrites = this.writeCount
    this.integrity = {
      ok: issues.length === 0,
      quick,
      foreignKeyIssues: Math.max(0, foreignKeyIssues),
      statMismatches,
      players: this.count(),
      games: this.gameCount(),
      checkedAt: this.now(),
      issues,
    }
    return this.integrity
  }

  /** 把 WAL 合并回主文件（关服 / 备份前调） */
  checkpoint(): void {
    if (this.closed) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (e) {
      this.onLog(`WAL checkpoint 失败：${(e as Error).message}`)
    }
  }

  /** 用 `VACUUM INTO` 做一份一致性快照（不是简单的文件复制，WAL 里的事务也在） */
  backup(): boolean {
    if (this.closed) return false
    const tmp = `${this.backupPath}.tmp`
    try {
      fs.rmSync(tmp, { force: true })
      this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
      fs.renameSync(tmp, this.backupPath)
      return true
    } catch (e) {
      this.onLog(`备份失败：${(e as Error).message}`)
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* 清不掉也没关系，下次会覆盖 */
      }
      return false
    }
  }

  /** 关闭：先 checkpoint 再关（WAL 边车不会留在磁盘上） */
  close(): void {
    if (this.closed) return
    this.checkpoint()
    this.closed = true
    try {
      this.db.close()
    } catch (e) {
      this.onLog(`关闭数据库失败：${(e as Error).message}`)
    }
  }

  /** 模拟「重启」：关掉再打开同一个文件（测试与运维用） */
  reopen(): void {
    this.checkpoint()
    try {
      this.db.close()
    } catch {
      /* 已经关了 */
    }
    this.closed = false
    this.db = this.boot()
    this.integrity = this.checkIntegrity()
  }
}
