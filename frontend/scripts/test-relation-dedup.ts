import 'fake-indexeddb/auto'

import Dexie from 'dexie'
import { db } from '../src/hooks/usePersistentStore'
import {
  analyzeDuplicateGroups,
  relationDedupKey,
  relationDedupState,
  confirmRelationDedup,
  runRelationDedupMigration,
  RELATION_DEDUP_META_KEY
} from '../src/migrations/relationDedup'
import type { Relation, RelationBasis, RelationType } from '../src/types'

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

function R(
  id: string,
  a: string,
  type: RelationType,
  b: string,
  basis: RelationBasis,
  recorder: string,
  note = ''
): Relation {
  return { id, unitAId: a, type, unitBId: b, basis, recorder, note }
}

function waitFor(pred: () => boolean, timeout = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (pred()) return resolve()
      if (Date.now() - start > timeout) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function pairKey(a: string, type: RelationType, b: string): string {
  return relationDedupKey(R('', a, type, b, '剖面观察', ''))
}

async function main(): Promise<void> {
  // ---------- 判重键纯逻辑 ----------
  console.log('判重键')
  check(
    '叠压有向：A 叠压 B 与 B 叠压 A 键不同',
    relationDedupKey(R('x', 'a', '叠压', 'b', '剖面观察', '')) !==
      relationDedupKey(R('x', 'b', '叠压', 'a', '剖面观察', ''))
  )
  check(
    '共存无向：A 共存 B 与 B 共存 A 键相同',
    relationDedupKey(R('x', 'a', '共存', 'b', '剖面观察', '')) ===
      relationDedupKey(R('x', 'b', '共存', 'a', '剖面观察', ''))
  )

  // ---------- blocked：旧版 v2 页面占着库 ----------
  console.log('blocked 等待旧页面关闭')
  const oldDb = new Dexie('gbtrenchlog')
  oldDb.version(2).stores({
    trenches: 'id, code, area',
    strata: 'id, trenchId, code, type',
    artifacts: 'id, stratumId, code, category',
    relations: 'id, unitAId, unitBId, type',
    meta: 'key'
  })
  await oldDb.open()
  // 模拟同事的旧页面：收到 versionchange 也不关闭，一直占着库
  const origClose = oldDb.close.bind(oldDb)
  let holdOld = true
  oldDb.close = async () => {
    if (!holdOld) await origClose()
  }

  // 旧版页面里录好的重复数据
  await oldDb.relations.bulkPut([
    R('rl_001', 'st_a', '叠压', 'st_b', '剖面观察', '方铭', 'H12 打破 L02'),
    R('rl_002', 'st_a', '叠压', 'st_b', '剖面观察', '方铭', '重复录入'),
    R('rl_003', 'st_a', '叠压', 'st_b', '平面观察', '方铭', '平面也观察到'),
    R('rl_004', 'st_b', '共存', 'st_c', '剖面观察', '祁野', '共存一组'),
    R('rl_005', 'st_c', '共存', 'st_b', '剖面观察', '祁野', '共存二组(反向录入)'),
    R('rl_006', 'st_a', '打破', 'st_d', '剖面观察', '方铭', '打破记录一'),
    R('rl_007', 'st_a', '打破', 'st_d', '剖面观察', '祁野', '打破记录二'),
    R('rl_008', 'st_c', '叠压', 'st_d', '平面观察', '祁野', '唯一一条')
  ])

  const runPromise = runRelationDedupMigration()
  let blockedFired = false
  db.on('blocked', () => {
    blockedFired = true
  })
  await waitFor(() => blockedFired)
  check('旧版页面占库时触发 blocked 事件', blockedFired)
  await waitFor(() => relationDedupState.status === 'blocked' || relationDedupState.status === 'confirm')
  check('迁移界面进入 blocked 等待状态（旧页面关闭后自动继续）', relationDedupState.status !== 'done')

  holdOld = false
  await oldDb.close()
  await waitFor(() => relationDedupState.status === 'confirm')
  check('旧页面关闭后自动继续，进入冲突确认', relationDedupState.status === 'confirm')

  // ---------- 重复分组与人工确认 ----------
  console.log('重复分组与确认')
  const groups = analyzeDuplicateGroups(await db.relations.toArray())
  check('共 3 个重复组', groups.length === 3, `got ${groups.length}`)
  check('共存组依据/记录人一致，自动合并', groups.find((g) => g.type === '共存')?.autoMerge === true)
  check('2 个组存在依据或记录人差异，需确认', groups.filter((g) => !g.autoMerge).length === 2)
  check('多余记录 4 条（8 → 4）', relationDedupState.redundantCount === 4, `got ${relationDedupState.redundantCount}`)

  // 用户选择：叠压组保留 rl_002，打破组保留 rl_006
  relationDedupState.choices[pairKey('st_a', '叠压', 'st_b')] = 'rl_002'
  relationDedupState.choices[pairKey('st_a', '打破', 'st_d')] = 'rl_006'
  confirmRelationDedup()
  await runPromise

  check('迁移完成', relationDedupState.status === 'done')
  const after = await db.relations.toArray()
  check('关系总数 8 → 4', after.length === 4, `got ${after.length}`)
  const aB = after.filter((r) => relationDedupKey(r) === pairKey('st_a', '叠压', 'st_b'))
  check('叠压组只留 1 条，且为所选 rl_002', aB.length === 1 && aB[0].id === 'rl_002')
  const co = after.filter((r) => r.type === '共存')
  check('共存组只留 1 条，保留最早 rl_004', co.length === 1 && co[0].id === 'rl_004')
  const aD = after.filter((r) => relationDedupKey(r) === pairKey('st_a', '打破', 'st_d'))
  check('打破组只留 1 条，且为所选 rl_006', aD.length === 1 && aD[0].id === 'rl_006')
  check('唯一一条未重复的关系不受影响', after.some((r) => r.id === 'rl_008'))
  const stamp = await db.meta.get(RELATION_DEDUP_META_KEY)
  check('meta 已打完成标记', stamp?.value === 1)

  // ---------- 重开浏览器：幂等续跑 ----------
  console.log('重开续跑')
  await runRelationDedupMigration()
  check('重开后直接 done', relationDedupState.status === 'done')
  check('重开后仍是 4 条', (await db.relations.toArray()).length === 4)

  // ---------- 中途失败：事务回滚到升级前 ----------
  console.log('失败回滚')
  const before = await db.relations.toArray()
  try {
    await db.transaction('rw', db.relations, db.meta, async (tx) => {
      await tx
        .table<Relation, string>('relations')
        .put(R('rl_999', 'st_x', '叠压', 'st_y', '剖面观察', '测试'))
      throw new Error('模拟中途失败')
    })
    check('事务应抛错', false)
  } catch (error) {
    check('失败时抛出错误', (error as Error).message === '模拟中途失败')
  }
  const rolled = await db.relations.toArray()
  check(
    '回滚后记录数与升级前一致（rl_999 不存在）',
    rolled.length === before.length && !rolled.some((r) => r.id === 'rl_999')
  )

  // 回滚后重开浏览器继续升完
  await runRelationDedupMigration()
  check(
    '回滚后重开仍为 done、4 条',
    relationDedupState.status === 'done' && (await db.relations.toArray()).length === 4
  )

  // ---------- 全自动化合并（无冲突，无需确认） ----------
  console.log('全自动合并')
  await db.delete()
  await db.open()
  await db.relations.bulkPut([
    R('rl_a1', 'st_a', '叠压', 'st_b', '剖面观察', '方铭', '一条'),
    R('rl_a2', 'st_a', '叠压', 'st_b', '剖面观察', '方铭', '又一条'),
    R('rl_a3', 'st_a', '叠压', 'st_b', '剖面观察', '方铭', '再一条')
  ])
  relationDedupState.status = 'idle'
  await runRelationDedupMigration()
  check('无冲突时直接 done', relationDedupState.status === 'done')
  check('3 条自动合并为 1 条', (await db.relations.toArray()).length === 1)
  check('保留最早记录 rl_a1', (await db.relations.toArray())[0].id === 'rl_a1')
  check('备注去重保留', (await db.relations.toArray())[0].note.split('；').length === 3)

  // ---------- 零重复：不改动数据 ----------
  console.log('零重复')
  await db.delete()
  await db.open()
  await db.relations.put(R('rl_b1', 'st_a', '叠压', 'st_b', '剖面观察', '方铭', '唯一'))
  relationDedupState.status = 'idle'
  await runRelationDedupMigration()
  check('无重复时直接 done', relationDedupState.status === 'done')
  check('数据不改动', (await db.relations.toArray()).length === 1)
  check('meta 已标记', (await db.meta.get(RELATION_DEDUP_META_KEY))?.value === 1)

  if (failures > 0) process.exit(1)
  console.log('\n全部通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
