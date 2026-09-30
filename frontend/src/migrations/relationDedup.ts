import { reactive } from 'vue'
import { ElMessage } from 'element-plus'
import type { Relation, RelationType } from '@/types'
import { db, type MetaRow } from '@/hooks/usePersistentStore'

/** 层位关系去重迁移在 meta 表中的标记键 */
export const RELATION_DEDUP_META_KEY = 'relationDedup'
export const RELATION_DEDUP_META_VALUE = 1

/**
 * 同一对地层单位、同一种关系的判重键。
 * - 叠压/打破有方向：A 叠压 B 与 B 叠压 A 不是同一条；
 * - 共存无方向：A 共存 B 与 B 共存 A 视为同一对（单位 id 排序后拼键）。
 */
export function relationDedupKey(relation: Pick<Relation, 'unitAId' | 'unitBId' | 'type'>): string {
  if (relation.type === '共存') {
    const [a, b] = [relation.unitAId, relation.unitBId].sort()
    return `共存|${a}|${b}`
  }
  return `${relation.type}|${relation.unitAId}|${relation.unitBId}`
}

export interface RelationDuplicateGroup {
  key: string
  type: RelationType
  unitAId: string
  unitBId: string
  /** 组内全部记录，按 id 升序（第一条为保留的最早记录） */
  records: Relation[]
  /** 依据与记录人是否完全一致（一致则可自动合并，无需人工确认） */
  autoMerge: boolean
  basisOptions: Relation['basis'][]
  recorderOptions: string[]
}

export type DedupStatus = 'idle' | 'blocked' | 'checking' | 'confirm' | 'running' | 'done' | 'error'

/** 全局迁移状态（对话框组件与启动流程共用） */
export const relationDedupState = reactive({
  status: 'idle' as DedupStatus,
  groups: [] as RelationDuplicateGroup[],
  /** 冲突组保留哪一条：groupKey -> relationId（默认保留最早一条） */
  choices: {} as Record<string, string>,
  duplicateGroupCount: 0,
  redundantCount: 0,
  mergedCount: 0,
  error: ''
})

// 旧版页面占着库时，IndexedDB 升级会被阻塞（blocked）；状态切到 blocked，界面提示等待
db.on('blocked', () => {
  if (relationDedupState.status !== 'done') relationDedupState.status = 'blocked'
})

let confirmResolve: (() => void) | null = null

/** 扫描全部层位关系，按判重键分组；依据与记录人全部一致的可自动合并，其余需人工确认 */
export function analyzeDuplicateGroups(all: Relation[]): RelationDuplicateGroup[] {
  const buckets = new Map<string, Relation[]>()
  all.forEach((relation) => {
    const key = relationDedupKey(relation)
    const bucket = buckets.get(key) ?? []
    bucket.push(relation)
    buckets.set(key, bucket)
  })

  const groups: RelationDuplicateGroup[] = []
  buckets.forEach((records, key) => {
    if (records.length < 2) return
    records.sort((a, b) => a.id.localeCompare(b.id))
    const basisOptions = Array.from(new Set(records.map((item) => item.basis)))
    const recorderOptions = Array.from(new Set(records.map((item) => item.recorder)))
    const parts = key.split('|')
    const type = parts[0] as RelationType
    groups.push({
      key,
      type,
      unitAId: parts[1],
      unitBId: parts[2],
      records,
      autoMerge: basisOptions.length === 1 && recorderOptions.length === 1,
      basisOptions,
      recorderOptions
    })
  })
  return groups
}

/** 确认对话框中点击「合并」后调用 */
export function confirmRelationDedup(): void {
  if (relationDedupState.status !== 'confirm') return
  relationDedupState.status = 'running'
  const resolve = confirmResolve
  confirmResolve = null
  resolve?.()
}

function waitForUserConfirm(): Promise<void> {
  return new Promise((resolve) => {
    confirmResolve = resolve
  })
}

/**
 * 单事务应用去重：组内保留一条（自动组保留最早记录并去重合并备注；
 * 冲突组保留用户所选记录），其余删除，并在 meta 表打完成标记。
 * 事务中途失败会整体回滚到升级前的样子。
 */
async function applyDedupTransaction(choices: Record<string, string>): Promise<void> {
  await db.transaction('rw', [db.relations, db.meta], async (tx) => {
    // 事务内重新取数，避免等待用户确认期间数据发生变化
    const liveGroups = analyzeDuplicateGroups(await tx.table<Relation, string>('relations').toArray())
    const toPut: Relation[] = []
    const toDelete: string[] = []

    for (const group of liveGroups) {
      const keeperId = choices[group.key]
      const keeper = group.records.find((item) => item.id === keeperId) ?? group.records[0]
      const redundant = group.records.filter((item) => item.id !== keeper.id)
      // 自动合并组：备注去重后拼到保留记录上，不丢信息；冲突组以用户所选记录为准
      const note = group.autoMerge
        ? Array.from(new Set([keeper.note, ...redundant.map((item) => item.note)].filter(Boolean))).join('；')
        : keeper.note
      toPut.push({ ...keeper, note })
      toDelete.push(...redundant.map((item) => item.id))
    }

    const relations = tx.table<Relation, string>('relations')
    if (toDelete.length > 0) {
      await relations.bulkPut(toPut)
      await relations.bulkDelete(toDelete)
    }
    await tx.table<MetaRow, string>('meta').put({
      key: RELATION_DEDUP_META_KEY,
      value: RELATION_DEDUP_META_VALUE
    })
  })
}

/**
 * 层位关系去重迁移（一次性），启动时执行：
 * 1. 打开数据库——若旧版页面仍占着库会触发 blocked，等待对方关闭后自动继续；
 * 2. 扫描重复组：依据与记录人一致的自动合并，不一致的列出由人工确认保留哪条；
 * 3. 全部合并在同一个读写事务内完成，中途失败整体回滚，重开浏览器可继续升完；
 * 4. 完成后在 meta 表打标记，重开不再重复执行。
 */
export async function runRelationDedupMigration(): Promise<void> {
  const state = relationDedupState
  if (state.status === 'done') return
  state.error = ''

  try {
    await db.open()
    if (state.status === 'blocked') state.status = 'checking'

    const stamped = await db.meta.get(RELATION_DEDUP_META_KEY)
    if (stamped?.value === RELATION_DEDUP_META_VALUE) {
      state.status = 'done'
      return
    }

    const groups = analyzeDuplicateGroups(await db.relations.toArray())
    if (groups.length === 0) {
      await db.meta.put({ key: RELATION_DEDUP_META_KEY, value: RELATION_DEDUP_META_VALUE })
      state.status = 'done'
      return
    }

    state.groups = groups
    state.duplicateGroupCount = groups.length
    state.redundantCount = groups.reduce((total, group) => total + group.records.length - 1, 0)

    const conflicts = groups.filter((group) => !group.autoMerge)
    if (conflicts.length > 0) {
      const choices: Record<string, string> = {}
      conflicts.forEach((group) => {
        choices[group.key] = group.records[0].id
      })
      state.choices = choices
      state.status = 'confirm'
      await waitForUserConfirm()
    } else {
      state.status = 'running'
    }

    await applyDedupTransaction(state.choices)
    state.mergedCount = state.redundantCount
    state.status = 'done'
    try {
      ElMessage.success(`层位关系去重完成：${state.duplicateGroupCount} 组重复、${state.mergedCount} 条多余记录已合并为一条`)
    } catch {
      // 提示渲染失败不影响迁移结果
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error)
    state.status = 'error'
  }
}
