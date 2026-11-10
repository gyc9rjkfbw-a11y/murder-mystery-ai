import { PHASE_ROUTE } from '@/services/net/protocol'
import type { GamePhase } from '@/types/game'

export type AppNavItem = 'home' | 'game' | 'social' | 'mine'

export const APP_NAV_ITEMS: AppNavItem[] = ['home', 'game', 'social', 'mine']

const GAME_ROUTES = new Set([
  'game-setup',
  'room',
  'lobby',
  'dealing',
  'reading',
  'statement',
  'search',
  'poll',
  'organize',
  'voting',
  'reveal',
])

export function isGameRoute(routeName: string | null | undefined): boolean {
  return !!routeName && GAME_ROUTES.has(routeName)
}

export function navTabForRoute(routeName: string | null | undefined): AppNavItem | null {
  if (routeName === 'home') return 'home'
  if (routeName === 'settings') return 'mine'
  if (isGameRoute(routeName)) return 'game'
  return null
}

export interface GameEntryState {
  inRoom: boolean
  onlinePhase: GamePhase
  gamePhase: GamePhase
  hasScript: boolean
  seatCount: number
}

export interface GameEntryTarget {
  route: string
  active: boolean
}

/** 首页和底部「游戏」共用：有对局就回到当前阶段，否则进入游戏大厅。 */
export function resolveGameEntry(state: GameEntryState): GameEntryTarget {
  if (state.inRoom) {
    return { route: PHASE_ROUTE[state.onlinePhase] ?? '/lobby', active: true }
  }
  if (state.hasScript) {
    return { route: PHASE_ROUTE[state.gamePhase] ?? '/room', active: true }
  }
  if (state.seatCount > 0) return { route: '/room', active: true }
  return { route: '/game', active: false }
}
