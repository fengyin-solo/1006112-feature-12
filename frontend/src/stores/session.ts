import { defineStore } from 'pinia'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 当前值班作业面：测量班组提交读数时按它校验，跨作业面直接挡回。
    workface: '东线作业面',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setWorkface(label: string) {
      this.workface = label
    },
  },
})
