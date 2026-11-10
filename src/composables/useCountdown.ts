import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 阶段倒计时。
 * 状态机只提供 `endsAt` 时间戳，这里负责把它变成每秒刷新的 mm:ss。
 */
export function useCountdown(getEndsAt: () => number) {
  const now = ref(Date.now())
  let handle = 0

  onMounted(() => {
    handle = window.setInterval(() => {
      now.value = Date.now()
    }, 1000)
  })

  onBeforeUnmount(() => {
    if (handle) window.clearInterval(handle)
  })

  const remain = computed(() => {
    const endsAt = getEndsAt()
    if (!endsAt) return 0
    return Math.max(0, Math.round((endsAt - now.value) / 1000))
  })

  const text = computed(() => {
    const s = remain.value
    const mm = String(Math.floor(s / 60)).padStart(2, '0')
    const ss = String(s % 60).padStart(2, '0')
    return `${mm}:${ss}`
  })

  const urgent = computed(() => remain.value > 0 && remain.value <= 30)
  const overtime = computed(() => remain.value === 0 && getEndsAt() > 0)

  return { remain, text, urgent, overtime }
}