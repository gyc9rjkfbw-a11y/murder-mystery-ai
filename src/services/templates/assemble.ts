import type {
  ClueBatch,
  GameConfig,
  GlobalTruth,
  MurdererPrivilege,
  PrivateClue,
  Role,
  ScriptPackage,
  SearchLocation,
} from '@/types/script'
import { pacingFor, CLUE_TIER_LABELS, scriptLength } from '@/services/rules'

/**
 * 按人数拼装剧本（动态长度与复杂度控制）
 * ------------------------------------------------------------------
 * 核心思路：**一份长剧本，按段落重要性拼装出三个长度档位**。
 *
 * 模板作者只需为每个角色写一份 1000-1200 字的多段落长剧本，
 * 段落顺序按重要性排列：
 *   ① 角色小传与性格
 *   ② 内心挣扎与动机
 *   ③ 案发当日感官回忆（可拆成 2 段）
 *   ④ 补充细节 / 往事 / 支线（可被裁剪的部分）
 *   ⑤ 行为准则（其一…其二…其三）
 *
 * 然后：
 *   4 人局 → 取前面若干段凑到 600-800 字
 *   5 人局 → 800-1000 字
 *   6 人局 → 全量 1000-1200 字 + 渗透支线任务
 * 行为准则永远保留在最后，不会被裁掉。
 */

/** 统计非空白字符数（中文按字计） */
export { scriptLength }

/** 是否为「行为准则」段落 */
function isRuleParagraph(p: string): boolean {
  return /^其[一二三四五六]/.test(p.trim())
}

/**
 * 把一份长剧本拼装到目标字数区间。
 * - 正文段落按顺序贪心累加，超过上限则跳过该段继续尝试后面的短段
 * - 行为准则段落始终保留并置于末尾
 * - 若全量仍不足下限，则返回全量（尽力而为，由校验层给出告警）
 */
export function assembleScript(fullScript: string, min: number, max: number): string {
  const paragraphs = fullScript
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)

  const body: string[] = []
  const rules: string[] = []
  for (const p of paragraphs) {
    if (isRuleParagraph(p)) rules.push(p)
    else body.push(p)
  }

  const rulesText = rules.join('\n')
  const rulesLen = scriptLength(rulesText)
  const budgetMax = Math.max(0, max - rulesLen)
  const budgetMin = Math.max(0, min - rulesLen)

  const picked: string[] = []
  let used = 0
  for (const p of body) {
    const len = scriptLength(p)
    if (used >= budgetMin && used + len > budgetMax) continue
    if (used + len > budgetMax) continue
    picked.push(p)
    used += len
  }

  // 至少要有一段正文，否则说明段落实在太长，退回全量
  if (picked.length === 0) return fullScript.trim()

  return [...picked, rulesText].filter(Boolean).join('\n\n')
}

/** 模板原始素材：由各题材文件提供，不含人数差异 */
export interface TemplateSource {
  theme: string
  backgroundStory: string
  /** 6 个角色，凶手排第 1 位（保留优先级）；full_script 为长剧本 */
  allRoles: Role[]
  globalTruth: GlobalTruth
  murdererPrivilege: MurdererPrivilege
  /** 三批线索：基础 / 深度 / 决定性 */
  clueBatches: ClueBatch[]
  /** 6 个搜证地点 */
  searchLocations: SearchLocation[]
  /** 各角色私有线索 */
  privateClues: PrivateClue[]
}

const deepCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** 按人数生成最终剧本包（人数归一化到 4/5/6） */
export function buildScriptPackage(source: TemplateSource, playerCount: number): ScriptPackage {
  const n = Math.min(6, Math.max(4, Math.floor(Number(playerCount) || 6)))
  const rule = pacingFor(n)

  const roles: Role[] = deepCopy(source.allRoles)
    .slice(0, n)
    .map((role) => ({
      ...role,
      full_script: assembleScript(role.full_script, rule.scriptMin, rule.scriptMax),
      // 支线任务是 6 人局防边缘化机制，人少时不需要
      side_quests: n === 6 ? (role.side_quests ?? []).slice(0, 2) : [],
    }))

  const roleNames = new Set(roles.map((r) => r.name))

  const clueBatches: ClueBatch[] = deepCopy(source.clueBatches)
    .sort((a, b) => a.tier - b.tier)
    .map((b) => ({
      tier: b.tier,
      title: b.title || CLUE_TIER_LABELS[b.tier] || `第 ${b.tier} 批线索`,
      clues: b.clues.filter(Boolean),
    }))
    .filter((b) => b.clues.length > 0)

  // 4 人局 4 个地点，5 人局 5 个，6 人局 6 个
  const searchLocations = deepCopy(source.searchLocations).slice(0, n)

  const privateClues = deepCopy(source.privateClues).filter((c) => roleNames.has(c.role_name))

  const gameConfig: GameConfig = {
    theme: source.theme,
    player_count: n,
    background_story: source.backgroundStory,
  }

  return {
    game_config: gameConfig,
    global_truth: deepCopy(source.globalTruth),
    roles,
    murderer_privilege: deepCopy(source.murdererPrivilege),
    public_clues: clueBatches.flatMap((b) => b.clues),
    clue_batches: clueBatches,
    private_clues: privateClues,
    search_locations: searchLocations,
  }
}