import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import { useGameStore } from './stores/game'
import { useNetStore } from './stores/net'
import { playerId } from './services/profile'
import { initPwa } from './services/pwa'
import './styles/main.css'
import './styles/workbench.css'
import './styles/home.css'
import './styles/lobby.css'
import './styles/talk.css'
import './styles/motion.css'
import './styles/reader-acts.css'
import './styles/custom-scripts.css'
import './styles/game-nav.css'
import './styles/settings.css'
import './styles/profile.css'
import './styles/discussion.css'

const app = createApp(App)
app.use(createPinia())
// 演示深链（?demo=1）由路由守卫负责驱动，见 router/index.ts 与 services/demoBootstrap.ts：
// 必须在那里 await，才能保证 /reading 这类 needScript 路由不会被提前弹回 /room。
app.use(router)
app.mount('#app')

// PWA：注册 Service Worker（生产构建才有）+ 接管「安装到桌面」的时机
initPwa()

// 开发期把 store 挂到 window，方便自检脚本直接驱动状态机
// （验证「提前结算」「防冷场」这类需要构造条件的路径）
if (import.meta.env.DEV) {
  const w = window as unknown as { __game: unknown; __net: unknown; __router: unknown; __playerId: string }
  w.__game = useGameStore()
  // 联机自检脚本要用它检查连接状态、房号与收帧
  w.__net = useNetStore()
  // 路由跟随（阶段 → 页面）是联机的关键行为，排障时要能直接看路由状态
  w.__router = router
  // 设备档案 ID：自检脚本用它去服务器核对战绩（localStorage 在多个标签页之间
  // 是共享的，只有这个值才是「本页真正在用的身份」）
  w.__playerId = playerId()
}
