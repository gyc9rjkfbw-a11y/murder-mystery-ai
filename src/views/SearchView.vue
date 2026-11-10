<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import ClueCard from '@/components/ClueCard.vue'
import CountdownPill from '@/components/CountdownPill.vue'
import PhaseStepper from '@/components/PhaseStepper.vue'
import SheetModal from '@/components/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import type { ClueItem } from '@/types/script'

const router = useRouter()
const game = useGameStore()
const net = useNetStore()
const toast = useToast()

const found = ref<ClueItem | null>(null)
const sheetOpen = ref(false)

/** 本轮的搜证次数（按人数档位） */
const perRound = computed(() => game.rule.searchPerRound)

const locations = computed(() =>
  game.locations.map((loc) => {
    const all = game.state.clues.filter(
      (c) => !c.isPrivate && !c.tier && c.location === loc.name,
    )
    const revealed = all.filter((c) => c.revealed).length
    return { name: loc.name, total: all.length, revealed, left: all.length - revealed }
  }),
)

const publicClues = computed(() => game.publicClues)
const myFindings = computed(() =>
  game.state.clues.filter((c) => c.revealed && c.foundBy === game.state.selfSeatId),
)

onMounted(() => {
  if (!game.state.script) {
    router.replace('/')
    return
  }
  if (game.state.phase !== 'search') game.startSearch()
})

function search(name: string) {
  if (game.state.searchLeft <= 0) {
    toast.warn('本轮搜证次数用完了')
    return
  }
  if (game.state.online) {
    // 联机：抽哪条线索由服务器决定，结果会异步推回来（watch 弹层）
    net.search(name)
    return
  }
  const clue = game.searchLocation(name)
  if (!clue) {
    toast.info('这个地方已经被翻遍了')
    return
  }
  found.value = clue
  sheetOpen.value = true
  // 其他玩家也在同时翻找
  if (Math.random() > 0.35) game.simulateBotSearch()
}

// 联机：服务器私下把「你翻到了什么」推回来时弹出选择框
watch(
  () => net.pendingClue,
  (clue) => {
    if (!clue || !game.state.online) return
    found.value = clue
    sheetOpen.value = true
  },
)

function publish() {
  if (found.value) {
    if (game.state.online) net.decideClue(found.value.id, true)
    else game.publishClue(found.value.id)
    toast.success('已公开到公共线索板')
  }
  sheetOpen.value = false
}

function keep() {
  if (found.value && game.state.online) net.decideClue(found.value.id, false)
  sheetOpen.value = false
  toast.info('线索已留在你手上')
}

/** 搜证结束：非最后一轮先进摸底，最后一轮直接进整理 */
function finishSearch() {
  game.finishSearch()
  // 联机：由服务器决定进摸底还是进整理，App.vue 的 watch 负责跳页
  if (game.state.online) return
  if (game.state.phase === 'poll') router.push('/poll')
  else router.push('/organize')
}
</script>

<template>
  <AppTopBar
    :title="`第 ${game.state.round} 轮 · 自由搜证`"
    sub="翻找现场，线索不会自己说话"
    show-back
  >
    <CountdownPill />
  </AppTopBar>
  <PhaseStepper />

  <main class="page">
    <section class="card">
      <div style="display: flex; align-items: center; justify-content: space-between">
        <div>
          <h3 class="card__title" style="margin: 0">本轮搜证次数</h3>
          <p class="card__hint">每个地点只能翻出一条线索</p>
        </div>
        <div class="gold bold" style="font-size: 20px">
          {{ game.state.searchLeft
          }}<span class="muted" style="font-size: 13px">/{{ perRound }}</span>
        </div>
      </div>
    </section>

    <template v-if="game.releasedBatches.length > 0">
      <p class="section-title">本轮系统发放</p>
      <section class="card">
        <div v-for="b in game.releasedBatches" :key="b.tier" style="margin-bottom: 10px">
          <div class="tiny gold bold" style="margin-bottom: 6px">{{ b.title }}</div>
          <div v-for="(c, i) in b.clues" :key="i" class="sysclue">· {{ c }}</div>
        </div>
      </section>
    </template>

    <p class="section-title">可搜证地点</p>
    <div class="opt-grid" style="grid-template-columns: repeat(2, 1fr)">
      <button
        v-for="loc in locations"
        :key="loc.name"
        class="theme"
        :disabled="loc.left === 0 || game.state.searchLeft === 0"
        style="opacity: 1"
        @click="search(loc.name)"
      >
        <div style="display: flex; align-items: center; justify-content: space-between">
          <span style="font-size: 13px; font-weight: 600">{{ loc.name }}</span>
          <span class="tag" :class="loc.left === 0 ? '' : 'tag--gold'">
            {{ loc.left === 0 ? '已翻空' : `剩 ${loc.left}` }}
          </span>
        </div>
        <div class="tiny muted" style="margin-top: 6px">
          已发现 {{ loc.revealed }} / {{ loc.total }}
        </div>
      </button>
    </div>

    <p class="section-title">公共线索板 {{ publicClues.length }}</p>
    <section>
      <div v-if="publicClues.length === 0" class="empty">还没有人公开线索</div>
      <ClueCard v-for="c in publicClues" :key="c.id" :clue="c" />
    </section>

    <p class="section-title">你的发现 {{ myFindings.length }}</p>
    <section>
      <div v-if="myFindings.length === 0" class="empty">你还没翻到东西</div>
      <ClueCard
        v-for="c in myFindings"
        :key="c.id"
        :clue="c"
        actionable
        @publish="game.publishClue"
        @pin="game.togglePin"
      />
    </section>
  </main>

  <div class="dock">
    <div class="dock__inner">
      <div class="dock__info">
        {{
          game.state.round >= game.state.maxRounds
            ? '最后一轮搜证，搜完进入个人整理与投票'
            : '搜完后先摸一次底，再进入下一轮'
        }}
      </div>
      <button class="btn btn--primary btn--sm" @click="finishSearch">搜证结束 ›</button>
    </div>
  </div>

  <SheetModal :open="sheetOpen" title="你翻到了什么" @close="sheetOpen = false">
    <div v-if="found" class="clue clue--private" style="margin-bottom: 14px">
      <div class="clue__text">{{ found.text }}</div>
      <div class="clue__foot">
        <span class="tag tag--gold">{{ found.location }}</span>
      </div>
    </div>
    <p class="card__hint">
      公开之后所有人都能看到，也可以先捏在手里——什么时候抛出去，是你的战术。
    </p>
    <button class="btn btn--primary" @click="publish">公开到线索板</button>
    <div class="btn-row">
      <button class="btn btn--ghost" @click="keep">先自己留着</button>
    </div>
  </SheetModal>
</template>