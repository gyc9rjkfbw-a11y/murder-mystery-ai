<script setup lang="ts">
/**
 * 联机等待厅（LobbyView）
 * ==========================================================================
 * 职责：4-6 名真人用房号进入同一个房间后，**等待与开局前**的一切。
 *   - 展示房号并提供「复制邀请」（含分享文案）
 *   - 展示座位表（谁到了、谁准备了、谁是房主、谁掉线、谁由 AI 补位）
 *   - 房主：全部准备后开始；人不够可以补 AI
 *   - 非房主：准备 / 取消准备
 *   - 开局后：只渲染「已开局」过渡态（真正的路由跳转由 net store 负责，本页不写跳转）
 *
 * 建房 / 加入房间的输入在首页，本页不负责。
 * 所有状态与方法都来自 `useNetStore`，本页不直接碰 WebSocket 与路由表。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import { useToast } from '@/composables/useToast'
import { pacingFor } from '@/services/rules'
import type { SeatBrief } from '@/services/net/protocol'
import { useNetStore } from '@/stores/net'
import { AVATARS } from '@/types/game'

const net = useNetStore()
const toast = useToast()

/* ------------------------------------------------------------------ *
 * 连接状态：断线期间一律锁住会写服务器的操作
 * ------------------------------------------------------------------ */
const online = computed(() => net.connected && !net.reconnecting)

/* ------------------------------------------------------------------ *
 * 座位表：服务器只下发「已入座」的座位，空位由前端补齐到 playerCount
 * ------------------------------------------------------------------ */
interface SeatRow {
  key: string
  seat: SeatBrief | null
  avatar: string
}

const seats = computed<SeatBrief[]>(() => net.view?.seats ?? [])

const rows = computed<SeatRow[]>(() => {
  const list = seats.value
  const total = Math.max(net.playerCount, list.length)
  const out: SeatRow[] = []
  for (let i = 0; i < total; i += 1) {
    const seat: SeatBrief | null = list[i] ?? null
    out.push({
      key: seat ? seat.seatId : `lobby-empty-${i}`,
      seat,
      // 有人入座就用他的档案头像（同一个人在所有人屏幕上都是同一个 emoji）；
      // 空位仍按序号拿默认头像，座位表看起来才整齐
      avatar: seat?.avatar || AVATARS[i % AVATARS.length],
    })
  }
  return out
})

const emptySeats = computed(() => Math.max(net.playerCount - seats.value.length, 0))
const isFull = computed(() => emptySeats.value === 0)

const pendingText = computed(() => {
  const names = net.pendingNames
  if (names.length === 0) return ''
  return names.length > 3 ? `${names.slice(0, 3).join('、')} 等` : names.join('、')
})

/* ------------------------------------------------------------------ *
 * 本局节奏文案：轮次取自服务器视图，每轮搜证次数取自节奏规则表
 * ------------------------------------------------------------------ */
const paceText = computed(() => {
  const view = net.view
  if (!view) return '等待服务器下发配置…'
  if (!view.searchRounds) return `${view.maxRounds} 轮陈述 · 不设搜证环节，线索按轮次发放`
  const perRound = pacingFor(net.playerCount).searchPerRound
  return perRound > 0
    ? `${view.maxRounds} 轮陈述 · 每轮搜证 ${perRound} 次`
    : `${view.maxRounds} 轮陈述 · 共 ${view.searchRounds} 轮搜证`
})

/* ------------------------------------------------------------------ *
 * 邀请地址：从当前页面地址推导，绝不写死 IP
 * ------------------------------------------------------------------ */
const originText = window.location.origin
const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname)
const isDevPort = window.location.port === '5273'
/**
 * 是不是「公网/隧道」地址（而不是局域网 IP）。
 * 用来改邀请话术：局域网要说「连同一个 Wi-Fi」，隧道地址则相反 —— 不在同一网络也能进，
 * 而且 https 下才可能开麦（浏览器只在安全上下文给麦克风）。
 */
const isRemote =
  window.location.protocol === 'https:' &&
  !isLoopback &&
  !/^\d+\.\d+\.\d+\.\d+$/.test(window.location.hostname)

const copyState = ref<'idle' | 'ok' | 'fail'>('idle')
let copyTimer = 0

onBeforeUnmount(() => {
  if (copyTimer) window.clearTimeout(copyTimer)
})

async function onCopyCode() {
  let ok = false
  try {
    ok = await net.copyCode()
  } catch {
    ok = false
  }
  copyState.value = ok ? 'ok' : 'fail'
  if (ok) toast.success('邀请文案已复制，发给朋友就行')
  else toast.error('复制失败，请手动把房号念给朋友')

  if (copyTimer) window.clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copyState.value = 'idle'
  }, 2600)
}

/* ------------------------------------------------------------------ *
 * 离开房间：返回键与按钮都要先确认，确认后统一走 net.leaveRoom()
 * ------------------------------------------------------------------ */
const showLeaveConfirm = ref(false)
const leaving = ref(false)

function askLeave() {
  showLeaveConfirm.value = true
}

function cancelLeave() {
  showLeaveConfirm.value = false
}

function confirmLeave() {
  showLeaveConfirm.value = false
  leaving.value = true
  net.leaveRoom()
}

// AppTopBar 的返回键走的是 router.back()，所以在这里拦一道做确认
onBeforeRouteLeave(() => {
  if (leaving.value || !net.inRoom) return true
  // ★ 服务器已经开局时，离开等待厅是「阶段跟随」（App.vue 把所有人一起带到
  //   阅读/陈述页），不是玩家要退房 —— 这里必须放行，否则整局都卡在等待厅。
  if (net.started || (net.phase !== 'room' && net.phase !== 'lobby')) return true
  showLeaveConfirm.value = true
  return false
})
</script>

<template>
  <AppTopBar title="联机房间" :sub="net.roomCode ? `房号 ${net.roomCode}` : '联机等待厅'" show-back />

  <main class="page">
    <!-- 错误条：醒目 + 一键重连 -->
    <div v-if="net.error" class="warn lobby-alert">
      <div class="lobby-alert__text"><strong>连接异常：</strong>{{ net.error }}</div>
      <button class="btn btn--sm lobby-alert__btn" type="button" @click="net.connect()">
        重试连接
      </button>
    </div>

    <!-- 断线 / 重连中 -->
    <div v-if="!online" class="lobby-banner">
      <span class="lobby-dot" aria-hidden="true" />
      连接已断开，正在重连…
    </div>

    <!-- 服务端轻提示（由 store 负责清除，本页不自动消失） -->
    <p v-if="net.lastToast" class="lobby-toast">{{ net.lastToast }}</p>

    <template v-if="net.inRoom">
      <!-- ---------- 开局后：过渡态（跳转由 store 做） ---------- -->
      <section v-if="net.started" class="card lobby-started">
        <div class="spinner" aria-hidden="true" />
        <p class="lobby-started__title">已开局</p>
        <p class="lobby-started__hint muted small">剧本已下发，正在前往阅读页…</p>
      </section>

      <!-- ---------- 房号卡片 ---------- -->
      <section v-else class="card">
        <h3 class="card__title">房号</h3>
        <div class="lobby-code">
          <span class="lobby-code__text">{{ net.roomCode || '-----' }}</span>
          <button class="btn btn--sm lobby-copy" type="button" @click="onCopyCode">
            {{ copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : '复制邀请' }}
          </button>
        </div>

        <p class="card__hint" style="margin-top: 10px">怎么让朋友进来：</p>
        <ol class="lobby-steps">
          <li v-if="isRemote">
            把这个地址发给朋友（<strong>不在同一个 Wi-Fi 也能进</strong>，走的是隧道/公网），手机浏览器打开
            <span class="lobby-url">{{ originText }}/</span>
          </li>
          <li v-else>
            让朋友连上<strong>同一个 Wi-Fi</strong>，手机浏览器打开
            <span class="lobby-url">{{ originText }}/</span>
          </li>
          <li>
            点「加入房间」，输入房号
            <span class="lobby-code-inline">{{ net.roomCode }}</span>
          </li>
          <li>想开麦对质就点顶栏的 🎙 开麦；不方便开麦就在 💬 公屏打字。</li>
        </ol>

        <p v-if="isDevPort" class="tiny lobby-dev-note">
          当前是开发服务器（5273），这个地址只在本机有效：正式开玩请用
          <strong>5274</strong> 端口那个地址，手机和电脑必须在同一个 Wi-Fi。
        </p>
        <p v-else-if="isLoopback" class="tiny lobby-dev-note">
          当前是本机地址：把 <strong>localhost</strong> 换成这台电脑的局域网 IP
          （<code>ipconfig</code> 里的 IPv4 地址）再发给朋友。
        </p>
        <p v-else-if="isRemote" class="tiny lobby-dev-note">
          这是公网/隧道地址（https），<strong>语音可以开麦</strong>，但隧道域名每次重启都会变，
          重启后记得把新地址重新发一遍。
        </p>
        <p v-else-if="net.canVoice" class="tiny lobby-dev-note">
          这是 https 地址，<strong>语音可以开麦</strong>（自签证书的话每台手机要装一次证书，
          见 README 的「沟通」一节）。
        </p>
        <p v-else class="tiny lobby-dev-note">
          这是局域网 http 地址：打字没问题，但浏览器只在 https 下才给麦克风。
          想开麦请看 README 的「沟通：开麦通话 + 公屏打字」一节（隧道或自签证书两条路）。
        </p>
      </section>

      <!-- ---------- 座位表 ---------- -->
      <section class="card">
        <h3 class="card__title">
          {{ net.started ? '角色分配' : '座位' }} {{ seats.length }} / {{ net.playerCount }}
        </h3>
        <div class="lobby-seats">
          <div
            v-for="row in rows"
            :key="row.key"
            class="seat"
            :class="{
              'seat--self': !!row.seat && row.seat.isSelf,
              'seat--empty': !row.seat,
              'seat--offline': !!row.seat && !row.seat.connected,
            }"
          >
            <template v-if="row.seat">
              <div class="seat__avatar" aria-hidden="true">{{ row.avatar }}</div>
              <div class="lobby-seat__main">
                <div class="seat__name">
                  {{ row.seat.name }}
                  <span v-if="row.seat.isSelf" class="tag tag--ok lobby-seat__tag">我</span>
                  <span v-if="row.seat.isHost" class="tag tag--gold lobby-seat__tag">房主</span>
                  <span v-if="row.seat.isBot" class="tag lobby-seat__tag">AI</span>
                </div>
                <div class="seat__meta">
                  <span
                    class="lobby-state"
                    :class="
                      !row.seat.connected
                        ? 'lobby-state--off'
                        : row.seat.ready
                          ? 'lobby-state--ok'
                          : ''
                    "
                  >
                    {{ !row.seat.connected ? '掉线' : row.seat.ready ? '已准备' : '未准备' }}
                  </span>
                  <span
                    v-if="net.started && row.seat.roleName"
                    class="lobby-state lobby-state--role"
                  >
                    饰演 {{ row.seat.roleName }}
                  </span>
                </div>
              </div>
            </template>
            <template v-else>等待玩家…</template>
          </div>
        </div>
      </section>

      <!-- ---------- 开局前操作区 ---------- -->
      <section v-if="!net.started" class="card">
        <h3 class="card__title">开局前</h3>

        <template v-if="net.isHost">
          <p v-if="!net.allReady" class="tiny muted lobby-note">
            还有 {{ net.pendingNames.length }} 人未准备<span v-if="pendingText"> · {{ pendingText }}</span>
          </p>
          <p v-else class="tiny muted lobby-note">全员已准备，可以开局了。</p>

          <button
            class="btn btn--primary"
            type="button"
            :disabled="!net.allReady || !online"
            @click="net.start()"
          >
            开始游戏 · 下发剧本
          </button>

          <div class="btn-row">
            <button
              class="btn btn--ghost"
              type="button"
              :disabled="!online || isFull"
              @click="net.addBot()"
            >
              {{ isFull ? '人数已满' : `先补一个 AI 玩家（还差 ${emptySeats} 人）` }}
            </button>
          </div>

          <!-- 房主自己也是座位：服务器没自动置位时，这里兜住「房主不开准备」的死锁 -->
          <button
            v-if="!net.myReady"
            class="btn btn--ghost lobby-self-ready"
            type="button"
            :disabled="!online"
            @click="net.setReady(true)"
          >
            我也准备好了
          </button>
        </template>

        <template v-else>
          <button
            class="btn"
            :class="net.myReady ? 'btn--ghost' : 'btn--primary'"
            type="button"
            :disabled="!online"
            @click="net.setReady(!net.myReady)"
          >
            {{ net.myReady ? '取消准备' : '我准备好了' }}
          </button>
          <p class="tiny muted lobby-note lobby-note--gap">
            {{
              net.myReady
                ? `已准备，等房主开局${net.pendingNames.length ? `（还差 ${net.pendingNames.length} 人）` : ''}`
                : '准备好后房主才能开局。'
            }}
          </p>
        </template>
      </section>

      <!-- ---------- 本局配置（不泄露任何身份信息） ---------- -->
      <section v-if="!net.started" class="card card--flat">
        <h3 class="card__title">本局配置</h3>
        <div class="kv">
          <span class="kv__k">人数</span>
          <span class="kv__v">{{ net.playerCount }} 人同桌 · 已入座 {{ seats.length }} 人</span>
        </div>
        <div class="kv">
          <span class="kv__k">题材</span>
          <span class="kv__v">{{ net.theme || '—' }}</span>
        </div>
        <div class="kv">
          <span class="kv__k">节奏</span>
          <span class="kv__v">{{ paceText }}</span>
        </div>
        <div class="kv">
          <span class="kv__k">身份</span>
          <span class="kv__v">开局后只显示在你自己的手机上</span>
        </div>
      </section>

      <div class="btn-row lobby-leave">
        <button class="btn btn--ghost" type="button" @click="askLeave">离开房间</button>
      </div>
    </template>

    <!-- ---------- 兜底：还没入座（例如刷新后房间已解散） ---------- -->
    <section v-else class="card lobby-void">
      <h3 class="card__title">尚未入座</h3>
      <p class="muted small" style="margin: 0 0 12px">
        你还没有进入任何房间。回到首页创建房间，或用朋友给的房号加入。
      </p>
      <button class="btn btn--ghost" type="button" @click="net.leaveRoom()">返回首页</button>
    </section>
  </main>

  <!-- ---------- 离开确认 ---------- -->
  <div v-if="showLeaveConfirm" class="sheet-mask" @click.self="cancelLeave">
    <div class="sheet">
      <div class="sheet__grip" aria-hidden="true" />
      <h3 class="card__title">离开房间？</h3>
      <p class="muted small" style="margin: 0 0 12px">
        你的座位会立刻空出来，其他人会看到你掉线；再回来需要重新输入房号。
      </p>
      <div class="btn-row">
        <button class="btn btn--ghost" type="button" @click="cancelLeave">先不走</button>
        <button class="btn btn--blood" type="button" @click="confirmLeave">确认离开</button>
      </div>
    </div>
  </div>
</template>