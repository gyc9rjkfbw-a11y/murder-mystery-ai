<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    animated?: boolean
    label?: string
  }>(),
  {
    animated: false,
    label: '',
  },
)
</script>

<template>
  <svg
    class="brand-mark"
    :class="{ 'brand-mark--animated': props.animated }"
    viewBox="0 0 120 120"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    :aria-hidden="props.label ? undefined : 'true'"
    :role="props.label ? 'img' : undefined"
  >
    <title v-if="props.label">{{ props.label }}</title>
    <g class="brand-mark__case">
      <path d="M25 23.5 78.5 15l13 45.5-53.5 8.5L25 23.5Z" />
      <path d="m78.5 15 8.2 12.1-10.5 1.7" />
      <path d="m37 43 28.5-4.5M40 53l18.5-3" />
    </g>
    <g class="brand-mark__lens">
      <circle cx="49" cy="50" r="27" />
      <path class="brand-mark__handle" d="m68.3 69.4 24.2 24.2" />
      <path class="brand-mark__glint" d="M31.5 45.5c2.4-7.3 8.2-12.5 15.8-14.5" />
    </g>
    <path
      class="brand-mark__drop"
      d="M49 35.5c-5.7 8.5-10.2 14.2-10.2 20.2 0 6.2 4.6 10.3 10.2 10.3s10.2-4.1 10.2-10.3c0-6-4.5-11.7-10.2-20.2Z"
    />
    <circle class="brand-mark__seal" cx="93" cy="29" r="8.5" />
    <path class="brand-mark__seal-line" d="m89.5 29 2.4 2.3 4.8-5" />
  </svg>
</template>
