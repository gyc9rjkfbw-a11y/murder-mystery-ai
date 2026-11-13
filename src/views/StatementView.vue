<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import CountdownPill from '@/components/CountdownPill.vue'
import PhaseStepper from '@/components/PhaseStepper.vue'
import RoleAvatar from '@/components/RoleAvatar.vue'
import SheetModal from '@/components/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import type { ClueItem } from '@/types/script'

const router = useRouter()
const game = useGameStore()
const net = useNetStore()
const toast = useToast()

const autoPlay = ref(true)
const draft = ref('')
const scope = ref<'round' | 'all'>('round')
const taRef = ref<HTMLTextAreaElement | null>(null)
const evidenceOpen = ref(false)
const clueOpen = ref(false)
const inferenceOpen = ref(false)
const selectedEvidence = ref<ClueItem | null>(null)
const inferenceDraft = ref('')
let handle = 0

/** 发言草稿上限：够写一段完整陈述，但不至于把发言刷屏 */
const DRAFT_MAX = 600

/**
 * 草稿按「房间 + 轮次」分开存。
 * 为什么不按轮次存而共用一个 key：第 1 轮的草稿留到第 2 轮会串味；
 * 为什么用 sessionStorage：手机上切后台/误触返回不该把打了一半的字丢掉，
 * 但换台设备重新进房也没必要看到上次的草稿。
 */
function draftKey(): string {
  return `dsh_stmt_draft:${net.inRoom ? net.roomCode || 'room' : 'solo'}:${game.state.round}`
}

function loadDraft() {
  try {
    draft.value = sessionStorage.getItem(draftKey()) ?? ''
  } catch {
    draft.value = ''
  }
}

function saveDraft() {
  try {
    if (draft.value.trim()) sessionStorage.setItem(draftKey(), draft.value)
    else sessionStorage.removeItem(draftKey())
  } catch {
    /* 隐私模式下写不进去，忽略即可 */
  }
}

watch(draft, saveDraft)
watch(draftKey, loadDraft, { immediate: true })

/** 快捷短语：插入到光标处，方便接着改 */
const QUICK_PHRASES = [
  '我先交代时间线：',
  '他说的和我知道的对不上：',
  '我手上有条线索：',
  '我不方便开麦，先说这些：',
]

function insertAtCursor(text: string) {
  const el = taRef.value
  if (!el) {
    draft.value = draft.value ? `${draft.value} ${text}` : text
    return
  }
  const start = el.selectionStart ?? draft.value.length
  const end = el.selectionEnd ?? start
  draft.value = draft.value.slice(0, start) + text + draft.value.slice(end)
  void nextTick(() => {
    el.focus()
    const pos = start + text.length
    el.setSelectionRange(pos, pos)
  })
}

/** 回车发送 / Shift+回车换行；中文输入法组字中的回车不能当发送 */
function onDraftKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  submitSelf()
}

function clearDraft() {
  draft.value = ''
  try {
    sessionStorage.removeItem(draftKey())
  } catch {
    /* 忽略 */
  }
}

const speaker = computed(() => game.currentSpeaker)
const currentHasSpoken = computed(() =>
  speaker.value ? game.roundStatements.some((s) => s.seatId === speaker.value?.id) : false,
)
const myTurn = computed(() => speaker.value?.isSelf === true && !game.selfHasSpoken)
const allSpoken = computed(() => game.allSpoken)
const isSearchRound = computed(() => game.state.round <= game.state.searchRounds)
const isLastRound = computed(() => game.state.round >= game.state.maxRounds)
const selfRole = computed(() => game.selfRole)
const discussionTitle = computed(() => game.state.script?.game_config.theme || '公开讨论')

const selfObjective = computed(() => {
  if (selfRole.value?.is_murderer) return '隐藏真相，避免成为唯一最高票'
  return '找出真凶，并让证据链指向正确的人'
})

/**
 * 「随身任务」有时候是三四百字的长文。侧栏直接铺开会把讨论区挤到屏幕外，
 * 但一直截断又等于让人看不到自己的任务，所以默认折叠 4 行，
 * 溢出时给一个「展开全文」，点开就是完整任务，再点收起。
 */
const taskText = computed(
  () => selfRole.value?.surface_task ?? '先听别人怎么说，再决定亮出哪张牌。',
)
const taskExpanded = ref(false)
const taskOverflow = ref(false)
const taskBodyRef = ref<HTMLElement | null>(null)
let taskObserver: ResizeObserver | null = null

function measureTask() {
  const el = taskBodyRef.value
  if (!el) return
  // 展开态下 max-height 已放开，量不出真实溢出，保留原结论即可
  if (taskExpanded.value) return
  taskOverflow.value = el.scrollHeight > el.clientHeight + 2
}

watch(taskText, async () => {
  taskExpanded.value = false
  await nextTick()
  measureTask()
})

const currentSpeakerIdentity = computed(() => {
  const roleName = speaker.value?.roleName
  if (!roleName) return '身份尚未公开'
  return game.roles.find((role) => role.name === roleName)?.identity ?? '身份尚未公开'
})

const privilege = computed(() => game.state.privilege)
const showPrivilege = computed(
  () => game.canSeePrivilege && !!privilege.value && privilege.value.round <= game.state.round,
)
/**
 * 这条特权到底是「我本人就是凶手所以我能看」，还是「我开了上帝视角」。
 * 两者必须能一眼区分：平民在正常对局里永远不该看到它。
 */
const privilegeIsGodView = computed(() => game.state.godMode && !game.selfRole?.is_murderer)

/** 发言流：本轮 / 全部 */
const feed = computed(() => {
  const all = game.state.statements
  return scope.value === 'round' ? all.filter((s) => s.round === game.state.round) : all
})

/** 玩家发言条数（不含系统播报） */
const spokenCount = computed(() => game.roundStatements.length)

const evidenceCards = computed(() => {
  const seen = new Set<string>()
  return [...game.myClues, ...game.publicClues].filter((clue) => {
    if (seen.has(clue.id)) return false
    seen.add(clue.id)
    return true
  })
})

const dockText = computed(() => {
  if (!allSpoken.value) return `按顺序公开讨论 · 已发言 ${spokenCount.value}/${game.state.seats.length}`
  if (isSearchRound.value) return `本轮讨论结束，进入第 ${game.state.round} 轮搜证`
  if (!isLastRound.value) return '本轮讨论结束，先摸一次底再进下一轮'
  return '本轮讨论结束，将关闭所有人的发言通道'
})

const dockLabel = computed(() => {
  if (isSearchRound.value) return `进入搜证 ›`
  if (!isLastRound.value) return `结束本轮 ›`
  return `关闭发言 ›`
})

const seatOf = (seatId: string) => game.state.seats.find((s) => s.id === seatId)

onMounted(() => {
  if (!game.state.script) {
    router.replace('/')
    return
  }
  if (game.state.phase !== 'statement') game.startStatement()
  handle = window.setInterval(tick, 2600)
  void nextTick(() => {
    measureTask()
    if (typeof ResizeObserver !== 'undefined' && taskBodyRef.value) {
      taskObserver = new ResizeObserver(() => measureTask())
      taskObserver.observe(taskBodyRef.value)
    }
  })
  // 等字体真正落位后再量一次，否则换行位置会算错
  void document.fonts?.ready.then(() => measureTask())
})

onBeforeUnmount(() => {
  if (handle) window.clearInterval(handle)
  taskObserver?.disconnect()
  taskObserver = null
})

function tick() {
  // 联机：发言轮转与 AI 侦探提示都由服务器驱动，本地不要再抢拍
  if (game.state.online) return
  // 防冷场：6 人局本轮过半仍无人开口时，自动给出 AI 侦探提示
  if (game.maybeDetectiveHint()) return
  if (!autoPlay.value || myTurn.value) return
  if (!currentHasSpoken.value) {
    game.speakCurrent()
    return
  }
  if (game.state.statementIndex < game.state.seats.length - 1) {
    game.nextSpeaker()
  } else {
    autoPlay.value = false
  }
}

function speakNow() {
  if (myTurn.value || !currentHasSpoken.value) {
    if (game.speakCurrent()) autoPlay.value = true
  }
}

function next() {
  if (!currentHasSpoken.value) {
    if (myTurn.value) {
      // 轮到自己却直接点「下一位」时，记一条默认发言，
      // 否则这一轮永远凑不齐发言记录，流程会卡死。
      game.selfSpeak(draft.value.trim() || '我暂时不补充，但我记住了每个人说的话。')
      clearDraft()
      autoPlay.value = true
      return
    }
    game.speakCurrent()
  }
  game.nextSpeaker()
}

function submitSelf() {
  const text = draft.value.trim() || '我暂时没有什么要补充的，但我会盯着每个人。'
  game.selfSpeak(text)
  clearDraft()
  autoPlay.value = true
  toast.success('发言已记录')
}

/** 本轮结束：按规则进入搜证 / 轮间摸底 / 关闭发言 */
function finishRound() {
  game.finishStatements()
  // 联机：阶段由服务器改，改完 App.vue 的 watch 会把所有人一起带过去，
  // 这里读到的本地 phase 还是旧的，不能自己 push（否则会把玩家甩到错的页面）。
  if (game.state.online) return
  const phase = game.state.phase
  if (phase === 'search') router.push('/search')
  else if (phase === 'poll') router.push('/poll')
  else if (phase === 'organize') router.push('/organize')
}

/** 房主兜底：真人迟迟不发言时，请服务器跳过当前发言者 */
function skipSpeaker() {
  net.pass()
  toast.info('已请服务器跳过当前发言者')
}

function evidenceName(clue: ClueItem): string {
  const text = clue.text
    .replace(/[，。；、,:：（）()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.slice(0, 10) || '新的线索'
}

function evidenceIcon(clue: ClueItem): string {
  if (/钥匙|锁|门/.test(clue.text)) return '🔑'
  if (/录音|磁带|声音|电话/.test(clue.text)) return '◉'
  if (/账|信|纸|名单|记录/.test(clue.text)) return '📜'
  if (/血|衣|布|伤/.test(clue.text)) return '🩸'
  if (/时间|钟|表/.test(clue.text)) return '⌛'
  return '🔎'
}

function openEvidence(clue: ClueItem) {
  selectedEvidence.value = clue
  evidenceOpen.value = false
  clueOpen.value = true
}

function useSelectedEvidence() {
  const clue = selectedEvidence.value
  if (!clue) return
  const line = `【线索】${clue.text}`
  draft.value = draft.value.trim() ? `${draft.value.trim()}\n${line}` : line
  clueOpen.value = false
  evidenceOpen.value = false
  toast.success(myTurn.value ? '线索已加入发言草稿' : '线索已加入草稿，轮到你时可直接发送')
  void nextTick(() => taRef.value?.focus())
}

function openInference() {
  inferenceDraft.value = game.state.notes
  inferenceOpen.value = true
}

function saveInference() {
  game.state.notes = inferenceDraft.value.trim()
  inferenceOpen.value = false
  toast.success('推理已存入个人整理')
}
</script>

<template>
  <AppTopBar
    :title="`第 ${game.state.round} / ${game.state.maxRounds} 轮公开讨论`"
    :sub="game.currentRoundTheme.title"
    show-back
  >
    <CountdownPill />
  </AppTopBar>
  <PhaseStepper />

  <main class="page discussion-page">
    <header class="discussion-masthead">
      <div class="discussion-masthead__rule"><span /></div>
      <div class="discussion-masthead__kicker">PUBLIC DISCUSSION</div>
      <h1>{{ discussionTitle }}</h1>
      <p>线索 · 动机 · 真相</p>
    </header>

    <div class="discussion-grid">
      <aside class="discussion-panel discussion-role-panel">
        <div class="discussion-panel__head">
          <span>你的角色</span>
        </div>
        <div class="discussion-role__portrait">
          <RoleAvatar
            :role="selfRole"
            :size="104"
            :tone="selfRole?.is_murderer ? 'blood' : 'gold'"
          />
        </div>
        <div class="discussion-role__name">{{ selfRole?.name ?? '等待角色分配' }}</div>
        <div class="discussion-role__camp" :class="selfRole?.is_murderer ? 'is-killer' : 'is-civil'">
          {{ selfRole?.is_murderer ? '凶手阵营' : '平民阵营' }}
        </div>
        <div class="discussion-role__facts">
          <div>
            <span>身份</span>
            <strong>{{ selfRole?.identity ?? '尚未下发' }}</strong>
          </div>
          <div>
            <span>目标</span>
            <strong>{{ selfObjective }}</strong>
          </div>
        </div>
        <div class="discussion-role__task" :class="{ 'is-open': taskExpanded }">
          <span>随身任务</span>
          <p ref="taskBodyRef">{{ taskText }}</p>
          <button
            v-if="taskOverflow"
            type="button"
            class="discussion-role__task-toggle"
            :aria-expanded="taskExpanded ? 'true' : 'false'"
            @click="taskExpanded = !taskExpanded"
          >
            {{ taskExpanded ? '收起' : '展开全文' }}
            <span class="discussion-role__task-caret" aria-hidden="true">▾</span>
          </button>
        </div>
      </aside>

      <section class="discussion-center-column">
        <section class="card round-card discussion-round-card">
          <div class="round-card__head">
            <span class="tag tag--gold">第 {{ game.state.round }} 轮讨论</span>
            <span class="tiny muted">
              {{ spokenCount }} / {{ game.state.seats.length }} 人已发言
            </span>
            <button
              v-if="!game.state.online || net.isHost"
              class="discussion-advance"
              :disabled="!allSpoken"
              @click="finishRound"
            >
              {{ dockLabel }}
            </button>
            <span v-else class="tag">等待房主推进</span>
          </div>
          <p class="round-card__goal">{{ game.currentRoundTheme.goal }}</p>
          <p class="tiny muted discussion-round-card__system">
            系统：{{ game.currentRoundTheme.systemAction }}
          </p>
        </section>

        <section v-if="showPrivilege && privilege" class="privilege discussion-privilege">
          <div class="privilege__head">
            <span>🩸</span>
            <span>凶手特权 · 第 {{ privilege.round }} 轮已解锁</span>
            <span
              class="tag"
              :class="privilegeIsGodView ? 'tag--blood' : 'tag--gold'"
              style="margin-left: auto"
            >
              {{ privilegeIsGodView ? '上帝视角' : '仅你可见' }}
            </span>
          </div>
          <div class="privilege__body">{{ privilege.hint }}</div>
        </section>

    <section class="card discussion-current-speaker">
      <div style="display: flex; align-items: center; gap: 10px">
        <div class="speech__avatar">{{ speaker?.avatar ?? '？' }}</div>
        <div style="flex: 1; min-width: 0">
          <div class="seat__name">
            {{ speaker?.name ?? '—' }}
            <span v-if="myTurn" class="tag tag--gold" style="margin-left: 6px">轮到你</span>
          </div>
          <div class="seat__meta">
            {{ currentSpeakerIdentity }}
          </div>
        </div>
        <button
          v-if="!game.state.online"
          class="mini-btn"
          :class="{ 'mini-btn--on': autoPlay }"
          @click="autoPlay = !autoPlay"
        >
          {{ autoPlay ? '自动播放中' : '自动播放' }}
        </button>
        <button
          v-if="game.state.online && net.isHost && !myTurn && speaker"
          class="mini-btn"
          @click="skipSpeaker"
        >
          跳过 TA
        </button>
      </div>

      <!-- 联机时发言由服务器轮转，这两个按钮只对单机模拟有意义 -->
      <div v-if="!game.state.online" class="btn-row">
        <button class="btn btn--ghost btn--sm" :disabled="myTurn" @click="speakNow">听他说</button>
        <button class="btn btn--ghost btn--sm" @click="next">下一位 ›</button>
      </div>
    </section>

    <section v-if="myTurn" class="card discussion-composer">
      <h3 class="card__title">轮到你发言（第 {{ game.state.round }} 轮）</h3>
      <p class="card__hint" style="margin-bottom: 10px">
        {{
          game.state.round <= 1
            ? '先把案发前后的行踪交代清楚，可以照着表层任务说，也可以主动把水搅浑。'
            : game.state.round < game.state.maxRounds
              ? '抓住上一轮的矛盾点追问，也可以把话题引到别人的秘密上。'
              : '别再纠结细枝末节了，把线索和时间线串起来，指向具体的人。'
        }}
      </p>

      <!-- 打字端：快捷短语 + 草稿保护 + 回车发送 -->
      <div class="chips" style="margin-bottom: 8px">
        <button
          v-for="p in QUICK_PHRASES"
          :key="p"
          class="chip"
          type="button"
          @click="insertAtCursor(p)"
        >
          {{ p }}
        </button>
      </div>
      <textarea
        ref="taRef"
        v-model="draft"
        class="textarea"
        :maxlength="DRAFT_MAX"
        enterkeyhint="send"
        autocomplete="off"
        placeholder="例如：我先说。案发那半小时我在二层走廊，有人可以为我作证……（回车发送 · Shift+回车换行）"
        @keydown="onDraftKeydown"
      />
      <div class="draft-meta">
        <span class="tiny muted">草稿会自动留在本机，误触返回也丢不了</span>
        <span v-if="draft.length > DRAFT_MAX - 200" class="tiny muted">
          {{ draft.length }} / {{ DRAFT_MAX }}
        </span>
      </div>

      <button class="btn btn--primary" style="margin-top: 10px" @click="submitSelf">
        说完了 · 记录发言
      </button>

      <!-- 语音端：说不清楚就直接开麦 -->
      <div v-if="game.state.online" class="btn-row" style="margin-top: 8px">
        <button class="btn btn--ghost btn--sm" @click="net.openTalk('voice')">
          🎙 {{ net.inVoice ? '在麦上' : '开麦说' }}<template v-if="net.voiceCount"> · {{ net.voiceCount }} 人</template>
        </button>
        <button class="btn btn--ghost btn--sm" @click="net.openTalk('chat')">
          💬 公屏<template v-if="net.unread"> {{ net.unread }}</template>
        </button>
      </div>
    </section>

    <!-- 不是我的轮次：想插话就开麦，或者去公屏打字（打字端的存在意义就在这里） -->
    <section
      v-else-if="game.state.online && speaker && !currentHasSpoken"
      class="card discussion-whisper-tip"
      style="display: flex; align-items: center; gap: 8px"
    >
      <span class="tiny muted" style="flex: 1">
        轮到 {{ speaker.name }} 发言 · 想补充可以开麦插话，也可以在公屏打字
      </span>
      <button class="btn btn--ghost btn--sm" @click="net.openTalk('voice')">🎙 开麦</button>
      <button class="btn btn--ghost btn--sm" @click="net.openTalk('chat')">💬 打字</button>
    </section>

    <div class="feed-head discussion-feed-head">
      <p class="section-title" style="margin: 0">
        发言记录 {{ spokenCount }} / {{ game.state.seats.length }}
      </p>
      <div class="seg">
        <button class="seg__btn" :class="{ 'seg__btn--on': scope === 'round' }" @click="scope = 'round'">
          本轮
        </button>
        <button class="seg__btn" :class="{ 'seg__btn--on': scope === 'all' }" @click="scope = 'all'">
          全部
        </button>
      </div>
    </div>

    <section class="discussion-feed">
      <div v-if="feed.length === 0" class="empty">还没有人开口</div>
      <template v-for="(s, i) in feed" :key="i">
        <div v-if="s.kind === 'system'" class="sysmsg">
          <div class="sysmsg__title">
            <span>📣</span>{{ s.title ?? '系统播报' }}
            <span class="tiny muted" style="margin-left: auto">第 {{ s.round }} 轮</span>
          </div>
          <div class="sysmsg__body">{{ s.text }}</div>
        </div>
        <div
          v-else
          class="speech"
          :class="{ 'speech--self': s.seatId === game.state.selfSeatId }"
        >
          <div class="speech__avatar">{{ seatOf(s.seatId)?.avatar ?? '🎭' }}</div>
          <div style="flex: 1; min-width: 0">
            <div class="speech__name">
              {{ seatOf(s.seatId)?.name ?? '未知' }} · {{ s.roleName }}
              <span class="tiny muted" style="margin-left: 6px">第 {{ s.round }} 轮</span>
            </div>
            <div class="speech__bubble">{{ s.text }}</div>
          </div>
        </div>
      </template>
    </section>
      </section>

      <aside class="discussion-panel discussion-evidence-panel">
        <div class="discussion-panel__head">
          <span>证据链</span>
        </div>
        <p class="discussion-evidence__hint">点击证物，可把线索直接加入发言草稿。</p>
        <div v-if="evidenceCards.length" class="discussion-evidence__grid">
          <button
            v-for="clue in evidenceCards.slice(0, 6)"
            :key="clue.id"
            class="discussion-evidence-card"
            @click="openEvidence(clue)"
          >
            <span class="discussion-evidence-card__icon">{{ evidenceIcon(clue) }}</span>
            <strong>{{ evidenceName(clue) }}</strong>
            <small>{{ clue.published ? '公开线索' : clue.isPrivate ? '私有线索' : clue.location }}</small>
          </button>
        </div>
        <div v-else class="discussion-evidence__empty">
          <span>◇</span>
          <strong>证据链尚未建立</strong>
          <p>留意系统发放的公共线索，也可以把自己的私有线索带进讨论。</p>
        </div>
        <button class="discussion-evidence__more" @click="evidenceOpen = true">
          查看全部证据
          <span>{{ evidenceCards.length }}</span>
        </button>
      </aside>
    </div>
  </main>

  <div class="dock discussion-dock">
    <div class="discussion-dock__status">
      <span>{{ dockText }}</span>
      <small>{{ game.currentRoundTheme.title }}</small>
    </div>
    <div class="discussion-actions">
      <button class="discussion-action discussion-action--infer" @click="openInference">
        <span aria-hidden="true">⚖</span>
        提交推理
      </button>
      <button class="discussion-action discussion-action--clue" @click="evidenceOpen = true">
        <span aria-hidden="true">✦</span>
        使用线索
      </button>
      <button class="discussion-action" @click="router.push('/reading')">
        <span aria-hidden="true">▤</span>
        查看剧本
      </button>
    </div>
  </div>

  <SheetModal :open="inferenceOpen" title="记录当前推理" @close="inferenceOpen = false">
    <p class="card__hint" style="margin-bottom: 10px">
      写下目前最怀疑的人、动机和证据。进入个人整理阶段后，这份内容会继续保留。
    </p>
    <textarea
      v-model="inferenceDraft"
      class="textarea discussion-inference-input"
      maxlength="1200"
      placeholder="例如：我怀疑管家。22:15 的钥匙记录和他的证词对不上，染血披肩也应该能解释作案路线……"
    />
    <div class="discussion-inference__meta">
      <span>{{ inferenceDraft.length }} / 1200</span>
      <button class="btn btn--primary btn--sm" @click="saveInference">保存推理</button>
    </div>
  </SheetModal>

  <SheetModal :open="evidenceOpen" title="选择一条线索" @close="evidenceOpen = false">
    <p class="card__hint" style="margin-bottom: 10px">
      公共线索与你自己掌握的线索会出现在这里。选中后可加入发言草稿。
    </p>
    <div v-if="evidenceCards.length" class="discussion-evidence-list">
      <button
        v-for="clue in evidenceCards"
        :key="clue.id"
        class="discussion-evidence-option"
        @click="openEvidence(clue)"
      >
        <span class="discussion-evidence-card__icon">{{ evidenceIcon(clue) }}</span>
        <span>
          <strong>{{ evidenceName(clue) }}</strong>
          <small>{{ clue.text }}</small>
        </span>
      </button>
    </div>
    <div v-else class="discussion-evidence__empty">
      <span>◇</span>
      <strong>暂时还没有可用线索</strong>
      <p>系统会在轮次推进时发放线索。</p>
    </div>
  </SheetModal>

  <SheetModal :open="clueOpen" title="证物详情" @close="clueOpen = false">
    <div v-if="selectedEvidence" class="discussion-clue-detail">
      <div class="discussion-clue-detail__icon">{{ evidenceIcon(selectedEvidence) }}</div>
      <div class="discussion-clue-detail__source">
        {{ selectedEvidence.published ? '公开线索' : selectedEvidence.isPrivate ? '私有线索' : selectedEvidence.location }}
      </div>
      <p>{{ selectedEvidence.text }}</p>
      <button class="btn btn--primary" @click="useSelectedEvidence">
        把这条线索加入发言
      </button>
    </div>
  </SheetModal>
</template>
