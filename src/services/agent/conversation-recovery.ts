/**
 * 会话恢复净化 — CC 对比 §三.8（conversationRecovery.ts 对齐）
 *
 * 恢复不是重放是净化：崩溃残片（半截 tool_call / 思维链 / 空白占位 / 孤立标签）在恢复时清理；
 * 正常路径零改动（净化只命中残片形态，未发现残片时逐字返回原内容）。
 *
 * NovelForge 形态裁决（2026-08-29，C4 report 记录）：
 * - tool_call 配对判定：NF 的 tool_call 是 agent-engine ReAct 协议的 <tool_call> 纯文本块，
 *   归档写入链（agent-store onTextChunk/onDone 全量清洗）保证正常归档不含任何 tool 标签——
 *   **assistant** 消息恢复时出现的完整/断裂 tool_call/tool_result 文本 = 崩溃或旧版残留，文本级清理。
 *   CC 的「无配对 tool_use 整轮过滤」对应到 NF = assistant 消息清理后为纯空白 → 整条过滤
 *   （NF store 层无独立 user observation 消息类型，不存在跨消息配对判定的基质；
 *   assistant 含正文 + tool 块 → 只清块留正文，不整条删）。
 *   **user/system 消息写入链零清洗，正文必须逐字保留**（可含字面 <tool_call>/<think>，
 *   含未闭合形态——评审 F1 修复：清理只作用 assistant，user/system 仅校验/空白过滤/streaming 归一）。
 * - thinking：输出链落盘前已剥 <think>（output-post-processor / workflow-utils
 *   stripThinkingTags）；可见思考以 `_思考过程：_` 引用形态存 assistant 正文（用户可见，不滤）。
 *   **assistant** 消息里出现原始 <think> 块（含未闭合）= 流式中断残留 → 清理。
 *   「仅思考无正文」的引用形态（quote-only assistant）可被正常路径产出（引擎空正文 + 有思考），
 *   非崩溃残片 → 本层不动，留 UI/后续裁决（C4 report 记录）。
 * - streaming:true 持久化 = 崩溃/错误后未收尾（正常 onDone 清 flag 后才落盘）→ 恢复时清 flag；
 *   纯空白消息（含崩溃留下的流式占位符）→ 整条过滤。
 * - 本层为纯函数：零运行时依赖（仅 import type），archive-codec.parseArchive 与
 *   workflow-store.restoreCheckpoint 共用；L2（checkpoint 迁 DB）迁移时直接复用，勿双写实现。
 */

import type { AgentMessage } from '../../stores/agent-store'
import type { CheckpointData, WorkflowRun, WorkflowStep, WorkflowType, WorkflowParams } from '../../stores/workflow-store'

// ===== 文本残片清理（tool_call / tool_result / think 标签） =====

/** <tool_call>…</tool_call> 完整块（LLM 中途崩溃可能留下半截/整段调用文本） */
const TOOL_CALL_BLOCK_RE = /<tool_call>[\s\S]*?<\/tool_call>/gi
/** <tool_result name=…>…</tool_result> 完整块（含属性与 error 变体） */
const TOOL_RESULT_BLOCK_RE = /<tool_result[\s\S]*?<\/tool_result>/gi
/** 孤立 <tool_call> / </tool_call> 开闭标签 */
const TOOL_CALL_TAG_RE = /<\/?tool_call>/gi
/** 孤立 <tool_result …> / </tool_result> 开闭标签 */
const TOOL_RESULT_TAG_RE = /<\/?tool_result[^>]*>/gi
/** <think>…</think> 思维链块（含未闭合到文末——与 workflow-utils.stripThinkingTags 同语义） */
const THINK_BLOCK_RE = /<think>[\s\S]*?(?:<\/think>|$)/gi
/** 孤立 </think> 残留 */
const THINK_TAG_RE = /<\/?think>/gi

/**
 * 清理单段文本中的协议残片：完整/断裂 tool_call、tool_result 块与孤立标签、think 块。
 * 只移除标签形态文本——不 trim、不折叠空白（用户正文的空白/换行必须逐字保留，
 * 行为兼容：正常内容不含上述标签时逐字原样返回）。
 */
export function cleanupMessageText(content: string): string {
  return content
    .replace(TOOL_CALL_BLOCK_RE, '')
    .replace(TOOL_RESULT_BLOCK_RE, '')
    .replace(TOOL_CALL_TAG_RE, '')
    .replace(TOOL_RESULT_TAG_RE, '')
    .replace(THINK_BLOCK_RE, '')
    .replace(THINK_TAG_RE, '')
}

/** 合法消息 role（净化入口的 role 白名单——手改/损坏归档可能带任意 role 值） */
const VALID_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system'])

/**
 * 净化单条消息：role 非法 / content 非字符串 → null（过滤）；
 * content 清理后为纯空白 → null（过滤——CC「滤纯空白消息」+ 无配对 tool_use 整轮过滤的 NF 落地）；
 * 残留 streaming:true → 清为 false（恢复后无生成链路，flag 恒陈旧）。
 *
 * 按 role 分流（评审 F1 修复，2026-09）：cleanupMessageText 只作用 **assistant** 消息——
 * assistant 写链在落盘前全量清洗（agent-store onTextChunk/onDone），恢复时出现的 tool/think
 * 标签 = 崩溃残留，可安全清理；**user/system 消息写入链零清洗**（agent-store 用户原文直存），
 * 正常正文可能含字面 <tool_call>/<think>（用户粘贴/讨论代码标签/引用文件内容，含未闭合形态——
 * 未闭合 <think> 正则会吞其后整段到文末），必须逐字保留：只做校验 + 空白过滤 + streaming flag 归一。
 * 无变化的合法消息返回原引用（调用方可据此判断是否发生过净化）。
 */
export function sanitizeAgentMessage(msg: AgentMessage): AgentMessage | null {
  if (!msg || typeof msg.content !== 'string' || !VALID_ROLES.has(msg.role)) return null
  const cleaned = msg.role === 'assistant' ? cleanupMessageText(msg.content) : msg.content
  if (cleaned.trim() === '') return null
  if (cleaned === msg.content && msg.streaming !== true) return msg
  if (cleaned === msg.content) {
    // 仅陈旧 streaming flag：清 flag，正文不变
    return { ...msg, streaming: false }
  }
  return { ...msg, content: cleaned, streaming: msg.streaming === true ? false : msg.streaming }
}

/**
 * 净化消息列表（顺序保持）：逐条 sanitizeAgentMessage，null 过滤。
 * 用于 archive 的 messages / compressed[].original / rewound[].messages 三处。
 */
export function sanitizeMessageList(messages: readonly AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const m of messages) {
    const s = sanitizeAgentMessage(m)
    if (s) out.push(s)
  }
  return out
}

// ===== Checkpoint 净化（workflow-store.restoreCheckpoint / L2 复用） =====

/**
 * 净化 checkpoint 中的步骤文本：steps[].result/error/logs 的字符串走 cleanupMessageText
 * （LLM 中途崩溃可能留下半截 think/tool 文本）；结果字段为纯生成正文时不改一字。
 * 形状防御（loadCheckpoint 只有 JSON.parse，无逐级校验——损坏 checkpoint 曾致启动崩溃）：
 * - 顶层非对象 / activeRuns 非数组 → null（恢复路径按「无 checkpoint」处理）
 * - run 非对象 / 缺 string id / steps 非数组 → 丢弃该 run
 * - step 非对象 → 丢弃该 step；logs 非数组置空；waitingRuns 非对象置空
 */
export function sanitizeCheckpointData(raw: unknown): CheckpointData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  if (!Array.isArray(data.activeRuns)) return null

  const activeRuns: WorkflowRun[] = []
  for (const run of data.activeRuns) {
    const s = sanitizeCheckpointRun(run)
    if (s) activeRuns.push(s)
  }

  const out: CheckpointData = {
    activeRuns,
    waitingRuns: sanitizeWaitingRuns(data.waitingRuns),
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
  }
  // L2 v2：保留重建信息（runDefs / contextData）。shape 防御：仅当 non-null 纯对象才带，否则省略——
  // runDefs 是 type+params 快照、contextData 是 executor 跨步共享上下文，均非生成文本，不进 cleanupMessageText。
  if (data.runDefs && typeof data.runDefs === 'object' && !Array.isArray(data.runDefs)) {
    out.runDefs = data.runDefs as Record<string, { type: WorkflowType; params: WorkflowParams }>
  }
  if (data.contextData && typeof data.contextData === 'object' && !Array.isArray(data.contextData)) {
    out.contextData = data.contextData as Record<string, Record<string, unknown>>
  }
  return out
}

function sanitizeCheckpointRun(run: unknown): WorkflowRun | null {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null
  const r = run as Record<string, unknown>
  if (typeof r.id !== 'string' || !Array.isArray(r.steps)) return null

  const steps: WorkflowStep[] = []
  for (const rawStep of r.steps) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) continue
    const step = rawStep as Record<string, unknown>
    const out: Record<string, unknown> = { ...step }
    if (typeof out.result === 'string') out.result = cleanupMessageText(out.result)
    if (typeof out.error === 'string') out.error = cleanupMessageText(out.error)
    if (Array.isArray(out.logs)) {
      out.logs = (out.logs as unknown[]).map(l => (typeof l === 'string' ? cleanupMessageText(l) : l))
    } else {
      out.logs = []
    }
    steps.push(out as unknown as WorkflowStep)
  }

  return { ...(r as unknown as WorkflowRun), steps }
}

function sanitizeWaitingRuns(value: unknown): CheckpointData['waitingRuns'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: CheckpointData['waitingRuns'] = {}
  for (const [id, w] of Object.entries(value as Record<string, unknown>)) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) continue
    const ww = w as Record<string, unknown>
    out[id] = {
      waitingForConfirm: ww.waitingForConfirm === true,
      waitingAfterStepIndex: typeof ww.waitingAfterStepIndex === 'number' ? ww.waitingAfterStepIndex : -1,
    }
  }
  return out
}
