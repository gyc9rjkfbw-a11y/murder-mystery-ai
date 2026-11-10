export type GameNavItem = 'role' | 'clues' | 'talk' | 'phase'

const GAME_ROUTES = new Set([
  'reading',
  'statement',
  'search',
  'poll',
  'organize',
  'voting',
  'reveal',
])

export function gameNavVisible(routeName: string | null | undefined, hasScript: boolean): boolean {
  return hasScript && !!routeName && GAME_ROUTES.has(routeName)
}

export function availableGameNavItems(online: boolean): GameNavItem[] {
  return online ? ['role', 'clues', 'talk', 'phase'] : ['role', 'clues', 'phase']
}
