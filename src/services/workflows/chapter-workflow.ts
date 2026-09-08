import type { WorkflowDefinition } from '../../stores/workflow-store'
import type { DraftMeta } from '../draft-index'
import { VELA } from '../vela-protocol'
import { t } from '../../shared/locale'
import { ipc } from '../ipc-client'

import type { DraftStatus } from '../../shared/draft-status'
import { registerWorkflow } from './workflow-registry'

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================
export type { DraftStatus, DraftMeta }

export interface ChapterInfo {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  characters: string[]
  keyEvents: string
  suspenseHook?: string
  userGuidance?: string
  /** 用户自定义知识库检索关键词（追加到向量搜索 query） */
  knowledgeQueryHint?: string
}

export interface RefineOnlyParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  userRefinePrompt?: string
}

export interface RefineFromReviewParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  reviewReport: string
  reviewFileName: string
  userRefinePrompt?: string
}

export interface ReviewOnlyParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  /** 审稿维度侧重点（可选） */
  reviewFocus?: string
}

export interface FinalizeOnlyParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
}

// ==========================================
// 2. 草稿文件工具函数 (供前端 UI 侧调用)
// ==========================================

export function getDraftDir(_projectPath: string, chapterNumber: number): string {
  return `${VELA.DRAFT}ch${chapterNumber}`
}

export function getDraftPath(_projectPath: string, chapterNumber: number, version: number): string {
  return `${VELA.DRAFT}ch${chapterNumber}/v${version}`
}

export async function parseDraftMeta(filePath: string): Promise<DraftMeta | null> {
  const { ipc } = await import('../ipc-client')

  // 优先处理 vela://draft/{id} 纯数字 ID 格式（DB 化后的标准路径）
  const idMatch = filePath.match(/^vela:\/\/(?:draft|manuscript)\/(\d+)$/)
  if (idMatch) {
    const draftId = parseInt(idMatch[1])
    const dbMeta = await ipc.invoke('db:draft-get-meta', draftId)
    if (!dbMeta) return null
    return {
      ...dbMeta,
      status: dbMeta.status as DraftStatus,
      source: dbMeta.source as 'write' | 'rewrite',
      fileName: `draft_v${dbMeta.version}.md`,
      filePath: `${VELA.DRAFT}${dbMeta.id}`,
    } as unknown as DraftMeta
  }

  // 兼容旧格式 draft_v(\d+).md 和 vela://draft/ch{N}/v{V}
  const versionMatch = filePath.match(/v(\d+)(?:\.md)?$/)
  if (!versionMatch) return null
  const version = parseInt(versionMatch[1])

  // 提取章节号
  const chMatch = filePath.match(/ch(\d+)/)
  if (!chMatch) return null
  const chapterNumber = parseInt(chMatch[1])

  const drafts = await ipc.invoke('db:draft-list', chapterNumber)
  const d = (drafts as unknown as Array<Record<string, unknown>>).find((d) => d.version === version)
  return d ? (d as unknown as DraftMeta) : null
}

export async function updateDraftStatus(filePath: string, newStatus: DraftStatus): Promise<void> {
  const meta = await parseDraftMeta(filePath)
  if (meta) {
    const { ipc } = await import('../ipc-client')
    await ipc.invoke('db:draft-update-status', meta.id, newStatus)
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// 将原有的 1500 多行核心面条代码剥离为微内核执行器。
// ==========================================

export function createChapterWorkflow(chapterInfo: ChapterInfo): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflow.writeTitle').replace('{n}', String(chapterInfo.chapterNumber)).replace('{title}', chapterInfo.title),
    steps: [
      {
        name: t('workflow.write'),
        description: t('workflow.writeDesc'),
        executor: async (step, context, callbacks) => {
          const { GenerateDraftCommand } = await import('./commands/generate-draft.command')
          const cmd = new GenerateDraftCommand(chapterInfo)
          return cmd.execute({ step, context, callbacks })
        },
      },
      {
        // 迭代式自省：审计报告 → 终审 Agent 建议清单 → 主 AI 重写 → 再审计（≤2 轮）
        // 容错：终审是增强环节，任何失败不得让整个写稿工作流 failed（初稿已生成）
        name: t('workflow.selfReview'),
        description: t('workflow.selfReviewDesc'),
        executor: async (step, context, callbacks) => {
          try {
            const { SelfReviewCommand } = await import('./commands/self-review.command')
            const latest = await ipc.invoke('db:draft-get-latest', chapterInfo.chapterNumber) as { id?: number } | null
            if (!latest?.id) {
              callbacks.log(t('log.selfReviewSkipped'))
              return
            }
            const cmd = new SelfReviewCommand({
              chapterNumber: chapterInfo.chapterNumber,
              chapterTitle: chapterInfo.title,
              draftId: latest.id,
            })
            await cmd.execute({ step, context, callbacks })
          } catch (e) {
            callbacks.log(t('log.selfReviewFailed').replace('{error}', e instanceof Error ? e.message : String(e)))
          }
        },
      },
    ],
    rehydrateParams: { ...chapterInfo },
    onComplete: { mode: 'open', message: t('workflow.draftDone').replace('{n}', String(chapterInfo.chapterNumber)) },
  }
}

export function createRefineOnlyWorkflow(params: RefineOnlyParams): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflow.polishTitle').replace('{n}', String(params.chapterNumber)).replace('{title}', params.chapterTitle),
    rehydrateParams: { ...params },
    steps: [
      {
        name: t('workflow.polish'),
        description: t('workflow.polishDesc'),
        executor: async (step, context, callbacks) => {
          const { RefineDraftCommand } = await import('./commands/refine-draft.command')
          const cmd = new RefineDraftCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            chapterInfo: { chapterNumber: params.chapterNumber, title: params.chapterTitle, role: '', purpose: '', characters: [], keyEvents: '' },
            userRefinePrompt: params.userRefinePrompt,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', openResult: async () => { } },
  }
}

export function createRefineFromReviewWorkflow(params: RefineFromReviewParams): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflow.reviewFixTitle').replace('{n}', String(params.chapterNumber)).replace('{title}', params.chapterTitle),
    rehydrateParams: { ...params },
    steps: [
      {
        name: t('workflow.reviewFix'),
        description: t('workflow.reviewFixDesc'),
        executor: async (step, context, callbacks) => {
          const { RefineFromReviewCommand } = await import('./commands/refine-from-review.command')
          const cmd = new RefineFromReviewCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            reviewReport: params.reviewReport,
            reviewFileName: params.reviewFileName,
            chapterNumber: params.chapterNumber,
            userRefinePrompt: params.userRefinePrompt,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', openResult: async () => { } },
  }
}

export function createReviewOnlyWorkflow(params: ReviewOnlyParams): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflow.reviewTitle').replace('{n}', String(params.chapterNumber)).replace('{title}', params.chapterTitle),
    rehydrateParams: { ...params },
    steps: [
      {
        name: t('workflow.review'),
        description: t('workflow.reviewDesc'),
        executor: async (step, context, callbacks) => {
          const { ReviewChapterCommand } = await import('./commands/review-chapter.command')
          const cmd = new ReviewChapterCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            reviewFocus: params.reviewFocus,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', message: t('workflow.reviewDone').replace('{n}', String(params.chapterNumber)) },
  }
}

export function createFinalizeWorkflow(params: FinalizeOnlyParams): WorkflowDefinition {
  const chapterInfo = { chapterNumber: params.chapterNumber, title: params.chapterTitle, role: '', purpose: '', characters: [], keyEvents: '' }
  return {
    type: 'chapter_creation',
    title: t('workflow.finalizeTitle').replace('{n}', String(params.chapterNumber)).replace('{title}', params.chapterTitle),
    rehydrateParams: { ...params },
    steps: [
      {
        name: t('workflow.finalize'),
        description: t('workflow.finalizeDesc'),
        executor: async (step, context, callbacks) => {
          const { FinalizeChapterCommand } = await import('./commands/finalize-chapter.command')
          const cmd = new FinalizeChapterCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            chapterInfo,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: {
      mode: 'open', message: t('workflow.finalized').replace('{n}', String(params.chapterNumber)), openResult: async () => {
        const { useEditorStore } = await import('../../stores/editor-store')
        const { useProjectStore } = await import('../../stores/project-store')
        const project = useProjectStore.getState().currentProject
        if (!project) return
        const { ipc } = await import('../ipc-client')
        const draftMeta = await ipc.invoke('db:draft-get-finalized', params.chapterNumber)
        if (draftMeta) {
          const fullContent = await ipc.invoke('db:draft-get-full', draftMeta.id)
          // 从数据库蓝图读取正式标题
          let displayTitle = params.chapterTitle
          try {
            const bp = await ipc.invoke('db:blueprint-get', params.chapterNumber)
            if (bp?.title) displayTitle = bp.title
          } catch (e) {
            console.warn('[chapter-workflow] 蓝图标题读取失败，回退使用章节参数:', e)
          }
          const dbPath = `${VELA.MANUSCRIPT}${draftMeta.id}`
          useEditorStore.getState().openFile({
            id: dbPath,
            name: t('workflow.chapterTitle')
              .replace('{n}', String(params.chapterNumber))
              .replace('{title}', displayTitle),
            type: 'chapter',
            filePath: dbPath,
            content: fullContent?.content || '',
          })
        }
      }
    },
  }
}

/**
 * 修复定稿后处理工作流 — 当定稿后的三路推演失败时可重跑
 * 从 manuscript/ 读取已定稿内容，重新执行 FinalizeChapterCommand 的后处理部分
 */
export function createRepairFinalizeWorkflow(chapterNumber: number): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflow.repairTitle').replace('{n}', String(chapterNumber)),
    rehydrateParams: { chapterNumber },
    steps: [
      {
        name: t('workflow.repair'),
        description: t('workflow.repairDesc'),
        executor: async (_step, _context, callbacks) => {
          const { useProjectStore } = await import('../../stores/project-store')
          const { ipc } = await import('../ipc-client')
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error(t('error.noProject'))

          // 使用数据库定稿源
          const draftMeta = await ipc.invoke('db:draft-get-finalized', chapterNumber)
          if (!draftMeta) throw new Error(t('error.chapterFinalizeMissing').replace('{n}', String(chapterNumber)))
          const full = await ipc.invoke('db:draft-get-full', draftMeta.id)
          if (!full) throw new Error(t('error.chapterContentFetch').replace('{id}', String(draftMeta.id)))

          // 从数据库蓝图读取正式标题
          let chapterTitle = `第${chapterNumber}章`
          try {
            const bp = await ipc.invoke('db:blueprint-get', chapterNumber)
            if (bp?.title) chapterTitle = bp.title
          } catch { /* 蓝图读取失败时使用默认标题 */ }

          // 构建后处理步骤并以修复模式执行（跳过已成功的步骤）
          const { buildFinalizePostProcessSteps } = await import('./commands/finalize-chapter.command')
          const { runPostProcessPipeline, getChapterFinalizeScope } = await import('./workflow-utils')
          const scope = getChapterFinalizeScope(chapterNumber)
          const steps = buildFinalizePostProcessSteps(project, chapterNumber, chapterTitle, full.content)

          await runPostProcessPipeline(project.path, scope, t('workflow.chapterFinalizeSource').replace('{n}', String(chapterNumber)), steps, callbacks, { onlyFailed: true })

          // 通知刷新：定稿改变了草稿状态/正式稿列表/角色卡/文件树——用 'all' 全刷
          // （FINALIZE_COMPLETE 供 project-service 刷新草稿+角色+文件树，
          //   REFRESH_RESOURCE 供工作台/知识库等组件重载各自数据）
          const { globalEventBus } = await import('../../shared/event-bus')
          globalEventBus.emit('FINALIZE_COMPLETE', { chapterNumber })
          globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
        },
      },
    ],
    onComplete: { mode: 'open', message: t('workflow.postProcessFix').replace('{n}', String(chapterNumber)) },
  }
}

// ===== 顶层自注册（rehydrate 重建，L2 任务6）=====
// 6 个工厂都产出 type 'chapter_creation'，registry 按 type 单工厂映射——最后注册的
// createChapterWorkflow（写稿主流程）对这个 type 生效；其余 5 个子流程注册但被同 type 覆盖。
registerWorkflow('chapter_creation', (p) => createRefineOnlyWorkflow(p as unknown as RefineOnlyParams))
registerWorkflow('chapter_creation', (p) => createRefineFromReviewWorkflow(p as unknown as RefineFromReviewParams))
registerWorkflow('chapter_creation', (p) => createReviewOnlyWorkflow(p as unknown as ReviewOnlyParams))
registerWorkflow('chapter_creation', (p) => createFinalizeWorkflow(p as unknown as FinalizeOnlyParams))
registerWorkflow('chapter_creation', (p) => createRepairFinalizeWorkflow((p as { chapterNumber: number }).chapterNumber))
registerWorkflow('chapter_creation', (p) => createChapterWorkflow(p as unknown as ChapterInfo))
