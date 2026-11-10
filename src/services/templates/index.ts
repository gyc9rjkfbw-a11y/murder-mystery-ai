import { fogHarborTemplate } from './fogHarbor'
import { snowManorTemplate } from './snowManor'
import type { ScriptTemplate } from './types'

export type { ScriptTemplate } from './types'

/** 内置离线剧本库 */
export const TEMPLATES: ScriptTemplate[] = [fogHarborTemplate, snowManorTemplate]

/** 首页推荐的题材（未命中离线库时会就近改写生成） */
export const PRESET_THEMES: { label: string; theme: string; emoji: string }[] = [
  { label: '民国·远洋邮轮', theme: '民国·远洋邮轮谋杀案', emoji: '🚢' },
  { label: '现代·雪山山庄', theme: '现代·雪山山庄暴风雪山庄', emoji: '🏔️' },
  { label: '古风·宫廷夜宴', theme: '古风·宫廷夜宴疑云', emoji: '🏮' },
  { label: '校园·毕业典礼', theme: '校园·毕业典礼失踪案', emoji: '🎓' },
  { label: '科幻·空间站', theme: '科幻·空间站第七日', emoji: '🛰️' },
  { label: '都市·豪门遗产', theme: '都市·豪门遗产争产案', emoji: '🏙️' },
]

/** 依据题材关键词就近匹配离线模板 */
export function pickTemplate(theme: string): ScriptTemplate {
  const t = theme.trim()
  if (!t) return TEMPLATES[0]
  let best: { tpl: ScriptTemplate; score: number } | null = null
  for (const tpl of TEMPLATES) {
    let score = 0
    for (const kw of tpl.keywords) {
      if (t.includes(kw) || kw.includes(t)) score += kw.length
    }
    if (tpl.theme.includes(t) || t.includes(tpl.theme)) score += 10
    if (!best || score > best.score) best = { tpl, score }
  }
  return best && best.score > 0 ? best.tpl : TEMPLATES[0]
}

/** 找不到对应模板时，把用户题材改写进背景故事，做到「任意题材都能开局」 */
export function adaptTheme(
  tpl: ScriptTemplate,
  theme: string,
  playerCount: number,
): ReturnType<ScriptTemplate['create']> {
  const pkg = tpl.create(playerCount)
  const t = theme.trim()
  if (!t || t === pkg.game_config.theme) return pkg
  return {
    ...pkg,
    game_config: {
      ...pkg.game_config,
      theme: t,
      background_story: pkg.game_config.background_story,
    },
  }
}