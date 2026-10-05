<template>
  <section class="page" data-module="axis">
    <header class="page-head">
      <div>
        <h2>轴线偏差管理</h2>
        <p class="page-desc">
          单向处置进度：待测量 → 测量中 → 已纠偏 → 复核通过。超限按设计图纸允许偏差自动判定，必须挂纠偏措施；
          复核不通过退回测量中重测。{{ designNote }}
        </p>
      </div>
      <div class="page-actions">
        <label class="switcher">
          角色
          <select :value="session.role" @change="onRoleChange">
            <option v-for="role in ROLES" :key="role" :value="role">{{ role }}</option>
          </select>
        </label>
        <label class="switcher">
          作业面
          <select :value="session.workFace" @change="onFaceChange">
            <option v-for="face in FACES" :key="face" :value="face">{{ face }}</option>
          </select>
        </label>
        <button class="btn primary" type="button" @click="openCreate">登记轴线测量</button>
        <button class="btn" type="button" @click="exportRows">导出轴线偏差清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statsCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span class="legend-item flow">
        <template v-for="(status, index) in AXIS_FLOW" :key="status">
          {{ status }}：{{ statusCount(status) }}<template v-if="index < AXIS_FLOW.length - 1"> → </template>
        </template>
      </span>
      <span class="legend-item">当前视角：{{ session.role }} / {{ session.workFace }}（跨作业面提交直接挡回）</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>测量编号/环号</span>
        <input v-model="keyword" placeholder="按测量编号或环号检索" />
      </label>
      <label class="filter-item">
        <span>作业面</span>
        <select v-model="faceFilter">
          <option value="">全部</option>
          <option v-for="face in FACES" :key="face" :value="face">{{ face }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option v-for="status in AXIS_FLOW" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['测量编号'] }}</td>
          <td>{{ row['对应环号'] }}</td>
          <td>{{ row['作业面'] }}</td>
          <td>{{ row['设计轴线'] }}</td>
          <td>{{ row['实测轴线'] || '—' }}</td>
          <td :class="{ 'over-limit': absNum(row['水平偏差']) > tolerance }">
            {{ formatDeviation(row['水平偏差']) }}
          </td>
          <td :class="{ 'over-limit': absNum(row['垂直偏差']) > tolerance }">
            {{ formatDeviation(row['垂直偏差']) }}
          </td>
          <td>{{ row['纠偏措施'] || '—' }}</td>
          <td>
            <span v-if="wasOverLimit(row)" class="tag tag-danger">超限</span>
            <span v-else class="tag tag-ok">未超限</span>
            <span v-if="String(row['复核结论'] ?? '') !== ''">{{ row['复核结论'] }}</span>
          </td>
          <td>
            <span class="status-pill" :data-status="row.status">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <template v-for="action in availableActions(row)" :key="action.key">
              <button class="link" type="button" @click="openAction(action.key, row)">{{ action.label }}</button>
            </template>
            <span v-if="availableActions(row).length === 0" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前筛选下暂无轴线测量记录，可先登记轴线测量</td>
        </tr>
      </tbody>
    </table>

    <section class="rework-panel">
      <h3>管片拼装返工清单（与管片拼装页同一份，按环只一条）</h3>
      <table class="data-table">
        <thead>
          <tr><th>作业面</th><th>环号</th><th>水平偏差(mm)</th><th>垂直偏差(mm)</th><th>纠偏措施</th><th>轴线进度</th><th>返工状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in reworkItems" :key="String(item.id)">
            <td>{{ item.face }}</td>
            <td>{{ item.ringNo }}</td>
            <td>{{ item.horizontal }}</td>
            <td>{{ item.vertical }}</td>
            <td>{{ item.measure }}</td>
            <td>{{ item.status }}</td>
            <td><span class="tag" :class="reworkTagClass(item.reworkStatus)">{{ item.reworkStatus }}</span></td>
          </tr>
          <tr v-if="!reworkItems.length">
            <td colspan="7" class="empty-state">暂无超限挂纠偏的环，返工清单为空</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条轴线测量记录 · 超限环数与管片拼装页取同一份</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 登记 -->
    <div v-if="dialog === 'create'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>登记轴线测量</h3>
        <p class="modal-tip">登记到当前作业面「{{ session.workFace }}」，跨面请到上方切换后再登记。</p>
        <label class="form-item"><span>对应环号</span><input v-model="createForm.ringNo" type="number" min="1" /></label>
        <label class="form-item">
          <span>设计轴线（图纸，登记后不可改）</span>
          <input v-model="createForm.designAxis" placeholder="如 K12+202.000" />
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">登记</button>
        </div>
      </div>
    </div>

    <!-- 录入测量读数 -->
    <div v-if="dialog === 'reading'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>提交测量读数 · 环 {{ activeRow?.['对应环号'] }}（{{ activeRow?.['作业面'] }}）</h3>
        <p class="modal-tip">测量班组只能改实测轴线与水平偏差；垂直偏差同属实测读数一并录入，其余字段不可改。</p>
        <label class="form-item"><span>实测轴线</span><input v-model="readingForm.actualAxis" placeholder="如 K12+203.512" /></label>
        <label class="form-item"><span>水平偏差(mm)</span><input v-model="readingForm.horizontal" type="number" /></label>
        <label class="form-item"><span>垂直偏差(mm)</span><input v-model="readingForm.vertical" type="number" /></label>
        <p class="modal-tip">读数录齐后由系统对照图纸自动判定是否超限，无需手工标记。</p>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitReading">提交读数</button>
        </div>
      </div>
    </div>

    <!-- 登记纠偏 -->
    <div v-if="dialog === 'correct'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>登记纠偏措施 · 环 {{ activeRow?.['对应环号'] }}</h3>
        <p v-if="activeRow && wasOverLimit(activeRow)" class="modal-tip danger">
          该环已超限，必须挂接纠偏措施才能进入「已纠偏」。
        </p>
        <p v-else class="modal-tip">偏差在图纸允许范围内，可直接流转；如需跟踪可填写措施。</p>
        <label class="form-item">
          <span>纠偏措施{{ activeRow && wasOverLimit(activeRow) ? '（必填）' : '（可空）' }}</span>
          <textarea v-model="correctForm.measure" rows="3" placeholder="如：右偏区加大右侧推进油压，铰接油缸右收10mm，下一环复测"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" @click="submitCorrect">登记并流转到已纠偏</button>
        </div>
      </div>
    </div>

    <!-- 复核 -->
    <div v-if="dialog === 'review'" class="modal-mask" @click.self="closeDialog">
      <div class="modal">
        <h3>复核 · 环 {{ activeRow?.['对应环号'] }}</h3>
        <p class="modal-tip">同一轮复核只认头一回结论；复核不通过将退回「测量中」重测并清空本轮纠偏措施。</p>
        <label class="form-item"><span>复核人</span><input v-model="reviewForm.reviewer" :placeholder="session.role" /></label>
        <label class="form-item"><span>复核说明</span><textarea v-model="reviewForm.note" rows="3"></textarea></label>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closeDialog">取消</button>
          <button class="btn danger" type="button" @click="submitReview(false)">复核不通过（退回重测）</button>
          <button class="btn primary" type="button" @click="submitReview(true)">复核通过</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  axisOverview,
  downloadEntries,
  listAxis,
  moduleMeta,
  segmentReworkList,
  submitAxis,
} from '@/api/local-service'
import {
  AXIS_FIELDS,
  AXIS_FLOW,
  AXIS_STATUS,
  DESIGN_BASIS_NOTE,
  DESIGN_TOLERANCE_MM,
  wasOverLimit,
  type ReworkItem,
} from '@/data/axis-workflow'
import { FACES, ROLES, useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('axis')
const session = useSessionStore()
const designNote = DESIGN_BASIS_NOTE
const tolerance = DESIGN_TOLERANCE_MM

const columns = [
  '测量编号',
  '对应环号',
  '作业面',
  '设计轴线',
  '实测轴线',
  '水平偏差',
  '垂直偏差',
  '纠偏措施',
  '超限/复核',
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(true)
const reworkItems = ref<ReworkItem[]>([])

const keyword = ref('')
const faceFilter = ref('')
const statusFilter = ref('')

const dialog = ref<'' | 'create' | 'reading' | 'correct' | 'review'>('')
const activeRow = ref<EntryRow | null>(null)
const createForm = reactive({ ringNo: '', designAxis: '' })
const readingForm = reactive({ actualAxis: '', horizontal: '', vertical: '' })
const correctForm = reactive({ measure: '' })
const reviewForm = reactive({ reviewer: '', note: '' })

const statsCards = computed(() => {
  const stats = axisOverview()
  return [
    { label: '待测量环数', value: stats.pendingCount, warn: false },
    { label: '超限环数', value: stats.overLimit, warn: stats.overLimit > 0 },
    { label: '返工清单环数', value: stats.rework, warn: stats.rework > 0 },
    { label: '复核通过环数', value: stats.passed, warn: false },
  ]
})

function statusCount(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function absNum(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? Math.abs(num) : Infinity
}

function formatDeviation(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const num = Number(value)
  return Number.isFinite(num) ? `${num}` : String(value)
}

function onRoleChange(event: Event) {
  session.setRole((event.target as HTMLSelectElement).value)
}

function onFaceChange(event: Event) {
  session.setWorkFace((event.target as HTMLSelectElement).value)
}

function resetFilters() {
  keyword.value = ''
  faceFilter.value = ''
  statusFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function availableActions(row: EntryRow): { key: 'start' | 'reading' | 'correct' | 'review'; label: string }[] {
  // 只在当前作业面的记录上给按钮，跨面记录只可查看；状态机本身还会再挡一次。
  if (String(row[AXIS_FIELDS.face]) !== session.workFace) return []
  switch (row.status) {
    case AXIS_STATUS.pending:
      return [{ key: 'start', label: '开始测量' }]
    case AXIS_STATUS.measuring:
      return [
        { key: 'reading', label: '提交测量读数' },
        { key: 'correct', label: '登记纠偏' },
      ]
    case AXIS_STATUS.corrected:
      return [{ key: 'review', label: '提交复核' }]
    default:
      return []
  }
}

function reworkTagClass(status: string): string {
  if (status === '返工闭环') return 'tag-ok'
  if (status === '返工中') return 'tag-warn'
  return 'tag-danger'
}

function openCreate() {
  createForm.ringNo = ''
  createForm.designAxis = ''
  dialog.value = 'create'
}

function openAction(key: 'start' | 'reading' | 'correct' | 'review', row: EntryRow) {
  activeRow.value = row
  if (key === 'start') {
    runCommand(() =>
      submitAxis({ kind: 'start', id: Number(row.id), workFace: session.workFace }),
    )
    return
  }
  if (key === 'reading') {
    readingForm.actualAxis = String(row[AXIS_FIELDS.actualAxis] ?? '')
    readingForm.horizontal = String(row[AXIS_FIELDS.horizontal] ?? '')
    readingForm.vertical = String(row[AXIS_FIELDS.vertical] ?? '')
  }
  if (key === 'correct') {
    correctForm.measure = wasOverLimit(row) ? '' : String(row[AXIS_FIELDS.correction] ?? '')
  }
  if (key === 'review') {
    reviewForm.reviewer = ''
    reviewForm.note = ''
  }
  dialog.value = key
}

function closeDialog() {
  dialog.value = ''
  activeRow.value = null
}

function flash(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageOk.value = result.ok
}

function runCommand(build: () => { ok: boolean; message: string }) {
  const result = build()
  flash(result)
  if (result.ok) {
    closeDialog()
    reload()
  }
}

function submitCreate() {
  runCommand(() =>
    submitAxis({
      kind: 'create',
      ringNo: Number(createForm.ringNo),
      designAxis: createForm.designAxis,
      workFace: session.workFace,
      operator: session.operator,
    }),
  )
}

function submitReading() {
  if (!activeRow.value) return
  runCommand(() =>
    submitAxis({
      kind: 'saveReading',
      id: Number(activeRow.value!.id),
      workFace: session.workFace,
      role: session.role,
      actualAxis: readingForm.actualAxis,
      horizontal: readingForm.horizontal,
      vertical: readingForm.vertical,
      crew: session.operator,
    }),
  )
}

function submitCorrect() {
  if (!activeRow.value) return
  runCommand(() =>
    submitAxis({
      kind: 'correct',
      id: Number(activeRow.value!.id),
      workFace: session.workFace,
      role: session.role,
      measure: correctForm.measure,
    }),
  )
}

function submitReview(pass: boolean) {
  if (!activeRow.value) return
  runCommand(() =>
    submitAxis({
      kind: 'review',
      id: Number(activeRow.value!.id),
      workFace: session.workFace,
      role: session.role,
      reviewer: reviewForm.reviewer || session.role,
      pass,
      note: reviewForm.note,
    }),
  )
}

function reload() {
  message.value = ''
  try {
    const all = listAxis({}).items
    const kw = keyword.value.trim()
    rows.value = all.filter((row) => {
      const matchKw =
        kw === '' ||
        String(row[AXIS_FIELDS.no] ?? '').includes(kw) ||
        String(row[AXIS_FIELDS.ring] ?? '').includes(kw)
      const matchFace = faceFilter.value === '' || String(row[AXIS_FIELDS.face]) === faceFilter.value
      const matchStatus = statusFilter.value === '' || String(row.status) === statusFilter.value
      return matchKw && matchFace && matchStatus
    })
    total.value = rows.value.length
    reworkItems.value = segmentReworkList()
  } catch (error) {
    message.value = error instanceof Error ? error.message : '轴线偏差列表读取失败'
    messageOk.value = false
  }
}

onMounted(reload)
</script>

<style scoped>
.page-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.switcher {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.switcher select {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.flow {
  background: #e8f0fe;
  color: #1f6feb;
}
.stat-value.warn {
  color: #b42318;
}
.over-limit {
  color: #b42318;
  font-weight: 600;
}
.muted-text {
  color: var(--muted);
}
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  margin-right: 4px;
}
.tag-danger {
  background: #fee4e2;
  color: #b42318;
}
.tag-warn {
  background: #fef3c7;
  color: #92400e;
}
.tag-ok {
  background: #dcfce7;
  color: #166534;
}
.status-pill {
  border-radius: 4px;
  padding: 2px 8px;
  background: #eef2f7;
  font-size: 12px;
}
.status-pill[data-status='复核通过'] {
  background: #dcfce7;
  color: #166534;
}
.status-pill[data-status='已纠偏'] {
  background: #fef3c7;
  color: #92400e;
}
.rework-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.rework-panel h3 {
  margin: 0 0 10px;
  font-size: 14px;
}
.ok-text {
  color: #166534;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 460px;
  max-width: calc(100vw - 32px);
}
.modal h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.modal-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 4px 0 10px;
}
.modal-tip.danger {
  color: #b42318;
}
.form-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 10px;
}
.form-item input,
.form-item textarea {
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  color: #1f2937;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.btn.danger {
  border-color: #f04438;
  color: #b42318;
}
</style>
