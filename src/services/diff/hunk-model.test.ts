/**
 * hunk-model — 会话内 hunk 决策状态机纯函数测试（L1 Task 2）
 *
 * 覆盖：aggregateDecision 组级聚合推导（空 sub / 全 accepted / 全 rejected /
 * 混合 / 决策缺省=按 pending 计）；countAccepted / countSubHunks 统计
 * （浮条 n/m 进度数据源，Task 4 消费）。decisions 是决策表（subHunkId →
 * accepted|rejected，pending 为缺省），SessionHunk.decision 由其推导——
 * updateHunkDecision 的单写同步路径属 Task 3，此处只锁推导/统计函数本身。
 */
import { describe, it, expect } from 'vitest'
import { aggregateDecision, countAccepted, countSubHunks, countUndecided } from './hunk-model'
import type { DiffSession, HunkDecision, SessionHunk, SubHunk } from './hunk-model'

const mkSub = (id: string, parentId = 'h0'): SubHunk => ({
  id, parentId,
  origRange: { from: 0, to: 0 }, origText: '', modText: '',
})

const mkSession = (
  hunks: SessionHunk[],
  decisions: Record<string, Exclude<HunkDecision, 'pending'>>,
): DiffSession => ({
  sessionId: 'sess-1',
  sourceKind: 'selection',
  baseDocSnapshot: '',
  hunks, decisions,
})

describe('aggregateDecision（组级聚合：pending = 缺省，设计 §4.2/§4.4）', () => {
  it('空 sub → pending', () => {
    expect(aggregateDecision([], {})).toBe('pending')
  })
  it('sub 全 accepted → accepted', () => {
    const subs = [mkSub('a'), mkSub('b')]
    expect(aggregateDecision(subs, { a: 'accepted', b: 'accepted' })).toBe('accepted')
  })
  it('sub 全 rejected → rejected', () => {
    const subs = [mkSub('a'), mkSub('b')]
    expect(aggregateDecision(subs, { a: 'rejected', b: 'rejected' })).toBe('rejected')
  })
  it('accepted/rejected 混合 → pending（组级未定，不拦全组）', () => {
    const subs = [mkSub('a'), mkSub('b'), mkSub('c')]
    expect(aggregateDecision(subs, { a: 'accepted', b: 'rejected' })).toBe('pending')
  })
  it('部分已决、部分缺省 → pending（缺省决策按 pending 计）', () => {
    const subs = [mkSub('a'), mkSub('b')]
    expect(aggregateDecision(subs, { a: 'accepted' })).toBe('pending')
  })
  it('sub 有 id 但 decisions 无该记录（决策表被清/未建）→ pending', () => {
    const subs = [mkSub('ghost')]
    expect(aggregateDecision(subs, {})).toBe('pending')
  })
})

describe('countAccepted / countSubHunks（浮条 n/m 进度数据源，Task 4）', () => {
  it('countAccepted 跨 hunk 汇总 accepted，缺省/rejected 不计', () => {
    const session = mkSession([
      { id: 'h0', kind: 'MATCH', modText: '', sub: [mkSub('a1', 'h0'), mkSub('a2', 'h0')], decision: 'pending' },
      { id: 'h1', kind: 'MATCH', modText: '', sub: [mkSub('b1', 'h1')], decision: 'pending' },
    ], { a1: 'accepted', a2: 'rejected', b1: 'accepted' })
    expect(countAccepted(session)).toBe(2)
  })
  it('countSubHunks = 全 hunk sub 总数；空 hunks → 0', () => {
    const session = mkSession([
      { id: 'h0', kind: 'MATCH', modText: '', sub: [mkSub('a1', 'h0'), mkSub('a2', 'h0')], decision: 'pending' },
      { id: 'h1', kind: 'MATCH', modText: '', sub: [], decision: 'pending' },
    ], {})
    expect(countSubHunks(session)).toBe(2)
    expect(countSubHunks(mkSession([], {}))).toBe(0)
  })
  it('countUndecided = 决策表无记录（pending）子句数；rejected/accepted 不计；undefined → 0（M-4 关闭确认口径）', () => {
    const session = mkSession([
      { id: 'h0', kind: 'MATCH', modText: '', sub: [mkSub('a1', 'h0'), mkSub('a2', 'h0')], decision: 'pending' },
      { id: 'h1', kind: 'MATCH', modText: '', sub: [mkSub('b1', 'h1'), mkSub('b2', 'h1')], decision: 'pending' },
    ], { a1: 'accepted', b1: 'rejected' })
    expect(countUndecided(session)).toBe(2) // a2、b2 未决；a1 accepted / b1 rejected 不计
    expect(countUndecided(mkSession([], {}))).toBe(0)
  })
})
