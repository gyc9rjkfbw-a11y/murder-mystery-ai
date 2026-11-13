<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '@/components/AppTopBar.vue'
import PhaseStepper from '@/components/PhaseStepper.vue'
import RoleAvatar from '@/components/RoleAvatar.vue'
import SheetModal from '@/components/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import { useDeductionStore } from '@/stores/deduction'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'
import { useSettingsStore } from '@/stores/settings'
import type { Role } from '@/types/script'

const router = useRouter()
const game = useGameStore()
const deduction = useDeductionStore()
const settings = useSettingsStore()
const net = useNetStore()
const scriptOpen = ref(false)
const viewing = ref<Role | null>(null)
/** 房主点「离开房间」：房里还有别人时先问一句——是只走自己，还是把整桌解散 */
const leaveOpen = ref(false)
/** 解散是不可逆的，第一次点只变成二次确认，不直接执行 */
const dissolveArmed = ref(false)
/** 正在等服务端响应：keep = 回房间保留房号，dissolve = 解散房间 */
const pendingMode = ref<'keep' | 'dissolve' | null>(null)

const toast = useToast()

/** 复盘页的两个出口，服务端响应期间一起变灰 */
const busyExit = computed(() => pendingMode.value !== null)

const backLabel = computed(() =>
  pendingMode.value === 'keep' ? '正在返回房间…' : '返回房间',
)

const leaveLabel = computed(() =>
  pendingMode.value === 'dissolve' ? '正在解散房间…' : '离开房间',
)

/** 这一桌除我之外还有几个真人：决定房主离开时是「转交」还是「一起关掉」 */
const otherHumans = computed(
  () => (net.view?.seats ?? []).filter((s) => !s.isBot && !s.isSelf).length,
)

/** 底部两个按钮下面那行小字：把「两个选项各自会发生什么」说清楚 */
const exitHint = computed(() => {
  if (!net.active) {
    return '返回房间：原班人马留在这间房里，可以再开一局；离开房间：结束这次对局回首页。'
  }
  if (net.isHost) {
    return `房号 ${net.roomCode} 会保留：返回房间后大家一起回到等待厅重新准备；离开房间只把你一个人请出这一桌。`
  }
  return `返回房间：回到房号 ${net.roomCode} 的等待厅，等房主开新一局；离开房间：直接退出这一桌。`
})

const truth = computed(() => game.state.script?.global_truth)
const deductionHit = computed(
  () =>
    !!deduction.summary.target &&
    deduction.summary.target === game.state.script?.global_truth.murderer_name,
)
/**
 * 凶手特权的直觉提示：局中只有凶手端持有（见 stores/game.ts 的纵深防御），
 * 复盘时统一从剧本包读取，保证所有玩家都能看到。
 */
const privilegeHint = computed(
  () => game.state.privilege?.hint ?? game.state.script?.murderer_privilege?.intuition_hint ?? '',
)
const settlement = computed(() => game.state.settlement)
const myRow = computed(() =>
  settlement.value.find((r) => r.roleName === game.selfRole?.name),
)
const murdererRow = computed(() => settlement.value.find((r) => r.isMurderer))
/** 平民阵营是否获胜 */
const crowdWins = computed(() => murdererRow.value?.win === false)

const myWin = computed(() => myRow.value?.win === true)
const murdererRole = computed(() => game.murdererRole)

const maxVotes = computed(() => Math.max(1, ...settlement.value.map((r) => r.votes)))

/** 结算行只带角色名，头像需要按名字回查角色（复盘阶段 roles 对所有人完整） */
function roleByName(name: string) {
  return game.roles.find((r) => r.name === name) ?? null
}

onMounted(() => {
  if (!game.state.script) {
    router.replace('/')
    return
  }
  if (game.state.phase !== 'reveal') game.reveal()
  deduction.sync()
  // 服务器在复盘时已经把这一局的胜负记进档案了，这里读回来——
  // 局后回到设置页就能看到战绩 +1（服务器没开时静默失败）
  if (game.state.online) void settings.refreshProfile()
})

function openScript(role: Role) {
  viewing.value = role
  scriptOpen.value = true
}

/**
 * 返回房间：这一桌留着，所有人（或自己）回到等待厅。
 * ------------------------------------------------------------------
 * · 联机房主：服务端 `restart(keep)` 把房间退回等待厅，房号与座位都保留，
 *   其他客户端收到阶段变化会一起跳回 /lobby（App 里的阶段跟随）。
 * · 联机非房主：没法替全房做主，自己先回等待厅，等房主开新一局。
 * · 单机：本地清掉这一局、座位与房号保留，回 /room 再开一局。
 */
function backToRoom() {
  if (busyExit.value) return
  if (!net.active) {
    game.backToRoom()
    router.replace('/room')
    return
  }
  if (!net.isHost) {
    router.replace('/lobby')
    toast.info('已回到房间，等房主开新一局')
    return
  }
  pendingMode.value = 'keep'
  net.rematch(true)
  // 兜底：服务器异常时不至于按钮一直灰着
  window.setTimeout(() => (pendingMode.value = null), 5000)
}

/** 离开房间：走人（联机时房主的房子怎么处置，见 leaveSelf / dissolveRoom） */
function askLeave() {
  if (busyExit.value) return
  if (!net.active) {
    game.resetAll()
    router.replace('/')
    return
  }
  // 非房主：没有处置房间的权限，直接退出自己的座位
  if (!net.isHost) {
    net.leaveRoom()
    return
  }
  // 房里只剩自己（和 AI）：没有可转交的人，直接连房解散
  if (otherHumans.value === 0) {
    dissolveRoom()
    return
  }
  dissolveArmed.value = false
  leaveOpen.value = true
}

/** 房主只走自己：房号留给其他人，房主身份自动转给下一位真人 */
function leaveSelf() {
  if (busyExit.value) return
  leaveOpen.value = false
  net.leaveRoom()
}

/**
 * 解散整个房间：房号作废，所有人（含自己）被请回首页。
 * 不可逆，所以第一次点只变成二次确认。
 */
function dissolveRoom() {
  if (busyExit.value) return
  if (!dissolveArmed.value && otherHumans.value > 0) {
    dissolveArmed.value = true
    return
  }
  leaveOpen.value = false
  pendingMode.value = 'dissolve'
  net.rematch(false)
  window.setTimeout(() => (pendingMode.value = null), 5000)
}

function closeLeave() {
  if (busyExit.value) return
  leaveOpen.value = false
  dissolveArmed.value = false
}
</script>

<template>
  <AppTopBar title="复盘结算" sub="真相揭晓" show-back />
  <PhaseStepper />

  <main class="page">
    <section class="card center" style="padding-top: 26px">
      <p class="tiny muted" style="letter-spacing: 0.3em; margin: 0">THE TRUTH IS</p>
      <RoleAvatar
        :role="murdererRole"
        :size="92"
        tone="blood"
        style="margin: 14px auto 0"
      />
      <h2
        class="serif"
        style="font-size: 30px; margin: 10px 0 6px; letter-spacing: 0.1em"
        :class="crowdWins ? 'gold' : 'blood'"
      >
        {{ truth?.murderer_name }}
      </h2>
      <p class="small dim" style="margin: 0">
        {{ murdererRole?.identity }} · 就是那个动手的人
      </p>
      <div class="divider" />
      <p class="small" :class="myWin ? 'gold' : 'blood'" style="margin: 0">
        <template v-if="myRow">
          {{ myRow.isMurderer ? '你是凶手，' : '你是平民，' }}
          {{ myWin ? '你赢了这一局。' : '你输掉了这一局。' }}
        </template>
        <template v-else>旁观复盘</template>
      </p>
      <p class="tiny muted" style="margin-top: 6px">
        {{ crowdWins ? '凶手被指认出来了。' : '凶手逃掉了。' }}
      </p>
    </section>

    <section v-if="deduction.summary.target" class="card deduction-review">
      <div class="deduction-review__head">
        <div>
          <div class="wb-kicker">YOUR THEORY</div>
          <h3 class="card__title" style="margin: 0">你当时的判断</h3>
        </div>
        <span class="tag" :class="deductionHit ? 'tag--ok' : 'tag--blood'">
          {{ deductionHit ? '判断命中' : '判断偏离' }}
        </span>
      </div>
      <p class="deduction-review__target">
        你怀疑了 <strong>{{ deduction.summary.target }}</strong>
      </p>
      <div v-if="deduction.board.finalReasons.length" class="deduction-review__reasons">
        <span v-for="reason in deduction.board.finalReasons" :key="reason">{{ reason }}</span>
      </div>
      <p v-if="deduction.board.summary" class="deduction-review__summary">
        {{ deduction.board.summary }}
      </p>
    </section>

    <section class="card">
      <h3 class="card__title">真实死因与手法</h3>
      <p class="small dim" style="margin: 0; line-height: 1.9">{{ truth?.cause_of_death }}</p>
    </section>

    <section class="card">
      <h3 class="card__title">绝对时间线（仅系统可见）</h3>
      <p class="small dim" style="margin: 0; line-height: 1.9; white-space: pre-wrap">
        {{ truth?.absolute_timeline }}
      </p>
    </section>

    <section v-if="privilegeHint" class="privilege">
      <div class="privilege__head">
        <span>🩸</span>
        <span>当时推送给凶手的直觉提示</span>
        <span class="tag" style="margin-left: auto">复盘公开</span>
      </div>
      <div class="privilege__body">{{ privilegeHint }}</div>
      <p class="tiny muted" style="margin: 10px 0 0">
        局中只有凶手端能看到这条提示，复盘时才对所有人公开。
      </p>
    </section>

    <p class="section-title">票型</p>
    <section class="card card--flat">
      <div v-for="row in settlement" :key="row.roleName" style="padding: 9px 0">
        <div style="display: flex; align-items: center; gap: 8px">
          <RoleAvatar :role="roleByName(row.roleName)" :size="24" tone="none" />
          <span style="font-size: 14px; font-weight: 600; flex: 0 0 68px">
            {{ row.roleName }}
          </span>
          <div
            style="flex: 1; height: 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.06)"
          >
            <div
              style="height: 100%; border-radius: 4px"
              :style="{
                width: `${(row.votes / maxVotes) * 100}%`,
                background: row.isMurderer
                  ? 'linear-gradient(90deg,#d4483a,#c0392b)'
                  : 'linear-gradient(90deg,#e8c07a,#d8a95b)',
              }"
            />
          </div>
          <span class="tiny muted" style="flex: 0 0 34px; text-align: right">
            {{ row.votes }} 票
          </span>
        </div>
      </div>
      <div class="divider" />
      <p class="tiny muted" style="margin: 0">
        判定规则（初版）：只有凶手被唯一最高票指认时，平民阵营获胜；平票或指认错误都算凶手逃脱。
      </p>
    </section>

    <p class="section-title">本局节奏回顾</p>
    <section class="card card--flat">
      <div class="kv">
        <span class="kv__k">难度</span>
        <span class="kv__v">
          {{ game.difficultyMeta.emoji }} {{ game.difficultyMeta.label }} ·
          {{ game.difficultyMeta.tagline }}
        </span>
      </div>
      <div class="kv">
        <span class="kv__k">实际轮次</span>
        <span class="kv__v">
          第 {{ game.state.round }} 轮 / 上限 {{ game.state.maxRounds }} 轮
          <template v-if="game.state.accelerateSuggested">（触发提前结算）</template>
        </span>
      </div>
      <div class="kv">
        <span class="kv__k">线索发放</span>
        <span class="kv__v">
          已发放 {{ game.state.releasedTiers.length }} / {{ game.state.script?.clue_batches?.length ?? 0 }} 批
        </span>
      </div>
      <div v-if="game.state.detectiveHints > 0" class="kv">
        <span class="kv__k">防冷场</span>
        <span class="kv__v">触发 {{ game.state.detectiveHints }} 次 AI 侦探提示</span>
      </div>
      <div v-if="game.state.accelerateReason" class="kv">
        <span class="kv__k">收网依据</span>
        <span class="kv__v">{{ game.state.accelerateReason }}</span>
      </div>
      <div v-for="s in game.state.roundSummaries" :key="s.round" class="kv">
        <span class="kv__k">第 {{ s.round }} 轮摸底</span>
        <span class="kv__v">
          {{ s.top ?? '无人得票' }}{{ s.top ? `（${s.topVotes} 票）` : '' }}
          <template v-if="s.accelerate"> · 已达提前结算条件</template>
        </span>
      </div>
    </section>

    <p class="section-title">任务清算</p>
    <section>
      <div v-for="row in settlement" :key="row.roleName" class="card">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
          <RoleAvatar :role="roleByName(row.roleName)" :size="38" tone="none" />
          <span style="font-size: 15px; font-weight: 600">{{ row.roleName }}</span>
          <span class="tiny muted">{{ row.identity }}</span>
          <span v-if="row.isMurderer" class="tag tag--blood">凶手</span>
          <span class="tag" :class="row.win ? 'tag--ok' : ''" style="margin-left: auto">
            {{ row.win ? '获胜' : '失败' }}
          </span>
        </div>
        <div class="kv">
          <span class="kv__k">表层任务</span>
          <span class="kv__v">{{ row.surfaceDone ? '达成（没被盯上）' : '暴露（被多数人怀疑）' }}</span>
        </div>
        <div class="kv">
          <span class="kv__k">深层任务</span>
          <span class="kv__v">{{ row.deepDone ? '达成' : '未达成' }}</span>
        </div>
        <button
          class="mini-btn"
          style="margin-top: 10px"
          @click="openScript(game.roles.find((r) => r.name === row.roleName) as Role)"
        >
          查看该角色剧本
        </button>
      </div>
    </section>

    <div class="btn-row reveal-exit">
      <button class="btn btn--primary" :disabled="busyExit" @click="backToRoom">
        {{ backLabel }}
      </button>
      <button class="btn btn--ghost" :disabled="busyExit" @click="askLeave">
        {{ leaveLabel }}
      </button>
    </div>
    <p class="tiny muted reveal-exit__hint">{{ exitHint }}</p>
  </main>

  <SheetModal :open="leaveOpen" title="离开房间？" @close="closeLeave">
    <p class="small dim" style="margin: 0 0 4px">
      这一局已经结束，房号 <strong class="gold">{{ net.roomCode }}</strong> 还有
      {{ otherHumans }} 位玩家在。你可以只走自己，也可以把整桌解散：
    </p>
    <div class="again-choice">
      <button class="again-option" @click="leaveSelf">
        <span class="again-option__icon" aria-hidden="true">走</span>
        <span>
          <strong>我先离开</strong>
          <small>房间留给其他人，房主身份自动转给下一位；你回首页，战绩已经记好了。</small>
        </span>
      </button>
      <button
        class="again-option again-option--danger"
        :class="{ 'again-option--armed': dissolveArmed }"
        @click="dissolveRoom"
      >
        <span class="again-option__icon" aria-hidden="true">✕</span>
        <span>
          <strong>{{ dissolveArmed ? '再点一次，确认解散' : '解散整个房间' }}</strong>
          <small>
            {{
              dissolveArmed
                ? '解散不可撤销：房号立即作废，所有人都要各自新建房间才能再玩。'
                : '房号立即作废，所有人（包括你）都会回到首页。'
            }}
          </small>
        </span>
      </button>
    </div>
    <p class="tiny muted" style="margin: 10px 0 0">
      还想跟同一批人再玩，就回上一页点「返回房间」——房号和座位都会留着。
    </p>
  </SheetModal>

  <SheetModal :open="scriptOpen" :title="viewing?.name ?? ''" @close="scriptOpen = false">
    <div v-if="viewing">
      <div style="display: flex; gap: 8px; margin-bottom: 10px">
        <span class="tag tag--gold">{{ viewing.identity }}</span>
        <span v-if="viewing.is_murderer" class="tag tag--blood">凶手</span>
      </div>
      <div class="kv">
        <span class="kv__k">表层任务</span>
        <span class="kv__v">{{ viewing.surface_task }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">深层任务</span>
        <span class="kv__v">{{ viewing.deep_task }}</span>
      </div>
      <div class="kv">
        <span class="kv__k">行动轨迹</span>
        <span class="kv__v">{{ viewing.personal_timeline }}</span>
      </div>
      <div class="divider" />
      <div class="script-body" style="font-size: 14.5px">
        <p v-for="(line, i) in viewing.full_script.split(/\n+/).filter(Boolean)" :key="i">
          {{ line }}
        </p>
      </div>
    </div>
  </SheetModal>
</template>
