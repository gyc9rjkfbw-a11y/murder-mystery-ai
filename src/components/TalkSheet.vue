<script setup lang="ts">
/**
 * 牌桌沟通面板（底部弹层）
 * ==========================================================================
 * 两个 tab：
 *   · 语音通话（默认）—— 开麦后就一直开着，像打电话一样随时插话；
 *   · 公屏打字 —— 不方便开麦时的备选（陈述阶段打字完全算数）。
 *
 * 为什么默认停在语音：剧本杀的对质基本都是靠嘴，打字只是兜底。
 * 但如果当前地址调不了麦克风（http 页面），面板会把原因说清楚并把人引导到打字。
 */
import { computed } from 'vue'
import { useNetStore } from '@/stores/net'
import ChatPanel from '@/components/ChatPanel.vue'

const net = useNetStore()

/** AI 不参与语音，列表里只列真人 */
const humans = computed(() => (net.view?.seats ?? []).filter((s) => !s.isBot))
const botCount = computed(() => (net.view?.seats ?? []).filter((s) => s.isBot).length)
const onMicCount = computed(() => net.voiceCount)
/** 还没开麦的真人（用来提示「他们可以打字」） */
const notOnMic = computed(() =>
  humans.value.filter((s) => !net.voicePeers.some((v) => v.seatId === s.seatId)),
)

function avatarText(name: string): string {
  return (name || '?').trim().slice(0, 1)
}

function statusText(seatId: string): string {
  const peer = net.voicePeers.find((v) => v.seatId === seatId)
  if (!peer) return '未开麦'
  if (peer.muted) return '已静音'
  const st = net.peerStateOf(seatId)
  if (st === 'connecting') return '连接中…'
  if (st === 'failed') return '连不上'
  return '在麦上'
}

/** 有人的连接失败了，多半是网络环境问题 —— 给一句能动手排查的话 */
const anyFailed = computed(() =>
  net.voicePeers.some((p) => p.seatId !== net.seatId && net.peerStateOf(p.seatId) === 'failed'),
)

async function toggleMic() {
  if (net.inVoice) net.leaveVoice()
  else await net.joinVoice()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="net.talkOpen" class="sheet-mask" @click.self="net.closeTalk()">
      <section class="sheet talk">
        <div class="sheet__grip" />

        <header class="talk__head">
          <div>
            <div class="talk__title">牌桌沟通</div>
            <div class="talk__sub">
              语音 {{ onMicCount }} 人在麦上<span v-if="botCount"> · {{ botCount }} 个 AI 不参与语音</span>
            </div>
          </div>
          <button class="icon-btn" aria-label="关闭" @click="net.closeTalk()">✕</button>
        </header>

        <div class="talk-tabs" role="tablist">
          <button
            class="talk-tab"
            :class="{ 'talk-tab--on': net.talkTab === 'voice' }"
            role="tab"
            :aria-selected="net.talkTab === 'voice'"
            @click="net.setTalkTab('voice')"
          >
            🎙 语音通话<em v-if="onMicCount"> {{ onMicCount }}</em>
          </button>
          <button
            class="talk-tab"
            :class="{ 'talk-tab--on': net.talkTab === 'chat' }"
            role="tab"
            :aria-selected="net.talkTab === 'chat'"
            @click="net.setTalkTab('chat')"
          >
            💬 公屏打字<em v-if="net.unread"> {{ net.unread }}</em>
          </button>
        </div>

        <!-- ============ 语音 ============ -->
        <div v-if="net.talkTab === 'voice'" class="talk__body">
          <!-- 这个地址根本调不了麦克风：说清原因，并把人推去打字 -->
          <div v-if="!net.canVoice" class="talk-note talk-note--warn">
            <strong>当前地址不允许浏览器用麦克风。</strong>
            <p>
              浏览器只在 <b>https</b> 或 <b>localhost</b> 下放行麦克风；现在这个 http:// 局域网地址拿不到权限，
              和手机型号无关。两个办法：
            </p>
            <p>① 用 https 地址重新打开（见下面「怎么开语音」）；② 直接切到「公屏打字」——陈述阶段打字也一样算你的发言。</p>
            <button class="btn btn--ghost" @click="net.setTalkTab('chat')">去打字 →</button>
          </div>

          <template v-else>
            <div class="talk-actions">
              <button
                class="btn"
                :class="net.inVoice ? 'btn--blood' : ''"
                @click="toggleMic"
              >
                {{ net.inVoice ? '退出通话' : '开麦加入通话' }}
              </button>
              <button v-if="net.inVoice" class="btn btn--ghost" @click="net.toggleMute()">
                {{ net.inVoice && net.mutedSeats.includes(net.seatId) ? '取消静音' : '静音' }}
              </button>
            </div>

            <!-- 手机上首次自动播放常被拦，给一个明确的按钮 -->
            <button v-if="net.autoplayBlocked" class="talk-note talk-note--warn" @click="net.primeVoiceAudio()">
              浏览器拦住了声音 · 点这里开启
            </button>

            <p v-if="net.voiceError" class="talk-note talk-note--err">{{ net.voiceError }}</p>
            <p v-else-if="net.inVoice" class="talk-note">
              你已在麦上{{ net.mutedSeats.includes(net.seatId) ? '（当前静音）' : '' }}。说话时头像会亮起来，
              别人不用按键就能听到你。
            </p>
          </template>

          <ul class="talk-people">
            <li
              v-for="s in humans"
              :key="s.seatId"
              class="talk-person"
              :class="{
                'talk-person--up': net.voicePeers.some((v) => v.seatId === s.seatId),
                'talk-person--speaking': net.speakingOf(s.seatId),
              }"
            >
              <span class="talk-person__avatar">
                {{ avatarText(s.name) }}
                <i v-if="net.speakingOf(s.seatId)" class="talk-person__wave" />
              </span>
              <span class="talk-person__name">
                {{ s.name }}<em v-if="s.seatId === net.seatId">（我）</em>
              </span>
              <span class="talk-person__state">{{ statusText(s.seatId) }}</span>
            </li>
          </ul>

          <p v-if="notOnMic.length" class="talk-note">
            {{ notOnMic.map((s) => s.name).join('、') }} 还没开麦 —— 他们可以在「公屏打字」里发言。
          </p>

          <!-- 语音是 P2P 直连，打不通基本都是网络环境问题，这里给出可执行的两条排查 -->
          <p v-if="anyFailed" class="talk-note talk-note--warn">
            有人的语音连不上（P2P 打不通）。常见原因：路由器的「AP 隔离 / 客户端隔离」把设备之间的
            互访挡住了，或者大家不在同一个网段。让 TA 改用「公屏打字」，或先关掉路由器的隔离再试。
          </p>

          <p class="talk-foot">
            语音是端到端加密的 P2P 直连（同一 Wi-Fi 下直连），房间服务器只转发连接信息，
            <b>不听、不存、不录音</b>。
          </p>
        </div>

        <!-- ============ 打字 ============ -->
        <ChatPanel
          v-else
          :messages="net.chats"
          :my-seat-id="net.seatId"
          :disabled="!net.connected"
          @send="net.sendChat"
        />
      </section>
    </div>
  </Teleport>
</template>