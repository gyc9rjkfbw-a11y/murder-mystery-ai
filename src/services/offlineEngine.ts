import type { ScriptPackage } from '@/types/script'
import { pacingFor } from './rules'
import { adaptTheme, pickTemplate } from './templates'

/**
 * 离线模拟引擎
 * ------------------------------------------------------------------
 * 作用：在没有大模型 API Key 的情况下，用内置剧本库产出 **完全符合
 * 《指令》JSON 结构** 的剧本包，让前端全流程可以立即跑通、演示、联调。
 *
 * 它刻意模拟了《核心系统架构设计》中的「三步生成法」耗时节奏，
 * 并补上产品升级后的第 4 步「字数自检」，
 * 以便剧本下发页的进度动画在接入真实 API 后行为一致：
 *   第一步：全局真相与角色矩阵
 *   第二步：游戏博弈框架 + 三批线索
 *   第三步：逐个生成带沉浸文笔的角色剧本
 *   第四步：字数自检与支线任务校验
 */

export interface GenerateProgress {
  /** 当前第几步（从 1 开始） */
  step: number
  /** 总步数 */
  totalSteps: number
  /** 当前步骤说明 */
  label: string
  /** 当前管线的全部步骤名称（在线分阶段生成时动态变化） */
  labels?: string[]
}

export interface OfflineGenerateOptions {
  playerCount: number
  theme: string
  onProgress?: (p: GenerateProgress) => void
  /** 每步模拟耗时（毫秒），测试时可传 0 */
  stepDelay?: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 生成管线的四个步骤（前三步即架构文档中的「三步生成法」） */
export const GENERATION_PIPELINE = [
  '正在推演全局真相与角色矩阵……',
  '正在搭建游戏博弈框架与三批线索……',
  '正在逐个生成角色的沉浸式剧本……',
  '正在执行字数自检与支线任务校验……',
] as const

/** 兼容旧引用 */
export const THREE_STEP_PIPELINE = GENERATION_PIPELINE

export async function generateOfflineScript(
  options: OfflineGenerateOptions,
): Promise<ScriptPackage> {
  const { playerCount, theme, onProgress, stepDelay = 800 } = options
  const tpl = pickTemplate(theme)
  const rule = pacingFor(playerCount)

  for (let i = 0; i < GENERATION_PIPELINE.length; i += 1) {
    let label: string = GENERATION_PIPELINE[i]
    if (i === 2) {
      label = `${label}目标 ${rule.scriptMin}-${rule.scriptMax} 字/人`
    }
    if (i === 3) {
      label = `${label}本局 ${rule.maxRounds} 轮${
        rule.searchRounds > 0 ? `、每轮搜证` : ''
      }`
    }
    onProgress?.({ step: i + 1, totalSteps: GENERATION_PIPELINE.length, label })
    if (stepDelay > 0) await sleep(stepDelay)
  }

  const pkg = adaptTheme(tpl, theme, playerCount)
  onProgress?.({
    step: GENERATION_PIPELINE.length,
    totalSteps: GENERATION_PIPELINE.length,
    label: '剧本已通过自检，正在分发到各端……',
  })
  return pkg
}
