/**
 * 服务端剧本生成（完全离线，不调大模型）
 * ------------------------------------------------------------------
 * 复用前端既有的离线剧本引擎与校验器，保证服务端产出的剧本包与单机版
 * 完全同构（同一套模板、同一套字数自检、同一套扩展字段兜底）。
 */

import type { Difficulty, ScriptPackage } from '@/types/script'
import { generateOfflineScript } from '@/services/offlineEngine'
import { validateScriptPackage } from '@/services/validator'

export interface BuildScriptResult {
  ok: boolean
  pkg: ScriptPackage | null
  errors: string[]
}

/** 生成 + 校验一个剧本包；stepDelay=0 让服务端瞬间完成（不演进度动画） */
export async function buildScriptPackage(
  playerCount: number,
  theme: string,
  difficulty?: Difficulty,
): Promise<BuildScriptResult> {
  const raw = await generateOfflineScript({ playerCount, theme, difficulty, stepDelay: 0 })
  const result = validateScriptPackage(raw, playerCount)
  if (!result.ok || !result.data) {
    return { ok: false, pkg: null, errors: result.errors }
  }
  return { ok: true, pkg: result.data, errors: [] }
}