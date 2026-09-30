import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import { db, seedDemoData, stampDbVersion } from '@/hooks/usePersistentStore'
import { runRelationDedupMigration } from '@/migrations/relationDedup'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import '@/styles/main.css'

async function bootstrap(): Promise<void> {
  // 先显式开库：若旧版页面仍占着库会触发 blocked，迁移界面提示等待其关闭
  await db.open()
  await seedDemoData()
  await stampDbVersion()
  // 探方/地层先一步 hydration：去重确认对话框需要显示单位名称
  await trenchStore.getState().hydrate()
  await stratumStore.getState().hydrate()
  // 层位关系去重迁移：重复关系合并为一条，冲突项人工确认；失败回滚、重开继续
  await runRelationDedupMigration()
  await artifactStore.getState().hydrate()
  await relationStore.getState().hydrate()
}

const app = createApp(App)

Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
  app.component(key, component)
})

app.use(router)
app.use(ElementPlus, { locale: zhCn })
app.mount('#app')

void bootstrap()
