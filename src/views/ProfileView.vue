<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import { useToast } from '@/composables/useToast'
import { AVATAR_CHOICES, profileEndpoint, randomAvatar } from '@/services/profile'
import { PRESET_THEMES } from '@/services/templates'
import { randomNickname, useSettingsStore } from '@/stores/settings'

/**
 * 「我的」页
 * ------------------------------------------------------------------
 * 和「游戏设置」是两件事：
 *   · 这里只放**人**——头像、昵称、同步状态、战绩、剧本类型偏好；
 *   · 设置页只放**机器**——默认人数、动画、字号、AI 引擎。
 * 所有偏好都落在本机 localStorage（免登录设备档案），联机时昵称头像再推给服务器。
 */
const settings = useSettingsStore()
const toast = useToast()
const router = useRouter()

const syncing = ref(false)
const nameDraft = computed({
  get: () => settings.state.playerName,
  set: (v: string) => {
    settings.state.playerName = v
  },
})

const stats = computed(() => settings.stats)
const winRate = computed(() => settings.winRate)
const history = computed(() => (settings.profile?.history ?? []).slice(-5).reverse())
const hasProfile = computed(() => settings.profile !== null)
const synced = computed(() => settings.profileSynced)
const busy = computed(() => syncing.value || settings.profileLoading)
const displayName = computed(() => settings.state.playerName.trim() || '未命名玩家')
const preferred = computed(() => settings.state.preferredGenres)

function fmtTime(at: number): string {
  if (!at) return '—'
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function shortId(): string {
  const id = settings.playerId()
  return id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id
}

function pickAvatar(a: string): void {
  settings.state.avatar = a
}

function rerollAvatar(): void {
  // 随机到一个和当前不一样的，点一下真的能看出变化
  let next = randomAvatar()
  for (let i = 0; i < 8 && next === settings.state.avatar; i += 1) next = randomAvatar()
  settings.state.avatar = next
}

function rerollName(): void {
  nameDraft.value = randomNickname()
}

/** 换头像 / 改昵称：只有服务器在线时才推送，离线时不白打请求 */
function pushIfOnline(): void {
  if (synced.value) settings.pushProfile()
}

watch(
  // 题材偏好也要跟着同步：本地选了却不同步，换设备就白选了
  () => [settings.state.playerName, settings.state.avatar, settings.state.preferredGenres.join('|')],
  () => pushIfOnline(),
)

async function syncNow(): Promise<void> {
  syncing.value = true
  // 先推（立刻，不等去抖）再读回来：新设备上服务器还没有档案，
  // 只读不推的话第一次永远同步不上。
  const ok = await settings.syncNow()
  if (ok) toast.success('档案已同步')
  else toast.warn('没连上服务器（单机不受影响，联机时会自动记录）')
  syncing.value = false
}

function toggleGenre(label: string): void {
  settings.togglePreferredGenre(label)
}

function clearGenres(): void {
  settings.state.preferredGenres = []
}

onMounted(() => {
  // 进页面就刷一次，顺便把「服务器是否在线」显示成真实状态
  void settings.refreshProfile()
})
</script>

<template>
  <AppTopBar title="我的" sub="档案 · 战绩 · 偏好" />

  <main class="page me-page">
    <!-- 身份总览 -->
    <section class="me-hero me-sec" style="--i: 0">
      <button class="me-hero__avatar" aria-label="随机换一个头像" @click="rerollAvatar">
        <span class="me-hero__face">{{ settings.state.avatar }}</span>
        <i class="me-hero__dice" aria-hidden="true">🎲</i>
      </button>
      <div class="me-hero__info">
        <h1 class="me-hero__name">{{ displayName }}</h1>
        <div class="me-hero__meta">
          <span class="me-hero__id">ID {{ shortId() }}</span>
          <span class="me-tag" :class="{ 'me-tag--ok': synced }">
            <i class="me-tag__dot" aria-hidden="true" />
            {{ synced ? '已同步到服务器' : '仅本机保存' }}
          </span>
        </div>
      </div>
    </section>

    <!-- 头像 -->
    <section class="me-card me-sec" style="--i: 1">
      <header class="me-card__head">
        <h2>头像</h2>
        <small>换一张脸，同桌的人也能看到</small>
      </header>
      <div class="me-avatars" role="group" aria-label="选择头像">
        <button
          v-for="a in AVATAR_CHOICES"
          :key="a"
          class="me-avatar"
          :class="{ 'me-avatar--on': settings.state.avatar === a }"
          :aria-label="`选择头像 ${a}`"
          :aria-pressed="settings.state.avatar === a ? 'true' : 'false'"
          @click="pickAvatar(a)"
        >
          {{ a }}
        </button>
      </div>
    </section>

    <!-- 昵称 + 同步 -->
    <section class="me-card me-sec" style="--i: 2">
      <header class="me-card__head">
        <h2>昵称</h2>
        <small>{{ 12 - nameDraft.length }} 字可用</small>
      </header>
      <div class="me-name-row">
        <input
          v-model="nameDraft"
          class="me-input"
          placeholder="给自己起个名字"
          maxlength="12"
          aria-label="昵称"
          @blur="pushIfOnline()"
        />
        <button class="me-mini" aria-label="随机昵称" @click="rerollName">随机</button>
      </div>
      <div class="me-sync">
        <span class="me-tag" :class="{ 'me-tag--ok': synced, 'me-tag--busy': busy }">
          <i class="me-tag__dot" aria-hidden="true" />
          {{ busy ? '正在同步…' : synced ? '已同步到服务器' : '仅本机保存' }}
        </span>
        <button class="me-sync__btn" :disabled="busy" @click="syncNow">
          <i v-if="busy" class="me-spin" aria-hidden="true" />
          {{ busy ? '同步中…' : '立即同步' }}
        </button>
      </div>
      <p class="me-note">
        免登录：档案跟这台设备走，换手机 / 清缓存就是新档案。同步只传昵称、头像、胜负与对局摘要，
        <strong>不传 API 密钥，也不传剧本和聊天内容</strong>。
      </p>
    </section>

    <!-- 战绩 -->
    <section class="me-card me-sec" style="--i: 3">
      <header class="me-card__head">
        <h2>战绩</h2>
        <small>{{ hasProfile ? '服务器结算，打完自动更新' : '还没有档案，打一局联机就会创建' }}</small>
      </header>
      <div class="me-stats">
        <div class="me-stat">
          <strong class="me-stat__num">{{ stats.games }}</strong>
          <span>总局数</span>
        </div>
        <div class="me-stat">
          <strong class="me-stat__num me-stat__num--win">{{ stats.wins }}</strong>
          <span>胜场</span>
        </div>
        <div class="me-stat">
          <strong class="me-stat__num">{{ stats.games ? winRate + '%' : '—' }}</strong>
          <span>胜率</span>
        </div>
      </div>
      <div class="me-winbar" :class="{ 'me-winbar--empty': !stats.games }">
        <i :style="{ width: `${stats.games ? winRate : 0}%` }" />
      </div>
      <div class="me-stats__sub">
        <span>负场 <b>{{ stats.losses }}</b></span>
        <span>凶手局 <b>{{ stats.asMurderer }}</b></span>
        <span>凶手胜 <b>{{ stats.murdererWins }}</b></span>
      </div>
    </section>

    <!-- 游戏偏好 -->
    <section class="me-card me-sec" style="--i: 4">
      <header class="me-card__head">
        <h2>游戏偏好</h2>
        <small>喜欢哪种类型的剧本？可多选</small>
      </header>
      <div class="me-genres" role="group" aria-label="剧本类型偏好">
        <button
          v-for="t in PRESET_THEMES"
          :key="t.label"
          class="me-genre"
          :class="{ 'me-genre--on': preferred.includes(t.label) }"
          :aria-pressed="preferred.includes(t.label) ? 'true' : 'false'"
          @click="toggleGenre(t.label)"
        >
          <span class="me-genre__emoji" aria-hidden="true">{{ t.emoji }}</span>
          <span class="me-genre__label">{{ t.label }}</span>
          <i class="me-genre__check" aria-hidden="true">✓</i>
        </button>
      </div>
      <p class="me-hint">
        <template v-if="preferred.length">
          已选 {{ preferred.length }} 种 · 开局页会把它们排在最前面
        </template>
        <template v-else>还没选 · 六种题材都会正常展示</template>
        <button v-if="preferred.length" class="me-link" @click="clearGenres">清空</button>
      </p>
    </section>

    <!-- 最近对局 -->
    <section class="me-card me-sec" style="--i: 5">
      <header class="me-card__head">
        <h2>最近对局</h2>
        <small v-if="history.length">最近 {{ history.length }} 场</small>
      </header>
      <div v-if="history.length" class="me-history">
        <div v-for="(h, i) in history" :key="`${h.at}-${i}`" class="history__row">
          <span class="me-history__time">{{ fmtTime(h.at) }}</span>
          <span class="history__theme">{{ h.theme || '未命名题材' }}</span>
          <span class="me-history__count">{{ h.playerCount }} 人</span>
          <span class="me-history__result" :class="h.result === 'win' ? 'is-win' : 'is-lose'">
            {{ h.result === 'win' ? '胜' : '负' }}
            <template v-if="h.isMurderer">· 凶手</template>
          </span>
        </div>
      </div>
      <p v-else class="me-empty">
        {{ hasProfile ? '还没有战绩：打完一局联机，结算后这里就会自动出现。' : '服务器上还没有你的档案，点「立即同步」或开一局联机就会创建。' }}
      </p>
    </section>

    <!-- 出口 -->
    <section class="me-sec me-links" style="--i: 6">
      <button class="me-link-row" @click="router.push('/settings')">
        <span>
          <strong>游戏设置</strong>
          <small>默认人数、动画、字号与 AI 引擎</small>
        </span>
        <i aria-hidden="true">›</i>
      </button>
      <p class="me-foot">
        档案接口：{{ profileEndpoint() }}<br />
        谜案剧本杀 v0.1.0
      </p>
    </section>
  </main>
</template>
