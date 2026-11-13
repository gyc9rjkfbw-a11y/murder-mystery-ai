<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import CountdownPill from '@/components/CountdownPill.vue'
import PhaseStepper from '@/components/PhaseStepper.vue'
import RoleAvatar from '@/components/RoleAvatar.vue'
import { useToast } from '@/composables/useToast'
import { useGameStore } from '@/stores/game'

const router = useRouter()
const game = useGameStore()
const toast = useToast()

// 节奏统一取 store 的 rule（人数 + 本局难度），不要再按人数单独算一遍
const rule = computed(() => game.rule)
const summary = computed(() =>
  game.state.roundSummaries.find((s) => s.round === game.state.round),
)
const nextRoundNo = computed(() => Math.min(game.state.maxRounds, game.state.round + 1))
const isLastRound = computed(() => game.state.round >= game.state.maxRounds)

/** 意向票型：按票数从高到低 */
const rows = computed(() =>
  game.roles
    .map((r) => ({ name: r.name, identity: r.identity, votes: game.strawTally[r.name] ?? 0 }))
    .sort((a, b) => b.votes - a.votes),
)

const maxVotes = computed(() => Math.max(1, ...rows.value.map((r) => r.votes)))

/** 线索曝光进度 */
const clueProgress = computed(() => {
  const totalTiers = (game.state.script?.clue_batches ?? []).length
  const searchable = game.state.clues.filter((c) => !c.isPrivate && !c.tier)
  const found = searchable.filter((c) => c.revealed).length
  return {
    tiers: `${game.state.releasedTiers.length}/${totalTiers}`,
    searched: searchable.length > 0 ? `${found}/${searchable.length}` : '—',
  }
})

onMounted(() => {
  if (!game.state.script) router.replace('/')
  if (game.state.phase !== 'poll') {
    // 直接进入本页（如演示深链）时补一次本轮小结
    if (game.state.strawPoll.length === 0) game.endRound()
    game.setPhase('poll')
  }
})

function vote(name: string) {
  game.castStrawVote(name)
  toast.success(`已指认 ${name}`)
}

function goNext() {
  game.nextRound()
  // 联机：下一阶段（下一轮陈述 / 整理）由服务器决定并广播，App.vue 负责跳页
  if (game.state.online) return
  router.push('/statement')
}

function settleNow() {
  game.forceSettle()
  if (game.state.online) return
  router.push('/organize')
}

const voterName = (seatId: string) =>
  seatId === game.state.selfSeatId ? '我' : (game.state.seats.find((s) => s.id === seatId)?.name ?? '？')
</script>

<template>
  <AppTopBar :title="`第 ${game.state.round} 轮 · 意向投票`" sub="先摸一次底" show-back>
    <CountdownPill />
  </AppTopBar>
  <PhaseStepper />

  <main class="page">
    <section class="card round-card">
      <div class="round-card__head">
        <span class="tag tag--gold">摸底结果</span>
        <span class="tiny muted">不决定胜负，只用来判断要不要提前收网</span>
      </div>
      <p class="round-card__goal" style="margin-bottom: 6px">
        提前结算阈值：<b>{{ rule.accelerateVotes }} 票</b>指向同一人（需在第
        {{ Math.max(1, game.state.maxRounds - 1) }} 轮结束时达成）
      </p>
      <p class="tiny muted" style="margin: 0">
        线索曝光：批次 {{ clueProgress.tiers }} · 现场线索 {{ clueProgress.searched }}
      </p>
    </section>

    <section
      v-if="game.state.accelerateSuggested"
      class="card accel"
    >
      <div class="accel__head">
        <span>⚡</span>
        <span>可以提前结算</span>
      </div>
      <p class="accel__body">{{ game.state.accelerateReason }}</p>
      <p class="tiny muted" style="margin: 10px 0 0">
        提前结算会跳过剩余轮次，直接进入个人整理与最终投票。如果你们还想再问一轮，也可以继续。
      </p>
      <div class="btn-row">
        <button class="btn btn--primary btn--sm" @click="settleNow">提前结算 · 进入整理</button>
        <button class="btn btn--ghost btn--sm" @click="goNext">继续第 {{ nextRoundNo }} 轮</button>
      </div>
    </section>

    <p class="section-title">意向票型</p>
    <section class="card">
      <div v-for="r in rows" :key="r.name" class="tally">
        <div class="tally__head">
          <span class="tally__name">
            {{ r.name }}
            <span class="tiny muted" style="margin-left: 6px">{{ r.identity }}</span>
          </span>
          <span class="tally__votes">{{ r.votes }} 票</span>
        </div>
        <div class="tally__bar">
          <span
            class="tally__fill"
            :style="{ width: `${(r.votes / maxVotes) * 100}%` }"
            :class="{ 'tally__fill--lead': r.name === summary?.top && r.votes > 0 }"
          />
        </div>
      </div>
      <p class="tiny muted" style="margin: 12px 0 0">
        本轮最高票：{{ summary?.top ?? '无人' }}{{ summary?.topVotes ? `（${summary.topVotes} 票）` : '' }}
      </p>
    </section>

    <p class="section-title">我的一票</p>
    <section class="card">
      <p class="card__hint" style="margin-bottom: 10px">
        现在指定一个人，票型会立刻重算——说不定你们已经够票提前收网了。
      </p>
      <div class="chips">
        <button
          v-for="r in game.roles"
          :key="r.name"
          class="chip"
          :class="{ 'chip--on': game.myStrawVote?.targetRoleName === r.name }"
          @click="vote(r.name)"
        >
          <RoleAvatar :role="r" :size="20" tone="none" />
          {{ r.name }}
        </button>
      </div>
    </section>

    <p class="section-title">谁投了谁</p>
    <section class="card">
      <div v-for="v in game.state.strawPoll" :key="v.voterSeatId" class="vote-row">
        <span class="vote-row__who">{{ voterName(v.voterSeatId) }}</span>
        <span class="vote-row__arrow">→</span>
        <span class="vote-row__target">{{ v.targetRoleName }}</span>
      </div>
      <div v-if="game.state.strawPoll.length === 0" class="empty">还没有人表态</div>
    </section>
  </main>

  <div class="dock">
    <div class="dock__inner">
      <div class="dock__info">
        {{
          isLastRound
            ? '已是最后一轮，即将进入整理与投票'
            : `摸底不会影响最终投票，随时可以改`
        }}
      </div>
      <button v-if="!isLastRound" class="btn btn--primary btn--sm" @click="goNext">
        进入第 {{ nextRoundNo }} 轮 ›
      </button>
      <button v-else class="btn btn--primary btn--sm" @click="settleNow">进入整理 ›</button>
    </div>
  </div>
</template>