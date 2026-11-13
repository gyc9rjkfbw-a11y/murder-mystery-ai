/**
 * 节奏规则层（按人数的轮次 / 搜证 / 时长 / 字数基准）
 * ------------------------------------------------------------------
 * 这是「一局游戏怎么跑」的唯一事实来源。状态机、阅读页时长、
 * AI 指令、字数校验、UI 进度条全部从这里取值，避免各处硬编码。
 *
 * 设计依据（产品给定的节奏规范）：
 *   4 人局：2 轮 —— 铺陈时间线 → 核心冲突，
 *           人少，每个人都能被充分质询，剧情高度浓缩。
 *   5 人局：3 轮 —— 铺陈 → 高潮 → 决战，最经典的配置。
 *   6 人局：3 轮 + 每轮搜证 —— 多线并行，额外给支线任务防止挂机。
 */

export interface PacingRule {
  playerCount: number
  /** 配置档位名 */
  label: string
  /** 硬性发言轮次上限 */
  maxRounds: number
  /** 需要搜证的轮次数（0 = 不设搜证环节，线索由系统分批发放） */
  searchRounds: number
  /** 每人每轮可搜证次数 */
  searchPerRound: number
  /** 阅读剧本时长（秒） */
  readingSeconds: number
  /** 每轮陈述时长（秒） */
  roundSeconds: number
  /** 角色剧本字数下限（非空白字符） */
  scriptMin: number
  /** 角色剧本字数上限（非空白字符） */
  scriptMax: number
  /** 提前结算阈值：多少票指向同一人即提示跳过剩余轮次 */
  accelerateVotes: number
  /** 第几轮为凶手解锁特权面板 */
  privilegeRound: number
  /** 6 人局每人必须生成的独立支线任务数下限 */
  sideQuestMin: number
  /** 半场无人发言多少秒后触发 AI 侦探提示（0 = 不启用） */
  idleHintSeconds: number
}

export const PACING_RULES: Record<number, PacingRule> = {
  4: {
    playerCount: 4,
    label: '极简紧凑 · 高信息密度',
    maxRounds: 2,
    searchRounds: 0,
    searchPerRound: 0,
    readingSeconds: 12 * 60,
    roundSeconds: 4 * 60,
    scriptMin: 1500,
    scriptMax: 2200,
    accelerateVotes: 3,
    privilegeRound: 2,
    sideQuestMin: 0,
    idleHintSeconds: 0,
  },
  5: {
    playerCount: 5,
    label: '标准均衡 · 经典配置',
    maxRounds: 3,
    searchRounds: 0,
    searchPerRound: 0,
    readingSeconds: 16 * 60,
    roundSeconds: 5 * 60,
    scriptMin: 1900,
    scriptMax: 2900,
    accelerateVotes: 4,
    privilegeRound: 2,
    sideQuestMin: 0,
    idleHintSeconds: 0,
  },
  6: {
    playerCount: 6,
    label: '多线并行 · 防边缘化',
    maxRounds: 3,
    searchRounds: 3,
    searchPerRound: 2,
    readingSeconds: 20 * 60,
    roundSeconds: 6 * 60,
    scriptMin: 2300,
    scriptMax: 3300,
    accelerateVotes: 5,
    privilegeRound: 2,
    sideQuestMin: 1,
    idleHintSeconds: 90,
  },
}

/** 取某个配置档的节奏规则（超范围按 6 人处理） */
export function pacingFor(playerCount: number): PacingRule {
  const n = Number(playerCount)
  if (n <= 4) return PACING_RULES[4]
  if (n === 5) return PACING_RULES[5]
  return PACING_RULES[6]
}

/**
 * 统计剧本字数：按**非空白字符**计（中文字符逐个计数）。
 * 产品规范里的「1500-2200 字」「2300-3300 字」都以此口径为准，
 * 换行与缩进不计入，避免排版差异导致字数误判。
 */
export function scriptLength(text: string): number {
  return text.replace(/\s/g, '').length
}

export interface RoundTheme {
  round: number
  /** 标题，如「第二轮 · 核心冲突与秘密碰撞」 */
  title: string
  /** 这一轮玩家该干什么 */
  goal: string
  /** 这一轮系统要做什么 */
  systemAction: string
}

/**
 * 某一轮的定位文案。
 * 4 人局只有 2 轮，第二轮的定位是「核心冲突 + 逻辑收网」的合并版。
 */
export function roundTheme(round: number, maxRounds: number): RoundTheme {
  if (round >= maxRounds && maxRounds === 2) {
    return {
      round,
      title: '第二轮 · 核心冲突与逻辑收网',
      goal: '针对第一轮的漏洞深度质询，好人为了掩护秘密开始撒谎，凶手带节奏',
      systemAction: '发放第二批深度线索，并为凶手解锁特权面板',
    }
  }
  const table: Record<number, RoundTheme> = {
    1: {
      round: 1,
      title: '第一轮 · 破冰与时间线对齐',
      goal: '交代案发前后的行踪，自然暴露各自的表层任务',
      systemAction: '发放第一批基础公共线索（现场勘察、死者死因、基本人际关系）',
    },
    2: {
      round: 2,
      title: '第二轮 · 核心冲突与秘密碰撞',
      goal: '抓住第一轮的矛盾点深度质询，凶手用别人的秘密转移视线',
      systemAction: '发放第二批深度线索，并为凶手解锁特权面板',
    },
    3: {
      round: 3,
      title: '第三轮 · 逻辑收网与最终陈述',
      goal: '不再纠结细枝末节，集中盘问作案手法与动机',
      systemAction: '发放第三批决定性线索，随后强制关闭发言',
    },
  }
  return table[round] ?? table[3]
}

/** 三批线索的固定档位说明 */
export const CLUE_TIER_LABELS: Record<number, string> = {
  1: '第一批 · 基础现场线索',
  2: '第二批 · 深度线索',
  3: '第三批 · 决定性线索',
}

/** 阅读时长文案 */
export function readingTimeText(seconds: number): string {
  return `${Math.round(seconds / 60)} 分钟`
}

/** 提前结算的票数阈值文案 */
export function accelerateText(playerCount: number): string {
  return `${pacingFor(playerCount).accelerateVotes} 人指认同一人`
}
