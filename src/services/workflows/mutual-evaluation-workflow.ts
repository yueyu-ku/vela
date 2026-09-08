/**
 * AI 互评工作流 — 多视角并行评审 + 综合评分
 *
 * 流程：
 * 1. 获取草稿内容
 * 2. 多视角评审（3 个 AI 实例并行）
 * 3. 综合评分（聚合 + 共识分析）
 */

import type { WorkflowDefinition, WorkflowStep, WorkflowContext, StepCallbacks } from '../../stores/workflow-store'
import { t } from '../../shared/locale'
import { ipc } from '../ipc-client'
import { SpawnReviewersCommand, type ReviewerOutput } from './commands/spawn-reviewers.command'
import { SynthesizeScoresCommand } from './commands/synthesize-scores.command'
import { registerWorkflow } from './workflow-registry'

export interface MutualEvaluationParams {
  draftId: number
  draftContent: string
  chapterNumber: number
}

export function createMutualEvaluationWorkflow(
  params: MutualEvaluationParams,
): WorkflowDefinition {
  return {
    type: 'post_process',
    rehydrateParams: { ...params },
    title: t('workflow.mutualTitle').replace('{n}', String(params.chapterNumber)),
    steps: [
      {
        name: t('workflow.multiReview'),
        description: t('workflow.mutualReviewDesc'),
        executor: async (_step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
          callbacks.log(t('log.mutualStart').replace('{n}', String(params.chapterNumber)))
          callbacks.log(t('log.mutualPerspectives'))

          const cmd = new SpawnReviewersCommand({
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
          })

          const outputs = await cmd.execute({
            step: _step as never,
            context,
            callbacks,
          })

          context.data.reviewerOutputs = outputs
          return t('workflow.mutualReviewCount').replace('{n}', String(outputs.length))
        },
      },
      {
        name: t('workflow.synthesizeScores'),
        description: t('workflow.synthesizeDesc'),
        executor: async (_step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
          const outputs = context.data.reviewerOutputs as ReviewerOutput[]
          const cmd = new SynthesizeScoresCommand({
            reviewerOutputs: outputs,
            draftId: params.draftId,
            chapterNumber: params.chapterNumber,
          })

          const report = await cmd.execute({
            step: _step as never,
            context,
            callbacks,
          })

          context.data.mutualReviewReport = report

          // 持久化评审结果
          try {
            for (const output of outputs) {
              await ipc.invoke('db:evaluation-create', {
                draftId: params.draftId,
                perspective: output.perspective,
                scores: JSON.stringify(output.scores),
                overallScore: output.overallScore,
                strengths: JSON.stringify(output.strengths),
                weaknesses: JSON.stringify(output.weaknesses),
                suggestions: JSON.stringify(output.suggestions),
                rawResponse: output.rawResponse,
                tokensUsed: output.tokensUsed,
              })
            }
            callbacks.log(t('log.evalSaved'))
          } catch (e) {
            callbacks.log(t('log.evalSaveFailed').replace('{error}', String(e)))
          }

          return t('workflow.synthesizeResult')
            .replace('{score}', String(report.finalScore))
            .replace('{strengths}', String(report.consensusStrengths.length))
            .replace('{weaknesses}', String(report.consensusWeaknesses.length))
        },
      },
    ],
    onComplete: {
      mode: 'open',
      message: t('workflow.mutualDone').replace('{n}', String(params.chapterNumber)),
      openResult: () => {
        import('../../stores/layout-store').then((m) =>
          m.useLayoutStore.getState().openRightPanel('ai-output'),
        ).catch(() => {})
      },
    },
  }
}

// 顶层自注册（rehydrate 重建，L2 任务6）
registerWorkflow('post_process', (p) => createMutualEvaluationWorkflow(p as unknown as MutualEvaluationParams))
