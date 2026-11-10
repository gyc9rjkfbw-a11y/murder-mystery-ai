<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppTopBar from '@/components/AppTopBar.vue'
import InstallCard from '@/components/InstallCard.vue'
import ProfileCard from '@/components/ProfileCard.vue'
import { useToast } from '@/composables/useToast'
import { testConnection, type AiProvider } from '@/services/aiEngine'
import { SYSTEM_PROMPT } from '@/services/systemPrompt'
import { useSettingsStore } from '@/stores/settings'
import SheetModal from '@/components/SheetModal.vue'
import {
  loadScriptHistory,
  persistScriptHistory,
  type ScriptHistoryStorage,
} from '@/services/scriptHistory'

const settings = useSettingsStore()
const toast = useToast()

const testing = ref(false)
const testResult = ref('')
const promptOpen = ref(false)
const historyCount = ref(0)

const ai = computed(() => settings.state.ai)

function scriptHistoryStorage(): ScriptHistoryStorage {
  return localStorage
}

function refreshHistoryCount(): void {
  try {
    historyCount.value = loadScriptHistory(scriptHistoryStorage()).length
  } catch {
    historyCount.value = 0
  }
}

function clearScriptHistory(): void {
  if (!window.confirm('清空最近剧本记录？清空后，相同案件可能再次被生成。')) return
  try {
    persistScriptHistory(scriptHistoryStorage(), [])
    refreshHistoryCount()
    toast.info('最近剧本记录已清空')
  } catch {
    toast.error('无法清除本地剧本记录')
  }
}

const providers: { key: AiProvider; title: string; desc: string }[] = [
  {
    key: 'offline',
    title: '离线模拟引擎',
    desc: '内置剧本库 + 三步生成法，无需联网与密钥，随时开局。',
  },
  {
    key: 'openai',
    title: '真实大模型',
    desc: '任意 OpenAI 兼容端点：DeepSeek / 通义千问 / Kimi / 本地 vLLM。',
  },
]

const presets = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '通义千问（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
]

function applyPreset(p: (typeof presets)[number]) {
  ai.value.baseUrl = p.baseUrl
  ai.value.model = p.model
  toast.info(`已填入 ${p.label} 的地址与模型名`)
}

async function runTest() {
  testing.value = true
  testResult.value = ''
  const res = await testConnection({ ...ai.value })
  testResult.value = res.message
  testing.value = false
  if (res.ok) toast.success('连接正常')
  else toast.error('连接失败')
}

onMounted(refreshHistoryCount)
</script>

<template>
  <AppTopBar title="设置" sub="AI 引擎与个人信息" show-back />

  <main class="page">
    <!-- 我的档案：头像 / 昵称 / 战绩 / 最近对局（免登录，跟设备走） -->
    <ProfileCard />

    <section class="card">
      <h3 class="card__title">剧本生成引擎</h3>
      <button
        v-for="p in providers"
        :key="p.key"
        class="theme"
        style="width: 100%; text-align: left; margin-bottom: 10px"
        :class="{ 'theme--on': ai.provider === p.key }"
        @click="settings.setProvider(p.key)"
      >
        <div style="display: flex; align-items: center; gap: 8px">
          <span style="font-size: 14px; font-weight: 600">{{ p.title }}</span>
          <span v-if="ai.provider === p.key" class="tag tag--gold" style="margin-left: auto">
            使用中
          </span>
        </div>
        <div class="tiny muted" style="margin-top: 6px">{{ p.desc }}</div>
      </button>
      <p class="card__hint">
        当前：{{ settings.providerLabel }}
      </p>
    </section>

    <section v-if="ai.provider === 'openai'" class="card">
      <h3 class="card__title">接口配置</h3>

      <!-- 选了真实大模型却没填 Key：这是最常见的「生成剧本失败」原因，提前在这里说清楚 -->
      <p
        v-if="!String(ai.apiKey ?? '').trim()"
        class="small"
        style="margin: 0 0 12px; color: #ef8a7c"
      >
        ⚠️ 还没填 API Key：现在开局会在「下发剧本」页失败。填好下面的密钥，
        或把上面的引擎改回「离线模拟引擎」（内置、不联网、一定能生成）。
      </p>

      <div class="field">
        <label class="field__label">快速填充</label>
        <div style="display: flex; flex-wrap: wrap; gap: 8px">
          <button v-for="p in presets" :key="p.label" class="mini-btn" @click="applyPreset(p)">
            {{ p.label }}
          </button>
        </div>
      </div>

      <div class="field">
        <label class="field__label">Base URL</label>
        <input v-model="ai.baseUrl" class="input" placeholder="https://api.deepseek.com/v1" />
      </div>

      <div class="field">
        <label class="field__label">API Key</label>
        <input v-model="ai.apiKey" class="input" type="password" placeholder="sk-..." />
        <p class="tiny muted" style="margin: 6px 0 0">
          密钥只保存在本机浏览器 localStorage，不会上传到任何第三方服务器。
        </p>
      </div>

      <div class="field">
        <label class="field__label">模型名</label>
        <input v-model="ai.model" class="input" placeholder="deepseek-chat" />
      </div>

      <div class="field">
        <label class="field__label">温度 {{ ai.temperature.toFixed(1) }}</label>
        <input
          v-model.number="ai.temperature"
          class="input"
          type="range"
          min="0"
          max="2"
          step="0.1"
        />
        <p class="tiny muted" style="margin: 6px 0 0">
          剧本创作建议 0.9 - 1.2，太低会写成大纲，太高会逻辑崩坏。
        </p>
      </div>

      <div class="btn-row">
        <button class="btn" :disabled="testing" @click="runTest">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn btn--ghost" @click="promptOpen = true">查看系统指令</button>
      </div>
      <p v-if="testResult" class="small" style="margin: 10px 0 0" :class="testResult.includes('成功') ? 'gold' : 'blood'">
        {{ testResult }}
      </p>
      <p class="card__hint" style="margin-top: 10px">
        提示：浏览器直连大模型可能被跨域（CORS）拦截，正式部署请由后端代理转发。
      </p>
    </section>

    <section class="card card--flat">
      <div class="list-row" @click="settings.state.demoMode = !settings.state.demoMode">
        <div>
          <div style="font-size: 14px">单人演示模式</div>
          <div class="tiny muted">开启后可查看全部角色剧本与凶手特权</div>
        </div>
        <span class="tag" :class="settings.state.demoMode ? 'tag--gold' : ''">
          {{ settings.state.demoMode ? '已开启' : '已关闭' }}
        </span>
      </div>
    </section>

    <section class="card card--flat">
      <div class="list-row">
        <div>
          <div style="font-size: 14px">AI 剧本防重复</div>
          <div class="tiny muted">
            最近记录 {{ historyCount }} 局；相同案件会被拒绝并自动要求重写
          </div>
        </div>
        <button class="mini-btn" :disabled="historyCount === 0" @click="clearScriptHistory">
          清空记录
        </button>
      </div>
    </section>

    <section class="card card--flat">
      <button class="btn btn--ghost" @click="settings.reset()">恢复默认设置</button>
    </section>

    <InstallCard />

    <p class="tiny muted center" style="margin-top: 20px">
      迷案 · AI 剧本杀 前端 v0.1.0<br />
      Vue 3 + Vite + TypeScript
    </p>
  </main>

  <SheetModal :open="promptOpen" title="剧本杀 AI 游戏引擎系统指令" @close="promptOpen = false">
    <pre
      class="tiny"
      style="white-space: pre-wrap; color: var(--text-dim); line-height: 1.75; margin: 0"
    >{{ SYSTEM_PROMPT }}</pre>
  </SheetModal>
</template>
