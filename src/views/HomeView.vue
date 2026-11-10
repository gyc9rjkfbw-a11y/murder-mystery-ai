<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import BrandMark from '@/components/BrandMark.vue'
import InstallBanner from '@/components/InstallBanner.vue'
import { useToast } from '@/composables/useToast'
import { PRESET_THEMES } from '@/services/templates'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { randomNickname, useSettingsStore } from '@/stores/settings'

const router = useRouter()
const game = useGameStore()
const net = useNetStore()
const settings = useSettingsStore()
const toast = useToast()

const playerCount = ref(5)
const theme = ref(PRESET_THEMES[0].theme)
const joinCode = ref('')
const showJoin = ref(false)
const myName = ref(settings.state.playerName)
const showSolo = ref(false)

const counts = [
  { n: 4, label: '紧凑' },
  { n: 5, label: '均衡' },
  { n: 6, label: '丰满' },
]

const providerText = computed(() => settings.providerLabel)

function pickTheme(t: string) {
  theme.value = t
}

function saveName() {
  // 清空昵称时给个随机名，别让两台设备都叫「我」
  const n = myName.value.trim() || randomNickname()
  settings.state.playerName = n
  myName.value = n
  return n
}

function createOnline() {
  if (!theme.value.trim()) {
    toast.warn('先给这局定个题材')
    return
  }
  net.createRoom(saveName(), playerCount.value, theme.value.trim())
  router.push('/lobby')
}

function joinOnline() {
  const code = joinCode.value.trim().toUpperCase()
  if (code.length < 4) {
    toast.warn('房间号至少 4 位')
    return
  }
  net.joinRoom(saveName(), code)
  router.push('/lobby')
}

function createRoom() {
  if (!theme.value.trim()) {
    toast.warn('先给这局定个题材')
    return
  }
  saveName()
  game.createRoom(playerCount.value, theme.value.trim())
  router.push('/room')
}

function toggleDemo() {
  settings.state.demoMode = !settings.state.demoMode
}
</script>

<template>
  <AppTopBar title="迷案" sub="AI 剧本杀" show-settings />

  <main class="page home-page">
    <InstallBanner />

    <section class="home-intro">
      <div class="home-intro__brand">
        <BrandMark class="home-intro__mark" label="迷案游戏标志" />
        <div>
          <div class="home-intro__eyebrow">NO BODY, NO TRUTH</div>
          <div class="home-intro__edition">AI MURDER MYSTERY</div>
        </div>
      </div>
      <h1 class="home-intro__title">今晚，谁是凶手？</h1>
      <p class="home-intro__sub">
        和 3-5 位朋友各看各的剧本，在线搜证、互相试探，最后当面指认。
      </p>
    </section>

    <section class="home-start">
      <div class="home-start__heading">
        <div>
          <div class="home-start__kicker">NEW CASE</div>
          <h2 class="home-start__title">开一局</h2>
        </div>
        <span class="tag tag--gold">{{ playerCount }} 人</span>
      </div>

      <div class="home-field">
        <div class="home-field__head">
          <span>玩家人数</span>
          <small>联机不足时由 AI 补位</small>
        </div>
        <div class="home-counts">
          <button
            v-for="c in counts"
            :key="c.n"
            class="home-count"
            :class="{ 'home-count--on': playerCount === c.n }"
            @click="playerCount = c.n"
          >
            <strong>{{ c.n }}</strong>
            <span>{{ c.label }}</span>
          </button>
        </div>
      </div>

      <div class="home-field">
        <div class="home-field__head">
          <span>案件题材</span>
          <small>也可以自己写</small>
        </div>
        <div class="home-themes">
          <button
            v-for="t in PRESET_THEMES"
            :key="t.theme"
            class="home-theme"
            :class="{ 'home-theme--on': theme === t.theme }"
            @click="pickTheme(t.theme)"
          >
            <span class="home-theme__emoji">{{ t.emoji }}</span>
            <span>{{ t.label }}</span>
          </button>
        </div>
        <input
          v-model="theme"
          class="input home-theme-input"
          placeholder="例如：民国·戏院后台的第十三排"
        />
      </div>

      <label class="field home-name">
        <span class="field__label">你的昵称</span>
        <input v-model="myName" class="input" maxlength="12" placeholder="例如：阿澈" />
      </label>

      <button class="btn btn--primary home-create" @click="createOnline">
        创建联机房间
      </button>

      <div class="home-start__quick">
        <button @click="showJoin = !showJoin">输入房间号</button>
        <span aria-hidden="true" />
        <button @click="showSolo = !showSolo">单人带 AI 试玩</button>
      </div>

      <div v-if="showJoin" class="home-inline">
        <input
          v-model="joinCode"
          class="input home-code"
          placeholder="输入 5 位房间号"
          maxlength="8"
          style="text-transform: uppercase"
        />
        <button class="btn" @click="joinOnline">加入房间</button>
      </div>

      <div v-if="showSolo" class="home-inline home-inline--solo">
        <p>其余座位由 AI 本地模拟，适合先熟悉流程。</p>
        <button class="btn btn--ghost btn--sm" @click="createRoom">单人开一局</button>
      </div>
    </section>

    <section class="home-flow" aria-label="游戏流程">
      <span>阅读剧本</span>
      <i />
      <span>轮流陈述</span>
      <i />
      <span>搜证整理</span>
      <i />
      <span>投票复盘</span>
    </section>

    <details class="home-more">
      <summary>更多设置</summary>
      <div class="home-more__body">
        <div class="list-row">
          <div>
            <div class="home-more__label">剧本引擎</div>
            <div class="tiny muted">{{ providerText }}</div>
          </div>
          <button class="mini-btn" @click="router.push('/settings')">配置</button>
        </div>
        <div class="list-row" @click="toggleDemo">
          <div>
            <div class="home-more__label">上帝视角</div>
            <div class="tiny muted">仅用于单机演示与排查剧本</div>
          </div>
          <span class="tag" :class="settings.state.demoMode ? 'tag--blood' : ''">
            {{ settings.state.demoMode ? '已开启' : '已关闭' }}
          </span>
        </div>
        <p v-if="settings.state.demoMode" class="warn">
          开启后会直接看到真凶，正常对局请保持关闭。
        </p>
      </div>
    </details>
  </main>
</template>
