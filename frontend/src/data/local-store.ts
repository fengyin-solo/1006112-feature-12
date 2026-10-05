import { SEED_ROWS } from './seed'
import {
  AXIS_FIELDS,
  AXIS_FLOW,
  AXIS_KEY,
  AXIS_STATUS,
  DESIGN_TOLERANCE_MM,
  isOverLimit,
  parseRingNo,
  type AxisRecord,
  type AxisReviewEntry,
} from './axis-workflow'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const VERSION_KEY = 'shield-tunnel-construction:axis-schema-version'
const AXIS_SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = { ...fallback }
    commitAll(seeded)
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    // 存量内容解析失败时不能把老数据冲掉：保留原样返回，由页面提示，绝不写坏数据。
    return fallback
  }
}

/**
 * 存量轴线测量记录补登：按环号升序走一遍，老环次兼容。
 * - 已是「已纠偏」的老环次原样保留，不强制重测；
 * - 老数据里的「超限」不是处置状态：挂了纠偏措施的并入「已纠偏」，没挂的退回「测量中」；
 * - 补齐作业面、图纸允许偏差、复核轮次等新字段；超限标由读数对照图纸重算。
 */
function migrateAxisLegacy(rows: EntryRow[]): EntryRow[] {
  const normalized = rows.map((row) => {
    const next: EntryRow = { ...row }
    if (String(next[AXIS_FIELDS.face] ?? '') === '') next[AXIS_FIELDS.face] = '左线'
    next[AXIS_FIELDS.tolerance] = DESIGN_TOLERANCE_MM

    // 旧播种数据里偏差是「轴线偏差样例N」这类占位文字：先识别占位（含非数值字符），清成空读数，避免 parseMm 误抠数字。
    const numericDeviation = (value: unknown) => {
      const text = String(value ?? '').trim()
      if (text === '') return ''
      return /^[+-]?\d+(\.\d+)?$/.test(text) ? text : ''
    }
    next[AXIS_FIELDS.horizontal] = numericDeviation(next[AXIS_FIELDS.horizontal])
    next[AXIS_FIELDS.vertical] = numericDeviation(next[AXIS_FIELDS.vertical])
    if (!String(next[AXIS_FIELDS.actualAxis] ?? '').includes('K') || String(next[AXIS_FIELDS.actualAxis]).includes('样例')) {
      next[AXIS_FIELDS.actualAxis] = ''
    }
    if (!String(next[AXIS_FIELDS.designAxis] ?? '').includes('K') || String(next[AXIS_FIELDS.designAxis]).includes('样例')) {
      next[AXIS_FIELDS.designAxis] = `K12+${String(100 + Number(next.id ?? 0) * 2).padStart(3, '0')}（图纸）`
    }
    // 占位的纠偏措施不算真措施。
    if (String(next[AXIS_FIELDS.correction] ?? '').includes('样例')) next[AXIS_FIELDS.correction] = null

    const status = String(next.status)
    if (status === '超限') {
      const hasMeasure = String(next[AXIS_FIELDS.correction] ?? '').trim() !== ''
      next.status = hasMeasure ? AXIS_STATUS.corrected : AXIS_STATUS.measuring
      if (!hasMeasure) next[AXIS_FIELDS.correction] = null
    } else if (!AXIS_FLOW.includes(status as (typeof AXIS_FLOW)[number])) {
      next.status = AXIS_STATUS.pending
    }
    // 读数对照图纸超限即落超限标记（兼容老「超限」环与读数已超的环）。
    next[AXIS_FIELDS.overLimitFlag] = next[AXIS_FIELDS.overLimitFlag] === true || isOverLimit(next)
    // 兼容已经纠偏的老环次：已纠偏/复核通过的不回退，只补复核轮次与措施占位。
    if (next[AXIS_FIELDS.reviewRound] === undefined) {
      next[AXIS_FIELDS.reviewRound] = next.status === AXIS_STATUS.passed ? 1 : 0
    }
    if (!Array.isArray(next[AXIS_FIELDS.history])) next[AXIS_FIELDS.history] = [] as unknown as AxisReviewEntry[]
    if (next.status === AXIS_STATUS.passed && !next[AXIS_FIELDS.reviewResult]) {
      next[AXIS_FIELDS.reviewResult] = '复核通过'
    }
    if (next.status === AXIS_STATUS.corrected && !next[AXIS_FIELDS.correction]) {
      next[AXIS_FIELDS.correction] = '历史纠偏措施（存量补登）'
    }
    next.abnormal = (next[AXIS_FIELDS.overLimitFlag] === true || isOverLimit(next)) && next.status !== AXIS_STATUS.passed
    next.pending = next.status !== AXIS_STATUS.passed
    return next as AxisRecord
  })

  // 存量记录按环次顺序补登一遍：编号按环号升序重排（环号缺失的排末尾，保持原序）。
  return normalized
    .map((row, index) => ({ row, index, ring: parseRingNo(row[AXIS_FIELDS.ring]) }))
    .sort((a, b) => {
      if (a.ring === null && b.ring === null) return a.index - b.index
      if (a.ring === null) return 1
      if (b.ring === null) return -1
      return a.ring - b.ring
    })
    .map(({ row }, seq) => {
      const ring = parseRingNo(row[AXIS_FIELDS.ring])
      return {
        ...row,
        [AXIS_FIELDS.ring]: ring === null ? String(seq + 1) : String(ring),
        [AXIS_FIELDS.no]: `AXIS-L${String(seq + 1).padStart(4, '0')}`,
      }
    })
}

function migrateIfNeeded(all: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) return all
  const version = Number(window.localStorage.getItem(VERSION_KEY) ?? '0')
  if (version >= AXIS_SCHEMA_VERSION) return all
  const next = { ...all, [AXIS_KEY]: migrateAxisLegacy(all[AXIS_KEY] ?? []) }
  // 迁移与版本号必须一起落：提交失败则整体不落，下次打开还能重放迁移。
  const previous = window.localStorage.getItem(STORAGE_KEY)
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.localStorage.setItem(VERSION_KEY, String(AXIS_SCHEMA_VERSION))
  } catch {
    if (previous !== null) window.localStorage.setItem(STORAGE_KEY, previous)
    throw new Error('存量轴线记录补登失败，已保留原数据未入库')
  }
  return next
}

function commitAll(all: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  if (!window.localStorage.getItem(VERSION_KEY)) {
    window.localStorage.setItem(VERSION_KEY, String(AXIS_SCHEMA_VERSION))
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = migrateIfNeeded(readStorage())
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

/**
 * 事务式提交：先在内存里组装完整快照并自检，序列化成功才落库。
 * 任一步失败都保留原快照，调用方拿到 false 时界面不刷新——入库失败一律不落。
 */
export function commitRows(key: string, rows: EntryRow[]): boolean {
  const previous = cache ?? readStorage()
  const next = { ...previous, [key]: rows }
  let serialized = ''
  try {
    serialized = JSON.stringify(next)
  } catch {
    cache = previous
    return false
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized)
    } catch {
      cache = previous
      return false
    }
  }
  cache = next
  return true
}

export function saveRows(key: string, rows: EntryRow[]): void {
  if (!commitRows(key, rows)) {
    throw new Error('入库失败，改动未保留')
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
