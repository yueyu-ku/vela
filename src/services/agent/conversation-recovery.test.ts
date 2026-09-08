import { describe, it, expect } from 'vitest'
import {
  cleanupMessageText,
  sanitizeAgentMessage,
  sanitizeMessageList,
  sanitizeCheckpointData,
} from './conversation-recovery'
import type { AgentMessage } from '../../stores/agent-store'

// ===== 工厂 =====

const makeMsg = (
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  extra: Partial<AgentMessage> = {},
): AgentMessage => ({ id, role, content, createdAt: 0, ...extra })

const toolCallBlock = '<tool_call>\n{"name": "read_drafts", "arguments": {}}\n</tool_call>'

// ===== 文本残片清理 =====

describe('cleanupMessageText', () => {
  it('清除完整 <tool_call> 块，保留周围正文', () => {
    expect(cleanupMessageText(`好的，我先查一下。\n${toolCallBlock}`)).toBe('好的，我先查一下。\n')
  })

  it('清除完整 <tool_result> 块（含属性与 error 变体）', () => {
    const ok = cleanupMessageText(`<tool_result name="read_drafts">\n第1章内容\n</tool_result>`)
    expect(ok).toBe('')
    const err = cleanupMessageText(`前言\n<tool_result name="x" error="true">\n失败\n</tool_result>\n后记`)
    expect(err).toBe('前言\n\n后记')
  })

  it('完整块整体移除；孤立开/闭标签移除（多个、大小写不敏感）', () => {
    expect(cleanupMessageText('<tool_call>裸调用文本</tool_call>')).toBe('')
    expect(cleanupMessageText('前 <tool_call> 中 </tool_call> 后')).toBe('前  后')
    expect(cleanupMessageText('<tool_call>孤立开标签')).toBe('孤立开标签')
    expect(cleanupMessageText('孤立闭标签</tool_call>')).toBe('孤立闭标签')
    expect(cleanupMessageText('<tool_result name="x">残留开头')).toBe('残留开头')
    expect(cleanupMessageText('前 <TOOL_RESULT name="x"> 中 </TOOL_RESULT> 后')).toBe('前  后')
  })

  it('清除 <think> 块与未闭合 <think>（同 workflow-utils.stripThinkingTags 语义）', () => {
    expect(cleanupMessageText('<think>深度思考中</think>正文')).toBe('正文')
    expect(cleanupMessageText('<think>未闭合思考')).toBe('')
    expect(cleanupMessageText('正文<think>链</think>尾')).toBe('正文尾')
    expect(cleanupMessageText('残留</think>标签')).toBe('残留标签')
    expect(cleanupMessageText('<THINK>大写</THINK>x')).toBe('x')
  })

  it('正常正文逐字返回（不 trim、不折叠空白、不含标签时零改动）', () => {
    const normal = '  前后带空白的正文\n\n\n连续空行  '
    expect(cleanupMessageText(normal)).toBe(normal)
    const withQuote = '> 引用块\n\n普通段落'
    expect(cleanupMessageText(withQuote)).toBe(withQuote)
    // 标签形态字符串（实体转义/残缺拼写）不属于协议残片，不得误删
    expect(cleanupMessageText('请解释 &lt;tool_call&gt; 标签的用法')).toBe('请解释 &lt;tool_call&gt; 标签的用法')
  })
})

// ===== 消息级净化 =====

describe('sanitizeMessageList', () => {
  it('纯空白消息整条过滤（CC「滤纯空白消息」）', () => {
    const list = [
      makeMsg('u1', 'user', '正常问题'),
      makeMsg('u2', 'user', '   \n\t '),
      makeMsg('a1', 'assistant', ''),
      makeMsg('a2', 'assistant', '正文'),
    ]
    const out = sanitizeMessageList(list)
    expect(out.map(m => m.id)).toEqual(['u1', 'a2'])
  })

  it('role 非法 / content 非字符串消息过滤（损坏/手改归档）', () => {
    const list = [
      makeMsg('a1', 'assistant', 'ok'),
      { ...makeMsg('bad1', 'user', 'x'), role: 'tool' } as unknown as AgentMessage,
      { id: 'bad2', content: '无 role', createdAt: 0 } as unknown as AgentMessage,
      { id: 'bad3', role: 'assistant', content: 12345, createdAt: 0 } as unknown as AgentMessage,
    ]
    const out = sanitizeMessageList(list)
    expect(out.map(m => m.id)).toEqual(['a1'])
  })

  it('仅含 tool_call 无正文的 assistant 整条过滤（CC「无配对 tool_use」对齐）', () => {
    const list = [
      makeMsg('u1', 'user', '帮我查第 3 章'),
      makeMsg('a1', 'assistant', toolCallBlock),
      makeMsg('a2', 'assistant', `好。\n${toolCallBlock}`),
    ]
    const out = sanitizeMessageList(list)
    expect(out.map(m => m.id)).toEqual(['u1', 'a2'])
    expect(out[1]!.content).toBe('好。\n')
  })

  it('正文 + tool/think 残片 → 清残片留正文，正文零改动时保留原引用', () => {
    const clean = makeMsg('a1', 'assistant', '正常回答文本')
    const list = [
      clean,
      makeMsg('a2', 'assistant', `先说结论\n<think>中途思考</think>${toolCallBlock}\n\n最后总结`),
    ]
    const out = sanitizeMessageList(list)
    expect(out[0]).toBe(clean) // 无变化消息原引用（零改动）
    expect(out[1]!.content).toBe('先说结论\n\n\n最后总结')
  })

  it('system role 非空消息保留', () => {
    const list = [makeMsg('s1', 'system', '系统指令'), makeMsg('u1', 'user', 'q')]
    expect(sanitizeMessageList(list).map(m => m.id)).toEqual(['s1', 'u1'])
  })

  it('崩溃流式占位：streaming:true 空内容过滤；有内容则保留并清 streaming flag', () => {
    const list = [
      makeMsg('u1', 'user', '写一段'),
      makeMsg('a1', 'assistant', '', { streaming: true, toolCalls: [] }),
      makeMsg('a2', 'assistant', '半截正文', { streaming: true }),
    ]
    const out = sanitizeMessageList(list)
    expect(out.map(m => m.id)).toEqual(['u1', 'a2'])
    expect(out[1]!.streaming).toBe(false)
    expect(out[1]!.content).toBe('半截正文')
  })

  it('正常消息列表（含正文/引用/空行）零改动，顺序保持', () => {
    const list = [
      makeMsg('u1', 'user', '帮我写一章'),
      makeMsg('a1', 'assistant', '_思考过程：_\n> 先梳理伏笔\n\n夜色渐深。'),
      makeMsg('u2', 'user', '继续'),
      makeMsg('a2', 'assistant', '他推开门。'),
    ]
    const out = sanitizeMessageList(list)
    expect(out).toEqual(list)
  })

  // 评审 F1/F2 修复（2026-09）：cleanup 只作用 assistant——user/system 正文逐字保留（写链零清洗，
  // 正常 user 正文可含字面标签，含未闭合 <think>——不得被吞段/清空/改写）
  it('F1/F2：user 消息含原始 <tool_call>/<think>（含未闭合）→ 逐字保留', () => {
    const literalTool = makeMsg('u1', 'user', '请问 <tool_call> 和 <tool_result> 标签的用途？')
    const pastedBlock = makeMsg('u2', 'user', `我贴一段：\n${toolCallBlock}\n<think>用户粘贴的思考标记</think>后面还有正文`)
    const unclosedThink = makeMsg('u3', 'user', '文件里有 <think> 未闭合\n\n其后整段都是正文，绝不能吞')
    const list = [literalTool, pastedBlock, unclosedThink]
    const out = sanitizeMessageList(list)
    expect(out).toEqual(list)
    expect(out[2]!.content).toBe(unclosedThink.content) // 未闭合 <think> 不吞其后正文
  })

  it('F1/F2：system 消息含原始标签 → 逐字保留', () => {
    const sys = makeMsg('s1', 'system', '规则：禁止使用 <tool_call> 伪造调用；参考 <think> 结构')
    expect(sanitizeMessageList([sys])).toEqual([sys])
  })

  it('F1/F2 对偶：assistant 含同样标签内容 → 清理（残片清理语义不变）', () => {
    const assistantMsgs = [
      makeMsg('a1', 'assistant', '请问 <tool_call> 和 <tool_result> 标签的用途？'),
      makeMsg('a2', 'assistant', `${toolCallBlock}\n正文`),
      makeMsg('a3', 'assistant', '半截<think>未闭合'),
    ]
    const out = sanitizeMessageList(assistantMsgs)
    expect(out.map(m => m.id)).toEqual(['a1', 'a2', 'a3'])
    expect(out[0]!.content).toBe('请问  和  标签的用途？')
    expect(out[1]!.content).toBe('\n正文')
    expect(out[2]!.content).toBe('半截')
  })
})

// ===== 单条消息级净化 =====

describe('sanitizeAgentMessage', () => {
  it('无残片消息原引用返回；streaming:true 非空消息清 flag 保留正文', () => {
    const clean = makeMsg('a1', 'assistant', '正文')
    expect(sanitizeAgentMessage(clean)).toBe(clean)
    const stale = makeMsg('a2', 'assistant', '半截', { streaming: true })
    const out = sanitizeAgentMessage(stale)!
    expect(out.streaming).toBe(false)
    expect(out.content).toBe('半截')
  })

  it('F1/F2：user 含标签消息原引用返回（正文零触碰，不建新对象）', () => {
    const u = makeMsg('u1', 'user', '<think>未闭合\n\n其后整段正文不能吞')
    expect(sanitizeAgentMessage(u)).toBe(u)
  })
})

// ===== Checkpoint 净化 =====

const makeRun = (over: Record<string, unknown> = {}) => ({
  id: 'run-1',
  type: 'chapter_creation',
  title: '第 1 章创作',
  status: 'running',
  currentStepIndex: 1,
  createdAt: '2026-08-29T00:00:00.000Z',
  steps: [
    {
      id: 's1', name: '写稿', description: '', status: 'completed',
      result: '第一章正文…', logs: ['[10:00:00] 开始'], completedAt: '2026-08-29T00:01:00.000Z',
    },
    {
      id: 's2', name: '修稿', description: '', status: 'running',
      result: '修稿中…', logs: [], startedAt: '2026-08-29T00:02:00.000Z',
    },
  ],
  ...over,
})

describe('sanitizeCheckpointData', () => {
  it('合法干净 checkpoint 结构保真（result/logs/waitingRuns/savedAt 逐字不变）', () => {
    const cp = {
      activeRuns: [makeRun()],
      waitingRuns: { 'run-1': { waitingForConfirm: true, waitingAfterStepIndex: 0 } },
      savedAt: '2026-08-29T00:03:00.000Z',
    }
    const out = sanitizeCheckpointData(cp)
    expect(out).not.toBeNull()
    expect(out!.activeRuns).toEqual(cp.activeRuns)
    expect(out!.waitingRuns).toEqual(cp.waitingRuns)
    expect(out!.savedAt).toBe(cp.savedAt)
  })

  it('steps[].result/error/logs 中 think/tool 残片被清理（LLM 中途崩溃的半截文本）', () => {
    const run = makeRun({
      steps: [
        { id: 's1', name: 'a', description: '', status: 'completed', result: '<think>思考</think>正文', logs: ['<think>x</think>日志', '正常日志'], completedAt: 'x' },
        { id: 's2', name: 'b', description: '', status: 'failed', error: `失败<tool_call>{"name":"x"}</tool_call>`, logs: [], completedAt: 'y' },
        { id: 's3', name: 'c', description: '', status: 'running', result: toolCallBlock + '\n未闭合<think>', logs: [], startedAt: 'z' },
      ],
    })
    const out = sanitizeCheckpointData({ activeRuns: [run], waitingRuns: {}, savedAt: '' })
    const steps = out!.activeRuns[0]!.steps
    expect(steps[0]!.result).toBe('正文')
    expect(steps[0]!.logs).toEqual(['日志', '正常日志'])
    expect(steps[1]!.error).toBe('失败')
    expect(steps[2]!.result).toBe('\n未闭合')
  })

  it('非对象/activeRuns 非数组 → null（损坏 checkpoint 不崩，按无 checkpoint 处理）', () => {
    expect(sanitizeCheckpointData(null)).toBeNull()
    expect(sanitizeCheckpointData('str')).toBeNull()
    expect(sanitizeCheckpointData({ activeRuns: 'bad' })).toBeNull()
    expect(sanitizeCheckpointData({ activeRuns: [{ id: 1, steps: [] }] })).not.toBeNull()
  })

  it('run 缺 string id / steps 非数组 → 丢弃该 run；step 非对象 → 丢弃', () => {
    const cp = {
      activeRuns: [
        { id: 'ok', type: 'x', title: 't', status: 'running', currentStepIndex: 0, createdAt: 'c', steps: [{ id: 's', name: 'n', description: '', status: 'pending', logs: ['l'], result: 123 }, 'bad-step', null] },
        { type: 'no-id', steps: [] },
        { id: 'no-steps', status: 'running' },
        'bad-run',
        null,
      ],
      waitingRuns: {},
      savedAt: '',
    }
    const out = sanitizeCheckpointData(cp)!
    expect(out.activeRuns).toHaveLength(1)
    expect(out.activeRuns[0]!.id).toBe('ok')
    expect(out.activeRuns[0]!.steps.map(s => s.id)).toEqual(['s'])
    // result 非字符串保留原值不强行转换（防御不做类型改写）
    expect(out.activeRuns[0]!.steps[0]!.result).toBe(123)
  })

  it('logs 非数组 → 置空；waitingRuns 非对象/坏值 → 空或字段归一化；savedAt 非 string → 空串', () => {
    const cp = {
      activeRuns: [makeRun({ steps: [{ id: 's1', name: 'n', description: '', status: 'completed', result: 'ok', logs: 'bad' }] })],
      waitingRuns: { good: { waitingForConfirm: true, waitingAfterStepIndex: 1 }, bad: 'x', bad2: { waitingForConfirm: 'yes', waitingAfterStepIndex: 'nope' } },
      savedAt: 42,
    }
    const out = sanitizeCheckpointData(cp)!
    expect(out.activeRuns[0]!.steps[0]!.logs).toEqual([])
    expect(out.waitingRuns).toEqual({
      good: { waitingForConfirm: true, waitingAfterStepIndex: 1 },
      bad2: { waitingForConfirm: false, waitingAfterStepIndex: -1 },
    })
    expect(out.savedAt).toBe('')
  })

  it('L2 v2：保留 runDefs/contextData 重建信息（non-null 纯对象才带，坏值省略）', () => {
    const runDefs = { 'run-1': { type: 'post_process', params: { seed: 'x' } } }
    const contextData = { 'run-1': { shared: 'ctx' } }
    const out = sanitizeCheckpointData({ activeRuns: [makeRun()], waitingRuns: {}, savedAt: '', runDefs, contextData })!
    expect(out.runDefs).toEqual(runDefs)
    expect(out.contextData).toEqual(contextData)

    // 非对象/数组 → 省略（shape 防御不带上坏值）
    const bad = sanitizeCheckpointData({ activeRuns: [makeRun()], waitingRuns: {}, savedAt: '', runDefs: 'x', contextData: [] })
    expect(bad!.runDefs).toBeUndefined()
    expect(bad!.contextData).toBeUndefined()
  })
})
