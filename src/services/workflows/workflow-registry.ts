import type { WorkflowDefinition, WorkflowType, WorkflowParams } from '../../stores/workflow-store'

export type { WorkflowParams } from '../../stores/workflow-store'
export type WorkflowRehydrateFactory = (params: WorkflowParams) => WorkflowDefinition

const registry = new Map<WorkflowType, WorkflowRehydrateFactory>()

export function registerWorkflow(type: WorkflowType, factory: WorkflowRehydrateFactory): void {
  registry.set(type, factory)
}

export function rehydrateWorkflow(type: WorkflowType, params: WorkflowParams): WorkflowDefinition | null {
  const f = registry.get(type)
  return f ? f(params) : null
}
