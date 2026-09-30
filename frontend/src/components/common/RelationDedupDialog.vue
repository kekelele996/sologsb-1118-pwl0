<script setup lang="ts">
import { computed } from 'vue'
import { ElButton, ElDialog, ElRadio, ElRadioGroup } from 'element-plus'
import {
  confirmRelationDedup,
  relationDedupState,
  runRelationDedupMigration,
  type RelationDuplicateGroup
} from '@/migrations/relationDedup'
import { useStore } from '@/hooks/usePersistentStore'
import { stratumStore } from '@/stores/stratumStore'
import { trenchStore } from '@/stores/trenchStore'

const stratumState = useStore(stratumStore)
const trenchState = useStore(trenchStore)

const visible = computed({
  get: () => relationDedupState.status !== 'idle' && relationDedupState.status !== 'done',
  set: () => {
    /* 迁移未完成时不允许关闭对话框 */
  }
})
const conflictGroups = computed(() => relationDedupState.groups.filter((group) => !group.autoMerge))
const autoGroupCount = computed(() => relationDedupState.duplicateGroupCount - conflictGroups.value.length)

function unitLabel(stratumId: string): string {
  const stratum = stratumState.strata.find((item) => item.id === stratumId)
  if (!stratum) return '未知单位'
  const trench = trenchState.trenches.find((item) => item.id === stratum.trenchId)
  return `${stratum.code}（${trench ? `${trench.area}·${trench.code}` : '未知探方'}）`
}

function groupLabel(group: RelationDuplicateGroup): string {
  return `${unitLabel(group.unitAId)} ${group.type} ${unitLabel(group.unitBId)}`
}

async function retry(): Promise<void> {
  await runRelationDedupMigration()
}
</script>

<template>
  <ElDialog
    v-if="relationDedupState.status === 'confirm'"
    v-model="visible"
    title="层位关系去重：发现重复记录"
    width="640px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
  >
    <div class="summary">
      共发现 <b>{{ relationDedupState.duplicateGroupCount }}</b> 组重复层位关系、
      <b>{{ relationDedupState.redundantCount }}</b> 条多余记录，同一对单位的同一种关系将只保留一条。
      <template v-if="autoGroupCount > 0">
        其中 <b>{{ autoGroupCount }}</b> 组的判定依据与记录人完全一致，会自动合并；
      </template>
      以下 <b>{{ conflictGroups.length }}</b> 组存在依据或记录人差异，请确认每组保留哪一条：
    </div>

    <div v-for="group in conflictGroups" :key="group.key" class="group">
      <div class="group-title">{{ groupLabel(group) }}</div>
      <ElRadioGroup v-model="relationDedupState.choices[group.key]" class="options">
        <ElRadio v-for="record in group.records" :key="record.id" :value="record.id" class="option">
          <span class="mono">{{ record.basis }}</span>
          <span class="mono">· {{ record.recorder || '未填记录人' }}</span>
          <span v-if="record.note" class="note">· {{ record.note }}</span>
        </ElRadio>
      </ElRadioGroup>
    </div>

    <template #footer>
      <ElButton type="primary" @click="confirmRelationDedup">
        确认合并（{{ conflictGroups.length }} 组差异已选）
      </ElButton>
    </template>
  </ElDialog>

  <div v-else-if="visible" class="mask">
    <div class="panel">
      <template v-if="relationDedupState.status === 'blocked'">
        <div class="spinner" />
        <p class="title">等待其他页面关闭旧版数据</p>
        <p class="desc">
          检测到有浏览器页面（或同事电脑）仍打开着旧版层位关系数据，升级需要独占数据库。
          <br />
          请关闭该页面，关闭后升级将自动继续，无需刷新。
        </p>
      </template>

      <template v-else-if="relationDedupState.status === 'running'">
        <div class="spinner" />
        <p class="title">正在合并重复的层位关系…</p>
        <p class="desc">同一对单位的同一种关系只保留一条，请勿关闭浏览器。</p>
      </template>

      <template v-else-if="relationDedupState.status === 'error'">
        <p class="title error">升级失败，已恢复到升级前的样子</p>
        <p class="desc">
          事务已整体回滚，层位关系数据未发生任何变化。可点击重试继续升级，
          <br />
          或关闭浏览器后重新打开，升级会从未完成处继续。
        </p>
        <p class="error-detail">{{ relationDedupState.error }}</p>
        <ElButton type="primary" @click="retry">重试升级</ElButton>
      </template>

      <template v-else>
        <div class="spinner" />
        <p class="title">正在检查层位关系数据…</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.summary {
  font-size: 13px;
  line-height: 1.8;
  color: #5c5040;
  margin-bottom: 14px;
}
.group {
  border: 1px solid #e6ded0;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.group-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 8px;
  color: #3c2f1f;
}
.options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.option {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  margin-right: 0;
  height: auto;
  white-space: normal;
}
.mono {
  color: #5c5040;
}
.note {
  color: #8a8073;
}
.mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  background: rgba(60, 47, 31, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.panel {
  background: #fff;
  border-radius: 12px;
  padding: 28px 36px;
  max-width: 480px;
  text-align: center;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
}
.spinner {
  width: 34px;
  height: 34px;
  margin: 0 auto 14px;
  border: 3px solid #e6ded0;
  border-top-color: #a9762f;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360);
  }
}
.title {
  font-size: 16px;
  font-weight: 600;
  color: #3c2f1f;
  margin: 0 0 8px;
}
.title.error {
  color: #b03a2e;
}
.desc {
  font-size: 13px;
  color: #8a8073;
  line-height: 1.7;
  margin: 0 0 12px;
}
.error-detail {
  font-size: 12px;
  color: #b03a2e;
  background: #fbeeeC;
  border-radius: 6px;
  padding: 8px 10px;
  margin: 0 0 14px;
  word-break: break-all;
}
</style>
