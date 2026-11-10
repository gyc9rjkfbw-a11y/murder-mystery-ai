<script setup lang="ts">
import { useGameStore } from '@/stores/game'

/**
 * 进度条 / 阶段指示器
 * 步骤由人数与轮次动态生成（4 人 2 轮、5/6 人 3 轮、6 人每轮带搜证），
 * 所以这里渲染的是 store 计算出来的 flowSteps，而不是固定数组。
 */
const game = useGameStore()
</script>

<template>
  <nav class="stepper phase-stepper">
    <span
      v-for="(s, i) in game.flowSteps"
      :key="s.key"
      class="stepper__item"
      :class="{
        'stepper__item--now': i === game.flowIndex,
        'stepper__item--done': game.flowIndex >= 0 && i < game.flowIndex,
      }"
    >
      {{ s.label }}
    </span>
  </nav>
</template>