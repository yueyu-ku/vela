// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { executeRunFromIndex, useWorkflowStore, type WorkflowDefinition, type WorkflowRun } from './workflow-store'

describe('executeRunFromIndex（断点重放，L2 任务2）', () => {
  beforeEach(() => { useWorkflowStore.setState({ activeRuns: [], waitingRuns: {}, history: [] }) })

  it('从 startIndex 重放：跳过已完成步骤，只重放 startIndex 及之后', async () => {
    const seen: string[] = []
    const def: WorkflowDefinition = {
      type: 'post_process', title: 't',
      steps: [
        { name: 'a', description: 'a', executor: async () => { seen.push('a'); return 'a' } },
        { name: 'b', description: 'b', executor: async () => { seen.push('b'); return 'b' } },
        { name: 'c', description: 'c', executor: async () => { seen.push('c'); return 'c' } },
      ],
      rehydrateParams: { autoFill: false },
    }
    const run: WorkflowRun = { id: 'r1', type: 'post_process', title: 't', status: 'running', currentStepIndex: 1, createdAt: '', steps: [
      { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
      { id: 's1', name: 'b', description: 'b', status: 'pending', logs: [] },
      { id: 's2', name: 'c', description: 'c', status: 'pending', logs: [] },
    ] }
    useWorkflowStore.setState({ activeRuns: [run] })
    await executeRunFromIndex(run, def, 1, {})
    expect(seen).toEqual(['b', 'c'])  // a 不重跑（断点重放核心契约）
    // executeRunFromIndex 完成全部步骤后与 startWorkflow 收尾一致：run 移入 history
    const finalRun = useWorkflowStore.getState().history.find(r => r.id === 'r1')
    expect(finalRun?.steps[1].status).toBe('completed')
    expect(finalRun?.steps[2].status).toBe('completed')
  })
  it('contextData 注入：重放时 context.data 由参数提供（executor 读到）', async () => {
    let got: unknown = null
    const def: WorkflowDefinition = {
      type: 'architecture_generation', title: 't',
      steps: [{ name: 's', description: 's', executor: async (_step, ctx) => { got = ctx.data; return '' } }],
    }
    const run: WorkflowRun = { id: 'r2', type: 'architecture_generation', title: 't', status: 'running', currentStepIndex: 0, createdAt: '', steps: [{ id: 's0', name: 's', description: 's', status: 'pending', logs: [] }] }
    useWorkflowStore.setState({ activeRuns: [run] })
    await executeRunFromIndex(run, def, 0, { stepGuidance: { premise: 'x' } })
    expect(got).toEqual({ stepGuidance: { premise: 'x' } })
  })
})
