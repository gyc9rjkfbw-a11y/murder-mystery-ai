<script setup lang="ts">
/**
 * 公屏文字面板（沟通面板里的「打字」那一块）
 * ==========================================================================
 * 职责边界（刻意收窄）：
 *   - 只负责渲染 messages + 收集输入，**不碰 store、不发网络请求、不管路由**；
 *     真正发送由父级监听 `send` 后自己走 net store。
 *   - 语音（麦克风 / 成员列表）不在这个组件里，由父级底部弹层的另一个 tab 负责。
 *
 * 安全：消息是别人发来的不可信内容，全程用 `{{ }}` 文本插值，**绝不使用 v-html**。
 *
 * 自动滚动策略（最容易被写坏的地方，所以显式写清楚）：
 *   1. 只有一个「是否贴底」的状态 `atBottom`，由用户的滚动事件维护
 *      （距底 < 80px 视为贴底，此时清掉未读提示）。
 *   2. 新消息到达时：
 *        - 贴底 → 直接滚到底（行为保持自然，不会被硬拽）；
 *        - 用户正在往上翻 → **一动不动**，只把「↓ 有新消息」按钮点亮，
 *          用户点了才滚到底并恢复自动滚动。
 *   3. 自己发消息 = 明确的「我要看最新」意图 → 强制回底并恢复贴底。
 *   4. 容器尺寸变化（v-show 切 tab、旋屏、键盘顶起）时按当前状态重算：
 *        - 贴底就重新贴底；不贴底就只更新按钮可见性，不抢用户的阅读位置。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { CHAT_MAX_LEN, chatTimeText } from '@/services/net/protocol'
import type { ChatMessage } from '@/services/net/protocol'
import '@/styles/chat.css'

interface Props {
  /** 公屏消息（已按时间正序，最新在最后） */
  messages: ChatMessage[]
  /** 我自己的 seatId：用来把「我发的」气泡放右边、昵称标金色 */
  mySeatId: string
  /** 输入框是否被禁用（例如断线重连中） */
  disabled?: boolean
  /** 面板高度（父级底部弹层里用） */
  height?: string
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  height: '46vh',
})

const emit = defineEmits<{
  /** 用户发一条文字（组件自己负责 trim、非空校验、清空输入框、滚动到底部） */
  (e: 'send', text: string): void
  /** 组件无法发送时的提示（比如空内容），父级可以用 Toast 展示；也可以不实现 */
  (e: 'notice', text: string): void
}>()

/** 草稿 key：组件卸载 / 切 tab 后回来不该丢字 */
const DRAFT_KEY = 'dsh_chat_draft'
/** 距底部多少像素以内算「贴着底」 */
const NEAR_BOTTOM_PX = 80
/** 超过这个字数才显示计数，平时不干扰 */
const COUNT_VISIBLE_FROM = 160
/** 接近上限的提示色阈值 */
const COUNT_WARN_FROM = 190

/** 快捷短语：点击只**填入**输入框，不直接发送，方便用户改 */
const QUICK_PHRASES = ['我有线索要说', '我时间线对不上', '我反对这个说法', '稍等我看下剧本'] as const

interface Row {
  msg: ChatMessage
  /** 是不是我发的 */
  mine: boolean
  /** 是否显示昵称（同一个人连发时只在第一条显示） */
  showName: boolean
  /** 是否与上一条同一个人（间距收紧） */
  cont: boolean
}

const scroller = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
const draft = ref('')
/** 是否贴着底（即「自动滚动还生效」） */
const atBottom = ref(true)
/** 用户翻历史时来了新消息 → 点亮「↓ 有新消息」 */
const hasNew = ref(false)

/* ------------------------------------------------------------------ *
 * 渲染数据
 * ------------------------------------------------------------------ */

const rows = computed<Row[]>(() => {
  let prevSeatId = ''
  return props.messages.map((msg) => {
    const showName = msg.seatId !== prevSeatId
    prevSeatId = msg.seatId
    return {
      msg,
      // mySeatId 为空（还没入座）时不要误判成「我发的」
      mine: props.mySeatId !== '' && msg.seatId === props.mySeatId,
      showName,
      cont: !showName,
    }
  })
})

const canSend = computed(() => !props.disabled && draft.value.trim().length > 0)
const count = computed(() => draft.value.length)
const showCount = computed(() => count.value > COUNT_VISIBLE_FROM)
const countClass = computed(() => {
  if (count.value >= CHAT_MAX_LEN) return 'chat__count--full'
  if (count.value >= COUNT_WARN_FROM) return 'chat__count--near'
  return ''
})

/** 只在最后一条变化时触发（长度或 id 变了都算） */
const tailKey = computed(() => {
  const n = props.messages.length
  const last = n > 0 ? props.messages[n - 1] : null
  return last ? `${n}:${last.id}` : '0'
})

/* ------------------------------------------------------------------ *
 * 自动滚动
 * ------------------------------------------------------------------ */

function onScroll() {
  const el = scroller.value
  // 容器还没布局出来（隐藏的 tab）时不要下结论，否则会误亮「有新消息」
  if (!el || el.clientHeight === 0) return
  const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
  atBottom.value = near
  if (near) hasNew.value = false
}

function scrollToBottom(behavior: ScrollBehavior = 'auto') {
  const el = scroller.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior })
  atBottom.value = true
  hasNew.value = false
}

function smoothBehavior(): ScrollBehavior {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'auto'
  }
  return 'smooth'
}

function jumpToLatest() {
  scrollToBottom(smoothBehavior())
}

watch(tailKey, async () => {
  await nextTick()
  const el = scroller.value
  if (!el) return
  if (atBottom.value) scrollToBottom('auto')
  else hasNew.value = true
})

/* ------------------------------------------------------------------ *
 * 草稿
 * ------------------------------------------------------------------ */

function loadDraft(): string {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY) ?? ''
    // 上限可能被调小过，兜一层，避免旧草稿一发就被服务端拒
    return raw.length > CHAT_MAX_LEN ? raw.slice(0, CHAT_MAX_LEN) : raw
  } catch {
    return ''
  }
}

function persistDraft() {
  try {
    if (draft.value) sessionStorage.setItem(DRAFT_KEY, draft.value)
    else sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    /* 隐私模式下 sessionStorage 不可用，忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 输入框
 * ------------------------------------------------------------------ */

/** 单行起步，随内容增高到最多 3 行（上限从 CSS 的 max-height 读，避免两处写死） */
function resizeInput() {
  const el = inputEl.value
  if (!el) return
  const cs = window.getComputedStyle(el)
  const border =
    (Number.parseFloat(cs.borderTopWidth) || 0) + (Number.parseFloat(cs.borderBottomWidth) || 0)
  const maxRaw = Number.parseFloat(cs.maxHeight)
  const cap = Number.isFinite(maxRaw) ? maxRaw : 94
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight + border, cap)}px`
}

function focusInput() {
  const el = inputEl.value
  if (!el || props.disabled) return
  el.focus()
  const end = el.value.length
  el.setSelectionRange(end, end)
}

function onInput(e: Event) {
  const el = e.target as HTMLTextAreaElement
  // 显式从事件取值，不依赖 v-model 与 @input 的执行顺序
  draft.value = el.value
  resizeInput()
  persistDraft()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter') return
  // 中文输入法组字中的回车是「选词」，绝不当成发送
  if (e.isComposing || e.keyCode === 229) return
  // Shift + 回车 = 换行
  if (e.shiftKey) return
  e.preventDefault()
  send()
}

function send() {
  if (props.disabled) return
  const text = draft.value.trim()
  if (!text) {
    emit('notice', '先说点什么再发送')
    return
  }
  if (text.length > CHAT_MAX_LEN) {
    emit('notice', `一条最多 ${CHAT_MAX_LEN} 个字`)
    return
  }
  emit('send', text)
  draft.value = ''
  persistDraft()
  // 发完必须回到最新一条：这是明确的「我要看最新」意图
  nextTick(() => {
    resizeInput()
    scrollToBottom('auto')
    focusInput()
  })
}

function usePhrase(phrase: string) {
  if (props.disabled) return
  const next = draft.value ? `${draft.value}${phrase}` : phrase
  if (next.length > CHAT_MAX_LEN) {
    emit('notice', '输入框快满了，先精简一下再补短语')
    return
  }
  draft.value = next
  persistDraft()
  nextTick(() => {
    resizeInput()
    focusInput()
  })
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

let resizeObserver: ResizeObserver | null = null

onMounted(async () => {
  draft.value = loadDraft()
  await nextTick()
  resizeInput()
  scrollToBottom('auto')
  // 恢复草稿时把光标放到末尾，接着写就行
  const el = inputEl.value
  if (el && draft.value) {
    const end = el.value.length
    el.setSelectionRange(end, end)
  }
  if (typeof ResizeObserver !== 'undefined' && scroller.value) {
    resizeObserver = new ResizeObserver(() => {
      // 贴底就继续贴底；在翻历史就只重算按钮可见性，不抢阅读位置
      if (atBottom.value) scrollToBottom('auto')
      else onScroll()
    })
    resizeObserver.observe(scroller.value)
  }
})

onBeforeUnmount(() => {
  persistDraft()
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <section
    class="chat"
    :class="{ 'chat--disabled': props.disabled }"
    :style="{ height: props.height }"
    aria-label="公屏文字"
  >
    <div class="chat__main">
      <div
        ref="scroller"
        class="chat__list"
        role="log"
        aria-label="公屏消息"
        @scroll.passive="onScroll"
      >
        <div v-if="rows.length === 0" class="chat__empty">
          <div class="chat__empty-icon" aria-hidden="true">🎙</div>
          <p class="chat__empty-text">还没人说话 · 开麦直接说，或在这里打字</p>
        </div>

        <div
          v-for="row in rows"
          :key="row.msg.id"
          class="chat__msg"
          :class="[
            row.mine ? 'chat__msg--mine' : 'chat__msg--other',
            { 'chat__msg--cont': row.cont },
          ]"
        >
          <span
            v-if="row.showName"
            class="chat__name"
            :class="{ 'chat__name--mine': row.mine }"
          >{{ row.msg.name }}</span>
          <!-- 时间压在气泡右下角，不额外占一行 -->
          <div class="chat__bubble">
            <span class="chat__text">{{ row.msg.text }}</span>
            <span class="chat__time">{{ chatTimeText(row.msg.at) }}</span>
          </div>
        </div>
      </div>

      <button v-if="hasNew" class="chat__jump" type="button" @click="jumpToLatest">
        ↓ 有新消息
      </button>
    </div>

    <div class="chat__composer">
      <div class="chat__chips" role="group" aria-label="快捷短语">
        <button
          v-for="phrase in QUICK_PHRASES"
          :key="phrase"
          class="chat__chip"
          type="button"
          :disabled="props.disabled"
          :aria-label="`填入快捷短语：${phrase}`"
          @click="usePhrase(phrase)"
        >
          {{ phrase }}
        </button>
      </div>

      <div class="chat__input-row">
        <textarea
          ref="inputEl"
          class="chat__input"
          rows="1"
          :value="draft"
          :maxlength="CHAT_MAX_LEN"
          :disabled="props.disabled"
          :placeholder="props.disabled ? '连接中…' : '打字说点什么…'"
          aria-label="公屏输入"
          enterkeyhint="send"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          inputmode="text"
          @input="onInput"
          @keydown="onKeydown"
        ></textarea>
        <button
          class="chat__send"
          type="button"
          :disabled="!canSend"
          aria-label="发送"
          @click="send"
        >
          <svg class="chat__send-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12 2-12 2z" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div v-if="props.disabled || showCount" class="chat__foot">
        <span v-if="props.disabled" class="chat__status" role="status">连接中…</span>
        <span v-if="showCount" class="chat__count" :class="countClass">
          {{ count }}/{{ CHAT_MAX_LEN }}
        </span>
      </div>
    </div>
  </section>
</template>