import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import type { AiConfig, AiProvider } from '@/services/aiEngine'
import { DEFAULT_DIFFICULTY, normalizeDifficulty } from '@/services/difficulty'
import { PRESET_THEMES } from '@/services/templates'
import type { Difficulty } from '@/types/script'
import {
  fetchProfile,
  playerId,
  pushProfile as pushProfileNow,
  randomAvatar,
  saveProfileSoon,
  type PlayerProfile,
} from '@/services/profile'
import { loadJSON, saveJSON, STORAGE_KEYS } from '@/services/storage'

export interface SettingsState {
  /** 我的昵称 */
  playerName: string
  /** 我的头像（emoji）。跟着档案走：联机时服务器会用它当座位头像 */
  avatar: string
  /**
   * 上帝视角（演示用）：可以看到全部角色剧本与凶手特权。
   * 注意：这是**每局手动开启**的调试开关，默认关闭，且不写入本地存储 ——
   * 否则上一局开过之后，下一局平民一进房间就直接看到凶手特权了。
   */
  demoMode: boolean
  /** 新房间默认人数 */
  defaultPlayerCount: 4 | 5 | 6
  /** 新房间默认难度（开局页可以随时改） */
  defaultDifficulty: Difficulty
  /**
   * 喜欢的剧本类型（题材 label 数组，取自 PRESET_THEMES）。
   * 纯偏好：不影响生成规则与难度，只用来在开局页把偏好的题材标出来 + 排序靠前。
   */
  preferredGenres: string[]
  /** 动画偏好：跟随系统或强制精简 */
  motion: 'system' | 'reduced'
  /** 剧本阅读字号 */
  readingFontSize: 'normal' | 'large'
  /** AI 配置 */
  ai: AiConfig
}

const DEFAULT_AI: AiConfig = {
  provider: 'offline',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 1.0,
  maxTokens: 8192,
}

function defaultState(): SettingsState {
  return {
    playerName: randomNickname(),
    avatar: randomAvatar(),
    demoMode: false,
    defaultPlayerCount: 5,
    defaultDifficulty: DEFAULT_DIFFICULTY,
    preferredGenres: [],
    motion: 'system',
    readingFontSize: 'normal',
    ai: { ...DEFAULT_AI },
  }
}

/**
 * 题材偏好只认 PRESET_THEMES 里真实存在的 label：
 * 旧版本 / 手改 localStorage 写进来的脏值（题材全名、emoji、已下线的题材）
 * 一律丢掉，免得界面上出现一个点不亮也删不掉的幽灵标签。
 */
export function normalizeGenres(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set(PRESET_THEMES.map((t) => t.label))
  const out: string[] = []
  for (const item of value) {
    const label = String(item ?? '').trim()
    if (!allowed.has(label) || out.includes(label)) continue
    out.push(label)
  }
  return out
}

/**
 * 没设置过昵称时给一个**随机**默认名。
 * 用固定的「我」会导致两台手机都叫「我」，等待厅里根本分不清谁是谁
 * （真联机实测踩到过：座位表上并排两个「我」）。
 */
export function randomNickname(): string {
  const tails = ['阿澈', '小满', '老周', '阿离', '七喜', '大壮', '小鹿', '阿宽', '十一', '铁蛋', '晚风', '青禾']
  const t = tails[Math.floor(Math.random() * tails.length)]
  return `${t}${Math.floor(Math.random() * 90 + 10)}`
}

/** 本地存档是否已经存在（用来判断「全新设备」——只有全新设备才让服务器档案覆盖本地设置） */
function hasLocalSettings(): boolean {
  try {
    return !!localStorage.getItem('mmai:' + STORAGE_KEYS.settings)
  } catch {
    return false
  }
}

const freshInstall = !hasLocalSettings()

function applyMotionPreference(motion: SettingsState['motion']): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.motion = motion
}

export const useSettingsStore = defineStore('settings', () => {
  const saved = loadJSON<Partial<SettingsState>>(STORAGE_KEYS.settings, {})
  // 兼容旧存档：把已经落盘的 demoMode 丢掉，避免「上帝视角」跨局残留
  delete (saved as Record<string, unknown>).demoMode
  // 兼容旧存档：老版本默认名叫「我」，联机时两台设备会重名，这里一并换掉
  if (!saved.playerName || saved.playerName === '我') {
    delete (saved as Record<string, unknown>).playerName
  }
  if (!saved.avatar) delete (saved as Record<string, unknown>).avatar
  const state = reactive<SettingsState>({
    ...defaultState(),
    ...saved,
    ai: { ...DEFAULT_AI, ...(saved.ai ?? {}) },
  })
  if (![4, 5, 6].includes(state.defaultPlayerCount)) state.defaultPlayerCount = 5
  // 旧存档没有难度 / 写过脏值，一律回落到标准档
  state.defaultDifficulty = normalizeDifficulty(state.defaultDifficulty)
  if (state.motion !== 'system' && state.motion !== 'reduced') state.motion = 'system'
  if (state.readingFontSize !== 'normal' && state.readingFontSize !== 'large') {
    state.readingFontSize = 'normal'
  }
  // 旧存档没有偏好 / 存进脏值：退回空数组（= 不挑，六种都行）
  state.preferredGenres = normalizeGenres(state.preferredGenres)

  watch(
    () => state.motion,
    (motion) => applyMotionPreference(motion),
    { immediate: true },
  )

  watch(
    state,
    // 上帝视角必须每局重新手动开启，其余玩家偏好持久化。
    (v) =>
      saveJSON(STORAGE_KEYS.settings, {
        playerName: v.playerName,
        avatar: v.avatar,
        defaultPlayerCount: v.defaultPlayerCount,
        defaultDifficulty: v.defaultDifficulty,
        preferredGenres: v.preferredGenres,
        motion: v.motion,
        readingFontSize: v.readingFontSize,
        ai: v.ai,
      }),
    { deep: true },
  )

  const isOnlineAI = computed(() => state.ai.provider === 'openai')
  const providerLabel = computed(() =>
    state.ai.provider === 'offline' ? '离线模拟引擎' : `大模型 · ${state.ai.model || '未指定'}`,
  )

  /* ---------------- 服务器档案（免登录 · 设备档案） ---------------- */

  /** 服务器上我的档案（含战绩 / 对局历史）；离线时用上次的本地快照 */
  const profile = ref<PlayerProfile | null>(loadJSON<PlayerProfile | null>(STORAGE_KEYS.profileCache, null))
  /** 最近一次读取成功没有（设置页据此显示「已同步 / 服务器未连接」） */
  const profileSynced = ref(false)
  const profileLoading = ref(false)

  /** 把服务器档案合并进本地设置（只在「全新设备」时覆盖昵称/头像/AI，避免盖掉用户在这台机器上的选择） */
  function applyProfile(next: PlayerProfile | null): void {
    profile.value = next
    if (!next) return
    saveJSON(STORAGE_KEYS.profileCache, next)
    // 换设备时把「喜欢哪几类剧本」也带过来（本机已经选过就不覆盖）
    if (state.preferredGenres.length === 0 && next.genres?.length) {
      state.preferredGenres = normalizeGenres(next.genres)
    }
    if (!freshInstall) return
    if (next.name) state.playerName = next.name
    if (next.avatar) state.avatar = next.avatar
    // AI 偏好只取三项：provider / model / baseUrl。**密钥永远不跟过来**
    const provider = next.ai?.provider === 'openai' ? 'openai' : 'offline'
    state.ai.provider = provider
    if (next.ai?.model) state.ai.model = next.ai.model
    if (next.ai?.baseUrl) state.ai.baseUrl = next.ai.baseUrl
  }

  /**
   * 从服务器拉一次档案。
   * `profileSynced` 的含义是「**服务器答话了**」而不是「我有档案里」——
   * 第一次玩的人服务器在线但没有档案，这两件事在界面上必须分开显示。
   */
  async function refreshProfile(): Promise<PlayerProfile | null> {
    profileLoading.value = true
    try {
      const result = await fetchProfile()
      profileSynced.value = result.ok
      if (result.profile) applyProfile(result.profile)
      return result.profile
    } finally {
      profileLoading.value = false
    }
  }

  /** 立刻推一次（不走去抖）+ 再读回来，给「立即同步」按钮用 */
  async function syncNow(): Promise<boolean> {
    profileLoading.value = true
    try {
      const pushed = await pushProfileNow({
        name: state.playerName,
        avatar: state.avatar,
        ai: { provider: state.ai.provider, model: state.ai.model, baseUrl: state.ai.baseUrl },
        genres: state.preferredGenres,
      })
      const result = await fetchProfile()
      profileSynced.value = pushed.ok && result.ok
      if (result.profile) applyProfile(result.profile)
      return pushed.ok && result.ok
    } finally {
      profileLoading.value = false
    }
  }

  /** 把本机昵称 / 头像 / AI 偏好 / 题材偏好推给服务器（去抖；不带密钥） */
  function pushProfile(): void {
    // 传函数而不是快照：到真正发送时再读一次 store，保证带上刚选的题材
    saveProfileSoon(() => ({
      name: state.playerName,
      avatar: state.avatar,
      ai: { provider: state.ai.provider, model: state.ai.model, baseUrl: state.ai.baseUrl },
      genres: [...state.preferredGenres],
    }))
  }

  const stats = computed(() => profile.value?.stats ?? { games: 0, wins: 0, losses: 0, asMurderer: 0, murdererWins: 0 })
  const winRate = computed(() => (stats.value.games > 0 ? Math.round((stats.value.wins / stats.value.games) * 100) : 0))

  function setProvider(p: AiProvider) {
    state.ai.provider = p
  }

  /** 点一下选中 / 取消一个题材偏好（按点的先后记录，方便用户对照自己刚点的） */
  function togglePreferredGenre(label: string) {
    const next = state.preferredGenres.includes(label)
      ? state.preferredGenres.filter((item) => item !== label)
      : [...state.preferredGenres, label]
    state.preferredGenres = normalizeGenres(next)
  }

  function reset() {
    Object.assign(state, defaultState())
  }

  return {
    state,
    isOnlineAI,
    providerLabel,
    setProvider,
    togglePreferredGenre,
    reset,
    // 档案
    playerId,
    profile,
    profileSynced,
    profileLoading,
    stats,
    winRate,
    refreshProfile,
    syncNow,
    applyProfile,
    pushProfile,
  }
})
