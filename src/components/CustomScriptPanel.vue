<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import SheetModal from '@/components/SheetModal.vue'
import { useToast } from '@/composables/useToast'
import type { CustomScriptParseResult } from '@/services/customScripts'
import { DIFFICULTIES, normalizeDifficulty } from '@/services/difficulty'
import { TEMPLATES } from '@/services/templates'
import { useCustomScriptsStore } from '@/stores/customScripts'
import { useGameStore } from '@/stores/game'
import { useSettingsStore } from '@/stores/settings'
import type { Difficulty, ScriptPackage } from '@/types/script'

const emit = defineEmits<{
  (e: 'start-solo', pkg: ScriptPackage): void
  (e: 'start-online', pkg: ScriptPackage): void
}>()

const router = useRouter()
const store = useCustomScriptsStore()
const game = useGameStore()
const settings = useSettingsStore()
const toast = useToast()
const fileInput = ref<HTMLInputElement | null>(null)
const pasteOpen = ref(false)
const pasteText = ref('')
const importErrors = ref<string[]>([])
const generationErrors = ref<string[]>([])
const selectedId = ref(store.records[0]?.id ?? '')
const aiTheme = ref('')
const aiCount = ref(5)
/** AI 按主题写剧本时的难度（跟开局页共用同一个默认档） */
const aiDifficulty = ref<Difficulty>(settings.state.defaultDifficulty)

const selected = computed(
  () => store.records.find((record) => record.id === selectedId.value) ?? store.records[0],
)
const draft = computed(() => game.customDraft)
const progress = computed(() => game.generating.progress)
const generating = computed(() => game.generating.busy)

function accepted(result: CustomScriptParseResult): void {
  if (!result.ok || !result.pkg) {
    importErrors.value = result.errors
    toast.error('剧本未通过校验')
    return
  }
  importErrors.value = []
  selectedId.value = store.records[0]?.id ?? ''
  pasteText.value = ''
  pasteOpen.value = false
  toast.success('自定义剧本已保存')
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 1_000_000) {
    importErrors.value = ['剧本文件超过 1 MB，请精简后再导入']
    toast.error('文件过大')
    return
  }
  accepted(store.addText(await file.text()))
}

function savePaste(): void {
  accepted(store.addText(pasteText.value))
}

function select(recordId: string): void {
  selectedId.value = recordId
  importErrors.value = []
}

function removeSelected(): void {
  const record = selected.value
  if (!record) return
  if (!window.confirm(`删除自定义剧本「${record.title}」？`)) return
  store.remove(record.id)
  selectedId.value = store.records[0]?.id ?? ''
  toast.info('已删除自定义剧本')
}

function downloadSample(): void {
  const sample = TEMPLATES[0].create(5)
  const blob = new Blob([JSON.stringify(sample, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = '谜案剧本杀-自定义剧本模板.json'
  link.click()
  URL.revokeObjectURL(url)
  toast.success('已下载 5 人剧本模板')
}

async function generateDraft(): Promise<void> {
  generationErrors.value = []
  const result = await game.generateCustomDraft(
    aiTheme.value,
    aiCount.value,
    undefined,
    normalizeDifficulty(aiDifficulty.value),
  )
  if (!result.ok) {
    generationErrors.value = result.errors
    toast.error('剧本生成失败')
    return
  }
  if (result.warnings.length) toast.info(result.warnings[0])
  toast.success('剧本已生成，请确认后分发给玩家')
}

function startDraftSolo(): void {
  if (draft.value) emit('start-solo', draft.value)
}

function startDraftOnline(): void {
  if (draft.value) emit('start-online', draft.value)
}

function startSavedSolo(): void {
  if (selected.value) emit('start-solo', selected.value.pkg)
}

function startSavedOnline(): void {
  if (selected.value) emit('start-online', selected.value.pkg)
}

function dateText(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
</script>

<template>
  <section class="card custom-scripts">
    <div class="custom-scripts__head">
      <div>
        <div class="custom-scripts__kicker">CUSTOM STORY</div>
        <h3 class="card__title" style="margin-bottom: 4px">挑选剧本</h3>
        <p class="card__hint">从剧本库选择已保存案件，或让 AI 按你的主题写一份新剧本。</p>
      </div>
      <span class="tag tag--gold">{{ settings.providerLabel }}</span>
    </div>

    <div class="custom-scripts__library">
      <div class="custom-scripts__library-head">
        <div>
          <strong>已保存剧本</strong>
          <span>可直接用于联机房间或单人试玩</span>
        </div>
        <small>{{ store.records.length }} 个</small>
      </div>

      <div v-if="store.records.length === 0" class="custom-scripts__empty">
        <p>剧本库还是空的</p>
        <span>可以导入剧本文件或粘贴任意文本，或在下方让 AI 生成一份新剧本。</span>
      </div>

      <template v-else>
        <div class="custom-scripts__list" role="listbox" aria-label="自定义剧本列表">
          <button
            v-for="record in store.records"
            :key="record.id"
            class="custom-script"
            :class="{ 'custom-script--on': selected?.id === record.id }"
            role="option"
            :aria-selected="selected?.id === record.id"
            @click="select(record.id)"
          >
            <span class="custom-script__main">
              <strong>{{ record.title }}</strong>
              <small>{{ record.playerCount }} 人 · {{ record.pkg.roles.length }} 个角色 · {{ dateText(record.updatedAt) }}</small>
            </span>
            <span class="tag">剧本</span>
          </button>
        </div>

        <div v-if="selected" class="custom-scripts__selected">
          <div>
            <span>当前选中</span>
            <strong>{{ selected.title }}</strong>
            <small>{{ selected.playerCount }} 人 · {{ selected.pkg.private_clues?.length ?? 0 }} 条私有线索</small>
          </div>
          <button class="mini-btn" @click="removeSelected">删除</button>
        </div>

        <div class="custom-scripts__start">
          <button class="btn btn--primary" @click="startSavedOnline">用此剧本创建联机房间</button>
          <button class="btn btn--ghost" @click="startSavedSolo">单人带 AI 开局</button>
        </div>
      </template>
    </div>

    <div class="custom-ai">
      <div class="custom-ai__heading">
        <strong>AI 按主题写剧本</strong>
        <span>不会与最近生成的案件重复</span>
      </div>
      <label class="field">
        <span class="field__label">你想写一个什么故事？</span>
        <textarea
          v-model="aiTheme"
          class="textarea custom-ai__theme"
          maxlength="180"
          placeholder="例如：1998 年南方小城的录像厅，最后一盘录像带里拍到了失踪者的脸。要求有旧时代气味、双线叙事和一场停电。"
        />
      </label>

      <div class="custom-ai__settings">
        <div>
          <span class="custom-ai__label">玩家人数</span>
          <div class="chips">
            <button
              v-for="count in [4, 5, 6]"
              :key="count"
              class="chip"
              :class="{ 'chip--on': aiCount === count }"
              @click="aiCount = count"
            >
              {{ count }} 人
            </button>
          </div>
        </div>
        <div>
          <span class="custom-ai__label">剧本难度</span>
          <div class="chips">
            <button
              v-for="d in DIFFICULTIES"
              :key="d.id"
              class="chip"
              :class="{ 'chip--on': aiDifficulty === d.id }"
              @click="aiDifficulty = d.id"
            >
              {{ d.label }}
            </button>
          </div>
        </div>
        <button class="mini-btn" @click="router.push('/settings')">AI 设置</button>
      </div>

      <button class="btn btn--primary" :disabled="generating || !aiTheme.trim()" @click="generateDraft">
        {{ generating ? 'AI 正在写剧本…' : '让 AI 生成完整剧本' }}
      </button>

      <div v-if="generating" class="custom-ai__progress">
        <div class="custom-ai__progress-head">
          <span>{{ progress?.label ?? '正在建立剧情矩阵…' }}</span>
          <small>{{ progress?.step ?? 0 }}/{{ progress?.totalSteps ?? 4 }}</small>
        </div>
        <div class="custom-ai__bar">
          <span :style="{ width: `${((progress?.step ?? 0) / (progress?.totalSteps ?? 4)) * 100}%` }" />
        </div>
      </div>

      <div v-if="generationErrors.length" class="custom-scripts__errors">
        <strong>生成未完成</strong>
        <p v-for="error in generationErrors.slice(0, 8)" :key="error">{{ error }}</p>
      </div>
    </div>

    <article v-if="draft" class="custom-draft">
      <div class="custom-draft__head">
        <div>
          <span class="tag tag--ok">AI 剧本草稿</span>
          <h4>{{ draft.game_config.theme }}</h4>
          <p>{{ draft.roles.length }} 名角色 · {{ draft.clue_batches?.length ?? 0 }} 批公共线索</p>
        </div>
        <span class="custom-draft__status">待分发</span>
      </div>

      <p class="custom-draft__background">{{ draft.game_config.background_story }}</p>
      <div class="custom-draft__roles">
        <span v-for="role in draft.roles" :key="role.name">{{ role.name }}</span>
      </div>

      <div class="custom-scripts__start">
        <button class="btn btn--primary" @click="startDraftOnline">创建联机房间并分发剧本</button>
        <button class="btn btn--ghost" @click="startDraftSolo">单人带 AI 试玩</button>
      </div>
      <p class="tiny muted custom-draft__note">
        联机创建后，服务器会重新校验剧本，并按座位分别下发角色内容。
      </p>
    </article>

    <details class="custom-scripts__import">
      <summary>导入 / 粘贴外部剧本</summary>
      <div class="custom-scripts__import-body">
        <div class="custom-scripts__actions">
          <button class="mini-btn mini-btn--gold" @click="fileInput?.click()">导入文件</button>
          <button class="mini-btn" @click="pasteOpen = true">粘贴内容</button>
          <button class="mini-btn" @click="downloadSample">下载模板</button>
          <input ref="fileInput" class="custom-scripts__file" type="file" @change="onFile" />
        </div>

        <div v-if="importErrors.length" class="custom-scripts__errors">
          <strong>导入未完成</strong>
          <p v-for="error in importErrors.slice(0, 8)" :key="error">{{ error }}</p>
          <p v-if="importErrors.length > 8" class="tiny">另有 {{ importErrors.length - 8 }} 项错误未显示</p>
        </div>

      </div>
    </details>
  </section>

  <SheetModal :open="pasteOpen" title="粘贴自定义剧本" @close="pasteOpen = false">
    <p class="card__hint" style="margin-bottom: 10px">
      不做格式校验，输入什么就存什么。能识别为剧本对象的会直接用于开局；其它文本原样保存，并套用内置模板骨架供试玩。
    </p>
    <textarea
      v-model="pasteText"
      class="textarea custom-scripts__paste"
      placeholder="在这里粘贴剧本内容（任意文本）"
      spellcheck="false"
    />
    <button class="btn btn--primary" :disabled="!pasteText.trim()" @click="savePaste">
      保存
    </button>
  </SheetModal>
</template>
