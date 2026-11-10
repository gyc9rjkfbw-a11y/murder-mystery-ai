export type AppNavItem = 'home' | 'game' | 'social' | 'mine'

export const APP_NAV_ITEMS: AppNavItem[] = ['home', 'game', 'social', 'mine']

const GAME_ROUTES = new Set([
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
