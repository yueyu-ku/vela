import { describe, it, expect } from 'vitest'
import { registerWorkflow, rehydrateWorkflow, type WorkflowParams } from './workflow-registry'

describe('workflow-registry（rehydrate 重建，设计 §4.3）', () => {
  it('registerWorkflow + rehydrateWorkflow：按 type 重建 definition', () => {
    const type = 'directory' as const
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    registerWorkflow(type, (_p) => ({ type, title: 't', steps: [{ name: 'step', description: 'd', executor: async () => {} }] }))
    const def = rehydrateWorkflow(type, { mode: 'full' })
    expect(def).toBeTruthy()
    expect(def!.type).toBe(type)
    expect(def!.steps).toHaveLength(1)
  })
  it('未注册 type → null（恢复走「不可续跑」兜底）', () => {
    const def = rehydrateWorkflow('nonexistent' as never, {})
    expect(def).toBeNull()
  })
  it('factory 参数透传：rehydrate 重建需拿到启动时 params（设计 §4.4 方案 ii）', () => {
    const type = 'novel_import' as const
    let captured: WorkflowParams | null = null
    registerWorkflow(type, (p) => { captured = p; return { type, title: 't', steps: [] } })
    rehydrateWorkflow(type, { chapters: [{ number: 1, title: 'a', content: 'c', wordCount: 1 }] })
    expect(captured).toEqual({ chapters: [{ number: 1, title: 'a', content: 'c', wordCount: 1 }] })
  })
})
