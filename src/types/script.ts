/**
 * 剧本数据契约
 * ------------------------------------------------------------------
 * 这里的字段与《剧本杀 AI 游戏引擎系统指令（System Prompt）》中约定的
 * JSON 输出结构 **严格一一对应**（见 src/services/systemPrompt.ts）。
 * 任何后端 / 大模型返回的数据，都必须先通过 `validateScriptPackage`
 * 校验后才能进入游戏状态机。
 */

/** game_config：全局配置 */
export interface GameConfig {
  /** 题材名称 */
  theme: string
  /** 玩家人数（4-6） */
  player_count: number
  /** 200 字以内的故事背景，交代时代、场景和死者信息 */
  background_story: string
}

/** global_truth：全局真相，仅系统（与复盘环节）可见 */
export interface GlobalTruth {
  /** 凶手角色姓名 */
  murderer_name: string
  /** 真实死因与作案手法 */
  cause_of_death: string
  /** 绝对客观的作案时间线（精确到分钟，仅系统可见） */
  absolute_timeline: string
}

/** roles[]：单个角色 */
export interface Role {
  /** 角色姓名 */
  name: string
  /** 角色身份 */
  identity: string
  /** 是否为凶手 */
  is_murderer: boolean
  /** 表层任务（开局必须完成的隐藏小目标，如隐瞒某事、寻找某物） */
  surface_task: string
  /** 深层任务（与主线案件相关的隐藏动机或阵营目标） */
  deep_task: string
  /** 案发当天该玩家的详细行动轨迹 */
  personal_timeline: string
  /**
   * 完整沉浸式剧本。
   * 字数由 `player_count` 决定（见 src/services/rules.ts）：
   * 4 人 1500-1900 / 5 人 1900-2400 / 6 人 2300-2800（非空白字符）。
   */
  full_script: string
  /**
   * 扩展：独立支线任务（6 人局必须，1-2 条）。
   * 与主线案件无直接关系，用来消耗玩家精力、增加交流话题、防止被边缘化。
   */
  side_quests?: string[]
}

/** 扩展：一批系统发放的线索（按轮次分批释出） */
export interface ClueBatch {
  /** 批次：1 基础 / 2 深度 / 3 决定性 */
  tier: number
  /** 批次标题，如「第一批 · 基础现场线索」 */
  title: string
  /** 本批线索（纯文本） */
  clues: string[]
}

/** murderer_privilege：凶手特权 */
export interface MurdererPrivilege {
  /** 写给凶手的直觉提示（第二人称），必须是对他人表层任务的模糊心理感知 */
  intuition_hint: string
}

/** 搜证地点（扩展字段，可选） */
export interface SearchLocation {
  /** 地点名称，如「二层走廊」 */
  name: string
  /** 该地点可被搜出的线索（纯文本） */
  clues: string[]
}

/**
 * 一份完整剧本包。
 *
 * 前 5 个字段是指令中强制要求的 JSON 结构；
 * `private_clues` / `search_locations` 是本项目为「自由搜证」环节补充的
 * **可选扩展字段**，离线模拟引擎会填充它们，真实大模型若不返回则由前端
 * 从 public_clues 中按地点自动分发。
 */
export interface ScriptPackage {
  game_config: GameConfig
  global_truth: GlobalTruth
  roles: Role[]
  murderer_privilege: MurdererPrivilege
  public_clues: string[]

  /** 扩展：按轮次分批发放的线索（缺失时由 public_clues 自动切分） */
  clue_batches?: ClueBatch[]
  /** 扩展：角色私有线索（仅该角色可见） */
  private_clues?: PrivateClue[]
  /** 扩展：搜证地点分布 */
  search_locations?: SearchLocation[]
}

/** 扩展：角色私有线索 */
export interface PrivateClue {
  /** 线索归属角色姓名 */
  role_name: string
  /** 线索内容 */
  text: string
}

/** 已到手的一条线索（在搜证/整理环节流转的对象） */
export interface ClueItem {
  id: string
  text: string
  /** 来源地点；系统发放的线索为批次标题 */
  location: string
  /** 是否为私有线索 */
  isPrivate: boolean
  /** 系统发放的线索批次（1/2/3）；搜证与私有线索为空 */
  tier?: number
  /** 私有线索的归属角色姓名 */
  ownerRoleName?: string
  /** 发现者（玩家座位 id） */
  foundBy?: string
  /** 是否已被搜出（对搜出者可见） */
  revealed: boolean
  /** 是否已公开到公共线索板（所有玩家可见） */
  published: boolean
  /** 是否已加入个人线索板 */
  pinned: boolean
}

/** 校验结果 */
export interface ValidationResult {
  ok: boolean
  errors: string[]
  /** 校验通过时返回补齐扩展字段后的剧本包 */
  data?: ScriptPackage
}

export const PHASE_ORDER = [
  'lobby',
  'room',
  'dealing',
  'reading',
  'statement',
  'search',
  'organize',
  'voting',
  'reveal',
] as const
