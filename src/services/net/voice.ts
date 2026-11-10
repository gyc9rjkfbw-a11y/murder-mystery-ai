/**
 * 实时语音通话（WebRTC 全网状 / mesh）
 * ==========================================================================
 * 目标：像打电话一样一直开着麦，方便剧本杀里随时插话对质。
 *
 * 三个必须讲清楚的设计决定：
 *
 * 1. **服务器不碰音频**。房间服务器只转发信令（SDP / ICE），音频走端到端加密
 *    的 P2P 通道；服务器上没有 SFU/MCU、不录音、不落盘。一桌最多 6 人，
 *    全网状是 15 条连接，手机上完全撑得住；再大就必须上 SFU 了。
 *
 * 2. **谁发 offer 是确定性的**：座位号小的那一方发。
 *    两边都按同一条规则算，所以不会同时发 offer 打架（glare）。
 *    收到 offer 时如果还没有对应连接，就现场补建 —— 这样即使对方的
 *    `view.voice` 比信令晚到一步，流程也不会断。
 *
 * 3. **必须安全上下文**：浏览器只在 https / localhost 下给麦克风
 *    （`navigator.mediaDevices` 在 http 页面上根本不存在）。
 *    所以本文件所有入口都先查 `micSupported()`，不支持时由 UI 引导
 *    「改用打字」。见 README「语音通话」一节。
 *
 * 本文件是**纯前端**模块，只能在浏览器里跑（不参与 Node 服务器打包）。
 */

import type { VoicePeer, VoiceSignal } from './protocol'
import { micSupported } from './netClient'

export type PeerState = 'connecting' | 'live' | 'failed'

/** 说话高亮的阈值：RMS 超过它就算「正在说话」（经验值，太低会被环境噪声点亮） */
const SPEAK_LEVEL = 0.055

/**
 * ICE 服务器：**默认留空**。
 * 同一 Wi-Fi 下靠 host 候选就能直连，配一个连不上的 STUN 反而会拖慢建连
 * （要等超时）。要跨网络玩，用 `VITE_STUN` 或 `localStorage.dsh_voice_stun`
 * 指定，例如 `stun:stun.l.google.com:19302`；真要穿透对称 NAT 还得上 TURN。
 */
function iceServers(): RTCIceServer[] {
  const raw =
    (import.meta.env.VITE_STUN as string | undefined) ||
    (typeof localStorage !== 'undefined' ? localStorage.getItem('dsh_voice_stun') || '' : '')
  return raw ? [{ urls: raw.split(',').map((s) => s.trim()).filter(Boolean) }] : []
}

export interface VoiceHooks {
  /** 把信令交给网络层发出去 */
  signal: (toSeatId: string, data: VoiceSignal) => void
  /** 状态有变化（连接数 / 谁在说话 / 是否被浏览器拦了自动播放） */
  change: () => void
  /** 给用户看的一句话错误 */
  error: (text: string) => void
}

/** 把浏览器的错误翻译成人话 */
function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝。手机浏览器地址栏里可以重新允许，或改用打字。'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没找到麦克风设备（插上耳机试试），也可以改用打字。'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被别的程序占用了（比如正在打电话），先关掉它再试。'
  }
  if (name === 'OverconstrainedError') return '麦克风不支持当前的音频参数，试试换一台设备。'
  return `麦克风打不开：${(e as Error)?.message || name || '未知原因'}`
}

export class VoiceRoom {
  /** 我的座位号（由 store 注入） */
  mySeatId = ''
  /** 我是否已经加入语音（本地状态，服务端另有 view.voice） */
  joined = false
  /** 我是否静音 */
  muted = false
  /** 自动播放被浏览器拦住了（需要用户点一下才出声） */
  autoplayBlocked = false

  private hooks: VoiceHooks
  private localStream: MediaStream | null = null
  private pcs = new Map<string, RTCPeerConnection>()
  private streams = new Map<string, MediaStream>()
  private els = new Map<string, HTMLAudioElement>()
  private retries = new Map<string, number>()
  /** 远端描述还没设好时先攒着 ICE，否则 addIceCandidate 会抛错 */
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()

  private ctx: AudioContext | null = null
  private analysers = new Map<string, AnalyserNode>()
  private meterTimer = 0
  private speaking = new Map<string, boolean>()
  private meterBuf = new Uint8Array(256)

  constructor(hooks: VoiceHooks) {
    this.hooks = hooks
  }

  static supported(): boolean {
    return (
      micSupported() &&
      typeof RTCPeerConnection !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia
    )
  }

  /** 是否正在跟某个座位通话（UI 显示用） */
  stateOf(seatId: string): PeerState | null {
    const pc = this.pcs.get(seatId)
    if (!pc) return null
    if (pc.connectionState === 'connected') return 'live'
    if (pc.connectionState === 'failed') return 'failed'
    return 'connecting'
  }

  /** 谁正在说话（只有 true 的会在 UI 里点亮） */
  isSpeaking(seatId: string): boolean {
    return this.speaking.get(seatId) === true
  }

  /** 我自己正在说话（麦克风音量过阈值，且没静音） */
  get selfSpeaking(): boolean {
    return this.speaking.get('__self__') === true
  }

  /** 已经连通的人数（不含自己） */
  get liveCount(): number {
    let n = 0
    for (const pc of this.pcs.values()) if (pc.connectionState === 'connected') n += 1
    return n
  }

  /**
   * 连接诊断：每条连接的收发字节/包数与状态。
   * 自检脚本用它证明「语音真的通了」（收到过 RTP 包），
   * 界面上也可以用它显示「连接质量差」。
   */
  async stats(): Promise<
    { seatId: string; connection: string; packetsReceived: number; bytesReceived: number; packetsSent: number }[]
  > {
    const out: {
      seatId: string
      connection: string
      packetsReceived: number
      bytesReceived: number
      packetsSent: number
    }[] = []
    for (const [seatId, pc] of this.pcs) {
      let packetsReceived = 0
      let bytesReceived = 0
      let packetsSent = 0
      try {
        const report = await pc.getStats()
        report.forEach((s) => {
          const r = s as unknown as {
            type?: string
            kind?: string
            packetsReceived?: number
            bytesReceived?: number
            packetsSent?: number
          }
          if (r.type === 'inbound-rtp' && (r.kind === 'audio' || r.kind === undefined)) {
            packetsReceived += r.packetsReceived ?? 0
            bytesReceived += r.bytesReceived ?? 0
          }
          if (r.type === 'outbound-rtp' && r.kind === 'audio') packetsSent += r.packetsSent ?? 0
        })
      } catch {
        /* 连接已关掉时 getStats 会抛，忽略 */
      }
      out.push({ seatId, connection: pc.connectionState, packetsReceived, bytesReceived, packetsSent })
    }
    return out
  }

  /* ---------------------------------------------------------------- *
   * 进出房间
   * ---------------------------------------------------------------- */

  /** 开麦：拿本地流 → 通知服务器 voice-join（由 store 做）→ 再按 view.voice 连线 */
  async join(): Promise<boolean> {
    if (!VoiceRoom.supported()) {
      this.hooks.error('这个浏览器/地址不允许调麦克风，先用文字聊：https 打开或换台设备。')
      return false
    }
    if (this.joined && this.localStream) return true
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      })
    } catch (e) {
      this.hooks.error(micErrorMessage(e))
      return false
    }
    this.joined = true
    this.attachMeter('__self__', this.localStream)
    this.applyMute()
    // 先给本地流建好分析器（自己说话也要亮），再等 view 里的人来连
    this.startMeter()
    this.hooks.change()
    return true
  }

  /** 收麦：告诉所有人再见，拆掉全部连接，释放麦克风 */
  leave(notifyPeers = true) {
    if (notifyPeers) {
      for (const seatId of this.pcs.keys()) this.hooks.signal(seatId, { kind: 'bye' })
    }
    this.teardownAll()
    this.localStream?.getTracks().forEach((t) => t.stop())
    this.localStream = null
    this.joined = false
    this.stopMeter()
    this.hooks.change()
  }

  setMuted(muted: boolean) {
    this.muted = muted
    this.applyMute()
    this.hooks.change()
  }

  private applyMute() {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !this.muted
    })
    if (this.muted) {
      this.speaking.set('__self__', false)
    }
  }

  /**
   * 根据服务端下发的「谁在语音里」对齐连接。
   * 每次收到 view 都调用一次：多了就连、少了就拆、谁静音了只影响显示。
   */
  syncPeers(peers: VoicePeer[], mySeatId: string) {
    this.mySeatId = mySeatId
    if (!this.joined) return
    const want = new Set(peers.filter((p) => p.seatId !== mySeatId).map((p) => p.seatId))
    // 拆掉已经不在语音里的人
    for (const seatId of [...this.pcs.keys()]) {
      if (!want.has(seatId)) this.teardown(seatId)
    }
    // 连上新来的人：座位号小的那一方发 offer（两端口径一致，不会打架）
    for (const seatId of want) {
      if (this.pcs.has(seatId)) continue
      if (this.mySeatId && this.mySeatId < seatId) void this.offerTo(seatId)
      else this.ensurePc(seatId) // 等对方的 offer，但先把连接壳建好
    }
  }

  /** 收到别人转来的信令 */
  async handleSignal(fromSeatId: string, data: VoiceSignal) {
    if (!this.joined) return
    if (data.kind === 'bye') {
      this.teardown(fromSeatId)
      return
    }
    const pc = this.ensurePc(fromSeatId)
    try {
      if (data.kind === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
        await this.flushIce(fromSeatId, pc)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        this.hooks.signal(fromSeatId, { kind: 'answer', sdp: answer.sdp ?? '' })
      } else if (data.kind === 'answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
        await this.flushIce(fromSeatId, pc)
      } else if (data.kind === 'ice') {
        if (!data.candidate) return
        const cand: RTCIceCandidateInit = {
          candidate: data.candidate,
          sdpMid: data.sdpMid,
          sdpMLineIndex: data.sdpMLineIndex,
        }
        if (!pc.remoteDescription) {
          const q = this.pendingIce.get(fromSeatId) ?? []
          q.push(cand)
          this.pendingIce.set(fromSeatId, q)
        } else {
          await pc.addIceCandidate(cand)
        }
      }
    } catch (e) {
      // 单条信令失败不该毁掉整场通话：记一笔，让 UI 显示「连接中」，
      // 下一轮 syncPeers 或对端重试会把它救回来。
      this.hooks.error(`与 ${fromSeatId} 的语音信令出错：${(e as Error).message}`)
    }
  }

  /** 浏览器拦住自动播放时，让用户点一下按钮把声音放出来 */
  async primeAudio() {
    try {
      await this.ctx?.resume()
    } catch {
      /* 忽略：resume 失败不影响后续操作 */
    }
    this.autoplayBlocked = false
    for (const el of this.els.values()) {
      try {
        await el.play()
      } catch {
        this.autoplayBlocked = true
      }
    }
    this.hooks.change()
  }

  dispose() {
    this.leave(false)
    try {
      void this.ctx?.close()
    } catch {
      /* 关不掉就算了，页面要走了 */
    }
    this.ctx = null
  }

  /* ---------------------------------------------------------------- *
   * 内部：连接
   * ---------------------------------------------------------------- */

  private ensurePc(seatId: string): RTCPeerConnection {
    const existing = this.pcs.get(seatId)
    if (existing) return existing

    const pc = new RTCPeerConnection({ iceServers: iceServers() })
    this.pcs.set(seatId, pc)

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream)
    }

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return
      this.hooks.signal(seatId, {
        kind: 'ice',
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid ?? null,
        sdpMLineIndex: ev.candidate.sdpMLineIndex ?? null,
      })
    }

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track])
      this.streams.set(seatId, stream)
      const el = this.ensureAudioEl(seatId)
      el.srcObject = stream
      void el.play().catch(() => {
        // 手机上首次播放常常需要一次用户手势
        this.autoplayBlocked = true
        this.hooks.change()
      })
      this.attachMeter(seatId, stream)
      this.startMeter()
      this.hooks.change()
    }

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') {
        this.retries.set(seatId, 0)
        this.hooks.change()
        return
      }
      if (st === 'failed') {
        this.retry(seatId)
        return
      }
      // disconnected 常常只是抖动，给它 6 秒自己恢复；还是不行就重连
      if (st === 'disconnected') {
        window.setTimeout(() => {
          if (this.pcs.get(seatId) === pc && pc.connectionState === 'disconnected') this.retry(seatId)
        }, 6000)
      }
      this.hooks.change()
    }

    this.hooks.change()
    return pc
  }

  private async offerTo(seatId: string) {
    const pc = this.ensurePc(seatId)
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true })
      await pc.setLocalDescription(offer)
      this.hooks.signal(seatId, { kind: 'offer', sdp: offer.sdp ?? '' })
    } catch (e) {
      this.hooks.error(`发起语音连接失败：${(e as Error).message}`)
    }
  }

  /** 断线重连：最多重试 2 次，之后交给 UI 显示「连接失败」 */
  private retry(seatId: string) {
    const n = (this.retries.get(seatId) ?? 0) + 1
    this.retries.set(seatId, n)
    this.teardown(seatId, false)
    if (n > 2) {
      this.hooks.change()
      return
    }
    if (this.mySeatId && this.mySeatId < seatId) void this.offerTo(seatId)
    else this.ensurePc(seatId)
    this.hooks.change()
  }

  private async flushIce(seatId: string, pc: RTCPeerConnection) {
    const q = this.pendingIce.get(seatId)
    if (!q?.length) return
    this.pendingIce.delete(seatId)
    for (const c of q) {
      try {
        await pc.addIceCandidate(c)
      } catch {
        /* 过期候选丢掉即可 */
      }
    }
  }

  private teardown(seatId: string, notify = false) {
    if (notify) this.hooks.signal(seatId, { kind: 'bye' })
    const pc = this.pcs.get(seatId)
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      try {
        pc.close()
      } catch {
        /* 已关闭 */
      }
    }
    this.pcs.delete(seatId)
    this.pendingIce.delete(seatId)
    this.streams.delete(seatId)
    const el = this.els.get(seatId)
    if (el) {
      el.srcObject = null
      el.remove()
      this.els.delete(seatId)
    }
    const an = this.analysers.get(seatId)
    if (an) {
      try {
        an.disconnect()
      } catch {
        /* 忽略 */
      }
      this.analysers.delete(seatId)
    }
    if (this.speaking.delete(seatId)) this.hooks.change()
  }

  private teardownAll() {
    for (const seatId of [...this.pcs.keys()]) this.teardown(seatId)
    this.retries.clear()
    this.speaking.clear()
    const an = this.analysers.get('__self__')
    an?.disconnect()
    this.analysers.delete('__self__')
  }

  private ensureAudioEl(seatId: string): HTMLAudioElement {
    const found = this.els.get(seatId)
    if (found) return found
    const el = document.createElement('audio')
    el.autoplay = true
    el.setAttribute('playsinline', 'true')
    // 不放进文档在某些移动浏览器上不出声；用 0 尺寸而不是 display:none。
    el.style.position = 'fixed'
    el.style.width = '0'
    el.style.height = '0'
    el.style.opacity = '0'
    el.style.pointerEvents = 'none'
    el.dataset.seat = seatId
    document.body.appendChild(el)
    this.els.set(seatId, el)
    return el
  }

  /* ---------------------------------------------------------------- *
   * 内部：说话高亮（音量表）
   * ---------------------------------------------------------------- */

  private attachMeter(key: string, stream: MediaStream) {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.ctx = new Ctor()
    }
    try {
      const src = this.ctx.createMediaStreamSource(stream)
      const an = this.ctx.createAnalyser()
      an.fftSize = 512
      src.connect(an) // **不**接 destination，否则自己的声音会被放出来形成回授
      const old = this.analysers.get(key)
      old?.disconnect()
      this.analysers.set(key, an)
    } catch {
      /* 分析器建不起来不影响通话本身 */
    }
  }

  private startMeter() {
    if (this.meterTimer) return
    // 约 8 帧/秒：足够点亮「正在说话」，又不会让 Vue 一直重渲染
    this.meterTimer = window.setInterval(() => this.tickMeter(), 120)
  }

  private stopMeter() {
    if (!this.meterTimer) return
    window.clearInterval(this.meterTimer)
    this.meterTimer = 0
  }

  private tickMeter() {
    let changed = false
    for (const [key, an] of this.analysers) {
      an.getByteTimeDomainData(this.meterBuf)
      let sum = 0
      for (let i = 0; i < this.meterBuf.length; i += 1) {
        const v = (this.meterBuf[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / this.meterBuf.length)
      const speaking = rms > SPEAK_LEVEL && !(key === '__self__' && this.muted)
      if (this.speaking.get(key) !== speaking) {
        this.speaking.set(key, speaking)
        changed = true
      }
    }
    // 只在「有人开始/停止说话」的那一帧通知 Vue，别 8 次/秒 地重渲染
    if (changed) this.hooks.change()
  }
}