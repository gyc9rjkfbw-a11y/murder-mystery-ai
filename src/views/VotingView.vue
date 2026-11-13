<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import RoleAvatar from '@/components/RoleAvatar.vue'
import CountdownPill from '@/components/CountdownPill.vue'
import PhaseStepper from '@/components/PhaseStepper.vue'
import { useToast } from '@/composables/useToast'
import { useGameStore } from '@/stores/game'
import { useDeductionStore } from '@/stores/deduction'

const router = useRouter()
const game = useGameStore()
const deduction = useDeductionStore()
const toast = useToast()

const picked = ref('')
const voted = computed(() => game.myVote !== undefined)
const botVoted = computed(() => game.state.votes.filter((v) => v.voterSeatId !== game.state.selfSeatId).length)
const deductionTarget = computed(() =>
  game.roles.some((role) => role.name === deduction.board.finalSuspect)
    ? deduction.board.finalSuspect
    : '',
)

onMounted(() => {
  if (!game.state.script) {
    router.replace('/')
    return
  }
  if (game.state.phase !== 'voting') game.startVoting()
  deduction.sync()
  if (!picked.value && deductionTarget.value) picked.value = deductionTarget.value
})

function submit() {
  if (!picked.value) {
    toast.warn('先选一个你认为是凶手的人')
    return
  }
  game.castVote(picked.value)
  toast.success(`你投给了 ${picked.value}`)
}

function reveal() {
  game.reveal()
  // 联机：所有票到齐后服务器才会开复盘并公开身份，等它广播即可
  if (game.state.online) return
  router.push('/reveal')
}
</script>

<template>
  <AppTopBar title="投票" sub="指认凶手" show-back>
    <CountdownPill />
  </AppTopBar>
  <PhaseStepper />

  <main class="page">
    <section v-if="deductionTarget" class="card vote-deduction">
      <div class="vote-deduction__top">
        <div>
          <div class="wb-kicker">YOUR THEORY</div>
          <h3 class="vote-deduction__title">我的整理结论</h3>
        </div>
        <span class="tag tag--gold">工作台推荐</span>
      </div>
      <p class="vote-deduction__target">你当时最怀疑：<strong>{{ deductionTarget }}</strong></p>
      <p v-if="deduction.board.finalReasons.length" class="vote-deduction__reasons">
        {{ deduction.board.finalReasons.join(' · ') }}
      </p>
      <button
        v-if="!voted && picked !== deductionTarget"
        class="mini-btn"
        @click="picked = deductionTarget"
      >
        按整理结果选择
      </button>
    </section>

    <section class="card">
      <h3 class="card__title">投票进度</h3>
      <div class="kv">
        <span class="kv__k">已投票</span>
        <span class="kv__v">{{ botVoted + (voted ? 1 : 0) }} / {{ game.state.seats.length }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">你的选择</span>
        <span class="kv__v">{{ game.myVote?.targetRoleName ?? '还未投票' }}</span>
      </div>
    </section>

    <p class="section-title">选择你要指认的人</p>
    <section>
      <button
        v-for="r in game.roles"
        :key="r.name"
        class="theme"
        style="width: 100%; text-align: left; margin-bottom: 10px"
        :class="{ 'theme--on': picked === r.name || game.myVote?.targetRoleName === r.name }"
        :disabled="voted"
        @click="picked = r.name"
      >
        <div style="display: flex; align-items: center; gap: 10px">
          <RoleAvatar :role="r" :size="40" tone="none" />
          <div style="flex: 1; min-width: 0">
            <div style="font-size: 15px; font-weight: 600">{{ r.name }}</div>
            <div class="tiny muted">{{ r.identity }}</div>
          </div>
          <span
            v-if="game.myVote?.targetRoleName === r.name"
            class="tag tag--blood"
          >
            你投了
          </span>
          <span v-else-if="deductionTarget === r.name" class="tag tag--gold">整理结论</span>
          <span v-else-if="picked === r.name" class="tag tag--gold">已选中</span>
        </div>
      </button>
    </section>

    <p class="tiny muted center" style="margin-top: 6px">
      投票是不可逆的。票型会在复盘环节公开。
    </p>
  </main>

  <div class="dock">
    <div class="dock__inner">
      <div class="dock__info">
        {{ voted ? '投票已提交' : '选一个人，然后提交' }}
      </div>
      <button v-if="!voted" class="btn btn--blood btn--sm" :disabled="!picked" @click="submit">
        提交投票
      </button>
      <button v-else class="btn btn--primary btn--sm" @click="reveal">揭晓真相</button>
    </div>
  </div>
</template>
