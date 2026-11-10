import type { ScriptPackage } from '@/types/script'
import { pacingFor, scriptLength } from './rules'
import { validateScriptPackage } from './validator'

export interface StoryBibleResult {
  ok: boolean
  pkg?: ScriptPackage
  errors: string[]
}

export interface RoleScriptResult {
  ok: boolean
  full_script?: string
  errors: string[]
}

interface AvoidCase {
  theme: string
  murderer: string
}

export const STORY_BIBLE_SYSTEM_PROMPT = `你是顶级剧本杀案件的架构师。
当前阶段只生成“案件骨架”，不要写完整角色剧本。
必须锁定：故事背景、唯一真凶、真实死因与绝对时间线、角色身份和任务、凶手特权、三批线索、私有线索、搜证地点。
所有角色 full_script 必须留空字符串，后续会逐个角色单独撰写。
只输出一个合法 JSON 对象，不要 Markdown，不要解释。`

export const ROLE_SCRIPT_SYSTEM_PROMPT = `你是顶级剧本杀主笔。
你会收到已经固定的案件骨架和一个目标角色。不得修改凶手、手法、时间线、他人身份或线索事实。
只撰写目标角色的第一人称完整剧本，必须使用幕标题：
【第一幕 · 入戏】
【第二幕 · 暗潮】
【第三幕 · 案发】
【第四幕 · 人心】
【终幕 · 守则】
剧本必须达到系统指定字数，包含感官细节、人物关系、私人秘密、谎言动机和三条行为准则。
只输出 {"full_script":"..."}，不要 Markdown，不要解释。`

function extractJson(text: string): unknown {
  let value = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value)
  if (fenced) value = fenced[1].trim()
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  return JSON.parse(start >= 0 && end > start ? value.slice(start, end + 1) : value)
}

export function buildStoryBiblePrompt(
  playerCount: number,
  theme: string,
  uniqueness?: { nonce: string; avoid: AvoidCase[] },
): string {
  const rule = pacingFor(playerCount)
  const recent = (uniqueness?.avoid ?? [])
    .slice(0, 10)
    .map((item, index) => `${index + 1}. ${item.theme} / 凶手：${item.murderer}`)
    .join('\n')
  return `请为 ${playerCount} 人剧本杀生成完整案件骨架。
玩家输入主题：${theme.trim() || '原创悬疑案件'}

输出 JSON 必须包含：
{
  "game_config": { "theme": "", "player_count": ${playerCount}, "background_story": "" },
  "global_truth": { "murderer_name": "", "cause_of_death": "", "absolute_timeline": "" },
  "roles": [
    {
      "name": "",
      "identity": "",
      "is_murderer": false,
      "surface_task": "",
      "deep_task": "",
      "personal_timeline": "",
      "full_script": "",
      "side_quests": []
    }
  ],
  "murderer_privilege": { "intuition_hint": "" },
  "public_clues": [],
  "clue_batches": [{ "tier": 1, "title": "", "clues": [] }],
  "private_clues": [{ "role_name": "", "text": "" }],
  "search_locations": [{ "name": "", "clues": [] }]
}

硬性要求：
- 恰好 ${playerCount} 个角色，恰好 1 名凶手，global_truth.murderer_name 必须与凶手角色完全一致。
- ${playerCount === 6 ? '每个角色至少 1 条独立 side_quests。' : '不要生成无关支线。'}
- 三批线索合计 9-11 条；搜证地点数量为 ${rule.playerCount}，地点线索不得与公共线索重复。
- 所有角色的 full_script 必须输出空字符串，禁止提前写角色正文。
- 凶手特权只能写模糊心理感知，不能直述凶手、手法或具体时间点。
- 角色、任务、时间线和线索必须全部咬合，不能出现逻辑死锁。
${uniqueness ? `- 本局唯一标识：${uniqueness.nonce}
- 禁止重复最近案件，必须更换凶手、核诡、手法、关系与关键物证：
${recent || '暂无历史记录'}` : ''}`
}

export function normalizeStoryBible(
  raw: string,
  playerCount: number,
): StoryBibleResult {
  let parsed: unknown
  try {
    parsed = extractJson(raw)
  } catch (error) {
    return {
      ok: false,
      errors: [`案件骨架 JSON 未完整返回：${error instanceof Error ? error.message : String(error)}`],
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errors: ['案件骨架不是 JSON 对象'] }
  }
  const data = parsed as Partial<ScriptPackage>
  if (!Array.isArray(data.roles) || data.roles.length === 0) {
    return { ok: false, errors: ['案件骨架缺少 roles'] }
  }

  const rule = pacingFor(playerCount)
  const placeholder = JSON.parse(JSON.stringify(data)) as ScriptPackage
  placeholder.roles = placeholder.roles.map((role) => ({
    ...role,
    full_script: '占'.repeat(rule.scriptMin),
    side_quests: Array.isArray(role.side_quests) ? role.side_quests : [],
  }))
  const checked = validateScriptPackage(placeholder, playerCount)
  if (!checked.ok || !checked.data) {
    return { ok: false, errors: checked.errors }
  }
  checked.data.roles = checked.data.roles.map((role) => ({ ...role, full_script: '' }))
  return { ok: true, pkg: checked.data, errors: [] }
}

export function buildRoleScriptPrompt(
  bible: ScriptPackage,
  roleName: string,
  playerCount: number,
): string {
  const rule = pacingFor(playerCount)
  const role = bible.roles.find((item) => item.name === roleName)
  if (!role) throw new Error(`案件骨架中不存在角色：${roleName}`)
  const context = {
    theme: bible.game_config.theme,
    background_story: bible.game_config.background_story,
    global_truth: bible.global_truth,
    murderer_privilege: bible.murderer_privilege,
    role,
    public_roles: bible.roles.map((item) => ({
      name: item.name,
      identity: item.identity,
      is_murderer: item.is_murderer,
    })),
    clues: bible.public_clues,
    clue_batches: bible.clue_batches,
    private_clues: (bible.private_clues ?? []).filter((clue) => clue.role_name === roleName),
    search_locations: (bible.search_locations ?? []).map((location) => location.name),
  }
  return `请只为角色「${roleName}」撰写第一人称完整剧本。
目标字数：${rule.scriptMin}-${rule.scriptMax} 字，按非空白字符计算。
必须完整使用五个幕标题，并保持以下案件事实不变。

案件与角色上下文：
${JSON.stringify(context, null, 2)}

角色正文必须包含：
- 至少 4 个具体场景、3 组人物关系、3 个明确时间点、2 个感官细节。
- 1 个与凶案无关但会影响发言选择的私人秘密。
- 每条谎言都说明为什么撒谎、希望别人相信什么。
- 最后一段严格使用“其一、其二、其三”三条行为准则。

只输出 {"full_script":"完整正文"}。`
}

export function parseRoleScriptResponse(
  raw: string,
  playerCount: number,
): RoleScriptResult {
  let parsed: unknown
  try {
    parsed = extractJson(raw)
  } catch (error) {
    return {
      ok: false,
      errors: [`角色剧本 JSON 未完整返回：${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const text =
    parsed && typeof parsed === 'object' && typeof (parsed as { full_script?: unknown }).full_script === 'string'
      ? (parsed as { full_script: string }).full_script.trim()
      : ''
  if (!text) return { ok: false, errors: ['角色剧本缺少 full_script'] }

  const rule = pacingFor(playerCount)
  const length = scriptLength(text)
  if (length < rule.scriptMin || length > rule.scriptMax) {
    return {
      ok: false,
      errors: [`角色剧本只有 ${length} 字，要求 ${rule.scriptMin}-${rule.scriptMax} 字`],
    }
  }
  return { ok: true, full_script: text, errors: [] }
}

export function mergeRoleScript(
  bible: ScriptPackage,
  roleName: string,
  fullScript: string,
): ScriptPackage {
  const merged = JSON.parse(JSON.stringify(bible)) as ScriptPackage
  const role = merged.roles.find((item) => item.name === roleName)
  if (!role) throw new Error(`案件骨架中不存在角色：${roleName}`)
  role.full_script = fullScript
  return merged
}
