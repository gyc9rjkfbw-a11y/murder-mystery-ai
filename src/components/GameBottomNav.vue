<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import SheetModal from '@/components/SheetModal.vue'
import {
  availableGameNavItems,
  gameNavVisible,
  type GameNavItem,
} from '@/services/gameNavigation'
import { useGameStore } from '@/stores/game'
import { useNetStore } from '@/stores/net'

const route = useRoute()
const game = useGameStore()
const net = useNetStore()
const active = ref<GameNavItem | null>(null)

const visible = computed(() => gameNavVisible(route.name as string | undefined, !!game.state.script))
const items = computed(() => availableGameNavItems(net.inRoom))
const title = computed(() => {
  if (active.value === 'role') return '我的角色'
  if (active.value === 'clues') return '我的线索'
  if (active.value === 'phase') return '对局阶段'
  return ''
})

const privateClues = computed(() =>
  game.myClues.filter((clue) => clue.isPrivate || clue.foundBy === game.state.selfSeatId),
)
const publicClues = computed(() => game.publicClues)

watch(
  () => route.name,
  () => {
    active.value = null
  },
)

function open(item: GameNavItem): void {
  if (item === 'talk') {
    net.openTalk(net.unread ? 'chat' : 'voice')
    return
  }
  active.value = item
}
</script>

<template>
  <nav v-if="visible" class="game-bottom-nav" aria-label="局内导航">
    <button
      v-for="item in items"
      :key="item"
      class="game-nav-btn"
      :class="{ 'game-nav-btn--active': active === item || (item === 'talk' && net.talkOpen) }"
      :aria-label="
        item === 'role'
          ? '我的角色'
          : item === 'clues'
            ? '我的线索'
            : item === 'talk'
              ? '牌桌沟通'
              : '对局阶段'
      "
      @click="open(item)"
    >
      <span class="game-nav-btn__icon" aria-hidden="true">
        {{ item === 'role' ? '本' : item === 'clues' ? '线' : item === 'talk' ? '聊' : '阶' }}
      </span>
      <span class="game-nav-btn__label">
        {{ item === 'role' ? '剧本' : item === 'clues' ? '线索' : item === 'talk' ? '沟通' : '阶段' }}
      </span>
      <i v-if="item === 'talk' && net.unread" class="game-nav-btn__badge">
        {{ net.unread > 99 ? '99+' : net.unread }}
      </i>
      <i v-else-if="item === 'talk' && net.inVoice" class="game-nav-btn__live" />
    </button>
  </nav>

  <SheetModal
    :open="active === 'role' || active === 'clues' || active === 'phase'"
    :title="title"
    @close="active = null"
  >
    <template v-if="active === 'role'">
      <div v-if="game.selfRole" class="game-quick">
        <div class="game-quick__hero">
          <div class="game-quick__avatar">{{ game.selfSeat?.avatar || '🎭' }}</div>
          <div>
            <h4>{{ game.selfRole.name }}</h4>
            <p>{{ game.selfRole.identity }}</p>
          </div>
          <span class="tag" :class="game.selfRole.is_murderer ? 'tag--blood' : 'tag--ok'">
            {{ game.selfRole.is_murderer ? '凶手' : '平民' }}
          </span>
        </div>
        <div class="game-quick__section">
          <span>表层任务</span>
          <p>{{ game.selfRole.surface_task }}</p>
        </div>
        <div class="game-quick__section">
          <span>深层任务</span>
          <p>{{ game.selfRole.deep_task }}</p>
        </div>
        <div class="game-quick__section">
          <span>行动轨迹</span>
          <p>{{ game.selfRole.personal_timeline }}</p>
        </div>
      </div>
      <p v-else class="empty">尚未分配角色</p>
    </template>

    <template v-else-if="active === 'clues'">
      <div class="game-quick">
        <div class="game-quick__summary">
          <span>私有 / 自己发现</span>
          <strong>{{ privateClues.length }}</strong>
          <span>公共线索</span>
          <strong>{{ publicClues.length }}</strong>
        </div>
        <p class="section-title">私有线索</p>
        <div v-if="privateClues.length === 0" class="empty">暂时没有私有线索</div>
        <article v-for="clue in privateClues" :key="clue.id" class="game-quick-clue game-quick-clue--private">
          <p>{{ clue.text }}</p>
          <span>{{ clue.location }}</span>
        </article>
        <p class="section-title">公共线索</p>
        <div v-if="publicClues.length === 0" class="empty">暂时没有公开线索</div>
        <article v-for="clue in publicClues" :key="clue.id" class="game-quick-clue">
          <p>{{ clue.text }}</p>
          <span>{{ clue.location }}</span>
        </article>
      </div>
    </template>

    <template v-else-if="active === 'phase'">
      <div class="game-quick">
        <div class="game-quick__phase-head">
          <div>
            <span>{{ game.phaseInfo.label }}</span>
            <strong>{{ game.phaseInfo.desc }}</strong>
          </div>
          <span class="tag tag--gold">
            第 {{ game.state.round }} / {{ game.state.maxRounds }} 轮
          </span>
        </div>
        <div class="game-quick__flow">
          <div
            v-for="(step, index) in game.flowSteps"
            :key="step.key"
            class="game-quick__flow-item"
            :class="{
              'game-quick__flow-item--done': index < game.flowIndex,
              'game-quick__flow-item--now': index === game.flowIndex,
            }"
          >
            <i>{{ index < game.flowIndex ? '✓' : index + 1 }}</i>
            <span>{{ step.label }}</span>
          </div>
        </div>
      </div>
    </template>
  </SheetModal>
</template>
