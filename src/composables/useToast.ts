import { reactive } from 'vue'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'success' | 'warn' | 'error'
}

const toasts = reactive<Toast[]>([])
let seq = 0

function push(text: string, kind: Toast['kind'] = 'info', duration = 2200) {
  const id = ++seq
  toasts.push({ id, text, kind })
  window.setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id)
    if (i >= 0) toasts.splice(i, 1)
  }, duration)
}

export function useToast() {
  return {
    toasts,
    info: (t: string) => push(t, 'info'),
    success: (t: string) => push(t, 'success'),
    warn: (t: string) => push(t, 'warn'),
    error: (t: string) => push(t, 'error', 3600),
  }
}