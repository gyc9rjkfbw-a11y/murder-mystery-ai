export interface LaunchSessionStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const LAUNCH_KEY = 'mmai:launch-intro-seen'

function sessionStore(): LaunchSessionStorage | null {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage
  } catch {
    /* 隐私模式可能禁止访问。 */
  }
  return null
}

/**
 * 启动动画只在当前标签页首次打开时播放。
 * 存储不可用时选择跳过动画，保证任何情况下都能直接进入游戏。
 */
export function shouldPlayLaunchIntro(
  storage: LaunchSessionStorage | null = sessionStore(),
  reduceMotion = false,
): boolean {
  if (reduceMotion || !storage) return false
  try {
    return storage.getItem(LAUNCH_KEY) === null
  } catch {
    return false
  }
}

export function markLaunchIntroSeen(
  storage: LaunchSessionStorage | null = sessionStore(),
  now = Date.now(),
): void {
  if (!storage) return
  try {
    storage.setItem(LAUNCH_KEY, String(now))
  } catch {
    /* 写不进去只影响下次是否播放，不影响进入游戏。 */
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  } catch {
    return false
  }
}
