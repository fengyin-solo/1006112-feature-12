<template>
  <section class="page" data-module="segment">
    <header class="page-head">
      <div>
        <h2>管片拼装管理</h2>
        <p class="page-desc">维护管片环，围绕管片环号、管片型号、拼装点位、螺栓扭矩做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管片环</button>
        <button class="btn" type="button" @click="exportRows">导出管片拼装清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ warn: item.warn }">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item linked">返工清单与「轴线偏差」联动，超限环数两处只认一份（当前 {{ overLimit }} 环超限）</span>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
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
          <td :colspan="columns.length + 2" class="empty-state">暂无管片拼装数据，可先登记管片环</td>
        </tr>
      </tbody>
    </table>

    <section class="rework-panel">
      <h3>返工清单（轴线超限联动 · 单一数据源）</h3>
      <p class="panel-tip">纠偏结论在「轴线偏差」页登记后自动反映到这里，按环只一条，不另存第二份。</p>
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
            <td colspan="7" class="empty-state">暂无因轴线超限挂纠偏的返工环</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片拼装记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  segmentReworkList,
  sharedOverLimitCount,
} from '@/api/local-service'
import type { ReworkItem } from '@/data/axis-workflow'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('segment')
const columns = ["管片环号", "管片型号", "拼装点位", "螺栓扭矩", "错台量", "拼装班组", "拼装日期", "拼装状态"]
const actions = ["开始拼装", "提交验收", "登记返工"]
const statuses = ["待拼装", "拼装中", "已验收", "已返工"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 返工清单与超限环数都从轴线测量那份数据派生，本页不另计。
const reworkItems = ref<ReworkItem[]>([])
const overLimit = ref(0)
const stats = computed(() => [
  { label: "待拼装环数", value: rows.value.filter((row) => row.status === "待拼装").length, warn: false },
  { label: "已验收环数", value: rows.value.filter((row) => row.status === "已验收").length, warn: false },
  { label: "返工环数（轴线联动）", value: reworkItems.value.length, warn: reworkItems.value.length > 0 },
  { label: "超限环数（同轴线一份）", value: overLimit.value, warn: overLimit.value > 0 },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function reworkTagClass(status: string): string {
  if (status === '返工闭环') return 'tag-ok'
  if (status === '返工中') return 'tag-warn'
  return 'tag-danger'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '管片环登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reworkItems.value = segmentReworkList()
    overLimit.value = sharedOverLimitCount()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管片拼装列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.stat-value.warn {
  color: #b42318;
}
.legend-item.linked {
  background: #e8f0fe;
  color: #1f6feb;
}
.rework-panel {
  margin-top: 18px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.rework-panel h3 {
  margin: 0 0 4px;
  font-size: 14px;
}
.panel-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 10px;
}
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
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
</style>
