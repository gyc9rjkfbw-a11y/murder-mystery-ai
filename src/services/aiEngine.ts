import type { ScriptPackage } from '@/types/script'
import { generateOfflineScript, type GenerateProgress } from './offlineEngine'
import { pacingFor } from './rules'
import { validateScriptPackage } from './validator'
import { findDuplicateScript, type ScriptHistoryEntry } from './scriptHistory'
import {
  buildRoleScriptPrompt,
  buildStoryBiblePrompt,
  mergeRoleScript,
  normalizeStoryBible,
  parseRoleScriptResponse,
  ROLE_SCRIPT_SYSTEM_PROMPT,
  STORY_BIBLE_SYSTEM_PROMPT,
} from './stagedScript'

/** 生成进度（透传给 UI，避免各处重复 import） */
export type { GenerateProgress }

/**
 * AI 剧本生成引擎（内容层）
 * ------------------------------------------------------------------
 * 两种提供方：
 *   - offline：内置剧本库 + 三步生成法模拟（默认，无需 Key，随时可玩）
 *   - openai ：任意 OpenAI 兼容的 Chat Completions 端点
 *              （DeepSeek / 通义千问 DashScope 兼容模式 / Kimi / 本地 vLLM 均可）
 *
 * 无论哪个提供方，产物都必须通过 `validateScriptPackage` 才能进游戏，
 * 这是《核心系统架构设计》要求的「事实校验机制」入口。
 *
 * 线上引擎额外实现了 **字数自检 + 自动重写**：
 *   若 4 人局生成了 3000 字的剧本（超出 1500-1900 区间），系统不会直接放行，
 *   而是把自检错误回灌给模型，要求它按目标字数重写一次。
 */

export type AiProvider = 'offline' | 'openai'

export interface AiConfig {
  provider: AiProvider
  /** 例如 https://api.deepseek.com/v1 */
  baseUrl: string
  apiKey: string
  /** 例如 deepseek-chat */
  model: string
  temperature: number
  /** 单次模型调用的最大输出 token 数。 */
  maxTokens: number
}

export interface GenerateRequest {
  playerCount: number
  theme: string
  config: AiConfig
  uniqueness?: {
    nonce: string
    history: ScriptHistoryEntry[]
  }
  /** 离线引擎步骤间隔；测试可设为 0。 */
  offlineStepDelayMs?: number
  onProgress?: (p: GenerateProgress) => void
  signal?: AbortSignal
}

export interface GenerationResult {
  pkg: ScriptPackage
  provider: AiProvider
  /** 真实调用时保留原始返回，便于排查 */
  raw?: string
  /** 因自检不通过而自动重写的次数 */
  rewrites: number
  warnings: string[]
}

export class GenerationError extends Error {
  readonly detail: string[]
  constructor(message: string, detail: string[] = []) {
    super(message)
    this.name = 'GenerationError'
    this.detail = detail
  }
}

/** 单次真实调用的返回 */
interface RawCompletion {
  content: string
  finishReason?: string
}

/** 剥掉模型可能多写的 markdown 代码块围栏 */
export function extractJSON(text: string): string {
  let t = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(t)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  return t
}

/** 把自检错误整理成给模型的「重写指令」 */
export function buildRewriteInstruction(errors: string[], playerCount: number): string {
  const rule = pacingFor(playerCount)
  const lines = errors.slice(0, 14).map((e) => `- ${e}`)
  return `【系统自检未通过，请重写】
你上一次的输出没有通过系统的格式与字数自检，具体问题如下：
${lines.join('\n')}

请严格修正后**重新输出完整 JSON**：
1. 每个角色的 full_script 必须落在 ${rule.scriptMin}-${rule.scriptMax} 字（按非空白字符计，段落之间换行不计入）。
${
  rule.sideQuestMin > 0
    ? `2. 每个角色必须额外给出 1-2 条 side_quests（与主线无关的独立支线任务）。`
    : '2. 不要写与主线无关的支线剧情，保持紧凑。'
}
3. 线索按 clue_batches 分三批，合计 9-11 条，不得与 search_locations 重复。
4. 不要输出 markdown 代码块，不要任何解释文字。`
}

export function buildDuplicateRewriteInstruction(duplicateTheme: string): string {
  return `【系统查重未通过，请重新设计】
你上一次生成的案件与最近已经玩过的「${duplicateTheme}」在人物身份、凶手、核诡、手法、时间线或关键线索上重复。
请完全重新设计本局：
1. 更换凶手、核心诡计、作案手法、关键物证和至少三组人物关系。
2. 不要只替换角色姓名、地名或题材名。
3. 保留指定玩家人数、JSON 结构与全部校验要求。
4. 只输出完整 JSON。`
}

type StagedCaller = (
  req: GenerateRequest,
  system: string,
  user: string,
  maxTokens: number,
) => Promise<RawCompletion>

async function callModel(
  req: GenerateRequest,
  system: string,
  user: string,
  maxTokens: number,
): Promise<RawCompletion> {
  const { config, signal } = req
  const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions'

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: config.temperature,
        max_tokens: maxTokens,
        stream: false,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal,
    })
  } catch (error) {
    throw new GenerationError(`无法连接到大模型服务：${(error as Error).message}`, [
      `请求地址：${url}`,
      '请检查 Base URL 是否正确、是否被浏览器跨域策略（CORS）拦截。',
    ])
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new GenerationError(`大模型服务返回 ${res.status}`, [body.slice(0, 500)])
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
  }
  const choice = json.choices?.[0]
  const content = choice?.message?.content ?? ''
  if (!content) throw new GenerationError('大模型返回内容为空')
  return { content, finishReason: choice?.finish_reason }
}

function maxOutputTokens(req: GenerateRequest): number {
  return Math.max(1024, Math.min(32768, Math.floor(Number(req.config.maxTokens) || 8192)))
}

function progressPayload(
  step: number,
  totalSteps: number,
  labels: string[],
  label: string,
): GenerateProgress {
  return { step, totalSteps, labels, label }
}

/** 两阶段生成：案件骨架一次，完整角色剧本逐角色生成。 */
export async function generateWithOpenAI(
  req: GenerateRequest,
  caller: StagedCaller = callModel,
): Promise<GenerationResult> {
  const warnings: string[] = []
  let rewrites = 0
  const maxTokens = maxOutputTokens(req)
  const totalSteps = req.playerCount + 2
  const labels = [
    '生成全局真相与人物骨架',
    ...Array.from({ length: req.playerCount }, (_, index) => `撰写第 ${index + 1} 个角色剧本`),
    '合并角色剧本并执行最终校验',
  ]
  req.onProgress?.(progressPayload(1, totalSteps, labels, labels[0]))

  let storyPrompt = buildStoryBiblePrompt(req.playerCount, req.theme, req.uniqueness
    ? {
        nonce: req.uniqueness.nonce,
        avoid: req.uniqueness.history.map((item) => ({
          theme: item.theme,
          murderer: item.murderer,
        })),
      }
    : undefined)
  let bible: ScriptPackage | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await caller(req, STORY_BIBLE_SYSTEM_PROMPT, storyPrompt, maxTokens)
    if (raw.finishReason === 'length') {
      throw new GenerationError('案件骨架输出被截断', [
        `模型达到单次 ${maxTokens} token 输出上限。`,
        '请在设置中提高最大输出 Token，或换用支持更长输出的模型。',
      ])
    }
    const parsed = normalizeStoryBible(raw.content, req.playerCount)
    if (parsed.ok && parsed.pkg) {
      const duplicate = findDuplicateScript(parsed.pkg, req.uniqueness?.history ?? [])
      if (duplicate && attempt === 0) {
        rewrites += 1
        warnings.push(`案件骨架与最近对局「${duplicate.theme}」重复，已重新设计`)
        storyPrompt += `\n\n${buildDuplicateRewriteInstruction(duplicate.theme)}\n当前阶段只重新输出案件骨架，所有 full_script 仍必须为空。`
        continue
      }
      if (duplicate) {
        throw new GenerationError('案件骨架与最近对局重复', [
          `系统检测到案件骨架与「${duplicate.theme}」重复。`,
          '请更换主题，或清空最近剧本记录后重试。',
        ])
      }
      bible = parsed.pkg
      break
    }
    if (attempt === 0) {
      rewrites += 1
      warnings.push('案件骨架未通过校验，已自动重写一次')
      storyPrompt += `\n\n【上一次案件骨架校验失败】\n${parsed.errors.join('\n')}\n请修正后重新输出完整 JSON。`
      continue
    }
    throw new GenerationError('案件骨架生成失败', parsed.errors)
  }

  if (!bible) throw new GenerationError('案件骨架生成失败')
  let assembled = bible

  for (let index = 0; index < assembled.roles.length; index += 1) {
    const role = assembled.roles[index]
    const step = index + 2
    const label = `正在撰写 ${role.name}（${index + 1}/${assembled.roles.length}）`
    req.onProgress?.(progressPayload(step, totalSteps, labels, label))
    let rolePrompt = buildRoleScriptPrompt(bible, role.name, req.playerCount)
    let generated = false

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await caller(req, ROLE_SCRIPT_SYSTEM_PROMPT, rolePrompt, maxTokens)
      if (raw.finishReason === 'length') {
        throw new GenerationError(`${role.name} 的剧本输出被截断`, [
          `模型达到单次 ${maxTokens} token 输出上限。`,
          '请在设置中提高最大输出 Token；角色剧本已拆分生成，不应再出现整桌内容截断。',
        ])
      }
      const parsed = parseRoleScriptResponse(raw.content, req.playerCount)
      if (parsed.ok && parsed.full_script) {
        assembled = mergeRoleScript(assembled, role.name, parsed.full_script)
        generated = true
        break
      }
      if (attempt === 0) {
        rewrites += 1
        warnings.push(`${role.name} 的剧本未达标，已要求单独重写`)
        rolePrompt += `\n\n【上一次角色正文不合格】\n${parsed.errors.join('\n')}\n必须重新写完整角色正文，不要解释。`
        continue
      }
      throw new GenerationError(`${role.name} 的剧本生成失败`, parsed.errors)
    }
    if (!generated) throw new GenerationError(`${role.name} 的剧本生成失败`)
  }

  const finalStep = totalSteps
  req.onProgress?.(progressPayload(finalStep, totalSteps, labels, labels[labels.length - 1]))
  const finalCheck = validateScriptPackage(assembled, req.playerCount)
  if (!finalCheck.ok || !finalCheck.data) {
    throw new GenerationError('完整剧本未通过最终校验', finalCheck.errors)
  }
  return {
    pkg: finalCheck.data,
    provider: 'openai',
    raw: JSON.stringify(finalCheck.data),
    rewrites,
    warnings,
  }
}

/** 离线生成（内置剧本库已按人数产出合规长度，无需重写） */
export async function generateWithOffline(req: GenerateRequest): Promise<GenerationResult> {
  const pkg = await generateOfflineScript({
    playerCount: req.playerCount,
    theme: req.theme,
    stepDelay: req.offlineStepDelayMs,
    onProgress: req.onProgress,
  })
  const check = validateScriptPackage(pkg, req.playerCount)
  if (!check.ok || !check.data) {
    // 内置库自身不合法属于开发期问题，直接抛出便于发现
    throw new GenerationError('内置剧本库未通过校验', check.errors)
  }
  const duplicate = findDuplicateScript(check.data, req.uniqueness?.history ?? [])
  if (duplicate) {
    throw new GenerationError('内置剧本与最近对局重复', [
      `离线引擎的内置案件「${duplicate.theme}」最近已经玩过。`,
      '离线引擎使用有限内置模板，无法保证无限不重复；请换一个完全不同的题材，或使用真实大模型生成全新案件。',
    ])
  }
  return { pkg: check.data, provider: 'offline', rewrites: 0, warnings: [] }
}

/** 统一入口 */
export async function generateScript(req: GenerateRequest): Promise<GenerationResult> {
  if (req.config.provider === 'openai') {
    if (!req.config.apiKey) {
      throw new GenerationError('尚未填写 API Key', [
        '你选择了「真实大模型」，但没有配置密钥。',
        '可以到「设置」里补全，或切回「离线模拟引擎」。',
      ])
    }
    return generateWithOpenAI(req)
  }
  return generateWithOffline(req)
}

/** 连通性测试：真实端点用它验证 Base URL / Key / 模型名 */
export async function testConnection(config: AiConfig): Promise<{ ok: boolean; message: string }> {
  if (config.provider === 'offline') {
    return { ok: true, message: '离线模拟引擎随时可用，无需联网。' }
  }
  if (!config.apiKey) return { ok: false, message: '请先填写 API Key' }
  if (!config.baseUrl) return { ok: false, message: '请先填写 Base URL' }

  const url = config.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 8,
        messages: [{ role: 'user', content: '回复：ok' }],
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, message: `HTTP ${res.status}：${body.slice(0, 200)}` }
    }
    return { ok: true, message: '连接成功，可以开始生成剧本了。' }
  } catch (e) {
    return { ok: false, message: `连接失败：${(e as Error).message}` }
  }
}
