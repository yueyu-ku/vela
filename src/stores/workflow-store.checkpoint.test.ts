// @vitest-environment jsdom
/**
 * workflow-checkpoint v2（L2 任务5）专项：
 * - save/load/restore 从 localStorage 迁到 DB（经 Task 4 IPC db:checkpoint-*）
 * - runDefs + contextData 重建信息随 checkpoint 持久化
 * - localStorage 兜底迁移（DB 空读旧数据并写回）
 * - 损坏降级（非法/activeRuns 非数组 → 视为无 checkpoint，不崩）
 * - 恢复决断：running 自动重放 / waiting 点继续重放（跨重启真续跑）
 * - 跨任务约束 I-1：恢复态对齐 running，断点重放能打到 completed
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWorkflowStore } from './workflow-store'
import { registerWorkflow } from '../services/workflows/workflow-registry'

const CHECKPOINT_KEY = 'vela-workflow-checkpoint'

// vi.hoisted：mock 工厂需要引用共享状态（dbMap/记录），且必须在 hoisted 作用域内定义
const h = vi.hoisted(() => {
  const dbMap = new Map<string, string>()
  const invoke = vi.fn(async (...args: unknown[]) => {
    const ch = args[0] as string
    if (ch === 'db:checkpoint-save') {
      dbMap.set('cp', JSON.stringify(args[1]))
      return { success: true }
    }
    if (ch === 'db:checkpoint-load') {
      return { success: true, data: dbMap.get('cp') ? JSON.parse(dbMap.get('cp')!) : null }
    }
    if (ch === 'db:checkpoint-clear') {
      dbMap.delete('cp')
      return { success: true }
    }
    return { success: true }
  })
  return { dbMap, invoke, seen: [] as string[], seenData: [] as Record<string, unknown>[] }
})

vi.mock('../services/ipc-client', () => ({
  ipc: { invoke: (...a: unknown[]) => h.invoke(...(a as [])) },
}))

// 注册一个可重建的 workflow（type: post_process），executor 记录运行步骤供断言断点重放 +
// 记录 executor 读到的 ctx.data（IMP-1：waiting 续跑须消费 checkpoint contextData，而非空）
registerWorkflow('post_process', () => ({
  type: 'post_process',
  title: '后处理（L2 测试桩）',
  steps: ['a', 'b', 'c'].map((name) => ({
    name,
    description: name,
    executor: async (_step, ctx) => {
      h.seen.push(name)
      h.seenData.push({ ...ctx.data })
      return name
    },
  })),
  rehydrateParams: {},
}))

/** 构造一个 3 步（a/b/c）的 post_process run 快照（checkpoint 内嵌形状） */
function makeRun(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    type: 'post_process' as const,
    title: `run-${id}`,
    status: 'running' as const,
    currentStepIndex: 0,
    createdAt: '2026-09-05T00:00:00.000Z',
    steps: [
      { id: `${id}-s0`, name: 'a', description: 'a', status: 'pending' as const, logs: [] },
      { id: `${id}-s1`, name: 'b', description: 'b', status: 'pending' as const, logs: [] },
      { id: `${id}-s2`, name: 'c', description: 'c', status: 'pending' as const, logs: [] },
    ],
    rehydrateParams: { seed: id },
    ...over,
  }
}

const resetStore = () => {
  useWorkflowStore.setState({
    activeRuns: [],
    history: [],
    globalLogs: [],
    waitingRuns: {},
    currentRun: null,
    waitingForConfirm: false,
    waitingAfterStepIndex: -1,
  })
}

/** 轮询等待某条件成立（异步断点重放需等待 async 链路完成） */
async function waitFor(fn: () => boolean, timeout = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, 1))
  }
}

beforeEach(() => {
  h.dbMap.clear()
  h.seen.length = 0
  h.seenData.length = 0
  localStorage.clear()
  resetStore()
})

describe('workflow-checkpoint v2（L2）', () => {
  it('restoreCheckpoint v2：waiting 断点重放（跨重启真续跑，I-1 对齐 running → completed）', async () => {
    // waitingAfterStepIndex=1 → 断点续跑应从步骤 2（c）开始，seen 只含断点后步骤
    const cp = {
      activeRuns: [
        makeRun('run-wait', {
          currentStepIndex: 1,
          status: 'waiting',
          steps: [
            { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
            { id: 's1', name: 'b', description: 'b', status: 'completed', result: 'b', logs: [] },
            { id: 's2', name: 'c', description: 'c', status: 'pending', logs: [] },
          ],
        }),
      ],
      waitingRuns: { 'run-wait': { waitingForConfirm: true, waitingAfterStepIndex: 1 } },
      savedAt: '2026-09-05T00:01:00.000Z',
      runDefs: { 'run-wait': { type: 'post_process', params: { seed: 'run-wait' } } },
      contextData: { 'run-wait': { shared: 'ctx' } },
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    const restored = await useWorkflowStore.getState().restoreCheckpoint()
    expect(restored).not.toBeNull()
    const waitingRun = useWorkflowStore.getState().activeRuns.find((r) => r.id === 'run-wait')
    expect(waitingRun?.status).toBe('waiting')
    // 等待标记保留（confirmContinue 依赖 waitingAfterStepIndex 定位断点）
    expect(useWorkflowStore.getState().waitingRuns['run-wait']?.waitingAfterStepIndex).toBe(1)
    // waiting 未自动重放：seen 为空
    expect(h.seen).toEqual([])

    // 点「继续」→ 断点重放：只跑断点后步骤（c），并靠 I-1（restore 态对齐 running）打到 completed
    useWorkflowStore.getState().confirmContinue('run-wait')
    await waitFor(() => useWorkflowStore.getState().history.some((r) => r.id === 'run-wait'))
    const finalRun = useWorkflowStore.getState().history.find((r) => r.id === 'run-wait')
    expect(finalRun?.status).toBe('completed')
    expect(h.seen).toEqual(['c'])
    // IMP-1：waiting 续跑消费 checkpoint 的 contextData（executor 读到断点共享数据而非空）
    expect(h.seenData).toEqual([{ shared: 'ctx' }])
  })

  it('restoreCheckpoint v2：running 中断自动重放（从 currentStepIndex 立即续跑）', async () => {
    const cp = {
      activeRuns: [
        makeRun('run-live', {
          currentStepIndex: 1,
          status: 'running',
          steps: [
            { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
            { id: 's1', name: 'b', description: 'b', status: 'pending', logs: [] },
            { id: 's2', name: 'c', description: 'c', status: 'pending', logs: [] },
          ],
        }),
      ],
      waitingRuns: {},
      savedAt: '2026-09-05T00:02:00.000Z',
      runDefs: { 'run-live': { type: 'post_process', params: { seed: 'run-live' } } },
      contextData: { 'run-live': { shared: 'ctx' } },
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    await useWorkflowStore.getState().restoreCheckpoint()
    // running 中断 → 立即自动重放（从 currentStepIndex=1 起跑 b、c）
    await waitFor(() => useWorkflowStore.getState().history.some((r) => r.id === 'run-live'))
    const finalRun = useWorkflowStore.getState().history.find((r) => r.id === 'run-live')
    expect(finalRun?.status).toBe('completed')
    expect(h.seen).toEqual(['b', 'c'])
  })

  it('restoreCheckpoint v2：不可重建 → 旧兜底（waiting→failed / running→paused，不自动重放）', async () => {
    // 用未注册的 type（rehydrateWorkflow 返回 null）走旧兜底
    const legacyRun = makeRun('run-old', {
      type: 'chapter_creation' as const,
      status: 'running',
      steps: [
        { id: 'x-s0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
        { id: 'x-s1', name: 'b', description: 'b', status: 'pending', logs: [] },
      ],
    })
    const cp = {
      activeRuns: [legacyRun],
      waitingRuns: { 'run-old': { waitingForConfirm: true, waitingAfterStepIndex: 0 } },
      savedAt: '2026-09-05T00:03:00.000Z',
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    await useWorkflowStore.getState().restoreCheckpoint()
    const restoredRun = useWorkflowStore.getState().activeRuns.find((r) => r.id === 'run-old')
    // 不可重建的 waiting → failed，且等待标记清除
    expect(restoredRun?.status).toBe('failed')
    expect(useWorkflowStore.getState().waitingRuns['run-old']).toBeUndefined()
  })

  it('saveCheckpoint 经迁移写回 DB：含 runDefs + contextData 重建信息', async () => {
    // DB 空（h.dbMap 无 'cp'）+ localStorage 有旧 checkpoint（含 runDefs/contextData）
    const legacyCp = {
      activeRuns: [
        makeRun('run-legacy', {
          type: 'chapter_creation' as const,
          currentStepIndex: 0,
          steps: [
            { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
          ],
        }),
      ],
      waitingRuns: {},
      savedAt: '2026-09-05T00:04:00.000Z',
      runDefs: { 'run-legacy': { type: 'chapter_creation', params: { seed: 'run-legacy' } } },
      contextData: { 'run-legacy': { shared: 'ctx' } },
    }
    localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(legacyCp))

    const restored = await useWorkflowStore.getState().restoreCheckpoint()
    expect(restored).not.toBeNull()
    // DB 空 → 兜底读 localStorage 并迁移写回 DB
    expect(h.dbMap.get('cp')).toBeTruthy()
    const migrated = JSON.parse(h.dbMap.get('cp')!)
    // 重建信息随迁移写回：runDefs + contextData 均保留
    expect(migrated.runDefs['run-legacy']).toEqual({ type: 'chapter_creation', params: { seed: 'run-legacy' } })
    expect(migrated.contextData['run-legacy']).toEqual({ shared: 'ctx' })
  })

  it('restoreCheckpoint v2：损坏降级（activeRuns 非数组/非法 JSON）→ 视为无 checkpoint，不崩', async () => {
    h.dbMap.set('cp', JSON.stringify({ activeRuns: 'corrupt', savedAt: 'x' }))
    await expect(useWorkflowStore.getState().restoreCheckpoint()).resolves.toBeNull()
    expect(useWorkflowStore.getState().activeRuns).toHaveLength(0)
  })

  // ===== L2 final review fix wave（final whole-branch review）=====

  it('legacy checkpoint（runDefs 缺失）→ 走安全兜底非误路由（waiting→failed / running→paused，不自动重放）', async () => {
    // registry 已注册 post_process（rehydrateWorkflow 恒可重建）；但 checkpoint 缺 runDefs
    // （legacy pre-L2 localStorage 旧数据）→ 必须走 else 兜底，不得用空 params 命中工厂误路由。
    const legacyRun = makeRun('run-legacy-missing', {
      status: 'running',
      currentStepIndex: 1,
      steps: [
        { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
        { id: 's1', name: 'b', description: 'b', status: 'running', logs: [] },
        { id: 's2', name: 'c', description: 'c', status: 'pending', logs: [] },
      ],
    })
    const cp = {
      activeRuns: [legacyRun],
      waitingRuns: {},
      savedAt: '2026-09-05T00:05:00.000Z',
      // 无 runDefs：模拟 legacy pre-L2 localStorage checkpoint
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    await useWorkflowStore.getState().restoreCheckpoint()
    const run = useWorkflowStore.getState().activeRuns.find((r) => r.id === 'run-legacy-missing')
    expect(run?.status).toBe('paused') // running 走兜底 → paused，而非误路由自动重放
    expect(h.seen).toEqual([]) // 未被重放（不重新生成内容）
  })

  it('legacy checkpoint（runDefs 缺失）novel_import → 不调工厂不抛 TypeError，整批 restore 正常 resolve', async () => {
    // 复现真实 novel_import 工厂：params.chapters 缺失会抛（String(params.chapters.length) → undefined）
    registerWorkflow('novel_import', (p) => {
      if (!p.chapters) throw new TypeError('chapters undefined')
      return { type: 'novel_import', title: '导入', steps: [] }
    })
    const legacyRun = makeRun('run-import', {
      type: 'novel_import' as const,
      status: 'running',
      currentStepIndex: 0,
      steps: [{ id: 'i-s0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] }],
    })
    const cp = {
      activeRuns: [legacyRun],
      waitingRuns: {},
      savedAt: '2026-09-05T00:06:00.000Z',
      // 无 runDefs
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    // runDefs 缺失 → 不得调用工厂（否则 TypeError）→ 整批 restore 必须 resolve（不 reject）+ 走兜底
    await expect(useWorkflowStore.getState().restoreCheckpoint()).resolves.not.toBeNull()
    const run = useWorkflowStore.getState().activeRuns.find((r) => r.id === 'run-import')
    expect(run?.status).toBe('paused')
    expect(h.seen).toEqual([])
  })

  it('running 重放 startIndex>=steps.length（末步已完成与 run 完成间崩溃）→ completed 不 stuck running', async () => {
    // post_process 定义 3 步（a/b/c）；run 已完成全部步骤（currentStepIndex=3 >= steps.length=3）。
    // 先入列（set activeRuns）再 fire executeRunFromIndex → 零迭代同步完成，finalRun 命中 → completed 入历史。
    const finishedRun = makeRun('run-done', {
      status: 'running',
      currentStepIndex: 3,
      steps: [
        { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
        { id: 's1', name: 'b', description: 'b', status: 'completed', result: 'b', logs: [] },
        { id: 's2', name: 'c', description: 'c', status: 'completed', result: 'c', logs: [] },
      ],
    })
    const cp = {
      activeRuns: [finishedRun],
      waitingRuns: {},
      savedAt: '2026-09-05T00:07:00.000Z',
      runDefs: { 'run-done': { type: 'post_process', params: { seed: 'run-done' } } },
    }
    h.dbMap.set('cp', JSON.stringify(cp))

    await useWorkflowStore.getState().restoreCheckpoint()
    await waitFor(() => useWorkflowStore.getState().history.some((r) => r.id === 'run-done'))
    const finalRun = useWorkflowStore.getState().history.find((r) => r.id === 'run-done')
    expect(finalRun?.status).toBe('completed')
    // 不再 stuck running：activeRuns 不残留该 run
    expect(useWorkflowStore.getState().activeRuns.some((r) => r.id === 'run-done')).toBe(false)
    // 零迭代重跑：无步骤被执行
    expect(h.seen).toEqual([])
  })
})
