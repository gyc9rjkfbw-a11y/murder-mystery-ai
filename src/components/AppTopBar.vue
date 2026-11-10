<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useNetStore } from '@/stores/net'

const props = withDefaults(
  defineProps<{
    title: string
    sub?: string
    showBack?: boolean
    showSettings?: boolean
  }>(),
  { sub: '', showBack: false, showSettings: false },
)

const router = useRouter()
const net = useNetStore()

/** 联机对局里才出现「牌桌沟通」入口 */
const showTalk = computed(() => net.inRoom)
/** 有人在说话时点一个小金点，不用打开面板也知道桌上正热闹 */
const someoneSpeaking = computed(
  () => net.voicePeers.some((p) => net.speakingOf(p.seatId)) || net.speakingOf('self'),
)

function back() {
  if (window.history.length > 1) router.back()
  else router.push('/')
}
</script>

<template>
  <header class="topbar">
    <button v-if="props.showBack" class="icon-btn" aria-label="返回" @click="back">‹</button>
    <div style="flex: 1; min-width: 0">
      <div class="topbar__title">{{ props.title }}</div>
      <div v-if="props.sub" class="topbar__sub">{{ props.sub }}</div>
    </div>
    <button
      v-if="showTalk"
      class="icon-btn talk-btn"
      :class="{ 'talk-btn--live': net.inVoice }"
      :aria-label="net.inVoice ? '牌桌沟通（已在语音）' : '牌桌沟通'"
      @click="net.openTalk(net.unread ? 'chat' : 'voice')"
    >
      <span aria-hidden="true">{{ net.inVoice ? '🎙' : '💬' }}</span>
      <i v-if="net.unread" class="talk-btn__badge">{{ net.unread > 99 ? '99+' : net.unread }}</i>
      <i v-else-if="someoneSpeaking" class="talk-btn__dot" />
    </button>
    <slot />
    <button
      v-if="props.showSettings"
      class="icon-btn"
      aria-label="设置"
      @click="router.push('/settings')"
    >
      ⚙
    </button>
  </header>
</template>