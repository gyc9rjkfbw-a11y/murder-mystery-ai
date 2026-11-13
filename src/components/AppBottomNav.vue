<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SheetModal from '@/components/SheetModal.vue'
import {
  navTabForRoute,
  resolveGameEntry,
  type AppNavItem,
} from '@/services/gameNavigation'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { useSettingsStore } from '@/stores/settings'

const route = useRoute()
const router = useRouter()
const game = useGameStore()
const net = useNetStore()
const settings = useSettingsStore()
const socialOpen = ref(false)

const items: { key: AppNavItem; label: string; icon: string }[] = [
  { key: 'home', label: '首页', icon: '家' },
  { key: 'game', label: '游戏', icon: '局' },
  { key: 'social', label: '社交/消息', icon: '讯' },
  { key: 'mine', label: '我的', icon: '我' },
]

const routeTab = computed(() => navTabForRoute(route.name as string | undefined))
const activeTab = computed<AppNavItem | null>(() =>
  net.talkOpen || socialOpen.value ? 'social' : routeTab.value,
)
const profile = computed(() => settings.profile)

function goHome() {
  router.push('/')
}

function goGame() {
  router.push(
    resolveGameEntry({
      inRoom: net.inRoom,
      onlinePhase: net.phase,
      gamePhase: game.state.phase,
      hasScript: !!game.state.script,
      seatCount: game.state.seats.length,
    }).route,
  )
}

function goSocial() {
  if (net.inRoom) {
    net.openTalk(net.unread ? 'chat' : 'voice')
    return
  }
  socialOpen.value = true
}

function goMine() {
  router.push('/me')
}

function select(item: AppNavItem) {
  if (item !== 'social') socialOpen.value = false
  if (item === 'home') goHome()
  else if (item === 'game') goGame()
  else if (item === 'social') goSocial()
  else goMine()
}

function goStart() {
  socialOpen.value = false
  router.push('/')
}
</script>

<template>
  <nav class="game-bottom-nav app-bottom-nav" aria-label="主导航">
    <button
      v-for="item in items"
      :key="item.key"
      class="game-nav-btn"
      :class="{
        'game-nav-btn--active': activeTab === item.key,
        'game-nav-btn--social': item.key === 'social',
      }"
      :aria-label="item.label"
      :aria-current="activeTab === item.key ? 'page' : undefined"
      @click="select(item.key)"
    >
      <span class="game-nav-btn__icon" aria-hidden="true">{{ item.icon }}</span>
      <span class="game-nav-btn__label">{{ item.label }}</span>
      <i v-if="item.key === 'social' && net.unread" class="game-nav-btn__badge">
        {{ net.unread > 99 ? '99+' : net.unread }}
      </i>
      <i v-else-if="item.key === 'social' && net.inVoice" class="game-nav-btn__live" />
    </button>
  </nav>

  <SheetModal :open="socialOpen" title="社交与消息" @close="socialOpen = false">
    <div class="social-empty">
      <div class="social-empty__avatar">{{ profile?.avatar || settings.state.avatar || '🎭' }}</div>
      <h4>{{ profile?.name || settings.state.playerName }}</h4>
      <p v-if="profile">
        已玩 {{ profile.stats.games }} 局 · 胜率
        {{ profile.stats.games ? Math.round((profile.stats.wins / profile.stats.games) * 100) : 0 }}%
      </p>
      <p v-else>当前没有进行中的联机房间。</p>
      <div class="social-empty__note">
        进入联机房间后，这里会直接打开语音通话与公屏消息。
      </div>
      <button class="btn btn--primary" @click="goStart">创建或加入房间</button>
    </div>
  </SheetModal>
</template>
