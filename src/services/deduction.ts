import type {
  CaseSummary,
  DeductionBoard,
  ReviewMark,
  SuspectDossier,
  SuspicionLevel,
  TimelineStatus,
} from '@/types/deduction'

const TIMELINE_STATUSES: TimelineStatus[] = ['unknown', 'steady', 'gap', 'contradiction']
const UNIQUE_LIMIT = 12
const REASON_LIMIT = 6
const NOTE_LIMIT = 360

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function uniqueStrings(value: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    const text = cleanText(item, maxLength)
    if (text && !out.includes(text)) out.push(text)
    if (out.length >= limit) break
  }
  return out
}

function defaultDossier(): SuspectDossier {
  return {
    suspicion: 0,
    timeline: 'unknown',
    motive: false,
    clueIds: [],
    note: '',
  }
}

function clampSuspicion(value: unknown): SuspicionLevel {
  const n = Math.max(0, Math.min(3, Math.floor(Number(value) || 0)))
  return n as SuspicionLevel
}

function normalizeDossier(raw: unknown): SuspectDossier {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const timeline = TIMELINE_STATUSES.includes(source.timeline as TimelineStatus)
    ? (source.timeline as TimelineStatus)
    : 'unknown'
  return {
    suspicion: clampSuspicion(source.suspicion),
    timeline,
    motive: source.motive === true,
    clueIds: uniqueStrings(source.clueIds, UNIQUE_LIMIT, 120),
    note: cleanText(source.note, NOTE_LIMIT),
  }
}

export function createDeductionBoard(
  gameKey: string,
  roleNames: string[],
  now = Date.now(),
): DeductionBoard {
  const suspects: Record<string, SuspectDossier> = {}
  for (const name of roleNames) {
    const clean = cleanText(name, 80)
    if (clean) suspects[clean] = defaultDossier()
  }
  return {
    version: 1,
    gameKey,
    suspects,
    finalSuspect: '',
    finalReasons: [],
    summary: '',
    scratchpad: '',
    reviewMarks: {},
    updatedAt: now,
  }
}

/** 读取旧缓存或外部数据时做一次防御性清洗，界面永远只拿到合法结构。 */
export function normalizationDeductionBoard(
  raw: unknown,
  gameKey: string,
  roleNames: string[],
  now = Date.now(),
): DeductionBoard {
  const cleanRoles = [...new Set(roleNames.map((name) => cleanText(name, 80)).filter(Boolean))]
  const board = createDeductionBoard(gameKey, cleanRoles, now)
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const rawSuspects =
    source.suspects && typeof source.suspects === 'object'
      ? (source.suspects as Record<string, unknown>)
      : {}

  for (const name of cleanRoles) {
    if (Object.prototype.hasOwnProperty.call(rawSuspects, name)) {
      board.suspects[name] = normalizeDossier(rawSuspects[name])
    }
  }

  const finalSuspect = cleanText(source.finalSuspect, 80)
  board.finalSuspect = cleanRoles.includes(finalSuspect) ? finalSuspect : ''
  board.finalReasons = uniqueStrings(source.finalReasons, REASON_LIMIT, 120)
  board.summary = cleanText(source.summary, 500)
  board.scratchpad = cleanText(source.scratchpad, 1200)
  const rawMarks =
    source.reviewMarks && typeof source.reviewMarks === 'object'
      ? (source.reviewMarks as Record<string, unknown>)
      : {}
  for (const [key, value] of Object.entries(rawMarks)) {
    if (
      (key.startsWith('self:') || key.startsWith('statement:')) &&
      (value === 'trusted' || value === 'contradiction')
    ) {
      board.reviewMarks[key] = value
    }
  }
  board.updatedAt = Number.isFinite(Number(source.updatedAt))
    ? Number(source.updatedAt)
    : now
  return board
}

export function nextReviewMark(current: ReviewMark | ''): ReviewMark | '' {
  if (current === '') return 'trusted'
  if (current === 'trusted') return 'contradiction'
  return ''
}

export function buildCaseSummary(board: DeductionBoard): CaseSummary {
  const target = board.finalSuspect
  const dossier = target ? board.suspects[target] : undefined
  const reasonCount = board.finalReasons.length
  const clueCount = dossier?.clueIds.length ?? 0
  const missing: string[] = []
  if (!target) missing.push('还没有选定最怀疑的人')
  if (reasonCount < 2) missing.push(`还需要 ${2 - reasonCount} 条核心理由`)
  if (clueCount < 1) missing.push('还没有关联任何线索')

  return {
    target,
    reasonCount,
    clueCount,
    complete: missing.length === 0,
    missing,
    text: target
      ? `我怀疑 ${target}。${board.finalReasons.join('；')}${board.summary ? ` ${board.summary}` : ''}`.trim()
      : '',
  }
}

/** 同一剧本、同一房间、同一角色共享一份工作台；角色顺序不影响缓存键。 */
export function deductionStorageKey(
  roomCode: string,
  selfRoleName: string,
  roleNames: string[],
): string {
  const room = cleanText(roomCode, 32) || 'solo'
  const self = cleanText(selfRoleName, 80) || 'unknown'
  const cast = [...new Set(roleNames.map((name) => cleanText(name, 80)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .join('·')
  return `deduction:${room}:${self}:${cast}`
}

export interface DeductionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function loadDeductionBoard(
  storage: DeductionStorage,
  storageKey: string,
  roleNames: string[],
  now = Date.now(),
): DeductionBoard {
  let raw: unknown = null
  try {
    const text = storage.getItem(storageKey)
    raw = text ? JSON.parse(text) : null
  } catch {
    raw = null
  }
  return normalizationDeductionBoard(raw, storageKey, roleNames, now)
}

export function persistDeductionBoard(
  storage: DeductionStorage,
  storageKey: string,
  board: DeductionBoard,
): void {
  try {
    storage.setItem(storageKey, JSON.stringify({ ...board, gameKey: storageKey }))
  } catch {
    /* 隐私模式下写不进去，不影响继续投票。 */
  }
}
