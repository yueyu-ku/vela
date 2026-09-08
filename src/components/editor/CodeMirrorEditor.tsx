import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import CodeMirror, { ReactCodeMirrorRef, EditorView, ViewUpdate } from '@uiw/react-codemirror'
import { keymap } from '@codemirror/view'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState, Transaction } from '@codemirror/state'
import { openSearchPanel, closeSearchPanel, search } from '@codemirror/search'
import { history, historyKeymap, undo, redo } from '@codemirror/commands'
import { Sparkles, Bold, Undo2, Redo2, Share2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useTranslation } from '../../hooks/useTranslation'
import { computeTextStats } from '../../services/text-stats'
import { buildSelectionSession } from '../../services/diff/selection-session'
import { extractPreferencePair, recordPreference } from '../../services/preferences'
import { useEditorStore } from '../../stores/editor-store'
import {
  INLINE_ACCEPT_EVENT,
  changesIntersectRanges,
  deriveRangesFromDoc,
  dispatchAcceptChange,
  findRestorableRangeAt,
  inlineAcceptExtensions,
  inlineAcceptField,
  isManualUserEdit,
  setHunkRanges,
} from './codemirror-inline-accept'
import { countUndecided, type SubHunk } from '../../services/diff/hunk-model'
import { InlineAcceptBar } from './InlineAcceptBar'
import { InlineAcceptPopover } from './InlineAcceptPopover'
import './inline-accept.css'

/** 统计字数（简单字符数统计，包含空格换行等格式符） */
function countWords(text: string): number {
  return text.length
}

export type CodeMirrorEditorProps = {
  content: string
  filePath?: string
  editable?: boolean
  onChange?: (content: string) => void
  onSave?: (content: string) => Promise<void> | void
  onCharCountChange?: (count: number) => void
  placeholder?: string
  hideStatusBar?: boolean
  mode?: 'document' | 'prose'
}

/** AI 段落改写操作 — 接入 RefineParagraphsCommand 的 5 种模式 */
const AI_ACTION_KEYS = ['polish', 'expand', 'shrink', 'style', 'conflict'] as const

function getAIActions(t: (key: string) => string) {
  const labelKeys: Record<string, string> = {
    polish: 'ai.polish', expand: 'ai.expand', shrink: 'ai.shrink', style: 'ai.style', conflict: 'ai.conflict',
  }
  const prompts: Record<string, string> = {
    polish: t('ai.prompt.polish'), expand: t('ai.prompt.expand'), shrink: t('ai.prompt.shrink'), style: t('ai.prompt.style'), conflict: t('ai.prompt.conflict'),
  }
  const colors: Record<string, string> = {
    polish: 'text-blue-400', expand: 'text-amber-400', shrink: 'text-purple-400', style: 'text-emerald-400', conflict: 'text-rose-400',
  }
  return AI_ACTION_KEYS.map(k => ({ key: k, label: t(labelKeys[k]), color: colors[k], prompt: prompts[k] }))
}

/* eslint-disable react-refresh/only-export-components */
/**
 * A 收尾落库（Task 5，设计 §4.5 A 来源；白盒导出供 CodeMirrorEditor.inline.test 断言调用序列）。
 * 语义：会话「完成」（浮条 onFinish）→ 仅 vela://draft 且会话有 accepted 时创建 refine revision：
 *   1. R9 修复（现状气泡无 pending 清理 → 反复累积缺陷）：先按 refine-draft.command.ts:88-92
 *      语义清理该草稿既有 pending refine revision，保证同一草稿只留最新一条；
 *   2. db:revision-create（content = 会话最终 doc 实况、userPrompt 带动作标签）——
 *      已接受内容以 doc 为准（doc 是唯一真相，undo 后的 doc 即最终采纳文本，决策表不参与正文合成）；
 *   3. 正文落库不在此处（Ctrl+S/自动保存走 DraftEditor.doSave 现状链路 :102-145）。
 * 无 accepted / 非 vela://draft 宿主 → 仅关会话（不落 revision）。任何 ipc 失败不阻塞会话结束。
 *
 * 重入防护（Task 5 评审 I-1）：双击「完成」/重复调用不得产生第二条并行收尾链——
 * ① per-session in-flight flag（selectionFinishInFlight）：async 链入口（首个 await 前）
 *    登记 sessionId，重复调用直接 return——R9「同一草稿只留一条 pending refine」在双击下也成立；
 * ② endSession 带会话身份检查（endSessionIfSame）：收尾期间若 tab 已被新会话接管
 *    （sessionId 变化），旧链迟到的 finally 不再清场（不破坏中途新建会话）。
 */
const selectionFinishInFlight = new Set<string>()

export async function finishSelectionSession(
  filePath: string | undefined,
  docText: string,
  actionLabel?: string,
): Promise<void> {
  const store = useEditorStore.getState()
  const tab = filePath ? store.tabs.find(t => t.id === filePath || t.filePath === filePath) : undefined
  const session = tab?.inlineSession
  const sessionId = session?.sessionId
  // ② 会话身份检查：仅当 tab 仍持同一 inlineSession（sessionId 未变）才 end——旧链
  // finally 迟到时若已开新会话（另一轮「应用为修改建议」）不清场
  const endSessionIfSame = () => {
    if (!tab || !sessionId) return
    const current = useEditorStore.getState().tabs.find(t => t.id === tab.id)?.inlineSession
    if (current && current.sessionId !== sessionId) return
    useEditorStore.getState().endInlineSession(tab.id)
  }
  if (!filePath || !tab || !session || !sessionId) return
  // 非 vela://draft 宿主：完成 = 关会话（Task 4 语义保留；revision 侧链仅 A 入口草稿走）
  if (!filePath.startsWith('vela://draft/')) {
    endSessionIfSame()
    return
  }
  const hasAccepted = session.hunks.some(h => h.sub.some(s => session.decisions[s.id] === 'accepted'))
  if (!hasAccepted) {
    endSessionIfSame() // 全部拒绝/未决：不落 revision
    return
  }
  const draftIdRaw = filePath.slice('vela://draft/'.length)
  if (!/^\d+$/.test(draftIdRaw)) {
    // legacy vela://draft/ch{n}（对齐 DraftEditor.doSave:111 防 NaN 入参）→ 无法定位 DB 草稿：
    // 仅关会话不落 revision（正文仍在 doc，Ctrl+S 保存链兜底）
    endSessionIfSame()
    return
  }
  // ① 重入防护：async 链入口登记（同步完成于首个 await 前），重复调用直接 return
  if (selectionFinishInFlight.has(sessionId)) return
  selectionFinishInFlight.add(sessionId)
  try {
    const draftId = parseInt(draftIdRaw, 10)
    const { ipc } = await import('../../services/ipc-client')
    const pending = await ipc.invoke('db:revision-get-pending', draftId) as Array<{ id: number }>
    for (const rev of pending) {
      await ipc.invoke('db:revision-mark-discarded', rev.id)
    }
    const nextIdx = await ipc.invoke('db:revision-next-index', draftId) as number
    await ipc.invoke('db:revision-create', {
      baseDraftId: draftId,
      revisionIndex: nextIdx,
      revisionType: 'refine',
      userPrompt: actionLabel ? `气泡菜单 AI — ${actionLabel}` : '气泡菜单 AI 改写',
      content: docText,
      wordCount: computeTextStats(docText).novelWordCount,
    })
  } catch (e) {
    // 不阻塞会话结束（错误经 console 留痕；Toast 反馈接入留给后续）
    console.error('[inline-accept] revision create failed', e)
  } finally {
    selectionFinishInFlight.delete(sessionId)
    endSessionIfSame()
  }
}

export default function CodeMirrorEditor({
  content,
  filePath,
  editable = true,
  onChange,
  onSave,
  onCharCountChange,
  mode = 'document',
}: CodeMirrorEditorProps) {
  const { t, locale } = useTranslation()
  // t 是稳定引用（useCallback []），语言切换时 locale 变化必须重算操作标签/指令（eslint 仅看数据流，误判 locale 不必要）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const aiActions = useMemo(() => getAIActions(t as (key: string) => string), [t, locale])
  const editorRef = useRef<ReactCodeMirrorRef>(null)

  // 避免状态回路
  const lastEmittedContentRef = useRef(content)
  const [editorContent, setEditorContent] = useState(content)
  const hasEmittedInitialCount = useRef(false)

  // ===== L1 inline 接受会话（Task 4）=====
  // 会话决策态存 editor-store（R5：切 tab/重挂载不丢）；本文档仅订阅 + 派发事务。
  // vela 草稿 tab 的 id === filePath（DraftEditor:373-376 语义）；filePath 缺失/未命中 → 无会话零影响。
  const inlineSession = useEditorStore((s) =>
    filePath ? (s.tabs.find(tab => tab.id === filePath || tab.filePath === filePath)?.inlineSession ?? null) : null,
  )
  // handleUpdate 以 ref 读会话（避免每次决策更新重建回调）；filePath 对 tab 固定
  const inlineSessionRef = useRef(inlineSession)
  const filePathRef = useRef(filePath)
  useEffect(() => { inlineSessionRef.current = inlineSession }, [inlineSession])
  useEffect(() => { filePathRef.current = filePath }, [filePath])

  // 浮层命中状态（点击 pending 区段打开）
  const [activeRange, setActiveRange] = useState<{ hunkIdx: number; subIdx: number } | null>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null)
  const activeSubId = activeRange && inlineSession
    ? (inlineSession.hunks[activeRange.hunkIdx]?.sub[activeRange.subIdx]?.id ?? null)
    : null
  // 气泡 AI 流式动作标签（A 入口会话收尾 revision.userPrompt 标注「气泡菜单 AI — {动作}」用；
  // 声明须先于 finishSession——其 useCallback 依赖数组在 render 期即时求值）
  const [activeAIAction, setActiveAIAction] = useState<string | null>(null)

  // @uiw/react-codemirror 在自身 useLayoutEffect + setState 后才创建 EditorView 并经 ref 暴露；
  // 首帧 effect 里 editorRef.current?.view 尚不存在 → 用 onCreateEditor 锁存实例触发重渲染，
  // 使会话区间同步 effect 在 view 就绪后必然执行（含「带会话重挂载」路径，R5）
  const [cmView, setCmView] = useState<EditorView | null>(null)
  // 事件处理器经 ref 取 view（渲染期不访问 ref；cmView state 只作 effect 触发器）
  const cmViewRef = useRef<EditorView | null>(null)
  useEffect(() => { cmViewRef.current = cmView }, [cmView])

  // 会话期间把决策态同步进 CM ranges（begin / 决策变更 / 会话结束 / 重挂载）。
  // accepted 子句已替换入 doc（derive 跳过）；rejected/pending 重 derive 定位；结束 → 清空
  useEffect(() => {
    const view = cmView
    if (!view) return
    const ranges = inlineSession ? deriveRangesFromDoc(inlineSession, view.state.doc.toString()) : []
    view.dispatch({ effects: setHunkRanges.of(ranges) })
  }, [inlineSession, cmView])

  // 程序化连续接受的事务时间：显式递增（R4，防 CM history 500ms 事件合并；
  // 实测 userEvent 非 input.type/delete 亦不合并，时间戳为双保险）
  const acceptTimeRef = useRef(0)
  const nextAcceptTime = useCallback(() => {
    const now = Date.now()
    acceptTimeRef.current = Math.max(now, acceptTimeRef.current + 1)
    return acceptTimeRef.current
  }, [])

  /** 单子 hunk 接受 = 唯一 doc 改写路径：带递增 time + INLINE_ACCEPT_EVENT 的独立事务。
   *  只接受 pending 子句：accepted 已入 doc（区间不在 field）、rejected 属已裁决（v1 恢复走
   *  resetHunkDecision，不在此路径复活）。view 在事件处理器内经 cmViewRef 取（渲染期不访问）。
   *  接受后同步重推 ranges：关闭「dispatch → React effect」间隙——立即 Ctrl+Z 的还原区间
   *  已不在 field（I1：防 undo 被触碰区间判定误判成漂移退出） */
  const applyAcceptSub = useCallback((sub: SubHunk) => {
    const view = cmViewRef.current
    const tabId = filePathRef.current
    if (!view || !tabId) return
    const ranges = view.state.field(inlineAcceptField).ranges
    const r = ranges.find(x => x.id === sub.id)
    if (!r || r.decision !== 'pending') return
    dispatchAcceptChange(view, r, sub.modText, nextAcceptTime())
    useEditorStore.getState().updateHunkDecision(tabId, sub.id, 'accepted')
    const session = useEditorStore.getState().tabs.find(tab => tab.id === tabId)?.inlineSession
    if (session) {
      view.dispatch({ effects: setHunkRanges.of(deriveRangesFromDoc(session, view.state.doc.toString())) })
    }
  }, [nextAcceptTime])

  /** 按序逐个接受（每子句独立事务 → 多步 undo 逐句还原，裁决 4） */
  const acceptSubsInOrder = useCallback((subs: SubHunk[]) => {
    for (const sub of subs) applyAcceptSub(sub)
  }, [applyAcceptSub])

  /** 拒绝 = 纯决策态（无 doc 事务、无 undo 事件）；只翻动当前 pending 的子句 */
  const rejectSubs = useCallback((subs: SubHunk[]) => {
    const tabId = filePathRef.current
    const session = inlineSessionRef.current
    if (!tabId || !session) return
    for (const sub of subs) {
      if (session.decisions[sub.id]) continue // 已有裁决不再翻动
      useEditorStore.getState().updateHunkDecision(tabId, sub.id, 'rejected')
    }
  }, [])

  /** 完成：会话收尾——vela://draft 且有 accepted → finishSelectionSession 落 refine revision
   *  （Task 5，验收 4）；非草稿宿主仅关会话。doc 实况经 cmViewRef 取（渲染期不访问 ref）。
   *  动作标签直接读 activeAIAction state（A 入口会话由某次 AI 动作进入，标签至完成保持不变；
   *  v1 后动作标签定格进会话元数据留给 v1.1）。 */
  const finishSession = useCallback(() => {
    const tabId = filePathRef.current
    const view = cmViewRef.current
    const session = inlineSessionRef.current
    setActiveRange(null)
    setPopoverPos(null)
    if (!tabId) return
    const docText = view ? view.state.doc.toString() : (session?.baseDocSnapshot ?? '')
    void finishSelectionSession(tabId, docText, activeAIAction ?? undefined)
  }, [activeAIAction])

  /** 关闭：仍有未决修改 → 二次确认；确认后丢弃未决建议并关会话——不落 revision
   *  （discard 语义，设计 §4.5；已接受文本保留在 doc，走 Ctrl+S 保存链） */
  const closeSession = useCallback(async () => {
    const tabId = filePathRef.current
    const session = inlineSessionRef.current
    if (!tabId || !session) return
    const unhandled = countUndecided(session)
    if (unhandled > 0) {
      const { confirm } = await import('../ui/Confirm')
      const ok = await confirm(t('inlineAccept.closeConfirm').replace('{n}', String(unhandled)))
      if (!ok) return
    }
    useEditorStore.getState().endInlineSession(tabId)
    setActiveRange(null)
    setPopoverPos(null)
  }, [t])

  /** 点击未接受区段 → 打开浮层（复用坐标基建思路：selection head + coordsAtPos）。
   *  final review I-1：rejected 划除段同样可点开——浮层内「恢复为待定」撤销误拒
   *  （findRestorableRangeAt 覆盖 pending|rejected；findPendingRangeAt 语义保持不变） */
  const handleDocClick = useCallback(() => {
    const view = editorRef.current?.view
    const session = inlineSessionRef.current
    if (!view || !session) return
    const sel = view.state.selection.main
    if (!sel.empty) return // 拖选（AI 气泡流）不打开 inline 浮层
    const range = findRestorableRangeAt(view, sel.head)
    if (range) {
      const hunkIdx = session.hunks.findIndex(h => h.sub.some(s => s.id === range.id))
      if (hunkIdx < 0) {
        setActiveRange(null)
        setPopoverPos(null)
        return
      }
      const subIdx = session.hunks[hunkIdx].sub.findIndex(s => s.id === range.id)
      const coords = view.coordsAtPos(range.from)
      if (coords) {
        setActiveRange({ hunkIdx, subIdx })
        setPopoverPos({ top: coords.top + 4, left: coords.left })
        return
      }
    }
    setActiveRange(null)
    setPopoverPos(null)
  }, [])

  // 浮层动作：以命名 handler 挂接（避免渲染期 IIFE 闭包触发 react-hooks/refs 保守告警）
  const popoverHunk = inlineSession && activeRange
    ? (inlineSession.hunks[activeRange.hunkIdx] ?? null)
    : null
  const handlePopoverAcceptSelected = useCallback((ids: string[]) => {
    if (!popoverHunk) return
    const subs = ids
      .map(id => popoverHunk.sub.find(s => s.id === id))
      .filter((s): s is SubHunk => !!s)
    if (subs.length === 0) return
    acceptSubsInOrder(subs)
    setActiveRange(null)
    setPopoverPos(null)
  }, [popoverHunk, acceptSubsInOrder])
  const handlePopoverAcceptWhole = useCallback(() => {
    if (!popoverHunk) return
    acceptSubsInOrder(popoverHunk.sub)
    setActiveRange(null)
    setPopoverPos(null)
  }, [popoverHunk, acceptSubsInOrder])
  const handlePopoverReject = useCallback(() => {
    if (!popoverHunk) return
    rejectSubs(popoverHunk.sub)
    setActiveRange(null)
    setPopoverPos(null)
  }, [popoverHunk, rejectSubs])
  /** 恢复误拒子句为待定（final review I-1）：resetHunkDecision → 装饰回 pending，可再接受 */
  const handlePopoverRestoreSub = useCallback((subId: string) => {
    const tabId = filePathRef.current
    if (!tabId) return
    useEditorStore.getState().resetHunkDecision(tabId, subId)
  }, [])
  const handlePopoverClose = useCallback(() => {
    setActiveRange(null)
    setPopoverPos(null)
  }, [])

  // 更新内容
  useEffect(() => {
    // 首次挂载时主动汇报一次字数
    if (!hasEmittedInitialCount.current) {
      onCharCountChange?.(countWords(content))
      hasEmittedInitialCount.current = true
    }

    if (content !== lastEmittedContentRef.current) {
      lastEmittedContentRef.current = content
      const view = editorRef.current?.view
      if (view) {
        // 外部内容同步（切文件/AI 刷新）：手动 dispatch 且不进 undo 历史栈，
        // 否则用户 Ctrl+Z 会先撤销"整文替换"而非自身编辑。
        // ReactCodeMirror 的受控 value 同步（esm/useCodeMirror.js value effect）
        // 只标记 ExternalChange 防止 onChange 回显，未带 addToHistory:false，
        // 整文替换事务会进入 undo 栈。
        // 不带 selection：CodeMirror 自动 clamp 越界光标，保留原有受控同步的光标语义，
        // 避免强制 anchor:0 导致切文件后光标跳文件头（用户可感知回归）。
        // 注：使用 annotation 形式而非 TransactionSpec 的 addToHistory 快捷字段——
        // 该快捷字段由 state 6.8+ 的 update() 转换（6.7.1 运行时静默忽略，
        // 行为级测试实测），annotation 形式在两版语义等价且由 @codemirror/commands
        // 的 historyField.update 直接识别。
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
          annotations: [Transaction.addToHistory.of(false)],
          scrollIntoView: true,
        })
      } else {
        setEditorContent(content)
      }
      // 内容经由外部变动（例如打开新文件）
      onCharCountChange?.(countWords(content))
    }
  }, [content, onCharCountChange])

  // ===== Bubble Menu 逻辑 =====
  const [bubbleOpen, setBubbleOpen] = useState(false)
  const [bubblePos, setBubblePos] = useState({ top: 0, left: 0 })
  const [aiResult, setAiResult] = useState<string | null>(null)
  // AI 流式缓冲：chunk 高频到达，逐片 setState 会高频重渲染编辑器阻塞主线程
  // （同 workflow-store 教训）→ 50ms 时间间隔硬约束，纯时间驱动
  const aiBufferRef = useRef('')
  const aiLastFlushRef = useRef(0)
  const [loadingDots, setLoadingDots] = useState('.')
  const [selectionRange, setSelectionRange] = useState<{ from: number, to: number } | null>(null)
  // 偏好记忆：AI 接受快照（检测用户后续手动修改 → 记录替换对）
  const aiAcceptedRef = useRef<{ aiText: string } | null>(null)

  // 检测用户是否手动修改了 AI 接受的内容，提取并记录替换对（偏好记忆）
  const detectPreferenceChange = useCallback(() => {
    const acc = aiAcceptedRef.current
    if (!acc || !editorRef.current?.view) return
    const doc = editorRef.current.view.state.doc.toString()
    // AI 文本仍完整存在 → 用户改的是别处，保留快照继续等待
    if (doc.includes(acc.aiText)) return
    aiAcceptedRef.current = null // 每次 AI 接受只检测一次
    // AI 文本被修改 → 定位（开头 15 字锚点；开头被改则用结尾锚点）→ 提取替换对
    const head = acc.aiText.slice(0, 15)
    const tail = acc.aiText.slice(-15)
    let pos = doc.indexOf(head)
    if (pos < 0 && head.length >= 15) {
      const tailPos = doc.indexOf(tail)
      if (tailPos < 0) return
      pos = tailPos - (acc.aiText.length - tail.length)
      if (pos < 0) return
    }
    if (pos < 0) return
    // 取 AI 原文等长（放宽 24 字容纳扩写）的区段 → 前后缀匹配提取差异
    const userSegment = doc.slice(pos, pos + acc.aiText.length + 24)
    const pair = extractPreferencePair(acc.aiText, userSegment)
    if (!pair) return
    void recordPreference(pair.ai, pair.user)
  }, [])

  useEffect(() => {
    if (aiResult === '') {
      const timer = setInterval(() => setLoadingDots(d => d.length >= 3 ? '.' : d + '.'), 400)
      return () => clearInterval(timer)
    }
  }, [aiResult])

  const handleUpdate = useCallback((v: ViewUpdate) => {
    if (v.docChanged) {
      // L1 inline 会话（R6 + 评审 I1）：任何「非会话知情」的 doc 改动都视为漂移并退出会话——
      // (a) 真实 CM 输入（input.*/delete.*/move.*/indent.* userEvent；区间内输入已被
      //     changeFilter 拦截，能到 doc 的必在区间外，偏移基准同样失效）；
      // (b) 无 userEvent 的程序化改动（Bold/Tab/气泡替换等）若 changes 触碰当前
      //     pending/rejected 区间——读该事务 startState 的 field（改动后映射可能已使区间
      //     塌缩，无法用 v.state 判定）。
      // 豁免：自身接受（INLINE_ACCEPT_EVENT）、外部同步（addToHistory:false）、undo/redo
      // （history 事务无输入类 userEvent，且其还原的已接受区间在接受后已被同步重推清除，
      //  不触碰剩余 pending/rejected → 不误判退出——「撤销自身接受不退出」用例锁定）。
      const session = inlineSessionRef.current
      if (session && filePathRef.current) {
        const tr = v.transactions[v.transactions.length - 1]
        const userEvent = tr?.annotation(Transaction.userEvent)
        const isExternal = tr?.annotation(Transaction.addToHistory) === false
        if (tr && userEvent !== INLINE_ACCEPT_EVENT && !isExternal) {
          const preRanges = tr.startState.field(inlineAcceptField).ranges
          const drift = isManualUserEdit(userEvent) || changesIntersectRanges(tr, preRanges)
          if (drift) {
            // final review M-1：清浮层状态——否则旧 activeRange/popoverPos 会在
            // 下一会话 begin 时（无点击）复活错位的旧浮层
            setActiveRange(null)
            setPopoverPos(null)
            useEditorStore.getState().endInlineSession(filePathRef.current)
            void import('../ui/Toast').then(({ toast }) => {
              toast.info(t('inlineAccept.manualEditExit'))
            })
          }
        }
      }

      const newText = v.state.doc.toString()
      lastEmittedContentRef.current = newText
      onChange?.(newText)

      const cnt = countWords(newText)
      onCharCountChange?.(cnt)

      // 偏好记忆：检测用户手动修改 AI 接受的内容
      detectPreferenceChange()
    }

    if (v.selectionSet || v.docChanged || v.geometryChanged) {
      const sel = v.state.selection.main
      if (sel.empty || sel.to - sel.from < 1) {
        setBubbleOpen(false)
        setSelectionRange(null)
      } else {
        setSelectionRange({ from: sel.from, to: sel.to })
        // 交由下方的 useEffect 进行精准防越界座标计算与位置同步
        if (!aiResult) {
          setBubbleOpen(true)
        }
      }
    }
  }, [onChange, onCharCountChange, aiResult, detectPreferenceChange, t])

  // Bubble Menu：Escape 关闭（原 InlineAIToolbar 的键盘关闭特性）
  useEffect(() => {
    if (!bubbleOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBubbleOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [bubbleOpen])

  // 监听滚动与缩放，实时更新 Bubble Menu 坐标
  useEffect(() => {
    if (!bubbleOpen || !selectionRange || !editorRef.current?.view) return;

    const view = editorRef.current.view;
    const scrollDOM = view.scrollDOM;

    let rafId: number;

    const updatePosition = () => {
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        const coords = view.coordsAtPos(selectionRange.from)
        if (coords) {
          setBubblePos({ top: coords.top, left: coords.left })
        } else {
          setBubbleOpen(false)
        }
        return
      }

      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const viewRect = scrollDOM.getBoundingClientRect()

      // 判断选区是否整体完全在视口之外
      if (rect.bottom < viewRect.top || rect.top > viewRect.bottom || rect.width === 0) {
        setBubbleOpen(false)
        return
      }

      let top = rect.top - 5 // 与选区顶部有些许间距
      const left = rect.left + rect.width / 2

      // 当用户圈选了一大段并向下滚动时，如果选区顶部滚出了视区，
      // 我们让气泡悬浮在视区顶部边缘，直到选区底部也完全滚出视区。
      if (top < viewRect.top + 45) {
        top = Math.min(viewRect.top + 45, rect.bottom - 10)
      }

      setBubblePos({ top, left })
    }

    const onScrollOrResize = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updatePosition)
    }

    scrollDOM.addEventListener('scroll', onScrollOrResize, { passive: true })
    window.addEventListener('resize', onScrollOrResize, { passive: true })

    // 初始化计算需要等待 CM 渲染映射完成，确保获取到正确的 DOM Range
    rafId = requestAnimationFrame(updatePosition)

    return () => {
      scrollDOM.removeEventListener('scroll', onScrollOrResize)
      window.removeEventListener('resize', onScrollOrResize)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [bubbleOpen, selectionRange])

  // 主题配置
  const cmTheme = useMemo(() => EditorView.theme({
    "&": {
      height: "100%",
      // prose/document 都是写作场景，使用写作字体
      // 其他模式（如代码等）继承父元素 UI 字体
      fontSize: mode === 'prose' ? "16px" : "14px",
      backgroundColor: "transparent",
      fontFamily: (mode === 'prose' || mode === 'document') ? "var(--font-writing)" : "inherit"
    },
    ".cm-scroller": {
      overflow: "auto",
      paddingBottom: "100px",
      fontFamily: (mode === 'prose' || mode === 'document') ? "var(--font-writing)" : "inherit"
    },
    ".cm-content": {
      width: "100%",
      maxWidth: "800px",
      margin: "0 auto",
      padding: "40px",
      lineHeight: "1.8",
      color: "var(--color-text)",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--color-accent)", borderLeftWidth: "2px" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-selectionBackground, .cm-focused .cm-selectionBackground": { backgroundColor: "var(--color-editor-selection, var(--color-hover)) !important" },
    ".cm-line": { padding: "0" },
    // 防御性兜底（非渲染来源）：当前依赖下 `**文字**`/`*文字*` 的粗体/斜体渲染由
    // defaultHighlightStyle（basicSetup 的 syntaxHighlighting）提供的散列类名实现，
    // .cm-strong/.cm-em 并不匹配任何实际 DOM 类；保留以防未来替换高亮主题后丢失
    ".cm-strong": { fontWeight: "bold" },
    ".cm-em": { fontStyle: "italic" },
  }), [mode])

  // 构建扩展
  const extensions = useMemo(() => {
    const exts = [
      history(),                    // 撤销/重做历史记录
      search({ top: true }),
      EditorView.lineWrapping,
      keymap.of([
        ...historyKeymap,           // Ctrl+Z 撤销, Ctrl+Y/Ctrl+Shift+Z 重做
        {
          key: 'Tab',
          run: (target) => {
            // 插入两个 em 空格（U+2003）= 2em = 标准中文首行缩进两字符宽
            // 使用 \u2003 而非 \u3000（全角空格），因为 em 空格在任何 Unicode 字体下
            // 都精确等于 1em，不依赖 CJK 字体加载
            target.dispatch({
              changes: { from: target.state.selection.main.head, insert: '\u2003\u2003' },
              selection: { anchor: target.state.selection.main.head + 2 }
            })
            return true
          }
        }
      ]),
      // 汉化 Search / UI 文本（涵盖官方大小写所有变种）
      EditorState.phrases.of({
        "Find": "Find",
        "find": "Find",
        "Replace": "Replace",
        "replace": "Replace",
        "Replace all": "Replace All",
        "replace all": "Replace All",
        "Next": "Next",
        "next": "Next",
        "Previous": "Previous",
        "previous": "Previous",
        "All": "All",
        "all": "All",
        "Match case": "Match Case",
        "match case": "Match Case",
        "Regexp": "Regexp",
        "regexp": "Regexp",
        "by word": "By Word",
        "By word": "By Word",
        "Close": "Close",
        "close": "Close"
      })
    ]
    // L1 inline 接受（Task 4）：StateField 常驻但无会话时空值零可见影响（R3）；
    // 会话期由 setHunkRanges effect 动态驱动，无需 reconfigure
    exts.push(...inlineAcceptExtensions())
    if (mode === 'document' || mode === 'prose') {
      exts.push(markdown({ base: markdownLanguage, codeLanguages: languages }))
    }
    return exts
  }, [mode])

  // AI 菜单处理（流式调用，实时显示生成内容）
  const handleAIAction = async (prompt: string, _actionKey: string) => {
    try {
      if (!selectionRange || !editorRef.current?.view) return
      const view = editorRef.current.view
      const selectedText = view.state.sliceDoc(selectionRange.from, selectionRange.to)

      const { useLLMStore } = await import('../../stores/llm-store')

      // 初始化流式内容
      setActiveAIAction(aiActions.find(a => a.key === _actionKey)?.label || 'AI')
      setAiResult('')
      aiBufferRef.current = ''
      aiLastFlushRef.current = 0 // 0 = 首块立即 flush

      await useLLMStore.getState().generateStream(
        [
          { role: 'system', content: t('ai.systemPrompt') },
          { role: 'user', content: `要求：${prompt}\n\n文本：\n${selectedText}` },
        ],
        {
          onChunk: (chunk) => {
            aiBufferRef.current += chunk
            if (Date.now() - aiLastFlushRef.current >= 50) {
              setAiResult(prev => (prev ?? '') + aiBufferRef.current)
              aiBufferRef.current = ''
              aiLastFlushRef.current = Date.now()
            }
          },
          onError: () => {
            setAiResult(t('error.genFailed'))
          },
        }
      )
      // 流结束：flush 残留缓冲（最后一批可能不足 50ms 间隔）
      if (aiBufferRef.current) {
        setAiResult(prev => (prev ?? '') + aiBufferRef.current)
        aiBufferRef.current = ''
      }
    } catch (e) {
      console.error(e)
      setAiResult(t('error.genFailed'))
    }
  }

  /** 生成章节分享卡：先弹保存对话框（用户手势立即响应）→ LLM 摘要 → 卡片 → 截图 → 写入 */
  const handleShareCard = async () => {
    try {
      if (!selectionRange || !editorRef.current?.view) return
      const selectedText = editorRef.current.view.state.sliceDoc(selectionRange.from, selectionRange.to)
      if (!selectedText.trim()) return

      const { ipc } = await import('../../services/ipc-client')
      const outPath = await ipc.invoke('dialog:save-file', { defaultName: 'NovelForge-Share-Card.png' })
      if (!outPath) return

      const { useLLMStore } = await import('../../stores/llm-store')
      const res = await useLLMStore.getState().generate(
        [
          { role: 'system', content: t('ai.systemPrompt') },
          { role: 'user', content: `${t('ai.prompt.shareSummary')}\n\n片段：\n${selectedText.slice(0, 4000)}` },
        ],
        undefined,
        { temperature: 0.2, responseFormat: { type: 'json_object' } },
      )
      if (!res.success || !res.content) throw new Error(res.error || 'empty response')

      let parsed: { summary?: string; quote?: string }
      try {
        parsed = JSON.parse(res.content) as { summary?: string; quote?: string }
      } catch {
        throw new Error('summary parse failed')
      }
      if (!parsed.summary) throw new Error('no summary in response')

      const { buildShareCardHTML } = await import('../../services/share-card')
      const { toast } = await import('../ui/Toast')
      // 卡片标题：物理文件取文件名（去扩展名）；vela:// 伪协议用品牌名
      const fileName = filePath && !filePath.startsWith('vela:')
        ? filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '')
        : ''
      const html = buildShareCardHTML({
        title: fileName || 'NovelForge',
        meta: '',
        summary: parsed.summary,
        quote: parsed.quote ?? '',
      })

      const shot = await ipc.invoke('report:render-html', html)
      if (!shot.success || !shot.png) throw new Error(shot.error || 'render failed')
      const saved = await ipc.invoke('fs:write-buffer', outPath, shot.png)
      if (!saved.success) throw new Error(saved.error || 'write failed')
      toast.success(t('shareCard.saveSuccess').replace('{path}', outPath))
    } catch (e) {
      const { toast } = await import('../ui/Toast')
      toast.error(t('shareCard.saveFailed').replace('{error}', String(e)))
    }
  }

  /** A 入口（Task 5）：AI 流式结果「应用为修改建议」→ 进入 inline 会话，不再整段替换。
   *  - buildSelectionSession 选区级对齐：AI 输出与选区等价 → toast 提示并清态（无改动不进会话）；
   *  - 进会话后 doc 保持原样（验收 1/2——原文不变、pending 区装饰由 Task 4 浮层接管）；
   *  - revision 落库移至会话收尾 finishSelectionSession（验收 4：恰一条 + R9 旧 pending 清理）；
   *  - 偏好记忆快照（aiAcceptedRef 旧整段替换链路）在新路径不适用：detectPreferenceChange 保留
   *    但不再写快照（接受在会话内逐句发生），偏好记忆链留 v1.1 评估。 */
  const handleAcceptAI = async () => {
    if (selectionRange && aiResult && editorRef.current?.view) {
      const view = editorRef.current.view
      // v1 仅 DraftEditor（必带 filePath）接入；无 filePath 的宿主无法挂会话 → toast 拒绝
      // （不回退旧整段替换——L1 已把入口语义改为「建议先行」，设计 §4.7 范围）
      if (!filePath) {
        const { toast } = await import('../ui/Toast')
        toast.error(t('error.unknownError'))
        handleRejectAI()
        return
      }
      const session = buildSelectionSession(
        view.state.doc.toString(), selectionRange.from, selectionRange.to, aiResult,
      )
      if (!session) {
        // AI 输出与选区等价（无改动可进会话——Task 1 reviewer 归一化零重叠语义）
        const { toast } = await import('../ui/Toast')
        toast.info(t('inlineAccept.noChanges'))
        handleRejectAI()
        return
      }
      // 进会话：doc 保持原样（验收 1/2）——会话 action 标签由 finishSession 读 activeAIAction
      useEditorStore.getState().beginInlineSession(filePath, session)
      setAiResult(null)
      setBubbleOpen(false)
    }
  }

  const handleRejectAI = () => {
    setAiResult(null)
    setBubbleOpen(false)
  }

  // 固定 basicSetup 内存引用，防止 React 每次渲染生成新对象导致内部扩展被重载（搜索框消失的罪魁祸首）
  const cmBasicSetup = useMemo(() => ({
    lineNumbers: false,
    foldGutter: false,
    dropCursor: false,
    allowMultipleSelections: false,
    indentOnInput: false,
    highlightActiveLine: false,
    highlightActiveLineGutter: false,
    searchKeymap: true,
  }), [])

  return (
    <div className="relative h-full flex flex-col min-h-0"
      onKeyDownCapture={(e) => {
        // 全局捕获 Ctrl+F 实现搜索框 Toggle（解决搜索框内焦点时快捷键失效的问题）
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
          e.preventDefault()
          e.stopPropagation()
          const view = editorRef.current?.view
          if (view) {
            const searchPanel = view.dom.querySelector('.cm-search')
            if (searchPanel) {
              closeSearchPanel(view)
              view.focus()
            } else {
              openSearchPanel(view)
            }
          }
        }
      }}
      onKeyDown={(e) => {
        // 捕获 Cmd+S 保存
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault()
          onSave?.(lastEmittedContentRef.current)
        }
      }}
      onClick={(e) => {
        // L1 inline（Task 4）：仅 CM 正文点击驱动 pending 段点击 → 打开/切换接受浮层
        // （浮条/浮层/气泡按钮的点击不落在 .cm-content 内，不触发）
        const target = e.target as HTMLElement
        if (target && typeof target.closest === 'function' && target.closest('.cm-content')) {
          handleDocClick()
        }
      }}>
      <div className="flex-1 relative min-h-0 overflow-hidden"
        onMouseDown={() => {
          // 点击空白处关闭 Bubble Menu
          if (aiResult) return;
          // setBubbleOpen(false) 交给 handleUpdate 里面的 selection empty 判断即可
        }}>
        <div className="absolute inset-0">
          <CodeMirror
            ref={editorRef}
            value={editorContent}
            height="100%"
            className="h-full"
            theme={cmTheme}
            extensions={extensions}
            readOnly={!editable}
            basicSetup={cmBasicSetup}
            onUpdate={handleUpdate}
            onCreateEditor={(view) => setCmView(view)}
          />
        </div>
      </div>

      {/* Bubble Menu（选中工具栏：撤销/重做/加粗/AI + 预览面板）。
          旧 InlineAIToolbar 已废弃移除——曾与它同位置同时渲染造成双弹窗 */}
      {bubbleOpen && bubblePos.top !== 0 && (
        <div
          className="fixed z-[var(--z-overlay)] flex items-center gap-0.5 p-1 rounded-xl border select-none shadow-xl transform -translate-x-1/2 -translate-y-full"
          style={{
            top: bubblePos.top,
            left: bubblePos.left,
            backgroundColor: 'var(--color-sidebar)',
            borderColor: 'var(--color-border)',
          }}
          onMouseDown={(e) => e.preventDefault()} // 防止编辑器失焦
        >
          {aiResult !== null ? (
            <div className="w-[360px] max-h-[260px] overflow-y-auto p-2">
              <div
                className="text-[10px] mb-1.5 font-medium flex items-center gap-1"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <Sparkles size={11} style={{ color: 'var(--color-accent)' }} /> {activeAIAction ? t('codeEditor.previewSuffix').replace('{action}', activeAIAction) : t('codeEditor.aiPreview')}
              </div>
              {/* 流式输入中显示动态内容 */}
              {aiResult === '' ? (
                <div
                  className="text-xs leading-relaxed mb-3"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {t('status.generating')} {loadingDots}
                </div>
              ) : (
                <div
                  className="text-xs whitespace-pre-wrap leading-relaxed mb-3"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {aiResult}
                </div>
              )}
              <div className="flex items-center gap-2 justify-end">
                <button
                  className="px-2.5 py-1 text-xs rounded-md transition-colors"
                  style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  onClick={handleRejectAI}
                >{t('editor.cancel')}</button>
                <button
                  className="px-2.5 py-1 text-xs rounded-md font-medium transition-colors"
                  style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-text)' }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                  disabled={aiResult === ''}
                  onClick={handleAcceptAI}
                >{t('inlineAccept.applyAsSuggestion')}</button>
              </div>
            </div>
          ) : (
            <>
              {/* 撤销 / 重做（Ctrl+Z / Ctrl+Y） */}
              {editable && (
                <>
                  <button
                    className="p-1 rounded"
                    title={t('action.undo')}
                    style={{ color: 'var(--color-text-secondary)' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                    onClick={() => {
                      const view = editorRef.current?.view
                      if (view) undo(view)
                    }}
                  ><Undo2 size={14} /></button>
                  <button
                    className="p-1 rounded"
                    title={t('action.redo')}
                    style={{ color: 'var(--color-text-secondary)' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                    onClick={() => {
                      const view = editorRef.current?.view
                      if (view) redo(view)
                    }}
                  ><Redo2 size={14} /></button>
                  <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
                </>
              )}
              {(mode === 'document' || mode === 'prose') && (
                <>
                  <button
                    className="p-1 rounded"
                    style={{ color: 'var(--color-text-secondary)' }}
                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                    onClick={() => {
                      if (selectionRange && editorRef.current?.view) {
                        const view = editorRef.current.view
                        const text = view.state.sliceDoc(selectionRange.from, selectionRange.to)
                        view.dispatch({
                          changes: { from: selectionRange.from, to: selectionRange.to, insert: `**${text}**` }
                        })
                      }
                    }}
                  ><Bold size={14} /></button>
                  <div className="w-[1px] h-3 mx-1" style={{ backgroundColor: 'var(--color-border)' }} />
                </>
              )}
              <div
                className="flex items-center gap-0.5 pl-0.5 pr-1 text-[10px]"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <Sparkles size={11} />AI
              </div>
              {aiActions.map(action => (
                <button
                  key={action.key}
                  className={cn('p-1.5 rounded flex items-center gap-1 transition-colors', action.color)}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                  onClick={() => handleAIAction(action.prompt, action.key)}
                >
                  <span className="text-[10px] tracking-widest">{action.label}</span>
                </button>
              ))}
              <button
                className="p-1.5 rounded transition-colors"
                title={t('shareCard.generate')}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                onClick={handleShareCard}
              >
                <Share2 size={13} style={{ color: 'var(--color-text-muted)' }} />
              </button>
            </>
          )}
        </div>
      )}

      {/* L1 inline 接受（Task 4）：进度浮条 + 接受浮层——仅存在 inlineSession 时渲染 */}
      {inlineSession && (
        <InlineAcceptBar
          session={inlineSession}
          onAcceptAll={() => {
            setActiveRange(null)
            setPopoverPos(null)
            acceptSubsInOrder(inlineSession.hunks.flatMap(h => h.sub))
          }}
          onRejectAll={() => {
            setActiveRange(null)
            setPopoverPos(null)
            rejectSubs(inlineSession.hunks.flatMap(h => h.sub))
          }}
          onFinish={finishSession}
          onClose={() => void closeSession()}
        />
      )}
      {inlineSession && activeRange && popoverPos && activeSubId && popoverHunk && (
        <InlineAcceptPopover
          key={`${activeRange.hunkIdx}:${activeRange.subIdx}`}
          session={inlineSession}
          hunkIdx={activeRange.hunkIdx}
          activeSubId={activeSubId}
          position={popoverPos}
          onAcceptSelected={handlePopoverAcceptSelected}
          onAcceptWhole={handlePopoverAcceptWhole}
          onReject={handlePopoverReject}
          onClose={handlePopoverClose}
          onRestoreSub={handlePopoverRestoreSub}
        />
      )}
    </div>
  )
}
