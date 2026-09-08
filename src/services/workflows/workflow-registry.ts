import type { WorkflowDefinition, WorkflowType, WorkflowParams } from '../../stores/workflow-store'

export type { WorkflowParams } from '../../stores/workflow-store'
export type WorkflowRehydrateFactory = (params: WorkflowParams) => WorkflowDefinition

/**
 * per-type 多工厂 registry（L2 任务6 修复 round 1）：
 * 同一 WorkflowType 可能有多个 create*Workflow 工厂（如 chapter_creation 6 个、post_process 5 个），
 * 单工厂 Map 会被「后注册覆盖先注册」→ 非有效子流重建错 definition（回归）。改为多工厂 + match 判据选厂：
 * - `match?(params)` 返回 true 时该条目命中；无 match 的条目恒命中（作该 type 的兜底）。
 * - `rehydrateWorkflow` 依序取第一个命中条目；无任何命中 → null（干净降级，不误重建）。
 *   match 判据用各工厂 rehydrateParams 附带的 __subflow 判别键（避免字段巧合冲突）。
 */
export interface WorkflowRehydrateEntry {
  factory: WorkflowRehydrateFactory
  match?: (params: WorkflowParams) => boolean
}

const registry = new Map<WorkflowType, WorkflowRehydrateEntry[]>()

export function registerWorkflow(
  type: WorkflowType,
  factory: WorkflowRehydrateFactory,
  match?: (params: WorkflowParams) => boolean,
): void {
  const arr = registry.get(type) ?? []
  arr.push({ factory, match })
  registry.set(type, arr)
}

export function rehydrateWorkflow(type: WorkflowType, params: WorkflowParams): WorkflowDefinition | null {
  const arr = registry.get(type)
  if (!arr || arr.length === 0) return null
  const hit = arr.find(e => !e.match || e.match(params))
  return hit ? hit.factory(params) : null
}
