import type { ScriptPackage } from '@/types/script'

/**
 * 离线剧本模板
 * ------------------------------------------------------------------
 * 一个模板提供 **6 个角色** 的完整剧本（含凶手、全局真相、凶手特权、
 * 公共线索与搜证地点），并在 `create(playerCount)` 中按人数裁剪：
 *   4 人 → 保留 4 个核心角色
 *   5 人 → 保留 5 个（多一个关系枢纽角色）
 *   6 人 → 全量
 * 裁剪后必须仍然满足：
 *   - 恰好 1 名凶手，且 `global_truth.murderer_name` 指向他/她
 *   - `player_count` 与实际角色数一致
 *   - 所有角色的表层任务在「集中陈述」环节能相互碰撞（不允许逻辑死锁）
 */
export interface ScriptTemplate {
  /** 模板 id */
  id: string
  /** 题材名称 */
  theme: string
  /** 匹配用户输入题材的关键词 */
  keywords: string[]
  /** 一句话卖点，用于卡片展示 */
  tagline: string
  /** 生成指定人数的完整剧本包 */
  create(playerCount: number): ScriptPackage
}