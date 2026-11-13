<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import BrandMark from '@/components/BrandMark.vue'
import CustomScriptPanel from '@/components/CustomScriptPanel.vue'
import { useToast } from '@/composables/useToast'
import {
  DIFFICULTIES,
  difficultyEffectText,
  difficultyFor,
  normalizeDifficulty,
} from '@/services/difficulty'
import { PRESET_THEMES } from '@/services/templates'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { randomNickname, useSettingsStore } from '@/stores/settings'
import type { Difficulty, ScriptPackage } from '@/types/script'

const router = useRouter()
const game = useGameStore()
const net = useNetStore()
const settings = useSettingsStore()
const toast = useToast()

const playerCount = ref(settings.state.defaultPlayerCount)
/**
 * 题材列表：在「我的 → 游戏偏好」里选过的排前面（稳定排序，其余保持原顺序）。
 * 一个都没选时就是原来的六格，顺序与升级前完全一致。
 */
const themeOptions = computed(() => {
  const pref = settings.state.preferredGenres
  if (!pref.length) return PRESET_THEMES
  return [...PRESET_THEMES].sort(
    // 偏好的权重 0、其余 1；sort 是稳定排序，同组内保持原来的先后
    (a, b) => Number(!pref.includes(a.label)) - Number(!pref.includes(b.label)),
  )
})
const theme = ref(themeOptions.value[0]?.theme ?? PRESET_THEMES[0].theme)
/** 本局难度：三档都能自由选，选完会记成下次的默认档 */
const difficulty = ref<Difficulty>(settings.state.defaultDifficulty)
const difficultyMeta = computed(() => difficultyFor(difficulty.value))
/** 这一档在当前人数下到底会怎样（数字由规则现算，不写死） */
const difficultyEffect = computed(() => difficultyEffectText(playerCount.value, difficulty.value))
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
  settings.state.defaultDifficulty = normalizeDifficulty(difficulty.value)
  myName.value = name
  return name
}

function createOnline() {
  if (!theme.value.trim()) {
    toast.warn('先给这局定个题材')
    return
  }
  net.createRoom(saveName(), playerCount.value, theme.value.trim(), undefined, difficulty.value)
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
  game.createRoom(playerCount.value, theme.value.trim(), difficulty.value)
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
  // 自定义剧本以剧本自带的难度为准（没标就走标准档）
  net.createRoom(name, pkg.roles.length, pkg.game_config.theme, pkg, pkg.game_config.difficulty)
  router.push('/lobby')
}
</script>

<template>
  <AppTopBar title="游戏大厅" sub="选择玩法与剧本" show-back />

  <main class="page setup-page">
    <section class="setup-hero">
      <BrandMark class="setup-hero__mark" label="谜案剧本杀游戏标志" />
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
          <span>剧本难度</span>
          <small>只改节奏与线索发放，不改凶手与真相</small>
        </div>
        <div class="home-difficulties">
          <button
            v-for="d in DIFFICULTIES"
            :key="d.id"
            class="home-difficulty"
            :class="{ 'home-difficulty--on': difficulty === d.id }"
            :aria-pressed="difficulty === d.id ? 'true' : 'false'"
            @click="difficulty = d.id"
          >
            <span class="home-difficulty__emoji" aria-hidden="true">{{ d.emoji }}</span>
            <strong>{{ d.label }}</strong>
            <span class="home-difficulty__tag">{{ d.tagline }}</span>
          </button>
        </div>
        <p class="home-difficulty-note">
          {{ difficultyMeta.detail }}<br />
          <span class="muted">本局实际：{{ difficultyEffect }}</span>
        </p>
      </div>

      <div class="home-field">
        <div class="home-field__head">
          <span>案件题材</span>
          <small>也可以自己写</small>
        </div>
        <div class="home-themes">
          <button
            v-for="item in themeOptions"
            :key="item.theme"
            class="home-theme"
            :class="{
              'home-theme--on': theme === item.theme,
              'home-theme--pref': settings.state.preferredGenres.includes(item.label),
            }"
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
