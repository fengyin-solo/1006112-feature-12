import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveAll, saveRows, storageKey } from '@/data/local-store'
import type { ActionResult, EntryRow, MeasureContext, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// —— 轴线偏差：单向处置进度 ——————————————————————————————————————
// 状态只能按 待测量→测量中→已纠偏→复核通过 依次流转；
// 复核不通过是唯一允许的回退（已纠偏→测量中重测）。
const AXIS_KEY = 'axis'
const SEGMENT_KEY = 'segment'
const AXIS_FLOW = ['待测量', '测量中', '已纠偏', '复核通过'] as const
const AXIS_NEXT_ACTION: Record<string, string> = { 待测量: '提交测量', 测量中: '执行纠偏', 已纠偏: '复核通过' }
// 测量班组只能改这两个字段，其余一律挡回。
const AXIS_MEASURE_FIELDS = ['实测轴线', '水平偏差']
// 测量口径与设计图纸冲突时以设计图纸为准：允许范围从「设计轴线」标注里取，未标注按默认 ±50mm。
const AXIS_DEFAULT_TOLERANCE_MM = 50
const DEFAULT_WORKFACE = '东线作业面'
const AXIS_SCHEMA_VERSION = 'axis-v2'
let backfillChecked = false

function axisSchemaFlagKey(): string {
  return `${storageKey()}:axis-schema`
}

function deviationMm(value: unknown): number | null {
  const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/)
  if (!match) {
    return null
  }
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : null
}

// 允许偏差以设计图纸（设计轴线字段）为准；图纸没标才落到平台默认值。
function axisToleranceMm(row: EntryRow): number {
  const design = String(row['设计轴线'] ?? '')
  const match = design.match(/±\s*(\d+(?:\.\d+)?)\s*mm/i) ?? design.match(/允许[^0-9]*(\d+(?:\.\d+)?)\s*mm/i)
  const parsed = match ? Number(match[1]) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : AXIS_DEFAULT_TOLERANCE_MM
}

// 水平偏差或垂直偏差任一超出设计允许范围即超限。
function exceedsDesign(row: EntryRow): boolean {
  const tolerance = axisToleranceMm(row)
  const horizontal = deviationMm(row['水平偏差'])
  const vertical = deviationMm(row['垂直偏差'])
  return (horizontal !== null && Math.abs(horizontal) > tolerance) || (vertical !== null && Math.abs(vertical) > tolerance)
}

// 超限一旦标过不自动撤销（保留历史账），未标过的按当前读数算。
function refreshOverLimit(row: EntryRow): string {
  if (String(row['超限标记'] ?? '') === '是') {
    return '是'
  }
  return exceedsDesign(row) ? '是' : '否'
}

function ringSortKey(value: unknown): [number, string] {
  const text = String(value ?? '')
  const match = text.match(/\d+/)
  return [match ? Number(match[0]) : Number.MAX_SAFE_INTEGER, text]
}

function compareRing(a: EntryRow, b: EntryRow): number {
  const [an, as] = ringSortKey(a['对应环号'])
  const [bn, bs] = ringSortKey(b['对应环号'])
  return an !== bn ? an - bn : as.localeCompare(bs, 'zh')
}

function normalizeAxisRow(row: EntryRow): EntryRow {
  const next: EntryRow = { ...row }
  const status = String(next.status)
  // 兼容历史记录：老状态「超限」并入流转链（回到测量中、保留超限标记），未识别的一律从头补登。
  const wasOverLimitStatus = status === '超限'
  if (!(AXIS_FLOW as readonly string[]).includes(status)) {
    next.status = wasOverLimitStatus ? '测量中' : '待测量'
  }
  if (next['作业面'] === undefined) {
    next['作业面'] = DEFAULT_WORKFACE
  }
  if (next['复核结论'] === undefined) {
    next['复核结论'] = ''
  }
  if (next['复核次数'] === undefined) {
    next['复核次数'] = 0
  }
  if (next['超限标记'] === undefined) {
    // 兼容已经纠偏的老环次：已纠偏/复核通过的历史记录不回头翻账；
    // 仍在测量环节的按设计图纸允许范围重算。
    const closed = next.status === '已纠偏' || next.status === '复核通过'
    next['超限标记'] = wasOverLimitStatus || (!closed && exceedsDesign(next)) ? '是' : '否'
  }
  next.abnormal = next['超限标记'] === '是' && next.status !== '复核通过'
  next.pending = next.status !== AXIS_FLOW[AXIS_FLOW.length - 1]
  next['测量状态'] = String(next.status)
  return next
}

// 纠偏结论联动管片拼装返工清单：超限且已挂纠偏措施的环号，对应管片环一律进返工。
// 与轴线写在同一次入库里，两边只认这一份。
function syncSegmentRework(next: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const axisRows = next[AXIS_KEY] ?? []
  const reworkRings = new Set(
    axisRows
      .filter((row) => row['超限标记'] === '是' && String(row['纠偏措施'] ?? '').trim() !== '')
      .map((row) => String(row['对应环号'] ?? '').trim())
      .filter((ring) => ring !== ''),
  )
  const segmentRows = (next[SEGMENT_KEY] ?? []).map((row) => {
    const ring = String(row['管片环号'] ?? '').trim()
    if (ring !== '' && reworkRings.has(ring) && row.status !== '已返工') {
      return { ...row, status: '已返工', pending: false, 拼装状态: '已返工' }
    }
    return row
  })
  return { ...next, [SEGMENT_KEY]: segmentRows }
}

// 存量测量记录按环次顺序补登一遍：老状态归并、缺字段补齐、超限重算、返工联动重挂。
function ensureAxisBackfilled(): void {
  if (backfillChecked) {
    return
  }
  backfillChecked = true
  const rows = listRows(AXIS_KEY)
  const stale = rows.some(
    (row) =>
      !(AXIS_FLOW as readonly string[]).includes(String(row.status)) ||
      row['超限标记'] === undefined ||
      row['作业面'] === undefined ||
      row['复核结论'] === undefined ||
      row['复核次数'] === undefined,
  )
  const flag =
    typeof window !== 'undefined' && window.localStorage ? window.localStorage.getItem(axisSchemaFlagKey()) : null
  if (!stale && flag === AXIS_SCHEMA_VERSION) {
    return
  }
  try {
    const sorted = [...rows].sort(compareRing).map(normalizeAxisRow)
    saveAll(syncSegmentRework({ ...allRows(), [AXIS_KEY]: sorted }))
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(axisSchemaFlagKey(), AXIS_SCHEMA_VERSION)
    }
  } catch {
    // 入库失败一律不落：缓存不动，下次访问重新补登。
    backfillChecked = false
  }
}

// 超限环数与返工环数的唯一口径：轴线页、管片拼装页都从这里读，两处只认这一份。
export function axisOverLimitRingNumbers(): string[] {
  ensureAxisBackfilled()
  return uniqueRings(listRows(AXIS_KEY).filter((row) => row['超限标记'] === '是'))
}

export function axisReworkRingNumbers(): string[] {
  ensureAxisBackfilled()
  return uniqueRings(
    listRows(AXIS_KEY).filter((row) => row['超限标记'] === '是' && String(row['纠偏措施'] ?? '').trim() !== ''),
  )
}

function uniqueRings(rows: EntryRow[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    const ring = String(row['对应环号'] ?? '').trim()
    if (ring !== '') {
      seen.add(ring)
    }
  }
  return [...seen].sort((a, b) => {
    const [an, as] = ringSortKey(a)
    const [bn, bs] = ringSortKey(b)
    return an !== bn ? an - bn : as.localeCompare(bs, 'zh')
  })
}

// 轴线变更与返工联动一次入库；写失败整体不落。
function commitAxis(rows: EntryRow[], message: string): ActionResult {
  try {
    saveAll(syncSegmentRework({ ...allRows(), [AXIS_KEY]: rows }))
  } catch (error) {
    return { ok: false, message: `入库失败，本次变更一律不落：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, message }
}

function runAxisAction(meta: ModuleMeta, id: number, action: string, payload: Record<string, string>): ActionResult {
  const rows = listRows(AXIS_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const step = AXIS_FLOW.indexOf(current as (typeof AXIS_FLOW)[number])
  if (step < 0) {
    return { ok: false, message: `挡回：「${current}」不在单向流转链上，请先按环次补登后再处置` }
  }

  // 复核不通过：唯一允许的回退，已纠偏 → 测量中重测。
  if (action === '复核不通过') {
    if (current !== '已纠偏') {
      return { ok: false, message: `挡回：只有「已纠偏」才能复核回退，该记录当前卡在「${current}」环节` }
    }
    const first = String(row['复核结论'] ?? '')
    if (first !== '') {
      return { ok: false, message: `挡回：该环本轮已提交过复核，只认头一回结论（首次结论：${first}），重复提交不生效` }
    }
    const reviewRound = Number(row['复核次数'] ?? 0) + 1
    const updated: EntryRow = {
      ...row,
      status: '测量中',
      复核结论: '不通过',
      复核次数: reviewRound,
      pending: true,
      abnormal: row['超限标记'] === '是',
      测量状态: '测量中',
    }
    const next = [...rows]
    next[index] = updated
    return commitAxis(next, `复核不通过，已回到「测量中」重测（第 ${reviewRound} 次复核）`)
  }

  const targetStep = AXIS_FLOW.indexOf(target as (typeof AXIS_FLOW)[number])
  if (targetStep === step) {
    return { ok: false, message: `挡回：记录已是「${current}」，重复提交只生效一次` }
  }
  if (targetStep < step) {
    return {
      ok: false,
      message: `挡回：轴线处置只能单向流转（待测量→测量中→已纠偏→复核通过），不能从「${current}」倒改回「${target}」`,
    }
  }
  if (targetStep > step + 1) {
    return {
      ok: false,
      message: `挡回：不能跳级，该记录当前卡在「${current}」环节，须先「${AXIS_NEXT_ACTION[current]}」才能「${action}」`,
    }
  }

  if (action === '执行纠偏') {
    const overLimit = String(row['超限标记'] ?? '') === '是'
    const existing = String(row['纠偏措施'] ?? '').trim()
    const incoming = String(payload['纠偏措施'] ?? '').trim()
    if (overLimit && existing === '' && incoming === '') {
      return { ok: false, message: '挡回：该环已标超限，必须挂上纠偏措施才能执行纠偏' }
    }
    const updated: EntryRow = {
      ...row,
      status: '已纠偏',
      复核结论: '',
      pending: true,
      abnormal: row['超限标记'] === '是',
      测量状态: '已纠偏',
    }
    if (incoming !== '') {
      updated['纠偏措施'] = incoming
    }
    const next = [...rows]
    next[index] = updated
    return commitAxis(
      next,
      overLimit ? '已执行纠偏，纠偏结论同步纳入管片拼装返工清单' : '已执行纠偏，等待复核',
    )
  }

  if (action === '复核通过') {
    const first = String(row['复核结论'] ?? '')
    if (first !== '') {
      return { ok: false, message: `挡回：该环本轮已提交过复核，只认头一回结论（首次结论：${first}），重复提交不生效` }
    }
    const updated: EntryRow = {
      ...row,
      status: '复核通过',
      复核结论: '通过',
      pending: false,
      abnormal: false,
      测量状态: '复核通过',
    }
    const next = [...rows]
    next[index] = updated
    return commitAxis(next, '复核通过，处置闭环')
  }

  // 提交测量：待测量 → 测量中。
  const updated: EntryRow = { ...row, status: target, pending: true, 测量状态: target }
  const next = [...rows]
  next[index] = updated
  return commitAxis(next, `${meta.entity}已${action}，当前状态「${target}」`)
}

// 测量班组登记读数：只能改实测轴线与水平偏差，跨作业面直接挡回。
export function submitMeasurement(
  id: number,
  patch: Record<string, string>,
  context: MeasureContext,
): ActionResult {
  ensureAxisBackfilled()
  const rows = listRows(AXIS_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的轴线测量` }
  }
  const row = rows[index]
  const keys = Object.keys(patch).filter((key) => patch[key] !== undefined)
  const illegal = keys.filter((key) => !AXIS_MEASURE_FIELDS.includes(key))
  if (illegal.length > 0) {
    return { ok: false, message: `挡回：测量班组只能改实测轴线与水平偏差，「${illegal.join('、')}」不在权限内` }
  }
  if (keys.length === 0) {
    return { ok: false, message: '挡回：没有提交任何读数' }
  }
  const workface = String(row['作业面'] ?? '')
  if (workface !== '' && context.workface !== '' && workface !== context.workface) {
    return {
      ok: false,
      message: `挡回：该环属于「${workface}」，当前值班作业面为「${context.workface}」，跨作业面提交不受理`,
    }
  }
  if (row.status === '已纠偏' || row.status === '复核通过') {
    return {
      ok: false,
      message: `挡回：记录已走到「${String(row.status)}」，实测读数不允许倒改；如需重测，请先复核不通过回到「测量中」`,
    }
  }
  const trimmed: Record<string, string> = {}
  for (const key of keys) {
    trimmed[key] = String(patch[key]).trim()
  }
  const changed = keys.some((key) => String(row[key] ?? '') !== trimmed[key])
  if (!changed) {
    return { ok: true, message: '读数与已登记内容一致，重复提交只生效一次，本次不再落库' }
  }
  const wasOverLimit = String(row['超限标记'] ?? '') === '是'
  const updated: EntryRow = { ...row, ...trimmed }
  updated['超限标记'] = refreshOverLimit(updated)
  updated.abnormal = updated['超限标记'] === '是'
  const next = [...rows]
  next[index] = updated
  const nowOverLimit = updated['超限标记'] === '是'
  const message = nowOverLimit
    ? wasOverLimit
      ? '已登记实测读数，该环仍为超限'
      : '已登记实测读数，偏差超出设计轴线允许范围，已自动标为超限'
    : '已登记实测读数'
  return commitAxis(next, message)
}

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
  ensureAxisBackfilled()
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string, payload: Record<string, string> = {}): ActionResult {
  ensureAxisBackfilled()
  const meta = moduleMeta(key)
  if (key === AXIS_KEY) {
    return runAxisAction(meta, id, action, payload)
  }
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
  try {
    saveRows(key, next)
  } catch (error) {
    return { ok: false, message: `入库失败，本次变更一律不落：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  ensureAxisBackfilled()
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
  ensureAxisBackfilled()
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
