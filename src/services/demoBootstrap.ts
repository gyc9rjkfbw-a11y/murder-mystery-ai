import { PRESET_THEMES } from './templates'
import { useGameStore } from '@/stores/game'
import { useSettingsStore } from '@/stores/settings'
import type { GamePhase } from '@/types/game'

/**
 * 演示深链（QA / 截图 / 快速体验用）
 * ------------------------------------------------------------------
 * 在地址栏 hash 里带上查询参数即可直接跳到任意阶段，例如：
 *
 *   #/reading?demo=1                 阅读阶段
 *   #/statement?demo=1               第 1 轮陈述（已自动播完前几位发言）
 *   #/poll?demo=1                    轮间意向投票
 *   #/search?demo=1&count=6          自由搜证（仅 6 人局有搜证环节，会自动补到 6 人）
 *   #/organize?demo=1                个人整理（自动跑完所有轮次）
 *   #/voting?demo=1                  最终投票
 *   #/reveal?demo=1                  复盘结算
 *   #/reading?demo=1&count=4&theme=古风·宫廷夜宴疑云
 *
 * 它强制使用**离线引擎**（离线可用、几秒完成），不会消耗任何 API 额度，
 * 并且是沿着真实状态机一轮一轮推进过去的，不是硬塞数据。
 *
 * 执行时机：由**路由守卫** await（见 router/index.ts）。
 * 这一点很关键 —— 守卫必须在放行 /reading 这类 needScript 路由之前就把剧本准备好，
 * 否则深链会先被弹回 /room；所以这里不再自己调 router.replace，
 * 而是把「该落到哪个阶段」作为返回值交给守卫。
 */

const DEMO_PHASES: GamePhase[] = [
  'reading',
  'statement',
  'search',
  'poll',
  'organize',
  'voting',
  'reveal',
]

function parseQuery(): URLSearchParams | null {
  const raw = window.location.hash.replace(/^#/, '')
  const q = raw.indexOf('?')
  if (q < 0) return null
  const params = new URLSearchParams(raw.slice(q + 1))
  return params.has('demo') ? params : null
}

/** 本次会话只驱动一次深链（避免用户手动返回时又被拽回去） */
let task: Promise<GamePhase | null> | null = null
let redirected = false

/**
 * 解析并执行演示深链。幂等：无论被调用多少次都只开一局。
 * 返回「本次应该跳到的阶段」；不需要跳转时返回 null。
 */
export function resolveDemoRedirect(currentName?: string): Promise<GamePhase | null> {
  if (!task) task = boot()
  return task.then((target) => {
    if (!target || redirected) return null
    redirected = true
    return target === currentName ? null : target
  })
}

async function boot(): Promise<GamePhase | null> {
  const params = parseQuery()
  if (!params) return null

  const game = useGameStore()
  const settings = useSettingsStore()
  // 深链是「一键到某个状态」的语义：本地若残留上一局，必须丢掉重开，
  // 否则会按旧存档的人数 / 题材渲染，和 URL 里写的对不上。
  if (game.state.script) game.resetAll()

  const phaseParam = (params.get('phase') ?? currentPhase()) as GamePhase
  const phase: GamePhase = DEMO_PHASES.includes(phaseParam) ? phaseParam : 'reading'
  let count = Math.min(6, Math.max(4, Number(params.get('count') ?? 5) || 5))
  // 搜证环节只有 6 人局有，深链里自动补齐，保证截图/体验不落空
  if (phase === 'search' && count < 6) count = 6
  const theme = params.get('theme') ?? PRESET_THEMES[0].theme

  // 深链一律走离线引擎，避免误用真实 API 额度
  const previousProvider = settings.state.ai.provider
  settings.state.ai.provider = 'offline'

  game.createRoom(count, theme)
  // 深链本来就是「上帝视角」的演示入口（要能切换角色看剧本、截图复盘），
  // 所以这里显式打开并会在界面上打上「上帝视角」标记。
  // 正常从首页开的房间不会打开它，平民看不到凶手特权。
  game.setGodMode(true)
  await game.dealScript()
  settings.state.ai.provider = previousProvider

  if (!game.state.script) return null
  await seed(phase)
  return game.state.phase
}

function currentPhase(): string {
  const raw = window.location.hash.replace(/^#/, '').split('?')[0]
  const seg = raw.split('/').filter(Boolean)[0] ?? 'reading'
  return seg
}

/** 让本轮所有人都发过言（轮到自己时补一条），然后结束本轮 */
function playFullRound(): void {
  const game = useGameStore()
  for (let guard = 0; guard < game.state.seats.length * 2 + 4; guard += 1) {
    if (game.allSpoken) break
    if (game.currentSpeaker?.isSelf) game.selfSpeak('我先说到这里，剩下的听你们说。')
    else if (!game.speakCurrent()) game.nextSpeaker()
  }
  if (!game.selfHasSpoken) game.selfSpeak('我先说到这里，剩下的听你们说。')
  game.finishStatements()
}

/** 沿着真实状态机推进到目标阶段 */
function advanceTo(target: GamePhase): void {
  const game = useGameStore()
  for (let guard = 0; guard < 40; guard += 1) {
    const p = game.state.phase
    if (p === target) return
    if (p === 'reading') {
      game.confirmReading()
      game.startStatement()
    } else if (p === 'statement') {
      playFullRound()
    } else if (p === 'search') {
      game.finishSearch()
    } else if (p === 'poll') {
      // 演示时偶尔演示一次「提前结算」
      game.nextRound()
    } else {
      return
    }
  }
}

/** 把状态推进到目标阶段，让页面一打开就是「玩到一半」的样子 */
async function seed(phase: GamePhase): Promise<void> {
  const game = useGameStore()

  if (phase === 'reading') {
    game.setPhase('reading')
    return
  }

  game.confirmReading()
  game.startStatement()

  if (phase === 'statement') {
    // 自动播完前几位，留下真实的发言流
    for (let i = 0; i < 3; i += 1) {
      game.speakCurrent()
      game.nextSpeaker()
    }
    return
  }

  if (phase === 'poll') {
    playFullRound()
    game.setPhase('poll')
    return
  }

  if (phase === 'search') {
    playFullRound() // 第 1 轮发言结束 → 进入第 1 轮搜证
    const names = game.locations.map((l) => l.name)
    for (const n of names.slice(0, 2)) {
      const clue = game.searchLocation(n)
      if (clue) game.publishClue(clue.id)
    }
    game.simulateBotSearch()
    game.simulateBotSearch()
    game.setPhase('search')
    return
  }

  // organize / voting / reveal：把剩余轮次全部跑完
  advanceTo('organize')

  const names = game.locations.map((l) => l.name)
  for (const n of names.slice(0, 3)) {
    const clue = game.searchLocation(n)
    if (clue) {
      game.publishClue(clue.id)
      game.togglePin(clue.id)
    }
  }
  game.roles
    .slice(0, 2)
    .forEach((r) => game.castStrawVote(r.name))
  game.setNotes('1. 22:30 前后走廊上有人走动\n2. 值班记录被重描过\n3. 医生的药箱少了一格')
  game.startOrganize()

  if (phase === 'organize') return

  game.startVoting()
  const suspect = game.roles.find((r) => r.name !== game.selfRole?.name)
  if (suspect) game.castVote(suspect.name)
  if (phase === 'voting') return

  game.reveal()
}