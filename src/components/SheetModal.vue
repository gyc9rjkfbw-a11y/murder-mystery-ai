<script setup lang="ts">
const props = defineProps<{ open: boolean; title?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <Teleport to="body">
    <div v-if="props.open" class="sheet-mask" @click.self="emit('close')">
      <section class="sheet">
        <div class="sheet__grip" />
        <h3 v-if="props.title" class="card__title">{{ props.title }}</h3>
        <slot />
        <div class="btn-row">
          <button class="btn btn--ghost" @click="emit('close')">关闭</button>
        </div>
      </section>
    </div>
  </Teleport>
</template>