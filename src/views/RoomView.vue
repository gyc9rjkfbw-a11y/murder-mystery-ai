<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import { useToast } from '@/composables/useToast'
import { IS_LOCAL_MODE } from '@/services/ws'
import { readingTimeText } from '@/services/rules'
import { useGameStore } from '@/stores/game'
import { useSettingsStore } from '@/stores/settings'

const router = useRouter()
const game = useGameStore()
const settings = useSettingsStore()
const toast = useToast()

const theme = computed(() => game.setup.theme)
const count = computed(() => game.setup.playerCount)
const provider = computed(() => settings.providerLabel)

onMounted(() => {
  if (game.state.seats.length === 0) router.replace('/')
})

async function copyCode() {
  try {
    await navigator.clipboard.writeText(game.state.roomCode)
    toast.success('房间号已复制')
  } catch {
    toast.info(`房间号：${game.state.roomCode}`)
  }
}

function leave() {
  game.resetAll()
  router.replace('/')
}

function start() {
  // 生成过程由剧本下发页驱动，这样进度动画不会因为等待而丢失
  router.push('/dealing')
}

function toggleDemo() {
  game.setGodMode(!game.state.godMode)
}
</script>

<template>
  <AppTopBar title="组局中" :sub="`房间号 ${game.state.roomCode}`" show-back show-settings />

  <main class="page">
    <section class="card">
      <h3 class="card__title">房间号</h3>
      <div style="display: flex; align-items: center; gap: 12px">
        <div
          class="serif gold"
          style="font-size: 30px; letter-spacing: 0.28em; font-weight: 700"
        >
          {{ game.state.roomCode }}
        </div>
        <button class="mini-btn" @click="copyCode">复制</button>
      </div>
      <p class="card__hint" style="margin-top: 8px">
        把房间号发到群里，朋友点开就能进。
        <template v-if="IS_LOCAL_MODE">（当前为前端本地演示，其他座位由模拟玩家填充）</template>
      </p>
    </section>

    <p class="section-title">座位 {{ game.state.seats.length }} / {{ count }}</p>
    <section class="seats">
      <div
        v-for="s in game.state.seats"
        :key="s.id"
        class="seat"
        :class="{ 'seat--self': s.isSelf }"
      >
        <div class="seat__avatar">{{ s.avatar }}</div>
        <div style="min-width: 0">
          <div class="seat__name">
            {{ s.name }}
            <span v-if="s.isSelf" class="tag tag--gold" style="margin-left: 4px">你</span>
          </div>
          <div class="seat__meta">{{ s.isBot ? '模拟玩家' : '真人' }}</div>
        </div>
      </div>
    </section>

    <p class="section-title">本局配置</p>
    <section class="card card--flat">
      <div class="kv">
        <span class="kv__k">题材</span>
        <span class="kv__v">{{ theme }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">人数</span>
        <span class="kv__v">{{ count }} 人 · {{ game.rule.label }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">生成引擎</span>
        <span class="kv__v">{{ provider }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">流程</span>
        <span class="kv__v">
          剧本下发 → 阅读 →
          <template v-for="r in game.rule.maxRounds" :key="r">
            第{{ r }}轮陈述<template v-if="r <= game.rule.searchRounds"> → 搜证</template>
            <template v-if="r < game.rule.maxRounds"> → 摸底</template> →
          </template>
          整理 → 投票 → 复盘
        </span>
      </div>
    </section>

    <p class="section-title">节奏与字数基准</p>
    <section class="card card--flat">
      <div class="kv">
        <span class="kv__k">发言轮次</span>
        <span class="kv__v">{{ game.rule.maxRounds }} 轮（硬性上限）</span>
      </div>
      <div class="kv">
        <span class="kv__k">搜证</span>
        <span class="kv__v">
          {{
            game.rule.searchRounds > 0
              ? `每轮 ${game.rule.searchPerRound} 次，共 ${game.rule.searchRounds} 轮`
              : '不设搜证环节，线索由系统按轮次发放'
          }}
        </span>
      </div>
      <div class="kv">
        <span class="kv__k">阅读时长</span>
        <span class="kv__v">{{ readingTimeText(game.rule.readingSeconds) }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">剧本字数</span>
        <span class="kv__v">{{ game.rule.scriptMin }}-{{ game.rule.scriptMax }} 字 / 人</span>
      </div>
      <div class="kv">
        <span class="kv__k">提前结算</span>
        <span class="kv__v">{{ game.rule.accelerateVotes }} 人指认同一人时提示收网</span>
      </div>
      <div v-if="game.rule.sideQuestMin > 0" class="kv">
        <span class="kv__k">防边缘化</span>
        <span class="kv__v">每人 {{ game.rule.sideQuestMin }}-2 条独立支线任务</span>
      </div>
    </section>

    <section class="card card--flat">
      <div class="list-row" @click="toggleDemo">
        <div>
          <div style="font-size: 14px">上帝视角（演示）</div>
          <div class="tiny muted">开启后可以查看全部角色剧本与凶手特权</div>
        </div>
        <span class="tag" :class="game.state.godMode ? 'tag--blood' : ''">
          {{ game.state.godMode ? '已开启' : '已关闭' }}
        </span>
      </div>
      <p v-if="game.state.godMode" class="warn">
        ⚠️ 上帝视角会直接暴露真凶与凶手特权，<strong>正常对局请保持关闭</strong>；
        它的作用是让你一个人也能把全流程跑通、方便截图与排查问题。
      </p>
      <p v-else class="tiny muted" style="margin: 8px 0 0">
        默认关闭。你是哪个角色、是不是凶手，开局后在阅读页的「阵营卡」里会明确告诉你。
      </p>
    </section>

    <button class="btn btn--primary" style="margin-top: 8px" @click="start">
      开始游戏 · 下发剧本
    </button>
    <div class="btn-row">
      <button class="btn btn--ghost" @click="leave">解散房间</button>
    </div>
  </main>
</template>