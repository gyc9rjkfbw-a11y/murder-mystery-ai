import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import type { AiConfig, AiProvider } from '@/services/aiEngine'
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
    ai: { ...DEFAULT_AI },
  }
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

  watch(
    state,
    // 只持久化昵称 / 头像 / AI 配置：上帝视角必须每局重新手动开启
    (v) => saveJSON(STORAGE_KEYS.settings, { playerName: v.playerName, avatar: v.avatar, ai: v.ai }),
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
      })
      const result = await fetchProfile()
      profileSynced.value = pushed.ok && result.ok
      if (result.profile) applyProfile(result.profile)
      return pushed.ok && result.ok
    } finally {
      profileLoading.value = false
    }
  }

  /** 把本机昵称 / 头像 / AI 偏好推给服务器（去抖；不带密钥） */
  function pushProfile(): void {
    saveProfileSoon({
      name: state.playerName,
      avatar: state.avatar,
      ai: { provider: state.ai.provider, model: state.ai.model, baseUrl: state.ai.baseUrl },
    })
  }

  const stats = computed(() => profile.value?.stats ?? { games: 0, wins: 0, losses: 0, asMurderer: 0, murdererWins: 0 })
  const winRate = computed(() => (stats.value.games > 0 ? Math.round((stats.value.wins / stats.value.games) * 100) : 0))

  function setProvider(p: AiProvider) {
    state.ai.provider = p
  }

  function reset() {
    Object.assign(state, defaultState())
  }

  return {
    state,
    isOnlineAI,
    providerLabel,
    setProvider,
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
