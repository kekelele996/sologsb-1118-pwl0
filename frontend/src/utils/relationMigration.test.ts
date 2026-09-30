import assert from 'node:assert/strict'
import type { Relation } from '@/types'
import { buildRelationMigrationPlan, prepareRelationUpgrade } from './relationMigration.ts'

const rows: Array<Partial<Relation>> = [
  { id: 'rl_1', unitAId: 'a', unitBId: 'b', type: '叠压', basis: '剖面观察', recorder: '甲', note: '第一条' },
  { id: 'rl_2', unitAId: 'a', unitBId: 'b', type: '叠压', basis: '平面观察', recorder: '乙', note: '第二条' },
  { id: 'rl_3', unitAId: 'c', unitBId: 'd', type: '共存', basis: '剖面观察', recorder: '丙', note: '正向' },
  { id: 'rl_4', unitAId: 'd', unitBId: 'c', type: '共存', basis: '剖面观察', recorder: '丙', note: '反向' }
]

const plan = buildRelationMigrationPlan(rows)
assert.equal(plan.duplicateGroups.length, 2)
assert.equal(plan.removableRowCount, 2)
assert.equal(plan.groupsNeedingDecision, 1)
assert.equal(plan.reversedRowCount, 1)

assert.throws(() => prepareRelationUpgrade(rows, {}), /未确认/)

const conflictKey = 'a|叠压|b'
const changes = prepareRelationUpgrade(rows, { [conflictKey]: 'rl_2' })
assert.deepEqual(changes.deletedIds.sort(), ['rl_1', 'rl_4'])
assert.equal(changes.puts.length, 2)
const directional = changes.puts.find((row) => row.id === 'rl_2')
assert.equal(directional?.basis, '平面观察')
assert.equal(directional?.note, '第一条；第二条')
const coexist = changes.puts.find((row) => row.id === 'rl_3')
assert.deepEqual([coexist?.unitAId, coexist?.unitBId], ['c', 'd'])
assert.equal(coexist?.note, '正向；反向')
