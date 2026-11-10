/**
 * 联机状态（网络层 store）
 * ------------------------------------------------------------------
 * 职责：
 *   1. 维持与房间服务器的连接（含断线自动重连 + 用 token 回到原座位）；
 *   2. 保存**我这个座位**的权威视图 `SeatView`；
 *   3. 每收到一帧 view 就投影到 `stores/game.ts`（`applyServerView`），
 *      于是 11 个页面完全不用改；
 *   4. 把玩家的操作变成命令发给服务器（commands 一节）。
 *
 * 注意方向：本文件 **单向依赖** `stores/game.ts`（net → game），
 * game 侧需要联网时通过 `setOnlineBridge` 注入的回调发命令，避免循环依赖。
 */

import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import { NetClient, micSupported, type NetStatus } from '@/services/net/netClient'
import {
  CHAT_MAX_LEN,
  PROTOCOL_VERSION,
  selfInVoice,
  type ChatMessage,
  type ClientMsg,
  type SeatView,
  type ServerMsg,
} from '@/services/net/protocol'
import { VoiceRoom } from '@/services/net/voice'
import { playerId } from '@/services/profile'
import type { ClueItem, ScriptPackage } from '@/types/script'
import { useGameStore } from '@/stores/game'
import { useSettingsStore } from '@/stores/settings'

const SESSION_KEY = 'dsh_net_session'
/** 本地最多留多少条公屏（服务端只给 60 条历史，这里多留一些翻滚上去能看） */
const CHAT_KEEP = 200

interface SavedSession {
  roomCode: string
  token: string
  name: string
}

function loadSession(): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as SavedSession) : null
  } catch {
    return null
  }
}

function saveSession(s: SavedSession | null) {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用，忽略 */
  }
}

/** 复制文本：http 局域网下 navigator.clipboard 不可用，需要兜底 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export const useNetStore = defineStore('net', () => {
  const game = useGameStore()

  // ---- 连接与身份 ----
  const active = ref(false)
  const status = ref<NetStatus>('idle')
  const statusDetail = ref('')
  const view = shallowRef<SeatView | null>(null)
  const seatId = ref('')
  const token = ref('')
  const roomCode = ref('')
  const isHost = ref(false)
  const myName = ref('')
  const error = ref('')
  const lastToast = ref('')
  const toastKind = ref<'info' | 'warn' | 'good'>('info')

  /** 服务器与本地时钟的偏差（毫秒）：phaseEndsAt 需要换算到本地时间轴 */
  const clockSkew = ref(0)

  let client: NetClient | null = null
  /** 连接建立后要发的第一条命令（建房 / 加入） */
  let intent: ClientMsg | null = null
  /** 已经登记过的「我翻到的线索」id，用来识别"新翻出"的那一条 */
  const seenClueIds = new Set<string>()
  const pendingClue = ref<ClueItem | null>(null)

  // ---- 沟通：公屏（打字端） ----
  const chats = ref<ChatMessage[]>([])
  const unread = ref(0)
  /** 沟通面板（底部弹层）是否打开，以及停在哪个 tab */
  const talkOpen = ref(false)
  const talkTab = ref<'voice' | 'chat'>('voice')
  /** 公屏全量索引（含已滚出屏幕的），用 id 去重 */
  const chatIndex = new Map<string, ChatMessage>()

  // ---- 沟通：实时语音（WebRTC，服务端只转信令） ----
  const voiceRoom = shallowRef<VoiceRoom | null>(null)
  const voiceJoined = ref(false)
  const voiceError = ref('')
  /** 自增计数：VoiceRoom 内部是普通 Map，靠它触发 Vue 重新求值 */
  const voiceTick = ref(0)
  /** 重连后想把麦克风自动接回去时用的节流时间戳 */
  let lastVoiceRejoin = 0

  // ---- getters（大厅页用） ----
  const connected = computed(() => status.value === 'open')
  const inRoom = computed(() => !!view.value && !!seatId.value)
  const reconnecting = computed(() => active.value && status.value !== 'open')
  const playerCount = computed(() => view.value?.playerCount ?? 0)
  const theme = computed(() => view.value?.theme ?? '')
  const started = computed(() => view.value?.started === true)
  const myReady = computed(() => mySeatReady())
  const allReady = computed(() => {
    const seats = view.value?.seats ?? []
    return seats.length > 0 && seats.every((s) => s.ready || s.isBot)
  })
  const pendingNames = computed(() =>
    (view.value?.seats ?? []).filter((s) => !s.ready && !s.isBot).map((s) => s.name),
  )
  const selfRoleName = computed(() => view.value?.self.roleName ?? '')
  const isMurderer = computed(() => view.value?.self.isMurderer === true)
  const phase = computed(() => view.value?.phase ?? 'room')

  // ---- 沟通相关 getters ----
  /** 正在语音里的人（服务端权威列表，含我自己） */
  const voicePeers = computed(() => view.value?.voice ?? [])
  const voiceCount = computed(() => voicePeers.value.length)
  /** 浏览器能不能用麦克风（非 https 的 http 页面上为 false） */
  const canVoice = computed(() => micSupported())
  /** 我是否在麦上（本地麦克风状态；服务端列表会用来自动纠偏） */
  const inVoice = computed(() => voiceJoined.value)
  /** 别人静音了没有 */
  const mutedSeats = computed(() => voicePeers.value.filter((p) => p.muted).map((p) => p.seatId))
  /** 谁的音量过阈值（含我自己）—— 读 voiceTick 建立响应式依赖 */
  function speakingOf(seatId: string): boolean {
    void voiceTick.value
    const v = voiceRoom.value
    if (!v) return false
    return seatId === 'self' ? v.selfSpeaking : v.isSpeaking(seatId)
  }
  const peerStateOf = (seatId: string): string => {
    void voiceTick.value
    return voiceRoom.value?.stateOf(seatId) ?? 'idle'
  }
  const autoplayBlocked = computed(() => {
    void voiceTick.value
    return voiceRoom.value?.autoplayBlocked === true
  })

  function mySeatReady(): boolean {
    const v = view.value
    if (!v) return false
    return v.seats.find((s) => s.seatId === v.self.seatId)?.ready === true
  }

  // ---- 内部：投影到 game store ----
  function project(v: SeatView) {
    view.value = v
    clockSkew.value = v.serverAt - Date.now()
    detectNewFind(v)
    mergeChats(v.chats ?? [], true) // view 里的是历史，不算未读
    syncVoice(v)
    game.applyServerView(v, clockSkew.value)
  }

  /**
   * 合并公屏消息（服务端 view 里的历史 + 实时广播的 `chat` 帧走同一条路）。
   * `silent = true` 表示这是历史（重连补发），不计未读。
   */
  function mergeChats(list: ChatMessage[], silent: boolean) {
    let added = false
    for (const m of list) {
      if (!m || !m.id || chatIndex.has(m.id)) continue
      chatIndex.set(m.id, m)
      added = true
      if (!silent && m.seatId !== seatId.value && !talkOpen.value) unread.value += 1
    }
    if (!added) return
    const all = [...chatIndex.values()].sort((a, b) =>
      a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at - b.at,
    )
    if (all.length > CHAT_KEEP) {
      for (const m of all.slice(0, all.length - CHAT_KEEP)) chatIndex.delete(m.id)
      chats.value = all.slice(-CHAT_KEEP)
    } else {
      chats.value = all
    }
  }

  /** 每次收到 view 都对齐一次语音连接：多了连、少了拆、我不在列表里就重新登记 */
  function syncVoice(v: SeatView) {
    const room = voiceRoom.value
    if (!room) return
    room.syncPeers(v.voice ?? [], v.self.seatId)
    if (room.joined && !selfInVoice(v)) {
      const now = Date.now()
      if (now - lastVoiceRejoin > 2000) {
        lastVoiceRejoin = now
        send({ t: 'voice-join' })
      }
    }
    if (!room.joined && voiceJoined.value) voiceJoined.value = false
  }

  /** 找出服务器刚刚私下推给我的那条搜证线索（用于弹「你翻到了什么」） */
  function detectNewFind(v: SeatView) {
    const mine = (v.self.privateClues ?? []).filter(
      (c) => c.foundBy === v.self.seatId && !c.isPrivate,
    )
    let fresh: ClueItem | null = null
    for (const c of mine) {
      if (!seenClueIds.has(c.id)) {
        seenClueIds.add(c.id)
        fresh = c
      }
    }
    if (fresh) pendingClue.value = fresh
  }

  // ---- 内部：收帧 ----
  function onMessage(msg: ServerMsg) {
    switch (msg.t) {
      case 'welcome':
        seatId.value = msg.seatId
        token.value = msg.token
        roomCode.value = msg.roomCode
        isHost.value = msg.isHost
        error.value = ''
        saveSession({ roomCode: msg.roomCode, token: msg.token, name: myName.value })
        break
      case 'view':
        project(msg.view)
        // 断线重连后可能错过「已开局」，这里兜底把在线标记补齐
        // （setOnline 只在首次进入联机时清本地痕迹，不会覆盖刚投影的轮次）
        if (active.value) game.setOnline(true)
        break
      case 'toast':
        lastToast.value = msg.text
        toastKind.value = msg.kind ?? 'info'
        break
      case 'error':
        error.value = msg.message
        break
      case 'pong':
        clockSkew.value = msg.serverAt - msg.at
        break
      case 'chat':
        mergeChats([msg.msg], false)
        break
      case 'voice-signal':
        void voiceRoom.value?.handleSignal(msg.fromSeatId, msg.data)
        break
    }
  }

  function onStatus(s: NetStatus, detail: string) {
    status.value = s
    statusDetail.value = detail
    if (s !== 'open') {
      // 信令通道断了就先退出语音：否则别人还在等你，你这边却再也发不出信令
      if (voiceJoined.value && voiceRoom.value) {
        voiceRoom.value.leave(false)
        voiceJoined.value = false
      }
      lastVoiceRejoin = 0
      return
    }
    // 连上之后：优先续座，其次执行建房/加入意图
    const saved = token.value ? { roomCode: roomCode.value, token: token.value } : loadSession()
    if (saved?.token && saved.roomCode) {
      send({ t: 'rejoin', roomCode: saved.roomCode, token: saved.token, proto: PROTOCOL_VERSION })
      if (!roomCode.value) roomCode.value = saved.roomCode
      return
    }
    if (intent) {
      const msg = intent
      intent = null
      send(msg)
    }
  }

  function ensureClient() {
    if (client) return client
    client = new NetClient({ onMessage, onStatus })
    return client
  }

  function send(msg: ClientMsg): boolean {
    const c = ensureClient()
    if (c.send(msg)) return true
    // 没连上就先记着（onStatus('open') 时补发）
    if (msg.t === 'create' || msg.t === 'join') intent = msg
    return false
  }

  // ---- 对外动作 ----

  /** 手动重连（错误条上的「重试连接」） */
  function connect() {
    active.value = true
    game.setOnline(true)
    ensureClient().connect()
  }

  /**
   * 带在 create / join 上的「我是谁」：设备档案 ID + 头像。
   * 服务器据此把这一局记进我的战绩（老服务器不认识这两个字段，会直接忽略）。
   */
  function identity(): { playerId: string; avatar?: string } {
    const id = playerId()
    const avatar = useSettingsStore().state.avatar?.trim()
    return avatar ? { playerId: id, avatar } : { playerId: id }
  }

  /** 建房并成为房主 */
  function createRoom(name: string, count: number, themeName: string, script?: ScriptPackage) {
    myName.value = name || '我'
    active.value = true
    game.setOnline(true)
    resetLocalRoom()
    intent = {
      t: 'create',
      name: myName.value,
      playerCount: count,
      theme: themeName,
      proto: PROTOCOL_VERSION,
      ...identity(),
      ...(script ? { script } : {}),
    }
    const c = ensureClient()
    c.connect()
    // 已经连着的话 onStatus 不会再触发，直接发
    if (c.isOpen) {
      const msg = intent
      intent = null
      if (msg) send(msg)
    }
  }

  /** 用房号加入 */
  function joinRoom(name: string, code: string) {
    myName.value = name || '我'
    active.value = true
    game.setOnline(true)
    resetLocalRoom()
    intent = {
      t: 'join',
      name: myName.value,
      roomCode: code.trim().toUpperCase(),
      proto: PROTOCOL_VERSION,
      ...identity(),
    }
    const c = ensureClient()
    c.connect()
    if (c.isOpen) {
      const msg = intent
      intent = null
      if (msg) send(msg)
    }
  }

  function resetLocalRoom() {
    game.resetAll()
    seenClueIds.clear()
    pendingClue.value = null
    error.value = ''
    lastToast.value = ''
    view.value = null
    forgetTalk()
  }

  /** 清空本地沟通状态（换房间 / 离开时调用） */
  function forgetTalk() {
    // 用 dispose 而不是 leave：除了拆连接、停麦克风，还要把 AudioContext 关掉，
    // 否则每换一次房间就漏一个（浏览器对同时存在的 AudioContext 数量是有上限的）。
    voiceRoom.value?.dispose()
    voiceJoined.value = false
    voiceError.value = ''
    lastVoiceRejoin = 0
    chats.value = []
    chatIndex.clear()
    unread.value = 0
    talkOpen.value = false
    talkTab.value = 'voice'
  }

  /** 离开房间：断线 + 清空本地局 + 回首页 */
  function leaveRoom() {
    client?.close()
    active.value = false
    game.setOnline(false)
    saveSession(null)
    seatId.value = ''
    token.value = ''
    roomCode.value = ''
    isHost.value = false
    view.value = null
    pendingClue.value = null
    seenClueIds.clear()
    intent = null
    forgetTalk()
    game.resetAll()
    if (location.hash !== '#/') location.hash = '#/'
  }

  /* ---------------------------------------------------------------- *
   * 公屏（打字端）：不方便开麦时用
   * ---------------------------------------------------------------- */

  /** 发一条公屏文字；返回 false 表示没发出去（断线或内容为空） */
  function sendChat(text: string): boolean {
    const t = (text ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim()
    if (!t) return false
    return send({ t: 'chat', text: t.slice(0, CHAT_MAX_LEN) })
  }

  function openTalk(tab: 'voice' | 'chat' = 'voice') {
    talkOpen.value = true
    setTalkTab(tab)
  }

  function closeTalk() {
    talkOpen.value = false
  }

  function setTalkTab(tab: 'voice' | 'chat') {
    talkTab.value = tab
    if (tab === 'chat') unread.value = 0
  }

  /* ---------------------------------------------------------------- *
   * 实时语音（WebRTC）：服务器只转信令，音频端到端
   * ---------------------------------------------------------------- */

  function ensureVoiceRoom(): VoiceRoom {
    if (voiceRoom.value) return voiceRoom.value
    const room = new VoiceRoom({
      signal: (toSeatId, data) => {
        send({ t: 'voice-signal', toSeatId, data })
      },
      change: () => {
        voiceTick.value += 1
      },
      error: (text) => {
        voiceError.value = text
        lastToast.value = text
        toastKind.value = 'warn'
      },
    })
    voiceRoom.value = room
    return room
  }

  /** 开麦加入通话；返回 false 表示拿不到麦克风（调用方应引导「改用打字」） */
  async function joinVoice(): Promise<boolean> {
    voiceError.value = ''
    const room = ensureVoiceRoom()
    const ok = await room.join()
    if (!ok) {
      voiceJoined.value = false
      if (!canVoice.value) {
        voiceError.value =
          '当前地址不允许调麦克风：浏览器只在 https 或 localhost 下放行。找个 https 地址打开，或直接用下面的打字。'
      }
      return false
    }
    voiceJoined.value = true
    const v = view.value
    if (v) room.syncPeers(v.voice ?? [], v.self.seatId)
    send({ t: 'voice-join' })
    return true
  }

  /** 收麦退出通话（会通知其他人拆连接） */
  function leaveVoice() {
    voiceRoom.value?.leave(true)
    voiceJoined.value = false
    if (active.value) send({ t: 'voice-leave' })
  }

  /** 切换静音；返回切换后的静音状态 */
  function toggleMute(): boolean {
    const room = voiceRoom.value
    if (!room || !voiceJoined.value) return false
    room.setMuted(!room.muted)
    send({ t: 'voice-mute', muted: room.muted })
    return room.muted
  }

  /** 被浏览器拦住自动播放时，用一次点击把声音放出来 */
  async function primeVoiceAudio() {
    await voiceRoom.value?.primeAudio()
  }

  /**
   * 语音连接诊断（自检脚本用来证明「真的收到了 RTP 音频包」）。
   * 界面上暂时没用到，但排障时它就是唯一能说明「谁没连上」的东西。
   */
  function voiceStats() {
    return voiceRoom.value?.stats() ?? Promise.resolve([])
  }

  function setReady(v: boolean) {
    send({ t: 'ready', ready: v })
  }

  function start() {
    send({ t: 'start' })
  }

  function addBot() {
    send({ t: 'add-bot' })
  }

  async function copyCode(): Promise<boolean> {
    const text = `来玩剧本杀：打开 ${location.origin}/ 点「加入房间」，房号 ${roomCode.value}`
    return copyText(text)
  }

  function advance() {
    send({ t: 'advance' })
  }

  function speak(text: string) {
    send({ t: 'speak', text })
  }

  function pass() {
    send({ t: 'pass' })
  }

  function search(location: string) {
    send({ t: 'search', location })
  }

  function decideClue(clueId: string, isPublic: boolean) {
    send({ t: 'clue', clueId, public: isPublic })
    pendingClue.value = null
  }

  function strawVote(roleName: string) {
    send({ t: 'straw-vote', targetRoleName: roleName })
  }

  function vote(roleName: string) {
    send({ t: 'vote', targetRoleName: roleName })
  }

  /** SearchView 关掉弹层时调用，避免重复弹出 */
  function ackClue() {
    pendingClue.value = null
  }

  function clearToast() {
    lastToast.value = ''
  }

  function clearError() {
    error.value = ''
  }

  // 把「发命令」的能力注入 game store：game 里所有联网分支都走这里
  game.setOnlineBridge({
    active: () => active.value,
    send: (msg) => send(msg),
    clockSkew: () => clockSkew.value,
  })

  return {
    // 状态
    active,
    status,
    statusDetail,
    view,
    seatId,
    roomCode,
    isHost,
    myName,
    error,
    lastToast,
    toastKind,
    pendingClue,
    clockSkew,
    // getters
    connected,
    inRoom,
    reconnecting,
    playerCount,
    theme,
    started,
    myReady,
    allReady,
    pendingNames,
    selfRoleName,
    isMurderer,
    phase,
    // 沟通
    chats,
    unread,
    talkOpen,
    talkTab,
    voicePeers,
    voiceCount,
    canVoice,
    inVoice,
    voiceError,
    mutedSeats,
    speakingOf,
    peerStateOf,
    autoplayBlocked,
    // actions
    connect,
    createRoom,
    joinRoom,
    leaveRoom,
    setReady,
    start,
    addBot,
    copyCode,
    advance,
    speak,
    pass,
    search,
    decideClue,
    strawVote,
    vote,
    ackClue,
    clearToast,
    clearError,
    send,
    // 沟通动作
    sendChat,
    openTalk,
    closeTalk,
    setTalkTab,
    joinVoice,
    leaveVoice,
    toggleMute,
    primeVoiceAudio,
    voiceStats,
  }
})
