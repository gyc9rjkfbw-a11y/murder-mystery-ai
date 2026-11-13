import type { ScriptPackage } from '@/types/script'
import { adaptTheme, TEMPLATES } from './templates'

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
  /** 用户粘贴 / 导入时输入的原文，原样保存，不做格式改写 */
  rawText: string
}

export interface CustomScriptParseResult {
  ok: boolean
  pkg?: ScriptPackage
  rawText?: string
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

/**
 * 导入自定义剧本：不做 JSON 格式校验、不做结构 / 人数 / 字数校验。
 * 输入什么就存什么——原文保存在 rawText；若文本恰好是剧本对象就直接拿来开局，
 * 否则套一份内置骨架让它也能玩（原文写进背景故事），绝不因格式问题拒绝保存。
 */
export function parseCustomScriptText(text: string): CustomScriptParseResult {
  if (!text.trim()) return { ok: false, errors: ['请先输入或选择剧本内容'] }
  if (text.length > MAX_IMPORT_CHARS) {
    return { ok: false, errors: ['剧本文件超过 1 MB，请精简后再导入'] }
  }

  let pkg: ScriptPackage | undefined
  try {
    const raw = JSON.parse(cleanJsonText(text)) as ScriptPackage
    if (raw && typeof raw === 'object' && Array.isArray(raw.roles)) pkg = raw
  } catch {
    /* 不是 JSON 也照常保存，不报错 */
  }

  if (!pkg) {
    const skeleton = adaptTheme(TEMPLATES[0], TEMPLATES[0].theme, 5)
    const firstLine = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '自定义剧本'
    skeleton.game_config = {
      ...skeleton.game_config,
      theme: firstLine.slice(0, 24),
      background_story: text.slice(0, 4000),
    }
    pkg = skeleton
  }

  return { ok: true, pkg, rawText: text, errors: [] }
}

export function createCustomScriptRecord(
  pkg: ScriptPackage,
  now = Date.now(),
  rawText = JSON.stringify(pkg),
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
    rawText,
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
    if (!source.pkg || typeof source.pkg !== 'object' || !Array.isArray(source.pkg.roles)) continue
    const updatedAt = Number(source.updatedAt)
    const record = createCustomScriptRecord(
      source.pkg,
      Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
      String(source.rawText ?? JSON.stringify(source.pkg)),
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
