import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  createCustomScriptRecord,
  loadCustomScripts,
  parseCustomScriptText,
  persistCustomScripts,
  removeCustomScript,
  upsertCustomScript,
  type CustomScriptParseResult,
  type CustomScriptRecord,
  type CustomScriptStorage,
} from '@/services/customScripts'
import type { ScriptPackage } from '@/types/script'

const memory = new Map<string, string>()
const memoryStorage: CustomScriptStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
  removeItem: (key) => void memory.delete(key),
}

function localStore(): CustomScriptStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* 隐私模式退回内存。 */
  }
  return memoryStorage
}

export const useCustomScriptsStore = defineStore('customScripts', () => {
  const records = ref<CustomScriptRecord[]>(loadCustomScripts(localStore()))
  const count = computed(() => records.value.length)

  function persist() {
    persistCustomScripts(localStore(), records.value)
  }

  function addText(text: string): CustomScriptParseResult {
    const parsed = parseCustomScriptText(text)
    if (!parsed.ok || !parsed.pkg) return parsed
    const record = createCustomScriptRecord(parsed.pkg)
    records.value = upsertCustomScript(records.value, record)
    persist()
    return parsed
  }

  function addPackage(pkg: ScriptPackage): CustomScriptParseResult {
    return addText(JSON.stringify(pkg))
  }

  function remove(id: string) {
    records.value = removeCustomScript(records.value, id)
    persist()
  }

  return {
    records,
    count,
    addText,
    addPackage,
    remove,
  }
})
