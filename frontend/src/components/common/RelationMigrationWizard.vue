<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { RelationPreflightReport } from '@/hooks/usePersistentStore'
import { db, seedDemoData, setRelationMigrationDecisions, stampDbVersion } from '@/hooks/usePersistentStore'
import { artifactStore } from '@/stores/artifactStore'
import { relationStore } from '@/stores/relationStore'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'
import {
  clearMigrationDecisions,
  saveMigrationDecisions,
  type RelationMigrationDecisions,
  type RelationMigrationField,
  type RelationMigrationGroup
} from '@/utils/relationMigration'

type Stage = 'review' | 'waiting' | 'upgrading' | 'error' | 'done'

const props = defineProps<{
  report: RelationPreflightReport
  onFinished: () => void
}>()

const stage = ref<Stage>('review')
const errorMessage = ref('')
const decisions = ref<RelationMigrationDecisions>({ ...props.report.decisions })

const plan = computed(() => props.report.plan)
const conflictGroups = computed(() => plan.value.duplicateGroups.filter((group) => group.needsDecision))
const automaticGroups = computed(() => plan.value.duplicateGroups.filter((group) => !group.needsDecision))
const unresolvedGroups = computed(() =>
  conflictGroups.value.filter((group) => !group.rows.some((row) => row.id === decisions.value[group.key]))
)

watch(
  decisions,
  (value) => saveMigrationDecisions(plan.value.fingerprint, value),
  { deep: true, immediate: true }
)

db.on('blocked', () => {
  if (stage.value === 'upgrading' || stage.value === 'waiting') stage.value = 'waiting'
})

onMounted(() => {
  if (unresolvedGroups.value.length === 0) {
    void startUpgrade()
  }
})

function stratumLabel(unitId: string): string {
  const stratum = props.report.strata.find((item) => item.id === unitId)
  if (!stratum) return `未知单位 ${unitId}`
  const trench = props.report.trenches.find((item) => item.id === stratum.trenchId)
  const trenchText = trench ? `${trench.area}·${trench.code}` : '未知探方'
  return `${stratum.code}（${trenchText} · ${stratum.type}）`
}

function conflictText(fields: RelationMigrationField[]): string {
  return fields.map((field) => (field === 'basis' ? '判定依据' : '记录人')).join('、')
}

function choose(group: RelationMigrationGroup, rowId: string): void {
  decisions.value[group.key] = rowId
}

async function startUpgrade(): Promise<void> {
  if (unresolvedGroups.value.length > 0) {
    ElMessage.warning(`还有 ${unresolvedGroups.value.length} 组依据或记录人不一致，请先选择保留内容`)
    return
  }

  errorMessage.value = ''
  stage.value = 'upgrading'
  setRelationMigrationDecisions(decisions.value)

  try {
    await db.open()
    stage.value = 'upgrading'

    const trenchesCount = await db.trenches.count()
    if (trenchesCount === 0) {
      await seedDemoData()
    }
    await stampDbVersion()
    await Promise.all([
      trenchStore.getState().hydrate(),
      stratumStore.getState().hydrate(),
      artifactStore.getState().hydrate(),
      relationStore.getState().hydrate()
    ])

    clearMigrationDecisions()
    stage.value = 'done'
    window.setTimeout(() => props.onFinished(), 900)
  } catch (error) {
    stage.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <div class="migration-page">
    <el-card class="migration-card" shadow="always">
      <template #header>
        <div class="card-header">
          <div>
            <h2>层位关系数据升级</h2>
            <p>同一对地层单位、同一种关系将只保留一条，修复关系图、层序核对和探方关系统计重复计数。</p>
          </div>
          <el-tag :type="stage === 'done' ? 'success' : stage === 'error' ? 'danger' : 'warning'" size="large">
            {{ stage === 'review' ? '待确认' : stage === 'waiting' ? '等待旧版退出' : stage === 'upgrading' ? '升级中' : stage === 'done' ? '已完成' : '需重试' }}
          </el-tag>
        </div>
      </template>

      <el-alert
        class="summary"
        type="info"
        :closable="false"
        show-icon
        :title="`发现 ${plan.duplicateGroups.length} 组重复关系、${plan.duplicateRowCount} 条记录；升级后将删除 ${plan.removableRowCount} 条重复记录。`"
        :description="[
          plan.groupsNeedingDecision > 0
            ? `其中 ${plan.groupsNeedingDecision} 组的判定依据或记录人不一致，需要先确认。备注会自动合并。`
            : '重复记录的依据和记录人一致，可直接自动合并；备注会自动合并。',
          plan.reversedRowCount > 0 ? `另有 ${plan.reversedRowCount} 条反向记录的「共存」关系会按同一无向关系统一方向。` : ''
        ].filter(Boolean).join('')"
      />

      <template v-if="stage === 'review'">
        <section v-if="conflictGroups.length > 0" class="section">
          <h3>需要人工确认（{{ conflictGroups.length }}）</h3>
          <article v-for="group in conflictGroups" :key="group.key" class="group required">
            <div class="group-head">
              <div>
                <strong>{{ stratumLabel(group.unitAId) }}</strong>
                <el-tag effect="dark" class="relation-type">{{ group.type }}</el-tag>
                <strong>{{ stratumLabel(group.unitBId) }}</strong>
              </div>
              <el-tag type="danger">{{ conflictText(group.conflicts) }}不一致</el-tag>
            </div>
            <el-radio-group
              :model-value="decisions[group.key]"
              class="choices"
              @update:model-value="(value: string) => choose(group, value)"
            >
              <label v-for="row in group.rows" :key="row.id" class="choice">
                <el-radio :value="row.id">
                  <span class="choice-body">
                    <span><b>依据：</b>{{ row.basis }}</span>
                    <span><b>记录人：</b>{{ row.recorder || '未填' }}</span>
                    <span class="note"><b>备注：</b>{{ row.note || '无' }}</span>
                  </span>
                </el-radio>
              </label>
            </el-radio-group>
          </article>
        </section>

        <section class="section">
          <h3>将自动合并（{{ automaticGroups.length }}）</h3>
          <el-table :data="automaticGroups" size="small" border>
            <el-table-column label="地层单位关系" min-width="260">
              <template #default="{ row }: { row: RelationMigrationGroup }">
                {{ stratumLabel(row.unitAId) }} {{ row.type }} {{ stratumLabel(row.unitBId) }}
              </template>
            </el-table-column>
            <el-table-column label="重复条数" width="90" align="center">
              <template #default="{ row }: { row: RelationMigrationGroup }">
                {{ row.rows.length }}
              </template>
            </el-table-column>
            <el-table-column label="保留依据" min-width="170">
              <template #default="{ row }: { row: RelationMigrationGroup }">
                {{ row.rows[0].basis }} · {{ row.rows[0].recorder || '未填记录人' }}
              </template>
            </el-table-column>
          </el-table>
        </section>

        <el-alert
          class="atomic-note"
          type="warning"
          :closable="false"
          show-icon
          title="升级会在同一个 IndexedDB 事务内一次完成；中途失败会整体回滚到升级前。若浏览器被关闭，重新打开后可继续。"
        />
        <div class="actions">
          <el-button type="primary" :disabled="unresolvedGroups.length > 0" @click="startUpgrade">
            确认并开始一次升级
          </el-button>
          <span v-if="unresolvedGroups.length > 0" class="muted">还需确认 {{ unresolvedGroups.length }} 组</span>
        </div>
      </template>

      <template v-else-if="stage === 'waiting'">
        <el-result icon="warning" title="正在等待旧版页面退出" sub-title="请通知同事关闭仍打开旧版页面的浏览器标签页；关闭后升级会自动继续，不需要刷新。">
          <template #extra>
            <div class="waiting-box">
              <el-icon class="is-loading"><i-loading /></el-icon>
              <span>新版页面已暂停在数据库外等待，当前不会改动任何数据。</span>
            </div>
          </template>
        </el-result>
      </template>

      <template v-else-if="stage === 'upgrading'">
        <el-result icon="info" title="正在合并重复层位关系" sub-title="请不要关闭浏览器；合并、去重和唯一索引创建会在同一个事务中完成。">
          <template #extra>
            <el-progress :percentage="100" :indeterminate="true" :show-text="false" />
          </template>
        </el-result>
      </template>

      <template v-else-if="stage === 'error'">
        <el-result
          icon="error"
          title="升级未完成，数据已保持升级前状态"
          :sub-title="errorMessage || '升级事务已回滚。请处理问题后重新打开浏览器继续。'"
        >
          <template #extra>
            <el-button type="primary" @click="startUpgrade">重新打开并继续升级</el-button>
          </template>
        </el-result>
      </template>

      <template v-else>
        <el-result icon="success" title="层位关系升级完成" sub-title="重复记录已合并，唯一约束已生效；正在进入新版页面。" />
      </template>
    </el-card>
  </div>
</template>

<style scoped>
.migration-page {
  min-height: 100%;
  display: flex;
  justify-content: center;
  padding: 36px 20px;
  background: #f7f4ee;
}
.migration-card {
  width: min(980px, 100%);
  border-radius: 14px;
}
.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.card-header h2 {
  margin: 0 0 6px;
  font-size: 20px;
}
.card-header p {
  margin: 0;
  color: #7d7264;
  font-size: 13px;
}
.summary {
  margin-bottom: 18px;
}
.section {
  margin-bottom: 20px;
}
.section h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.group {
  padding: 12px;
  margin-bottom: 10px;
  border: 1px solid #e6ded0;
  border-radius: 10px;
  background: #fff;
}
.group.required {
  border-color: #e6a23c;
  background: #fffaf0;
}
.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.relation-type {
  margin: 0 8px;
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.choice {
  display: flex;
  padding: 8px;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
}
.choice-body {
  display: grid;
  gap: 4px;
  font-size: 13px;
}
.note {
  color: #7d7264;
}
.atomic-note {
  margin-top: 16px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 18px;
}
.muted {
  color: #9b8d79;
  font-size: 13px;
}
.waiting-box {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #7d7264;
}
:deep(.el-progress) {
  width: 280px;
}
</style>
