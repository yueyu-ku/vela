import type { WorkflowDefinition, WorkflowContext, StepCallbacks, WorkflowStep } from '../../stores/workflow-store'
import { t } from '../../shared/locale'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import { getPromptTemplate } from '../prompt-templates'
import { ipc } from '../ipc-client'
import { stripNameAlias } from '../character-normalize'
import type { NovelConfig } from '../../shared/ipc-channels'

import { runPostProcessPipeline, stripThinkingTags, extractAndRepairJSON, robustParseJSON, stringifyField as stringifyFieldUtils } from './workflow-utils'
import { registerWorkflow } from './workflow-registry'

// ==========================================
// 1. 类型定义
// ==========================================

export interface PartialArchData {
  premise_result?: string
  character_dynamics_result?: string
  character_state_result?: string
  world_building_result?: string
  synopsis_result?: string
}

export interface ArchitectureWorkflowParams {
  selectedSteps?: Array<'premise' | 'characters' | 'worldbuilding' | 'synopsis'>
  /** 每步的补充指导（如 { premise: "多强调金手指的限制" }） */
  stepGuidance?: Record<string, string>
}

export interface ConfigGenerationWorkflowParams {
  idea: string
  totalChapters: number
  wordsPerChapter: number
  onGenerated: (config: Partial<NovelConfig>) => void
}

// ==========================================
// 2. 工作流定义
// ==========================================

export function createArchitectureWorkflow(params: ArchitectureWorkflowParams = {}): WorkflowDefinition {
  const sel = params.selectedSteps ?? ['premise', 'characters', 'worldbuilding', 'synopsis']
  const stepDesc = (key: string, defaultDesc: string) => sel.includes(key as never) ? defaultDesc : t('workflow.stepSkipped')
  // 闭包捕获逐步指导，executor 中注入到 context.data
  const guidance = params.stepGuidance || {}

  const allSteps = [
    {
      name: t('arch.storyPremise'),
      key: 'premise',
      description: stepDesc('premise', t('workflow.archPremiseDesc')),
      executor: async (step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateCoreSeedCommand } = await import('./commands/architecture.command')
        return new GenerateCoreSeedCommand().execute({ step, context, callbacks })
      },
    },
    {
      name: t('arch.characterMap'),
      key: 'characters',
      description: stepDesc('characters', t('workflow.archCharactersDesc')),
      executor: async (step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateCharactersCommand } = await import('./commands/architecture.command')
        return new GenerateCharactersCommand().execute({ step, context, callbacks })
      },
    },
    {
      name: t('arch.worldBuilding'),
      key: 'worldbuilding',
      description: stepDesc('worldbuilding', t('workflow.archWorldDesc')),
      executor: async (step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GenerateWorldBuildingCommand } = await import('./commands/architecture.command')
        return new GenerateWorldBuildingCommand().execute({ step, context, callbacks })
      },
    },
    {
      name: t('arch.plotOutline'),
      key: 'synopsis',
      description: stepDesc('synopsis', t('workflow.archSynopsisDesc')),
      executor: async (step: WorkflowStep, context: WorkflowContext, callbacks: StepCallbacks) => {
        context.data.stepGuidance = guidance
        const { GeneratePlotArchitectureCommand } = await import('./commands/architecture.command')
        return new GeneratePlotArchitectureCommand().execute({ step, context, callbacks })
      },
    },
  ]

  const finalSteps = allSteps.filter(s => sel.includes(s.key as never))

  return {
    type: 'architecture_generation',
    title: t('workflow.generateArch'),
    steps: finalSteps,
    onComplete: { mode: 'silent', message: t('workflow.archDone') },
    rehydrateParams: { selectedSteps: params.selectedSteps, stepGuidance: params.stepGuidance },
  }
}

export function createConfigGenerationWorkflow(params: ConfigGenerationWorkflowParams): WorkflowDefinition {
  return {
    type: 'config_generation',
    title: t('workflow.generateConfig'),
    steps: [
      {
        name: t('workflow.analyzeFill'),
        description: t('workflow.configDesc').replace('{n}', String(params.totalChapters)),
        executor: async (step, context, callbacks) => {
          const { GenerateConfigCommand } = await import('./commands/architecture.command')
          const cmd = new GenerateConfigCommand(params.idea, params.totalChapters, params.wordsPerChapter, params.onGenerated)
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'silent', message: t('workflow.configDone') },
  }
}

// ==========================================
// 3. 工具与指导文本
// ==========================================

export function getPlotStructureGuide(structure: string, totalChapters: number): string {
  const ch20 = Math.round(totalChapters * 0.2)
  const ch25 = Math.round(totalChapters * 0.25)
  const ch50 = Math.round(totalChapters * 0.5)
  const ch75 = Math.round(totalChapters * 0.75)

  switch (structure) {
    case 'heros_journey':
      return `【英雄之旅·十二阶段】（严格按以下阶段组织大纲）\n建议章节分配：全书共 ${totalChapters} 章...` // 为了简洁截断，后台已由架构掌控
    case 'save_the_cat':
      return `【节拍表·十五拍】（严格按以下节拍组织大纲）\n建议章节分配：全书共 ${totalChapters} 章...`
    case 'kishotenketsu':
      return `【起承转合·四段式】（严格按以下四段组织大纲）
建议章节分配：全书共 ${totalChapters} 章
起（约第1章~第${ch25}章，占总篇幅约25%）：介绍世界、角色和日常，建立读者认同
承（约第${ch25 + 1}章~第${ch50}章，占总篇幅约25%）：延续与深化，展现角色关系和冲突苗头
转（约第${ch50 + 1}章~第${ch75}章，占总篇幅约25%）：核心转折，出人意料的变化打破既有格局
合（约第${ch75 + 1}章~第${totalChapters}章，占总篇幅约25%）：收束所有线索，揭示主题，给出结局`
    case 'multi_thread':
      return `【多线叙事】（按多条故事线并行推进的方式组织大纲）
建议章节分配：全书共 ${totalChapters} 章
需要明确以下要素：
1. 主线数量：设定2-4条独立又交织的故事线，每条有独立主角或视角
2. 交汇节点：每条线在第${ch25}章、第${ch50}章、第${ch75}章左右安排交汇碰撞
3. 节奏编排：各线交替出现的节奏，避免某条线长期消失
4. 最终合流：在第${ch75}章前后所有线索开始汇聚，走向统一高潮`
    case 'freeform':
      return `【自由结构】（不限定特定叙事框架，根据故事内容自然编排）
全书共 ${totalChapters} 章。
请根据故事类型和内容特点自行设计最合适的叙事节奏。
核心原则：
1. 保证每10-20章有一个小高潮或悬念释放点
2. 全书应有清晰的开篇建置（前10-15%）和收尾段落（后10-15%）
3. 中段避免节奏单一，适时安排转折点
4. 允许插叙、倒叙、片段式叙事等灵活手法`
    case 'three_act':
    default:
      return `【三幕结构】（严格按以下结构组织大纲）
建议章节分配：全书共 ${totalChapters} 章
第一幕：建置（约第1章~第${ch20}章，占总篇幅约20%）
第二幕：对抗与发展（约第${ch20 + 1}章~第${ch75}章，占总篇幅约55%）
第三幕：高潮与结局（约第${ch75 + 1}章~第${totalChapters}章，占总篇幅约25%）`
  }
}

export function getNarrativePOVLabel(pov: string): string {
  const labels: Record<string, string> = {
    first_person: '第一人称',
    third_limited: '第三人称有限视角',
    third_omniscient: '第三人称全知视角',
    multi_pov: '多视角轮换',
  }
  return labels[pov] || pov
}

// ==========================================
// 4. 角色卡后处理逻辑
// ==========================================

export const ARCH_CHARACTER_SCOPE = 'arch_characters'

/**
 * 从 AI 返回的文本中直接提取角色数据（不依赖 JSON.parse）
 * 解决 AI 生成 JSON 格式不稳定的根本问题
 *
 * 支持格式：
 * - 标准 JSON 数组：[{...}, {...}]
 * - 包裹格式：{ "characters": [...] }
 * - 半结构化文本：每个角色从 "name" 字段开始
 */
export function extractCharactersFromText(text: string): Array<Record<string, unknown>> {
  // 1. 先走统一结构化出口（workflow-utils 的提取/修复引擎，与其余工作流一致）
  const repaired = extractAndRepairJSON(text, false)
  const raw = repaired.parsed ?? robustParseJSON(text, false)
  if (raw) {
    const arr = Array.isArray(raw)
      ? raw
      : (raw as Record<string, unknown>).characters
    if (Array.isArray(arr) && arr.length > 0) {
      const cards = arr.filter((c): c is Record<string, unknown> =>
        !!c && typeof c === 'object' && !!(c as Record<string, unknown>).name)
      if (cards.length > 0) return cards
    }
  }

  // 2. 降级：字符串感知的括号扫描（角色描述含 } 不会提前闭合对象区间，历史事故）
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"' && text[i - 1] !== '\\') inStr = !inStr
    if (inStr) continue
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        objects.push(text.substring(start, i + 1))
        start = -1
      }
    }
  }

  if (objects.length === 0) {
    // 降级：尝试用正则直接提取字段名-值对
    return extractByNamePattern(text)
  }

  const results: Array<Record<string, unknown>> = []

  for (const obj of objects) {
    // 跳过太短的对象（可能不是角色数据）
    if (obj.length < 20) continue

    const card = extractFieldsFromJsonLike(obj)
    if (card && card.name) {
      results.push(card)
    }
  }

  return results.length > 0 ? results : extractByNamePattern(text)
}

/**
 * 从类 JSON 对象字符串中提取字段（容错模式）
 * 使用正则逐个匹配 "field": value 对，容忍格式错误。
 * 主路径（extractFieldsFromJsonLike）与降级路径（extractByNamePattern）共用的单一出口，
 * 防止内联正则副本漂移（降级路径曾漏掉数字/布尔字段）。
 */
export function extractKvFields(objStr: string): Record<string, unknown> {
  const card: Record<string, unknown> = {}

  // 匹配 "name": "value" 的键值对（支持值中带转义引号）
  const kvPattern = /"(\w+)":\s*"((?:[^"\\]|\\.)*)"/g
  let match: RegExpExecArray | null
  while ((match = kvPattern.exec(objStr)) !== null) {
    card[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }

  // 非字符串字段（数字/布尔）——此前只匹配字符串值，age/tier/powerLevel 等数字字段全丢（P2 修复）
  const nonStringPattern = /"(\w+)":\s*(\d+(?:\.\d+)?|true|false|null)/g
  while ((match = nonStringPattern.exec(objStr)) !== null) {
    const v = match[2]
    card[match[1]] = v === 'true' ? true : v === 'false' ? false : v === 'null' ? null : Number(v)
  }

  // 嵌套对象重建：currentState 等嵌套键被上方正则拍平成顶层键（location/powerLevel/...），
  // 检测到 "currentState" 键时回收到 currentState 子对象（P0-1：初始提取 currentState 丢失修复）
  if (!card.currentState && /"currentState"\s*:/.test(objStr)) {
    const st: Record<string, unknown> = {}
    for (const k of ['location', 'powerLevel', 'physicalState', 'mentalState', 'keyItems', 'recentEvents', 'updatedAtChapter']) {
      if (card[k] !== undefined) {
        st[k] = card[k]
        delete card[k]
      }
    }
    if (Object.keys(st).length > 0) card.currentState = st
  }

  // 也匹配 "name" 后面缺冒号时用空格分隔的模式
  if (!card.name) {
    const nameMatch = objStr.match(/"name"\s*[:=]\s*"([^"]+)"/)
    if (nameMatch) card.name = nameMatch[1]
  }

  return card
}

function extractFieldsFromJsonLike(objStr: string): Record<string, unknown> | null {
  const card = extractKvFields(objStr)
  return card.name ? card : null
}

/**
 * 降级方案：当无法找到 JSON 对象结构时，直接用 "name" 关键字分割文本
 */
function extractByNamePattern(text: string): Array<Record<string, unknown>> {
  // 按 "name": 或 "name" : 分割
  const parts = text.split(/"name"\s*:\s*"/)
  const results: Array<Record<string, unknown>> = []

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    const nameEnd = part.indexOf('"')
    if (nameEnd === -1) continue
    const name = part.substring(0, nameEnd)

    // 与主路径共用 extractKvFields（含数字/布尔字段），防正则副本漂移
    const fields = extractKvFields(part)
    // split 后 part 不含 "name" 键（首个双引号前已是名字值），防御性清理避免覆盖显式 name
    delete fields.name
    if (name) results.push({ name, ...fields })
  }

  return results
}
export function createCharacterExtractSteps(_projectPath: string, characterDynamicsContent: string, genre: string) {
  return [
    {
      key: 'extract_character_cards',
      label: t('workflow.extractInitialCards'),
      critical: true,
      executor: async (cb: { appendText: (t: string) => void; log: (m: string) => void }) => {
        const { ArchitecturePromptBuilder } = await import('../prompts/prompt-builder')
        const template = getPromptTemplate('extract_initial_characters')
        if (!template) throw new Error(t('error.templateNotFound').replace('{name}', 'extract_initial_characters'))
        const extractPrompt = new ArchitecturePromptBuilder(template).withCharacterDynamics(characterDynamicsContent).withGenre(genre).build()
        const systemRole = template.systemRole || t('role.dataStructurer')

        const llmStore = useLLMStore.getState()
        cb.appendText(t('log.extractCardsStart'))

        let fullContent = ''
        await new Promise<void>((resolve, reject) => {
          llmStore.generateStream(
            [
              { role: 'system', content: systemRole },
              { role: 'user', content: extractPrompt }
            ],
            {
              onChunk: (chunk) => { fullContent += chunk; cb.appendText(chunk) },
              onDone: () => resolve(),
              onError: (err) => reject(new Error(err))
            },
            undefined,
            { responseFormat: { type: 'json_object' } }
          )
        })

        const cleanedCards = stripThinkingTags(fullContent)
        const rawText = cleanedCards.replace(/```json?\n?/g, '').replace(/```/g, '').trim()

        // 使用正则直接提取角色数据，避免 AI 格式不稳定的 JSON.parse
        const parsedCards = extractCharactersFromText(rawText)

        if (parsedCards.length === 0) {
          throw new Error(t('error.roleDataInvalid').replace('{text}', rawText.slice(0, 200)))
        }

        // 防御：AI 可能将文本字段生成为对象或数组，统一转为字符串（workflow-utils 单一出口）
        const stringifyField = (val: unknown): string => stringifyFieldUtils(val)

        // 构建角色卡数据列表（#34 块 A：role 不在此处 normalize——mergeCharacterCards
        // 内部处理且仅当 LLM 原始值非空才覆盖；写入端剥离括号别名保证主键稳定）
        const characterDataList = assembleCharacterCards(parsedCards, stringifyField)

        // 批量写入（#34 块 A：仅填空合并——已存在角色 LLM 非空字段覆盖、空白保留 DB 现值，
        // 防重跑提取全列覆盖清空手写档案/tags/动态状态）
        const { mergeCharacterCards } = await import('../character-card-merge')
        const stats = await mergeCharacterCards(characterDataList)
        cb.log(t('log.extractCardsDone').replace('{n}', String(stats.saved)))
      },
    },
  ]
}

/**
 * 组装角色卡数据列表（纯函数，可单测）
 *
 * P0-1 修复：currentState（初始位置/境界/道具/心理）此前不在拷贝清单 → 初始状态整体丢失；
 * 现按 LLM 原始对象透传（mergeCardRows/仓库 upsert 负责拍平到 cs_* 列），
 * 并校验为对象形态（LLM 可能输出字符串/数组，防御性丢弃非法形态）。
 */
export function assembleCharacterCards(
  parsedCards: Array<Record<string, unknown>>,
  stringifyField: (val: unknown) => string,
): Array<Record<string, unknown>> {
  const characterDataList: Array<Record<string, unknown>> = []
  for (const card of parsedCards) {
    if (!card.name) continue
    const cleaned: Record<string, unknown> = { name: stripNameAlias(String(card.name)) }
    if (card.role !== undefined && String(card.role).trim() !== '') cleaned.role = String(card.role)
    for (const key of ['gender', 'age', 'appearance', 'personality', 'background', 'abilities', 'motivation', 'relationships', 'arc', 'notes']) {
      if (card[key] !== undefined) cleaned[key] = stringifyField(card[key])
    }
    // v7 标签：LLM 输出数组 → 存 JSON 数组字符串（角色列表 JSON.parse 消费）
    if (card.tags !== undefined) {
      const tags = Array.isArray(card.tags)
        ? card.tags.map(String).filter(Boolean)
        : String(card.tags).split(/[，,、]/).map(s => s.trim()).filter(Boolean)
      if (tags.length > 0) cleaned.tags = JSON.stringify(tags.slice(0, 8))
    }
    // P0-1：初始 currentState 透传（对象形态校验；updatedAtChapter 由 LLM 按模板填 0）
    if (card.currentState !== undefined && card.currentState !== null && typeof card.currentState === 'object' && !Array.isArray(card.currentState)) {
      cleaned.currentState = card.currentState
    }
    characterDataList.push(cleaned)
  }
  return characterDataList
}

export interface ArchCharacterExtractWorkflowParams {
  projectPath: string
  characterDynamicsContent: string
  genre: string
}

/** 架构角色卡后处理 工作流定义工厂（可 rehydrate；§5.2 由 runArchCharacterExtract 重构而来） */
export function createArchCharacterExtractWorkflow(params: ArchCharacterExtractWorkflowParams): WorkflowDefinition {
  const { projectPath, characterDynamicsContent, genre } = params
  const steps = createCharacterExtractSteps(projectPath, characterDynamicsContent, genre)
  return {
    type: 'post_process',
    title: t('workflow.postProcessCards'),
    rehydrateParams: { projectPath, characterDynamicsContent, genre },
    steps: [
      {
        name: t('workflow.extractCards'),
        description: t('workflow.extractCardsDesc'),
        executor: async (_step, _ctx, callbacks) => {
          const { globalEventBus } = await import('../../shared/event-bus')
          const archStatus = await runPostProcessPipeline(projectPath, ARCH_CHARACTER_SCOPE, t('workflow.archCharacterSource'), steps, callbacks)
          if (archStatus.allCriticalPassed) {
            // 角色卡提取成功 → 通过 EventBus 通知 ProjectService 刷新
            globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {})
          } else {
            // 提取失败 → 记录详细错误日志
            const failedStep = steps.find(s => {
              const stepResult = archStatus.steps[s.key]
              return stepResult && !stepResult.ok
            })
            const errMsg = failedStep
              ? `${failedStep.label}: ${archStatus.steps[failedStep.key]?.error || t('status.unknown')}`
              : t('log.extractFailedUnknown')
            callbacks.log(`❌ ${errMsg}`)
            globalEventBus.emit('CHARACTER_EXTRACT_FAILED', { error: errMsg })
            globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {})
          }
        },
      },
    ],
  }
}

/** 架构角色卡后处理 启动入口（fire-and-forget；§5.2 重构后保持原调用签名，可 rehydrate） */
export function runArchCharacterExtract(projectPath: string, characterDynamicsContent: string, genre: string): void {
  import('../../stores/workflow-store').then(async ({ useWorkflowStore }) => {
    await useWorkflowStore.getState().startWorkflow(createArchCharacterExtractWorkflow({ projectPath, characterDynamicsContent, genre }))
  })
}

export interface RepairArchCharacterCardsWorkflowParams {
  projectPath: string
}

/** 修复架构角色卡 工作流定义工厂（可 rehydrate；§5.2 由 repairArchCharacterCards 重构而来） */
export function createRepairArchCharacterCardsWorkflow(params: RepairArchCharacterCardsWorkflowParams): WorkflowDefinition {
  const { projectPath } = params
  return {
    type: 'post_process',
    title: t('workflow.fixCards'),
    rehydrateParams: { projectPath },
    steps: [
      {
        name: t('workflow.retryCards'),
        description: t('workflow.retryCardsDesc'),
        executor: async (_step, _ctx, callbacks) => {
          // charactersArch/genre 运行时 DB/项目解析（§5.2：让工厂重建时同样查库）
          const core = await ipc.invoke('db:project-core-get')
          if (!core?.charactersArch || core.charactersArch.length < 50) throw new Error(t('error.cannotExtractCards'))
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error(t('error.noProject'))
          const steps = createCharacterExtractSteps(projectPath, core.charactersArch, project.novelConfig.genre)
          const { globalEventBus } = await import('../../shared/event-bus')
          const archStatus = await runPostProcessPipeline(projectPath, ARCH_CHARACTER_SCOPE, t('workflow.archCharacterSource'), steps, callbacks, { onlyFailed: true })
          if (archStatus.allCriticalPassed) {
            globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {})
          } else {
            globalEventBus.emit('ARCH_POSTPROCESS_UPDATED', {})
          }
        },
      },
    ],
  }
}

/** 修复架构角色卡 启动入口（async；§5.2 重构后保持原调用签名，可 rehydrate） */
export async function repairArchCharacterCards(projectPath: string): Promise<void> {
  const { useWorkflowStore } = await import('../../stores/workflow-store')
  await useWorkflowStore.getState().startWorkflow(createRepairArchCharacterCardsWorkflow({ projectPath }))
}

// ==========================================
// 5. 顶层自注册（rehydrate 重建，L2 任务6）——文件被 lazy import 时注册即生效
// config_generation 不注册：params 含 onGenerated 函数回调，无法经 (type+serialized params) 重建 → 恢复走兜底
// ==========================================
registerWorkflow('architecture_generation', (p) => createArchitectureWorkflow(p as ArchitectureWorkflowParams))
registerWorkflow('post_process', (p) => createArchCharacterExtractWorkflow(p as unknown as ArchCharacterExtractWorkflowParams))
registerWorkflow('post_process', (p) => createRepairArchCharacterCardsWorkflow(p as unknown as RepairArchCharacterCardsWorkflowParams))

