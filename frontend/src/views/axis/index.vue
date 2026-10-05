<template>
  <section class="page" data-module="axis">
    <header class="page-head">
      <div>
        <h2>轴线偏差管理</h2>
        <p class="page-desc">
          处置进度单向流转：待测量→测量中→已纠偏→复核通过；超限自动标记，超限环须挂纠偏措施才能纠偏，复核不通过回到测量中重测。
        </p>
      </div>
      <div class="page-actions">
        <label class="workface-switch">
          <span>当前作业面</span>
          <select :value="session.workface" @change="switchWorkface">
            <option v-for="item in workfaces" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>
        <button class="btn" type="button" @click="exportRows">导出轴线偏差清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
          <td>
            <input
              class="cell-input"
              :value="edits[String(row.id)]?.实测轴线 ?? ''"
              :disabled="!readingEditable(row)"
              placeholder="实测轴线"
              @input="setEdit(row, '实测轴线', $event)"
            />
          </td>
          <td>
            <input
              class="cell-input narrow"
              :value="edits[String(row.id)]?.水平偏差 ?? ''"
              :disabled="!readingEditable(row)"
              placeholder="如 +45mm"
              @input="setEdit(row, '水平偏差', $event)"
            />
          </td>
          <td>{{ row['垂直偏差'] || '—' }}</td>
          <td>
            <input
              v-if="measureEditable(row)"
              class="cell-input"
              :value="edits[String(row.id)]?.纠偏措施 ?? ''"
              placeholder="超限须挂纠偏措施"
              @input="setEdit(row, '纠偏措施', $event)"
            />
            <span v-else>{{ row['纠偏措施'] || '—' }}</span>
          </td>
          <td>
            <span :class="row['超限标记'] === '是' ? 'tag-over' : ''">{{ row['超限标记'] ?? '否' }}</span>
          </td>
          <td>{{ row['复核结论'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="saveReadings(row)">保存读数</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无轴线偏差数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条轴线偏差记录 · 超限环数与管片拼装返工清单同源</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  axisOverLimitRingNumbers,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitMeasurement,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('axis')
const session = useSessionStore()
const columns = ["测量编号", "对应环号", "作业面", "设计轴线", "实测轴线", "水平偏差", "垂直偏差", "纠偏措施", "超限标记", "复核结论"]
const actions = ["提交测量", "执行纠偏", "复核通过", "复核不通过"]
const statuses = ["待测量", "测量中", "已纠偏", "复核通过"]
const workfaces = ["东线作业面", "西线作业面"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["测量编号", "对应环号", "作业面"]
const overLimitCount = ref(0)
// 每行的可编辑草稿：实测轴线、水平偏差（测量班组权限内）与纠偏措施（执行纠偏时随动作提交）。
const edits = reactive<Record<string, { 实测轴线: string; 水平偏差: string; 纠偏措施: string }>>({})

const stats = computed(() => [
  { label: '待测量环数', value: rows.value.filter((row) => row.status === '待测量').length },
  { label: '超限环数', value: overLimitCount.value },
  { label: '复核通过环数', value: rows.value.filter((row) => row.status === '复核通过').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function readingEditable(row: EntryRow): boolean {
  return row.status === '待测量' || row.status === '测量中'
}

function measureEditable(row: EntryRow): boolean {
  return row.status === '测量中'
}

function setEdit(row: EntryRow, field: '实测轴线' | '水平偏差' | '纠偏措施', event: Event) {
  const key = String(row.id)
  if (!edits[key]) {
    edits[key] = { 实测轴线: '', 水平偏差: '', 纠偏措施: '' }
  }
  edits[key][field] = (event.target as HTMLInputElement).value
}

function switchWorkface(event: Event) {
  session.setWorkface((event.target as HTMLSelectElement).value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function saveReadings(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const draft = edits[String(row.id)] ?? { 实测轴线: '', 水平偏差: '' }
  const result = submitMeasurement(
    Number(row.id),
    { 实测轴线: draft.实测轴线, 水平偏差: draft.水平偏差 },
    { operator: session.operator, workface: session.workface },
  )
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const draft = edits[String(row.id)]
  const result = applyAction(meta.key, Number(row.id), action, { 纠偏措施: draft?.纠偏措施 ?? '' })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    overLimitCount.value = axisOverLimitRingNumbers().length
    for (const row of payload.items) {
      edits[String(row.id)] = {
        实测轴线: String(row['实测轴线'] ?? ''),
        水平偏差: String(row['水平偏差'] ?? ''),
        纠偏措施: String(row['纠偏措施'] ?? ''),
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '轴线偏差列表读取失败'
  }
}

onMounted(reload)
</script>
