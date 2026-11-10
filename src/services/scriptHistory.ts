import type { ScriptPackage } from '@/types/script'

export const SCRIPT_HISTORY_STORAGE_KEY = 'script-history'
export const SCRIPT_HISTORY_LIMIT = 30

export interface ScriptHistoryEntry {
  fingerprint: string
  theme: string
  murderer: string
  updatedAt: number
}

export interface ScriptHistoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function canonical(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。；：！？、,.!?;:"'“”‘’（）()【】\[\]《》<>—\-]/g, '')
}

function hash(text: string): string {
  let current = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    current ^= text.charCodeAt(i)
    current = Math.imul(current, 16777619)
  }
  return (current >>> 0).toString(36)
}

/**
 * 只比较决定案件身份与诡计的核心字段，不依赖角色、线索在 JSON 中的排列顺序。
 * 改换题材名或简单改写标点不会绕过重复检测。
 */
export function scriptFingerprint(pkg: ScriptPackage): string {
  const roles = pkg.roles
    .map((role) => `${canonical(role.name)}|${canonical(role.identity)}`)
    .sort()
    .join('#')
  const clues = [...pkg.public_clues, ...(pkg.clue_batches ?? []).flatMap((batch) => batch.clues)]
    .map(canonical)
    .sort()
    .join('#')
  const core = [
    canonical(pkg.game_config.background_story),
    canonical(pkg.global_truth.murderer_name),
    canonical(pkg.global_truth.cause_of_death),
    canonical(pkg.global_truth.absolute_timeline),
    roles,
    clues,
  ].join('||')
  return `story-${hash(core)}`
}

export function addScriptHistory(
  history: ScriptHistoryEntry[],
  pkg: ScriptPackage,
  now = Date.now(),
): ScriptHistoryEntry[] {
  const fingerprint = scriptFingerprint(pkg)
  const next: ScriptHistoryEntry = {
    fingerprint,
    theme: pkg.game_config.theme,
    murderer: pkg.global_truth.murderer_name,
    updatedAt: now,
  }
  return [next, ...history.filter((entry) => entry.fingerprint !== fingerprint)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SCRIPT_HISTORY_LIMIT)
}

export function findDuplicateScript(
  pkg: ScriptPackage,
  history: ScriptHistoryEntry[],
): ScriptHistoryEntry | undefined {
  const fingerprint = scriptFingerprint(pkg)
  return history.find((entry) => entry.fingerprint === fingerprint)
}

export function normalizeScriptHistory(raw: unknown): ScriptHistoryEntry[] {
  if (!Array.isArray(raw)) return []
  let history: ScriptHistoryEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = item as Partial<ScriptHistoryEntry>
    const fingerprint = String(source.fingerprint ?? '').trim()
    const updatedAt = Number(source.updatedAt)
    if (!fingerprint || !Number.isFinite(updatedAt) || updatedAt <= 0) continue
    const entry: ScriptHistoryEntry = {
      fingerprint,
      theme: String(source.theme ?? '').trim(),
      murderer: String(source.murderer ?? '').trim(),
      updatedAt,
    }
    history = [entry, ...history.filter((old) => old.fingerprint !== fingerprint)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, SCRIPT_HISTORY_LIMIT)
  }
  return history
}

export function loadScriptHistory(storage: ScriptHistoryStorage): ScriptHistoryEntry[] {
  try {
    const raw = storage.getItem(SCRIPT_HISTORY_STORAGE_KEY)
    return raw ? normalizeScriptHistory(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

export function persistScriptHistory(
  storage: ScriptHistoryStorage,
  history: ScriptHistoryEntry[],
): void {
  try {
    storage.setItem(SCRIPT_HISTORY_STORAGE_KEY, JSON.stringify(history))
  } catch {
    /* 隐私模式下不持久化，但本次生成仍会通过内存中的结果校验。 */
  }
}
