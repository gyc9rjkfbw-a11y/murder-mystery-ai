/**
 * 房间服务器验收测试
 * ==========================================================================
 * 用法：pnpm server:test
 *   （esbuild 把本文件打成 server/dist/test.mjs，再用 node 直接跑；
 *     不引入 vitest / jest 之类的重依赖）
 *
 * 覆盖：
 *   0. 静态站点与端口（同端口提供网页 + WebSocket）
 *   1. 信息隔离（最重要）：逐帧拦截，断言平民端永远拿不到凶手信息
 *   2. 完整流程：4 人局 reading → statement×2 → poll×2 → organize → voting → reveal
 *      （唯一最高票 = 平民胜；平票 = 凶手逃脱）
 *   3. 6 人局搜证：每人每轮 2 次上限、线索不重复、公开/私藏、地点统计
 *   4. 提前结算：倒数第二轮满票触发（含阈值文案），第 1 轮满票不触发
 *   5. 房号与断线重连
 *   8. 公屏文字：广播 / 历史补发 / 清洗截断 / 限流 / 环形缓冲
 *   9. 公屏隔离回归：平民端 view.chats 与自己的收帧逐条对账、绝不含身份字段
 *  10. 实时语音：加入 / 静音 / 退出 / 掉线自动移出 / 重连不自动回语音
 *  11. 语音信令：只中转给目标座位、结构校验、非法静默忽略、绝不落日志与视图
 *  12. 协议版本（PROTOCOL_VERSION = 2 起，旧版本一律拒绝）
 *  13. 房间单元（假时钟）：环形缓冲上限、350ms 与每秒 8 条的精确边界、日志不落 SDP
 *  14. TLS 参数解析与「证书坏了要软着陆回 http」
 *
 * 输出「X / Y 通过」，有失败则非零退出码。
 */

import { WebSocket } from 'ws'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { startServer, type ServerHandle } from '../src/app'
import { createApiHandler } from '../src/api'
import { PROFILE_LIMITS, ProfileStore } from '../src/store'
import {
  CHAT_HISTORY,
  CHAT_MIN_INTERVAL_MS,
  PROTOCOL_VERSION,
  type ChatMessage,
  type ClientMsg,
  type SeatView,
  type ServerMsg,
  type VoiceSignal,
} from '@/services/net/protocol'
import { pacingFor } from '@/services/rules'
import { buildScriptPackage } from '../src/script'
import { Room, sanitizeChatText, sanitizeVoiceSignal, truncateChatText } from '../src/room'
import { censorSeat } from '../src/censor'
import { loadTlsMaterial, parseTlsArgs, tlsFallbackWarning, tlsRequested } from '../src/tls'
import type { ScriptPackage } from '@/types/script'

const THEME = '民国·远洋邮轮谋杀案'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

let passCount = 0
let failCount = 0

function check(name: string, ok: boolean, extra = ''): void {
  if (ok) passCount += 1
  else failCount += 1
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
}

function must<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`断言前置失败：${label}`)
  return value
}

async function waitUntil(fn: () => boolean, label: string, timeoutMs = 10000): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return
    await sleep(20)
  }
  throw new Error(`等待超时：${label}`)
}

/* ------------------------------------------------------------------ *
 * 模拟客户端
 * ------------------------------------------------------------------ */

class TestClient {
  readonly name: string
  socket: WebSocket | null = null
  seatId = ''
  token = ''
  isHost = false
  /** 服务器发出的**每一帧**都留档，用于信息隔离逐帧审计 */
  frames: ServerMsg[] = []
  views: SeatView[] = []

  constructor(name: string) {
    this.name = name
  }

  async connect(url: string, options?: WebSocket.ClientOptions): Promise<void> {
    const socket = options ? new WebSocket(url, options) : new WebSocket(url)
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} 连接超时`)), 8000)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (e) => {
        clearTimeout(timer)
        reject(e as Error)
      })
    })
    socket.on('message', (raw: unknown) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(raw)) as ServerMsg
      } catch {
        return
      }
      this.frames.push(msg)
      if (msg.t === 'view') this.views.push(msg.view)
      else if (msg.t === 'welcome') {
        this.seatId = msg.seatId
        this.token = msg.token
        this.isHost = msg.isHost
      }
    })
    socket.on('error', () => {
      /* 断开错误在测试里不需要额外处理 */
    })
  }

  send(msg: ClientMsg): void {
    this.socket?.send(JSON.stringify(msg))
  }

  get hasView(): boolean {
    return this.views.length > 0
  }

  get view(): SeatView {
    return must(this.views[this.views.length - 1], `${this.name} 还没有收到视图`)
  }

  errors(): { message: string; code?: string }[] {
    return this.frames
      .filter((f): f is Extract<ServerMsg, { t: 'error' }> => f.t === 'error')
      .map((f) => ({ message: f.message, code: f.code }))
  }

  lastError(): { message: string; code?: string } | undefined {
    return this.errors()[this.errors().length - 1]
  }

  /** 收到过的公屏消息（按到达顺序） */
  chats(): ChatMessage[] {
    return this.frames
      .filter((f): f is Extract<ServerMsg, { t: 'chat' }> => f.t === 'chat')
      .map((f) => f.msg)
  }

  /** 收到过的语音信令帧 */
  signals(): Extract<ServerMsg, { t: 'voice-signal' }>[] {
    return this.frames.filter(
      (f): f is Extract<ServerMsg, { t: 'voice-signal' }> => f.t === 'voice-signal',
    )
  }

  /** 收到过的轻提示文案 */
  toasts(): string[] {
    return this.frames
      .filter((f): f is Extract<ServerMsg, { t: 'toast' }> => f.t === 'toast')
      .map((f) => f.text)
  }

  /** 当前帧数，用于「从这个时刻之后」的断言 */
  mark(): number {
    return this.frames.length
  }

  /** 某个座位在我最新视图里的语音状态 */
  voiceOf(seatId: string): { seatId: string; name: string; muted: boolean } | undefined {
    return this.view.voice.find((v) => v.seatId === seatId)
  }

  close(): void {
    this.socket?.close()
  }
}

/** 自某个帧位置之后收到的公屏消息 */
function chatsSince(client: TestClient, mark: number): ChatMessage[] {
  return client.frames
    .slice(mark)
    .filter((f): f is Extract<ServerMsg, { t: 'chat' }> => f.t === 'chat')
    .map((f) => f.msg)
}

/** 自某个帧位置之后收到的语音信令 */
function signalsSince(client: TestClient, mark: number): Extract<ServerMsg, { t: 'voice-signal' }>[] {
  return client.frames
    .slice(mark)
    .filter((f): f is Extract<ServerMsg, { t: 'voice-signal' }> => f.t === 'voice-signal')
}

/**
 * 用一个「只记帧的假 socket」直接驱动 Room（单元级）。
 * chat / voice 的注入测试用它，配合假时钟可以在毫秒内验证
 * 「环形缓冲上限 / 350ms 间隔 / 每秒 8 条」这些本来要 sleep 十几秒的逻辑。
 */
function fakeSocket(box: ServerMsg[]): Parameters<Room['attachSocket']>[1] {
  return {
    readyState: 1,
    send: (raw: string) => {
      box.push(JSON.parse(raw) as ServerMsg)
    },
  } as unknown as Parameters<Room['attachSocket']>[1]
}

/** 检查一个字符串里有没有「半个 emoji」（孤立的 UTF-16 代理码元） */
function hasLoneSurrogate(text: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)
}

function allViews(client: TestClient): SeatView[] {
  return client.frames
    .filter((f): f is Extract<ServerMsg, { t: 'view' }> => f.t === 'view')
    .map((f) => f.view)
}

/* ------------------------------------------------------------------ *
 * 通用流程驱动
 * ------------------------------------------------------------------ */

async function createRoom(
  url: string,
  playerCount: number,
  theme = THEME,
  humans = playerCount,
): Promise<{ host: TestClient; clients: TestClient[]; code: string }> {
  const host = new TestClient('房主')
  await host.connect(url)
  host.send({ t: 'create', name: host.name, playerCount, theme, proto: PROTOCOL_VERSION })
  await waitUntil(() => host.hasView, '房主收到 welcome + view')
  const clients = [host]
  for (let i = 1; i < humans; i += 1) {
    const c = new TestClient(`玩家${i + 1}`)
    await c.connect(url)
    c.send({ t: 'join', name: c.name, roomCode: host.view.roomCode, proto: PROTOCOL_VERSION })
    await waitUntil(() => c.hasView, `${c.name} 加入成功`)
    clients.push(c)
  }
  await waitUntil(
    () => host.view.seats.length === humans && host.view.seats.every((s) => !s.isBot),
    '全员就位',
  )
  return { host, clients, code: host.view.roomCode }
}

async function startGame(host: TestClient, clients: TestClient[]): Promise<void> {
  host.send({ t: 'start' })
  await waitUntil(() => host.view.started && host.view.phase === 'reading', '进入阅读阶段', 15000)
  await waitUntil(() => clients.every((c) => c.view.phase === 'reading'), '所有人进入阅读')
}

/** 让所有真人客户端按服务器指定的顺序各发一次言，返回发言顺序（seatId 序列） */
async function playRound(host: TestClient, clients: TestClient[], round: number): Promise<string[]> {
  await waitUntil(
    () => host.view.phase === 'statement' && host.view.round === round,
    `第 ${round} 轮陈述开始`,
  )
  const order: string[] = []
  for (let guard = 0; guard < clients.length + 4; guard += 1) {
    const v = host.view
    if (v.phase !== 'statement' || v.round !== round) break
    const turn = must(v.turnSeatId, `第 ${round} 轮 turnSeatId`)
    const speaker = must(
      clients.find((c) => c.seatId === turn),
      `座位 ${turn} 对应的客户端`,
    )
    order.push(turn)
    speaker.send({ t: 'speak', text: `第 ${round} 轮：我是${speaker.view.self.roleName}，先交代我的时间线。` })
    await waitUntil(
      () => host.view.turnSeatId !== turn || host.view.phase !== 'statement',
      '发言轮转',
    )
  }
  return order
}

async function castStrawVotes(
  host: TestClient,
  clients: TestClient[],
  targets: string[],
  round: number,
): Promise<void> {
  clients.forEach((c, i) => c.send({ t: 'straw-vote', targetRoleName: targets[i] }))
  await waitUntil(
    () => host.view.roundSummary !== null && host.view.roundSummary.round === round,
    `第 ${round} 轮票型统计完成`,
  )
}

async function castFinalVotes(
  host: TestClient,
  clients: TestClient[],
  targets: string[],
): Promise<void> {
  clients.forEach((c, i) => c.send({ t: 'vote', targetRoleName: targets[i] }))
  await waitUntil(() => host.view.phase === 'reveal', '结算完成', 12000)
}

function roleNamesOf(clients: TestClient[]): string[] {
  return clients[0].view.script.roles.map((r) => r.name)
}

/** 把票打散到不同角色，避免误触提前结算 */
function spreadTargets(clients: TestClient[], offset: number): string[] {
  const roles = roleNamesOf(clients)
  return clients.map((_, i) => roles[(i + offset) % roles.length])
}

/* ------------------------------------------------------------------ *
 * 1. 信息隔离逐帧审计
 * ------------------------------------------------------------------ */

interface Secret {
  label: string
  text: string
}

function secretsFor(pkg: ScriptPackage, client: TestClient): Secret[] {
  const ownRoleName = client.view.self.roleName
  const own = pkg.roles.find((r) => r.name === ownRoleName)
  const ownTexts = new Set<string>()
  if (own) {
    for (const text of [
      own.surface_task,
      own.deep_task,
      own.personal_timeline,
      own.full_script,
      ...(own.side_quests ?? []),
    ]) {
      if (text) ownTexts.add(text)
    }
  }
  const secrets: Secret[] = []
  const push = (label: string, text: string) => {
    if (!text || text.length < 12) return
    if (ownTexts.has(text)) return
    secrets.push({ label, text })
  }
  for (const role of pkg.roles) {
    if (role.name === ownRoleName) continue
    push(`${role.name}.full_script`, role.full_script.slice(0, 80))
    push(`${role.name}.surface_task`, role.surface_task)
    push(`${role.name}.deep_task`, role.deep_task)
    push(`${role.name}.personal_timeline`, role.personal_timeline)
    for (const quest of role.side_quests ?? []) push(`${role.name}.side_quest`, quest)
  }
  // 全局真相对任何人都不可见（凶手也一样，凶手只拿到直觉提示）
  push('global_truth.absolute_timeline', pkg.global_truth.absolute_timeline)
  push('global_truth.cause_of_death', pkg.global_truth.cause_of_death)
  // 凶手特权只有凶手端能拿到
  if (!client.view.self.isMurderer) {
    push('murderer_privilege.intuition_hint', pkg.murderer_privilege.intuition_hint)
  }
  return secrets
}

/** 逐帧审计一个客户端收到的所有帧，返回违规描述列表 */
function auditFrames(pkg: ScriptPackage, client: TestClient): string[] {
  const violations = new Set<string>()
  const secrets = secretsFor(pkg, client)
  const privilegeRound = pacingFor(pkg.game_config.player_count).privilegeRound
  const realMurderer = pkg.global_truth.murderer_name

  for (const frame of client.frames) {
    const atReveal = frame.t === 'view' && frame.view.phase === 'reveal'
    if (atReveal) continue // 复盘阶段本来就是全公开

    if (frame.t === 'view') {
      const v = frame.view
      const truth = v.script.global_truth
      if (truth.murderer_name !== '' || truth.cause_of_death !== '' || truth.absolute_timeline !== '') {
        violations.add('结构化：对局中 global_truth 不是空壳')
      }
      if (v.reveal !== null) violations.add('结构化：对局中 reveal 非 null')
      if (v.self.isMurderer !== (v.self.roleName === realMurderer)) {
        violations.add('结构化：self.isMurderer 与真实身份不一致')
      }
      if (v.seats.some((s) => !s.isSelf && s.roleName !== undefined)) {
        violations.add('结构化：seats 里除自己外下发了 roleName')
      }
      if ((v.script.search_locations ?? []).some((l) => l.clues.length > 0)) {
        violations.add('结构化：search_locations 下发了 clues')
      }
      for (const role of v.script.roles) {
        if (role.name === v.self.roleName) continue
        if (role.is_murderer) violations.add('结构化：别人的 is_murderer 为 true')
        if (role.full_script !== '') violations.add('结构化：别人的 full_script 非空')
        if (role.surface_task !== '' || role.deep_task !== '' || role.personal_timeline !== '') {
          violations.add('结构化：别人的任务 / 时间线非空')
        }
        if ((role.side_quests ?? []).length > 0) violations.add('结构化：别人的 side_quests 非空')
      }
      if (!v.self.isMurderer) {
        if (v.self.privilege !== null) violations.add('结构化：平民端拿到了 privilege')
        if (v.script.murderer_privilege.intuition_hint !== '') {
          violations.add('结构化：平民端 murderer_privilege 非空')
        }
      } else if (v.round < privilegeRound && v.self.privilege !== null) {
        violations.add('结构化：第 1 轮就给凶手下发了 privilege')
      }
      // 公屏 / 语音是纯公开信息，但绝不能变成身份泄露的新通道：
      // 谁在麦上、谁说了什么，都不得携带 roleName（ChatMessage / VoicePeer 本来就没这个字段）。
      for (const m of v.chats) {
        if (JSON.stringify(m).includes('"roleName"')) violations.add('结构化：chats 里出现了 roleName 字段')
      }
      if (v.chats.some((m, i) => i > 0 && m.at < v.chats[i - 1].at)) {
        violations.add('结构化：chats 不是时间正序')
      }
      if (v.voice.some((p) => JSON.stringify(p).includes('"roleName"'))) {
        violations.add('结构化：voice 里出现了 roleName 字段')
      }
    } else if (frame.t === 'chat') {
      if (JSON.stringify(frame.msg).includes('"roleName"')) {
        violations.add('结构化：chat 帧里出现了 roleName 字段')
      }
    }

    // 原文级扫描：别人的剧本正文 / 任务 / 真实死因 / 凶手特权，一个字都不许出现
    const json = JSON.stringify(frame)
    for (const secret of secrets) {
      if (json.includes(secret.text)) violations.add(`原文泄露：${secret.label}`)
    }
  }
  return [...violations]
}

/* ------------------------------------------------------------------ *
 * 测试用例
 * ------------------------------------------------------------------ */

async function testStatic(handle: ServerHandle): Promise<void> {
  console.log('\n=== 0. 同端口静态站点 + WebSocket ===')
  const res = await fetch(handle.httpUrl)
  const html = await res.text()
  check('同一端口能打开 dist/index.html', res.status === 200 && html.includes('id="app"'), `HTTP ${res.status}`)
  check(
    'WebSocket 与网页同端口',
    handle.wsUrl.includes(`:${handle.port}`) && handle.httpUrl.includes(`:${handle.port}`),
    `${handle.httpUrl} / ${handle.wsUrl}`,
  )
}

async function testStaticFallback(): Promise<void> {
  console.log('\n=== 0b. 找不到 dist 时给友好提示，但仍只提供 WS ===')
  const bare = await startServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    distDir: 'C:\\__definitely_no_dist_dir__',
  })
  try {
    const res = await fetch(bare.httpUrl)
    const html = await res.text()
    check(
      '没有 dist 时返回友好提示页（含构建指引）',
      res.status === 200 && html.includes('只提供联机服务') && html.includes('pnpm build'),
      `HTTP ${res.status}`,
    )
    const c = new TestClient('仅有WS')
    await c.connect(bare.wsUrl)
    c.send({ t: 'create', name: '仅有WS', playerCount: 4, theme: THEME, proto: PROTOCOL_VERSION })
    await waitUntil(() => c.hasView, '没有 dist 时 WS 仍可用')
    check('没有 dist 时 WebSocket 照常工作（能建房拿到 view）', c.view.playerCount === 4 && c.view.phase === 'room')
    c.close()
  } finally {
    await bare.close()
  }
}

async function testIsolation(url: string): Promise<void> {
  console.log('\n=== 1. 信息隔离（逐帧审计，最重要） ===')
  const { host, clients } = await createRoom(url, 4)
  const built = await buildScriptPackage(4, THEME)
  const pkg = must(built.pkg, '离线引擎生成 4 人剧本')
  await startGame(host, clients)
  await waitUntil(() => clients.every((c) => c.view.self.roleName.length > 0), '角色分配完成')

  const killers = clients.filter((c) => c.view.self.isMurderer)
  check('恰好一个客户端被告知自己是凶手', killers.length === 1)
  const killer = must(killers[0], '凶手客户端')
  check(
    '凶手客户端的角色名 = 原始剧本的 murderer_name',
    killer.view.self.roleName === pkg.global_truth.murderer_name,
    `${killer.view.self.roleName} / ${pkg.global_truth.murderer_name}`,
  )
  check(
    '平民端明确知道自己是平民（camp=civil，role.is_murderer=false）',
    clients
      .filter((c) => !c.view.self.isMurderer)
      .every((c) => c.view.self.camp === 'civil' && c.view.self.role?.is_murderer === false),
  )
  check('第 1 轮凶手端 privilege 仍为 null', killer.view.self.privilege === null)
  check(
    '第 1 轮所有端 murderer_privilege.intuition_hint 都为空',
    clients.every((c) => c.view.script.murderer_privilege.intuition_hint === ''),
  )
  check(
    '角色名单与离线引擎一致',
    host.view.script.roles.map((r) => r.name).join(',') === pkg.roles.map((r) => r.name).join(','),
  )

  // 推进到第 2 轮
  host.send({ t: 'advance' })
  const order1 = await playRound(host, clients, 1)
  check(
    '第 1 轮发言顺序 = 座位顺序',
    order1.join(',') === host.view.seats.map((s) => s.seatId).join(','),
    order1.join(','),
  )
  check('第 1 轮发放第 1 批线索', host.view.releasedTiers.join(',') === '1')
  await castStrawVotes(host, clients, spreadTargets(clients, 1), 1)
  check('第 1 轮摸底未触发提前结算', host.view.accel.suggested === false, host.view.accel.reason)
  host.send({ t: 'advance' })
  await playRound(host, clients, 2)

  check(
    '第 2 轮凶手端拿到特权且与原始剧本一致',
    killer.view.self.privilege !== null &&
      killer.view.self.privilege.hint === pkg.murderer_privilege.intuition_hint &&
      killer.view.self.privilege.round === 2,
    String(killer.view.self.privilege?.round),
  )
  check(
    '第 2 轮凶手端 script.murderer_privilege 与原始剧本一致',
    killer.view.script.murderer_privilege.intuition_hint === pkg.murderer_privilege.intuition_hint,
  )
  check(
    '第 2 轮平民端 privilege 仍为 null 且 murderer_privilege 为空',
    clients
      .filter((c) => !c.view.self.isMurderer)
      .every((c) => c.view.self.privilege === null && c.view.script.murderer_privilege.intuition_hint === ''),
  )
  check(
    '凶手端视图里只有自己那份 roles 是凶手',
    killer.view.script.roles.filter((r) => r.is_murderer).length === 1 &&
      killer.view.script.roles.find((r) => r.is_murderer)?.name === killer.view.self.roleName,
  )
  check(
    '第 2 轮发放第 2 批线索',
    host.view.releasedTiers.join(',') === '1,2',
    host.view.releasedTiers.join(','),
  )

  // 走完剩下的流程，中途的每一帧都留在客户端里供审计
  await castStrawVotes(host, clients, spreadTargets(clients, 2), 2)
  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'organize', '进入个人整理')
  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'voting', '进入最终投票')
  check('投票阶段会下发已投票进度（votes 字段）', Array.isArray(host.view.votes), typeof host.view.votes)
  await castFinalVotes(host, clients, clients.map(() => killer.view.self.roleName))

  check('复盘帧 reveal 非 null', clients.every((c) => c.view.reveal !== null))
  check(
    '复盘时 truth.murderer_name 全员可见且与原始剧本一致',
    clients.every(
      (c) =>
        c.view.reveal?.truth.murderer_name === pkg.global_truth.murderer_name &&
        c.view.script.global_truth.absolute_timeline === pkg.global_truth.absolute_timeline,
    ),
  )
  check(
    '复盘时凶手特权与全部搜证线索对所有人公开',
    clients.every(
      (c) =>
        c.view.script.murderer_privilege.intuition_hint === pkg.murderer_privilege.intuition_hint &&
        (c.view.script.search_locations ?? []).every((l) => l.clues.length > 0),
    ),
  )

  // —— 逐帧审计（对局中的所有帧）
  const allViolations: string[] = []
  for (const client of clients) {
    for (const v of auditFrames(pkg, client)) allViolations.push(`${client.name}: ${v}`)
  }
  const rawLeaks = [...new Set(allViolations.filter((v) => v.includes('原文泄露')))]
  const structural = [...new Set(allViolations.filter((v) => v.includes('结构化')))]
  check(
    '任一帧都没有出现别人的剧本原文 / 真实死因 / 凶手特权',
    rawLeaks.length === 0,
    `${rawLeaks.length} 处：${rawLeaks.slice(0, 3).join(' | ')}`,
  )
  check(
    '结构化裁剪规则全部成立（roles/global_truth/search_locations/seats/reveal/privilege）',
    structural.length === 0,
    `${structural.length} 处：${structural.slice(0, 3).join(' | ')}`,
  )
  check('审计确实覆盖到了多帧（防止空跑）', clients.every((c) => c.frames.length >= 10), `${host.frames.length} 帧`)
  clients.forEach((c) => c.close())
}

async function testFullFlow(url: string): Promise<void> {
  console.log('\n=== 2. 完整流程（4 人局 · 全真人） ===')
  const { host, clients } = await createRoom(url, 4)
  const built = await buildScriptPackage(4, THEME)
  const pkg = must(built.pkg, '4 人剧本')
  await startGame(host, clients)
  const killer = must(
    clients.find((c) => c.view.self.isMurderer),
    '凶手客户端',
  )
  const rule = pacingFor(4)

  check('4 人局 = 2 轮 / 无搜证 / 阅读 10 分钟', rule.maxRounds === 2 && rule.searchRounds === 0 && rule.readingSeconds === 600)
  check('开局进入 reading 且带阅读倒计时', host.view.phase === 'reading' && host.view.phaseEndsAt > host.view.serverAt)

  host.send({ t: 'advance' })
  const order1 = await playRound(host, clients, 1)
  check('陈述阶段 turnSeatId 按座位顺序轮转', order1.join(',') === host.view.seats.map((s) => s.seatId).join(','))
  check('第 1 轮只发放第 1 批线索（tier 1）', host.view.releasedTiers.join(',') === '1')
  check(
    '每人的发言都进了 statements（带轮次与座位）',
    host.view.statements.filter((s) => s.kind === 'player' && s.round === 1).length === 4,
  )
  check('4 人局无搜证环节，陈述后直接摸底', host.view.phase === 'poll', host.view.phase)
  check('轮间摸底是第 1 轮', host.view.round === 1)

  await castStrawVotes(host, clients, spreadTargets(clients, 1), 1)
  const tally = host.view.strawTally
  check(
    '票型统计（TallyRow：roleName/count/voters）正确',
    tally.reduce((n, r) => n + r.count, 0) === 4 && tally.every((r) => r.voters.length === r.count),
    tally.map((r) => `${r.roleName}:${r.count}`).join(' '),
  )
  host.send({ t: 'advance' })
  await playRound(host, clients, 2)
  check('第 2 轮发放第 2 批线索（tier 1,2）', host.view.releasedTiers.join(',') === '1,2')
  check('第 2 轮凶手特权解锁', killer.view.self.privilege !== null)

  await castStrawVotes(host, clients, spreadTargets(clients, 2), 2)
  check('末轮摸底未误触提前结算', host.view.accel.suggested === false, host.view.accel.reason)
  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'organize', '进入个人整理')
  check('末轮结束后补齐第 3 批线索', host.view.releasedTiers.join(',') === '1,2,3', host.view.releasedTiers.join(','))
  check('实际轮次停在最后一轮（第 2 轮）', host.view.round === 2)
  const organizeLeft = Math.round((host.view.phaseEndsAt - host.view.serverAt) / 1000)
  check('个人整理时长 300 秒', organizeLeft > 290 && organizeLeft <= 300, `${organizeLeft}s`)

  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'voting', '进入最终投票')
  await castFinalVotes(host, clients, clients.map(() => killer.view.self.roleName))

  const reveal = must(host.view.reveal, '复盘数据')
  const killerRow = must(
    reveal.settlement.find((r) => r.roleName === killer.view.self.roleName),
    '凶手结算行',
  )
  check(
    '凶手是唯一最高票 → 平民胜、凶手败',
    killerRow.votes === 4 &&
      killerRow.isMurderer === true &&
      killerRow.win === false &&
      reveal.settlement.filter((r) => !r.isMurderer).every((r) => r.win === true),
    `凶手 ${killerRow.votes} 票`,
  )
  check(
    '复盘包含凶手 / 真相 / 全部最终票',
    reveal.murdererRoleName === pkg.global_truth.murderer_name &&
      reveal.truth.absolute_timeline === pkg.global_truth.absolute_timeline &&
      reveal.votes.length === 4,
  )
  check(
    '复盘含节奏回顾（人数 / 轮次 / 线索发放 / 提前结算）',
    reveal.review.length >= 4 &&
      reveal.review.some((r) => r.label.includes('人数')) &&
      reveal.review.some((r) => r.label.includes('轮次')) &&
      reveal.review.some((r) => r.label.includes('线索')) &&
      reveal.review.some((r) => r.label.includes('提前结算')),
    reveal.review.map((r) => r.label).join('/'),
  )
  clients.forEach((c) => c.close())

  // —— 情形二：平票 → 凶手逃脱
  const second = await createRoom(url, 4)
  await startGame(second.host, second.clients)
  const killer2 = must(
    second.clients.find((c) => c.view.self.isMurderer),
    '第二局凶手',
  )
  const others = second.clients.filter((c) => c !== killer2)
  const otherRole = must(
    others[0].view.self.roleName === killer2.view.self.roleName
      ? undefined
      : others[0].view.self.roleName,
    '另一个平民角色',
  )
  second.host.send({ t: 'advance' })
  await playRound(second.host, second.clients, 1)
  await castStrawVotes(second.host, second.clients, spreadTargets(second.clients, 1), 1)
  second.host.send({ t: 'advance' })
  await playRound(second.host, second.clients, 2)
  await castStrawVotes(second.host, second.clients, spreadTargets(second.clients, 2), 2)
  second.host.send({ t: 'advance' })
  await waitUntil(() => second.host.view.phase === 'organize', '第二局进入整理')
  second.host.send({ t: 'advance' })
  await waitUntil(() => second.host.view.phase === 'voting', '第二局进入投票')
  // 2 票凶手 + 2 票平民 → 平票
  await castFinalVotes(second.host, second.clients, [
    killer2.view.self.roleName,
    killer2.view.self.roleName,
    otherRole,
    otherRole,
  ])
  const reveal2 = must(second.host.view.reveal, '第二局复盘')
  const murdererRow2 = must(
    reveal2.settlement.find((r) => r.isMurderer),
    '第二局凶手结算行',
  )
  check(
    '平票 → 凶手逃脱（平民败）',
    murdererRow2.votes === 2 &&
      murdererRow2.win === true &&
      reveal2.settlement.filter((r) => !r.isMurderer).every((r) => r.win === false),
    `凶手 ${murdererRow2.votes} 票 / 平民 ${must(reveal2.settlement.find((r) => r.roleName === otherRole), '平民行').votes} 票`,
  )
  second.clients.forEach((c) => c.close())
}

async function testSearch(url: string): Promise<void> {
  console.log('\n=== 3. 6 人局搜证（次数上限 / 不重复 / 公开与私藏 / 地点统计） ===')
  const { host, clients } = await createRoom(url, 6)
  await startGame(host, clients)
  host.send({ t: 'advance' })
  await playRound(host, clients, 1)

  check('6 人局陈述后进入搜证', host.view.phase === 'search', host.view.phase)
  check(
    '本轮剩余搜证次数 = 每人每轮 2 次',
    host.view.searchLeft === 2 && host.view.searchLeft === pacingFor(6).searchPerRound,
    String(host.view.searchLeft),
  )
  const initial = host.view.locations
  check(
    '地点统计：6 个地点、每个 total=3、found=0、used=false',
    initial.length === 6 && initial.every((l) => l.total === 3 && l.found === 0 && !l.used),
    JSON.stringify(initial),
  )
  check(
    'script.search_locations[].clues 永远是空数组（对局中）',
    clients.every((c) =>
      allViews(c)
        .filter((v) => v.phase !== 'reveal')
        .every((v) => (v.script.search_locations ?? []).every((l) => l.clues.length === 0)),
    ),
  )

  const locStat = (name: string) => must(host.view.locations.find((l) => l.name === name), `地点 ${name}`)
  const mine = (c: TestClient) => c.view.self.privateClues.filter((x) => x.foundBy === c.seatId)
  /** 私有板里已有的线索 id（线索按剧本顺序排列，不能按下标认「刚翻到的那条」） */
  const idsOf = (c: TestClient) => new Set(mine(c).map((x) => x.id))
  const newlyFound = (c: TestClient, before: Set<string>) =>
    must(
      mine(c).filter((x) => !before.has(x.id))[0],
      `${c.name} 刚翻出的线索`,
    )
  /** 除某个客户端之外的所有人 */
  const othersOf = (actor: TestClient) => clients.filter((c) => c !== actor)
  const A = clients[0]
  const B = clients[1]
  const C = clients[2]
  const loc = initial[0].name
  const loc2 = initial[1].name

  // A 连搜两次
  let seenA = idsOf(A)
  A.send({ t: 'search', location: loc })
  await waitUntil(() => mine(A).length === 1, 'A 第一次搜证')
  const t1 = newlyFound(A, seenA)
  check('搜证后该地点 found 从 0 → 1 且 total 不变', locStat(loc).found === 1 && locStat(loc).total === 3)
  check('搜证后本人剩余次数 -1', A.view.searchLeft === 1, String(A.view.searchLeft))
  check('翻到的线索进入本人的私有板（revealed=true / published=false）', t1.revealed === true && t1.published === false)
  check('线索内容不会出现在公共线索板', !host.view.script.public_clues.includes(t1.text))

  seenA = idsOf(A)
  A.send({ t: 'search', location: loc })
  await waitUntil(() => mine(A).length === 2, 'A 第二次搜证')
  const t2 = newlyFound(A, seenA)
  check('同一地点翻出的线索不重复', t2.text !== t1.text && t2.id !== t1.id)
  check('该地点 found 0 → 2', locStat(loc).found === 2)

  const errsBefore = A.errors().length
  A.send({ t: 'search', location: loc })
  await waitUntil(() => A.errors().length > errsBefore, 'A 第三次搜证被拒')
  const limitErr = must(A.lastError(), '第三次搜证错误')
  check(
    '每人每轮 2 次上限，第 3 次报错',
    limitErr.code === 'search-limit' && limitErr.message.includes('搜证次数已用完'),
    `${limitErr.code} / ${limitErr.message}`,
  )
  check('被拒后剩余次数不会变成负数', A.view.searchLeft === 0)

  // B 搜同一地点 → 翻空
  const seenB = idsOf(B)
  B.send({ t: 'search', location: loc })
  await waitUntil(() => mine(B).length === 1, 'B 搜证')
  const t3 = newlyFound(B, seenB)
  check('三人在同一地点翻出的线索互不重复', new Set([t1.text, t2.text, t3.text]).size === 3)
  check('地点被翻空后 used=true 且 found=total=3', locStat(loc).used === true && locStat(loc).found === 3)

  // 公开 t3
  B.send({ t: 'clue', clueId: t3.id, public: true })
  await waitUntil(
    () => othersOf(B).every((c) => c.view.script.public_clues.includes(t3.text)),
    '其他客户端看到公开线索',
  )
  check(
    'public:true 后其他客户端能看到',
    othersOf(B).every((c) => c.view.script.public_clues.includes(t3.text)),
  )

  // 翻空的地点再搜 → 报错且不消耗次数（C 有 2 次）
  C.send({ t: 'search', location: loc })
  await waitUntil(() => C.errors().length > 0, '翻空地点报错')
  const emptyErr = must(C.lastError(), '翻空地点错误')
  check(
    '翻空的地点返回 location-empty 且不消耗次数',
    emptyErr.code === 'location-empty' && C.view.searchLeft === 2,
    `${emptyErr.code} / 剩 ${C.view.searchLeft}`,
  )

  // B 搜另一个地点并私藏
  const seenB2 = idsOf(B)
  B.send({ t: 'search', location: loc2 })
  await waitUntil(() => mine(B).length === 2, 'B 第二次搜证')
  const t4 = newlyFound(B, seenB2)
  B.send({ t: 'clue', clueId: t4.id, public: false })
  await sleep(250)
  check(
    'public:false 后其他客户端完全看不到（任何一帧都没有原文）',
    othersOf(B).every((c) => !c.frames.some((f) => JSON.stringify(f).includes(t4.text))),
  )
  check(
    'public:false 的线索没有进公共线索板',
    othersOf(B).every((c) => !c.view.script.public_clues.includes(t4.text)),
  )
  check(
    'public:false 的线索仍留在搜到者自己的私有板（published=false）',
    B.view.self.privateClues.some((x) => x.text === t4.text && x.published === false),
  )
  check('搜证次数按座位独立计算（C 仍剩 2 次）', C.view.searchLeft === 2)
  check(
    '全部翻出的线索互不重复',
    new Set([t1.text, t2.text, t3.text, t4.text]).size === 4,
  )
  check('地点统计随翻找实时同步给所有人', othersOf(B).every((c) => must(c.view.locations.find((l) => l.name === loc), 'loc').found === 3))
  clients.forEach((c) => c.close())
}

async function testAccelerate(url: string): Promise<void> {
  console.log('\n=== 4. 提前结算阈值 ===')
  const { host, clients } = await createRoom(url, 5)
  const built = await buildScriptPackage(5, THEME)
  const pkg = must(built.pkg, '5 人剧本')
  const rule = pacingFor(5)
  await startGame(host, clients)
  const target = pkg.roles[0].name

  host.send({ t: 'advance' })
  await playRound(host, clients, 1)
  await castStrawVotes(host, clients, clients.map(() => target), 1)
  check(
    '第 1 轮满票不触发（5 人局的倒数第二轮是第 2 轮）',
    host.view.accel.suggested === false,
    `第 ${host.view.round} 轮 / ${host.view.strawTally[0]?.count} 票`,
  )
  check('5 人局满票 = 5 票', host.view.strawTally[0]?.count === 5)
  host.send({ t: 'advance' })
  await playRound(host, clients, 2)
  await castStrawVotes(host, clients, clients.map(() => target), 2)
  check('倒数第二轮（第 2 轮）满票触发提前结算', host.view.accel.suggested === true, host.view.accel.reason)
  check(
    'reason 文案含阈值说明与阈值数量',
    host.view.accel.reason.includes('阈值') && host.view.accel.reason.includes(String(rule.accelerateVotes)),
    host.view.accel.reason,
  )
  check(
    '轮次小结也记录了提前结算',
    host.view.roundSummary?.accelerate === true && host.view.roundSummary.round === 2,
  )
  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'organize', '提前结算进入个人整理')
  check('房主 advance 采纳建议：跳过第 3 轮直接进整理并补齐线索', host.view.releasedTiers.join(',') === '1,2,3')
  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'voting', '进入投票')
  await castFinalVotes(host, clients, clients.map(() => target))
  check(
    '复盘回顾写明「提前结算」及其依据',
    must(host.view.reveal, '复盘').review.some(
      (r) => r.label.includes('提前结算') && r.value.includes('阈值'),
    ),
  )
  clients.forEach((c) => c.close())

  // 4 人局的倒数第二轮就是第 1 轮，同样要在第 1 轮就提示
  const four = await createRoom(url, 4)
  const pkg4 = must((await buildScriptPackage(4, THEME)).pkg, '4 人剧本')
  await startGame(four.host, four.clients)
  four.host.send({ t: 'advance' })
  await playRound(four.host, four.clients, 1)
  await castStrawVotes(four.host, four.clients, four.clients.map(() => pkg4.roles[0].name), 1)
  check(
    '4 人局（2 轮）第 1 轮满票即触发提前结算',
    four.host.view.accel.suggested === true,
    four.host.view.accel.reason,
  )
  four.clients.forEach((c) => c.close())
}

async function testRoomCodeAndRejoin(url: string): Promise<void> {
  console.log('\n=== 5. 房号校验 / 断线重连 ===')
  const { host, clients, code } = await createRoom(url, 4)

  // 错误房号
  const stranger = new TestClient('陌生人')
  await stranger.connect(url)
  stranger.send({ t: 'join', name: '陌生人', roomCode: 'ZZZZZ', proto: PROTOCOL_VERSION })
  await waitUntil(() => stranger.errors().length > 0, '错误房号被拒')
  const notFound = must(stranger.lastError(), '错误房号错误')
  check(
    '错误房号被拒绝且给出中文提示',
    notFound.code === 'room-not-found' && notFound.message.includes('没有找到房间'),
    `${notFound.code} / ${notFound.message}`,
  )
  check('错误的房号不会拿到 welcome', !stranger.frames.some((f) => f.t === 'welcome'))

  // 人数只能是 4 / 5 / 6
  const badCount = new TestClient('七人局')
  await badCount.connect(url)
  badCount.send({ t: 'create', name: '七人局', playerCount: 7, theme: THEME, proto: PROTOCOL_VERSION })
  await waitUntil(() => badCount.errors().length > 0, '非法人数被拒')
  check('人数只能是 4 / 5 / 6', must(badCount.lastError(), '人数错误').code === 'bad-player-count')
  badCount.close()

  // 协议版本不一致直接拒绝
  const oldProto = new TestClient('旧版本')
  await oldProto.connect(url)
  oldProto.send({ t: 'create', name: '旧版本', playerCount: 4, theme: THEME, proto: PROTOCOL_VERSION + 99 })
  await waitUntil(() => oldProto.errors().length > 0, '协议不一致被拒')
  check('协议版本不一致被拒绝', must(oldProto.lastError(), '协议错误').code === 'proto')
  oldProto.close()

  // 人满拒绝
  const extra = new TestClient('第五人')
  await extra.connect(url)
  extra.send({ t: 'join', name: '第五人', roomCode: code, proto: PROTOCOL_VERSION })
  await waitUntil(() => extra.errors().length > 0, '人满被拒')
  check('人数满了拒绝并报错', must(extra.lastError(), '人满错误').code === 'room-full')
  stranger.close()
  extra.close()

  // 开局后不允许中途加入
  await startGame(host, clients)
  const late = new TestClient('迟到者')
  await late.connect(url)
  late.send({ t: 'join', name: '迟到者', roomCode: code, proto: PROTOCOL_VERSION })
  await waitUntil(() => late.errors().length > 0, '开局后加入被拒')
  check('开局后中途加入被拒绝', must(late.lastError(), '开局后加入错误').code === 'game-started')
  late.close()

  // 掉线 → 用 token 重连回原座位
  const leaver = clients[3]
  const seatId = leaver.seatId
  const token = leaver.token
  const roleName = leaver.view.self.roleName
  const privateCount = leaver.view.self.privateClues.length
  leaver.close()
  await waitUntil(
    () => host.view.seats.find((s) => s.seatId === seatId)?.connected === false,
    '房主看到掉线',
    6000,
  )
  check('掉线后座位保留、connected=false', host.view.seats.some((s) => s.seatId === seatId && !s.connected))

  const back = new TestClient('玩家4')
  await back.connect(url)
  back.send({ t: 'rejoin', roomCode: code, token, proto: PROTOCOL_VERSION })
  await waitUntil(() => back.frames.some((f) => f.t === 'welcome'), '重连收到 welcome')
  await waitUntil(() => back.view.self.seatId === seatId, '重连后立刻拿到当前 view')
  check(
    'rejoin 用 token 回到原座位并立刻补发当前 view',
    back.view.self.seatId === seatId && back.view.roomCode === code && back.view.phase === 'reading',
    `${back.view.self.seatId} / ${back.view.phase}`,
  )
  check(
    '重连恢复角色与私有线索',
    back.view.self.roleName === roleName && back.view.self.privateClues.length === privateCount,
    `${back.view.self.roleName}`,
  )
  check('重连后 welcome 里的座位与 token 不变', back.seatId === seatId && back.token === token)
  await waitUntil(
    () => host.view.seats.find((s) => s.seatId === seatId)?.connected === true,
    '房主看到恢复连接',
  )
  check('房主侧 connected 恢复为 true', host.view.seats.find((s) => s.seatId === seatId)?.connected === true)

  // 无效 token
  const fake = new TestClient('假token')
  await fake.connect(url)
  fake.send({ t: 'rejoin', roomCode: code, token: 'not-a-real-token', proto: PROTOCOL_VERSION })
  await waitUntil(() => fake.errors().length > 0, '无效 token 被拒')
  check('无效 token 的重连被拒绝', must(fake.lastError(), '无效 token 错误').code === 'bad-token')
  fake.close()
  clients.forEach((c) => c.close())
  back.close()
}

async function testBotsAndPass(url: string): Promise<void> {
  console.log('\n=== 6. AI 自动补位 + Bot 自动行动 + 房主跳过发言 ===')
  const { host, clients } = await createRoom(url, 4, THEME, 2)
  await startGame(host, clients)
  const bots = host.view.seats.filter((s) => s.isBot)
  const roleNames = roleNamesOf(clients)
  check('空位自动补 AI 玩家（4 人局 2 真人 → 2 个 AI）', bots.length === 2, `${bots.length} 个`)
  check(
    'AI 昵称取「AI·角色名」（对局中别人看不到 AI 的角色名，只认昵称格式）',
    bots.every(
      (b) => b.connected && b.name.startsWith('AI·') && roleNames.includes(b.name.slice(3)),
    ) && new Set(bots.map((b) => b.name)).size === 2,
    bots.map((b) => b.name).join('/'),
  )

  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'statement' && host.view.round === 1, '第 1 轮陈述')

  // 非房主不能跳过发言人
  const firstTurn = must(host.view.turnSeatId, '第一个发言人')
  const nonHost = clients.find((c) => c.seatId !== host.seatId)!
  nonHost.send({ t: 'pass' })
  await waitUntil(() => nonHost.errors().length > 0, '非房主 pass 被拒')
  check('非房主跳过发言人被拒绝', must(nonHost.lastError(), 'pass 错误').code === 'not-host')

  // 房主跳过当前发言人
  const beforeSkip = host.view.statements.filter((s) => s.kind === 'player').length
  host.send({ t: 'pass' })
  await waitUntil(() => host.view.turnSeatId !== firstTurn, '跳过后轮转')
  check(
    '房主 pass 跳过当前发言人并直接轮转',
    host.view.turnSeatId !== firstTurn &&
      host.view.statements.filter((s) => s.kind === 'player').length === beforeSkip,
    `${firstTurn} → ${host.view.turnSeatId}`,
  )
  check('跳过会写进系统播报', host.view.statements.some((s) => s.kind === 'system' && s.title === '发言跳过'))

  // 真人补完自己的发言，其余交给 AI 自动推进到摸底
  for (let guard = 0; guard < 10; guard += 1) {
    const v = host.view
    if (v.phase !== 'statement') break
    const turn = must(v.turnSeatId, '当前发言人')
    const human = clients.find((c) => c.seatId === turn)
    if (human) human.send({ t: 'speak', text: '我先说这些，剩下的听大家补充。' })
    await waitUntil(
      () => host.view.turnSeatId !== turn || host.view.phase !== 'statement',
      '轮转（AI 自动发言）',
      9000,
    )
  }
  check('AI 自动发言（simulated=true）并推进到摸底', host.view.phase === 'poll', host.view.phase)
  check(
    '两名 AI 都自动发过言',
    bots.every((b) => host.view.statements.some((s) => s.seatId === b.seatId && s.simulated === true)),
  )

  // 真人只投自己那一票，AI 自己会投
  clients.forEach((c, i) => c.send({ t: 'straw-vote', targetRoleName: roleNamesOf(clients)[i] }))
  await waitUntil(() => host.view.roundSummary !== null, 'AI 自动完成摸底投票', 8000)
  check(
    'AI 自动摸底投票（总票数 = 4）',
    host.view.strawTally.reduce((n, r) => n + r.count, 0) === 4,
    host.view.strawTally.map((r) => `${r.roleName}:${r.count}`).join(' '),
  )

  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'statement' && host.view.round === 2, '第 2 轮陈述')
  for (let guard = 0; guard < 10; guard += 1) {
    const v = host.view
    if (v.phase !== 'statement') break
    const turn = must(v.turnSeatId, '当前发言人')
    const human = clients.find((c) => c.seatId === turn)
    if (human) human.send({ t: 'speak', text: '第二轮我只补一个矛盾点。' })
    await waitUntil(
      () => host.view.turnSeatId !== turn || host.view.phase !== 'statement',
      '轮转（AI 自动发言）',
      9000,
    )
  }
  clients.forEach((c, i) => c.send({ t: 'straw-vote', targetRoleName: roleNames[(i + 1) % roleNames.length] }))
  await waitUntil(
    () => host.view.roundSummary !== null && host.view.roundSummary.round === 2,
    '第 2 轮摸底完成',
    8000,
  )
  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'organize', '进入整理')
  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'voting', '进入投票')

  const targets = clients.map(() => roleNamesOf(clients)[0])
  clients.forEach((c, i) => c.send({ t: 'vote', targetRoleName: targets[i] }))
  await waitUntil(() => host.view.phase === 'reveal', 'AI 自动投票后结算', 12000)
  const reveal = must(host.view.reveal, 'AI 局复盘')
  check(
    'AI 自动最终投票（4 票全部计入结算）',
    reveal.votes.length === 4 &&
      bots.every((b) => reveal.votes.some((v) => v.voterSeatId === b.seatId)),
    `${reveal.votes.length} 票`,
  )
  check('AI 局也能正常复盘', reveal.settlement.length === 4 && reveal.review.length >= 4)
  check(
    '复盘时 AI 昵称与角色名严格对应（说明补位时确实按角色命名）',
    host.view.seats.filter((s) => s.isBot).every((s) => s.name === `AI·${s.roleName}`),
    host.view.seats.filter((s) => s.isBot).map((s) => s.name).join('/'),
  )
  clients.forEach((c) => c.close())
}

async function testPhaseTimeout(): Promise<void> {
  console.log('\n=== 7. 阶段超时：服务器自动推进 ===')
  // 把阶段时长压缩到 1/20，才能在几秒内验证超时路径（真实时长是几分钟）
  const fast = await startServer({ port: 0, host: '127.0.0.1', quiet: true, phaseScale: 0.05 })
  try {
    const { host, clients } = await createRoom(fast.wsUrl, 4)
    await startGame(host, clients)
    host.send({ t: 'advance' }) // 房主手动结束阅读
    await playRound(host, clients, 1)
    check('第 1 轮陈述结束进入摸底', host.view.phase === 'poll', host.view.phase)
    const pollEndsAt = host.view.phaseEndsAt
    check(
      '阶段带 phaseEndsAt 倒计时（60 秒 × 压缩系数）',
      pollEndsAt - host.view.serverAt > 0 && pollEndsAt - host.view.serverAt <= 3000,
      `${pollEndsAt - host.view.serverAt}ms`,
    )
    // 谁都不 advance：等服务器自己超时推进
    await waitUntil(
      () => host.view.phase === 'statement' && host.view.round === 2,
      '超时后自动进入第 2 轮',
      15000,
    )
    check('phaseEndsAt 到时服务器自动推进到第 2 轮陈述', host.view.phase === 'statement' && host.view.round === 2)
    check('自动推进后倒计时被刷新', host.view.phaseEndsAt > pollEndsAt)
    clients.forEach((c) => c.close())
  } finally {
    await fast.close()
  }
}

/* ------------------------------------------------------------------ *
 * 8. 公屏文字
 * ------------------------------------------------------------------ */

/** 等一会，保证同一座位的两条公屏不会被 350ms 间隔限流挡住 */
const chatPace = (): Promise<void> => sleep(CHAT_MIN_INTERVAL_MS + 80)

async function testChat(url: string): Promise<void> {
  console.log('\n=== 8. 公屏文字：广播 / 历史 / 清洗截断 / 限流 / 环形缓冲 ===')
  // 6 人局只坐 4 个真人：留出空位，后面要拉一个「中途加入」的人验证历史补发
  const { host, clients } = await createRoom(url, 6, THEME, 4)
  const [A, B, C, D] = clients

  // —— 广播给所有人（含发送者自己的回显）
  A.send({ t: 'chat', text: '各位好，我是甲。' })
  await waitUntil(() => clients.every((c) => c.chats().length >= 1), '四人收到第一条公屏')
  const first = must(A.chats()[0], '第一条公屏')
  check(
    '公屏广播给全房间所有人（发送者也收到自己的回显）',
    clients.every((c) => c.chats()[0]?.id === first.id && c.chats()[0]?.text === first.text),
  )
  check(
    '公屏消息带发送者昵称与座位（昵称本来就公开）',
    first.seatId === A.seatId && first.name === A.view.self.name,
    `${first.seatId}/${first.name}`,
  )
  check('消息 id 由服务器生成且带时间戳', first.id === 'c1' && first.at > 0, `${first.id} / ${first.at}`)

  await chatPace()
  B.send({ t: 'chat', text: '收到，我是乙。' })
  await waitUntil(() => clients.every((c) => c.chats().length >= 2), '第二条公屏广播')
  await chatPace()
  C.send({ t: 'chat', text: '丙也来了。' })
  await waitUntil(() => clients.every((c) => c.chats().length >= 3), '第三条公屏广播')
  const ids = A.chats().map((m) => m.id)
  check(
    '房内 id 自增且不重复，到达顺序 = 发送顺序',
    ids.join(',') === 'c1,c2,c3' && new Set(ids).size === 3,
    ids.join(','),
  )

  // —— 中途加入的人：view.chats 直接补发历史，且按时间正序
  const late = new TestClient('迟到者')
  await late.connect(url)
  late.send({ t: 'join', name: late.name, roomCode: host.view.roomCode, proto: PROTOCOL_VERSION })
  await waitUntil(() => late.hasView, '迟到者加入')
  check(
    '新加入的人第一帧 view 里就有完整公屏历史（老的在前）',
    late.view.chats.map((m) => m.text).join('|') === '各位好，我是甲。|收到，我是乙。|丙也来了。',
    late.view.chats.map((m) => m.id).join(','),
  )
  check('后加入的人自己没有历史发言', late.chats().length === 0)

  // —— 超长截断 / emoji 不切坏
  await chatPace()
  A.send({ t: 'chat', text: 'x'.repeat(320) })
  await waitUntil(() => A.chats().length >= 4, '超长公屏被接受')
  const long = must(A.chats()[3], '截断后的公屏')
  check('超过 200 字截断到 200 字', long.text === 'x'.repeat(200), `${long.text.length} 字`)

  await chatPace()
  A.send({ t: 'chat', text: '😀'.repeat(260) })
  await waitUntil(() => A.chats().length >= 5, 'emoji 公屏被接受')
  const emoji = must(A.chats()[4], 'emoji 截断后的公屏')
  check(
    'emoji 按码点截断：正好 200 个字符、没切出半个代理对',
    Array.from(emoji.text).length === 200 && !hasLoneSurrogate(emoji.text),
    `${Array.from(emoji.text).length} 码点 / ${emoji.text.length} 码元`,
  )
  check('刚好 200 个码点的消息原样保留', truncateChatText('😀'.repeat(200)) === '😀'.repeat(200))

  // —— 空消息 / 纯空白
  const markA = A.mark()
  const markB = B.mark()
  A.send({ t: 'chat', text: '' })
  await waitUntil(() => A.errors().length > 0, '空消息被拒')
  check('空公屏被拒（chat-empty）', must(A.lastError(), '空消息错误').code === 'chat-empty')
  const errAfterEmpty = A.errors().length
  A.send({ t: 'chat', text: '   \n\t  ' })
  await waitUntil(() => A.errors().length > errAfterEmpty, '纯空白消息被拒')
  check('纯空白（含换行）的公屏同样被拒', must(A.lastError(), '空白消息错误').code === 'chat-empty')
  await sleep(200)
  check(
    '被拒的消息不会广播给任何人',
    chatsSince(A, markA).length === 0 && chatsSince(B, markB).length === 0,
  )

  // —— 控制字符清洗（不做 HTML 转义）
  await chatPace()
  A.send({ t: 'chat', text: '<b>甲</b>\u0000\u0007' })
  await waitUntil(() => A.chats().length >= 6, '含控制字符的公屏被接受')
  const cleaned = must(A.chats()[5], '清洗后的公屏')
  check(
    '控制字符（\\u0000 等）被去掉，尖括号原样保留（前端文本插值，不转义）',
    cleaned.text === '<b>甲</b>',
    cleaned.text,
  )

  // —— 限流①：同一座位最小间隔 350ms
  await chatPace()
  const markB2 = B.mark()
  A.send({ t: 'chat', text: '间隔第一条' })
  await waitUntil(() => chatsSince(B, markB2).length === 1, '间隔第一条被接受')
  A.send({ t: 'chat', text: '间隔第二条' })
  await waitUntil(() => A.errors().some((e) => e.code === 'chat-too-fast'), '同一座位连发被限流')
  await sleep(200)
  check(
    `限流生效：同一座位两条公屏至少隔 ${CHAT_MIN_INTERVAL_MS}ms（超出的丢弃并回 error）`,
    A.errors().some((e) => e.code === 'chat-too-fast') && chatsSince(B, markB2).length === 1,
  )

  // —— 限流②：每秒最多 8 条（多人合刷也不能突破）
  await sleep(1200) // 让 1 秒窗口清空，前面的消息不占额度
  const senders = [B, C, D, late]
  const floodMark = A.mark()
  senders.forEach((c) => c.send({ t: 'chat', text: '刷屏一组' }))
  await sleep(420) // > 350ms：同一座位不算「连发」，只有每秒上限能拦
  senders.forEach((c) => c.send({ t: 'chat', text: '刷屏二组' }))
  await sleep(80)
  A.send({ t: 'chat', text: '第 9 条' })
  await waitUntil(
    () => chatsSince(A, floodMark).length === 8 || A.errors().some((e) => e.code === 'chat-flood'),
    '刷屏结果稳定',
    5000,
  )
  await sleep(300)
  const accepted = chatsSince(A, floodMark)
  check('每秒 8 条上限：四个座位合刷 9 条，只放进 8 条', accepted.length === 8, `${accepted.length} 条`)
  check(
    '超出的那条被丢弃并回一条 error（chat-flood）',
    [...senders, A].some((c) => c.errors().some((e) => e.code === 'chat-flood')),
    A.errors().map((e) => e.code).join(','),
  )

  // —— 环形缓冲：历史不会随房间运行无限增长
  await sleep(1200)
  const total = CHAT_HISTORY + 2
  const burstMark = A.mark()
  for (let i = 0; i < total; i += 1) {
    senders[i % senders.length].send({ t: 'chat', text: `连发第 ${i + 1} 条` })
    // 4 个座位轮转 → 单座位 560ms、全房间约 7.1 条/秒，都低于限流
    await sleep(140)
  }
  await waitUntil(() => chatsSince(A, burstMark).length >= total, '连发全部到达', 15000)
  const burst = chatsSince(A, burstMark)
  check(`连续发 ${total} 条都未被限流误伤`, burst.length === total, `${burst.length} 条`)

  host.send({ t: 'ready', ready: true })
  const lastId = burst[burst.length - 1].id
  await waitUntil(() => {
    const kept = host.view.chats
    return kept.length > 0 && kept[kept.length - 1].id === lastId
  }, '视图刷新后能读到最新历史')
  const kept = host.view.chats
  check(`环形缓冲：view.chats 只保留最近 ${CHAT_HISTORY} 条`, kept.length === CHAT_HISTORY, `${kept.length} 条`)
  check(
    '淘汰的是最老的消息（先进先出），保留段仍严格按时间正序',
    Number(kept[0].id.slice(1)) > 1 &&
      kept.every((m, i) => i === 0 || Number(m.id.slice(1)) > Number(kept[i - 1].id.slice(1))) &&
      kept[kept.length - 1].id === lastId,
    `${kept[0].id} → ${kept[kept.length - 1].id}`,
  )
  check('累计接受数已超过上限（说明确实发生了淘汰）', A.chats().length > CHAT_HISTORY, `${A.chats().length} 条`)
  clients.forEach((c) => c.close())
  late.close()
}

/* ------------------------------------------------------------------ *
 * 9. 公屏隔离回归（平民端逐帧对账）
 * ------------------------------------------------------------------ */

async function testChatIsolation(url: string): Promise<void> {
  console.log('\n=== 9. 公屏隔离回归：平民端逐帧对账 + 绝不含身份字段 ===')
  const { host, clients } = await createRoom(url, 4)
  const built = await buildScriptPackage(4, THEME)
  const pkg = must(built.pkg, '4 人剧本')
  await startGame(host, clients)
  await waitUntil(() => clients.every((c) => c.view.self.roleName.length > 0), '角色分配完成')
  const civil = must(
    clients.find((c) => !c.view.self.isMurderer),
    '平民端',
  )

  // 陈述阶段照常能打字（「不方便开麦就打字」正是这条通道的用途）
  host.send({ t: 'advance' })
  await waitUntil(() => host.view.phase === 'statement', '进入陈述阶段')
  for (const c of clients) {
    c.send({ t: 'chat', text: `${c.view.self.name}：我先把时间线放这儿。` })
    await chatPace()
  }
  await waitUntil(() => civil.chats().length >= 4, '对局中的公屏全部到达')
  check('陈述阶段照常可以发公屏（不想开麦的人有退路）', civil.chats().length === 4)

  // 触发一次广播（房主举手），让 view.chats 把刚才的历史带上，再逐帧对账
  host.send({ t: 'ready', ready: true })
  await waitUntil(() => civil.view.chats.length >= 4, '公屏历史进入 view')

  const received = new Set(civil.chats().map((m) => m.id))
  const seenInViews = allViews(civil).flatMap((v) => v.chats)
  check(
    '平民端 view.chats 里的每条消息都能在他自己的收帧里找到（逐帧对账）',
    seenInViews.every((m) => received.has(m.id)) && seenInViews.length >= 4,
    `${seenInViews.length} 条历史 / ${received.size} 条收帧`,
  )

  const hasRoleField = civil.frames.some((f) => {
    if (f.t === 'view') {
      return f.view.chats.some(
        (m) =>
          JSON.stringify(m).includes('"roleName"') ||
          JSON.stringify(m).includes('"isMurderer"') ||
          JSON.stringify(m).includes('"camp"'),
      )
    }
    if (f.t === 'chat') return JSON.stringify(f.msg).includes('"roleName"')
    return false
  })
  check('chats 里扫不到任何身份字段（roleName / isMurderer / camp）', !hasRoleField)

  const violations = auditFrames(pkg, civil)
  check(
    '加入公屏后逐帧审计仍然全绿（无原文泄露 / 无结构化违规）',
    violations.length === 0,
    violations.slice(0, 3).join(' | '),
  )
  check(
    '公屏内容不会混进别人的私有信息（文本就是玩家自己写的）',
    civil.chats().every((m) => m.text.includes('时间线放这儿')),
  )
  clients.forEach((c) => c.close())
}

/* ------------------------------------------------------------------ *
 * 10. 实时语音：成员名单 / 静音 / 掉线 / 重连
 * ------------------------------------------------------------------ */

async function testVoice(url: string): Promise<void> {
  console.log('\n=== 10. 实时语音：加入 / 静音 / 退出 / 掉线移除 / 重连不自动回语音 ===')
  const { host, clients } = await createRoom(url, 4)
  const [A, B, C, D] = clients
  check('开局前 view.voice 是空数组（谁都不在麦上）', A.view.voice.length === 0)

  // B 先加入
  B.send({ t: 'voice-join' })
  await waitUntil(() => A.view.voice.length === 1, 'A 看到 B 在语音里')
  check(
    '语音名单全房间公开（谁在麦上不是秘密）',
    clients.every((c) => c.view.voice.length === 1 && c.view.voice[0].seatId === B.seatId),
  )
  check('默认不是静音', A.view.voice[0].muted === false)
  check(
    '加入语音会广播轻提示',
    clients.every((c) => c.toasts().some((t) => t.includes('加入'))),
    A.toasts().filter((t) => t.includes('语音')).join('/'),
  )

  // A 后加入 → 名单顺序仍按座位号，而不是加入先后
  A.send({ t: 'voice-join' })
  await waitUntil(() => B.view.voice.length === 2, 'B 看到 A 也进来了')
  check(
    '语音名单顺序稳定 = 座位顺序（与加入先后无关）',
    B.view.voice.map((v) => v.seatId).join(',') === [A.seatId, B.seatId].join(','),
    B.view.voice.map((v) => v.seatId).join(','),
  )

  const toastMark = A.toasts().length
  A.send({ t: 'voice-join' })
  await sleep(250)
  check('重复 voice-join 幂等（不重复进名单、不重复提示）', A.view.voice.length === 2 && A.toasts().length === toastMark)

  A.send({ t: 'voice-mute', muted: true })
  await waitUntil(() => B.voiceOf(A.seatId)?.muted === true, 'B 看到 A 静音')
  check(
    '静音状态广播给所有人（其他人显示 🔇）',
    clients.every((c) => c.voiceOf(A.seatId)?.muted === true && c.voiceOf(B.seatId)?.muted === false),
  )
  A.send({ t: 'voice-mute', muted: false })
  await waitUntil(() => C.voiceOf(A.seatId)?.muted === false, '取消静音同步给所有人')
  check('可以取消静音', B.voiceOf(A.seatId)?.muted === false)

  const errMark = C.errors().length
  C.send({ t: 'voice-mute', muted: true })
  await sleep(250)
  check(
    '不在语音里的座位 mute 被忽略（静默，不报错也不进名单）',
    C.view.voice.length === 2 &&
      !C.view.voice.some((v) => v.seatId === C.seatId) &&
      C.errors().length === errMark,
  )

  // 掉线前的公屏，用于验证重连补发
  await chatPace()
  D.send({ t: 'chat', text: '先把线索板上的东西说清楚。' })
  await waitUntil(() => B.chats().some((m) => m.text === '先把线索板上的东西说清楚。'), '掉线前的公屏到达')

  const seatB = B.seatId
  const tokenB = B.token
  B.close()
  await waitUntil(() => A.view.voice.length === 1 && A.voiceOf(seatB) === undefined, 'B 掉线后被移出语音')
  check('断线自动移出语音（其他人可以据此拆掉连接）', !A.view.voice.some((v) => v.seatId === seatB))
  check(
    '掉线只移出语音，座位仍然保留',
    A.view.seats.some((s) => s.seatId === seatB && !s.connected),
  )

  const back = new TestClient('玩家2')
  await back.connect(url)
  back.send({ t: 'rejoin', roomCode: host.view.roomCode, token: tokenB, proto: PROTOCOL_VERSION })
  await waitUntil(() => back.frames.some((f) => f.t === 'welcome'), 'B 重连')
  await waitUntil(() => back.view.chats.length > 0, '重连后补发公屏历史')
  check(
    '重连后公屏历史照常补发',
    back.view.chats.some((m) => m.text === '先把线索板上的东西说清楚。'),
  )
  check(
    '重连不自动回到语音（音频设备要用户重新授权），名单里只有 A',
    back.view.voice.length === 1 && back.view.voice[0].seatId === A.seatId,
  )

  back.send({ t: 'voice-join' })
  await waitUntil(() => A.voiceOf(seatB) !== undefined, '重连后手动加入语音')
  check('重连后可以重新 voice-join', A.voiceOf(seatB)?.seatId === seatB)
  check('重连后重新加入时静音状态重置为 false', A.voiceOf(seatB)?.muted === false)

  A.send({ t: 'voice-leave' })
  await waitUntil(() => back.voiceOf(A.seatId) === undefined, 'A 退出语音')
  // B 的旧连接已经关掉了，它的最后一帧视图停在退出之前，不参与这次比对
  check(
    'voice-leave 后从名单移除并广播给所有在线的人',
    [A, C, D, back].every((c) => c.voiceOf(A.seatId) === undefined),
  )
  check('退出语音也有轻提示', back.toasts().some((t) => t.includes('退出了语音')))

  const leaveToastMark = A.toasts().length
  A.send({ t: 'voice-leave' })
  await sleep(250)
  check('重复 voice-leave 幂等', back.view.voice.length === 1 && A.toasts().length === leaveToastMark)

  clients.forEach((c) => c.close())
  back.close()
}

/* ------------------------------------------------------------------ *
 * 11. 语音信令中转
 * ------------------------------------------------------------------ */

async function testVoiceSignal(url: string): Promise<void> {
  console.log('\n=== 11. 语音信令：只中转给目标座位 + 结构校验 + 不落日志/视图 ===')
  const { clients } = await createRoom(url, 4)
  const [A, B, C, D] = clients
  const dataOf = (frame: { data: VoiceSignal }): Record<string, unknown> =>
    frame.data as unknown as Record<string, unknown>

  A.send({ t: 'voice-join' })
  B.send({ t: 'voice-join' })
  await waitUntil(() => C.view.voice.length === 2, '甲乙进入语音')

  const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 10.11.12.13\r\nSECRET-SDP-MARKER'
  const CANDIDATE = 'candidate:842163049 1 udp 1677729535 10.11.12.13 54321 typ srflx'

  A.send({ t: 'voice-signal', toSeatId: B.seatId, data: { kind: 'offer', sdp: SDP } })
  await waitUntil(() => B.signals().length === 1, 'B 收到 offer')
  const offer = must(B.signals()[0], 'B 的 offer')
  check(
    'offer 只发给目标座位，并带上 fromSeatId',
    offer.fromSeatId === A.seatId && offer.data.kind === 'offer' && dataOf(offer).sdp === SDP,
  )
  check('第三个人（不在语音里的人）一条信令都收不到', C.signals().length === 0 && D.signals().length === 0)

  B.send({ t: 'voice-signal', toSeatId: A.seatId, data: { kind: 'answer', sdp: 'answer-sdp-ok' } })
  await waitUntil(() => A.signals().length === 1, 'A 收到 answer')
  check(
    'answer 反向转发正常',
    A.signals()[0].fromSeatId === B.seatId && A.signals()[0].data.kind === 'answer',
  )

  A.send({
    t: 'voice-signal',
    toSeatId: B.seatId,
    data: { kind: 'ice', candidate: CANDIDATE, sdpMid: '0', sdpMLineIndex: 0 },
  })
  await waitUntil(() => B.signals().length === 2, 'B 收到 ice')
  const ice = must(B.signals()[1], 'B 的 ice')
  check(
    'ice 候选原样转发（含 sdpMid / sdpMLineIndex）',
    ice.data.kind === 'ice' && dataOf(ice).candidate === CANDIDATE && dataOf(ice).sdpMLineIndex === 0,
  )

  A.send({ t: 'voice-signal', toSeatId: B.seatId, data: { kind: 'bye' } })
  await waitUntil(() => B.signals().length === 3, 'B 收到 bye')
  check('bye 正常转发', B.signals()[2].data.kind === 'bye')

  // —— 非法信令：静默忽略
  const sigMark = B.signals().length
  const bMark = B.mark()
  const errMarkA = A.errors().length
  const badPayloads: unknown[] = [
    { kind: 'hack' },
    { kind: 'offer', sdp: '' },
    { kind: 'offer', sdp: 'x'.repeat(20001) },
    { kind: 'offer' },
    { kind: 'ice', candidate: 'c'.repeat(2001) },
    null,
    [],
    'not-a-signal',
  ]
  for (const payload of badPayloads) {
    A.send({ t: 'voice-signal', toSeatId: B.seatId, data: payload as VoiceSignal })
  }
  await sleep(350)
  check(
    '非法信令被静默忽略（目标座位一条都没收到）',
    signalsSince(B, bMark).length === 0,
    `${signalsSince(B, bMark).length} 条`,
  )
  check('非法信令不给发送者回错误', A.errors().length === errMarkA)

  // —— 目标不存在 / 发给自己 / 发送者不在语音里 / 目标已掉线
  A.send({ t: 'voice-signal', toSeatId: 's999', data: { kind: 'offer', sdp: 'sdp-ok' } })
  A.send({ t: 'voice-signal', toSeatId: A.seatId, data: { kind: 'offer', sdp: 'sdp-ok' } })
  C.send({ t: 'voice-signal', toSeatId: B.seatId, data: { kind: 'offer', sdp: 'sdp-ok' } })
  const seatD = D.seatId
  D.close()
  await waitUntil(() => A.view.seats.find((s) => s.seatId === seatD)?.connected === false, 'D 掉线')
  A.send({ t: 'voice-signal', toSeatId: seatD, data: { kind: 'offer', sdp: 'sdp-ok' } })
  await sleep(350)
  check(
    '目标不存在 / 发给自己 / 发送者不在语音里 / 目标已掉线 → 全部忽略',
    B.signals().length === sigMark && A.signals().length === 1,
  )

  A.send({ t: 'voice-signal', toSeatId: B.seatId, data: { kind: 'bye' } })
  await waitUntil(() => signalsSince(B, bMark).length === 1, '信令通道仍然可用')
  check(
    '被垃圾信令刷过之后连接与通道都还活着（没有抛异常、没有断开）',
    signalsSince(B, bMark).length === 1,
  )

  check(
    '信令不写进任何 view / 不存历史（服务器只搬不存）',
    clients.every((c) =>
      allViews(c).every(
        (v) => !JSON.stringify(v).includes('SECRET-SDP-MARKER') && !JSON.stringify(v).includes('candidate:842163049'),
      ),
    ),
  )
  clients.forEach((c) => c.close())
}

/* ------------------------------------------------------------------ *
 * 12. 协议版本
 * ------------------------------------------------------------------ */

async function testProtocolVersion(url: string): Promise<void> {
  console.log('\n=== 12. 协议版本（公屏 / 语音契约要求 PROTOCOL_VERSION = 2） ===')
  check('协议版本已升到 2（断言引用常量，不写死数字）', PROTOCOL_VERSION >= 2, `v${PROTOCOL_VERSION}`)

  const { host } = await createRoom(url, 4, THEME, 2)
  const code = host.view.roomCode

  const oldCreate = new TestClient('旧版建房')
  await oldCreate.connect(url)
  oldCreate.send({ t: 'create', name: oldCreate.name, playerCount: 4, theme: THEME, proto: 1 })
  await waitUntil(() => oldCreate.errors().length > 0, 'proto=1 建房被拒')
  check('旧协议（1）建房被拒，code=proto', must(oldCreate.lastError(), '旧协议建房').code === 'proto')

  const oldJoin = new TestClient('旧版加入')
  await oldJoin.connect(url)
  oldJoin.send({ t: 'join', name: oldJoin.name, roomCode: code, proto: PROTOCOL_VERSION - 1 })
  await waitUntil(() => oldJoin.errors().length > 0, '旧协议加入被拒')
  check('旧协议加入被拒，code=proto', must(oldJoin.lastError(), '旧协议加入').code === 'proto')

  const oldRejoin = new TestClient('旧版重连')
  await oldRejoin.connect(url)
  oldRejoin.send({ t: 'rejoin', roomCode: code, token: host.token, proto: 1 })
  await waitUntil(() => oldRejoin.errors().length > 0, '旧协议重连被拒')
  check('旧协议重连被拒，code=proto', must(oldRejoin.lastError(), '旧协议重连').code === 'proto')
  check(
    '被拒的旧客户端拿不到 welcome（更不会占座位）',
    !oldCreate.frames.some((f) => f.t === 'welcome') && !oldJoin.frames.some((f) => f.t === 'welcome'),
  )
  oldCreate.close()
  oldJoin.close()
  oldRejoin.close()

  const ok = new TestClient('新版加入')
  await ok.connect(url)
  ok.send({ t: 'join', name: ok.name, roomCode: code, proto: PROTOCOL_VERSION })
  await waitUntil(() => ok.hasView, '版本一致的客户端正常加入')
  check(
    '版本一致的客户端不受影响，且 view 里带上了 chats / voice 两个新字段',
    ok.view.roomCode === code && Array.isArray(ok.view.chats) && Array.isArray(ok.view.voice),
  )
  ok.close()
  host.close()
}

/* ------------------------------------------------------------------ *
 * 13. 房间单元（假时钟）：环形缓冲 / 精确限流 / 日志不落 SDP
 * ------------------------------------------------------------------ */

function timersOf(room: Room): Set<unknown> {
  return (room as unknown as { timers: Set<unknown> }).timers
}

async function testRoomUnit(): Promise<void> {
  console.log('\n=== 13. 房间单元（假时钟）：环形缓冲 / 限流边界 / 日志不落 SDP ===')
  const logs: string[] = []
  let fakeNow = Date.now()
  const room = new Room({
    code: 'UNIT1',
    playerCount: 6,
    theme: THEME,
    logger: (line) => logs.push(line),
    now: () => fakeNow,
  })
  const boxes: ServerMsg[][] = []
  const seats = ['甲', '乙', '丙', '丁', '戊', '己'].map((name, i) => {
    const seat = room.addSeat({ name, isBot: false, connected: true, ready: false, host: i === 0 })
    const box: ServerMsg[] = []
    boxes.push(box)
    room.attachSocket(seat, fakeSocket(box))
    return seat
  })
  const boxChats = (i: number): Extract<ServerMsg, { t: 'chat' }>[] =>
    boxes[i].filter((f): f is Extract<ServerMsg, { t: 'chat' }> => f.t === 'chat')
  const boxErrors = (i: number): Extract<ServerMsg, { t: 'error' }>[] =>
    boxes[i].filter((f): f is Extract<ServerMsg, { t: 'error' }> => f.t === 'error')

  // —— 环形缓冲（假时钟把 400ms 一条的 67 条消息瞬间跑完）
  const burst = CHAT_HISTORY + 7
  for (let i = 1; i <= burst; i += 1) {
    room.handle(seats[0], { t: 'chat', text: `第 ${i} 条` })
    fakeNow += CHAT_MIN_INTERVAL_MS + 50
  }
  const view = censorSeat(room, seats[0].seatId)
  check(
    `环形缓冲：连发 ${burst} 条后只留上限 ${CHAT_HISTORY} 条（内部存储也不涨）`,
    view.chats.length === CHAT_HISTORY && room.chats.length === CHAT_HISTORY,
    `${view.chats.length} / ${room.chats.length}`,
  )
  check(
    '淘汰的是最老的，保留段是最后 60 条且时间正序',
    view.chats[0].text === '第 8 条' &&
      view.chats[CHAT_HISTORY - 1].text === `第 ${burst} 条` &&
      view.chats.every((m, i) => i === 0 || m.at >= view.chats[i - 1].at),
    `${view.chats[0].text} … ${view.chats[CHAT_HISTORY - 1].text}`,
  )
  check(
    'id 房内自增不重复',
    view.chats[0].id === 'c8' &&
      view.chats[CHAT_HISTORY - 1].id === `c${burst}` &&
      new Set(view.chats.map((m) => m.id)).size === CHAT_HISTORY,
  )

  // —— 350ms 间隔的边界（假时钟可以精确到 1ms）
  fakeNow += 2000
  const t0 = fakeNow
  const seat1Before = boxChats(1).length
  room.handle(seats[1], { t: 'chat', text: '边界 A' })
  room.handle(seats[1], { t: 'chat', text: '边界 B' })
  check('同一座位 0ms 内连发被拒（chat-too-fast）', boxErrors(1)[boxErrors(1).length - 1]?.code === 'chat-too-fast')
  fakeNow = t0 + CHAT_MIN_INTERVAL_MS - 1
  room.handle(seats[1], { t: 'chat', text: '边界 C' })
  check(
    `差 1ms（${CHAT_MIN_INTERVAL_MS - 1}ms）仍然被拒`,
    boxChats(1).length - seat1Before === 1,
    `${boxChats(1).length - seat1Before} 条`,
  )
  fakeNow = t0 + CHAT_MIN_INTERVAL_MS
  room.handle(seats[1], { t: 'chat', text: '边界 D' })
  check(
    `刚好 ${CHAT_MIN_INTERVAL_MS}ms 时通过（「至少」包含边界）`,
    boxChats(1).length - seat1Before === 2,
    `${boxChats(1).length - seat1Before} 条`,
  )

  // —— 每秒 8 条的房间级上限（假时钟下完全确定）
  fakeNow += 2000
  const base = fakeNow
  const observerBefore = boxChats(5).length
  for (const step of [0, 400, 800]) {
    fakeNow = base + step
    seats.slice(0, 3).forEach((s) => room.handle(s, { t: 'chat', text: `刷屏 ${step}` }))
  }
  const accepted = boxChats(5).length - observerBefore
  check(
    '房间级每秒上限：3 个座位 × 3 条（各隔 400ms）= 9 条，只放进 8 条',
    accepted === 8,
    `${accepted} 条`,
  )
  check(
    '被丢掉的那条不写入历史（历史上只多 8 条刷屏）',
    room.chats.filter((m) => m.text.startsWith('刷屏')).length === 8,
    `${room.chats.filter((m) => m.text.startsWith('刷屏')).length} 条`,
  )
  check(
    '超限的那条回 chat-flood 错误',
    [0, 1, 2].some((i) => boxErrors(i).some((e) => e.code === 'chat-flood')),
  )

  // —— 语音（单元级）
  room.handle(seats[0], { t: 'voice-join' })
  room.handle(seats[0], { t: 'voice-join' }) // 幂等
  room.handle(seats[1], { t: 'voice-mute', muted: true }) // 不在语音里 → 忽略
  check(
    'voice-join 幂等，名单顺序 = 座位顺序',
    room.voicePeers().length === 1 && room.voicePeers()[0].seatId === seats[0].seatId,
  )
  check('不在语音里的人 mute 被忽略', room.voicePeers()[0].muted === false)

  const SECRET_SDP = 'SECRET-SDP-BODY-9f3a'
  const SECRET_CAND = 'SECRET-CANDIDATE-77'
  const signalMark = boxes[1].length
  room.handle(seats[0], { t: 'voice-signal', toSeatId: seats[1].seatId, data: { kind: 'offer', sdp: SECRET_SDP } })
  room.handle(seats[0], {
    t: 'voice-signal',
    toSeatId: seats[1].seatId,
    data: { kind: 'ice', candidate: SECRET_CAND, sdpMid: '0', sdpMLineIndex: 0 },
  })
  const got = boxes[1].slice(signalMark).filter((f) => f.t === 'voice-signal')
  check('信令只转发给目标座位', got.length === 2 && boxes[2].every((f) => f.t !== 'voice-signal'))
  check(
    '日志只记「谁的什么信令转给谁」，SDP / candidate 正文一个字都不落日志',
    logs.some((l) => l.includes('语音信令') && l.includes('offer')) &&
      !logs.some((l) => l.includes(SECRET_SDP) || l.includes(SECRET_CAND)),
    logs.filter((l) => l.includes('语音信令')).slice(0, 2).join(' | '),
  )

  let threw = false
  try {
    room.handle(seats[0], {
      t: 'voice-signal',
      toSeatId: seats[1].seatId,
      data: { kind: 'nope' } as unknown as VoiceSignal,
    })
    room.handle(seats[0], { t: 'voice-signal', toSeatId: 's999', data: { kind: 'bye' } })
    room.handle(seats[0], {
      t: 'voice-signal',
      toSeatId: seats[1].seatId,
      data: { kind: 'offer', sdp: 'x'.repeat(20001) },
    })
  } catch {
    threw = true
  }
  check(
    '非法信令只忽略，不抛异常也不多转发',
    !threw && boxes[1].slice(signalMark).filter((f) => f.t === 'voice-signal').length === 2,
  )

  // —— 纯函数：清洗 / 截断 / 信令校验
  check(
    '清洗：去掉 \\u0000 等控制字符（前后字符直接相连），换行折叠成空格',
    sanitizeChatText(' 甲\u0000乙\n\n丙 ') === '甲乙 丙' && sanitizeChatText('\u0007\u0000') === '',
    sanitizeChatText(' 甲\u0000乙\n\n丙 '),
  )
  const cut = truncateChatText('😀'.repeat(260))
  check('截断按码点：200 个 emoji 一个不差，没有半个代理对', Array.from(cut).length === 200 && !hasLoneSurrogate(cut))
  check(
    '信令校验：ICE 结束时的空 candidate 合法，超长 sdp / 未知 kind / 非对象判非法',
    sanitizeVoiceSignal({ kind: 'ice', candidate: '' })?.kind === 'ice' &&
      sanitizeVoiceSignal({ kind: 'offer', sdp: 'x'.repeat(20001) }) === null &&
      sanitizeVoiceSignal({ kind: 'x' }) === null &&
      sanitizeVoiceSignal(null) === null &&
      sanitizeVoiceSignal([]) === null,
  )
  check(
    '信令校验会白名单化（客户端塞的额外字段不会跟着转发）',
    JSON.stringify(sanitizeVoiceSignal({ kind: 'bye', hacker: 'payload' })) === '{"kind":"bye"}',
    String(JSON.stringify(sanitizeVoiceSignal({ kind: 'bye', hacker: 'payload' }))),
  )

  // —— 新增的公屏 / 语音不注册定时器（空房间回收不受影响）
  check('公屏 / 语音操作不注册任何定时器', timersOf(room).size === 0, `${timersOf(room).size} 个`)
  room.dispose()
  check('dispose 后定时器集合为空（空房间回收不会漏）', timersOf(room).size === 0)
}

/* ------------------------------------------------------------------ *
 * 14. HTTPS / WSS（可选）：参数解析 + 证书配坏时软着陆回 http
 * ------------------------------------------------------------------ */

async function testTlsArgs(): Promise<void> {
  console.log('\n=== 14a. TLS 参数解析（命令行 / 环境变量 / 都没有） ===')

  const none = parseTlsArgs([], {})
  check('不传任何证书参数 = 纯 http（默认行为与以前完全一致）', !tlsRequested(none) && !none.pfx && !none.cert && !none.key)

  const cli = parseTlsArgs(['--port', '6000', '--tls-pfx', 'a.pfx', '--tls-pass', 'pw'], {})
  check('--tls-pfx / --tls-pass 解析正确', cli.pfx === 'a.pfx' && cli.pass === 'pw' && tlsRequested(cli))

  const eq = parseTlsArgs(['--tls-cert=c.pem', '--tls-key=k.pem'], {})
  check('--tls-cert=… 的等号写法也认', eq.cert === 'c.pem' && eq.key === 'k.pem')

  const env = parseTlsArgs([], { MMAI_TLS_CERT: 'env-c.pem', MMAI_TLS_KEY: 'env-k.pem' })
  check('环境变量 MMAI_TLS_* 兜底', env.cert === 'env-c.pem' && env.key === 'env-k.pem' && tlsRequested(env))

  const both = parseTlsArgs(['--tls-pfx', 'cli.pfx'], { MMAI_TLS_PFX: 'env.pfx', MMAI_TLS_PASS: 'envpw' })
  check('命令行优先于环境变量（没传的项仍从环境变量补）', both.pfx === 'cli.pfx' && both.pass === 'envpw')
  check('全空白的参数视为「没配」', !tlsRequested(parseTlsArgs(['--tls-pfx', '   '], {})))

  // 读文件层（证书内容本身不在这里校验，交给 createSecureContext）
  const pfxLoad = loadTlsMaterial({ pfx: 'package.json', pass: 'pw' })
  check(
    'loadTlsMaterial 能把 PFX 读成字节（口令原样带上）',
    pfxLoad.ok && pfxLoad.material.kind === 'pfx' && (pfxLoad.material.pfx?.length ?? 0) > 0 && pfxLoad.material.passphrase === 'pw',
  )
  const pairLoad = loadTlsMaterial({ cert: 'package.json', key: 'package.json', pfx: 'package.json' })
  check('cert/key 与 pfx 同时给出时优先用 cert/key', pairLoad.ok && pairLoad.material.kind === 'cert')

  const loneCert = loadTlsMaterial({ cert: 'package.json' })
  check(
    '只给 cert 不给 key → 拒绝并说明必须成对',
    !loneCert.ok && loneCert.reason.includes('成对'),
    loneCert.ok ? '' : loneCert.reason,
  )
  const noFile = loadTlsMaterial({ pfx: 'C:\\__no_such_cert__.pfx' })
  check(
    '文件不存在 → 返回中文原因（不抛异常）',
    !noFile.ok && noFile.reason.includes('读不到'),
    noFile.ok ? '' : noFile.reason,
  )

  const warning = tlsFallbackWarning(noFile.ok ? '' : noFile.reason).join('\n')
  check(
    '回退警告写明「退回 http」+「手机无法开麦」+ 补救办法',
    warning.includes('退回 http') && warning.includes('手机') && warning.includes('麦克风'),
  )
}

/** 用自签证书访问 https 站点（测试里不校验自签证书） */
function httpsText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { rejectUnauthorized: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function testTlsSoftLanding(): Promise<void> {
  console.log('\n=== 14b. TLS 配置失败要软着陆回 http（不崩、照常能玩） ===')

  // ① 默认不配证书：行为与以前完全一致
  const plain = await startServer({ port: 0, host: '127.0.0.1', quiet: true })
  try {
    check(
      '不配证书时仍是 http，且没有警告',
      plain.protocol === 'http' && plain.tlsWarning === '' && plain.httpUrl.startsWith('http://') && plain.wsUrl.startsWith('ws://'),
      `${plain.httpUrl} / ${plain.wsUrl}`,
    )
  } finally {
    await plain.close()
  }

  // ② 文件不存在
  const missing = await startServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    tls: { pfx: 'C:\\__definitely_no_such_cert__.pfx', pass: 'x' },
  })
  try {
    check('证书文件不存在：不崩，退回 http 启动', missing.protocol === 'http' && missing.httpUrl.startsWith('http://'))
    check(
      '给出醒目中文警告（含原因 + 退回 http + 手机将无法开麦）',
      missing.tlsWarning.includes('退回 http') && missing.tlsWarning.includes('手机') && missing.tlsWarning.length > 40,
      missing.tlsWarning.split('\n')[1] ?? '',
    )
    const res = await fetch(missing.httpUrl)
    const html = await res.text()
    check('退回 http 后静态站点照常可访问', res.status === 200 && html.includes('id="app"'), `HTTP ${res.status}`)
    const c = new TestClient('回退后仍可玩')
    await c.connect(missing.wsUrl)
    c.send({ t: 'create', name: c.name, playerCount: 4, theme: THEME, proto: PROTOCOL_VERSION })
    await waitUntil(() => c.hasView, '退回 http 后仍能建房')
    check('退回 http 后 WebSocket 照常建房开局', c.view.phase === 'room' && c.view.playerCount === 4)
    c.close()
  } finally {
    await missing.close()
  }

  // ③ 文件存在但不是合法证书（拿 package.json 冒充）
  const broken = await startServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    tls: { pfx: 'package.json', pass: 'wrong' },
  })
  try {
    check('证书内容损坏 / 口令错：同样软着陆回 http', broken.protocol === 'http' && broken.wsUrl.startsWith('ws://'))
    check(
      '损坏证书的警告说明是「口令错误或文件损坏」',
      broken.tlsWarning.includes('证书无法使用') && broken.tlsWarning.includes('退回 http'),
      broken.tlsWarning.split('\n')[1] ?? '',
    )
    const c = new TestClient('坏证书也能玩')
    await c.connect(broken.wsUrl)
    c.send({ t: 'create', name: c.name, playerCount: 4, theme: THEME, proto: PROTOCOL_VERSION })
    await waitUntil(() => c.hasView, '坏证书回退后仍能建房')
    check('坏证书回退后连接照常可用', c.view.playerCount === 4)
    c.close()
  } finally {
    await broken.close()
  }

  // ④ 真证书（可选）：父任务用手工生成的 PFX 跑这一段
  const realPfx = process.env.MMAI_TEST_TLS_PFX
  if (!realPfx) {
    console.log('  （跳过真证书用例：设置 MMAI_TEST_TLS_PFX / MMAI_TEST_TLS_PASS 后会自动跑）')
    return
  }
  const secure = await startServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    tls: { pfx: realPfx, pass: process.env.MMAI_TEST_TLS_PASS },
  })
  try {
    check(
      '真证书：以 https/wss 启动，且没有回退警告',
      secure.protocol === 'https' && secure.tlsWarning === '' && secure.httpUrl.startsWith('https://') && secure.wsUrl.startsWith('wss://'),
      `${secure.httpUrl} / ${secure.wsUrl}`,
    )
    const page = await httpsText(secure.httpUrl)
    check('https 下同一个端口能打开网页', page.status === 200 && page.body.includes('id="app"'), `HTTP ${page.status}`)
    const c = new TestClient('WSS 客户端')
    await c.connect(secure.wsUrl, { rejectUnauthorized: false })
    c.send({ t: 'create', name: c.name, playerCount: 4, theme: THEME, proto: PROTOCOL_VERSION })
    await waitUntil(() => c.hasView, 'WSS 上建房')
    check('wss:// 升级请求由 ws 正常接管（照常建房）', c.view.roomCode.length === 5)
    c.send({ t: 'chat', text: '通过 wss 发的公屏' })
    await waitUntil(() => c.chats().length > 0, 'WSS 上公屏可用')
    check('WSS 下公屏 / 语音能力照常', c.chats()[0].text === '通过 wss 发的公屏')
    c.close()
  } finally {
    await secure.close()
  }
}

/* ------------------------------------------------------------------ *
 * 15. 玩家档案：后端存储（昵称 / 头像 / 战绩 / 对局历史）
 * ------------------------------------------------------------------ */

/** 极简 JSON 请求（不带第三方库） */
function httpJson(
  url: string,
  options: { method?: string; body?: unknown; raw?: string } = {},
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? 'GET'
    const payload = options.raw ?? (options.body === undefined ? '' : JSON.stringify(options.body))
    const req = http.request(
      url,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(body) as Record<string, unknown>
          } catch {
            /* 静态资源不是 JSON，保留空对象 */
          }
          resolve({ status: res.statusCode ?? 0, json, text: body })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** 把一个 apiHandler 挂到临时端口上 */
async function serveApi(
  store: ProfileStore,
  limit?: { windowMs: number; max: number },
): Promise<{ base: string; close: () => Promise<void> }> {
  const handler = createApiHandler({ store, limit })
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) {
      res.statusCode = 404
      res.end('static-fallthrough')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function testProfiles(): Promise<void> {
  console.log('\n=== 15. 玩家档案：昵称/头像/战绩/历史 · 落盘 ===')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmai-profile-'))

  /* ---------------- 15.1 档案库本体 ---------------- */
  const profileDir = path.join(root, 'profiles')
  const store = new ProfileStore({ dir: profileDir, quiet: true })
  const pid = 'test-player-0001'
  check('空库：一开始没有任何档案', store.get(pid) === null && store.count() === 0)

  const created = must(
    store.upsert({
      id: pid,
      name: '  阿   甲  ',
      avatar: '🦊',
      ai: {
        provider: 'openai',
        model: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-should-never-be-stored',
      } as Record<string, unknown>,
    }),
    '创建档案',
  )
  check('写入后可读回，昵称折叠空白', created.name === '阿 甲', created.name)
  check('头像保存', created.avatar === '🦊')
  check(
    'AI 偏好只留 provider / model / baseUrl',
    created.ai.provider === 'openai' && created.ai.model === 'deepseek-chat' && !('apiKey' in (created.ai as object)),
    JSON.stringify(created.ai),
  )
  check('密钥绝不进档案（序列化全文都搜不到）', !JSON.stringify(created).includes('sk-should-never-be-stored'))

  const longName = must(store.upsert({ id: pid, name: `${'😀'.repeat(30)}\u0000abc` }), '写超长昵称')
  check(
    `超长昵称按码点截到 ${PROFILE_LIMITS.nameLen} 个字符（emoji 不被劈开）`,
    Array.from(longName.name).length === PROFILE_LIMITS.nameLen,
    `${Array.from(longName.name).length} 个字符`,
  )
  check('控制字符被丢掉', !longName.name.includes('\u0000'))
  check('非法 ID 一律拒绝（不会建出脏档案）', store.upsert({ id: 'x' }) === null && store.get('bad id!') === null)

  /* ---------------- 15.2 战绩与历史 ---------------- */
  const g1 = must(
    store.recordGame(pid, {
      roomCode: 'ABCDE',
      theme: THEME,
      playerCount: 4,
      result: 'win',
      role: '陆维桢',
      isMurderer: false,
    }),
    '记第一局',
  )
  check('第一局胜：games/wins 各 +1', g1.stats.games === 1 && g1.stats.wins === 1 && g1.stats.losses === 0)
  const g2 = must(
    store.recordGame(pid, {
      roomCode: 'FGHIJ',
      theme: '现代·雪山山庄',
      playerCount: 6,
      result: 'lose',
      role: '沈知雪',
      isMurderer: true,
    }),
    '记第二局',
  )
  check(
    '第二局负且是凶手：losses +1、asMurderer +1、murdererWins 不动',
    g2.stats.games === 2 && g2.stats.losses === 1 && g2.stats.asMurderer === 1 && g2.stats.murdererWins === 0,
    JSON.stringify(g2.stats),
  )
  check(
    '对局历史按时间顺序追加（一条一局）',
    g2.history.length === 2 && g2.history[1].roomCode === 'FGHIJ' && g2.history[1].result === 'lose',
  )
  for (let i = 0; i < 40; i += 1) {
    store.recordGame(pid, {
      roomCode: 'ZZZZZ',
      theme: '压力测试',
      playerCount: 4,
      result: i % 2 === 0 ? 'win' : 'lose',
      role: '轮转角色',
      isMurderer: false,
    })
  }
  const capped = must(store.get(pid), '读回含 42 局的档案')
  check(`历史只保留最近 ${PROFILE_LIMITS.historyLen} 局`, capped.history.length === PROFILE_LIMITS.historyLen, `${capped.history.length} 条`)
  check('但累计战绩不丢（42 局）', capped.stats.games === 42, `${capped.stats.games} 局`)

  /* ---------------- 15.3 落盘 / 重启 ---------------- */
  store.flush()
  check('落盘文件存在且是合法 JSON', fs.existsSync(store.filePath) && typeof (JSON.parse(fs.readFileSync(store.filePath, 'utf8')) as { players: Record<string, unknown> }).players[pid] === 'object')
  check('另有 .bak 备份（手滑也能救）', fs.existsSync(path.join(profileDir, 'profiles.json.bak')))
  const reopened = new ProfileStore({ dir: profileDir, quiet: true })
  const back = must(reopened.get(pid), '新实例读到档案')
  check(
    '「重启」后档案仍在：昵称/头像/战绩/历史都对得上',
    back.name === longName.name && back.avatar === '🦊' && back.stats.games === 42 && back.history.length === PROFILE_LIMITS.historyLen,
  )

  /* ---------------- 15.4 坏文件不致命 ---------------- */
  const brokenDir = path.join(root, 'broken')
  fs.mkdirSync(brokenDir, { recursive: true })
  fs.writeFileSync(path.join(brokenDir, 'profiles.json'), '{ this is not json at all')
  const recovered = new ProfileStore({ dir: brokenDir, quiet: true })
  check('档案文件坏了：从空库启动，不抛错', recovered.count() === 0)
  const backups = fs.readdirSync(brokenDir).filter((f) => f.includes('.corrupt-'))
  check('坏文件被改名备份（留证据，不静默丢弃）', backups.length === 1, backups.join(','))
  check('坏文件之后照样能继续写', recovered.upsert({ id: 'after-corrupt-01', name: '新玩家' })?.name === '新玩家')

  /* ---------------- 15.5 HTTP 接口 ---------------- */
  const apiStore = new ProfileStore({ dir: path.join(root, 'api'), quiet: true })
  const api = await serveApi(apiStore)
  try {
    const health = await httpJson(`${api.base}/api/health`)
    check('GET /api/health 正常', health.status === 200 && health.json.ok === true && typeof health.json.profileCount === 'number')

    const put = await httpJson(`${api.base}/api/profile`, {
      method: 'PUT',
      body: {
        id: 'api-player-001',
        name: '档案甲',
        avatar: '🐼',
        ai: { provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://x/v1', apiKey: 'sk-leak-me' },
      },
    })
    check('PUT 建档成功并回显', put.status === 200 && (put.json.profile as { name: string }).name === '档案甲')
    check(
      '客户端发了 apiKey：回报一条警告说明不保存',
      Array.isArray(put.json.warnings) && (put.json.warnings as string[]).some((w) => w.includes('密钥')),
      JSON.stringify(put.json.warnings),
    )

    const got = await httpJson(`${api.base}/api/profile?id=api-player-001`)
    const gotProfile = got.json.profile as { name: string; avatar: string; ai: Record<string, unknown> }
    check('GET 读回同一份档案', got.status === 200 && gotProfile.name === '档案甲' && gotProfile.avatar === '🐼')
    check('接口回包里没有密钥', !got.text.includes('sk-leak-me') && !('apiKey' in (gotProfile.ai ?? {})))

    const nobody = await httpJson(`${api.base}/api/profile?id=never-seen-me-01`)
    check('查不存在的档案：200 + profile:null（不是 500）', nobody.status === 200 && nobody.json.profile === null)
    check('非法 ID → 400', (await httpJson(`${api.base}/api/profile?id=x`)).status === 400)
    check('坏 JSON → 400', (await httpJson(`${api.base}/api/profile`, { method: 'PUT', raw: 'not-json' })).status === 400)
    check(
      '超大请求体 → 413',
      (
        await httpJson(`${api.base}/api/profile`, {
          method: 'PUT',
          body: { id: 'big-player-001', name: 'x'.repeat(PROFILE_LIMITS.bodyBytes + 200) },
        })
      ).status === 413,
    )
    check('未知 /api 路径 → 404', (await httpJson(`${api.base}/api/nope`)).status === 404)
    check('方法不对 → 405', (await httpJson(`${api.base}/api/profile`, { method: 'POST' })).status === 405)
    check('非 /api 路径交回静态处理器', (await httpJson(`${api.base}/index.html`)).text === 'static-fallthrough')

    // 跨域：pnpm dev 时页面在 5273、服务器在 5274，必须能过预检
    const preflight = await httpJson(`${api.base}/api/profile`, { method: 'OPTIONS' })
    check('OPTIONS 预检 → 204（开发时 5273→5274 才不会被浏览器拦）', preflight.status === 204)
    const corsGet = await fetch(`${api.base}/api/health`)
    check(
      '响应带 Access-Control-Allow-Origin（跨域可读）',
      corsGet.headers.get('access-control-allow-origin') === '*' &&
        corsGet.headers.get('cache-control') === 'no-store',
      `${corsGet.headers.get('access-control-allow-origin')} / ${corsGet.headers.get('cache-control')}`,
    )
  } finally {
    await api.close()
  }

  // 限流：单独一个「10 秒 3 次」的窗口
  const rateApi = await serveApi(new ProfileStore({ dir: path.join(root, 'rate'), quiet: true }), {
    windowMs: 60_000,
    max: 3,
  })
  try {
    const codes: number[] = []
    for (let i = 0; i < 5; i += 1) codes.push((await httpJson(`${rateApi.base}/api/health`)).status)
    check('超过窗口上限 → 429（前 3 次 200）', codes.slice(0, 3).every((c) => c === 200) && codes[3] === 429 && codes[4] === 429, codes.join(','))
  } finally {
    await rateApi.close()
  }

  /* ---------------- 15.6 真打一局：服务器结算 → 记战绩 ---------------- */
  const gameDir = path.join(root, 'game')
  const pidA = 'game-player-aaaa01'
  const pidB = 'game-player-bbbb02'
  const pidC = 'game-player-cccc03'
  const pidD = 'game-player-dddd04'
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, dataDir: gameDir })
  const host = new TestClient('甲')
  const guest = new TestClient('乙')
  const third = new TestClient('丙')
  const fourth = new TestClient('丁')
  try {
    await host.connect(srv.wsUrl)
    host.send({
      t: 'create',
      name: '甲',
      playerCount: 4,
      theme: THEME,
      proto: PROTOCOL_VERSION,
      playerId: pidA,
      avatar: '🦊',
    })
    await waitUntil(() => host.hasView, '甲建房')
    const joiners: { client: TestClient; playerId: string; avatar: string }[] = [
      { client: guest, playerId: pidB, avatar: '🐼' },
      { client: third, playerId: pidC, avatar: '🐯' },
      { client: fourth, playerId: pidD, avatar: '🐸' },
    ]
    for (const j of joiners) {
      await j.client.connect(srv.wsUrl)
      j.client.send({
        t: 'join',
        name: j.client.name,
        roomCode: host.view.roomCode,
        proto: PROTOCOL_VERSION,
        playerId: j.playerId,
        avatar: j.avatar,
      })
      await waitUntil(() => j.client.hasView, `${j.client.name} 加入`)
    }
    await waitUntil(() => host.view.seats.length === 4, '四人就位')

    check('入座即建档：昵称 + 头像落库', srv.profiles.get(pidA)?.name === '甲' && srv.profiles.get(pidA)?.avatar === '🦊')
    check('每位客人也各有自己的档案', srv.profiles.get(pidB)?.avatar === '🐼' && srv.profiles.count() === 4, `${srv.profiles.count()} 份`)

    host.send({ t: 'start' })
    await waitUntil(() => host.view.started && host.view.phase === 'reading', '开局进入阅读', 15000)
    const clients = [host, guest, third, fourth]
    host.send({ t: 'advance' })
    await playRound(host, clients, 1)
    await castStrawVotes(host, clients, spreadTargets(clients, 1), 1)
    host.send({ t: 'advance' })
    await playRound(host, clients, 2)
    await castStrawVotes(host, clients, spreadTargets(clients, 2), 2)
    host.send({ t: 'advance' })
    await waitUntil(() => host.view.phase === 'organize', '进入个人整理')
    host.send({ t: 'advance' })
    await waitUntil(() => host.view.phase === 'voting', '进入最终投票')
    const allVoteOne = clients.map(() => host.view.script.roles[0].name)
    await castFinalVotes(host, clients, allVoteOne)

    const reveal = must(host.view.reveal, '复盘数据')
    const winOf = (c: TestClient): boolean =>
      must(
        reveal.settlement.find((r) => r.roleName === c.view.self.roleName),
        '结算行',
      ).win === true
    const pa = must(srv.profiles.get(pidA), '甲方档案')
    check('复盘后每个人的战绩都 +1 局', clients.every((_c, i) => must(srv.profiles.get([pidA, pidB, pidC, pidD][i]), '档案').stats.games === 1))
    check(
      '胜负以服务器结算为准（和复盘页逐人一致）',
      clients.every((c, i) => must(srv.profiles.get([pidA, pidB, pidC, pidD][i]), '档案').stats.wins === (winOf(c) ? 1 : 0)),
      clients.map((c, i) => `${c.name}:${must(srv.profiles.get([pidA, pidB, pidC, pidD][i]), '档案').stats.wins}胜`).join(' '),
    )
    const murdererName = reveal.murdererRoleName
    const murdererProfile = clients.find((c) => c.view.self.roleName === murdererName)
    const mp = murdererProfile ? must(srv.profiles.get([pidA, pidB, pidC, pidD][clients.indexOf(murdererProfile)]), '凶手档案') : null
    check(
      '凶手那一份记了 asMurderer（且只有他一个）',
      srv.profiles.get(pidA)!.stats.asMurderer + srv.profiles.get(pidB)!.stats.asMurderer + srv.profiles.get(pidC)!.stats.asMurderer + srv.profiles.get(pidD)!.stats.asMurderer === 1 &&
        (mp?.stats.asMurderer ?? 0) === 1,
      `凶手=${murdererName}`,
    )
    check(
      '对局历史记下题材 / 人数 / 角色',
      pa.history[0]?.theme === THEME && pa.history[0]?.playerCount === 4 && (pa.history[0]?.result === 'win' || pa.history[0]?.result === 'lose'),
      JSON.stringify(pa.history[0]),
    )
    check('AI 座位不产生档案（只有四个真人）', srv.profiles.count() === 4, `${srv.profiles.count()} 份`)

    // 重复推进不能重复记账
    host.send({ t: 'advance' })
    host.send({ t: 'advance' })
    await sleep(300)
    check('同一局只记一次（重复推进不刷战绩）', srv.profiles.get(pidA)?.stats.games === 1)

    // 重启：内存清空，磁盘恢复
    await srv.close()
    const srv2 = await startServer({ port: 0, host: '127.0.0.1', quiet: true, dataDir: gameDir })
    try {
      check(
        '服务器重启后档案还在（昵称 / 头像 / 战绩）',
        srv2.profiles.get(pidA)?.stats.games === 1 && srv2.profiles.get(pidA)?.avatar === '🦊' && srv2.profiles.get(pidB)?.avatar === '🐼',
        JSON.stringify(srv2.profiles.get(pidA)?.stats),
      )
      const overHttp = await httpJson(`${srv2.httpUrl}api/profile?id=${pidA}`)
      const viaApi = overHttp.json.profile as { stats?: { games?: number }; history?: unknown[] } | null
      check(
        '重启后 HTTP 接口也能读到战绩与历史',
        overHttp.status === 200 && viaApi?.stats?.games === 1 && Array.isArray(viaApi?.history) && viaApi.history.length === 1,
      )
    } finally {
      await srv2.close()
    }
  } finally {
    host.close()
    guest.close()
    third.close()
    fourth.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  // 主用例段也用一个临时档案目录，别把测试数据写进仓库里的 server/data
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmai-main-'))
  const handle = await startServer({ port: 0, host: '127.0.0.1', quiet: true, dataDir })
  const url = handle.wsUrl
  console.log(`房间服务器已在 127.0.0.1:${handle.port} 启动（进程内），开始跑测试……`)

  try {
    await testStatic(handle)
    await testStaticFallback()
    await testIsolation(url)
    await testFullFlow(url)
    await testSearch(url)
    await testAccelerate(url)
    await testRoomCodeAndRejoin(url)
    await testBotsAndPass(url)
    await testPhaseTimeout()
    await testChat(url)
    await testChatIsolation(url)
    await testVoice(url)
    await testVoiceSignal(url)
    await testProtocolVersion(url)
    await testRoomUnit()
    await testTlsArgs()
    await testTlsSoftLanding()
    await testProfiles()
  } finally {
    await handle.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }

  const total = passCount + failCount
  console.log(`\n================ 结果：${passCount} / ${total} 通过 ================`)
  if (failCount > 0) {
    console.log(`失败 ${failCount} 项`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch(async (e) => {
  console.error('测试异常终止：', e instanceof Error ? e.message : e)
  console.error(e)
  process.exit(2)
})