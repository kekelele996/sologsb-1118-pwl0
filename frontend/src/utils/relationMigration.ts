import type { Relation, RelationBasis, RelationType } from '@/types'
import { RELATION_BASES, RELATION_TYPES } from '@/types'

export type RelationMigrationField = 'basis' | 'recorder'

export interface RelationIdentity {
  key: string
  unitAId: string
  unitBId: string
  type: RelationType
  reversed: boolean
}

export interface RelationMigrationGroup {
  key: string
  unitAId: string
  unitBId: string
  type: RelationType
  rows: Relation[]
  conflicts: RelationMigrationField[]
  needsDecision: boolean
  reversedRowIds: string[]
}

export interface RelationMigrationPlan {
  groups: RelationMigrationGroup[]
  duplicateGroups: RelationMigrationGroup[]
  duplicateRowCount: number
  removableRowCount: number
  reversedRowCount: number
  groupsNeedingDecision: number
  fingerprint: string
}

export type RelationMigrationDecisions = Record<string, string>

export interface RelationUpgradeChanges {
  puts: Relation[]
  deletedIds: string[]
}

export const RELATION_MIGRATION_STORAGE_KEY = 'gbtrenchlog:relationDedup:v3'

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeRelationType(value: unknown): RelationType {
  return RELATION_TYPES.includes(value as RelationType) ? (value as RelationType) : '叠压'
}

function normalizeBasis(value: unknown): RelationBasis {
  return RELATION_BASES.includes(value as RelationBasis) ? (value as RelationBasis) : '剖面观察'
}

/** 共存是双向关系，按双方 ID 排序得到统一身份；叠压、打破方向不能互换。 */
export function getRelationIdentity(relation: Pick<Relation, 'unitAId' | 'unitBId' | 'type'>): RelationIdentity {
  const type = normalizeRelationType(relation.type)
  let unitAId = normalizeText(relation.unitAId)
  let unitBId = normalizeText(relation.unitBId)
  let reversed = false

  if (type === '共存' && unitAId > unitBId) {
    ;[unitAId, unitBId] = [unitBId, unitAId]
    reversed = true
  }

  return {
    key: `${unitAId}|${type}|${unitBId}`,
    unitAId,
    unitBId,
    type,
    reversed
  }
}

export function normalizeRelation(row: Partial<Relation>): Relation {
  const identity = getRelationIdentity({
    unitAId: normalizeText(row.unitAId),
    unitBId: normalizeText(row.unitBId),
    type: normalizeRelationType(row.type)
  })

  return {
    id: normalizeText(row.id),
    unitAId: identity.unitAId,
    type: identity.type,
    unitBId: identity.unitBId,
    basis: normalizeBasis(row.basis),
    recorder: normalizeText(row.recorder),
    note: normalizeText(row.note)
  }
}

function distinctValues(rows: Relation[], field: RelationMigrationField): string[] {
  return Array.from(new Set(rows.map((row) => normalizeText(row[field]))))
}

function fingerprintPlan(groups: RelationMigrationGroup[]): string {
  const source = groups
    .map((group) => {
      const rows = group.rows
        .map((row) => [row.id, row.basis, row.recorder, row.note].map((item) => normalizeText(item)).join(''))
        .join('')
      return `${group.unitAId}|${group.type}|${group.unitBId}#${rows}`
    })
    .join('•')

  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fm${(hash >>> 0).toString(16)}:${source.length}`
}

/** 扫描旧数据，按「单位 A + 关系类型 + 单位 B」归并重复关系。 */
export function buildRelationMigrationPlan(input: Array<Partial<Relation>>): RelationMigrationPlan {
  const buckets = new Map<string, { identity: RelationIdentity; rows: Relation[]; reversedRowIds: string[] }>()

  input.forEach((raw) => {
    const originalType = normalizeRelationType(raw.type)
    const originalA = normalizeText(raw.unitAId)
    const originalB = normalizeText(raw.unitBId)
    const row = normalizeRelation(raw)
    const identity = getRelationIdentity(row)
    const bucket = buckets.get(identity.key) ?? { identity, rows: [], reversedRowIds: [] }
    bucket.rows.push(row)
    if (originalType === '共存' && (originalA !== identity.unitAId || originalB !== identity.unitBId)) {
      bucket.reversedRowIds.push(row.id)
    }
    buckets.set(identity.key, bucket)
  })

  const groups: RelationMigrationGroup[] = []
  let duplicateRowCount = 0
  let removableRowCount = 0
  let reversedRowCount = 0

  Array.from(buckets.values())
    .sort((a, b) => a.identity.key.localeCompare(b.identity.key))
    .forEach((bucket) => {
      const rows = bucket.rows.sort((a, b) => a.id.localeCompare(b.id))
      const conflicts: RelationMigrationField[] = []
      if (distinctValues(rows, 'basis').length > 1) conflicts.push('basis')
      if (distinctValues(rows, 'recorder').length > 1) conflicts.push('recorder')
      const needsDecision = conflicts.length > 0

      if (rows.length > 1) duplicateRowCount += rows.length
      removableRowCount += rows.length - 1
      reversedRowCount += bucket.reversedRowIds.length

      groups.push({
        key: bucket.identity.key,
        unitAId: bucket.identity.unitAId,
        unitBId: bucket.identity.unitBId,
        type: bucket.identity.type,
        rows,
        conflicts,
        needsDecision,
        reversedRowIds: bucket.reversedRowIds
      })
    })

  const duplicateGroups = groups.filter((group) => group.rows.length > 1)

  return {
    groups,
    duplicateGroups,
    duplicateRowCount,
    removableRowCount,
    reversedRowCount,
    groupsNeedingDecision: groups.filter((group) => group.needsDecision).length,
    fingerprint: fingerprintPlan(groups)
  }
}

function findChoice(group: RelationMigrationGroup, decisions: RelationMigrationDecisions): Relation | null {
  const chosenId = decisions[group.key]
  return group.rows.find((row) => row.id === chosenId) ?? null
}

function mergeGroup(group: RelationMigrationGroup, choice: Relation): Relation {
  const notes = Array.from(new Set(group.rows.map((row) => row.note.trim()).filter(Boolean)))
  return {
    ...choice,
    unitAId: group.unitAId,
    type: group.type,
    unitBId: group.unitBId,
    basis: choice.basis,
    recorder: choice.recorder,
    note: notes.join('；')
  }
}

/** 生成一次 Dexie 升级事务内执行的写入与删除清单。 */
export function prepareRelationUpgrade(
  input: Array<Partial<Relation>>,
  decisions: RelationMigrationDecisions
): RelationUpgradeChanges {
  const plan = buildRelationMigrationPlan(input)
  const missing: string[] = []
  const puts: Relation[] = []
  const deletedIds: string[] = []

  plan.groups.forEach((group) => {
    const choice = findChoice(group, decisions)
    if (group.needsDecision && !choice) {
      missing.push(group.key)
      return
    }

    const merged = mergeGroup(group, choice ?? group.rows[0])
    const needsPut = group.rows.length > 1 || group.reversedRowIds.length > 0
    if (needsPut) puts.push(merged)
    group.rows.forEach((row) => {
      if (row.id !== merged.id) deletedIds.push(row.id)
    })
  })

  if (missing.length > 0) {
    throw new Error(`还有 ${missing.length} 组重复层位关系的依据或记录人未确认`)
  }

  return { puts, deletedIds }
}

interface StoredDecisions {
  fingerprint: string
  decisions: RelationMigrationDecisions
}

export function loadMigrationDecisions(fingerprint: string): RelationMigrationDecisions {
  try {
    const raw = window.localStorage.getItem(RELATION_MIGRATION_STORAGE_KEY)
    if (!raw) return {}
    const stored = JSON.parse(raw) as StoredDecisions
    return stored.fingerprint === fingerprint ? stored.decisions : {}
  } catch {
    return {}
  }
}

export function saveMigrationDecisions(
  fingerprint: string,
  decisions: RelationMigrationDecisions
): void {
  try {
    const stored: StoredDecisions = { fingerprint, decisions }
    window.localStorage.setItem(RELATION_MIGRATION_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // 隐私模式或存储受限时仅保留内存中的决策；升级事务仍可原子执行。
  }
}

export function clearMigrationDecisions(): void {
  try {
    window.localStorage.removeItem(RELATION_MIGRATION_STORAGE_KEY)
  } catch {
    // 忽略清理失败，成功升级后旧决策不会再匹配新指纹。
  }
}
