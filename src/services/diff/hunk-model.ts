/**
 * hunk-model — inline 会话 hunk 状态机类型与组级聚合辅助（L1 Task 2）
 *
 * 纯类型 + 纯函数，无运行时依赖（除 type import）。会话形态为 editor-store
 * 可 JSON 序列化的 DiffSession；decisions 是决策表（subHunkId →
 * accepted|rejected，pending 为缺省），SessionHunk.decision 为组级聚合——
 * updateHunkDecision 的单写路径（Task 3）同步两者，本模块只提供推导/统计。
 *
 * v1 语义（与 Task 2 模块头注释/测试共同锁定）：
 * - 子 hunk 决策 = 原子裁决单位（接受/拒绝只作用 changed run，锚句不进子 hunk）；
 * - 全组同向 → 组级 accepted/rejected，混合或缺省 → pending（组级未定）。
 */
import type { AlignOp } from './paragraph-align'

export interface SubHunk {
  id: string
  parentId: string
  origRange: { from: number; to: number }
  origText: string
  modText: string
}
export type HunkDecision = 'pending' | 'accepted' | 'rejected'
export interface SessionHunk {
  id: string
  kind: AlignOp
  modText: string
  sub: SubHunk[]
  decision: HunkDecision
}
/** editor-store 持久化形态（JSON 可序列化；doc 文本不进决策表，仅存 baseDocSnapshot 作定位锚） */
export interface DiffSession {
  sessionId: string
  revisionId?: number
  sourceKind: 'selection' | 'revision'
  baseDocSnapshot: string
  hunks: SessionHunk[]
  /** 决策表：subHunkId → accepted|rejected（pending = 缺省） */
  decisions: Record<string, Exclude<HunkDecision, 'pending'>>
}

/** 由 decisions 推导组级聚合（updateHunkDecision 的单写路径调用，Task 3 复用） */
export function aggregateDecision(sub: SubHunk[], decisions: Record<string, Exclude<HunkDecision, 'pending'>>): HunkDecision {
  if (sub.length === 0) return 'pending'
  let accepted = 0
  let rejected = 0
  for (const s of sub) {
    const d = decisions[s.id]
    if (d === 'accepted') accepted++
    else if (d === 'rejected') rejected++
  }
  if (accepted === sub.length) return 'accepted'
  if (rejected === sub.length) return 'rejected'
  return 'pending'
}

/** 统计已接受子 hunk 数（浮条进度用，Task 4 消费） */
export function countAccepted(session: DiffSession): number {
  return session.hunks.reduce((n, h) => n + h.sub.filter(s => session.decisions[s.id] === 'accepted').length, 0)
}
export function countSubHunks(session: DiffSession): number {
  return session.hunks.reduce((n, h) => n + h.sub.length, 0)
}

/** 统计未决（pending，决策表无记录）子 hunk 数——关闭/退出会话的二次确认依据
 *  （M-4 收口：Tab 级关闭与浮条 closeSession 共用同一未决口径；rejected 已裁决不计入） */
export function countUndecided(session: DiffSession | undefined): number {
  if (!session) return 0
  return session.hunks.reduce(
    (n, h) => n + h.sub.filter(s => !session.decisions[s.id]).length,
    0,
  )
}
