<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import BrandMark from '@/components/BrandMark.vue'
import { THREE_STEP_PIPELINE } from '@/services/offlineEngine'
import { useGameStore } from '@/stores/game'
import { useSettingsStore } from '@/stores/settings'

const router = useRouter()
const game = useGameStore()
const settings = useSettingsStore()

const progress = computed(() => game.generating.progress)
const steps = computed(() => {
  const total = progress.value?.totalSteps ?? THREE_STEP_PIPELINE.length
  return Array.from({ length: total }, (_, i) => ({
    index: i,
    label: THREE_STEP_PIPELINE[i] ?? `第 ${i + 1} 步`,
  }))
})

const isError = computed(() => game.generating.error.length > 0)
const isBusy = computed(() => game.generating.busy && !isError.value)
/** 联机模式下剧本由房间服务器生成，这个页面只负责「等」，不显示本地引擎的三步进度 */
const isOnline = computed(() => game.state.online)
/**
 * 人数取座位表（两种模式都准），题材优先取服务器已下发的剧本配置。
 * 联机时本地 setup 可能是上一局单机留下的（甚至为空），直接显示会误导。
 */
const shownCount = computed(() => game.state.seats.length || game.setup.playerCount)
const shownTheme = computed(
  () => game.state.script?.game_config?.theme || game.setup.theme || '随房间而定',
)

onMounted(() => {
  if (game.state.seats.length === 0) {
    router.replace('/')
    return
  }
  // 联机时 dealScript() 内部会直接返回（服务器生成后下发），这里只是保持调用点一致
  if (!game.state.script && !game.generating.busy) {
    void game.dealScript()
  }
})

// 剧本就绪后自动进入阅读环节
watch(
  () => game.state.phase,
  (p) => {
    if (p === 'reading') router.replace('/reading')
  },
)

function retry() {
  void game.dealScript()
}

function backToRoom() {
  game.generating.error = ''
  game.generating.detail = []
  game.setPhase('room')
  router.replace('/room')
}

function gotoLocal() {
  // 生成失败时，直接用离线引擎兜底，保证流程不中断
  settings.state.ai.provider = 'offline'
  void game.dealScript()
}

function gotoSettings() {
  router.push('/settings')
}
</script>

<template>
  <AppTopBar title="剧本下发" sub="AI 剧本生成引擎" show-back />

  <main class="page">
    <section v-if="!isError" class="case-loader">
      <div class="case-loader__stage" aria-hidden="true">
        <div class="case-loader__card case-loader__card--back">
          <span>EVIDENCE</span>
          <i /><i /><i />
        </div>
        <div class="case-loader__card case-loader__card--mid">
          <span>CASE FILE</span>
          <i /><i />
        </div>
        <div class="case-loader__card case-loader__card--front">
          <span class="case-loader__stamp">CONFIDENTIAL</span>
          <BrandMark class="case-loader__mark" animated />
          <span class="case-loader__no">CASE · {{ shownCount }} · {{ game.state.roomCode || 'LOCAL' }}</span>
        </div>
        <span class="case-loader__scan" />
        <span class="case-loader__chip case-loader__chip--one">时间线</span>
        <span class="case-loader__chip case-loader__chip--two">证词</span>
        <span class="case-loader__chip case-loader__chip--three">物证</span>
      </div>

      <div class="case-loader__copy">
        <p class="case-loader__kicker">{{ isOnline ? 'ROOM SERVER' : 'BUILDING THE CASE' }}</p>
        <h3 class="case-loader__title">
          {{ isOnline ? '正在整理这一局' : '正在生成这一局' }}
        </h3>
        <p class="case-loader__meta">
          题材「{{ shownTheme }}」· {{ shownCount }} 人 ·
          {{ isOnline ? '全桌共用同一份剧本' : settings.providerLabel }}
        </p>
      </div>

      <div v-if="!isOnline" class="pipeline">
        <div
          v-for="s in steps"
          :key="s.index"
          class="pipeline__step"
          :class="{
            'pipeline__step--on': progress?.step === s.index + 1,
            'pipeline__step--done': (progress?.step ?? 0) > s.index + 1,
          }"
        >
          <div class="pipeline__dot">
            {{ (progress?.step ?? 0) > s.index + 1 ? '✓' : s.index + 1 }}
          </div>
          <div>
            <div style="font-size: 13px">{{ s.label }}</div>
          </div>
        </div>
      </div>

      <p class="case-loader__hint">
        {{
          isOnline
            ? '剧本由房间服务器生成，好了会自动带你进阅读页。'
            : '采用「全局统筹 + 逐个生成」的三步生成法，避免一次性生成导致内容缩水。'
        }}
      </p>
    </section>

    <section v-else class="card">
      <h3 class="card__title" style="color: #ef8a7c">生成失败</h3>
      <p class="small dim" style="margin: 0 0 10px">{{ game.generating.error }}</p>
      <div v-if="game.generating.detail.length" class="card card--flat" style="margin: 0 0 12px">
        <div v-for="(d, i) in game.generating.detail" :key="i" class="tiny muted">
          · {{ d }}
        </div>
      </div>
      <button class="btn btn--primary" @click="gotoLocal">改用离线引擎，先开这一局</button>
      <div class="btn-row">
        <button class="btn btn--ghost" @click="retry">再试一次</button>
        <button class="btn btn--ghost" @click="gotoSettings">去设置</button>
      </div>
      <button class="btn btn--ghost" style="width: 100%" @click="backToRoom">返回房间</button>
      <p class="card__hint" style="margin-top: 10px">
        离线引擎是内置的，不联网也能生成，任何一局都能开起来。
      </p>
    </section>

    <p v-if="isBusy" class="empty">请勿退出，这一步大约需要几秒钟</p>
  </main>
</template>
