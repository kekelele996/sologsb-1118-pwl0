import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import RelationMigrationWizard from '@/components/common/RelationMigrationWizard.vue'
import {
  inspectRelationUpgrade,
  seedDemoData,
  stampDbVersion,
  type RelationPreflightReport
} from '@/hooks/usePersistentStore'
import { trenchStore } from '@/stores/trenchStore'
import { stratumStore } from '@/stores/stratumStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import '@/styles/main.css'

function registerApp(app: ReturnType<typeof createApp>): void {
  Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
    app.component(key, component)
  })
  app.use(router)
  app.use(ElementPlus, { locale: zhCn })
}

function mountMainApp(): void {
  const app = createApp(App)
  registerApp(app)
  app.mount('#app')
}

function mountMigrationWizard(report: RelationPreflightReport): void {
  const app = createApp(RelationMigrationWizard, {
    report,
    onFinished: () => {
      document.getElementById('app')?.replaceChildren()
      mountMainApp()
    }
  })
  registerApp(app)
  app.mount('#app')
}

async function bootstrap(): Promise<void> {
  const report = await inspectRelationUpgrade()
  if (report?.needsUpgrade) {
    mountMigrationWizard(report)
    return
  }

  await seedDemoData()
  await stampDbVersion()
  await trenchStore.getState().hydrate()
  await stratumStore.getState().hydrate()
  await artifactStore.getState().hydrate()
  await relationStore.getState().hydrate()
  mountMainApp()
}

void bootstrap().catch((error) => {
  console.error('应用初始化失败', error)
  document.getElementById('app')!.innerHTML = `
    <div style="padding:32px;font-family:sans-serif;color:#3c2f1f">
      <h2>应用初始化失败</h2>
      <p style="color:#7d7264">${error instanceof Error ? error.message : String(error)}</p>
      <p>若提示旧版页面占用，请关闭旧版页面后重新打开浏览器。</p>
    </div>
  `
})
