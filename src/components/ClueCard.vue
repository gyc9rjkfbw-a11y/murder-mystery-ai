<script setup lang="ts">
import type { ClueItem } from '@/types/script'

const props = defineProps<{
  clue: ClueItem
  /** 是否显示「公开 / 收藏」操作 */
  actionable?: boolean
}>()

const emit = defineEmits<{
  (e: 'publish', id: string): void
  (e: 'pin', id: string): void
}>()
</script>

<template>
  <article class="clue" :class="{ 'clue--private': props.clue.isPrivate }">
    <div class="clue__text">{{ props.clue.text }}</div>
    <div class="clue__foot">
      <span class="tag" :class="props.clue.isPrivate ? 'tag--gold' : ''">
        {{ props.clue.isPrivate ? '私有线索' : props.clue.location }}
      </span>
      <div v-if="props.actionable" class="clue__actions">
        <button
          v-if="!props.clue.published"
          class="mini-btn"
          @click="emit('publish', props.clue.id)"
        >
          公开
        </button>
        <span v-else class="mini-btn mini-btn--on">已公开</span>
        <button
          class="mini-btn"
          :class="{ 'mini-btn--on': props.clue.pinned }"
          @click="emit('pin', props.clue.id)"
        >
          {{ props.clue.pinned ? '已钉住' : '钉上' }}
        </button>
      </div>
    </div>
  </article>
</template>