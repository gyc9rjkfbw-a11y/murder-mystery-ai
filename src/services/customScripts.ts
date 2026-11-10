import type { ScriptPackage } from '@/types/script'
import { validateScriptPackage } from './validator'

export const CUSTOM_SCRIPTS_STORAGE_KEY = 'custom-scripts'
export const MAX_CUSTOM_SCRIPTS = 20
const MAX_IMPORT_CHARS = 1_000_000

export interface CustomScriptRecord {
  id: string
  title: string
  playerCount: number
  importedAt: number
  updatedAt: number
  pkg: ScriptPackage
}

export interface CustomScriptParseResult {
  ok: boolean
  pkg?: ScriptPackage
  errors: string[]
}

export interface CustomScriptStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function stableHash(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function cleanJsonText(text: string): string {
  let result = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(result)
  if (fenced) result = fenced[1].trim()
  const start = result.indexOf('{')
  const end = result.lastIndexOf('}')
  if (start >= 0 && end > start) result = result.slice(start, end + 1)
  return result
}

export function parseCustomScriptText(text: string): CustomScriptParseResult {
  if (!text.trim()) return { ok: false, errors: ['请粘贴剧本 JSON 或选择文件'] }
  if (text.length > MAX_IMPORT_CHARS) {
    return { ok: false, errors: ['剧本文件超过 1 MB，请精简后再导入'] }
  }

  let raw: unknown
  try {
    raw = JSON.parse(cleanJsonText(text))
  } catch (error) {
    return {
      ok: false,
      errors: [`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`],
    }
  }

  const checked = validateScriptPackage(raw)
  if (!checked.ok || !checked.data) {
    return { ok: false, errors: checked.errors }
  }
  return { ok: true, pkg: checked.data, errors: [] }
}

export function createCustomScriptRecord(
  pkg: ScriptPackage,
  now = Date.now(),
): CustomScriptRecord {
  const title = pkg.game_config.theme.trim()
  const playerCount = pkg.roles.length
  const id = `custom-${stableHash(`${title.toLocaleLowerCase()}:${playerCount}`)}`
  const clone = JSON.parse(JSON.stringify(pkg)) as ScriptPackage
  return {
    id,
    title,
    playerCount,
    importedAt: now,
    updatedAt: now,
    pkg: clone,
  }
}

export function upsertCustomScript(
  records: CustomScriptRecord[],
  next: CustomScriptRecord,
): CustomScriptRecord[] {
  const withoutSame = records.filter((record) => record.id !== next.id)
  return [next, ...withoutSame]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CUSTOM_SCRIPTS)
}

export function removeCustomScript(
  records: CustomScriptRecord[],
  id: string,
): CustomScriptRecord[] {
  return records.filter((record) => record.id !== id)
}

export function normalizeCustomScriptLibrary(raw: unknown): CustomScriptRecord[] {
  if (!Array.isArray(raw)) return []
  let records: CustomScriptRecord[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const source = item as Partial<CustomScriptRecord>
    const checked = validateScriptPackage(source.pkg)
    if (!checked.ok || !checked.data) continue
    const updatedAt = Number(source.updatedAt)
    const record = createCustomScriptRecord(
      checked.data,
      Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
    )
    records = upsertCustomScript(records, record)
  }
  return records
}

export function loadCustomScripts(
  storage: CustomScriptStorage,
): CustomScriptRecord[] {
  try {
    const raw = storage.getItem(CUSTOM_SCRIPTS_STORAGE_KEY)
    return raw ? normalizeCustomScriptLibrary(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

export function persistCustomScripts(
  storage: CustomScriptStorage,
  records: CustomScriptRecord[],
): void {
  try {
    storage.setItem(CUSTOM_SCRIPTS_STORAGE_KEY, JSON.stringify(records))
  } catch {
    /* 空间不足或隐私模式下静默失败，不影响当前导入结果。 */
  }
}
