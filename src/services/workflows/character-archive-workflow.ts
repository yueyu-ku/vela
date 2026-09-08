// src/services/workflows/character-archive-workflow.ts
import { ipc } from '../ipc-client'
import { t } from '../../shared/locale'
import { useLLMStore } from '../../stores/llm-store'
import { getPromptTemplate } from '../prompt-templates'
import { PostProcessPromptBuilder } from '../prompts/prompt-builder'
import {
  extractRoleContextSegments,
  hasBlankArchiveFields,
  parseBatchArchiveJson,
  type ChapterContent,
  type RoleContextSegment,
} from '../character-archive'
import { parseAliases } from '../character-normalize'
import { runPostProcessPipeline, readPostProcessStatus, getFailedStepLabels, type PostProcessStep } from './workflow-utils'
import { registerWorkflow } from './workflow-registry'
import type { StepCallbacks, WorkflowDefinition } from '../../stores/workflow-store'
import type { CharacterData } from '../../../electron/repositories/character-repository'

/**
 * 定稿正文 → 角色档案 工作流（P1-3 批量提取 + 断点续跑版）
 *
 * 与旧实现（逐角色串行 LLM 调用、无持久化）的差异：
 * 1. 批量提取：每批 ARCHIVE_BATCH_SIZE 个角色共享一次 LLM 调用（新模板
 *    extract_from_finalized_batch，按角色分节输入），调用次数降为 1/批大小；
 * 2. 断点续跑：接入 runPostProcessPipeline（post_process_runs/steps 落库 +
 *    withRetry 批次重试）；mergeFields 只填空语义保证天然幂等——
 *    已完成角色不再 pending，失败批次中的角色下次运行自动重试；
 * 3. 批次步骤串行（dependsOn 链），每批独立记录 ok/failed 状态，失败不阻断后续批次。
 */

/** 档案提取后处理 scope（post_process_runs 溯源标识） */
export const ARCHIVE_SCOPE = 'archive_characters'

/** 批大小（默认 4：4 角色 × 3 段 ≈ 7-10k token/次调用） */
export const ARCHIVE_BATCH_SIZE = 4
/** 批量模式的上下文窗口（比单角色模式小——多角色共享 token 预算） */
export const ARCHIVE_BATCH_WINDOW_CHARS = 600
/** 批量模式每角色最大段数 */
export const ARCHIVE_BATCH_MAX_SEGMENTS = 3

/** 单次 LLM 流式调用（JSON 模式；流式内容同步到 AI 输出面板） */
async function callLLMForArchive(builder: { build: () => string; getSystemRole: () => string }, callbacks: StepCallbacks): Promise<string> {
  const llmStore = useLLMStore.getState()
  if (!llmStore.defaultModelId) throw new Error(t('error.noDefaultModel'))
  let full = ''
  await new Promise<void>((resolve, reject) => {
    llmStore.generateStream(
      [
        { role: 'system', content: builder.getSystemRole() },
        { role: 'user', content: builder.build() },
      ],
      { onChunk: c => { full += c; callbacks.appendText(c) }, onDone: () => resolve(), onError: e => reject(new Error(e)) },
      undefined,
      { responseFormat: { type: 'json_object' } },
    )
  })
  return full
}

/** 批量提取一批角色的档案（写库走 mergeFields 只填空，单角色失败不阻断整批） */
async function extractBatch(
  batch: CharacterData[],
  chapters: ChapterContent[],
  registryNames: string[],
  callbacks: StepCallbacks,
): Promise<void> {
  // 1. 逐角色抽取上下文（批量模式缩减窗口/段数预算，别名+前缀碰撞过滤）
  const items: Array<{ char: CharacterData; segments: RoleContextSegment[] }> = []
  for (const char of batch) {
    const segments = extractRoleContextSegments(chapters, char.name, {
      aliases: parseAliases(char.aliases),
      registryNames,
      windowChars: ARCHIVE_BATCH_WINDOW_CHARS,
      maxSegments: ARCHIVE_BATCH_MAX_SEGMENTS,
    })
    if (segments.length === 0) {
      callbacks.log(t('log.archiveNoMention').replace('{name}', char.name))
      continue
    }
    items.push({ char, segments })
  }
  if (items.length === 0) return // 本批无任何命中 → 无可提取内容，静默成功

  // 2. 组装批量 prompt（每角色一节）
  const template = getPromptTemplate('extract_from_finalized_batch')
  if (!template) throw new Error(t('error.templateNotFound').replace('{name}', 'extract_from_finalized_batch'))
  const segText = items.map(({ char, segments }) =>
    `【角色：${char.name}】\n` +
    segments.map(s => `[第${s.chapterNumber}章]\n${s.text}`).join('\n\n---\n\n')
  ).join('\n\n=====\n\n')
  const builder = new PostProcessPromptBuilder(template).withCharactersSegments(segText)

  // 3. 一次 LLM 调用提取整批
  const raw = await callLLMForArchive(builder, callbacks)
  const results = parseBatchArchiveJson(raw, items.map(i => i.char))

  // 4. 逐角色写库（仅填空）
  let okCount = 0
  for (const item of results) {
    if (item.archive === null) {
      callbacks.log(t('log.archiveParseFailed').replace('{name}', item.name))
      continue
    }
    try {
      const result = await ipc.invoke('db:character-merge-fields', item.name, item.archive)
      if (!result.success) {
        callbacks.log(t('log.archiveCharFailed').replace('{name}', item.name).replace('{error}', () => result.error || String(result)))
        continue
      }
      okCount++
      callbacks.log(t('log.archiveDone').replace('{name}', item.name))
    } catch (e) {
      callbacks.log(t('log.archiveCharFailed').replace('{name}', item.name).replace('{error}', () => String(e)))
    }
  }

  // 整批全失败 → 抛出触发批次重试（withRetry）；部分成功不抛（失败角色下次运行自动重试）
  if (okCount === 0 && results.length > 0) {
    throw new Error(t('log.archiveFailedSummary').replace('{n}', String(results.length)))
  }
}

export interface CharacterArchiveWorkflowParams {
  projectPath: string
  nameFilter?: string
}

/** 定稿正文 → 角色档案 工作流定义工厂（可 rehydrate；§5.2 由 runCharacterArchive 重构而来） */
export function createCharacterArchiveWorkflow(params: CharacterArchiveWorkflowParams): WorkflowDefinition {
  const { projectPath, nameFilter } = params
  return {
    type: 'post_process',
    title: t('workflow.archiveTitle'),
    rehydrateParams: { projectPath, nameFilter },
    steps: [{
      name: t('workflow.archiveSteps'),
      description: t('workflow.archiveStepsDesc'),
      executor: async (_step, _ctx, callbacks) => {
        const allChars = (await ipc.invoke('db:character-get-all')) as unknown as CharacterData[]
        const targets = nameFilter ? allChars.filter(c => c.name === nameFilter) : allChars
        const pending = targets.filter(c => hasBlankArchiveFields(c as unknown as Record<string, unknown>))
        const skipped = targets.length - pending.length
        if (skipped > 0) {
          callbacks.log(t('log.archiveSkipped').replace('{n}', String(skipped)))
        }
        if (pending.length === 0) {
          callbacks.log(t('log.archiveAllComplete'))
          return
        }
        callbacks.log(t('log.archiveStart').replace('{n}', String(pending.length)))

        // 全部定稿章节正文（draft-get-finalized 仅返回 meta，正文经 draft-get-full 按 id 补取）
        const chapterNumbers = (await ipc.invoke('db:draft-get-all-chapter-numbers')) as number[]
        const chapters: ChapterContent[] = []
        for (const n of [...chapterNumbers].sort((a, b) => a - b)) {
          const meta = await ipc.invoke('db:draft-get-finalized', n) as { id: number; content?: string } | null
          if (!meta) continue
          const full = await ipc.invoke('db:draft-get-full', meta.id) as { content?: string } | null
          if (full?.content) chapters.push({ chapterNumber: n, content: full.content })
        }
        if (chapters.length === 0) throw new Error(t('error.noFinalizedChapters'))

        // 全角色注册名（前缀碰撞过滤）
        const registryNames = allChars.map(c => c.name).filter(Boolean)

        // 分批构建管线步骤（dependsOn 链 → 串行；critical=false → 批次失败不阻断后续）
        const batchSteps: PostProcessStep[] = []
        for (let i = 0; i < pending.length; i += ARCHIVE_BATCH_SIZE) {
          const batch = pending.slice(i, i + ARCHIVE_BATCH_SIZE)
          const batchNo = i / ARCHIVE_BATCH_SIZE + 1
          const total = Math.ceil(pending.length / ARCHIVE_BATCH_SIZE)
          batchSteps.push({
            key: `archive_batch_${batchNo}`,
            label: t('workflow.archiveBatch').replace('{n}', String(batchNo)).replace('{total}', String(total)),
            critical: false,
            dependsOn: batchNo > 1 ? [`archive_batch_${batchNo - 1}`] : [],
            executor: async (cb) => { await extractBatch(batch, chapters, registryNames, cb) },
          })
        }

        // 接入后处理管线：run 落库 + 每批重试 2 次 + 失败标记
        await runPostProcessPipeline(projectPath, ARCHIVE_SCOPE, t('workflow.archiveTitle'), batchSteps, callbacks, {
          retryCount: 2,
        })

        // 失败批次汇总日志（可诊断：失败角色仍在 pending，下次运行自动重试）
        const status = await readPostProcessStatus(projectPath, ARCHIVE_SCOPE)
        if (status) {
          const failedLabels = getFailedStepLabels(status)
          if (failedLabels.length > 0) {
            callbacks.log(t('log.archiveFailedSummary').replace('{n}', String(failedLabels.length)))
          }
        }

        // 刷新角色卡（定稿档案写入后各面板重载角色数据）
        const { globalEventBus } = await import('../../shared/event-bus')
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['characterCards'] })
      },
    }],
  }
}

/**
 * 定稿正文 → 角色档案 工作流启动入口（fire-and-forget；§5.2 重构后仍保持原调用签名）
 * 现为薄包装：UI 调用点不变，行为经 createCharacterArchiveWorkflow 工厂重建，可 rehydrate。
 */
export function runCharacterArchive(projectPath: string, nameFilter?: string): void {
  import('../../stores/workflow-store').then(async ({ useWorkflowStore }) => {
    await useWorkflowStore.getState().startWorkflow(createCharacterArchiveWorkflow({ projectPath, nameFilter }))
  })
}

// 顶层自注册（rehydrate 重建，L2 任务6）：文件 lazy import 时触发注册
registerWorkflow('post_process', (p) => createCharacterArchiveWorkflow(p as unknown as CharacterArchiveWorkflowParams))
