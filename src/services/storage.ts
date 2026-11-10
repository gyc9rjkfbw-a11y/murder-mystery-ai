/**
 * 本地持久化（设置 / 断线续玩）
 * 只依赖 localStorage，前端可独立运行，不依赖后端。
 */

const PREFIX = 'mmai:'

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    /* 隐私模式下静默失败 */
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    /* ignore */
  }
}

export const STORAGE_KEYS = {
  settings: 'settings',
  lastRoom: 'last-room',
  /** 本机的稳定玩家 ID（免登录设备档案的身份，见 services/profile.ts） */
  playerId: 'player-id',
  /** 服务器档案的本地快照（离线时也能显示自己的战绩） */
  profileCache: 'profile-cache',
  /** 用户点了「以后再说」：不再在首页提示安装到桌面（见 services/pwa.ts） */
  installHintHidden: 'install-hint-hidden',
} as const