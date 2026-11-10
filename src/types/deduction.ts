/** 个人推理工作台只保存在本机，不进入联机协议。 */
export type SuspicionLevel = 0 | 1 | 2 | 3
export type TimelineStatus = 'unknown' | 'steady' | 'gap' | 'contradiction'
export type ReviewMark = 'trusted' | 'contradiction'

export interface SuspectDossier {
  /** 0 未判断 / 1 留意 / 2 可疑 / 3 最可疑 */
  suspicion: SuspicionLevel
  /** 对手时间线的判断 */
  timeline: TimelineStatus
  /** 是否发现明确动机 */
  motive: boolean
  /** 当前玩家能看到的线索 id */
  clueIds: string[]
  note: string
}

export interface DeductionBoard {
  version: 1
  gameKey: string
  suspects: Record<string, SuspectDossier>
  finalSuspect: string
  finalReasons: string[]
  summary: string
  scratchpad: string
  reviewMarks: Record<string, ReviewMark>
  updatedAt: number
}

export interface CaseSummary {
  target: string
  reasonCount: number
  clueCount: number
  complete: boolean
  missing: string[]
  text: string
}
