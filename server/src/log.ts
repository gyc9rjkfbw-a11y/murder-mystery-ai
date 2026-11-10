/**
 * 中文日志工具
 * ------------------------------------------------------------------
 * 用户会盯着终端确认「朋友进来了」，所以关键事件（建房 / 加入 / 阶段推进 /
 * 搜证 / 投票 / 结算）都保证打一行带时间与房间号的日志。
 */

export type Logger = (line: string) => void

/** 创建一个日志函数；enabled=false 时静默（测试里用得到） */
export function createLogger(enabled = true, scope = '房间服务'): Logger {
  return (line: string) => {
    if (!enabled) return
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    console.log(`[${t}] [${scope}] ${line}`)
  }
}

/** 阶段中文名，日志里用 */
export const PHASE_TEXT: Record<string, string> = {
  lobby: '大厅',
  room: '组局',
  dealing: '下发剧本',
  reading: '阅读剧本',
  statement: '集中陈述',
  search: '自由搜证',
  poll: '意向投票',
  organize: '个人整理',
  voting: '最终投票',
  reveal: '复盘结算',
}

export function phaseText(phase: string): string {
  return PHASE_TEXT[phase] ?? phase
}