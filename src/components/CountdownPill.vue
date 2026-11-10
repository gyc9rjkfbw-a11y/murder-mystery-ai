<script setup lang="ts">
import { useCountdown } from '@/composables/useCountdown'
import { useGameStore } from '@/stores/game'

const game = useGameStore()
const { text, urgent, overtime } = useCountdown(() => game.timer.endsAt)
</script>

<template>
  <span v-if="game.timer.endsAt > 0" class="countdown" :class="{ 'countdown--urgent': urgent }">
    <span>⏳</span>
    <span>{{ overtime ? '时间到' : text }}</span>
  </span>
</template>