import { fogHarborTemplate } from './fogHarbor'
import { snowManorTemplate } from './snowManor'
import { palaceBanquetTemplate } from './palaceBanquet'
import { campusGraduationTemplate } from './campusGraduation'
import { orbitalStationTemplate } from './orbitalStation'
import { cityEstateTemplate } from './cityEstate'
import type { ScriptTemplate } from './types'
import { fitRolesToPacing } from './assemble'
import { renameRoles } from '../roleNames'

export type { ScriptTemplate } from './types'

/**
 * 内置离线剧本库。
 * 六个首页题材各自对应一套**独立撰写**的剧本（背景、角色、线索、真相全部不同），
 * 不再把多个题材映射到同一份文本上。顺序即兜底优先级，fogHarbor 保持第一，
 * 以兼容「无匹配题材」时的历史行为。
 */
export const TEMPLATES: ScriptTemplate[] = [
  fogHarborTemplate,
  snowManorTemplate,
  palaceBanquetTemplate,
  campusGraduationTemplate,
  orbitalStationTemplate,
  cityEstateTemplate,
]

/** 首页推荐的题材（与离线库一一对应） */
export const PRESET_THEMES: { label: string; theme: string; emoji: string }[] = [
  { label: '民国·远洋邮轮', theme: '民国·远洋邮轮谋杀案', emoji: '🚢' },
  { label: '现代·雪山山庄', theme: '现代·雪山山庄暴风雪山庄', emoji: '🏔️' },
  { label: '古风·宫廷夜宴', theme: '古风·宫廷夜宴疑云', emoji: '🏮' },
  { label: '校园·毕业典礼', theme: '校园·毕业典礼失踪案', emoji: '🎓' },
  { label: '科幻·空间站', theme: '科幻·空间站第七日', emoji: '🛰️' },
  { label: '都市·豪门遗产', theme: '都市·豪门遗产争产案', emoji: '🏙️' },
]

/** 题材字符串的稳定散列，用于「无关键词匹配」时挑选模板 */
function themeHash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0
  }
  return h
}

/**
 * 依据题材选择离线模板。
 * 优先级：主题完全一致 → 关键词得分最高 → 按题材散列轮换。
 * 最后一档是为了避免「任意题材都落到同一份剧本」，让不同题材至少分布到
 * 六套不同的内置案件上。
 */
export function pickTemplate(theme: string): ScriptTemplate {
  const t = theme.trim()
  if (!t) return TEMPLATES[0]

  const exact = TEMPLATES.find((tpl) => tpl.theme === t)
  if (exact) return exact

  let best: { tpl: ScriptTemplate; score: number } | null = null
  for (const tpl of TEMPLATES) {
    let score = 0
    for (const kw of tpl.keywords) {
      if (t.includes(kw) || (kw.length > 2 && kw.includes(t))) score += kw.length
    }
    if (tpl.theme.includes(t) || t.includes(tpl.theme)) score += 10
    if (!best || score > best.score) best = { tpl, score }
  }
  if (best && best.score > 0) return best.tpl

  return TEMPLATES[themeHash(t) % TEMPLATES.length]
}

/** 找不到对应模板时，把用户题材改写进背景故事，做到「任意题材都能开局」 */
export function adaptTheme(
  tpl: ScriptTemplate,
  theme: string,
  playerCount: number,
): ReturnType<ScriptTemplate['create']> {
  // 每局换一套全新角色姓名（含正文、线索、真相里的全部引用）。
  // 连被人数裁剪掉的角色一起改名：它们仍会在线索里被提到。
  // case_id 保留模板身份，让防重复检测不受改名影响。
  const allRoles = tpl.create(6).roles
  const renamed = renameRoles(
    tpl.create(playerCount),
    tpl.id,
    allRoles.map((role) => role.name),
    allRoles.map((role) => role.gender),
  )
  // 换上的姓名可能比原名长，会把正文顶出该人数的字数上限，这里复核一次
  const pkg = fitRolesToPacing(renamed, playerCount)
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