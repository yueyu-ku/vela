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

describe('workflow rehydrate（重建 definition，L2 任务6）', () => {
  const table: Array<[string, Record<string, unknown>]> = [
    ['architecture_generation', { selectedSteps: ['premise', 'synopsis'], stepGuidance: { premise: 'x' } }],
    ['chapter_creation', { chapterNumber: 3, title: 't', role: 'r', purpose: 'p', characters: ['c'], keyEvents: '' }],
    ['directory', { mode: 'full' }],
    ['novel_import', { chapters: [{ number: 1, title: 'a', content: 'c', wordCount: 1 }] }],
    ['post_process', { draftId: 9, draftContent: 'c', chapterNumber: 3 }],  // mutual-eval
    ['post_process', { autoFill: false }],  // verification
  ]
  for (const [type, params] of table) {
    it(`${type}: rehydrateWorkflow 重建出 definition 且 steps 非空`, () => {
      const def = rehydrateWorkflow(type as never, params)
      expect(def).toBeTruthy()
      expect(def!.type).toBe(type)
      expect(def!.steps.length).toBeGreaterThan(0)
      expect(def!.steps.every(s => typeof s.executor === 'function')).toBe(true)
    })
  }
  it('config_generation（params 含 onGenerated 回调）不注册 → null（恢复走兜底）', () => {
    expect(rehydrateWorkflow('config_generation' as never, { idea: 'x', totalChapters: 10, wordsPerChapter: 3000 })).toBeNull()
  })
  it('§5.2 三内联重构为工厂后可重建（post_process 存档类）', () => {
    // character-archive / arch-character-extract / repair-arch-character-cards 三个 post_process 工厂
    expect(rehydrateWorkflow('post_process' as never, { projectPath: '/x', nameFilter: undefined })).toBeTruthy()
    expect(rehydrateWorkflow('post_process' as never, { projectPath: '/x', characterDynamicsContent: 'c', genre: 'g' })).toBeTruthy()
    expect(rehydrateWorkflow('post_process' as never, { projectPath: '/x' })).toBeTruthy()
  })
})
