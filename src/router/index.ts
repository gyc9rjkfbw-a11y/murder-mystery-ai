import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { PHASE_ROUTE } from '@/services/net/protocol'
import { resolveDemoRedirect } from '@/services/demoBootstrap'
import type { GamePhase } from '@/types/game'

/**
 * 路由即状态机的一层映射：
 * 每个游戏阶段一个页面，返回键 / 前进键都能直接定位到阶段视图。
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
  {
    path: '/game',
    name: 'game-setup',
    component: () => import('@/views/GameSetupView.vue'),
  },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  // 我的：档案 / 战绩 / 偏好（底部导航第四格）。和设置页分开，避免两页看起来一样。
  { path: '/me', name: 'me', component: () => import('@/views/ProfileView.vue') },
  { path: '/room', name: 'room', component: () => import('@/views/RoomView.vue') },
  // 联机等待厅：建房/加入之后、开局之前的地方
  { path: '/lobby', name: 'lobby', component: () => import('@/views/LobbyView.vue') },
  { path: '/dealing', name: 'dealing', component: () => import('@/views/DealingView.vue') },
  {
    path: '/reading',
    name: 'reading',
    component: () => import('@/views/ReadingView.vue'),
    meta: { needScript: true },
  },
  {
    path: '/statement',
    name: 'statement',
    component: () => import('@/views/StatementView.vue'),
    meta: { needScript: true },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
    meta: { needScript: true },
  },
  {
    path: '/poll',
    name: 'poll',
    component: () => import('@/views/PollView.vue'),
    meta: { needScript: true },
  },
  {
    path: '/organize',
    name: 'organize',
    component: () => import('@/views/OrganizeView.vue'),
    meta: { needScript: true },
  },
  {
    path: '/voting',
    name: 'voting',
    component: () => import('@/views/VotingView.vue'),
    meta: { needScript: true },
  },
  {
    path: '/reveal',
    name: 'reveal',
    component: () => import('@/views/RevealView.vue'),
    meta: { needScript: true },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  // 演示深链要在守卫里先把剧本准备好，否则 ?demo=1 会被下面的 needScript 判空、
  // 直接弹回 /room（这是首屏路由与自动开局之间的竞态）。
  const demoPhase = await resolveDemoRedirect(to.name as string | undefined)
  if (demoPhase) return { name: demoPhase }

  const game = useGameStore()
  const net = useNetStore()

  // 联机等待厅：只有正在联机（建房或加入中）才允许进入
  if (to.name === 'lobby' && !net.active) return { name: 'home' }

  if (to.meta.needScript && !game.state.script) {
    // 联机时剧本由服务器下发。本地被清空（例如刚点过「再来一局」）但服务器
    // 其实已经进到这一阶段时，用服务器视图把本地补回来再放行；
    // 否则会被弹回等待厅，而阶段值并没有变化、阶段跟随不会再触发一次，
    // 界面就永远停在「已开局，正在前往阅读页…」。
    const view = net.view
    if (
      net.active &&
      view &&
      PHASE_ROUTE[view.phase] === to.name &&
      (view.script?.roles?.length ?? 0) > 0
    ) {
      game.applyServerView(view)
      return true
    }
    // 还没到就先去等待厅；单机时回组局页
    if (net.active) return { name: 'lobby' }
    return { name: game.state.seats.length > 0 ? 'room' : 'home' }
  }

  // 进入对局之后不允许回退
  // ------------------------------------------------------------------
  // 开局以后（发牌 / 阅读 / 陈述 / 搜证 / 摸底 / 整理 / 投票），
  // 返回键、浏览器后退、底部导航、手改地址一律只把人送回**当前阶段**那一页：
  //   · 回上一页会让「上一阶段已经翻篇」这件事变得可以反复试探；
  //   · 复盘（reveal）是这一局的终点，回首页 / 设置都放行，怎么收尾由复盘页决定。
  const lockedPhase = lockedPlayPhase(net)
  if (lockedPhase) {
    const current = PHASE_ROUTE[lockedPhase] ?? 'lobby'
    if (to.name !== current) {
      useToast().warn('对局已经开始，不能返回上一页')
      return { name: current }
    }
  }
  return true
})

/**
 * 当前处在「不能回退」的对局阶段，返回那个阶段；不在对局中返回 null。
 * 等待厅（lobby/room）与复盘（reveal）都不锁。
 */
function lockedPlayPhase(net: ReturnType<typeof useNetStore>): GamePhase | null {
  const LOCKED: GamePhase[] = ['dealing', 'reading', 'statement', 'search', 'poll', 'organize', 'voting']
  const game = useGameStore()
  // 联机以服务器视图为准（本地被「再来一局」清掉也照样锁）；离线看本地阶段
  if (net.active && net.view) {
    const phase = net.view.phase
    if (net.view.started !== true) return null
    return LOCKED.includes(phase) ? phase : null
  }
  if (!game.state.script) return null
  return LOCKED.includes(game.state.phase) ? game.state.phase : null
}
