import { defineStore } from 'pinia'

// 轴线处置只区分两类角色：测量班组只能录实测读数；纠偏登记与复核结论归技术口。
export const ROLE_MEASURE = '测量班组'
export const ROLE_ENGINEER = '技术主管'
export const ROLES = [ROLE_MEASURE, ROLE_ENGINEER] as const

// 作业面：左线、右线分别建制，跨面提交一律挡回。
export const FACES = ['左线', '右线'] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    role: ROLE_MEASURE as string,
    workFace: '左线' as string,
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isMeasureCrew: (state) => state.role === ROLE_MEASURE,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: string) {
      this.role = role
    },
    setWorkFace(face: string) {
      this.workFace = face
    },
  },
})
