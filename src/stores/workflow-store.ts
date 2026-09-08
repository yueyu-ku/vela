import { create } from 'zustand'
import { getCurrentLocale, t } from '../shared/locale'
import { randomUUID } from '../utils/id'
import { renderLog } from '../services/render-logger'
import { sanitizeCheckpointData, cleanupMessageText } from '../services/agent/conversation-recovery'
import { mirrorStepAppend, deleteRunOutput, readStepOutputTail } from '../services/workflow-output'

// ===== 工作流 Checkpoint 持久化 =====

const CHECKPOINT_KEY = 'vela-workflow-checkpoint'

/** Checkpoint 数据结构（导出：conversation-recovery 净化纯函数复用类型，L2 迁 DB 亦复用） */
export interface CheckpointData {
  activeRuns: WorkflowRun[]
  waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>
  savedAt: string
}

function saveCheckpoint(state: WorkflowState): void {
  try {
    const data: CheckpointData = {
      activeRuns: state.activeRuns.filter(r => r.status === 'running' || r.status === 'waiting' || r.status === 'paused'),
      waitingRuns: state.waitingRuns,
      savedAt: new Date().toISOString(),
    }
    if (data.activeRuns.length > 0) {
      localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(data))
    } else {
      localStorage.removeItem(CHECKPOINT_KEY)
    }
  } catch { /* localStorage 不可用 */ }
}

function loadCheckpoint(): CheckpointData | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY)
    if (!raw) return null
    return JSON.parse(raw) as CheckpointData
  } catch {
    return null
  }
}

function clearCheckpoint(): void {
  try { localStorage.removeItem(CHECKPOINT_KEY) } catch { /* ignore */ }
}

// ===== 工作流数据模型 =====

/** 工作流步骤状态 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/** 工作流运行状态 */
export type WorkflowStatus = 'idle' | 'running' | 'completed' | 'failed' | 'paused' | 'waiting'

/** 工作流步骤 */
export interface WorkflowStep {
  id: string
  name: string
  description: string
  status: StepStatus
  progress?: number
  result?: string
  error?: string
  startedAt?: string
  completedAt?: string
  logs: string[]
  /** 允许命令注入额外属性（如 commandId, params 等） */
  [extra: string]: unknown
}

/** 工作流运行实例 */
export interface WorkflowRun {
  id: string
  type: WorkflowType
  title: string
  status: WorkflowStatus
  steps: WorkflowStep[]
  currentStepIndex: number
  createdAt: string
  completedAt?: string
  /** L2：可重建参数快照（rehydrateParams；Task 5 save 消费；confirmContinue 跨重启重放读） */
  rehydrateParams?: WorkflowParams
}

/** 工作流类型 */
export type WorkflowType =
  | 'new_project_setup'       // 新项目初始化（配置→架构→目录）
  | 'architecture_generation' // 架构生成（故事前提→角色图谱→世界观→情节大纲）
  | 'directory'               // 目录/蓝图生成
  | 'chapter_creation'        // 章节创作（写稿→修稿→审稿→定稿）
  | 'batch_generate'          // 批量生成
  | 'config_generation'       // 智能配置生成
  | 'post_process'            // 后处理任务（角色卡提取等）
  | 'novel_import'            // 导入已有小说（逆向推演全流程）

/** 工作流步骤执行器 */
export type StepExecutor = (
  step: WorkflowStep,
  context: WorkflowContext,
  callbacks: StepCallbacks,
) => Promise<string | void>

/** 工作流上下文（共享数据） */
export interface WorkflowContext {
  /** 步骤间传递的数据 */
  data: Record<string, unknown>
  /** 是否已取消 */
  cancelled: boolean
}

/** 步骤回调 */
export interface StepCallbacks {
  /** 追加日志 */
  log: (message: string) => void
  /** 更新进度 (0-100) */
  setProgress: (progress: number) => void
  /** 流式文本追加 */
  appendText: (text: string) => void
}

// ===== 工作流定义 =====

/** 工作流完成后的通知/跳转动作 */
export interface WorkflowCompleteAction {
  /** 通知策略：open=直接打开 | silent=仅内部状态不额外动作 */
  mode: 'open' | 'silent'
  /** 成功时的提示文案（备用，供日志用） */
  message?: string
  /** 打开结果的回调（open 模式直接调用） */
  openResult?: () => void | Promise<void>
}

export type WorkflowParams = Record<string, unknown>

export interface WorkflowDefinition {
  type: WorkflowType
  title: string
  steps: Array<{
    name: string
    description: string
    executor: StepExecutor
  }>
  /** 工作流完成后的通知/跳转动作（可选） */
  onComplete?: WorkflowCompleteAction
  /** L2：可重建参数快照（type + 此 params → rehydrateWorkflow 重建定义；零改动调用点，方案 ii） */
  rehydrateParams?: WorkflowParams
}

// ===== Store =====

interface WorkflowState {
  /** 所有活跃的工作流（支持多任务并发） */
  activeRuns: WorkflowRun[]
  /** 历史工作流记录 */
  history: WorkflowRun[]
  /** 全局日志（下方面板用） */
  globalLogs: Array<{ ts: number; time: string; level: 'info' | 'warn' | 'error'; message: string }>

  /** 兼容属性：第一个活跃工作流（供旧代码平稳过渡） */
  currentRun: WorkflowRun | null

  /** 步进模式：各工作流的等待状态 */
  waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>

  // ===== 旧接口兼容（映射到第一个 activeRun） =====
  waitingForConfirm: boolean
  waitingAfterStepIndex: number

  // ===== 便捷查询 =====
  /** 检查指定类型的工作流是否有在运行 */
  isTypeRunning: (type: WorkflowType) => boolean
  /** 是否有任何工作流在运行 */
  hasActiveRun: () => boolean
  /** 活跃任务数量 */
  activeCount: () => number
  /** 获取当前正在流式输出的活跃工作流（供 AI 输出面板消费） */
  getActiveStreamingRun: () => WorkflowRun | null
  /** 获取当前最活跃任务的步骤信息（供 StatusBar 胶囊显示） */
  getActiveStepInfo: () => { title: string; stepName: string; progress: number; total: number; completed: number } | null

  // ===== Actions =====
  /** 启动一个工作流（可并发），返回 runId */
  startWorkflow: (definition: WorkflowDefinition, stepByStep?: boolean) => Promise<string>
  /** 步进模式下确认继续执行下一步（需指定 runId） */
  confirmContinue: (runId?: string) => void
  /** 取消工作流（传 runId 取消指定，不传取消全部） */
  cancelWorkflow: (runId?: string) => void
  /** 添加全局日志 */
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 清空日志 */
  clearLogs: () => void
  /** 从 checkpoint 恢复未完成的工作流（应用启动时调用） */
  restoreCheckpoint: () => CheckpointData | null
  /** 清除持久化的 checkpoint */
  clearCheckpoint: () => void
  /**
   * 崩溃恢复续读（M2，CC §三.4）：restoreCheckpoint 后调用——把中断步骤落盘到
   * workflow-output/<runId>/<stepIndex>.txt 的输出（主进程文件）补回空的 step.result。
   * 只补「result 为空且文件存在」的步骤（checkpoint 已有内容/正常步骤零改动），
   * 补填内容走 cleanupMessageText 净化（与 checkpoint 恢复同语义，防半截 think 残片）。
   */
  hydrateInterruptedOutputs: () => Promise<void>
}

/** 工作流上下文实例 Map（runId → context） */
const activeContexts = new Map<string, WorkflowContext>()
/** 步进模式：存储「等待用户确认」的 Promise resolve（runId → resolve） */
const continueResolveRefs = new Map<string, () => void>()
/** L2：run 可重建参数快照（type + params → rehydrateWorkflow；Task 5 saveCheckpoint 消费，本任务先引入） */
const runDefs = new Map<string, { type: WorkflowType; params: WorkflowParams }>()

// ===== appendText 流式缓冲（共享限频调度器） =====
// LLM 流式 chunk 逐片 setState 会高频重渲染整个面板，阻塞主线程。
// 后果：mouseover 事件排队 → 浏览器原生 title 提示（UI 线程驱动，不受 JS 阻塞）
// 抢先弹出，用户看到"旧样式"悬浮弹窗。
//
// 根因教训（44244a1 修复无效的原因）：旧的"按 buffer 大小 >=200 立即 flush"会绕过
// 定时器——chunk 大或快时 flush 频率仍 ≈ chunk 频率；且定稿后处理 6-7 个步骤并发
// 流式，各自独立 buffer/timer，setState 频率再 ×并发数 → 主线程照样被占。
//
// 正确做法：**单一共享 timer 驱动，所有 run/step 的文本先进 pending 队列**。
// 最小刷新间隔 = FLUSH_INTERVAL_MS 是硬约束（并发步骤共用一个 timer，每轮最多
// 一次渲染）；同 tick 内的多次 updateStepById 被 React 自动批处理为一次渲染。
const FLUSH_INTERVAL_MS = 100
const pendingAppendFlushes = new Map<string, string>()
let appendFlushScheduled = false

/** 安排下一轮统一 flush（模块级单 timer，所有并发步骤共享） */
function scheduleAppendFlush(): void {
  if (appendFlushScheduled) return
  appendFlushScheduled = true
  setTimeout(() => {
    appendFlushScheduled = false
    flushAllPendingAppends()
  }, FLUSH_INTERVAL_MS)
}

/**
 * 把当前步骤的累积文本写入步骤 result。
 * key 格式：`{runId}:{stepIndex}`
 *
 * M2 双轨：此处是「内存流式 + 文件镜像」的单一汇聚点——文本以既有 100ms 共享 flush 节奏
 * 同时进 step.result（UI 流式渲染）与主进程输出文件（崩溃恢复/续读，见 workflow-output）。
 * 镜像与内存写同频、fire-and-forget，失败静默（补充通道，绝不打断渲染主路径）。
 */
function writeStepResultAppend(key: string, text: string): void {
  const sepIdx = key.indexOf(':')
  if (sepIdx < 0) return
  const runId = key.slice(0, sepIdx)
  const stepIndex = parseInt(key.slice(sepIdx + 1), 10)
  if (isNaN(stepIndex)) return

  const activeRun = useWorkflowStore.getState().activeRuns.find(r => r.id === runId)
  if (!activeRun) return
  const step = activeRun.steps[stepIndex]
  if (!step) return
  updateStepById(useWorkflowStore.setState, runId, stepIndex, { result: (step.result || '') + text })
  mirrorStepAppend(runId, stepIndex, text)
}

/** 定时器到期：把 pending 队列中全部累积文本一次性写入（多 key 同 tick → 一次渲染） */
function flushAllPendingAppends(): void {
  if (pendingAppendFlushes.size === 0) return
  for (const [key, text] of pendingAppendFlushes) {
    pendingAppendFlushes.delete(key)
    writeStepResultAppend(key, text)
  }
}

/**
 * 立即写入指定 key 的残留缓冲（不等 timer）。
 * 用于步骤完成/工作流结束时——此后该 key 不会再有新 chunk。
 */
function flushAppendTextNow(key: string): void {
  const text = pendingAppendFlushes.get(key)
  if (text === undefined) return
  pendingAppendFlushes.delete(key)
  writeStepResultAppend(key, text)
}

/** 清理某工作流的所有待写缓冲（结束/取消时丢弃残留，不写入） */
function clearAppendBuffers(runId: string): void {
  for (const key of [...pendingAppendFlushes.keys()]) {
    if (key.startsWith(`${runId}:`)) pendingAppendFlushes.delete(key)
  }
}

/** 计算兼容字段的辅助函数 */
function computeCompat(activeRuns: WorkflowRun[], waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>) {
  const currentRun = activeRuns.length > 0 ? activeRuns[0] : null
  const firstRunId = currentRun?.id ?? ''
  const firstWaiting = waitingRuns[firstRunId]
  return {
    currentRun,
    waitingForConfirm: firstWaiting?.waitingForConfirm ?? false,
    waitingAfterStepIndex: firstWaiting?.waitingAfterStepIndex ?? -1,
  }
}

export const useWorkflowStore = create<WorkflowState>()((set, get) => ({
  activeRuns: [],
  history: [],
  globalLogs: [],
  waitingRuns: {},

  // 兼容属性初始值
  currentRun: null,
  waitingForConfirm: false,
  waitingAfterStepIndex: -1,

  // ===== 便捷查询 =====
  isTypeRunning: (type) => get().activeRuns.some(r => r.type === type && (r.status === 'running' || r.status === 'waiting')),
  hasActiveRun: () => get().activeRuns.length > 0,
  activeCount: () => get().activeRuns.length,

  getActiveStreamingRun: () => {
    const runs = get().activeRuns
    // 优先返回正在 running 的任务；其次 waiting 的
    return runs.find(r => r.status === 'running') || runs.find(r => r.status === 'waiting') || null
  },

  getActiveStepInfo: () => {
    const run = get().activeRuns.find(r => r.status === 'running' || r.status === 'waiting')
    if (!run) return null
    const step = run.steps[run.currentStepIndex] || run.steps[0]
    const completed = run.steps.filter(s => s.status === 'completed').length
    return {
      title: run.title,
      stepName: step?.name || '',
      progress: step?.progress || 0,
      total: run.steps.length,
      completed,
    }
  },

  confirmContinue: (runId) => {
    // 如果未指定 runId，使用第一个等待中的
    const targetId = runId ?? Object.keys(get().waitingRuns).find(id => get().waitingRuns[id]?.waitingForConfirm)
    if (!targetId) return
    const resolve = continueResolveRefs.get(targetId)
    if (resolve) {
      // 进程内步进等待：内存 resolve（现状语义不变），continueResolveRefs 保持进程内语义
      resolve()
      continueResolveRefs.delete(targetId)
    } else {
      // L2：跨重启恢复后 waiting 无内存 resolve → 用断点重放续跑
      // （动态 import 规避 store←→registry 静态循环；rehydrateWorkflow 按 run 参数重建定义）
      const r = get().activeRuns.find(x => x.id === targetId)
      if (r) {
        import('../services/workflows/workflow-registry').then(async m => {
          const def = m.rehydrateWorkflow(r.type, r.rehydrateParams ?? {})
          if (def) {
            const waitIdx = get().waitingRuns[targetId]?.waitingAfterStepIndex ?? -1
            await executeRunFromIndex(r, def, waitIdx + 1, activeContexts.get(targetId)?.data ?? {})
          }
        }).catch(() => {})
      }
    }
    set(s => {
      const newWaiting = { ...s.waitingRuns }
      delete newWaiting[targetId]
      const compat = computeCompat(s.activeRuns, newWaiting)
      return { waitingRuns: newWaiting, ...compat }
    })
  },

  startWorkflow: async (definition, stepByStep = false) => {
    const run: WorkflowRun = {
      id: randomUUID(),
      type: definition.type,
      title: definition.title,
      status: 'running',
      currentStepIndex: 0,
      createdAt: new Date().toISOString(),
      steps: definition.steps.map((s) => ({
        id: randomUUID(),
        name: s.name,
        description: s.description,
        status: 'pending',
        logs: [],
      })),
      rehydrateParams: definition.rehydrateParams ?? {},
    }

    // 添加到活跃列表
    set(s => {
      const newRuns = [...s.activeRuns, run]
      return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
    })
    get().addLog('info', `[Start] ${definition.title}`)

    // 自动联动：打开底部任务面板（步进模式的"继续"确认按钮所在位置）+ 右侧 AI 输出视图
    // 非阻塞 import 避免循环依赖；不打开底栏时，步进模式下工作流会在等待确认时"隐形卡住"
    import('./layout-store').then(m => {
      m.useLayoutStore.getState().openBottomTab('tasks')
      m.useLayoutStore.getState().openRightPanel('ai-output')
    }).catch(() => {})

    // 记录 run 可重建参数快照（Task 5 saveCheckpoint 消费；confirmContinue 跨重启重放读 run.rehydrateParams）
    runDefs.set(run.id, { type: run.type, params: definition.rehydrateParams ?? {} })

    // 交给可重入执行函数（断点 index 0 + 空上下文字段）——行为与原内联循环 + 收尾等价
    await executeRunFromIndex(run, definition, 0, {}, stepByStep)
    return run.id
  },

  cancelWorkflow: (runId) => {
    if (runId) {
      // 取消指定工作流
      const ctx = activeContexts.get(runId)
      if (ctx) ctx.cancelled = true
      // 如果在步进等待，解除 Promise
      const resolve = continueResolveRefs.get(runId)
      if (resolve) { resolve(); continueResolveRefs.delete(runId) }
      // 移入历史
      set(s => {
        const targetRun = s.activeRuns.find(r => r.id === runId)
        const newRuns = s.activeRuns.filter(r => r.id !== runId)
        const newWaiting = { ...s.waitingRuns }
        delete newWaiting[runId]
        const newHistory = targetRun
          ? [{ ...targetRun, status: 'failed' as const, completedAt: new Date().toISOString() }, ...s.history].slice(0, 50)
          : s.history
        return {
          activeRuns: newRuns,
          history: newHistory,
          waitingRuns: newWaiting,
          ...computeCompat(newRuns, newWaiting),
        }
      })
      get().addLog('warn', '[Cancel] Workflow cancelled')
      clearAppendBuffers(runId)
      // M2：取消 = 任务级清理（用户不再需要该任务输出；崩溃恢复窗口关闭）
      deleteRunOutput(runId)
      saveCheckpoint(get())
    } else {
      // 取消全部
      const allRunIds = get().activeRuns.map(r => r.id)
      for (const [id, ctx] of activeContexts) {
        ctx.cancelled = true
        const resolve = continueResolveRefs.get(id)
        if (resolve) { resolve(); continueResolveRefs.delete(id) }
      }
      set(s => {
        const cancelledRuns = s.activeRuns.map(r => ({
          ...r, status: 'failed' as const, completedAt: new Date().toISOString(),
        }))
        return {
          activeRuns: [],
          waitingRuns: {},
          history: [...cancelledRuns, ...s.history].slice(0, 50),
          currentRun: null,
          waitingForConfirm: false,
          waitingAfterStepIndex: -1,
        }
      })
      get().addLog('warn', '[Cancel] All workflows cancelled')
      clearCheckpoint()
      // M2：取消全部 = 逐个任务级清理（被取消 run 的输出文件不再保留）
      for (const id of allRunIds) deleteRunOutput(id)
    }
  },

  addLog: (level, message) => {
    const now = Date.now()
    const entry = { ts: now, time: new Date(now).toLocaleTimeString(getCurrentLocale()), level, message }
    set((s) => ({
      globalLogs: [...s.globalLogs, entry].slice(-500), // 保留最近 500 条
    }))
    // 双写：内存（LogsView 展示）+ 主进程文件日志（持久化，用户反馈可查）
    renderLog(level, 'Workflow', message)
  },

  clearLogs: () => set({ globalLogs: [] }),

  // ===== Checkpoint 持久化 =====
  restoreCheckpoint: () => {
    // C4 净化（conversation-recovery）：恢复前先净化 checkpoint——steps[].result/error/logs 的
    // LLM 崩溃残片（半截 think/tool 标签）清理；形状防御（activeRuns/run/steps/waitingRuns 逐级
    // 校验，损坏 checkpoint 曾致启动崩溃：activeRuns 非数组时对字符串 .map）→ 损坏返回 null
    // 按「无 checkpoint」处理。正常 checkpoint 零改动（净化只命中残片）。
    const cp = sanitizeCheckpointData(loadCheckpoint())
    if (cp && cp.activeRuns.length > 0) {
      // 区分「等待确认」与「运行中中断」：
      // - 等待确认的工作流：executor 已随进程销毁，continueResolveRefs（内存态）
      //   为空，「继续」按钮将点击无效 → 标记 failed 并提示重新运行
      // - 运行中中断的工作流：恢复为 paused 展示，用户可取消后重新开始
      const interruptedWaitingIds = new Set(Object.keys(cp.waitingRuns ?? {}))
      const restored = cp.activeRuns.map(r => {
        if (interruptedWaitingIds.has(r.id)) {
          // 工作流标题是用户数据，可能含 $ 等特殊字符 → 箭头函数 replacer 防 $& 语义
          get().addLog('warn', t('log.workflow.restoreInterrupted').replace('{title}', () => r.title))
          return { ...r, status: 'failed' as const }
        }
        return { ...r, status: 'paused' as const }
      })
      set((s) => ({
        activeRuns: [...s.activeRuns, ...restored],
        // 等待确认的 run 已标记失败，其 waiting 标记不再恢复（避免「继续」按钮无效假象）
        waitingRuns: Object.fromEntries(
          Object.entries(cp.waitingRuns ?? {}).filter(([id]) => !interruptedWaitingIds.has(id))
        ),
      }))
    }
    return cp
  },

  clearCheckpoint: () => clearCheckpoint(),

  hydrateInterruptedOutputs: async () => {
    // 只处理崩溃恢复回来的暂停/失败 run（正常 run 不落此状态，文件在其结束时已被任务级清理）
    const runs = get().activeRuns.filter(r => r.status === 'paused' || r.status === 'failed')
    for (const run of runs) {
      // 候选 = result 为空/缺失的步骤（文件存在才补——pending/未流式步骤无文件，天然跳过）
      const candidates = run.steps
        .map((step, index) => ({ index, step }))
        .filter(({ step }) => typeof step.result !== 'string' || step.result === '')
      for (const { index } of candidates) {
        try {
          const tail = await readStepOutputTail(run.id, index, { full: true })
          if (!tail.success || !tail.exists || tail.content === '') continue
          // cleanupMessageText：与 restoreCheckpoint 同语义净化（半截 think/tool 残片）
          updateStepById(set, run.id, index, { result: cleanupMessageText(tail.content) })
        } catch {
          // 单步补填失败不影响其余步骤/run
        }
      }
    }
  },
}))

// Auto-save checkpoint on beforeunload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    saveCheckpoint(useWorkflowStore.getState())
  })
}

// ===== 工具函数（按 runId 操作） =====

/** 更新指定工作流的运行状态 */
function updateRunById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  updates: Partial<WorkflowRun>
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r =>
      r.id === runId ? { ...r, ...updates } : r
    )
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

/** 更新指定工作流的指定步骤 */
function updateStepById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  stepIndex: number,
  updates: Partial<WorkflowStep>
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      steps[stepIndex] = { ...steps[stepIndex], ...updates }
      return { ...r, steps }
    })
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

/** 追加指定工作流的指定步骤日志 */
function appendStepLogById(
  set: (fn: (s: WorkflowState) => Partial<WorkflowState>) => void,
  runId: string,
  stepIndex: number,
  message: string
) {
  set((s) => {
    const newRuns = s.activeRuns.map(r => {
      if (r.id !== runId) return r
      const steps = [...r.steps]
      steps[stepIndex] = {
        ...steps[stepIndex],
        logs: [...steps[stepIndex].logs, `[${new Date().toLocaleTimeString(getCurrentLocale())}] ${message}`],
      }
      return { ...r, steps }
    })
    return { activeRuns: newRuns, ...computeCompat(newRuns, s.waitingRuns) }
  })
}

/**
 * L2：把原 startWorkflow 内联执行循环抽为按任意断点 index 推进的可重入函数。
 *
 * - `startIndex` 之前的步骤视为已完成（断点重放：跳过，不重跑）；
 * - `contextData` 作为重放起点的工作流上下文字段（executor 经 `ctx.data` 读到）；
 * - 完成后处理（完成判定/onComplete/入历史/清理/PERSIST）与本函数一体
 *   （Task 5 save/load/restore 复用；index 0 调用 = 原 startWorkflow 内联循环等价）。
 * `activeContexts`/`continueResolveRefs` 保持模块级进程内语义（此函数重建 context）。
 * `stepByStep`（可选，仅 startWorkflow 传入）：重放/续跑路径默认 false（不再暂停）。
 */
export async function executeRunFromIndex(
  run: WorkflowRun,
  definition: WorkflowDefinition,
  startIndex: number,
  contextData: Record<string, unknown>,
  stepByStep = false,
): Promise<void> {
  const set = useWorkflowStore.setState
  const get = () => useWorkflowStore.getState()

  // 重建执行上下文（模块级进程内 Map 语义）
  const context: WorkflowContext = { data: contextData, cancelled: false }
  activeContexts.set(run.id, context)

  // 逐步执行（从断点 startIndex 起）
  for (let i = startIndex; i < definition.steps.length; i++) {
    // 检查取消
    if (context.cancelled) {
      updateRunById(set, run.id, { status: 'failed' })
      get().addLog('warn', `[Cancel] ${definition.title}`)
      break
    }

    const stepDef = definition.steps[i]

    // 标记当前步骤为运行中
    updateStepById(set, run.id, i, { status: 'running', startedAt: new Date().toISOString() })
    updateRunById(set, run.id, { currentStepIndex: i })
    get().addLog('info', `[${definition.title}] ${stepDef.name}`)

    // 创建步骤回调
    const callbacks: StepCallbacks = {
      log: (message) => {
        appendStepLogById(set, run.id, i, message)
        get().addLog('info', `  ${message}`)
      },
      setProgress: (progress) => {
        updateStepById(set, run.id, i, { progress })
      },
      appendText: (text) => {
        // 共享限频调度：只累积 + 安排统一 flush（timer 保证最小间隔），
        // 不在此同步 setState——避免 LLM 流式高频 chunk 阻塞主线程
        const key = `${run.id}:${i}`
        pendingAppendFlushes.set(key, (pendingAppendFlushes.get(key) ?? '') + text)
        scheduleAppendFlush()
      },
    }

    try {
      const result = await stepDef.executor(run.steps[i], context, callbacks)
      // 刷新该步骤流式缓冲残留（立即写入，避免 timer 晚于步骤完成）
      flushAppendTextNow(`${run.id}:${i}`)
      updateStepById(set, run.id, i, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        progress: 100,
        result: result || get().activeRuns.find(r => r.id === run.id)?.steps[i].result,
      })
      get().addLog('info', `[${definition.title}] ${stepDef.name} — OK`)
      saveCheckpoint(get())

      // 步进模式：非最后一步，且未取消 → 暂停等待用户确认
      if (stepByStep && i < definition.steps.length - 1 && !context.cancelled) {
        updateRunById(set, run.id, { status: 'waiting' })
        set(s => {
          const newWaiting = { ...s.waitingRuns, [run.id]: { waitingForConfirm: true, waitingAfterStepIndex: i } }
          return { waitingRuns: newWaiting, ...computeCompat(s.activeRuns, newWaiting) }
        })
        get().addLog('info', `[${definition.title}] Waiting: step ${i + 2} — ${definition.steps[i + 1].name}`)
        await new Promise<void>((resolve) => { continueResolveRefs.set(run.id, resolve) })
        if (context.cancelled) break
        updateRunById(set, run.id, { status: 'running' })
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      updateStepById(set, run.id, i, {
        status: 'failed',
        error: errorMsg,
        completedAt: new Date().toISOString(),
      })
      updateRunById(set, run.id, { status: 'failed', completedAt: new Date().toISOString() })
      get().addLog('error', `[${definition.title}] ${stepDef.name} — FAIL: ${errorMsg}`)
      break
    }
  }

  // 检查是否全部完成
  const finalRun = get().activeRuns.find(r => r.id === run.id)
  if (finalRun && finalRun.status === 'running') {
    updateRunById(set, run.id, { status: 'completed', completedAt: new Date().toISOString() })
    saveCheckpoint(get())
    get().addLog('info', `[Done] ${definition.title}`)

    // 通过 EventBus 广播工作流完成事件（替代 window.dispatchEvent）
    import('../shared/event-bus').then(m => {
      m.globalEventBus.emit('WORKFLOW_COMPLETE', { type: definition.type })
    }).catch(() => {})

    // ===== 执行 onComplete 通知/跳转 =====
    if (definition.onComplete) {
      const { mode, openResult } = definition.onComplete
      try {
        if (mode === 'open' && openResult) {
          // 直接打开结果
          await openResult()
        }
        // silent 模式不做额外操作
      } catch (e) {
        get().addLog('warn', `onComplete failed: ${e}`)
      }
    }
  }

  // 从活跃列表移除，存入历史
  set(s => {
    const completedRun = s.activeRuns.find(r => r.id === run.id)
    const newRuns = s.activeRuns.filter(r => r.id !== run.id)
    const newWaiting = { ...s.waitingRuns }
    delete newWaiting[run.id]
    const newHistory = completedRun
      ? [completedRun, ...s.history].slice(0, 50)
      : s.history
    return {
      activeRuns: newRuns,
      history: newHistory,
      waitingRuns: newWaiting,
      ...computeCompat(newRuns, newWaiting),
    }
  })

  // 清理上下文与流式缓冲
  activeContexts.delete(run.id)
  continueResolveRefs.delete(run.id)
  clearAppendBuffers(run.id)
  // M2 任务级清理：run 已移入历史（完成/失败），删除其输出目录（崩溃恢复窗口已过）
  deleteRunOutput(run.id)

  // 持久化 checkpoint
  saveCheckpoint(get())
}
