import type { ClueBatch, Role, ScriptPackage, ValidationResult } from '@/types/script'
import { CLUE_TIER_LABELS, pacingFor, scriptLength } from './rules'

/**
 * 事实校验机制
 * ------------------------------------------------------------------
 * 《核心系统架构设计》明确要求：「防范 AI 幻觉：必须在系统底层建立
 * 事实校验机制」。所有进入游戏状态机的剧本包，都必须先过这一关。
 *
 * 这里做的是结构性与一致性校验（可离线、零成本）：
 *   1. 必填字段齐全且类型正确
 *   2. 角色数 == game_config.player_count == 房间人数
 *   3. 恰好一名凶手，且 global_truth.murderer_name 指向他/她
 *   4. 每个角色的 full_script / surface_task / deep_task / personal_timeline 非空
 *   5. **字数自检**：按人数执行 1500-1900 / 1900-2400 / 2300-2800 的硬性字数区间，
 *      超出即拦截（线上引擎会据此自动要求 AI 重写）
 *   6. 6 人局每个角色必须有独立支线任务（防边缘化）
 *   7. 凶手特权不得直接点名凶手（模糊度检查）
 */

const FORBIDDEN_IN_HINT = ['你就是凶手', '你是凶手', '凶手就是你', '是你杀', '你杀了他', '你杀死了']

/** 字数不合规的错误前缀，便于上层识别并触发重写 */
export const LENGTH_ERROR_PREFIX = '字数不合规'

export function isLengthViolation(errors: string[]): boolean {
  return errors.some((e) => e.startsWith(LENGTH_ERROR_PREFIX))
}

/** 是否缺少支线任务 */
export function isSideQuestViolation(errors: string[]): boolean {
  return errors.some((e) => e.includes('独立支线任务'))
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * 凶手特权模糊度检查：直觉提示不能太直白，否则等于直接报身份。
 * 参考《避坑指南》：「AI 给出的直觉提示绝对不能太直白……
 * 要在 Prompt 中强制要求 AI 使用心理感知而非事实陈述。」
 */
export function checkHintBlur(hint: string): string[] {
  const errors: string[] = []
  const hit = FORBIDDEN_IN_HINT.find((w) => hint.includes(w))
  if (hit) errors.push(`凶手直觉提示出现事实性自曝用语「${hit}」，违反模糊度要求`)
  if (/\d{1,2}\s*[:：]\s*\d{2}/.test(hint)) {
    errors.push('凶手直觉提示出现了具体时间点，违反模糊度要求')
  }
  if (hint.length > 420) errors.push('凶手直觉提示过长，容易变成事实陈述')
  return errors
}

/** 校验并规范化一个剧本包 */
export function validateScriptPackage(
  raw: unknown,
  expectedPlayerCount?: number,
): ValidationResult {
  const errors: string[] = []

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['返回内容不是合法的 JSON 对象'] }
  }
  const data = raw as Partial<ScriptPackage>

  // --- game_config ---
  const cfg = data.game_config
  if (!cfg || typeof cfg !== 'object') {
    errors.push('缺少 game_config')
  } else {
    if (!isNonEmptyString(cfg.theme)) errors.push('game_config.theme 缺失')
    if (!isNonEmptyString(cfg.background_story)) errors.push('game_config.background_story 缺失')
    const pc = Number(cfg.player_count)
    if (!Number.isFinite(pc) && !Number.isFinite(Number(expectedPlayerCount))) {
      errors.push('game_config.player_count 不是数字')
    }
  }

  // --- global_truth ---
  const truth = data.global_truth
  if (!truth || typeof truth !== 'object') {
    errors.push('缺少 global_truth')
  } else {
    if (!isNonEmptyString(truth.murderer_name)) errors.push('global_truth.murderer_name 缺失')
    if (!isNonEmptyString(truth.cause_of_death)) errors.push('global_truth.cause_of_death 缺失')
    if (!isNonEmptyString(truth.absolute_timeline)) {
      errors.push('global_truth.absolute_timeline 缺失')
    }
  }

  // --- roles ---
  const roles = Array.isArray(data.roles) ? (data.roles as Role[]) : []
  const playerCount = Number(expectedPlayerCount ?? cfg?.player_count ?? roles.length)
  const rule = pacingFor(playerCount)

  if (roles.length === 0) {
    errors.push('roles 为空')
  } else {
    roles.forEach((r, i) => {
      const tag = `roles[${i}]（${r?.name ?? '未命名'}）`
      if (!isNonEmptyString(r?.name)) errors.push(`${tag}.name 缺失`)
      if (!isNonEmptyString(r?.identity)) errors.push(`${tag}.identity 缺失`)
      if (!isNonEmptyString(r?.surface_task)) errors.push(`${tag}.surface_task 缺失`)
      if (!isNonEmptyString(r?.deep_task)) errors.push(`${tag}.deep_task 缺失`)
      if (!isNonEmptyString(r?.personal_timeline)) errors.push(`${tag}.personal_timeline 缺失`)
      if (!isNonEmptyString(r?.full_script)) {
        errors.push(`${tag}.full_script 缺失`)
      } else {
        // 字数自检：4 人 1500-1900 / 5 人 1900-2400 / 6 人 2300-2800
        const len = scriptLength(r.full_script)
        if (len > rule.scriptMax) {
          errors.push(
            `${LENGTH_ERROR_PREFIX}：${playerCount} 人局的 ${tag}.full_script 有 ${len} 字，` +
              `超过上限 ${rule.scriptMax} 字，必须精简重写`,
          )
        } else if (len < rule.scriptMin) {
          errors.push(
            `${LENGTH_ERROR_PREFIX}：${playerCount} 人局的 ${tag}.full_script 只有 ${len} 字，` +
              `低于下限 ${rule.scriptMin} 字，内容过于单薄`,
          )
        }
      }
      // 6 人局防边缘化：必须有独立支线任务
      if (rule.sideQuestMin > 0) {
        const quests = Array.isArray(r?.side_quests) ? r.side_quests.filter(isNonEmptyString) : []
        if (quests.length < rule.sideQuestMin) {
          errors.push(
            `${tag} 缺少独立支线任务：${playerCount} 人局每人需要至少 ${rule.sideQuestMin} 条` +
              `与主线无关的 side_quests`,
          )
        }
      }
    })

    const murderers = roles.filter((r) => r?.is_murderer === true)
    if (murderers.length !== 1) {
      errors.push(`凶手数量为 ${murderers.length}，必须恰好 1 名`)
    } else if (truth && isNonEmptyString(truth.murderer_name)) {
      if (murderers[0].name.trim() !== truth.murderer_name.trim()) {
        errors.push(
          `global_truth.murderer_name（${truth.murderer_name}）与 is_murderer 角色（${murderers[0].name}）不一致`,
        )
      }
    }

    if (expectedPlayerCount && roles.length !== expectedPlayerCount) {
      errors.push(`角色数量 ${roles.length} 与房间人数 ${expectedPlayerCount} 不一致`)
    }
    if (cfg && Number.isFinite(Number(cfg.player_count)) && Number(cfg.player_count) !== roles.length) {
      errors.push(`game_config.player_count（${cfg.player_count}）与 roles 数量（${roles.length}）不一致`)
    }
  }

  // --- murderer_privilege ---
  const priv = data.murderer_privilege
  if (!priv || !isNonEmptyString(priv.intuition_hint)) {
    errors.push('缺少 murderer_privilege.intuition_hint')
  } else {
    errors.push(...checkHintBlur(priv.intuition_hint))
  }

  // --- 线索 ---
  const batches = Array.isArray(data.clue_batches) ? data.clue_batches : []
  const hasBatches = batches.some((b) => Array.isArray(b?.clues) && b.clues.length > 0)
  if (!hasBatches && (!Array.isArray(data.public_clues) || data.public_clues.length === 0)) {
    errors.push('clue_batches 与 public_clues 均为空，至少要有三批线索')
  }

  if (errors.length > 0) return { ok: false, errors }

  return { ok: true, errors: [], data: normalizeScriptPackage(data as ScriptPackage) }
}

/**
 * 规范化：补齐扩展字段。
 * 真实大模型可能不返回 clue_batches / private_clues / search_locations，
 * 这里自动兜底，保证轮次推进与「自由搜证」环节永远可玩。
 */
export function normalizeScriptPackage(pkg: ScriptPackage): ScriptPackage {
  const out: ScriptPackage = {
    ...pkg,
    game_config: { ...pkg.game_config, player_count: pkg.roles.length },
    roles: pkg.roles.map((r, i) => ({
      ...r,
      is_murderer: r.is_murderer === true || (pkg.global_truth?.murderer_name === r.name && i === 0),
      side_quests: Array.isArray(r.side_quests) ? [...r.side_quests] : [],
    })),
    public_clues: [...pkg.public_clues],
  }

  // 线索批次：缺失时把 public_clues 按 4:4:2 切成三批
  const batches = (pkg.clue_batches ?? []).filter((b) => Array.isArray(b?.clues) && b.clues.length > 0)
  if (batches.length === 0) {
    out.clue_batches = splitIntoBatches(out.public_clues)
  } else {
    out.clue_batches = batches
      .map((b) => ({
        tier: Number(b.tier) || 1,
        title: b.title || CLUE_TIER_LABELS[Number(b.tier)] || '线索',
        clues: b.clues.filter(isNonEmptyString),
      }))
      .sort((a, b) => a.tier - b.tier)
  }
  // public_clues 始终等于三批的并集，避免两处不一致
  const merged = out.clue_batches.flatMap((b) => b.clues)
  if (merged.length > 0) out.public_clues = merged

  if (!out.private_clues || out.private_clues.length === 0) {
    out.private_clues = out.roles.map((r, i) => ({
      role_name: r.name,
      text: `你私下留意到：${out.public_clues[i % Math.max(1, out.public_clues.length)] ?? '现场有些不对劲'}`,
    }))
  }

  const locationNames = ['案发现场', '二层走廊', '杂物间', '庭院', '厨房与酒窖', '客房区']
  const clues = out.public_clues
  if (!out.search_locations || out.search_locations.length === 0) {
    const per = Math.max(1, Math.ceil(clues.length / locationNames.length))
    out.search_locations = locationNames
      .map((name, i) => ({ name, clues: clues.slice(i * per, i * per + per) }))
      .filter((l) => l.clues.length > 0)
  }

  return out
}

/** 把一堆线索按 4:4:2 切成基础 / 深度 / 决定性三批 */
export function splitIntoBatches(clues: string[]): ClueBatch[] {
  const clean = clues.filter(isNonEmptyString)
  if (clean.length === 0) return []
  const n = clean.length
  const cut1 = Math.max(1, Math.round(n * 0.4))
  const cut2 = Math.max(cut1 + 1, Math.round(n * 0.8))
  const parts: string[][] = [clean.slice(0, cut1), clean.slice(cut1, cut2), clean.slice(cut2)]
  return parts
    .map((items, i) => ({
      tier: i + 1,
      title: CLUE_TIER_LABELS[i + 1],
      clues: items,
    }))
    .filter((b) => b.clues.length > 0)
}
