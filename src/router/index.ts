import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { resolveDemoRedirect } from '@/services/demoBootstrap'

/**
 * 路由即状态机的一层映射：
 * 每个游戏阶段一个页面，返回键 / 前进键都能直接定位到阶段视图。
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: () => import('@/views/HomeView.vue') },
  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
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
    // 联机时剧本由服务器下发，还没到就先去等待厅；单机时回组局页
    if (net.active) return { name: 'lobby' }
    return { name: game.state.seats.length > 0 ? 'room' : 'home' }
  }
  return true
})