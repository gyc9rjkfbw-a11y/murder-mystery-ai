import type { ScriptPackage } from '@/types/script'
import { difficultyFor } from './difficulty'
import { ModelJsonError, parseModelJson, stripCodeFence } from './modelJson'
import { pacingFor, scriptLength } from './rules'
import { shrinkScriptToMax } from './templates/assemble'
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
  /** 实际字数（被压缩过则是压缩后的字数） */
  length?: number
  /** 模型原文的字数（仅在被压缩时有值） */
  originalLength?: number
  /** 原文超出上限，已被系统按预算压缩 */
  trimmed?: boolean
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

/**
 * 纯文本兜底：模型没按 {"full_script":"..."} 返回，而是直接把正文写出来。
 * 从「第一幕」标题开始截取，末尾剥掉可能的 JSON 残渣（引号、花括号、围栏）。
 */
export function rawScriptText(raw: string): string {
  const source = stripCodeFence(raw)
  const act = /【\s*第[一二三四五六七八九十\d]+\s*幕/.exec(source)
  if (!act) return ''
  return source
    .slice(act.index)
    .replace(/["'`\]\)},，:：\s]+$/, '')
    .trim()
}

export function buildStoryBiblePrompt(
  playerCount: number,
  theme: string,
  uniqueness?: { nonce: string; avoid: AvoidCase[] },
  difficulty?: unknown,
): string {
  const rule = pacingFor(playerCount)
  const diff = difficultyFor(difficulty)
  const recent = (uniqueness?.avoid ?? [])
    .slice(0, 10)
    .map((item, index) => `${index + 1}. ${item.theme} / 凶手：${item.murderer}`)
    .join('\n')
  return `请为 ${playerCount} 人剧本杀生成完整案件骨架。本局难度：${diff.label}。
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
- 难度口径（${diff.label}）：${diff.brief}
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
    parsed = parseModelJson(raw)
  } catch (error) {
    const reason =
      error instanceof ModelJsonError ? error.message : String((error as Error).message ?? error)
    return {
      ok: false,
      errors: [
        `案件骨架没能解析出 JSON（${reason}）。请直接输出 JSON 对象，不要写说明文字。`,
      ],
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
  // 按幕分配字数预算，模型更容易一次命中区间（尤其不容易写飞）
  const target = Math.round((rule.scriptMin + rule.scriptMax) / 2)
  const actBudget = [
    Math.round(target * 0.16),
    Math.round(target * 0.22),
    Math.round(target * 0.24),
    Math.round(target * 0.2),
  ]
  const actLines = [
    `- 【第一幕 · 入戏】约 ${actBudget[0]} 字：我是谁、外貌习惯、与死者的关系、今天为何在场。`,
    `- 【第二幕 · 暗潮】约 ${actBudget[1]} 字：案发前的暗流与交易，我藏着的那个秘密的来龙去脉。`,
    `- 【第三幕 · 案发】约 ${actBudget[2]} 字：案发前后我做过什么（含具体钟点）、看到听到的细节、我撒的谎。`,
    `- 【第四幕 · 人心】约 ${actBudget[3]} 字：我怀疑谁、为什么，我掌握的别人把柄，我打算怎么在发言里用。`,
    `- 【终幕 · 守则】约 ${rule.scriptMax - target > 0 ? Math.max(120, Math.round((rule.scriptMax - target) * 0.5) + 120) : 150} 字：其一、其二、其三 三条行为准则（必须写全）。`,
  ].join('\n')

  return `请只为角色「${roleName}」撰写第一人称完整剧本。
目标字数：${rule.scriptMin}-${rule.scriptMax} 字，按非空白字符计算。
**硬性上限 ${rule.scriptMax} 字**：写超了会被系统直接截断，宁可少写也不要超。
**硬性下限 ${rule.scriptMin} 字**：不足会被判不合格，需要重写。
必须完整使用五个幕标题，并保持以下案件事实不变。

案件与角色上下文：
${JSON.stringify(context, null, 2)}

各幕字数分配（合计约 ${target} 字，落在区间中部最稳）：
${actLines}

角色正文必须包含：
- 至少 4 个具体场景、3 组人物关系、3 个明确时间点、2 个感官细节。
- 1 个与凶案无关但会影响发言选择的私人秘密。
- 每条谎言都说明为什么撒谎、希望别人相信什么。
- 最后一段严格使用“其一、其二、其三”三条行为准则。

写作质量要求（比字数更重要）：
- 每一幕都要推进信息：给出新的物证、新的关系、新的时间点，不要重复同一件事。
- 感官细节要落到具体的味道、声音、温度、触感，不要写“气氛很紧张”这类空话。
- 谎言要留破绽：我说话时会绕开哪个细节，这个细节别人一旦追问就会露馅。
- 不要罗列物品清单、不要复述别人的完整剧本、不要写旁白式总结。

只输出 {"full_script":"完整正文"}。`
}

export function parseRoleScriptResponse(
  raw: string,
  playerCount: number,
): RoleScriptResult {
  const rule = pacingFor(playerCount)
  let text = ''
  let parseError = ''

  try {
    const parsed = parseModelJson(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { full_script?: unknown }).full_script === 'string'
    ) {
      text = (parsed as { full_script: string }).full_script.trim()
    }
  } catch (error) {
    parseError =
      error instanceof ModelJsonError ? error.message : String((error as Error).message ?? error)
  }

  // 模型没给 JSON、直接写了正文 —— 只要是带幕标题的完整文本就直接收下。
  if (!text) text = rawScriptText(raw)

  // 连幕标题都没有？只要篇幅够长，就按整段正文收下（总比让玩家再等一次好）。
  if (!text) {
    const plain = stripCodeFence(raw).trim()
    if (scriptLength(plain) >= rule.scriptMin) text = plain
  }

  if (!text) {
    return {
      ok: false,
      errors: [
        parseError
          ? `角色剧本没能解析出 JSON（${parseError}），也没有找到幕标题正文。`
          : '角色剧本缺少 full_script',
      ],
    }
  }

  const length = scriptLength(text)
  if (length > rule.scriptMax) {
    // 超出上限不再判死：按预算压缩（保留行为准则，从后往前丢整段）
    const fitted = shrinkScriptToMax(text, rule.scriptMax)
    const fittedLength = scriptLength(fitted)
    if (fittedLength > rule.scriptMax || fittedLength < rule.scriptMin) {
      return {
        ok: false,
        errors: [`角色剧本 ${length} 字，超出上限 ${rule.scriptMax} 字，压缩后仍不合规`],
        length,
      }
    }
    return {
      ok: true,
      full_script: fitted,
      errors: [],
      length: fittedLength,
      originalLength: length,
      trimmed: true,
    }
  }
  if (length < rule.scriptMin) {
    return {
      ok: false,
      errors: [
        `角色剧本 ${length} 字，低于下限 ${rule.scriptMin} 字（还差 ${rule.scriptMin - length} 字）`,
      ],
      length,
    }
  }
  return { ok: true, full_script: text, errors: [], length }
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
