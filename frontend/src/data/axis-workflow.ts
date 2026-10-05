import type { EntryRow } from './types'

/**
 * 轴线偏差处置进度（单向流转）
 * 待测量 → 测量中 → 已纠偏 → 复核通过
 * - 只能逐级向前，跳级、倒改一律挡回，并指出卡在哪一环；
 * - 复核不通过回到「测量中」重测（同一环每轮复核只认头一回结论）；
 * - 「超限」不是独立状态，而是水平/垂直偏差对照设计图纸允许范围自动打的标。
 */
export const AXIS_STATUS = {
  pending: '待测量',
  measuring: '测量中',
  corrected: '已纠偏',
  passed: '复核通过',
} as const

export const AXIS_FLOW = [
  AXIS_STATUS.pending,
  AXIS_STATUS.measuring,
  AXIS_STATUS.corrected,
  AXIS_STATUS.passed,
] as const

export const AXIS_KEY = 'axis'
export const SEGMENT_KEY = 'segment'
export const RING_KEY = 'ring'

/**
 * 口径仲裁：测量口径与设计图纸冲突时，一律以设计图纸为准。
 * 允许偏差取图纸常量，不接受测量读数里自带的允许值；设计轴线字段任何角色不可改。
 * （盾构隧道管片轴线平面/高程允许偏差按 ±50mm 控制。）
 */
export const DESIGN_TOLERANCE_MM = 50
export const DESIGN_BASIS_NOTE = '允许偏差以设计图纸为准（±50mm）'

export const AXIS_FIELDS = {
  no: '测量编号',
  ring: '对应环号',
  face: '作业面',
  designAxis: '设计轴线',
  actualAxis: '实测轴线',
  horizontal: '水平偏差',
  vertical: '垂直偏差',
  tolerance: '允许偏差mm',
  measureCrew: '测量班组',
  measureDate: '测量日期',
  correction: '纠偏措施',
  reviewResult: '复核结论',
  reviewRound: '复核轮次',
  reviewer: '复核人',
  reviewNote: '复核说明',
  history: '复核历史',
  /** 超限标记：读数一旦超限就落标，纠偏闭环后仍保留，返工清单据此追溯；实时超限仍按读数重算。 */
  overLimitFlag: '超限标记',
} as const

export type AxisRecord = EntryRow & {
  作业面: string
  允许偏差mm: number
  复核轮次: number
  复核历史: AxisReviewEntry[]
  复核结论: string | null
  纠偏措施: string | null
  复核人: string | null
  复核说明: string | null
}

export type AxisReviewEntry = {
  round: number
  result: string
  reviewer: string
  note: string
  at: string
}

export function parseMm(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = Number(String(value).replace(/[^\d.\-]/g, ''))
  return Number.isFinite(num) ? num : null
}

export function parseRingNo(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const matched = String(value).match(/\d+/)
  return matched ? Number(matched[0]) : null
}

/** 水平偏差或垂直偏差任一超出图纸允许范围即超限；读数未录齐不算超限。 */
export function isOverLimit(row: EntryRow): boolean {
  const h = parseMm(row[AXIS_FIELDS.horizontal])
  const v = parseMm(row[AXIS_FIELDS.vertical])
  return (
    (h !== null && Math.abs(h) > DESIGN_TOLERANCE_MM) ||
    (v !== null && Math.abs(v) > DESIGN_TOLERANCE_MM)
  )
}

/** 曾经超限（含已纠偏闭环的历史环次），返工清单按它追溯。 */
export function wasOverLimit(row: EntryRow): boolean {
  return row[AXIS_FIELDS.overLimitFlag] === true || isOverLimit(row)
}

export function deviationsComplete(row: EntryRow): boolean {
  return (
    parseMm(row[AXIS_FIELDS.horizontal]) !== null &&
    parseMm(row[AXIS_FIELDS.vertical]) !== null &&
    String(row[AXIS_FIELDS.actualAxis] ?? '').trim() !== ''
  )
}

function overLimitText(row: EntryRow): string {
  const parts: string[] = []
  const h = parseMm(row[AXIS_FIELDS.horizontal])
  const v = parseMm(row[AXIS_FIELDS.vertical])
  if (h !== null && Math.abs(h) > DESIGN_TOLERANCE_MM) {
    parts.push(`水平偏差 ${h}mm（图纸允许 ±${DESIGN_TOLERANCE_MM}mm）`)
  }
  if (v !== null && Math.abs(v) > DESIGN_TOLERANCE_MM) {
    parts.push(`垂直偏差 ${v}mm（图纸允许 ±${DESIGN_TOLERANCE_MM}mm）`)
  }
  return parts.join('、')
}

export type ActionOutcome = {
  ok: boolean
  message: string
  /** 服务端语义：重复提交只生效一次，命中幂等时也按成功回显，但不重复落库。 */
  duplicate?: boolean
}

/**
 * 处置动作：action 名即页面按钮。
 * 所有写操作都只接收当前会话的角色/作业面，跨面、越权由这里统一拦截。
 */
export type AxisCommand =
  | { kind: 'create'; ringNo: number; designAxis: string; workFace: string; operator: string }
  | { kind: 'start'; id: number; workFace: string }
  | {
      kind: 'saveReading'
      id: number
      workFace: string
      role: string
      actualAxis: string
      horizontal: string
      vertical: string
      crew: string
    }
  | { kind: 'correct'; id: number; workFace: string; role: string; measure: string }
  | {
      kind: 'review'
      id: number
      workFace: string
      role: string
      reviewer: string
      pass: boolean
      note: string
    }

export function executeAxis(
  rows: EntryRow[],
  command: AxisCommand,
): { rows: EntryRow[]; outcome: ActionOutcome } {
  switch (command.kind) {
    case 'create':
      return createRecord(rows, command)
    case 'start':
      return advance(rows, command.id, command.workFace, AXIS_STATUS.measuring)
    case 'saveReading':
      return saveReading(rows, command)
    case 'correct':
      return registerCorrection(rows, command)
    case 'review':
      return submitReview(rows, command)
  }
}

function findRecord(rows: EntryRow[], id: number): EntryRow | null {
  return rows.find((row) => Number(row.id) === id) ?? null
}

/** 跨作业面提交直接挡回。 */
function sameFace(row: EntryRow, workFace: string): boolean {
  return String(row[AXIS_FIELDS.face] ?? '左线') === workFace
}

function flowError(current: string, target: string): string {
  const curIdx = AXIS_FLOW.indexOf(current as (typeof AXIS_FLOW)[number])
  const targetIdx = AXIS_FLOW.indexOf(target as (typeof AXIS_FLOW)[number])
  if (curIdx < 0 || targetIdx < 0) {
    return `状态「${current}」不在轴线处置链上，无法转到「${target}」`
  }
  if (targetIdx <= curIdx) {
    return `处置进度只能单向向前：当前卡在「${current}」，不能倒改到「${target}」；复核不通过请在复核环节退回重测`
  }
  const blockedAt = AXIS_FLOW[targetIdx - 1]
  return `跳级被挡回：轴线测量必须先完成「${blockedAt}」这一环，才能流转到「${target}」，当前卡在「${current}」`
}

function withStatus(row: EntryRow, status: string): EntryRow {
  const over = isOverLimit(row)
  const abnormal = over && status !== AXIS_STATUS.passed
  return { ...row, status, pending: status !== AXIS_STATUS.passed, abnormal, [AXIS_FIELDS.overLimitFlag]: row[AXIS_FIELDS.overLimitFlag] === true || over }
}

function advance(
  rows: EntryRow[],
  id: number,
  workFace: string,
  target: (typeof AXIS_FLOW)[number],
): { rows: EntryRow[]; outcome: ActionOutcome } {
  const row = findRecord(rows, id)
  if (!row) return { rows, outcome: { ok: false, message: `没有找到编号为 ${id} 的轴线测量记录` } }
  if (!sameFace(row, workFace)) {
    return { rows, outcome: { ok: false, message: `该记录属于${row[AXIS_FIELDS.face]}作业面，${workFace}不得跨作业面提交` } }
  }
  const current = String(row.status)
  const curIdx = AXIS_FLOW.indexOf(current as (typeof AXIS_FLOW)[number])
  const targetIdx = AXIS_FLOW.indexOf(target)
  if (current === AXIS_STATUS.passed) {
    return { rows, outcome: { ok: false, message: '该环已复核通过，处置进度终结，不能再改' } }
  }
  if (targetIdx !== curIdx + 1) {
    return { rows, outcome: { ok: false, message: flowError(current, target) } }
  }
  const next = rows.map((item) => (item === row ? withStatus(row, target) : item))
  return { rows: next, outcome: { ok: true, message: `环 ${row[AXIS_FIELDS.ring]} 已流转到「${target}」` } }
}

function createRecord(
  rows: EntryRow[],
  command: Extract<AxisCommand, { kind: 'create' }>,
): { rows: EntryRow[]; outcome: ActionOutcome } {
  const ringNo = Math.trunc(command.ringNo)
  if (!Number.isInteger(ringNo) || ringNo <= 0) {
    return { rows, outcome: { ok: false, message: '对应环号必须是正整数' } }
  }
  if (command.designAxis.trim() === '') {
    return { rows, outcome: { ok: false, message: '设计轴线取自图纸，登记时必须填写，事后不可修改' } }
  }
  // 同一作业面同一环只认一份；重复登记幂等返回，不产生第二条。
  const existing = rows.find(
    (row) =>
      String(row[AXIS_FIELDS.face] ?? '') === command.workFace &&
      parseRingNo(row[AXIS_FIELDS.ring]) === ringNo,
  )
  if (existing) {
    return {
      rows,
      outcome: {
        ok: true,
        duplicate: true,
        message: `环 ${ringNo} 已登记（测量编号 ${existing[AXIS_FIELDS.no]}），重复提交只生效一次`,
      },
    }
  }
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const record: AxisRecord = {
    id,
    status: AXIS_STATUS.pending,
    pending: true,
    abnormal: false,
    [AXIS_FIELDS.no]: `AXIS-${String(id).padStart(4, '0')}`,
    [AXIS_FIELDS.ring]: String(ringNo),
    [AXIS_FIELDS.face]: command.workFace,
    [AXIS_FIELDS.designAxis]: command.designAxis.trim(),
    [AXIS_FIELDS.actualAxis]: '',
    [AXIS_FIELDS.horizontal]: '',
    [AXIS_FIELDS.vertical]: '',
    [AXIS_FIELDS.tolerance]: DESIGN_TOLERANCE_MM,
    [AXIS_FIELDS.measureCrew]: command.operator,
    [AXIS_FIELDS.measureDate]: '',
    [AXIS_FIELDS.correction]: null,
    [AXIS_FIELDS.reviewResult]: null,
    [AXIS_FIELDS.reviewRound]: 0,
    [AXIS_FIELDS.reviewer]: null,
    [AXIS_FIELDS.reviewNote]: null,
    [AXIS_FIELDS.history]: [] as AxisReviewEntry[],
    [AXIS_FIELDS.overLimitFlag]: false,
  }
  return {
    rows: [...rows, record],
    outcome: { ok: true, message: `环 ${ringNo} 轴线测量已登记，当前「${AXIS_STATUS.pending}」` },
  }
}

function saveReading(
  rows: EntryRow[],
  command: Extract<AxisCommand, { kind: 'saveReading' }>,
): { rows: EntryRow[]; outcome: ActionOutcome } {
  const row = findRecord(rows, command.id)
  if (!row) return { rows, outcome: { ok: false, message: `没有找到编号为 ${command.id} 的轴线测量记录` } }
  if (!sameFace(row, command.workFace)) {
    return { rows, outcome: { ok: false, message: `该记录属于${row[AXIS_FIELDS.face]}作业面，跨作业面提交已挡回` } }
  }
  // 测量班组只能改实测轴线、水平偏差（垂直偏差同属实测读数一并录入）；图纸/纠偏/复核字段一律不接受。
  const h = parseMm(command.horizontal)
  const v = parseMm(command.vertical)
  if (String(row.status) !== AXIS_STATUS.measuring) {
    return { rows, outcome: { ok: false, message: flowError(String(row.status), AXIS_STATUS.measuring) } }
  }
  if (command.actualAxis.trim() === '' || h === null || v === null) {
    return { rows, outcome: { ok: false, message: '实测轴线、水平偏差、垂直偏差未录齐，测量不算完，不能登记纠偏' } }
  }
  const sameReadings =
    String(row[AXIS_FIELDS.actualAxis] ?? '') === command.actualAxis.trim() &&
    parseMm(row[AXIS_FIELDS.horizontal]) === h &&
    parseMm(row[AXIS_FIELDS.vertical]) === v
  if (sameReadings && String(row[AXIS_FIELDS.measureDate] ?? '') !== '') {
    return {
      rows,
      outcome: { ok: true, duplicate: true, message: `环 ${row[AXIS_FIELDS.ring]} 的读数与上次完全一致，重复提交只生效一次` },
    }
  }
  const updated: EntryRow = {
    ...row,
    [AXIS_FIELDS.actualAxis]: command.actualAxis.trim(),
    [AXIS_FIELDS.horizontal]: h,
    [AXIS_FIELDS.vertical]: v,
    [AXIS_FIELDS.measureCrew]: command.crew,
    [AXIS_FIELDS.measureDate]: today(),
  }
  // 超限由读数对照图纸自动判定，不提供手工标记入口；一旦超限即落标，闭环后也保留。
  updated.abnormal = isOverLimit(updated)
  updated[AXIS_FIELDS.overLimitFlag] = updated[AXIS_FIELDS.overLimitFlag] === true || updated.abnormal
  const message = updated.abnormal
    ? `${overLimitText(updated)}，自动标为超限，必须登记纠偏措施才能流转`
    : '读数已录，偏差在图纸允许范围内'
  return {
    rows: rows.map((item) => (item === row ? updated : item)),
    outcome: { ok: true, message },
  }
}

function registerCorrection(
  rows: EntryRow[],
  command: Extract<AxisCommand, { kind: 'correct' }>,
): { rows: EntryRow[]; outcome: ActionOutcome } {
  const row = findRecord(rows, command.id)
  if (!row) return { rows, outcome: { ok: false, message: `没有找到编号为 ${command.id} 的轴线测量记录` } }
  if (!sameFace(row, command.workFace)) {
    return { rows, outcome: { ok: false, message: `该记录属于${row[AXIS_FIELDS.face]}作业面，跨作业面提交已挡回` } }
  }
  if (command.role === '测量班组') {
    return { rows, outcome: { ok: false, message: '测量班组只能改实测轴线与水平偏差，登记纠偏措施须由技术口办理' } }
  }
  const current = String(row.status)
  if (current !== AXIS_STATUS.measuring) {
    return { rows, outcome: { ok: false, message: flowError(current, AXIS_STATUS.corrected) } }
  }
  if (!deviationsComplete(row)) {
    return { rows, outcome: { ok: false, message: '没测完不许登记纠偏：实测轴线、水平偏差、垂直偏差先录齐' } }
  }
  const over = isOverLimit(row)
  const measure = command.measure.trim()
  if (over && measure === '') {
    return {
      rows,
      outcome: { ok: false, message: `${overLimitText(row)}，已超限，必须挂上纠偏措施才能进入「已纠偏」` },
    }
  }
  const finalMeasure = measure || '偏差在图纸允许范围内，跟踪观察，无需专项纠偏'
  if (!over && String(row[AXIS_FIELDS.correction] ?? '') === finalMeasure) {
    return { rows, outcome: { ok: true, duplicate: true, message: '纠偏结论与已登记内容一致，重复提交只生效一次' } }
  }
  const updated = withStatus(
    { ...row, [AXIS_FIELDS.correction]: finalMeasure, [AXIS_FIELDS.reviewResult]: null },
    AXIS_STATUS.corrected,
  )
  return {
    rows: rows.map((item) => (item === row ? updated : item)),
    outcome: {
      ok: true,
      message: over
        ? `环 ${row[AXIS_FIELDS.ring]} 纠偏措施已挂接，流转到「已纠偏」，等待复核`
        : `环 ${row[AXIS_FIELDS.ring]} 无需专项纠偏，流转到「已纠偏」，等待复核`,
    },
  }
}

function submitReview(
  rows: EntryRow[],
  command: Extract<AxisCommand, { kind: 'review' }>,
): { rows: EntryRow[]; outcome: ActionOutcome } {
  const row = findRecord(rows, command.id)
  if (!row) return { rows, outcome: { ok: false, message: `没有找到编号为 ${command.id} 的轴线测量记录` } }
  if (!sameFace(row, command.workFace)) {
    return { rows, outcome: { ok: false, message: `该记录属于${row[AXIS_FIELDS.face]}作业面，跨作业面提交已挡回` } }
  }
  if (command.role === '测量班组') {
    return { rows, outcome: { ok: false, message: '测量班组只能改实测读数，复核结论须由技术口出具' } }
  }
  // 同一轮重复提交复核，只认头一回结论：本轮复核结论已存在（含已通过）即挡回，不允许改判。
  if (String(row[AXIS_FIELDS.reviewResult] ?? '') !== '') {
    return {
      rows,
      outcome: {
        ok: false,
        message: `该环本轮复核已出结论「${row[AXIS_FIELDS.reviewResult]}」，重复提交复核只认头一回，不能改判`,
      },
    }
  }
  const current = String(row.status)
  if (current !== AXIS_STATUS.corrected) {
    return { rows, outcome: { ok: false, message: flowError(current, AXIS_STATUS.passed) } }
  }
  const round = Number(row[AXIS_FIELDS.reviewRound] ?? 0) + 1
  const entry: AxisReviewEntry = {
    round,
    result: command.pass ? '复核通过' : '复核不通过',
    reviewer: command.reviewer || command.role,
    note: command.note.trim(),
    at: new Date().toISOString(),
  }
  const history = [
    ...((Array.isArray(row[AXIS_FIELDS.history])
      ? (row[AXIS_FIELDS.history] as AxisReviewEntry[])
      : []) as AxisReviewEntry[]),
    entry,
  ]

  if (command.pass) {
    const updated = withStatus(
      {
        ...row,
        [AXIS_FIELDS.reviewResult]: '复核通过',
        [AXIS_FIELDS.reviewRound]: round,
        [AXIS_FIELDS.reviewer]: entry.reviewer,
        [AXIS_FIELDS.reviewNote]: entry.note,
        [AXIS_FIELDS.history]: history,
      },
      AXIS_STATUS.passed,
    )
    return {
      rows: rows.map((item) => (item === row ? updated : item)),
      outcome: { ok: true, message: `环 ${row[AXIS_FIELDS.ring]} 复核通过，处置进度终结` },
    }
  }

  // 复核不通过：回到「测量中」重测，本轮结论留痕但不锁死；重测后可再走纠偏、再复核。
  const reset: EntryRow = {
    ...row,
    status: AXIS_STATUS.measuring,
    pending: true,
    abnormal: wasOverLimit(row),
    [AXIS_FIELDS.reviewResult]: null,
    [AXIS_FIELDS.reviewer]: null,
    [AXIS_FIELDS.reviewNote]: null,
    [AXIS_FIELDS.reviewRound]: round,
    [AXIS_FIELDS.correction]: null,
    [AXIS_FIELDS.history]: history,
  }
  return {
    rows: rows.map((item) => (item === row ? reset : item)),
    outcome: {
      ok: true,
      message: `环 ${row[AXIS_FIELDS.ring]} 复核不通过，已退回「测量中」重测，重测后须重新挂接纠偏措施`,
    },
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── 单一数据源派生：管片返工清单、掘进纠偏环数、各处超限环数都从这里读 ──

export type ReworkItem = {
  id: number
  ringNo: number
  face: string
  horizontal: number | null
  vertical: number | null
  measure: string
  status: string
  reviewResult: string
  reworkStatus: '待返工' | '返工中' | '返工闭环'
}

/**
 * 纠偏结论反映到管片拼装返工清单：
 * 只有「对照图纸超限、且已挂上纠偏措施」的环才进清单，按环号只出一条；
 * 返工状态随轴线处置进度推进，不另存数据，其他入口读到的与本页同一份。
 */
export function reworkList(rows: EntryRow[]): ReworkItem[] {
  return rows
    .filter((row) => wasOverLimit(row) && String(row[AXIS_FIELDS.correction] ?? '') !== '')
    .map((row) => {
      const status = String(row.status)
      const reworkStatus: ReworkItem['reworkStatus'] =
        status === AXIS_STATUS.passed
          ? '返工闭环'
          : status === AXIS_STATUS.corrected
            ? '返工中'
            : '待返工'
      return {
        id: Number(row.id),
        ringNo: parseRingNo(row[AXIS_FIELDS.ring]) ?? -1,
        face: String(row[AXIS_FIELDS.face] ?? '左线'),
        horizontal: parseMm(row[AXIS_FIELDS.horizontal]),
        vertical: parseMm(row[AXIS_FIELDS.vertical]),
        measure: String(row[AXIS_FIELDS.correction] ?? ''),
        status,
        reviewResult: String(row[AXIS_FIELDS.reviewResult] ?? ''),
        reworkStatus,
      }
    })
    .sort((a, b) => a.ringNo - b.ringNo)
}

/** 两处页面的「超限环数」都调它，避免两套口径。 */
export function overLimitCount(rows: EntryRow[]): number {
  return rows.filter((row) => isOverLimit(row)).length
}

/** 掘进环次页读到的纠偏环数：轴线记录进入「已纠偏」及以后即算。 */
export function correctedRingCount(rows: EntryRow[]): number {
  return rows.filter((row) =>
    [AXIS_STATUS.corrected, AXIS_STATUS.passed].some((status) => String(row.status) === status),
  ).length
}

export function axisStats(rows: EntryRow[]) {
  return {
    pendingCount: rows.filter((row) => row.status === AXIS_STATUS.pending).length,
    overLimit: overLimitCount(rows),
    rework: reworkList(rows).length,
    passed: rows.filter((row) => row.status === AXIS_STATUS.passed).length,
  }
}
