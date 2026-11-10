<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import CountdownPill from '@/components/CountdownPill.vue'
import PhaseStepper from '@/components/PhaseStepper.vue'
import { useToast } from '@/composables/useToast'
import { readingTimeText } from '@/services/rules'
import { buildStoryActs } from '@/services/storyActs'
import { scriptLength } from '@/services/templates/assemble'
import { useGameStore } from '@/stores/game'

const router = useRouter()
const game = useGameStore()
const toast = useToast()

const script = computed(() => game.state.script)
const role = computed(() => game.viewingRole)
const isSelf = computed(() => role.value?.name === game.selfRole?.name)

/** 只看时间线：6 人局长剧本容易读累，这个开关能把无关描写折叠掉 */
const timelineOnly = ref(false)
const flashId = ref('')
const activeAct = ref(0)
const visitedActs = ref<number[]>([0])

/**
 * 时间点识别
 * ------------------------------------------------------------------
 * 真实大模型写时间点的方式非常不统一：既可能写 `22:30`，也可能写
 * 「凌晨两点」「第二天一早」。这里把常见形态都覆盖进来，
 * 保证「高亮关键时间点」在任何题材、任何写法下都不会失效。
 */
const DAY_PART =
  '(?:凌晨|清晨|拂晓|早上|上午|中午|正午|下午|傍晚|黄昏|入夜|夜里|晚上|深夜|半夜|午夜|后半夜|次日|翌日|第二天)'
const CLOCK = [
  '\\d{1,2}\\s*[:：]\\s*\\d{2}', // 22:30
  '\\d{1,2}\\s*[点时](?:\\s*(?:\\d{1,2}|半)\\s*分?)?', // 22点 / 9时30分 / 9点半
  '[一二三四五六七八九十两]{1,3}\\s*点(?:\\s*(?:[一二三四五六七八九十]{1,3}|半)\\s*分?)?', // 凌晨两点 / 五点半
].join('|')

/** 每次都返回新的正则，避免 /g/ 的 lastIndex 状态在多次调用间互相污染 */
function timeRe(): RegExp {
  return new RegExp(`${DAY_PART}?\\s*(?:${CLOCK})|${DAY_PART}|案发前|案发后|案发时`, 'g')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 高亮关键时间点（先转义再插标签，避免内容里的尖括号破坏结构） */
function highlight(text: string): string {
  return escapeHtml(text).replace(timeRe(), (m) => `<mark class="time-mark">${m}</mark>`)
}

function extractTimes(text: string): string[] {
  const out: string[] = []
  const re = timeRe()
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const v = m[0].replace(/\s/g, '')
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** 剧本段落：保留原始下标，供「目录导航 / 时间线定位」滚动定位 */
const paragraphs = computed(() => {
  const text = role.value?.full_script ?? ''
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line, i) => ({
      line,
      index: i,
      rule: /^其[一二三四五]/.test(line),
      times: extractTimes(line),
    }))
    .filter((paragraph) => !/^【.+】$/.test(paragraph.line))
})

const acts = computed(() => buildStoryActs(role.value?.full_script ?? ''))
const currentAct = computed(() => acts.value[activeAct.value] ?? acts.value[0])
const currentActParagraphs = computed(() => {
  if (!currentAct.value) return []
  const byIndex = new Map(paragraphs.value.map((paragraph) => [paragraph.index, paragraph]))
  return currentAct.value.paragraphs
    .map((paragraph) => byIndex.get(paragraph.sourceIndex))
    .filter((paragraph): paragraph is NonNullable<typeof paragraph> => Boolean(paragraph))
})

const visibleParagraphs = computed(() =>
  timelineOnly.value ? paragraphs.value.filter((p) => p.times.length > 0) : currentActParagraphs.value,
)

const visitedCount = computed(
  () => visitedActs.value.filter((index) => index >= 0 && index < acts.value.length).length,
)
const actProgress = computed(() =>
  acts.value.length > 0 ? Math.round((visitedCount.value / acts.value.length) * 100) : 0,
)

/** 时间线导航：把插在剧本里的时间点抽成快捷跳转项 */
const timeIndex = computed(() =>
  paragraphs.value
    .filter((p) => p.times.length > 0)
    .flatMap((p) => p.times.slice(0, 1).map((t) => ({ label: t, index: p.index }))),
)

const sections = computed(() => {
  const list = [
    { id: 'sec-bg', label: '背景' },
    { id: 'sec-role', label: '角色档案' },
    { id: 'sec-script', label: '剧本正文' },
  ]
  if ((role.value?.side_quests ?? []).length > 0) list.push({ id: 'sec-quest', label: '支线任务' })
  if (privateClues.value.length > 0) list.push({ id: 'sec-clue', label: '私有线索' })
  return list
})

const privateClues = computed(() =>
  game.state.clues.filter((c) => c.ownerRoleName === role.value?.name),
)

const wordCount = computed(() => scriptLength(role.value?.full_script ?? ''))
/** 沉浸版剧本统一启用目录导航与时间高亮（4/5/6 人局均为 1500 字以上） */
const longScript = computed(() => wordCount.value > 1200)
const sideQuests = computed(() => role.value?.side_quests ?? [])

const readDone = computed(() => game.selfSeat?.readConfirmed === true)
const allRead = computed(() => game.allRead)

onMounted(() => {
  if (!game.state.script) router.replace('/')
  if (game.state.phase === 'dealing' || game.state.phase === 'room') game.setPhase('reading')
  activeAct.value = 0
  visitedActs.value = [0]
})

function scrollTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  flashId.value = id
  window.setTimeout(() => {
    if (flashId.value === id) flashId.value = ''
  }, 1200)
}

function jumpToParagraph(index: number) {
  if (timelineOnly.value) timelineOnly.value = false
  const targetAct = acts.value.findIndex((act) =>
    act.paragraphs.some((paragraph) => paragraph.sourceIndex === index),
  )
  if (targetAct >= 0) openAct(targetAct, false)
  nextTick(() => scrollTo(`para-${index}`))
}

function openAct(index: number, moveToTop = true) {
  const next = Math.max(0, Math.min(acts.value.length - 1, index))
  activeAct.value = next
  timelineOnly.value = false
  if (!visitedActs.value.includes(next)) visitedActs.value.push(next)
  if (!moveToTop) return
  nextTick(() => {
    const target = document.getElementById('sec-script')
    if (!target) return
    window.scrollTo({ top: Math.max(0, target.offsetTop - 76), behavior: 'smooth' })
  })
}

function previousAct() {
  if (activeAct.value > 0) openAct(activeAct.value - 1)
}

function nextAct() {
  if (activeAct.value < acts.value.length - 1) {
    openAct(activeAct.value + 1)
    return
  }
  confirmRead()
}

function confirmRead() {
  game.confirmReading()
  toast.success('已确认读完，请记住你的秘密')
}

function gotoStatement() {
  game.startStatement()
  // 联机：阶段由服务器统一改，改完 App.vue 会把所有人一起带到陈述页
  if (game.state.online) return
  router.push('/statement')
}

function switchRole(index: number) {
  if (!game.state.godMode) {
    toast.warn('只有单人演示模式可以切换角色')
    return
  }
  game.viewRole(index)
  timelineOnly.value = false
  activeAct.value = 0
  visitedActs.value = [0]
}
</script>

<template>
  <AppTopBar :title="script?.game_config.theme ?? '阅读剧本'" sub="阅读阶段" show-back>
    <CountdownPill />
  </AppTopBar>
  <PhaseStepper />

  <main class="page">
    <p v-if="game.state.godMode" class="section-title">
      上帝视角（演示）· 可切换任意角色，🩸 标记的是真凶
    </p>
    <div v-if="game.state.godMode" class="stepper" style="padding: 0 0 6px; margin-bottom: 6px">
      <button
        v-for="(r, i) in game.roles"
        :key="r.name"
        class="stepper__item"
        :class="{ 'stepper__item--now': i === game.state.readingRoleIndex }"
        @click="switchRole(i)"
      >
        {{ r.name }}{{ r.is_murderer ? ' 🩸' : '' }}
      </button>
    </div>

    <!-- 目录导航：长剧本专用，免得在 1000+ 字里迷路 -->
    <nav v-if="longScript" class="toc">
      <div class="toc__row">
        <span class="toc__label">目录</span>
        <button v-for="s in sections" :key="s.id" class="toc__chip" @click="scrollTo(s.id)">
          {{ s.label }}
        </button>
      </div>
      <div v-if="timeIndex.length" class="toc__row">
        <span class="toc__label">时间</span>
        <button
          v-for="t in timeIndex"
          :key="t.label + t.index"
          class="toc__chip toc__chip--time"
          @click="jumpToParagraph(t.index)"
        >
          {{ t.label }}
        </button>
      </div>
    </nav>

    <section v-if="longScript" class="card reading-meta">
      <div style="display: flex; align-items: center; gap: 10px">
        <span style="font-size: 20px">📖</span>
        <div style="flex: 1; min-width: 0">
          <div class="small bold">本局阅读时长 {{ readingTimeText(game.rule.readingSeconds) }}</div>
          <div class="tiny muted">
            你的剧本 {{ wordCount }} 字（{{ game.state.seats.length }} 人局标准
            {{ game.rule.scriptMin }}-{{ game.rule.scriptMax }} 字）· 已浏览
            {{ visitedCount }}/{{ acts.length }} 幕
          </div>
          <div class="act-progress" :aria-label="`阅读进度 ${actProgress}%`">
            <span :style="{ width: `${actProgress}%` }" />
          </div>
        </div>
        <button
          class="mini-btn"
          :class="{ 'mini-btn--on': timelineOnly }"
          @click="timelineOnly = !timelineOnly"
        >
          {{ timelineOnly ? '只看时间线中' : '只看时间线' }}
        </button>
      </div>
    </section>

    <section v-if="script" id="sec-bg" class="card" :class="{ flash: flashId === 'sec-bg' }">
      <h3 class="card__title">故事背景</h3>
      <p class="serif" style="margin: 0; line-height: 1.95; color: #dcd9d3">
        {{ script.game_config.background_story }}
      </p>
    </section>

    <section v-if="role" id="sec-role" class="card" :class="{ flash: flashId === 'sec-role' }">
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px">
        <div style="font-size: 26px">🎭</div>
        <div style="flex: 1; min-width: 0">
          <div style="font-size: 19px; font-weight: 700; letter-spacing: 0.06em">
            {{ role.name }}
          </div>
          <div class="small muted">{{ role.identity }}</div>
        </div>
        <span v-if="isSelf" class="tag tag--gold">你的角色</span>
        <span v-else class="tag">上帝视角 · 他人剧本</span>
      </div>

      <!--
        阵营卡：每个人开局就必须明确知道「自己是好人还是凶手」以及各自的胜负条件。
        这里只描述**当前查看的这个角色自己**的立场，不会泄露其他角色。
      -->
      <div class="camp" :class="role.is_murderer ? 'camp--killer' : 'camp--civil'">
        <span class="camp__badge">{{ role.is_murderer ? '凶手' : '平民' }}</span>
        <span class="camp__text">
          <template v-if="isSelf && role.is_murderer">
            你<strong>就是</strong>本案真凶。只要最终投票里你不是<strong>唯一</strong>最高票，凶手阵营就赢 ——
            平票、投错人、甚至没人投你，都算你逃脱。
          </template>
          <template v-else-if="isSelf">
            你是<strong>清白</strong>的。只有最终投票把真凶投成<strong>唯一</strong>最高票，平民阵营才赢；
            平票或投错人，凶手就逃脱了。
          </template>
          <template v-else-if="role.is_murderer">
            （上帝视角）{{ role.name }} 是本案真凶，胜负条件同上：不被投成唯一最高票即逃脱。
          </template>
          <template v-else>（上帝视角）{{ role.name }} 是清白的平民。</template>
        </span>
      </div>

      <div class="divider" />

      <div class="kv">
        <span class="kv__k">表层任务</span>
        <span class="kv__v">{{ role.surface_task }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">深层任务</span>
        <span class="kv__v">{{ role.deep_task }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">行动轨迹</span>
        <span class="kv__v">{{ role.personal_timeline }}</span>
      </div>
      <div v-if="role.is_murderer" class="kv">
        <span class="kv__k">你的处境</span>
        <span class="kv__v blood bold">本案是你动的手 —— 别被投成唯一最高票</span>
      </div>
      <div v-else class="kv">
        <span class="kv__k">你的处境</span>
        <span class="kv__v gold bold">你是清白的 —— 找出真凶并说服其他人</span>
      </div>
    </section>

    <article v-if="role" id="sec-script" class="card" :class="{ flash: flashId === 'sec-script' }">
      <div class="act-reader__head">
        <div class="act-reader__heading">
          <div class="act-reader__kicker">
            {{ timelineOnly ? '时间线速览' : `第 ${activeAct + 1} 幕 / 共 ${acts.length} 幕` }}
          </div>
          <h3 class="act-reader__title">
            {{ timelineOnly ? '关键时间点' : currentAct?.title ?? '你的剧本' }}
          </h3>
          <p class="act-reader__subtitle">
            {{
              timelineOnly
                ? '只保留剧本里带有时间、钟点或案发节点的段落'
                : currentAct?.subtitle
            }}
          </p>
        </div>
        <span class="tag tag--gold">
          {{ timelineOnly ? `${timeIndex.length} 个节点` : `${currentAct?.charCount ?? 0} 字` }}
        </span>
      </div>

      <nav v-if="!timelineOnly" class="act-tabs" role="tablist" aria-label="剧本幕次">
        <button
          v-for="(act, index) in acts"
          :key="act.id + index"
          class="act-tab"
          :class="{ 'act-tab--on': index === activeAct }"
          role="tab"
          :aria-selected="index === activeAct"
          @click="openAct(index)"
        >
          <span>{{ act.title.split(' · ')[0] }}</span>
          <small>{{ act.title.split(' · ')[1] }}</small>
          <i v-if="visitedActs.includes(index)" aria-hidden="true">✓</i>
        </button>
      </nav>
      <div v-else class="timeline-notice">
        <span class="tag">全剧本</span>
        共找到 {{ timeIndex.length }} 个关键时间点，点击顶部时间标签可直接定位。
      </div>

      <Transition name="act-swap" mode="out-in">
        <div :key="timelineOnly ? 'timeline' : currentAct?.id ?? 'empty'" class="script-body act-panel">
          <p
            v-for="p in visibleParagraphs"
            :id="`para-${p.index}`"
            :key="p.index"
            :class="{ gold: p.rule, flash: flashId === `para-${p.index}` }"
            v-html="highlight(p.line)"
          />
          <p v-if="visibleParagraphs.length === 0" class="muted">
            {{ timelineOnly ? '你的剧本里没有明确的时间点' : '这一幕没有正文' }}
          </p>
        </div>
      </Transition>

      <div v-if="!timelineOnly" class="act-controls">
        <button class="mini-btn" :disabled="activeAct === 0" @click="previousAct">‹ 上一幕</button>
        <span>{{ activeAct + 1 }} / {{ acts.length }}</span>
        <button class="mini-btn mini-btn--gold" @click="nextAct">
          {{ activeAct === acts.length - 1 ? '读完本幕' : '下一幕 ›' }}
        </button>
      </div>
    </article>

    <article
      v-if="sideQuests.length"
      id="sec-quest"
      class="card"
      :class="{ flash: flashId === 'sec-quest' }"
    >
      <h3 class="card__title">独立支线任务</h3>
      <p class="card__hint" style="margin-bottom: 10px">
        这些和主线案件没有直接关系，但同样要藏住——它们会是别人追问你的抓手。
      </p>
      <div v-for="(q, i) in sideQuests" :key="i" class="quest">
        <span class="quest__no">{{ i + 1 }}</span>
        <span>{{ q }}</span>
      </div>
    </article>

    <article
      v-if="privateClues.length"
      id="sec-clue"
      class="card"
      :class="{ flash: flashId === 'sec-clue' }"
    >
      <h3 class="card__title">你的私有线索</h3>
      <p class="card__hint" style="margin-bottom: 10px">这些是你自己知道的，别人不知道。</p>
      <div v-for="c in privateClues" :key="c.id" class="clue clue--private">
        <div class="clue__text">{{ c.text }}</div>
      </div>
    </article>

    <p v-if="!role" class="empty">剧本还没下发</p>
  </main>

  <div class="dock">
    <div class="dock__inner">
      <div class="dock__info">
        <template v-if="readDone">
          已确认读完
          <template v-if="allRead"> · 全部玩家就绪</template>
        </template>
        <template v-else>
          <template v-if="timelineOnly">时间线速览中 · 关闭后继续分幕阅读</template>
          <template v-else>
            已浏览 {{ visitedCount }}/{{ acts.length }} 幕
            <template v-if="activeAct < acts.length - 1"> · 读完这一幕再继续</template>
          </template>
        </template>
      </div>
      <button
        v-if="!readDone && !timelineOnly && activeAct < acts.length - 1"
        class="btn btn--primary btn--sm"
        @click="nextAct"
      >
        进入第 {{ activeAct + 2 }} 幕
      </button>
      <button v-else-if="!readDone" class="btn btn--primary btn--sm" @click="confirmRead">
        我已读完
      </button>
      <button v-else class="btn btn--primary btn--sm" @click="gotoStatement">
        进入第 1 轮陈述
      </button>
    </div>
  </div>
</template>
