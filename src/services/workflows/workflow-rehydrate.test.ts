import { describe, it, expect } from 'vitest'
import { rehydrateWorkflow } from './workflow-registry'
// 触发所有自注册
import './architecture-workflow'
import './chapter-workflow'
import './directory-workflow'
import './import-workflow'
import './mutual-evaluation-workflow'
import './verification-workflow'
import './character-archive-workflow'
import { createArchitectureWorkflow, createArchCharacterExtractWorkflow, createRepairArchCharacterCardsWorkflow, type ArchitectureWorkflowParams, type ArchCharacterExtractWorkflowParams, type RepairArchCharacterCardsWorkflowParams } from './architecture-workflow'
import { createChapterWorkflow, createRefineOnlyWorkflow, createRefineFromReviewWorkflow, createReviewOnlyWorkflow, createFinalizeWorkflow, createRepairFinalizeWorkflow, type ChapterInfo, type RefineOnlyParams, type RefineFromReviewParams, type ReviewOnlyParams, type FinalizeOnlyParams } from './chapter-workflow'
import { createDirectoryWorkflow, type DirectoryWorkflowParams } from './directory-workflow'
import { createImportWorkflow, type ImportWorkflowParams } from './import-workflow'
import { createMutualEvaluationWorkflow, type MutualEvaluationParams } from './mutual-evaluation-workflow'
import { createVerificationWorkflow, type VerificationWorkflowParams } from './verification-workflow'
import { createCharacterArchiveWorkflow, type CharacterArchiveWorkflowParams } from './character-archive-workflow'
import type { WorkflowDefinition } from '../../stores/workflow-store'

/** 校验 rehydrateWorkflow(type, params) 重建出的 steps 名称与直接调用 create*XxxWorkflow 完全一致（数量+名称）。 */
function expectSameSteps(via: WorkflowDefinition | null, direct: WorkflowDefinition): void {
  expect(via).toBeTruthy()
  expect(via!.type).toBe(direct.type)
  expect(via!.steps.map(s => s.name)).toEqual(direct.steps.map(s => s.name))
}

describe('workflow rehydrate（重建 definition，L2 任务6 修复 round 1）', () => {
  it('architecture_generation：rehydrate 重建 steps 与 createArchitectureWorkflow 一致', () => {
    const params = { selectedSteps: ['premise', 'synopsis'] as const, stepGuidance: { premise: 'x' } }
    expectSameSteps(rehydrateWorkflow('architecture_generation', params), createArchitectureWorkflow(params as unknown as ArchitectureWorkflowParams))
  })

  it('directory：rehydrate 重建 steps 与 createDirectoryWorkflow 一致', () => {
    const params = { mode: 'full' }
    expectSameSteps(rehydrateWorkflow('directory', params), createDirectoryWorkflow(params as unknown as DirectoryWorkflowParams))
  })

  it('novel_import：rehydrate 重建 steps 与 createImportWorkflow 一致', () => {
    const params = { chapters: [{ number: 1, title: 'a', content: 'c', wordCount: 1 }] }
    expectSameSteps(rehydrateWorkflow('novel_import', params), createImportWorkflow(params as unknown as ImportWorkflowParams))
  })

  it('chapter_creation 写稿（兜底，无 __subflow）→ createChapterWorkflow', () => {
    const params: Record<string, unknown> = { chapterNumber: 3, title: 't', role: 'r', purpose: 'p', characters: ['c'], keyEvents: '' }
    expectSameSteps(rehydrateWorkflow('chapter_creation', params), createChapterWorkflow(params as unknown as ChapterInfo))
  })

  it('chapter_creation refine_from_review：__subflow 判别 → createRefineFromReviewWorkflow', () => {
    const params: Record<string, unknown> = { chapterNumber: 3, chapterTitle: 't', draftPath: 'v', draftContent: 'c', reviewReport: 'r', reviewFileName: 'f', __subflow: 'refine_from_review' }
    expectSameSteps(rehydrateWorkflow('chapter_creation', params), createRefineFromReviewWorkflow(params as unknown as RefineFromReviewParams))
  })

  it('chapter_creation review-only：__subflow 判别 → createReviewOnlyWorkflow', () => {
    const params: Record<string, unknown> = { chapterNumber: 3, chapterTitle: 't', draftPath: 'v', draftContent: 'c', reviewFocus: 'x', __subflow: 'review' }
    expectSameSteps(rehydrateWorkflow('chapter_creation', params), createReviewOnlyWorkflow(params as unknown as ReviewOnlyParams))
  })

  it('chapter_creation finalize：__subflow 判别 → createFinalizeWorkflow', () => {
    const params: Record<string, unknown> = { chapterNumber: 3, chapterTitle: 't', draftPath: 'v', draftContent: 'c', __subflow: 'finalize' }
    expectSameSteps(rehydrateWorkflow('chapter_creation', params), createFinalizeWorkflow(params as unknown as FinalizeOnlyParams))
  })

  it('chapter_creation refine-only：__subflow 判别 → createRefineOnlyWorkflow', () => {
    const params: Record<string, unknown> = { chapterNumber: 3, chapterTitle: 't', draftPath: 'v', draftContent: 'c', __subflow: 'refine' }
    expectSameSteps(rehydrateWorkflow('chapter_creation', params), createRefineOnlyWorkflow(params as unknown as RefineOnlyParams))
  })

  it('chapter_creation repair-finalize：__subflow 判别 → createRepairFinalizeWorkflow', () => {
    const params: Record<string, unknown> = { chapterNumber: 3, __subflow: 'repair_finalize' }
    expectSameSteps(rehydrateWorkflow('chapter_creation', params), createRepairFinalizeWorkflow(params.chapterNumber as number))
  })

  it('post_process mutual-eval：__subflow 判别 → createMutualEvaluationWorkflow', () => {
    const params: Record<string, unknown> = { draftId: 9, draftContent: 'c', chapterNumber: 3, __subflow: 'mutual_eval' }
    expectSameSteps(rehydrateWorkflow('post_process', params), createMutualEvaluationWorkflow(params as unknown as MutualEvaluationParams))
  })

  it('post_process verification：__subflow 判别 → createVerificationWorkflow', () => {
    const params: Record<string, unknown> = { autoFill: false, __subflow: 'verification' }
    expectSameSteps(rehydrateWorkflow('post_process', params), createVerificationWorkflow(params as unknown as VerificationWorkflowParams))
  })

  it('post_process arch-extract：__subflow 判别 → createArchCharacterExtractWorkflow', () => {
    const params: Record<string, unknown> = { projectPath: '/x', characterDynamicsContent: 'c', genre: 'g', __subflow: 'arch_extract' }
    expectSameSteps(rehydrateWorkflow('post_process', params), createArchCharacterExtractWorkflow(params as unknown as ArchCharacterExtractWorkflowParams))
  })

  it('post_process repair-cards：__subflow 判别 → createRepairArchCharacterCardsWorkflow', () => {
    const params: Record<string, unknown> = { projectPath: '/x', __subflow: 'repair_cards' }
    expectSameSteps(rehydrateWorkflow('post_process', params), createRepairArchCharacterCardsWorkflow(params as unknown as RepairArchCharacterCardsWorkflowParams))
  })

  it('post_process archive（character-archive）：__subflow 判别 → createCharacterArchiveWorkflow', () => {
    const params: Record<string, unknown> = { projectPath: '/x', nameFilter: undefined, __subflow: 'archive' }
    expectSameSteps(rehydrateWorkflow('post_process', params), createCharacterArchiveWorkflow(params as unknown as CharacterArchiveWorkflowParams))
  })

  it('config_generation（params 含 onGenerated 回调）不注册 → null（恢复走兜底）', () => {
    expect(rehydrateWorkflow('config_generation', { idea: 'x', totalChapters: 10, wordsPerChapter: 3000 })).toBeNull()
  })

  it('未识别的 __subflow（无匹配）→ null（干净降级，不误重建）', () => {
    // post_process 无兜底工厂：未知子流键不应命中任何工厂
    expect(rehydrateWorkflow('post_process', { projectPath: '/x' })).toBeNull()
    expect(rehydrateWorkflow('post_process', { autoFill: false })).toBeNull()
  })
})
