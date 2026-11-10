<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GameBottomNav from '@/components/GameBottomNav.vue'
import LaunchIntro from '@/components/LaunchIntro.vue'
import ToastHost from '@/components/ToastHost.vue'
import TalkSheet from '@/components/TalkSheet.vue'
import { PHASE_ROUTE } from '@/services/net/protocol'
import { gameNavVisible } from '@/services/gameNavigation'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { useSettingsStore } from '@/stores/settings'

/**
 * 联机时的「阶段跟随」：
 * 服务器一改阶段（例如进入第 2 轮陈述、进入投票），所有客户端都要跟着跳到对应页面。
 * 放在 App 里做，是因为它只跑一次，且不依赖任何具体页面。
 *
 * ★ 同时监听 inRoom：`net.phase` 在还没进房间时默认就是 'room'（等待厅），
 *   而进房那一刻 phase 值并没有「变化」（一直是 room），
 *   只听 phase 会导致「建房/加入后停在首页」，所以必须把 inRoom 一起听。
 */
const net = useNetStore()
const game = useGameStore()
const settings = useSettingsStore()
const router = useRouter()
const route = useRoute()
const hasGameNav = computed(() =>
  gameNavVisible(route.name as string | undefined, !!game.state.script),
)

/**
 * 启动时同步一次「我的档案」：
 * 换设备 / 清了缓存的人，昵称头像与战绩能自动接回来；
 * 服务器没开时静默失败（fetchProfile 内部已兜住），单机玩法完全不受影响。
 */
onMounted(() => {
  void settings.refreshProfile()
})

watch(
  () => [net.inRoom, net.phase] as const,
  ([inRoom, phase]) => {
    if (!net.active || !inRoom) return
    const target = PHASE_ROUTE[phase]
    if (target && route.name !== target) router.replace({ name: target })
  },
  { immediate: true },
)
</script>

<template>
  <div class="shell" :class="{ 'shell--game-nav': hasGameNav }">
    <router-view v-slot="{ Component }">
      <Transition name="route" mode="out-in">
        <div :key="route.path" class="route-view">
          <component :is="Component" />
        </div>
      </Transition>
    </router-view>
    <!-- 牌桌沟通（语音 + 公屏）：只挂一份，入口在 AppTopBar 上；内部用 Teleport 到 body -->
    <TalkSheet v-if="net.inRoom" />
    <GameBottomNav />
    <ToastHost />
    <LaunchIntro />
  </div>
</template>
