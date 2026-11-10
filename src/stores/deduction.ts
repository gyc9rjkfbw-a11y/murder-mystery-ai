import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  buildCaseSummary,
  createDeductionBoard,
  deductionStorageKey,
  loadDeductionBoard,
  nextReviewMark,
  persistDeductionBoard,
  type DeductionStorage,
} from '@/services/deduction'
import { useGameStore } from '@/stores/game'
import type {
  DeductionBoard,
  ReviewMark,
  SuspicionLevel,
  TimelineStatus,
} from '@/types/deduction'

export const CASE_REASONS = [
  '时间线出现空档',
  '证词前后矛盾',
  '物证指向明确',
  '动机与案件直接相关',
  '有人替其作伪证',
] as const

const memory = new Map<string, string>()
const memoryStorage: DeductionStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
}

function localStore(): DeductionStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* 隐私模式可能直接抛异常，退回进程内存储。 */
  }
  return memoryStorage
}

export const useDeductionStore = defineStore('deduction', () => {
  const game = useGameStore()
  const board = ref<DeductionBoard>(createDeductionBoard('unbound', [], 0))
  const currentKey = ref('')

  const roleNames = computed(() => game.roles.map((role) => role.name))
  const storageKey = computed(() =>
    deductionStorageKey(game.state.roomCode, game.selfRole?.name ?? '', roleNames.value),
  )
  const summary = computed(() => buildCaseSummary(board.value))
  const linkedClueCount = computed(() =>
    Object.values(board.value.suspects).reduce((total, item) => total + item.clueIds.length, 0),
  )

  function sync(): void {
    if (roleNames.value.length === 0) return
    const key = storageKey.value
    if (key === currentKey.value) return
    currentKey.value = key
    board.value = loadDeductionBoard(localStore(), key, roleNames.value)
  }

  function touch(): void {
    board.value.updatedAt = Date.now()
    persistDeductionBoard(localStore(), currentKey.value, board.value)
  }

  function setSuspicion(roleName: string, value: SuspicionLevel): void {
    sync()
    const dossier = board.value.suspects[roleName]
    if (!dossier) return
    dossier.suspicion = value
    touch()
  }

  function setTimeline(roleName: string, value: TimelineStatus): void {
    sync()
    const dossier = board.value.suspects[roleName]
    if (!dossier) return
    dossier.timeline = value
    touch()
  }

  function toggleMotive(roleName: string): void {
    sync()
    const dossier = board.value.suspects[roleName]
    if (!dossier) return
    dossier.motive = !dossier.motive
    touch()
  }

  function toggleClue(roleName: string, clueId: string): void {
    sync()
    const dossier = board.value.suspects[roleName]
    if (!dossier || !clueId) return
    const index = dossier.clueIds.indexOf(clueId)
    if (index >= 0) dossier.clueIds.splice(index, 1)
    else dossier.clueIds.push(clueId)
    touch()
  }

  function setNote(roleName: string, text: string): void {
    sync()
    const dossier = board.value.suspects[roleName]
    if (!dossier) return
    dossier.note = text.slice(0, 360)
    touch()
  }

  function setFinalSuspect(roleName: string): void {
    sync()
    if (roleName && !board.value.suspects[roleName]) return
    board.value.finalSuspect = roleName
    if (roleName) board.value.suspects[roleName].suspicion = 3
    touch()
  }

  function toggleReason(reason: string): void {
    sync()
    const text = reason.trim().slice(0, 120)
    if (!text) return
    const index = board.value.finalReasons.indexOf(text)
    if (index >= 0) board.value.finalReasons.splice(index, 1)
    else if (board.value.finalReasons.length < 6) board.value.finalReasons.push(text)
    touch()
  }

  function setSummary(text: string): void {
    sync()
    board.value.summary = text.slice(0, 500)
    touch()
  }

  function setScratchpad(text: string): void {
    sync()
    board.value.scratchpad = text.slice(0, 1200)
    touch()
  }

  function cycleReview(key: string): void {
    sync()
    if (!key) return
    const current = (board.value.reviewMarks[key] ?? '') as ReviewMark | ''
    const next = nextReviewMark(current)
    if (next) board.value.reviewMarks[key] = next
    else delete board.value.reviewMarks[key]
    touch()
  }

  return {
    board,
    summary,
    linkedClueCount,
    roleNames,
    sync,
    setSuspicion,
    setTimeline,
    toggleMotive,
    toggleClue,
    setNote,
    setFinalSuspect,
    toggleReason,
    setSummary,
    setScratchpad,
    cycleReview,
  }
})
