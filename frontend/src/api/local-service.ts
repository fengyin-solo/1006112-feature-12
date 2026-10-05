import { MODULE_BY_KEY } from '@/data/modules'
import {
  AXIS_KEY,
  axisStats,
  correctedRingCount,
  executeAxis,
  overLimitCount,
  reworkList,
  type AxisCommand,
} from '@/data/axis-workflow'
import { allRows, commitRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ── 轴线偏差：单向处置进度的专用入口，其他页面（管片返工、掘进纠偏环数）都从这里取数 ──

export function listAxis(filters: Record<string, string> = {}): PageResult {
  return listEntries(AXIS_KEY, filters)
}

/** 处置动作统一入口：状态机校验通过后才提交，入库失败一律不落。 */
export function submitAxis(command: AxisCommand): ActionResult {
  const rows = listRows(AXIS_KEY)
  const { rows: next, outcome } = executeAxis(rows, command)
  if (!outcome.ok) {
    return { ok: false, message: outcome.message }
  }
  if (outcome.duplicate) {
    return { ok: true, message: outcome.message }
  }
  const committed = commitRows(AXIS_KEY, next)
  if (!committed) {
    return { ok: false, message: '入库失败，本次处置未保留（数据未落库）' }
  }
  return { ok: true, message: outcome.message }
}

export const axisOverview = () => axisStats(listRows(AXIS_KEY))

/** 管片拼装页的返工清单：与轴线页同一数据源，按环只一条。 */
export const segmentReworkList = () => reworkList(listRows(AXIS_KEY))

/** 两处页面的超限环数都调它，保证不是两套数。 */
export const sharedOverLimitCount = () => overLimitCount(listRows(AXIS_KEY))

/** 掘进环次页的纠偏环数：读轴线这一份，不另计。 */
export const ringCorrectedCount = () => correctedRingCount(listRows(AXIS_KEY))
