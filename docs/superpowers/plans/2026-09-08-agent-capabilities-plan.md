# Agent 能力升级：评审 + 排期（A/B/C 四档）

> **Purpose:** 评审 NovelForge Agent 能力的四项升级提议，输出价值/成本/风险评审 + 分档排期，作为后续细化实现计划（SDD）的起点。
> **Status:** 规划草案（2026-09-08）。用户裁定：DSH 插件**移植完整（拉源码学习并自建）**、**全部排期**、**写入本规划文档**。
> **基线:** master @ `f0c2949`（L2 checkpoint 迁 DB 完成）。

## 1. NovelForge Agent 现状矩阵

| 能力 | 现状 | 说明 |
|---|---|---|
| Agent 循环 | **单 agent**（`agent-engine`）循环 + 工具调用 | tool-registry + 20+ 工具 |
| 工具 | 23 个（read/write/edit-file、start-workflow、search-knowledge、read-drafts/blueprint/characters、embed-text、compare-texts、update-config 等） | `RefineParagraphsCommand` 在 **workflow 层**（editor 气泡「润色」用），**未暴露为 agent tool** |
| 记忆 | preferences 表（用户替换偏好）+ 知识库 RAG（向量检索）+ CCR 会话压缩 | **无**跨会话「会学习」长期记忆（hindsight 式：自动保存/召回/知识页/反思/按仓库隔离） |
| 上下文 | context-builder / context-usage / ccr-summary（构建 + token 用量 + 压缩） | **无**可视化 context 面板（分类/演进/压缩事件） |
| 工作流 | workflow-store（DAG 流水线，多任务并发，stepByStep 确认） | 输出到「任务面板」+ M2 输出文件 |
| 模型路由 | 三层预设（`PURPOSE_TIER_MAP` purpose→tier 静态映射 + 用户可配每层模型列表） | 静态路由，非「主 agent 动态决定」 |

## 2. 提议评审

### 提议 1：AI 改写自动调用 RefineParagraphs 等编辑工具
- **现状**：「润色/扩写/精简/风格/冲突」走 editor 气泡方案 = 纯 LLM 流式 + `RefineParagraphsCommand`（段落差异）。不走 agent 工具。
- **价值**：高——AI 改写可控（可读上下文/项目数据）、与 agent 工具链统一、可复用编辑能力。
- **成本/风险**：中高——需 agent↔编辑器**在位归档通道**（agent 结果回写到编辑器 CM 实例）+ 工具封装 + undo/并发语义。
- **技术要点**：分两步（见排期 B 档）——① 把 RefineParagraphs 封装为 agent tool（读选区/段落 + 生成改写 + 返回 diff，低成本）；② 在位编辑流（agent 工具改编辑器内容，复用 L1 inline-accept 的 CM 通道思想，中高成本需设计）。

### 提议 2：Agent 输出样式学习主流 AGENT 工具 + hindsight 长期记忆
- **Agent 输出样式**：NovelForge 已有 XML tool_call/tool_result 协议；可借鉴 DSH 主流 agent 样式（思考/工具/进度分节清晰、终止语义）。低-中成本。
- **hindsight 长期记忆**（@vectorize-io/hindsight-coding-agents v0.5.1）：
  - **行为契约**（运行环境第一手）：知识页（curated 持续更新的项目知识）+ 记忆 bank（git 决策/会话/摄入原始记忆）+ 按仓库隔离 + 自动召回/保存 + 深度反思（过去决策/规则）+ 捕获 initiative（捕获变更中的计划）。
  - **NovelForge 映射**：复用已有 **LanceDB 向量库 + RAG 检索**做记忆存储；新增 knowledge-page 模型（curated 项目知识）；接入 agent context（检索召回注入）；会话完成/提交时自动摄入；反思（跨会话检索）。
  - **移植成本**：**高**——需记忆 bank schema + 知识页模型 + 自动摄入接点 + 检索注入 agent context + 反思触发 + 知识页编辑 UI。DSH 的 hindsight 深度耦合 harness（会话捕获/gitlog/工具注入），NovelForge 需自建这些接点。
  - **风险**：中——记忆质量/漂移（陈旧记忆需纠正机制）、隐私（用户本地即可，NovelForge 本地优先符合）、体积。

### 提议 3：多 AGENT 并发 + 主 AGENT 拆分派发 + 用量统计改 dsh-context 面板
- **多 agent 并发/拆分派发**：
  - NovelForge **当前无**（单 agent + workflow 多任务并发）。要加「主 agent 拆分任务 → 派发子 agent → 回收结果」的编排层（AgentTeams 式）。
  - **行为**：子 agent 生命周期、上下文隔离、独立结果、汇合/评审、失败回收。
  - **成本**：**高**——编排层（任务 DAG 生成、子 agent 调度、结果汇合、评审）、子 agent 上下文管理、并发/取消语义。
  - **风险**：中高——子 agent 质量、上下文成本、结果一致性。
- **dsh-context 上下文洞察面板**（v0.38.5）：
  - **行为**：Context 仪表盘 + /context 命令 + Context 浏览器（分类组成/内容详情/演进趋势/压缩注入事件/统计）。
  - **NovelForge 映射**：复用现有 context-builder / context-usage / ccr-summary 数据（context 分类、token 用量、压缩事件）→ 可视化面板 + 命令。
  - **移植成本**：**中**——面板 UI + 数据聚合（数据已有）；DSH 的 context 面板深度耦合 harness（Session/Service），NovelForge 用现有数据自建面板。
- **「任务 vs 工作流输出」展示归属**：需明确 agent 产物（对话/工具结果）与 workflow 产物（步骤执行/输出文件）的展示边界——见 §5。

### 提议 4：模型路由由主 AGENT 决定 + 多模型 + 自动拉取
- **现状**：三层预设静态路由（elite/standard/budget + purpose→tier 映射，用户可配每层模型列表）。
- **提议**：① 路由策略（可选）改「主 agent 根据任务类型/复杂度动态决定 tier/model」——比静态目的映射更智能；② 用户可添加多模型（已支持模型配置，可能需要 UI 增强加多 model per tier）；③ **自动拉取模型**（从 provider /models 接口拉取的可用模型列表，更新默认模型/候选）。
- **价值**：高（路由智能化 + 模型自动更新，相对独立）。
- **成本**：**中**（相对独立，改动 model-router + 模型配置 UI + provider /models 拉取）。
- **风险**：低——需模型兼容性考量（provider 返回模型可能与 NovelForge 不兼容，需白名单/校验）。

## 3. 排期（档 A/B/C）

### A 档（Quick，独立快速，优先做）
- **提议 4**：模型路由主 agent 决定（可选策略）+ 用户多模型 + 自动拉取/更新默认模型。
- **工作量**：中（model-router 扩展 + provider /models + 设置 UI）。
- **价值**：高；**风险**：低；**依赖**：无（独立）。
- **建议**：最先做（成本低价值高）。可细化为 SDD A 档计划。

### B 档（中，需设计）
- **提议 1 第一步**：RefineParagraphs 封装为 agent tool（读选区 + 生成改写 diff + 返回）。低成本。
- **提议 3 第一步（context 面板低成本路径）**：只做「Current Context 构成」一卡（基于现有 context-builder + usage-store 直构）+ /context 命令。**约 3-5 人日**（dsh-context 全量事件流 25-40 人日留 C 档，见 §4）。
- **「任务 vs 工作流输出」展示归属设计**（§5）。
- **工作量**：中高（B 档主体 = 工具化 + 一卡面板 + 展示归属）；**风险**：中；**依赖**：A 档后的 agent 基建。

### C 档（重，架构级）
- **提议 3 多 agent 拆分派发**：编排层（主 agent 拆任务 → 子 agent → 汇合/评审）。高成本。
- **提议 1 在位编辑流**：agent 工具改编辑器内容（复用 L1 inline-accept CM 通道思想）。中高成本。
- **提议 2 hindsight 长期记忆**：retention/consolidation 引擎 15-25 人日 + harness 接点 3-5 人日（总 ~18-28 人日；关键难点 = 自建「LLM 事实提取→知识页合成」引擎 + 按 project 隔离 + 会话/提交摄入接点）。
- **dsh-context 全量**（若做）：自建规范化会话事件流 + 投影管道 + 9 卡 UI（~25-40 人日；**关键依赖** = 可审计的 NovelForge 规范化会话/文本书写事件流）。
- **Agent 输出样式**（DSH 主流样式）：低-中成本，可穿插 C 档。
- **工作量**：高；**风险**：中高；**依赖**：B 档后的 agent/context 基建。

### 依赖/里程碑
```
A 档（模型路由+自动拉取） ──→ B 档（工具化 + context 面板 + 展示归属）
                                     └──→ C 档（多 agent 拆分 + 在位编辑流 + hindsight 记忆）
```
- A 档独立先行；B 档依赖 A 的 agent 基建成熟；C 档最重最后。

## 4. DSH 插件移植评估（源码级细化，来自源码分析）

> 已拉取 hindsight（v0.5.1）/ dsh-context（v0.46.0）源码到 `.superpowers/sdd/plugin-source-study/` 分析。二者都不是「复制代码能落地」，核心在自建引擎/事件流。

### hindsight-coding-agents（长期记忆）—— 中等难度，约 18-28 人日
- **架构**：client→server 记忆系统，接入层不存记忆，调 HTTP（cloud/self-hosted/daemon 后端）。NovelForge 二选一：①内嵌 server/daemon；②把 retain/recall/reflect **重写到自己的 LanceDB + LLM 路由**（推荐，本地优先，成本低）。
- **harness 适配层极小**（3-5 人日）：`ChatReader`(读会话) + `HarnessAdapter.createRuntime`(绑 hook)。DSH 只绑 4 事件：session-start→seed、pre-step→recall+注入、turn-stopping→写回、ctx.tools→注册 `hindsight_*`。NovelForge 等价接点 = 打开项目(seed) / context-builder 组装 system prompt(recall+注入) / 对话完成保存点(写回) / agent 工具注册。
- **真正成本**（15-25 人日）：LLM 事实提取→归纳→知识页合成 的 **retention/consolidation 引擎**（NovelForge 目前只有 LanceDB 检索 + LLM 路由，需自建）。
- **bank 隔离**：`coding-agent::{gitProject}`（harness 中立、worktree-aware）→ NovelForge 改按 project 隔离。
- **需自建**：记忆 bank schema、知识页模型、自动摄入接点（会话/提交捕获）、recall/reflect 重写到 LanceDB+LLM、知识页编辑 UI、注入 agent context。

### dsh-context（context 面板）—— 高难度（全量约 25-40 人日）
- **深度耦合 DSH**：运行时依赖全是 harness 注入 peer（cordis / dsh-session / dsh-settings / dsh-client-ui-primitives / dsh-token-meter 投影）——NovelForge 全无，需自建整套。
- **关键依赖**：一个可审计的「**NovelForge 规范化会话/文本书写事件流**」（user/assistant/tool/request/header/step/compaction/plan·mode）→ 投影注册表+折叠+推送 → token 构成拆分。
- **自建**：规范化会话事件日志、投影注册表/折叠/推送、token 构成拆分；UI 面板 9 卡（Composition/History/Trend/Browser/Events/File Activity/Agent Network 等）。
- **低成本路径**（3-5 人日）：只做「**Current Context 构成**」一卡，基于现有 context-builder + usage-store 直构（不带事件流）。

## 5. 「任务 vs 工作流输出」展示归属（设计原则）

- **区分**：Agent（agent-store 对话，单 agent 循环，工具调用产物）vs Workflow（workflow-store DAG 流水线，步骤执行 + 输出文件）。
- **归属原则**：
  - **Agent 任务**：诊断/分析/跨数据问答/代码/创意建议等「对话式」产物 → Agent 面板（agent-store 会话流）。
  - **Workflow 输出**：确定性多步流水线（写稿/修稿/审稿/定稿/后处理）→ 任务面板 + 输出文件（workflow-output / M2）。
  - **边界**：agent 触发 workflow（start-workflow tool）→ agent 对话显示「已启动 workflow」，执行细节归任务面板；工具结果摘要归 agent，全量归 workflow 输出。
- **待定**：具体哪些字段显示在哪（agent 工具结果折叠 / workflow 步骤详情）由 B 档展示归属任务细化。

## 6. 非目标 / 风险 / 已知限制

- **非目标**：NovelForge 不直接 npm 安装 DSH harness 插件（耦合 Cordis）；移植 = 自建同能力。
- **风险**：
  - hindsight 记忆漂移（陈旧/错误记忆）→ 需纠正机制（「Correction」文档 + 新事覆盖旧事）。
  - 多 agent 拆分质量/上下文成本 → 需评审/汇合 + 子 agent 上下文预算。
  - 自动拉取模型兼容性 → provider /models 白名单 + 校验。
  - 在位编辑流 undo 语义 → 复用 L1 CM 通道（显式 time/undo 逐级）。
- **已知限制**：A 档模型路由「主 agent 决定」是可选策略，需设计「agent 如何决定 tier」（提示词/规则），避免每次调转成本。

## 7. 下一步

- 按用户优先级（全部排期）→ 建议**先 A 档**：细化为 SDD 计划（model-router 扩展 + provider /models + 设置 UI），worktree + implementer/reviewer 执行。
- hindsight/dsh-context 源码已拉取到 `.superpowers/sdd/plugin-source-study/`（含逐文件分析报告 `plugin-study-report.md`）；实现 B/C 档时可直接参照，无需再拉 D:\Code。
- B/C 档在 A 档后按评审方向细化。

---
*评审 + 排期草案。用户已裁定方向（移植完整 / 全部排期 / 写文档）。*
