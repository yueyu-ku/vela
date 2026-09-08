/**
 * 蓝图校验工作流 — 扫描缺口 + AI 补全
 *
 * 触发方式：
 * 1. ChapterCardEditor 中的"校验"按钮 → 仅扫描
 * 2. "补全"按钮 → 运行本工作流（扫描 + 自动补全）
 */

import type { WorkflowDefinition, WorkflowStep, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { t } from '../../shared/locale'
import { useProjectStore } from '../../stores/project-store'
import { loadDirectoryBlueprints, type ChapterBlueprint } from './directory-workflow'
import { FillGapsCommand } from './commands/fill-gaps.command'
import { generateVerificationReport, type BlueprintGap } from '../blueprint-verification-service'
import type { ProjectCoreData } from '../../../electron/repositories/project-core-repository'
import { registerWorkflow } from './workflow-registry'

export interface VerificationWorkflowParams {
  /** 是否自动补全缺口（true = 扫描 + 补全，false = 仅扫描） */
  autoFill?: boolean
}

export function createVerificationWorkflow(
  params: VerificationWorkflowParams = { autoFill: false },
): WorkflowDefinition {
  const steps: WorkflowDefinition['steps'] = [
    {
      name: t('workflow.loadBlueprints'),
      description: t('workflow.verifyLoadBlueprintsDesc'),
      executor: async (_step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
        const project = useProjectStore.getState().currentProject
        if (!project) throw new Error(t('error.noProject'))

        // 加载架构（用于补全时提供上下文）
        try {
          const { ipc } = await import('../ipc-client')
          const core = await ipc.invoke('db:project-core-get')
          if (core) {
            const parts: string[] = []
            const c = core as ProjectCoreData
            if (c.premise?.length > 50) parts.push(c.premise)
            if (c.charactersArch?.length > 50) parts.push(c.charactersArch)
            if (c.worldbuilding?.length > 50) parts.push(c.worldbuilding)
            if (c.synopsis?.length > 50) parts.push(c.synopsis)
            context.data.architecture = parts.join('\n\n---\n\n')
          }
        } catch { /* 架构加载失败不阻塞 */ }

        callbacks.log(t('log.loadingBlueprints'))
        const blueprints = await loadDirectoryBlueprints()
        context.data.blueprints = blueprints
        context.data.totalChapters = project.novelConfig.totalChapters
        callbacks.log(t('log.blueprintsLoaded').replace('{n}', String(blueprints.length)))
        return t('workflow.verifyLoadedCount').replace('{n}', String(blueprints.length))
      },
    },
    {
      name: t('workflow.scanGaps'),
      description: t('workflow.verifyScanGapsDesc'),
      executor: async (_step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
        const blueprints = context.data.blueprints as ChapterBlueprint[]
        const totalChapters = context.data.totalChapters as number

        callbacks.log(t('log.analyzingCompleteness'))
        const report = await generateVerificationReport(totalChapters, blueprints)

        context.data.verificationReport = report
        context.data.gaps = report.gaps

        callbacks.setProgress(30)
        callbacks.log(report.summary)

        return report.summary
      },
    },
  ]

  // 如果启用自动补全，添加补全步骤
  if (params.autoFill) {
    steps.push({
      name: t('workflow.aiFill'),
      description: t('workflow.verifyAiFillDesc'),
      executor: async (_step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
        const gaps = context.data.gaps as BlueprintGap[]

        if (!gaps || gaps.length === 0) {
          callbacks.log(t('log.noGaps'))
          callbacks.setProgress(100)
          return t('workflow.noGaps')
        }

        const cmd = new FillGapsCommand({ gaps })
        const filled = await cmd.execute({
          step: _step,
          context,
          callbacks,
        })

        context.data.filledBlueprints = filled
        return t('workflow.filledCount').replace('{n}', String(filled.length))
      },
    })
  }

  return {
    type: 'post_process',
    rehydrateParams: { ...params, __subflow: 'verification' },
    title: params.autoFill ? t('workflow.verifyTitle') : t('workflow.verifyTitleOnly'),
    steps,
    onComplete: {
      mode: 'silent',
      message: params.autoFill
        ? t('workflow.verifyDone')
        : t('workflow.verifyDoneOnly'),
    },
  }
}

// 顶层自注册（rehydrate 重建，L2 任务6 修复 round 1）
registerWorkflow('post_process', (p) => createVerificationWorkflow(p as VerificationWorkflowParams), (p) => p.__subflow === 'verification')
