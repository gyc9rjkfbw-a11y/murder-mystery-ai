/**
 * 难度层（轻松 / 标准 / 硬核）
 * ==================================================================
 * 难度只调两样东西：
 *   1. **节奏**：每轮陈述时长、阅读时长、每轮搜证次数、凶手特权解锁轮、
 *      防冷场侦探提示（见 `pacingForDifficulty`）
 *   2. **线索时序**：关键线索是早一点到手（轻松）还是晚一点到手（硬核）
 *      （见 `applyDifficultyToPackage`）
 *
 * 刻意**不动**的东西：角色数量、谁是凶手、真相与绝对时间线、线索文本本身。
 * 难度只是「同样一桩案子，给你多少时间、多少信息、什么时候给」，
 * 一旦去改凶手或删线索内容，案件就可能变成无解或自相矛盾 —— 那不是难，是坏。
 *
 * `normal` 必须等于历史行为：所有数值修正都是 0，选择它时一切与升级前一致。
 */

import { pacingFor, type PacingRule } from './rules'
import type { ClueBatch, Difficulty, ScriptPackage } from '@/types/script'

export type { Difficulty }

/** 难度档的一个具体口径 */
export interface DifficultyMeta {
  id: Difficulty
  /** 界面上的档位名 */
  label: string
  emoji: string
  /** 一句话卖点 */
  tagline: string
  /** 选档时的一句话解释（说清它改了什么） */
  detail: string
  /** 给大模型的写作口径 */
  brief: string
  /** 每轮陈述时长修正（秒） */
  roundSecondsDelta: number
  /** 阅读时长修正（秒） */
  readingSecondsDelta: number
  /** 每轮搜证次数修正（只在有搜证环节的 6 人局生效） */
  searchPerRoundDelta: number
  /** 凶手特权解锁轮次修正（负数 = 更早解锁 = 更难） */
  privilegeRoundDelta: number
  /** 防冷场侦探提示：on = 打开、off = 关闭、keep = 沿用人数档的默认值 */
  idleHint: 'on' | 'off' | 'keep'
  /** 把第 3 批（决定性）开头几条提前到第 2 批 */
  promoteClues: number
  /** 把第 2 批（深度）末尾几条压到第 3 批 */
  deferClues: number
}

export const DIFFICULTIES: DifficultyMeta[] = [
  {
    id: 'easy',
    label: '轻松',
    emoji: '🕯️',
    tagline: '线索早到手，先玩明白',
    detail: '每轮多 1 分钟，阅读多 2 分钟；决定性线索提前一轮到手，冷场时会给侦探提示。',
    brief:
      '难度＝轻松：线索要写得直白可验证，指向清楚；红鲱鱼最多 1 条；凶手的时间线伪装不要过于精巧，好人顺着线索能推出来。',
    roundSecondsDelta: 60,
    readingSecondsDelta: 120,
    searchPerRoundDelta: 1,
    privilegeRoundDelta: 0,
    idleHint: 'on',
    promoteClues: 1,
    deferClues: 0,
  },
  {
    id: 'normal',
    label: '标准',
    emoji: '🎭',
    tagline: '原汁原味的推理节奏',
    detail: '节奏与线索发放保持默认：按人数档给时间，三批线索按轮次发放。',
    brief: '难度＝标准：按既有规则写作，线索深浅按批次递进，保持原汁原味的博弈强度。',
    roundSecondsDelta: 0,
    readingSecondsDelta: 0,
    searchPerRoundDelta: 0,
    privilegeRoundDelta: 0,
    idleHint: 'keep',
    promoteClues: 0,
    deferClues: 0,
  },
  {
    id: 'hard',
    label: '硬核',
    emoji: '🩸',
    tagline: '关键线索压到最后',
    detail: '每轮少 1 分钟、凶手特权提前一轮解锁；深度线索压到最后一轮才发，冷场不再给提示。',
    brief:
      '难度＝硬核：必须安排 1-2 条可被证伪的红鲱鱼；凶手在作案时间线上要有至少两处自洽伪装；关键物证尽量压到第三批，不要提前交出决定性的直白描述。',
    roundSecondsDelta: -60,
    readingSecondsDelta: 0,
    searchPerRoundDelta: -1,
    privilegeRoundDelta: -1,
    idleHint: 'off',
    promoteClues: 0,
    deferClues: 1,
  },
]

export const DEFAULT_DIFFICULTY: Difficulty = 'normal'

/** 归一化：兼容中文、大小写与脏数据，识别不了一律回落到标准档 */
export function normalizeDifficulty(value: unknown): Difficulty {
  const v = String(value ?? '').trim().toLowerCase()
  if (v === 'easy' || v === '轻松' || v === '简单' || v === '新手') return 'easy'
  if (v === 'hard' || v === '硬核' || v === '困难' || v === '高难') return 'hard'
  return DEFAULT_DIFFICULTY
}

/** 取某档的完整口径（非法值回落到标准档，永远不会抛错） */
export function difficultyFor(value: unknown): DifficultyMeta {
  const id = normalizeDifficulty(value)
  return DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[1]
}

/** 界面上显示的档位名，如「硬核」 */
export function difficultyLabel(value: unknown): string {
  return difficultyFor(value).label
}

/** 徽标文案，如「难度 · 硬核」 */
export function difficultyBadge(value: unknown): string {
  const d = difficultyFor(value)
  return `难度 · ${d.label}`
}

/**
 * 某一档难度下的真实节奏。
 * normal 直接返回原对象（连引用都不换），保证「标准 = 升级前的行为」。
 */
export function pacingForDifficulty(playerCount: number, difficulty?: unknown): PacingRule {
  const base = pacingFor(playerCount)
  const d = difficultyFor(difficulty)
  if (d.id === DEFAULT_DIFFICULTY) return base

  // 4/5 人局本来就没有搜证环节，不要凭空长出一个「每轮搜证 1 次」
  const searchPerRound =
    base.searchRounds > 0
      ? Math.max(1, base.searchPerRound + d.searchPerRoundDelta)
      : base.searchPerRound
  const idleHintSeconds =
    d.idleHint === 'on'
      ? Math.max(90, base.idleHintSeconds)
      : d.idleHint === 'off'
        ? 0
        : base.idleHintSeconds

  return {
    ...base,
    readingSeconds: Math.max(5 * 60, base.readingSeconds + d.readingSecondsDelta),
    roundSeconds: Math.max(2 * 60, base.roundSeconds + d.roundSecondsDelta),
    searchPerRound,
    // 特权轮必须落在 1..maxRounds 之间，否则「第 3 轮解锁」在 2 轮的局里等于永远不解锁
    privilegeRound: Math.min(base.maxRounds, Math.max(1, base.privilegeRound + d.privilegeRoundDelta)),
    idleHintSeconds,
  }
}

/**
 * 把难度落到剧本包上。
 *
 * - 一律写入 `game_config.difficulty`（界面、复盘、联机视图都读它）
 * - 轻松：把第 3 批开头的决定性线索提前到第 2 批（信息更早到手）
 * - 硬核：把第 2 批末尾的深度线索压到第 3 批（信息更晚到手）
 * - 标准：一个字的线索都不动
 */
export function applyDifficultyToPackage(
  pkg: ScriptPackage,
  difficulty?: unknown,
): ScriptPackage {
  const d = difficultyFor(difficulty)
  const out: ScriptPackage = {
    ...pkg,
    game_config: { ...pkg.game_config, difficulty: d.id },
  }
  const batches: ClueBatch[] = (pkg.clue_batches ?? []).map((b) => ({
    tier: b.tier,
    title: b.title,
    clues: [...b.clues],
  }))
  // 工具函数可能拿到只有 public_clues 的旧剧本（还没被 normalize 补批次），那就只盖个难度戳
  if (batches.length === 0 || (d.promoteClues === 0 && d.deferClues === 0)) return out

  const byTier = new Map(batches.map((b) => [b.tier, b]))
  const second = byTier.get(2)
  const third = byTier.get(3)

  // 轻松：第 3 批开头 N 条 → 第 2 批（第 3 批至少留 1 条，不能整批搬空）
  if (d.promoteClues > 0 && second && third) {
    for (let i = 0; i < d.promoteClues && third.clues.length > 1; i += 1) {
      const moved = third.clues.shift()
      if (moved) second.clues.push(moved)
    }
  }
  // 硬核：第 2 批末尾 N 条 → 第 3 批（第 2 批同样至少留 1 条）
  if (d.deferClues > 0 && second && third) {
    for (let i = 0; i < d.deferClues && second.clues.length > 1; i += 1) {
      const moved = second.clues.pop()
      if (moved) third.clues.push(moved)
    }
  }

  const kept = batches.filter((b) => b.clues.length > 0)
  out.clue_batches = kept
  // public_clues 必须等于三批的并集（与 validator 的规范化口径一致）
  if (kept.length > 0) out.public_clues = kept.flatMap((b) => b.clues)
  return out
}

/**
 * 给界面的一句话说明：这一档在当前人数下到底会怎样。
 * 不写死数字，全部从 `pacingForDifficulty` 现算，避免文案与规则脱节。
 */
export function difficultyEffectText(playerCount: number, difficulty?: unknown): string {
  const d = difficultyFor(difficulty)
  const rule = pacingForDifficulty(playerCount, d.id)
  const parts = [`每轮陈述 ${Math.round(rule.roundSeconds / 60)} 分钟`]
  if (rule.searchRounds > 0) parts.push(`每轮搜证 ${rule.searchPerRound} 次`)
  parts.push(
    rule.privilegeRound <= 1 ? '凶手第 1 轮就有特权' : `凶手第 ${rule.privilegeRound} 轮解锁特权`,
  )
  if (d.promoteClues > 0) parts.push('关键线索提前一轮到手')
  if (d.deferClues > 0) parts.push('关键线索压到最后一轮')
  if (rule.idleHintSeconds > 0) parts.push('冷场会有侦探提示')
  return parts.join(' · ')
}
