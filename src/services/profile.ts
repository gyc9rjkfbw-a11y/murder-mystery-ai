/**
 * 我的档案（客户端侧）
 * ==================================================================
 * 一、身份：**免登录 · 设备档案**
 *   本机生成一个稳定 ID 存在 localStorage，之后每次建房 / 加入都带上它，
 *   服务器就认得「还是这个人」，昵称头像与战绩都跟着走。
 *   换手机 / 清浏览器缓存 = 换了一份新档案（没有任何账号体系，也不需要）。
 *
 * 二、同步：**离线优先**
 *   这个游戏的联机是「可选」的（单机能玩），所以档案同步必须做到：
 *     - 服务器连不上 → 一切都是本地行为，静默跳过，绝不弹错；
 *     - 只有真联机时才把昵称 / 头像 / AI 偏好推上去；
 *     - 战绩不需要客户端上报（服务器在复盘时自己算），这里只负责读回来展示。
 *
 * 三、隐私：**密钥不出浏览器**
 *   推给服务器的 ai 只有 provider / model / baseUrl，`apiKey` 永远留在本机。
 */

import { ref } from 'vue'
import { defaultWsUrl } from './net/netClient'
import { loadJSON, saveJSON, STORAGE_KEYS } from './storage'
import { AVATARS } from '@/types/game'

/** 服务器回的档案形状（和 server/src/store.ts 的 PlayerProfile 对齐） */
export interface ProfileStats {
  games: number
  wins: number
  losses: number
  asMurderer: number
  murdererWins: number
}

export interface ProfileGameRecord {
  at: number
  roomCode: string
  theme: string
  playerCount: number
  result: 'win' | 'lose'
  role: string
  isMurderer: boolean
}

export interface ProfileAi {
  provider: string
  model: string
  baseUrl: string
}

export interface PlayerProfile {
  id: string
  name: string
  avatar: string
  createdAt: number
  updatedAt: number
  lastSeenAt: number
  stats: ProfileStats
  history: ProfileGameRecord[]
  ai: ProfileAi
}

/** 头像候选：先用房间那套「剧本杀氛围」的头像，再加几个 */
export const AVATAR_CHOICES: string[] = [...AVATARS, '🔮', '🕵️', '🦉', '🥀']

export function randomAvatar(): string {
  return AVATAR_CHOICES[Math.floor(Math.random() * AVATAR_CHOICES.length)]
}

/** 设备 ID 的存储键（storage.ts 里 PREFIX 会自动拼成 mmai:player-id） */
const PLAYER_ID_KEY: string = STORAGE_KEYS.playerId

function makeId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // 非安全上下文（http 局域网）下 randomUUID 可能不存在，退回 getRandomValues
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

let cachedId = ''

/**
 * 本机的玩家 ID（首次调用时生成并落盘，之后永远同一个）。
 * 形如 uuid 或 32 位十六进制，都在服务器的 ID 白名单里。
 */
export function playerId(): string {
  if (cachedId) {
    // 缓存里已经有了，但 localStorage 可能被清过（隐私模式 / 手动清缓存）：
    // 这里补写回去，避免「内存里是一个身份、下次打开又是另一个身份」的漂移。
    if (!hasStoredId()) saveJSON(PLAYER_ID_KEY, cachedId)
    return cachedId
  }
  const saved = loadJSON<string>(PLAYER_ID_KEY, '')
  if (typeof saved === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(saved)) {
    cachedId = saved
    return cachedId
  }
  cachedId = makeId()
  saveJSON(PLAYER_ID_KEY, cachedId)
  return cachedId
}

function hasStoredId(): boolean {
  try {
    return localStorage.getItem('mmai:' + PLAYER_ID_KEY) !== null
  } catch {
    return true
  }
}

/**
 * 档案接口的基址。
 * 直接复用 WebSocket 的地址推导：ws→http、wss→https，
 * 这样开发（5273 页面 / 5274 服务）、局域网 http、https、隧道域名全都对得上。
 */
export function apiBase(): string {
  try {
    const url = new URL(defaultWsUrl())
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    return `${url.origin}/api`
  } catch {
    return '/api'
  }
}

const TIMEOUT_MS = 2500

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: controller?.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    // 单机 / 服务器没开 / 断网：静默失败，别打扰玩家
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 读回自己在服务器上的档案。
 * 必须区分两种情况（界面文案不同，第一版就是在这里混淆了）：
 *   - `{ ok: true, profile: null }` → 服务器在线，但这台设备还没有档案（第一次玩）
 *   - `{ ok: false, profile: null }` → 服务器压根没连上（单机 / 没开服务）
 */
export interface FetchProfileResult {
  ok: boolean
  profile: PlayerProfile | null
}

export async function fetchProfile(): Promise<FetchProfileResult> {
  const data = await request<{ profile: PlayerProfile | null }>(`/profile?id=${encodeURIComponent(playerId())}`)
  if (!data) return { ok: false, profile: null }
  return { ok: true, profile: data.profile ?? null }
}

export interface PushProfileInput {
  name?: string
  avatar?: string
  ai?: { provider: string; model: string; baseUrl: string }
}

export interface PushProfileResult {
  ok: boolean
  profile?: PlayerProfile
  warnings?: string[]
}

/** 把昵称 / 头像 / AI 偏好推给服务器（只推白名单字段，绝不带 apiKey） */
export async function pushProfile(input: PushProfileInput): Promise<PushProfileResult> {
  const data = await request<{ profile?: PlayerProfile; warnings?: string[] }>('/profile', {
    method: 'PUT',
    body: JSON.stringify({
      id: playerId(),
      name: input.name,
      avatar: input.avatar,
      ai: input.ai ? { provider: input.ai.provider, model: input.ai.model, baseUrl: input.ai.baseUrl } : undefined,
    }),
  })
  return data ? { ok: true, profile: data.profile, warnings: data.warnings } : { ok: false }
}

/* ------------------------------------------------------------------ *
 * 去抖推送：设置页里改昵称 / 换头像时不要每敲一个字就打一次请求
 * ------------------------------------------------------------------ */

let pending: PushProfileInput | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let inflight = false

function flush(): void {
  if (!pending || inflight) return
  const payload = pending
  pending = null
  inflight = true
  void pushProfile(payload)
    .then((result) => {
      if (result.ok) lastSync.value = { at: Date.now(), ok: true, warnings: result.warnings ?? [] }
      else lastSync.value = { at: Date.now(), ok: false, warnings: [] }
    })
    .finally(() => {
      inflight = false
      if (pending) flush()
    })
}

/** 排队推送（250ms 合并），服务器不在线就静默跳过 */
export function saveProfileSoon(input: PushProfileInput): void {
  pending = { ...(pending ?? {}), ...input }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    flush()
  }, 250)
}

/** 最近一次同步的状态（设置页用来显示「已同步 / 未连接」） */
export const lastSync = ref<null | { at: number; ok: boolean; warnings: string[] }>(null)

/** 把昵称 / 头像立刻推一次（不做去抖；进入设置页、开房前用） */
export async function syncProfileNow(input: PushProfileInput): Promise<boolean> {
  const result = await pushProfile(input)
  lastSync.value = { at: Date.now(), ok: result.ok, warnings: result.warnings ?? [] }
  return result.ok
}

/** 接口地址（设置页里给「档案已存在这台设备上」做说明用） */
export function profileEndpoint(): string {
  return `${apiBase()}/profile`
}