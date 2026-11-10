import { defineStore } from 'pinia'
import { computed, reactive } from 'vue'
import { generateScript, GenerationError, type GenerateProgress } from '@/services/aiEngine'
import { makeBotStatement, makeBotVoteTarget } from '@/services/bots'
import {
  CLUE_TIER_LABELS,
  pacingFor,
  roundTheme,
  type PacingRule,
  type RoundTheme,
} from '@/services/rules'
import type { ClueItem, Role, ScriptPackage } from '@/types/script'
import { validateScriptPackage } from '@/services/validator'
import {
  AVATARS,
  makeRoomCode,
  phaseMeta,
  type GamePhase,
  type GameState,
  type RoundSummary,
  type Seat,
  type SettlementRow,
  type Statement,
  type VoteRecord,
} from '@/types/game'
import { useSettingsStore } from './settings'
import type { ClientMsg, SeatView } from '@/services/net/protocol'

const BOT_NAMES = ['林小满', '周砚', '苏泠', '陈默', '顾青梧', '白鹭', '沈知遥', '唐见山']
const BOT_AVATARS = ['🎩', '🕰️', '🧣', '📻', '🪶', '🔮', '🥀', '🧤']

/**
 * 联网桥：由 `stores/net.ts` 注入。
 * 这样本文件不需要 import net store（避免 Pinia 循环依赖），
 * 联机时所有动作都变成「发一条命令给服务器」，本地不做任何状态推进。
 */
export interface OnlineBridge {
  active: () => boolean
  send: (msg: ClientMsg) => boolean
  clockSkew: () => number
}

let onlineBridge: OnlineBridge | null = null

/** 联机时给服务器发命令；非联机返回 false 让调用方走本地逻辑 */
function netSend(msg: ClientMsg): boolean {
  if (!onlineBridge?.active()) return false
  onlineBridge.send(msg)
  return true
}

/** 每轮每人可搜证次数（6 人局） */
export const SEARCH_TIMES = 2
/** 个人整理时长（秒）——强制进入，给玩家 5 分钟收网 */
export const ORGANIZE_SECONDS = 300

/** 进度条上的一格 */
export interface FlowStep {
  key: string
  label: string
  phase: GamePhase
  round?: number
}

function shuffle<T>(list: T[]): T[] {
  const arr = [...list]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function emptyState(): GameState {
  return {
    phase: 'lobby',
    roomCode: '',
    seats: [],
    script: null,
    selfSeatId: 'self',
    murdererSeatId: null,
    round: 1,
    maxRounds: 2,
    searchRounds: 0,
    releasedTiers: [],
    roundSummaries: [],
    accelerateSuggested: false,
    accelerateReason: '',
    privilege: null,
    statements: [],
    statementIndex: 0,
    clues: [],
    searchLeft: 0,
    notes: '',
    votes: [],
    strawPoll: [],
    settlement: [],
    // 默认关闭：上帝视角只能由「每局手动开启」的开关或演示深链打开，
    // 绝不能因为空状态而让平民看到凶手特权
    godMode: false,
    readingRoleIndex: 0,
    detectiveHints: 0,
    online: false,
    onlineTurnSeatId: null,
  }
}

export const useGameStore = defineStore('game', () => {
  const settings = useSettingsStore()
  const state = reactive<GameState>(emptyState())

  /** 待落地的房间配置 */
  const setup = reactive({
    playerCount: 5,
    theme: '民国·远洋邮轮谋杀案',
    played: false,
  })

  /** AI 生成过程 */
  const generating = reactive({
    busy: false,
    progress: null as GenerateProgress | null,
    error: '' as string,
    detail: [] as string[],
    provider: '' as string,
    rewrites: 0,
  })

  /** 阶段倒计时 */
  const timer = reactive({ endsAt: 0, paused: false })
  /** 本轮开始时间（用于防冷场检测） */
  const roundStartedAt = reactive({ at: 0 })
  /** 已触发过侦探提示的轮次 */
  const hintRounds = reactive<number[]>([])

  // ---------------------------------------------------------------- getters

  const rule = computed<PacingRule>(() => pacingFor(setup.playerCount))

  const selfSeat = computed<Seat | undefined>(() =>
    state.seats.find((s) => s.id === state.selfSeatId),
  )

  const roles = computed<Role[]>(() => state.script?.roles ?? [])

  const selfRole = computed<Role | undefined>(() => {
    const name = selfSeat.value?.roleName
    if (!name) return undefined
    return roles.value.find((r) => r.name === name)
  })

  const selfRoleIndex = computed(() =>
    roles.value.findIndex((r) => r.name === (selfSeat.value?.roleName ?? '')),
  )

  const isMurderer = computed(() => selfRole.value?.is_murderer === true)

  const canSeePrivilege = computed(() => isMurderer.value || state.godMode)

  const murdererRole = computed<Role | undefined>(() =>
    roles.value.find((r) => r.is_murderer === true),
  )

  /** 当前正在阅读/查看的角色（单人演示时可切换） */
  const viewingRole = computed<Role | undefined>(
    () => roles.value[state.readingRoleIndex] ?? selfRole.value,
  )

  /** 当前轮的定位文案 */
  const currentRoundTheme = computed<RoundTheme>(() =>
    roundTheme(state.round, state.maxRounds),
  )

  /** 发言顺序：从随机一位开始，顺时针一圈 */
  const statementOrder = computed<Seat[]>(() => {
    if (state.seats.length === 0) return []
    const n = state.seats.length
    const start = state.seats.findIndex((s) => s.roleName === roles.value[0]?.name)
    const from = start >= 0 ? start : 0
    return Array.from({ length: n }, (_, i) => state.seats[(from + i) % n])
  })

  /** 当前发言人：联机时以服务器指定的座位为准 */
  const currentSpeaker = computed<Seat | undefined>(() => {
    if (state.online) {
      if (!state.onlineTurnSeatId) return undefined
      return state.seats.find((s) => s.id === state.onlineTurnSeatId)
    }
    return statementOrder.value[state.statementIndex]
  })

  /** 本轮发言记录（不含系统播报） */
  const roundStatements = computed(() =>
    state.statements.filter((s) => s.round === state.round && s.kind === 'player'),
  )

  const selfHasSpoken = computed(() =>
    roundStatements.value.some((s) => s.seatId === state.selfSeatId),
  )

  /** 本轮是否所有人都发过言 */
  const allSpoken = computed(
    () =>
      state.seats.length > 0 &&
      state.seats.every((s) => roundStatements.value.some((st) => st.seatId === s.id)),
  )

  const myClues = computed<ClueItem[]>(() =>
    state.clues.filter((c) =>
      state.godMode
        ? c.revealed || c.isPrivate
        : c.published ||
          (c.ownerRoleName && c.ownerRoleName === selfRole.value?.name) ||
          c.foundBy === state.selfSeatId,
    ),
  )

  /** 公共线索板：已公开 + 系统已发放 */
  const publicClues = computed<ClueItem[]>(() => state.clues.filter((c) => c.published))

  /** 系统已发放的线索（按批次） */
  const releasedBatches = computed(() =>
    (state.script?.clue_batches ?? []).filter((b) => state.releasedTiers.includes(b.tier)),
  )

  const pinnedClues = computed<ClueItem[]>(() => state.clues.filter((c) => c.pinned))

  /** 可搜证地点 */
  const locations = computed(() => state.script?.search_locations ?? [])

  /** 最终投票统计：角色姓名 → 票数 */
  const voteTally = computed<Record<string, number>>(() => tally(state.votes))

  /** 意向投票统计 */
  const strawTally = computed<Record<string, number>>(() => tally(state.strawPoll))

  const myVote = computed(() => state.votes.find((v) => v.voterSeatId === state.selfSeatId))
  const myStrawVote = computed(() =>
    state.strawPoll.find((v) => v.voterSeatId === state.selfSeatId),
  )

  const phase = computed(() => state.phase)
  const phaseInfo = computed(() => phaseMeta(state.phase))

  /** 进度条：按人数与轮次动态生成 */
  const flowSteps = computed<FlowStep[]>(() => {
    const steps: FlowStep[] = [
      { key: 'room', label: '组局', phase: 'room' },
      { key: 'dealing', label: '下发剧本', phase: 'dealing' },
      { key: 'reading', label: '阅读剧本', phase: 'reading' },
    ]
    for (let r = 1; r <= state.maxRounds; r += 1) {
      steps.push({ key: `statement-${r}`, label: `第 ${r} 轮`, phase: 'statement', round: r })
      if (r <= state.searchRounds) {
        steps.push({ key: `search-${r}`, label: `第 ${r} 轮搜证`, phase: 'search', round: r })
      }
      if (r < state.maxRounds) {
        steps.push({ key: `poll-${r}`, label: '摸底', phase: 'poll', round: r })
      }
    }
    steps.push({ key: 'organize', label: '个人整理', phase: 'organize' })
    steps.push({ key: 'voting', label: '最终投票', phase: 'voting' })
    steps.push({ key: 'reveal', label: '复盘', phase: 'reveal' })
    return steps
  })

  const flowIndex = computed(() =>
    flowSteps.value.findIndex(
      (s) => s.phase === state.phase && (s.round === undefined || s.round === state.round),
    ),
  )

  // ---------------------------------------------------------------- helpers

  function tally(records: VoteRecord[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of roles.value) out[r.name] = 0
    for (const v of records) out[v.targetRoleName] = (out[v.targetRoleName] ?? 0) + 1
    return out
  }

  /** 阶段时长：阅读与陈述按人数动态，其余走默认值 */
  function phaseDuration(phase: GamePhase): number {
    const r = rule.value
    switch (phase) {
      case 'reading':
        return r.readingSeconds
      case 'statement':
        return r.roundSeconds
      case 'organize':
        return ORGANIZE_SECONDS
      case 'poll':
        return 60
      default:
        return phaseMeta(phase).duration
    }
  }

  function setPhase(phase: GamePhase) {
    state.phase = phase
    const seconds = phaseDuration(phase)
    timer.endsAt = seconds > 0 ? Date.now() + seconds * 1000 : 0
    timer.paused = false
    if (phase === 'statement') roundStartedAt.at = Date.now()
  }

  /** 系统播报：写进发言流，所有玩家可见 */
  function systemSay(title: string, text: string, round = state.round) {
    state.statements.push({
      seatId: 'system',
      roleName: '系统',
      text,
      round,
      kind: 'system',
      simulated: true,
      title,
      at: Date.now(),
    })
  }

  function triggerPrivilege() {
    const hint = state.script?.murderer_privilege?.intuition_hint
    if (!hint || state.privilege) return
    // 纵深防御：只有凶手端（或上帝视角）才把这条私有信息落到本地状态，
    // 平民端连数据都不持有，视图就算漏判也渲染不出东西来。
    // （复盘页需要展示它时，直接从 state.script.murderer_privilege 读。）
    if (!canSeePrivilege.value) return
    state.privilege = { round: state.round, hint, at: Date.now() }
  }

  /** 线索池：三批系统线索 + 搜证地点线索 + 私有线索 */
  function buildClues(pkg: ScriptPackage): ClueItem[] {
    const items: ClueItem[] = []

    pkg.clue_batches?.forEach((batch) => {
      batch.clues.forEach((text, ci) => {
        items.push({
          id: `batch-${batch.tier}-${ci}`,
          text,
          location: batch.title || CLUE_TIER_LABELS[batch.tier] || '系统线索',
          isPrivate: false,
          tier: batch.tier,
          revealed: false,
          published: false,
          pinned: false,
        })
      })
    })

    pkg.search_locations?.forEach((loc, li) => {
      loc.clues.forEach((text, ci) => {
        items.push({
          id: `srch-${li}-${ci}`,
          text,
          location: loc.name,
          isPrivate: false,
          revealed: false,
          published: false,
          pinned: false,
        })
      })
    })

    pkg.private_clues?.forEach((pc, i) => {
      items.push({
        id: `prv-${i}`,
        text: pc.text,
        location: '私有线索',
        isPrivate: true,
        ownerRoleName: pc.role_name,
        revealed: true,
        published: false,
        pinned: false,
      })
    })

    return items
  }

  function assignRoles(pkg: ScriptPackage) {
    const order = shuffle(state.seats.map((_, i) => i))
    pkg.roles.forEach((role, i) => {
      const seat = state.seats[order[i]]
      seat.roleName = role.name
      seat.readConfirmed = false
    })
    const murdererSeat = state.seats.find((s) => s.roleName === pkg.global_truth.murderer_name)
    state.murdererSeatId = murdererSeat?.id ?? null
    state.readingRoleIndex = Math.max(
      0,
      pkg.roles.findIndex((r) => r.name === selfSeat.value?.roleName),
    )
  }

  /** 发放某一批线索（系统动作） */
  function releaseClueBatch(tier: number) {
    if (state.releasedTiers.includes(tier)) return
    const batch = state.script?.clue_batches?.find((b) => b.tier === tier)
    if (!batch) return
    state.clues
      .filter((c) => c.tier === tier)
      .forEach((c) => {
        c.revealed = true
        c.published = true
      })
    state.releasedTiers.push(tier)
    systemSay(
      `第 ${state.round} 轮 · 线索发放`,
      `${batch.title} 已公开（共 ${batch.clues.length} 条）：\n` +
        batch.clues.map((c, i) => `　${i + 1}. ${c}`).join('\n'),
    )
  }

  /** 把剩余未发放的批次一次性放出（通常发生在最后一轮结束后） */
  function releaseRemainingTiers() {
    const tiers = (state.script?.clue_batches ?? []).map((b) => b.tier).sort((a, b) => a - b)
    for (const t of tiers) {
      if (!state.releasedTiers.includes(t)) releaseClueBatch(t)
    }
  }

  // ---------------------------------------------------------------- actions

  function resetAll() {
    Object.assign(state, emptyState())
    Object.assign(generating, {
      busy: false,
      progress: null,
      error: '',
      detail: [],
      provider: '',
      rewrites: 0,
    })
    timer.endsAt = 0
    roundStartedAt.at = 0
    hintRounds.length = 0
    setup.played = false
  }

  /** 创建房间：座位 = 我 + (人数-1) 个本地模拟玩家 */
  function createRoom(playerCount: number, theme: string) {
    resetAll()
    const r = pacingFor(playerCount)
    setup.playerCount = r.playerCount
    setup.theme = theme
    state.godMode = settings.state.demoMode
    state.roomCode = makeRoomCode()
    state.selfSeatId = 'self'
    state.maxRounds = r.maxRounds
    state.searchRounds = r.searchRounds
    state.round = 1

    const self: Seat = {
      id: 'self',
      name: settings.state.playerName || '我',
      // 单机也用档案里的头像，和联机时保持一致
      avatar: settings.state.avatar || '🖤',
      isSelf: true,
      isBot: false,
      ready: true,
      readConfirmed: false,
      alive: true,
    }
    const bots: Seat[] = Array.from({ length: Math.max(0, r.playerCount - 1) }, (_, i) => ({
      id: `bot-${i}`,
      name: BOT_NAMES[i % BOT_NAMES.length],
      avatar: BOT_AVATARS[i % BOT_AVATARS.length],
      isSelf: false,
      isBot: true,
      ready: false,
      readConfirmed: false,
      alive: true,
    }))
    state.seats = [self, ...bots]
    setPhase('room')
  }

  /** 直接使用导入的自定义剧本开局，跳过 AI 生成与下发阶段。 */
  function startCustomScript(pkg: ScriptPackage): { ok: boolean; errors: string[] } {
    const checked = validateScriptPackage(pkg, pkg.roles.length)
    if (!checked.ok || !checked.data) {
      return { ok: false, errors: checked.errors }
    }

    const data = checked.data
    createRoom(data.roles.length, data.game_config.theme)
    state.script = data
    assignRoles(data)
    state.clues = buildClues(data)
    state.statements = []
    state.statementIndex = 0
    state.votes = []
    state.strawPoll = []
    state.settlement = []
    state.roundSummaries = []
    state.releasedTiers = []
    state.accelerateSuggested = false
    state.accelerateReason = ''
    state.privilege = null
    state.detectiveHints = 0
    state.notes = ''
    state.round = 1
    hintRounds.length = 0
    setup.played = true
    state.seats.forEach((seat) => {
      seat.ready = true
    })
    setPhase('reading')
    return { ok: true, errors: [] }
  }

  /** 加入房间（前端演示版：按房间号生成一个本地房间） */
  function joinRoom(code: string, playerCount = 5, theme = '悬疑推理·无人生还') {
    createRoom(playerCount, theme)
    state.roomCode = code.trim().toUpperCase() || state.roomCode
  }

  /** 房主点击「开始游戏」：进入剧本下发 */
  async function dealScript() {
    /**
     * 联机模式下剧本**由房间服务器生成并下发**（服务器才是权威），客户端绝不能再自己生成一遍。
     * 之前这里没有这道闸，踩到的真实故障：玩家把设置切成「真实大模型」后进联机局，
     * 服务器已经生成好剧本了，客户端却还在本地调大模型 —— 没有 Key / 请求失败就抛错，
     * 「剧本下发」页显示「生成失败」，还会把本地阶段打回房间，跟服务器的阶段对着干。
     */
    if (state.online) return
    if (generating.busy) return
    generating.busy = true
    generating.error = ''
    generating.detail = []
    generating.rewrites = 0
    generating.progress = { step: 0, totalSteps: 4, label: '正在建立与 AI 引擎的连接……' }
    setPhase('dealing')

    try {
      const ai = settings.state.ai
      // 选了「真实大模型」却没填 Key：这一局是不可能成功的，直接给出可执行的失败说明，
      // 不再白等两次请求超时（下面的 catch 会走同一套文案与兜底按钮）。
      if (ai.provider === 'openai' && !String(ai.apiKey ?? '').trim()) {
        throw new GenerationError('尚未填写 API Key', [
          '你选择了「真实大模型」，但没有配置密钥。',
          '可以到「设置」里补全，或点下面的按钮改用离线引擎（本地生成，不联网）。',
        ])
      }
      const result = await generateScript({
        playerCount: setup.playerCount,
        theme: setup.theme,
        config: { ...settings.state.ai },
        onProgress: (p) => {
          generating.progress = p
        },
      })
      state.script = result.pkg
      generating.provider = result.provider
      generating.rewrites = result.rewrites
      assignRoles(result.pkg)
      state.clues = buildClues(result.pkg)
      state.statements = []
      state.statementIndex = 0
      state.votes = []
      state.strawPoll = []
      state.settlement = []
      state.roundSummaries = []
      state.releasedTiers = []
      state.accelerateSuggested = false
      state.accelerateReason = ''
      state.privilege = null
      state.detectiveHints = 0
      state.notes = ''
      state.round = 1
      hintRounds.length = 0
      setup.played = true
      state.seats.forEach((s) => {
        s.ready = true
      })
      setPhase('reading')
    } catch (e) {
      const err = e as GenerationError
      generating.error = err.message || '剧本生成失败'
      generating.detail = err.detail ?? []
      setPhase('room')
    } finally {
      generating.busy = false
    }
  }

  function confirmReading() {
    // 联机：把「我读完了」上报给服务器，等人齐了由房主推进
    if (netSend({ t: 'ready', ready: true })) return
    if (selfSeat.value) selfSeat.value.readConfirmed = true
    state.seats
      .filter((s) => s.isBot)
      .forEach((s) => {
        s.readConfirmed = true
      })
  }

  const allRead = computed(() => state.seats.every((s) => s.readConfirmed))

  function viewRole(index: number) {
    if (!state.godMode) return
    state.readingRoleIndex = index
  }

  // ---- 轮次推进 -----------------------------------------------------------

  /** 进入第 n 轮陈述：重置发言、发放该轮线索、按需解锁凶手特权 */
  function beginRound(n: number) {
    // 联机：轮次由服务器推进（房主点「进入第 N 轮」= 请求服务器推进）
    if (netSend({ t: 'advance' })) return
    state.round = Math.min(state.maxRounds, Math.max(1, n))
    state.statementIndex = 0
    state.strawPoll = []
    state.accelerateSuggested = false
    state.accelerateReason = ''
    state.searchLeft = rule.value.searchPerRound
    hintRounds.length = 0

    const theme = roundTheme(state.round, state.maxRounds)
    setPhase('statement')
    systemSay('本轮开始', `${theme.title}\n目标：${theme.goal}\n系统：${theme.systemAction}`)

    // 本轮线索批次 = 轮次序号
    releaseClueBatch(state.round)
    if (state.round >= rule.value.privilegeRound) triggerPrivilege()
  }

  function startStatement() {
    beginRound(state.round || 1)
  }

  function speakCurrent(): Statement | null {
    // 联机：发言只能由本人发出。这里原本是「替机器人播报」的本地模拟，
    // 联机时必须彻底静默——否则会替别的真人抢发一条空话。
    if (state.online) return null
    const seat = currentSpeaker.value
    if (!seat || seat.isSelf) return null
    const role = roles.value.find((r) => r.name === seat.roleName)
    if (!role) return null
    if (state.statements.some((s) => s.round === state.round && s.seatId === seat.id)) return null
    const st: Statement = {
      seatId: seat.id,
      roleName: role.name,
      text: makeBotStatement(role, roles.value, state.statementIndex, state.round),
      round: state.round,
      kind: 'player',
      simulated: true,
      at: Date.now(),
    }
    state.statements.push(st)
    return st
  }

  function nextSpeaker() {
    // 联机：轮到谁由服务器说了算
    if (state.online) return
    if (state.statementIndex < state.seats.length - 1) state.statementIndex += 1
  }

  /** 自己发言：写入发言记录后才允许轮转 */
  function selfSpeak(text: string) {
    const body = text.trim() || '我暂时不补充，但我记住了每个人说的话。'
    // 联机：把我的发言提交给服务器，由服务器广播给所有人
    if (netSend({ t: 'speak', text: body })) return
    const role = selfRole.value
    if (!role) return
    state.statements = state.statements.filter(
      (s) => !(s.round === state.round && s.seatId === state.selfSeatId),
    )
    state.statements.push({
      seatId: state.selfSeatId,
      roleName: role.name,
      text: body,
      round: state.round,
      kind: 'player',
      simulated: false,
      at: Date.now(),
    })
    nextSpeaker()
  }

  /** 本轮发言结束 → 进入搜证或直接结算本轮 */
  function finishStatements() {
    // 联机：阶段推进由服务器执行（房主点按钮 = 请求推进）
    if (netSend({ t: 'advance' })) return
    if (state.round <= state.searchRounds) {
      state.searchLeft = rule.value.searchPerRound
      setPhase('search')
      systemSay('搜证开始', `本轮每人的搜证次数：${rule.value.searchPerRound} 次。翻出来的东西可以选择公开或私藏。`)
      return
    }
    endRound()
  }

  /**
   * 防冷场机制（6 人局）：
   * 本轮时间过半仍无人发言时，自动触发 AI 侦探提示，给玩家一个具体的讨论抓手。
   */
  function maybeDetectiveHint(): boolean {
    // 联机：防冷场提示由服务器统一广播，本地不重复触发
    if (state.online) return false
    const r = rule.value
    if (r.idleHintSeconds <= 0) return false
    if (state.phase !== 'statement') return false
    if (hintRounds.includes(state.round)) return false
    if (roundStatements.value.length > 0) return false
    const elapsed = (Date.now() - roundStartedAt.at) / 1000
    if (roundStartedAt.at === 0 || elapsed < r.idleHintSeconds) return false

    const released = releasedBatches.value.flatMap((b) => b.clues)
    const hooks = released.slice(0, 2)
    const body =
      `已经过去 ${Math.round(elapsed)} 秒，还没有人开口。给几个具体的抓手：\n` +
      (hooks.length
        ? hooks.map((c, i) => `　${i + 1}. 关于「${c}」，谁最先能说清？`).join('\n')
        : '　1. 先让每个人说清案发前后 30 分钟在哪里。') +
      '\n建议从时间线入手：让每个人按顺序复述自己的行动轨迹，再对着矛盾点追问。'
    systemSay('AI 侦探提示', body)
    hintRounds.push(state.round)
    state.detectiveHints += 1
    return true
  }

  // ---- 搜证 ---------------------------------------------------------------

  function startSearch() {
    // 联机：阶段由服务器推进
    if (netSend({ t: 'advance' })) return
    setPhase('search')
  }

  /**
   * 搜证：在某个地点翻出一条尚未被发现的线索。
   * 返回翻到的线索；无剩余次数或该地点已被翻空时返回 null。
   */
  function searchLocation(location: string): ClueItem | null {
    // 联机：抽哪条线索由服务器决定，翻到的结果会异步推回来
    if (netSend({ t: 'search', location })) return null
    if (state.searchLeft <= 0) return null
    const clue = state.clues.find(
      (c) => !c.isPrivate && !c.tier && c.location === location && !c.revealed,
    )
    if (!clue) return null
    clue.revealed = true
    clue.foundBy = state.selfSeatId
    state.searchLeft -= 1
    return clue
  }

  /** 公开一条线索到公共线索板 */
  function publishClue(id: string) {
    // 联机：公开/私藏要告诉服务器，由它广播给所有人
    if (netSend({ t: 'clue', clueId: id, public: true })) return
    const clue = state.clues.find((c) => c.id === id)
    if (!clue) return
    clue.published = true
    clue.pinned = true
  }

  /** 模拟其他玩家也搜到了一些线索（仅用于营造气氛） */
  function simulateBotSearch() {
    // 联机时其他真人（或服务器 AI）的行为由服务器播报，本地不编造
    if (state.online) return
    const hidden = state.clues.filter((c) => !c.isPrivate && !c.tier && !c.revealed)
    if (hidden.length === 0) return
    const pick = hidden[Math.floor(Math.random() * hidden.length)]
    pick.revealed = true
    const bots = state.seats.filter((s) => s.isBot)
    const bot = bots[Math.floor(Math.random() * bots.length)]
    pick.foundBy = bot?.id
    pick.published = true
    pick.pinned = false
  }

  /** 搜证结束 → 本轮结算 */
  function finishSearch() {
    if (netSend({ t: 'advance' })) return
    endRound()
  }

  // ---- 轮间意向投票与提前结算 --------------------------------------------

  /** 计算某个角色姓名是否为当前最高票 */
  function topOf(t: Record<string, number>): { top: string | null; votes: number } {
    let top: string | null = null
    let votes = 0
    for (const [name, n] of Object.entries(t)) {
      if (n > votes) {
        votes = n
        top = name
      }
    }
    return { top, votes }
  }

  /** 判断是否满足提前结算条件 */
  function checkAcceleration(t: Record<string, number>): { accelerate: boolean; reason: string } {
    const r = rule.value
    const { top, votes } = topOf(t)
    const isPenultimate = state.round === state.maxRounds - 1

    if (isPenultimate && top && votes >= r.accelerateVotes) {
      return {
        accelerate: true,
        reason: `已有 ${votes} 人指认「${top}」，达到提前结算阈值（${r.accelerateVotes} 票）`,
      }
    }

    const totalTiers = (state.script?.clue_batches ?? []).length
    const allTiersOut = totalTiers > 0 && state.releasedTiers.length >= totalTiers
    const searchable = state.clues.filter((c) => !c.isPrivate && !c.tier)
    // 4/5 人局没有搜证环节，三批线索发完即等于关键线索全部曝光；
    // 6 人局还要看现场线索是否都被翻出来。
    const allSearched =
      state.searchRounds === 0 || searchable.length === 0 || searchable.every((c) => c.revealed)
    if (allTiersOut && allSearched) {
      return { accelerate: true, reason: '所有关键线索均已曝光，可以提前结算' }
    }

    return { accelerate: false, reason: '' }
  }

  /** 本轮结束：模拟玩家先摸底，生成轮次小结 */
  function endRound() {
    if (netSend({ t: 'advance' })) return
    const bots = state.seats.filter((s) => s.isBot && s.id !== state.selfSeatId)
    const botVotes: VoteRecord[] = bots.map((seat, i) => {
      const role = roles.value.find((r) => r.name === seat.roleName)
      return {
        voterSeatId: seat.id,
        targetRoleName: makeBotVoteTarget(
          roles.value,
          state.script?.global_truth.murderer_name ?? '',
          role?.name,
          i * 3 + state.round * 5 + state.roomCode.length,
        ),
        at: Date.now(),
      }
    })
    // 保留我自己的意向票
    state.strawPoll = botVotes
    refreshRoundSummary()

    if (state.round < state.maxRounds) {
      setPhase('poll')
    } else {
      releaseRemainingTiers()
      systemSay(
        '发言已关闭',
        '本轮陈述结束，所有人的发言通道已关闭。请进入个人整理，5 分钟后进行最终投票。',
      )
      setPhase('organize')
    }
  }

  /** 重算本轮小结（我投完意向票后调用） */
  function refreshRoundSummary() {
    const t = strawTally.value
    const { top, votes } = topOf(t)
    const acc = checkAcceleration(t)
    state.accelerateSuggested = acc.accelerate
    state.accelerateReason = acc.reason

    const summary: RoundSummary = {
      round: state.round,
      tally: { ...t },
      top,
      topVotes: votes,
      accelerate: acc.accelerate,
      reason: acc.reason,
    }
    const idx = state.roundSummaries.findIndex((s) => s.round === state.round)
    if (idx >= 0) state.roundSummaries[idx] = summary
    else state.roundSummaries.push(summary)
  }

  /** 我的意向票（轮间摸底，可改） */
  function castStrawVote(targetRoleName: string) {
    // 联机：交给服务器统计（它还要判定提前结算）
    if (netSend({ t: 'straw-vote', targetRoleName })) return
    state.strawPoll = state.strawPoll.filter((v) => v.voterSeatId !== state.selfSeatId)
    state.strawPoll.push({ voterSeatId: state.selfSeatId, targetRoleName, at: Date.now() })
    refreshRoundSummary()
  }

  /** 进入下一轮 */
  function nextRound() {
    if (netSend({ t: 'advance' })) return
    if (state.round >= state.maxRounds) return
    beginRound(state.round + 1)
  }

  /** 提前结算：跳过剩余轮次，直接进入个人整理与最终投票 */
  function forceSettle() {
    if (netSend({ t: 'advance' })) return
    releaseRemainingTiers()
    systemSay(
      '系统提示 · 提前结算',
      `满足提前结算条件：${state.accelerateReason || '关键信息已经足够'}。跳过剩余轮次，直接进入个人整理与最终投票。`,
    )
    setPhase('organize')
  }

  // ---- 整理 / 投票 / 复盘 -------------------------------------------------

  function startOrganize() {
    if (netSend({ t: 'advance' })) return
    setPhase('organize')
  }

  function togglePin(id: string) {
    const clue = state.clues.find((c) => c.id === id)
    if (clue) clue.pinned = !clue.pinned
  }

  function setNotes(text: string) {
    state.notes = text
  }

  /** 进入最终投票：先让模拟玩家投完，自己再投 */
  function startVoting() {
    if (netSend({ t: 'advance' })) return
    setPhase('voting')
    const botVotes: VoteRecord[] = state.seats
      .filter((s) => s.isBot)
      .map((seat, i) => {
        const role = roles.value.find((r) => r.name === seat.roleName)
        return {
          voterSeatId: seat.id,
          targetRoleName: makeBotVoteTarget(
            roles.value,
            state.script?.global_truth.murderer_name ?? '',
            role?.name,
            i * 3 + state.roomCode.length,
          ),
          at: Date.now(),
        }
      })
    state.votes = botVotes
  }

  function castVote(targetRoleName: string) {
    // 联机：票直接交给服务器统计，客户端不自己算
    if (netSend({ t: 'vote', targetRoleName })) return
    state.votes = state.votes.filter((v) => v.voterSeatId !== state.selfSeatId)
    state.votes.push({ voterSeatId: state.selfSeatId, targetRoleName, at: Date.now() })
  }

  function computeSettlement(): SettlementRow[] {
    const t = voteTally.value
    const maxVotes = Math.max(0, ...Object.values(t))
    const topRoles = roles.value.filter((r) => (t[r.name] ?? 0) === maxVotes && maxVotes > 0)
    const murdererName = state.script?.global_truth.murderer_name ?? ''
    const murdererCaught = topRoles.length === 1 && topRoles[0].name === murdererName
    const crowdWins = maxVotes > 0 && murdererCaught

    return roles.value.map((role) => ({
      roleName: role.name,
      identity: role.identity,
      isMurderer: role.is_murderer,
      votes: t[role.name] ?? 0,
      surfaceDone: (t[role.name] ?? 0) <= Math.floor(roles.value.length / 2),
      deepDone: role.is_murderer ? !crowdWins : crowdWins,
      win: role.is_murderer ? !crowdWins : crowdWins,
    }))
  }

  /** 复盘结算 */
  function reveal() {
    // 联机：复盘由服务器在收齐票后开启（并公开所有人的身份），本地不要抢跑，
    // 否则会用本地算出的结算顶掉服务器那份。
    if (state.online) return
    state.settlement = computeSettlement()
    setPhase('reveal')
  }

  function setGodMode(v: boolean) {
    // 联机对局禁止上帝视角：所有人都只能看自己那一份（服务端也不下发别人的）
    state.godMode = state.online ? false : v
    if (!state.online) settings.state.demoMode = v
  }

  // ---------------------------------------------------------------- 联机

  /** 由 stores/net.ts 注入联网桥（只需一次） */
  function setOnlineBridge(b: OnlineBridge | null) {
    onlineBridge = b
  }

  /** 切换联机模式：进入联机时禁用上帝视角，并清掉本地模拟留下的痕迹 */
  function setOnline(v: boolean) {
    const wasOnline = state.online
    state.online = v
    if (v) {
      state.godMode = false
      // ★ 只在「从单机切进联机」的那一次清痕迹。
      //   这个方法会被每一帧 view 兜底调用（见 stores/net.ts 的 onMessage），
      //   若无条件清 onlineTurnSeatId，服务器刚下发的「轮到谁」会被立刻抹掉，
      //   表现就是陈述阶段没人发言、整桌干等到超时。
      if (!wasOnline) state.onlineTurnSeatId = null
    }
  }

  /**
   * 把服务器下发的「我这个座位的视图」投影到既有 GameState。
   * ------------------------------------------------------------------
   * 为什么用投影而不是让页面直接读 SeatView：这样 11 个页面一行都不用改。
   * 投影只做「形状转换」，**不做任何权限判断** —— 权限在服务器端的
   * `censorSeat` 里已经裁剪完了（平民那一份根本没有凶手特权与全局真相）。
   */
  function applyServerView(v: SeatView, skewMs = 0) {
    state.online = true
    state.phase = v.phase
    state.roomCode = v.roomCode
    state.round = v.round
    state.maxRounds = v.maxRounds
    state.searchRounds = v.searchRounds
    state.releasedTiers = [...v.releasedTiers]
    state.selfSeatId = v.self.seatId
    state.godMode = false
    state.script = v.script
    state.readingRoleIndex = Math.max(
      0,
      v.script.roles.findIndex((r) => r.name === v.self.roleName),
    )

    // 座位：补齐本地渲染需要的字段；头像优先用服务器下发的档案头像
    state.seats = v.seats.map((s, i) => ({
      id: s.seatId,
      name: s.name,
      avatar: s.avatar || AVATARS[i % AVATARS.length],
      isSelf: s.isSelf,
      isBot: s.isBot,
      ready: s.ready,
      roleName: s.roleName,
      readConfirmed: s.ready,
      alive: s.connected || s.isBot,
    }))

    // 凶手座位：自己知道自己的；复盘时才知道别人
    const revealedMurdererSeat =
      v.phase === 'reveal' && v.reveal
        ? v.seats.find((s) => s.roleName === v.reveal?.murdererRoleName)?.seatId
        : undefined
    state.murdererSeatId = revealedMurdererSeat ?? (v.self.isMurderer ? v.self.seatId : null)

    // 凶手特权：服务器只发给凶手端，这里如实投影（平民端恒为 null）
    state.privilege = v.self.privilege
      ? { round: v.self.privilege.round, hint: v.self.privilege.hint, at: v.self.privilege.at }
      : null

    state.statements = [...v.statements]
    state.onlineTurnSeatId = v.turnSeatId
    state.searchLeft = v.searchLeft
    state.clues = cluesFromView(v)
    state.strawPoll = strawFromView(v)
    state.votes = v.reveal?.votes ?? v.votes ?? []
    state.settlement = v.reveal?.settlement ?? []
    state.accelerateSuggested = v.accel.suggested
    state.accelerateReason = v.accel.reason
    state.detectiveHints = v.hints.length

    // 倒计时：服务器时间是权威，换算到本地时间轴
    timer.endsAt = v.phaseEndsAt > 0 ? v.phaseEndsAt - skewMs : 0
  }

  /**
   * 用**被裁剪过**的数据重建线索池。
   * 关键点：未发放批次的文本、没被翻出的搜证线索文本，服务器根本没发下来，
   * 所以这里只能重建「我已知道的部分」+ 用于渲染地点进度的空占位。
   */
  function cluesFromView(v: SeatView): ClueItem[] {
    const items: ClueItem[] = []
    const seen = new Set<string>()

    const push = (c: ClueItem) => {
      if (seen.has(c.id)) return
      seen.add(c.id)
      items.push(c)
    }

    // 1) 已发放的系统批次（文本来自裁剪后的 clue_batches）
    for (const batch of v.script.clue_batches ?? []) {
      if (!v.releasedTiers.includes(batch.tier)) continue
      batch.clues.forEach((text, ci) => {
        push({
          id: `batch-${batch.tier}-${ci}`,
          text,
          location: batch.title || CLUE_TIER_LABELS[batch.tier] || '系统线索',
          isPrivate: false,
          tier: batch.tier,
          revealed: true,
          published: true,
          pinned: false,
        })
      })
    }

    // 2) 我自己的线索（角色私有线索 + 我翻到的搜证线索）
    for (const c of v.self.privateClues ?? []) {
      push({
        ...c,
        pinned: false,
        // 服务器若已把它公开，这里标记为已公开，公共线索板也能看到
        published: c.published === true,
      })
    }

    // 3) 已公开到线索板的搜证线索（文本由服务器放在 public_clues 里）
    const known = new Set(items.map((c) => c.text))
    for (const text of v.script.public_clues ?? []) {
      if (known.has(text)) continue
      push({
        id: `pub-${text.slice(0, 12)}-${items.length}`,
        text,
        location: '公共线索板',
        isPrivate: false,
        revealed: true,
        published: true,
        pinned: false,
      })
    }

    // 4) 地点进度占位：只用于让搜证页显示「剩 N / 已发现 x/y」，
    //    文本为空、未公开、未钉住，因此不会出现在任何线索列表里。
    for (const loc of v.locations ?? []) {
      const total = loc.total ?? 0
      const found = Math.min(loc.found ?? 0, total)
      for (let i = 0; i < total; i += 1) {
        push({
          id: `loc-${loc.name}-${i}`,
          text: '',
          location: loc.name,
          isPrivate: false,
          revealed: i < found,
          published: false,
          pinned: false,
        })
      }
    }

    return items
  }

  /** 把服务器的票型（按角色聚合，带投票人昵称）还原成本地用的 VoteRecord[] */
  function strawFromView(v: SeatView): VoteRecord[] {
    const out: VoteRecord[] = []
    for (const row of v.strawTally ?? []) {
      for (const voterName of row.voters) {
        const seat = v.seats.find((s) => s.name === voterName)
        out.push({
          voterSeatId: seat?.seatId ?? voterName,
          targetRoleName: row.roleName,
          at: 0,
        })
      }
    }
    return out
  }

  return {
    state,
    setup,
    generating,
    timer,
    roundStartedAt,
    // getters
    rule,
    selfSeat,
    selfRole,
    selfRoleIndex,
    isMurderer,
    canSeePrivilege,
    murdererRole,
    viewingRole,
    roles,
    currentRoundTheme,
    statementOrder,
    currentSpeaker,
    roundStatements,
    selfHasSpoken,
    allSpoken,
    myClues,
    publicClues,
    releasedBatches,
    pinnedClues,
    locations,
    voteTally,
    strawTally,
    myVote,
    myStrawVote,
    phase,
    phaseInfo,
    flowSteps,
    flowIndex,
    allRead,
    // actions
    setPhase,
    resetAll,
    createRoom,
    startCustomScript,
    joinRoom,
    dealScript,
    confirmReading,
    // ---- 联机 ----
    setOnline,
    setOnlineBridge,
    applyServerView,
    // ---- 本地/联机共用的动作（联机时内部会转成命令发给服务器）----
    viewRole,
    beginRound,
    startStatement,
    speakCurrent,
    nextSpeaker,
    selfSpeak,
    finishStatements,
    maybeDetectiveHint,
    startSearch,
    searchLocation,
    publishClue,
    simulateBotSearch,
    finishSearch,
    endRound,
    castStrawVote,
    nextRound,
    forceSettle,
    startOrganize,
    togglePin,
    setNotes,
    startVoting,
    castVote,
    reveal,
    setGodMode,
    systemSay,
  }
})
