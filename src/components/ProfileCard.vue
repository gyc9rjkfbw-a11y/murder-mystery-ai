<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useToast } from '@/composables/useToast'
import { AVATAR_CHOICES, profileEndpoint } from '@/services/profile'
import { useSettingsStore } from '@/stores/settings'

/**
 * 「我的档案」卡片
 * ------------------------------------------------------------------
 * 这里同时展示三件事：
 *   1. 身份——头像 + 昵称（本机设备档案，免登录）；
 *   2. 战绩——局数 / 胜率 / 胜负 / 凶手局数（服务器在复盘时结算，客户端只读）；
 *   3. 最近对局——时间 / 题材 / 人数 / 结果（最多 30 条，这里显示最近 5 条）。
 *
 * 服务器没开时不报错：档案缓存在本地，战绩区显示上次读到的那份。
 */
const settings = useSettingsStore()
const toast = useToast()

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

/** 换头像 / 改昵称：只有确认服务器在线才推送，避免离线时白打请求 */
function pushIfOnline() {
  if (synced.value) settings.pushProfile()
}

watch(
  () => [settings.state.playerName, settings.state.avatar],
  () => pushIfOnline(),
)

async function syncNow() {
  syncing.value = true
  // 先推（立刻，不等去抖）再读回来：新设备上服务器还没有档案，
  // 只读不推的话第一次永远同步不上。
  const ok = await settings.syncNow()
  if (ok) toast.success('档案已同步')
  else toast.warn('没连上服务器（单机不受影响，联机时会自动记录）')
  syncing.value = false
}

onMounted(() => {
  // 进设置页就刷一次，顺便让「服务器是否在线」显示成真实状态
  void settings.refreshProfile()
})
</script>

<template>
  <section class="card">
    <h3 class="card__title">我的档案</h3>
    <p class="tiny muted" style="margin: 0 0 12px">
      免登录：档案跟这台设备走（ID {{ shortId() }}），换手机 / 清缓存就是新档案。
    </p>

    <!-- 头像 -->
    <div class="field">
      <label class="field__label">头像</label>
      <div class="avatars">
        <button
          v-for="a in AVATAR_CHOICES"
          :key="a"
          class="avatar"
          :class="{ 'avatar--on': settings.state.avatar === a }"
          :aria-label="`选择头像 ${a}`"
          @click="settings.state.avatar = a"
        >
          {{ a }}
        </button>
      </div>
    </div>

    <!-- 昵称 -->
    <div class="field">
      <label class="field__label">昵称</label>
      <input
        v-model="nameDraft"
        class="input"
        placeholder="给自己起个名字"
        maxlength="16"
        @blur="pushIfOnline()"
      />
    </div>

    <!-- 同步状态 -->
    <div class="sync-row">
      <span class="tag" :class="synced ? 'tag--gold' : ''">
        {{ synced ? '已同步到服务器' : '仅本机（服务器未连接）' }}
      </span>
      <button class="mini-btn" :disabled="syncing || settings.profileLoading" @click="syncNow">
        {{ syncing || settings.profileLoading ? '同步中…' : '立即同步' }}
      </button>
    </div>

    <!-- 战绩 -->
    <div class="stats">
      <div class="stat">
        <div class="stat__num">{{ stats.games }}</div>
        <div class="stat__label">总局数</div>
      </div>
      <div class="stat">
        <div class="stat__num">{{ stats.games ? winRate + '%' : '—' }}</div>
        <div class="stat__label">胜率</div>
      </div>
      <div class="stat">
        <div class="stat__num">
          <span class="gold">{{ stats.wins }}</span> / <span class="blood">{{ stats.losses }}</span>
        </div>
        <div class="stat__label">胜 / 负</div>
      </div>
      <div class="stat">
        <div class="stat__num">{{ stats.asMurderer }}</div>
        <div class="stat__label">拿凶手</div>
      </div>
    </div>

    <!-- 最近对局 -->
    <div v-if="history.length" class="history">
      <div class="field__label" style="margin-bottom: 6px">最近对局</div>
      <div v-for="(h, i) in history" :key="`${h.at}-${i}`" class="history__row">
        <span class="tiny muted">{{ fmtTime(h.at) }}</span>
        <span class="history__theme">{{ h.theme || '未命名题材' }}</span>
        <span class="tiny muted">{{ h.playerCount }} 人</span>
        <span class="tiny" :class="h.result === 'win' ? 'gold' : 'blood'">
          {{ h.result === 'win' ? '胜' : '负' }}
          <template v-if="h.isMurderer">· 凶手</template>
        </span>
      </div>
    </div>
    <p v-else-if="hasProfile" class="card__hint" style="margin-top: 10px">
      还没有战绩：打一局完整的联机局，结算后这里就会自动出现。
    </p>
    <p v-else class="card__hint" style="margin-top: 10px">
      服务器上还没有你的档案。开一局联机游戏（或点「立即同步」）就会创建。
    </p>

    <p class="tiny muted" style="margin: 12px 0 0; line-height: 1.7">
      只保存昵称、头像、胜负与对局摘要（题材 / 人数 / 结果）；
      <strong>不保存 API 密钥</strong>，也不保存任何剧本或聊天内容。
      接口：{{ profileEndpoint() }}
    </p>
  </section>
</template>

<style scoped>
.avatars {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
}
.avatar {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease;
}
.avatar:active {
  transform: scale(0.94);
}
.avatar--on {
  border-color: var(--gold, #d8b36a);
  background: rgba(216, 179, 106, 0.16);
}
.sync-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0 14px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
.stat {
  text-align: center;
}
.stat__num {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.stat__label {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-dim);
}
.history {
  margin-top: 12px;
}
.history__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
}
.history__row:last-child {
  border-bottom: none;
}
.history__theme {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>