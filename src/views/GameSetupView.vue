<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import BrandMark from '@/components/BrandMark.vue'
import CustomScriptPanel from '@/components/CustomScriptPanel.vue'
import { useToast } from '@/composables/useToast'
import { PRESET_THEMES } from '@/services/templates'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { randomNickname, useSettingsStore } from '@/stores/settings'
import type { ScriptPackage } from '@/types/script'

const router = useRouter()
const game = useGameStore()
const net = useNetStore()
const settings = useSettingsStore()
const toast = useToast()

const playerCount = ref(settings.state.defaultPlayerCount)
const theme = ref(PRESET_THEMES[0].theme)
const joinCode = ref('')
const showJoin = ref(false)
const myName = ref(settings.state.playerName)
const showSolo = ref(false)
const activePanel = ref<'quick' | 'script'>('quick')

const counts = [
  { n: 4, label: '紧凑' },
  { n: 5, label: '均衡' },
  { n: 6, label: '丰满' },
]

function pickTheme(value: string) {
  theme.value = value
}

function saveName() {
  const name = myName.value.trim() || randomNickname()
  settings.state.playerName = name
  settings.state.defaultPlayerCount = playerCount.value
  myName.value = name
  return name
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

function startCustomSolo(pkg: ScriptPackage) {
  saveName()
  const started = game.startCustomScript(pkg)
  if (!started.ok) {
    toast.error(started.errors[0] ?? '自定义剧本无法开局')
    return
  }
  router.push('/reading')
}

function startCustomOnline(pkg: ScriptPackage) {
  const name = saveName()
  net.createRoom(name, pkg.roles.length, pkg.game_config.theme, pkg)
  router.push('/lobby')
}
</script>

<template>
  <AppTopBar title="游戏大厅" sub="选择玩法与剧本" show-back />

  <main class="page setup-page">
    <section class="setup-hero">
      <BrandMark class="setup-hero__mark" label="迷案游戏标志" />
      <div>
        <div class="setup-hero__kicker">START A NEW CASE</div>
        <h1>开一局</h1>
        <p>快速创建一局，或者从剧本库挑一个故事。</p>
      </div>
    </section>

    <nav class="setup-modes" aria-label="游戏大厅功能">
      <button
        :class="{ 'setup-modes__btn--on': activePanel === 'quick' }"
        @click="activePanel = 'quick'"
      >
        <strong>快速开局</strong>
        <small>选人数与题材</small>
      </button>
      <button
        :class="{ 'setup-modes__btn--on': activePanel === 'script' }"
        @click="activePanel = 'script'"
      >
        <strong>挑选剧本</strong>
        <small>剧本库或 AI 生成</small>
      </button>
    </nav>

    <section v-show="activePanel === 'quick'" class="home-start">
      <div class="home-start__heading">
        <div>
          <div class="home-start__kicker">ROOM SETUP</div>
          <h2 class="home-start__title">联机房间</h2>
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
            @click="playerCount = c.n as 4 | 5 | 6"
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
            v-for="item in PRESET_THEMES"
            :key="item.theme"
            class="home-theme"
            :class="{ 'home-theme--on': theme === item.theme }"
            @click="pickTheme(item.theme)"
          >
            <span class="home-theme__emoji">{{ item.emoji }}</span>
            <span>{{ item.label }}</span>
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

      <button class="btn btn--primary home-create" @click="createOnline">创建联机房间</button>

      <div class="home-start__quick">
        <button @click="showJoin = !showJoin">加入房间</button>
        <span aria-hidden="true" />
        <button @click="showSolo = !showSolo">单人试玩</button>
      </div>

      <div v-if="showJoin" class="home-inline">
        <input
          v-model="joinCode"
          class="input home-code"
          placeholder="输入 5 位房间号"
          maxlength="8"
          style="text-transform: uppercase"
        />
        <button class="btn" @click="joinOnline">加入</button>
      </div>

      <div v-if="showSolo" class="home-inline home-inline--solo">
        <p>其余座位由 AI 本地模拟，适合先熟悉流程。</p>
        <button class="btn btn--ghost btn--sm" @click="createRoom">单人开一局</button>
      </div>
    </section>

    <div v-show="activePanel === 'script'">
      <CustomScriptPanel
        @start-solo="startCustomSolo"
        @start-online="startCustomOnline"
      />
    </div>

    <section class="home-flow" aria-label="游戏流程">
      <span>阅读剧本</span>
      <i />
      <span>轮流陈述</span>
      <i />
      <span>搜证整理</span>
      <i />
      <span>投票复盘</span>
    </section>
  </main>
</template>
