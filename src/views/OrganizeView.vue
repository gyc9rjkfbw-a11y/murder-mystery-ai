<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import ClueCard from '@/components/ClueCard.vue'
import CountdownPill from '@/components/CountdownPill.vue'
import PhaseStepper from '@/components/PhaseStepper.vue'
import SheetModal from '@/components/SheetModal.vue'
import { CASE_REASONS, useDeductionStore } from '@/stores/deduction'
import { useGameStore } from '@/stores/game'
import type { ReviewMark, SuspicionLevel, TimelineStatus } from '@/types/deduction'
import type { ClueItem } from '@/types/script'

type WorkbenchTab = 'timeline' | 'suspects' | 'case'

interface TimelineEntry {
  key: string
  time: string
  text: string
  seatName?: string
}

const router = useRouter()
const game = useGameStore()
const deduction = useDeductionStore()

const tab = ref<WorkbenchTab>('timeline')
const evidenceFor = ref('')

const suspicionCopy: Record<SuspicionLevel, string> = {
  0: '未判断',
  1: '留意',
  2: '可疑',
  3: '重点',
}

const timelineCopy: Record<TimelineStatus, string> = {
  unknown: '未判断',
  steady: '无空档',
  gap: '有时间空档',
  contradiction: '说法矛盾',
}

const selectedEvidenceRole = computed(() =>
  evidenceFor.value ? game.roles.find((role) => role.name === evidenceFor.value) : undefined,
)

const visibleClues = computed(() => {
  const seen = new Set<string>()
  return game.myClues.filter((clue) => {
    if (!clue.text.trim() || seen.has(clue.id)) return false
    seen.add(clue.id)
    return true
  })
})

const myTimeline = computed(() => splitTimeline(game.selfRole?.personal_timeline ?? ''))
const speechEntries = computed<TimelineEntry[]>(() => {
  const seats = new Map(game.state.seats.map((seat) => [seat.id, seat.name]))
  return game.state.statements
    .filter((item) => item.kind === 'player' && item.text.trim())
    .sort((a, b) => a.round - b.round || a.at - b.at)
    .map((item) => ({
      key: `statement:${item.round}:${item.seatId}:${item.at}`,
      time: `第 ${item.round} 轮`,
      text: item.text,
      seatName: seats.get(item.seatId) ?? item.roleName,
    }))
})

const suspectRows = computed(() =>
  game.roles.map((role) => ({
    role,
    dossier: deduction.board.suspects[role.name],
  })),
)

const highestSuspect = computed(() => {
  let best = ''
  let score = 0
  for (const [name, dossier] of Object.entries(deduction.board.suspects)) {
    if (dossier.suspicion > score) {
      best = name
      score = dossier.suspicion
    }
  }
  return best
})

const contradictionCount = computed(() => {
  const marked = Object.values(deduction.board.reviewMarks).filter(
    (value) => value === 'contradiction',
  ).length
  const suspectGaps = Object.values(deduction.board.suspects).filter(
    (dossier) => dossier.timeline === 'gap' || dossier.timeline === 'contradiction',
  ).length
  return marked + suspectGaps
})

const caseSteps = computed(() => {
  const checks = [
    highestSuspect.value !== '',
    deduction.linkedClueCount > 0,
    deduction.board.finalSuspect !== '',
    deduction.board.finalReasons.length >= 2,
  ]
  return checks.filter(Boolean).length
})

const caseProgress = computed(() => `${caseSteps.value * 25}%`)
const finalDossier = computed(() =>
  deduction.board.finalSuspect
    ? deduction.board.suspects[deduction.board.finalSuspect]
    : undefined,
)

const pinned = computed(() => game.pinnedClues)
const available = computed(() => game.myClues.filter((clue) => !clue.pinned).slice(0, 30))

onMounted(() => {
  if (!game.state.script) {
    router.replace('/')
    return
  }
  deduction.sync()
  if (game.state.phase !== 'organize') game.startOrganize()
})

function splitTimeline(text: string): string[] {
  const clean = text.trim()
  if (!clean) return []
  const lines = clean.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  if (lines.length > 1) return lines
  const parts = clean
    .split(/(?=(?:\d{1,2}\s*[:：]\s*\d{2})|(?:凌晨|清晨|拂晓|早上|上午|中午|下午|傍晚|黄昏|晚上|深夜|半夜|午夜))/g)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 1 ? parts : [clean]
}

function timeHead(text: string): string {
  const match = text.match(
    /^(?:\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*[点时](?:\s*\d{1,2}\s*分?)?|凌晨|清晨|拂晓|早上|上午|中午|下午|傍晚|黄昏|晚上|深夜|半夜|午夜)/,
  )
  return match?.[0] ?? '时间线'
}

function markOf(key: string): ReviewMark | '' {
  return deduction.board.reviewMarks[key] ?? ''
}

function markLabel(mark: ReviewMark | ''): string {
  if (mark === 'trusted') return '可信'
  if (mark === 'contradiction') return '有出入'
  return '待核实'
}

function tabLabel(value: WorkbenchTab) {
  tab.value = value
}

function setSuspicion(roleName: string, value: SuspicionLevel) {
  deduction.setSuspicion(roleName, value)
}

function setTimelineStatus(roleName: string, value: TimelineStatus) {
  deduction.setTimeline(roleName, value)
}

function openEvidence(roleName: string) {
  evidenceFor.value = roleName
  deduction.sync()
}

function toggleEvidence(clue: ClueItem) {
  if (!evidenceFor.value) return
  deduction.toggleClue(evidenceFor.value, clue.id)
}

function chooseFinal(roleName: string) {
  deduction.setFinalSuspect(roleName)
  tab.value = 'case'
}

function linkedClues(dossier: { clueIds: string[] }): ClueItem[] {
  const ids = new Set(dossier.clueIds)
  return visibleClues.value.filter((clue) => ids.has(clue.id))
}

function gotVoting() {
  deduction.sync()
  game.setNotes(deduction.board.scratchpad)
  game.startVoting()
  if (game.state.online) return
  router.push('/voting')
}
</script>

<template>
  <AppTopBar title="个人整理" sub="把线索拼成你的判断" show-back>
    <CountdownPill />
  </AppTopBar>
  <PhaseStepper />

  <main class="page workbench-page">
    <section v-if="game.state.accelerateSuggested" class="card accel">
      <div class="accel__head">
        <span>⚡</span>
        <span>本局已提前结算</span>
      </div>
      <p class="accel__body">{{ game.state.accelerateReason }}</p>
      <p class="tiny muted" style="margin: 10px 0 0">
        发言通道已关闭。用工作台收束判断，准备最终投票。
      </p>
    </section>

    <section class="wb-overview">
      <div class="wb-overview__top">
        <div>
          <div class="wb-kicker">CASE DESK</div>
          <h2 class="wb-title">推理工作台</h2>
        </div>
        <span class="tag" :class="deduction.summary.complete ? 'tag--ok' : 'tag--gold'">
          {{ deduction.summary.complete ? '结案完整' : '整理中' }}
        </span>
      </div>
      <div class="wb-stats">
        <div class="wb-stat">
          <strong>{{ contradictionCount }}</strong>
          <span>矛盾点</span>
        </div>
        <div class="wb-stat wb-stat--wide">
          <strong>{{ highestSuspect || '—' }}</strong>
          <span>最高怀疑</span>
        </div>
        <div class="wb-stat">
          <strong>{{ deduction.linkedClueCount }}</strong>
          <span>关联线索</span>
        </div>
      </div>
      <div class="wb-progress" aria-label="结案准备进度">
        <span class="wb-progress__bar" :style="{ width: caseProgress }" />
      </div>
      <p class="wb-overview__hint">
        {{ deduction.summary.complete ? deduction.summary.text : deduction.summary.missing[0] || '先看时间线，再收拢嫌疑人' }}
      </p>
    </section>

    <nav class="wb-tabs" aria-label="推理工作台分区">
      <button class="wb-tab" :class="{ 'wb-tab--on': tab === 'timeline' }" @click="tabLabel('timeline')">
        时间线
      </button>
      <button class="wb-tab" :class="{ 'wb-tab--on': tab === 'suspects' }" @click="tabLabel('suspects')">
        嫌疑人
        <span>{{ suspectRows.length }}</span>
      </button>
      <button class="wb-tab" :class="{ 'wb-tab--on': tab === 'case' }" @click="tabLabel('case')">
        结案
        <span>{{ deduction.summary.complete ? '✓' : caseSteps }}/4</span>
      </button>
    </nav>

    <template v-if="tab === 'timeline'">
      <p class="section-title">我的行动线</p>
      <section class="wb-timeline">
        <article v-for="(line, index) in myTimeline" :key="`self-${index}`" class="wb-timeline__item">
          <div class="wb-timeline__time">{{ timeHead(line) }}</div>
          <div class="wb-timeline__body">
            <p>{{ line }}</p>
            <button
              class="wb-mark"
              :class="{
                'wb-mark--ok': markOf(`self:${index}`) === 'trusted',
                'wb-mark--bad': markOf(`self:${index}`) === 'contradiction',
              }"
              @click="deduction.cycleReview(`self:${index}`)"
            >
              {{ markLabel(markOf(`self:${index}`)) }}
            </button>
          </div>
        </article>
        <div v-if="myTimeline.length === 0" class="empty">暂无自己的行动轨迹</div>
      </section>

      <p class="section-title">桌上的发言</p>
      <section class="wb-timeline wb-timeline--speech">
        <article v-for="item in speechEntries" :key="item.key" class="wb-timeline__item">
          <div class="wb-timeline__time">{{ item.time }}</div>
          <div class="wb-timeline__body">
            <div class="wb-speaker">{{ item.seatName }}</div>
            <p>{{ item.text }}</p>
            <button
              class="wb-mark"
              :class="{
                'wb-mark--ok': markOf(item.key) === 'trusted',
                'wb-mark--bad': markOf(item.key) === 'contradiction',
              }"
              @click="deduction.cycleReview(item.key)"
            >
              {{ markLabel(markOf(item.key)) }}
            </button>
          </div>
        </article>
        <div v-if="speechEntries.length === 0" class="empty">还没有人发言</div>
      </section>
    </template>

    <template v-else-if="tab === 'suspects'">
      <p class="section-title">逐个判断</p>
      <section class="wb-suspect-list">
        <article
          v-for="{ role, dossier } in suspectRows"
          :key="role.name"
          class="wb-suspect"
          :class="{ 'wb-suspect--final': deduction.board.finalSuspect === role.name }"
        >
          <div class="wb-suspect__head">
            <div class="wb-suspect__identity">
              <strong>{{ role.name }}</strong>
              <span>{{ role.identity }}</span>
            </div>
            <span v-if="deduction.board.finalSuspect === role.name" class="tag tag--blood">结案对象</span>
          </div>

          <div class="wb-field">
            <div class="wb-field__label">怀疑程度</div>
            <div class="wb-segments">
              <button
                v-for="level in ([0, 1, 2, 3] as SuspicionLevel[])"
                :key="level"
                class="wb-segment"
                :class="{ 'wb-segment--on': dossier?.suspicion === level }"
                @click="setSuspicion(role.name, level)"
              >
                {{ suspicionCopy[level] }}
              </button>
            </div>
          </div>

          <div class="wb-field wb-field--split">
            <div>
              <div class="wb-field__label">时间线</div>
              <div class="wb-pills">
                <button
                  v-for="(label, value) in timelineCopy"
                  :key="value"
                  class="wb-pill"
                  :class="{ 'wb-pill--on': dossier?.timeline === value }"
                  @click="setTimelineStatus(role.name, value)"
                >
                  {{ label }}
                </button>
              </div>
            </div>
            <button
              class="wb-toggle"
              :class="{ 'wb-toggle--on': dossier?.motive }"
              @click="deduction.toggleMotive(role.name)"
            >
              <span>动机</span>
              <strong>{{ dossier?.motive ? '已发现' : '未发现' }}</strong>
            </button>
          </div>

          <div class="wb-evidence-line">
            <span>{{ dossier?.clueIds.length ?? 0 }} 条关联线索</span>
            <button class="mini-btn" @click="openEvidence(role.name)">关联线索</button>
          </div>

          <div v-if="dossier && linkedClues(dossier).length" class="wb-linked">
            <span v-for="clue in linkedClues(dossier).slice(0, 2)" :key="clue.id" class="wb-linked__chip">
              {{ clue.text }}
            </span>
          </div>

          <textarea
            class="textarea wb-note"
            :value="dossier?.note ?? ''"
            maxlength="360"
            placeholder="他/她哪句话最不对劲？"
            @input="deduction.setNote(role.name, ($event.target as HTMLTextAreaElement).value)"
          />

          <button class="btn btn--ghost btn--sm" @click="chooseFinal(role.name)">
            设为结案对象
          </button>
        </article>
      </section>
    </template>

    <template v-else>
      <p class="section-title">你的结论</p>
      <section class="card wb-case-card">
        <div class="field">
          <label class="field__label">最怀疑的人</label>
          <div class="chips">
            <button
              v-for="role in game.roles"
              :key="role.name"
              class="chip"
              :class="{ 'chip--on': deduction.board.finalSuspect === role.name }"
              @click="deduction.setFinalSuspect(role.name)"
            >
              {{ role.name }}
            </button>
          </div>
        </div>

        <div class="field">
          <label class="field__label">核心理由 · 至少两条</label>
          <div class="wb-reason-list">
            <button
              v-for="reason in CASE_REASONS"
              :key="reason"
              class="wb-reason"
              :class="{ 'wb-reason--on': deduction.board.finalReasons.includes(reason) }"
              @click="deduction.toggleReason(reason)"
            >
              <span class="wb-reason__check">{{ deduction.board.finalReasons.includes(reason) ? '✓' : '+' }}</span>
              {{ reason }}
            </button>
          </div>
        </div>

        <div class="field">
          <label class="field__label">一句话收束</label>
          <textarea
            v-model="deduction.board.summary"
            class="textarea"
            style="min-height: 92px"
            maxlength="500"
            placeholder="例如：他的时间线在 22:30 断开，且对戒指上的血迹解释前后不一。"
            @input="deduction.setSummary(($event.target as HTMLTextAreaElement).value)"
          />
        </div>

        <div class="wb-verdict" :class="{ 'wb-verdict--ok': deduction.summary.complete }">
          <div class="wb-verdict__icon">{{ deduction.summary.complete ? '✓' : '!' }}</div>
          <div>
            <strong>{{ deduction.summary.complete ? '可以进入投票' : '还差一点' }}</strong>
            <p>
              {{ deduction.summary.complete
                ? `${deduction.summary.target} · ${deduction.summary.reasonCount} 条理由 · ${deduction.summary.clueCount} 条线索`
                : deduction.summary.missing.join('；') }}
            </p>
          </div>
        </div>

        <div v-if="finalDossier?.note" class="wb-note-preview">
          <span>你的备注</span>
          <p>{{ finalDossier.note }}</p>
        </div>
      </section>

      <p class="section-title">我的笔记</p>
      <section class="card">
        <textarea
          v-model="deduction.board.scratchpad"
          class="textarea"
          style="min-height: 120px"
          placeholder="随手记下还没归类的想法"
          maxlength="1200"
          @input="deduction.setScratchpad(($event.target as HTMLTextAreaElement).value)"
        />
      </section>
    </template>

    <details class="wb-archive">
      <summary>线索原文与归档</summary>
      <div class="wb-archive__body">
        <p class="section-title">已钉住 {{ pinned.length }}</p>
        <div v-if="pinned.length === 0" class="empty">还没有钉住任何线索</div>
        <ClueCard
          v-for="clue in pinned"
          :key="clue.id"
          :clue="clue"
          actionable
          @publish="game.publishClue"
          @pin="game.togglePin"
        />

        <p class="section-title">待归档 {{ available.length }}</p>
        <div v-if="available.length === 0" class="empty">线索都已经归档</div>
        <ClueCard
          v-for="clue in available"
          :key="clue.id"
          :clue="clue"
          actionable
          @publish="game.publishClue"
          @pin="game.togglePin"
        />
      </div>
    </details>
  </main>

  <div class="dock">
    <div class="dock__inner">
      <div class="dock__info">
        {{ deduction.summary.complete ? `结论：${deduction.summary.target}` : deduction.summary.missing[0] || '先做判断，再去投票' }}
      </div>
      <button class="btn btn--blood btn--sm" @click="gotVoting">进入投票</button>
    </div>
  </div>

  <SheetModal
    :open="!!evidenceFor"
    :title="selectedEvidenceRole ? `关联线索 · ${selectedEvidenceRole.name}` : '关联线索'"
    @close="evidenceFor = ''"
  >
    <p class="card__hint" style="margin-bottom: 12px">
      只列出你当前能看到的线索。点击切换关联，不会公开或改动原始线索。
    </p>
    <div v-if="visibleClues.length === 0" class="empty">暂时没有可关联的线索</div>
    <div class="wb-clue-picker">
      <button
        v-for="clue in visibleClues"
        :key="clue.id"
        class="wb-clue-option"
        :class="{
          'wb-clue-option--on': evidenceFor && deduction.board.suspects[evidenceFor]?.clueIds.includes(clue.id),
        }"
        @click="toggleEvidence(clue)"
      >
        <span class="wb-clue-option__check">
          {{ evidenceFor && deduction.board.suspects[evidenceFor]?.clueIds.includes(clue.id) ? '✓' : '+' }}
        </span>
        <span class="wb-clue-option__text">{{ clue.text }}</span>
        <span class="tag">{{ clue.location }}</span>
      </button>
    </div>
  </SheetModal>
</template>
