import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { WorkflowCheckpointRepository } from './workflow-checkpoint-repository'

vi.mock('../database', () => ({
  getProjectDb: () => (globalThis as unknown as { __testDb: DatabaseSync }).__testDb,
}))

let db: DatabaseSync
const CREATE = `
  CREATE TABLE workflow_checkpoints (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER DEFAULT (unixepoch() * 1000)
  );
`

beforeAll(() => {
  (globalThis as unknown as { __testDb?: DatabaseSync }).__testDb = undefined
})
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(CREATE)
  ;(globalThis as unknown as { __testDb: DatabaseSync }).__testDb = db
})
afterEach(() => { try { db.close() } catch { /* ignore */ } })

describe('WorkflowCheckpointRepository（checkpoint 单行读写，L2 任务4）', () => {
  it('save → load 读回一致（state_json 字符串往返）', () => {
    const state = JSON.stringify({ activeRuns: [], savedAt: 'x' })
    WorkflowCheckpointRepository.save(state)
    expect(WorkflowCheckpointRepository.load()).toBe(state)
  })
  it('clear 后 load 为 null', () => {
    WorkflowCheckpointRepository.save('{}')
    WorkflowCheckpointRepository.clear()
    expect(WorkflowCheckpointRepository.load()).toBeNull()
  })
  it('save 幂等（同 id=1 覆盖，不产生多行）', () => {
    WorkflowCheckpointRepository.save('{"v":1}')
    WorkflowCheckpointRepository.save('{"v":2}')
    expect(WorkflowCheckpointRepository.load()).toBe('{"v":2}')
    const n = db.prepare(`SELECT count(*) c FROM workflow_checkpoints WHERE id = 1`).get() as { c: number }
    expect(n.c).toBe(1)
  })
  it('getProjectDb 为 null（未开项目）时不抛错', () => {
    (globalThis as unknown as { __testDb: DatabaseSync }).__testDb = null as unknown as DatabaseSync
    expect(() => { WorkflowCheckpointRepository.save('{}'); WorkflowCheckpointRepository.load(); WorkflowCheckpointRepository.clear() }).not.toThrow()
  })
})
