<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import BrandMark from '@/components/BrandMark.vue'
import InstallBanner from '@/components/InstallBanner.vue'
import { resolveGameEntry } from '@/services/gameNavigation'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { useSettingsStore } from '@/stores/settings'

const router = useRouter()
const game = useGameStore()
const net = useNetStore()
const settings = useSettingsStore()

const gameEntry = computed(() =>
  resolveGameEntry({
    inRoom: net.inRoom,
    onlinePhase: net.phase,
    gamePhase: game.state.phase,
    hasScript: !!game.state.script,
    seatCount: game.state.seats.length,
  }),
)
const hasActiveGame = computed(() => gameEntry.value.active)
const profile = computed(() => settings.profile)

const playerName = computed(() => profile.value?.name || settings.state.playerName)
const avatar = computed(() => profile.value?.avatar || settings.state.avatar)
const gamesPlayed = computed(() => profile.value?.stats.games ?? 0)
const winRate = computed(() => {
  const stats = profile.value?.stats
  return stats && stats.games > 0 ? Math.round((stats.wins / stats.games) * 100) : 0
})

function enterGame() {
  router.push(gameEntry.value.route)
}
</script>

<template>
  <AppTopBar title="谜案剧本杀" show-settings />

  <main class="page home-menu-page">
    <InstallBanner />

    <section class="home-menu-hero">
      <BrandMark class="home-menu-hero__mark" animated label="谜案剧本杀游戏标志" />
      <div class="home-menu-hero__kicker">AN AI MURDER MYSTERY</div>
      <h1>谜案剧本杀</h1>
      <p>NO BODY, NO TRUTH</p>
    </section>

    <section class="home-player">
      <div class="home-player__avatar">{{ avatar }}</div>
      <div class="home-player__info">
        <strong>{{ playerName }}</strong>
        <span>已进行 {{ gamesPlayed }} 局 · 胜率 {{ winRate }}%</span>
      </div>
      <button class="mini-btn" @click="router.push('/me')">档案</button>
    </section>

    <section class="home-menu-actions">
      <button class="home-enter-btn" @click="enterGame">
        <span>{{ hasActiveGame ? '继续对局' : '进入游戏' }}</span>
        <small>{{ hasActiveGame ? '回到当前游戏阶段' : '开始创建或加入一局' }}</small>
      </button>

      <div class="home-menu-secondary">
        <button @click="router.push('/game')">新游戏</button>
        <button @click="router.push('/settings')">设置</button>
      </div>
    </section>

    <p class="home-menu-foot">
      4-6 人剧本杀 · 单机试玩 / 联机房间 / 语音与公屏
    </p>
  </main>
</template>
