# L2 工作流 Checkpoint 迁 DB + 跨重启真续跑（executor 重建）设计

> **For agentic workers:** 本设计供 subagent-driven-development / executing-plans 实现。每个 SDD 任务先设计后执行；rehydrate 各 workflow 审计表以 `§5` 为准（由审计 subagent 补全）。

**Status:** 设计中（v1 草案，用户已裁定方案 A = 迁 DB + 完整真续跑）
**范围归属:** 档 3 L2（CC 对比报告剩余项，Task 定义见 `docs/superpowers/plans/2026-08-29-cc-remaining-implementation.md` §五.2）
**基线:** master @ `ee2f730`（L1 全量交付后）

## 1. 背景与问题

当前工作流 checkpoint 存储在 **localStorage**（`workflow-store.ts:10 CHECKPOINT_KEY='vela-workflow-checkpoint'`），存在三组缺陷：

1. **不跨项目隔离** —— localStorage 是全局的，项目 A 启动残留的 checkpoint 会在项目 B 里被恢复（跨项目串数据）。
2. **应用重启后无法真续跑** —— checkpoint 只存 `WorkflowRun` 状态快照，但 `steps[].executor` 是 JS 闭包函数（由各 `create*Workflow(params)` 工厂在启动时动态构造），重启后渲染进程销毁 → 所有闭包消失 → 无法重建执行器。现状 `restoreCheckpoint`（:579-608）只能区分：
   - `waiting`（步进等待确认）：executor 已随进程销毁、`continueResolveRefs`（内存 Map）为空 → **标 failed + 提示重跑**（无法续跑）；
   - `running`（运行中中断）：标 `paused`（用户只能查看、取消后**重新开始**，不是从中断续跑）。
3. **可靠性/容量受限** —— localStorage 受同源策略、清理策略与容量限制；错误路径静默（`try/catch` 吞掉）。

**L2 目标**：把 checkpoint 迁到每项目的 `.novelforge/vela.db` 新表，并**完整实现跨重启真续跑**（方案 A：executor 重建）。

## 2. 目标 / 非目标

### 2.1 目标
- **迁 DB**：checkpoint 存每项目 `vela.db` 的 `workflow_checkpoints` 表（每项目一个库 → 天然跨项目隔离）。
- **v17 迁移**：遵循 db-migration-standard，`CURRENT_SCHEMA_VERSION` 16→17。
- **旧 localStorage 兜底**：存量 checkpoint（localStorage）在 DB 为空时读回并迁移到 DB。
- **损坏降级**：复用 C4 已沉淀的 `sanitizeCheckpointData`（`conversation-recovery.ts:110`），损坏/形状异常 → 按「无 checkpoint」安全处理，不崩启动。
- **跨重启真续跑（executor 重建）**：持久化 run 的**重建信息（type + params 快照 + context.data）**，恢复时按 type 从 registry 调工厂重建 definition，并从**断点 index** 重放未完成步骤。`waiting` 的工作流重启后点「继续」能真正从中断处继续（不再标 failed）。
- **测试**：迁移幂等、写读回、跨项目隔离、损坏降级、rehydrate 重建、断点重放。

### 2.2 非目标（本档不做，登记为已知限制/后续项）
- **不可重建的 workflow（明确清单）**：`config_generation`（`createConfigGenerationWorkflow` —— params 含 `onGenerated` 组件回调，无法仅凭 (type+params) 重建等价回调语义，见 §5.3）。此类**保留现状**（waiting 标 failed、running 标 paused 可取消重跑），不提供 rehydrate 注册，恢复走「可查看/取消重跑」兜底。
- **不改变执行引擎的其他语义**：有限并发、appendText 共享限频调度、M2 输出文件镜像、onComplete 通知——全部保持，仅把「执行循环」抽成可重入函数。
- **不做**多项目并发跑的 checkpoint 合并（每项目单行 id=1，同一项目并发工作流共享一个 checkpoint 快照，与现状一致）。

## 3. 现状关键代码（实现落点）

| 文件 | 现状 | L2 落点 |
|---|---|---|
| `src/stores/workflow-store.ts` | `saveCheckpoint/loadCheckpoint/clearCheckpoint`（localStorage）、`restoreCheckpoint`（C4 sanitize + 分类恢复）、执行循环**内联**在 `startWorkflow`（:382-507，`stepByStep` waiting 用 `continueResolveRefs` 内存 Map） | 抽 `executeRunFromIndex` 可重入；save/load 改走 IPC→DB；restore 改为「rehydrate + 断点重放」 |
| `src/services/agent/conversation-recovery.ts` | `sanitizeCheckpointData`（C4，形状防御 + 残片净化） | 复用，不重写（重放/迁移不得双写实现） |
| `electron/database.ts` | `CURRENT_SCHEMA_VERSION = 16`、`createTables`（:168）、`migrateExistingTables`（:575）、`safeAddColumn`（:558） | 17：+`workflow_checkpoints`（主清单 + 迁移段） |
| `electron/repositories/*` | 统一 `getProjectDb()` 模式（每 repository 类） | 新增 `WorkflowCheckpointRepository` |
| `electron/controllers/db-controller.ts` | `ipcMain.handle('db:xxx', ...)` 模式 | +`db:checkpoint-save/load/clear` |
| `src/shared/ipc-channels.ts` | 通道签名声明 | +3 通道签名（`db:` 前缀落 preload 白名单，无需改 preload） |

## 4. 设计

### 4.1 checkpoint 数据模型（DB 表）

每项目一个 `vela.db` → `workflow_checkpoints` 单行（`id=1`），天然跨项目隔离：

```sql
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER DEFAULT (unixepoch() * 1000)
);
```

- 主清单（createTables）与迁移段（migrateExistingTables v17）**同时**加（db-migration-standard 铁律：全新库 user_version=0 走 fresh 分支，跳过迁移 → 表必须在 createTables 存在）。
- 幂等：`CREATE TABLE IF NOT EXISTS` + 迁移段内 `sqlite_master` 存在性检查（表已存在则跳过）。

### 4.2 CheckpointData v2（扩展重建信息）

```ts
// workflow-store.ts（导出入 conversation-recovery 复用 / L2 迁 DB 复用）
export interface CheckpointData {
  activeRuns: WorkflowRun[]
  waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>
  savedAt: string
  /** 新增 v2（L2 迁 DB 起）：runId → 重建信息（type + 启动时点 params 快照） */
  runDefs?: Record<string, { type: WorkflowType; params: Record<string, unknown> }>
  /** 新增 v2：runId → context.data 快照（executor 跨步骤共享数据；无则省略） */
  contextData?: Record<string, Record<string, unknown>>
}
```

- `saveCheckpoint` 时除 `activeRuns`（已有 run 状态）外，**必须补 `runDefs` + `contextData`**——重建 executor 需要 type + params 快照；跨步骤共享的 `context.data` 需持久化（否则重放时步骤间数据丢失）。
- `runDefs` 的 type 直接取 `WorkflowRun.type`；`params` 取启动 `startWorkflow(definition, params?)` 时传入的可序列化参数（见 §4.4）——**一定要持久化「启动时点」的 params**，而非恢复时重新读 DB（DB 数据可能已变）。

### 4.3 registry（definition 重建）

新建 `src/services/workflows/workflow-registry.ts`：

```ts
import type { WorkflowDefinition, WorkflowType } from '../../stores/workflow-store'

export type WorkflowParams = Record<string, unknown>
export type WorkflowRehydrateFactory = (params: WorkflowParams) => WorkflowDefinition

const registry = new Map<WorkflowType, WorkflowRehydrateFactory>()

/** 注册某工作流类型的一个「可重建」工厂（params 纯数据 → 完整 definition） */
export function registerWorkflow(type: WorkflowType, factory: WorkflowRehydrateFactory): void {
  registry.set(type, factory)
}

/** 恢复时按 type + params 重建 definition；未注册 → null（该 workflow 走「不可续跑」兜底） */
export function rehydrateWorkflow(type: WorkflowType, params: WorkflowParams): WorkflowDefinition | null {
  const f = registry.get(type)
  return f ? f(params) : null
}
```

- 工厂是「参数化重建入口」：现有 `create*Workflow(params)` 若 params 纯数据可序列化，直接包装注册（`registerWorkflow('chapter_creation', p => createChapterWorkflow(p as ChapterInfo))`）；若现有工厂的 params 含函数/组件依赖，须提供**可序列化子集**的重建版本。
- 各 workflow 的具体注册与 params 约束见 §5 审计表。

### 4.4 startWorkflow 传参改造

现状 `startWorkflow(definition, stepByStep?)` 只收 definition（executor 闭包），不存 params。L2 需在启动时把「可重建 params」一并记入 run 的重建信息。两种落地（择一，倾向后者）：

- 方案 i：`startWorkflow(definition, stepByStep?, rehydrateParams?)` —— 调用方在启动时显式传 params。
- 方案 ii（推荐）：definition 增加**可选** `rehydrateParams?: WorkflowParams` 字段；各 `create*Workflow` 在返回 definition 时附带其 params 快照；`startWorkflow` 启动时从 `definition` 取 `runDefs[runId] = { type, params: definition.rehydrateParams }`。**零改动调用点**（所有现有调用点继续 `startWorkflow(createXxxWorkflow(params))`）。

方案 ii 侵入最小，各工厂只需在返回的 definition 上附 `rehydrateParams`。

### 4.5 执行循环抽取（断点重放）

把 `startWorkflow` 内联的 for 循环（:382-451）抽成模块级可重入函数：

```ts
async function executeRunFromIndex(
  run: WorkflowRun,
  definition: WorkflowDefinition,
  startIndex: number,
  contextData: Record<string, unknown>,
): Promise<void>
```

- 内部重建 `context = { data: contextData, cancelled: false }`，`activeContexts.set(run.id, context)`，从 `startIndex` 开始逐 step 执行。
- `startWorkflow` 调 `executeRunFromIndex(run, definition, 0, {})`（行为与现状一致）。
- **恢复续跑**调 `executeRunFromIndex(restoredRun, rehydratedDef, breakpointIndex, ctxData)`：
  - `waiting` 恢复：`breakpointIndex = waitingAfterStepIndex + 1`（等待的下一步开始）；
  - `running` 中断：`breakpointIndex = run.currentStepIndex`（当前步重试——可能半途崩，重放安全；executor 幂等性由各 workflow 保证，L1/CC 已按「可重放」约束）。
- `stepByStep` 的 waiting 机制仍用 `continueResolveRefs`（内存）**仅在本次进程内有效**；跨重启恢复时不再依赖它（恢复即从断点自动重放，无需等内存 resolve）。

### 4.6 IPC 通道

`src/shared/ipc-channels.ts` 增（`db:` 前缀，preload 自动放行，无需改 preload）：

```ts
'db:checkpoint-save': { args: [data: unknown]; return: { success: boolean; error?: string } }
'db:checkpoint-load': { args: []; return: { success: boolean; data?: unknown; error?: string } }
'db:checkpoint-clear': { args: []; return: { success: boolean; error?: string } }
```

`electron/controllers/db-controller.ts` 加 3 个 `ipcMain.handle`（try/catch → {success, error}）。`electron/repositories/workflow-checkpoint-repository.ts`（`getProjectDb()`）提供 `save(stateJson)`/`load()`/`clear()`。

### 4.7 写入策略

`saveCheckpoint(get())`：
```ts
const data: CheckpointData = { activeRuns: active, waitingRuns, savedAt, runDefs, contextData }
// 不再 localStorage，改 IPC 写 DB：
void ipc.invoke('db:checkpoint-save', data)
```
- 保留「无 active run 则清空」语义（clear）。
- write 失败静默（与现状一致，checkpoint 是补充通道，不阻塞主流程）。
- `beforeunload` 保存路径不变（:635-639），只是落点改为 DB。

### 4.8 恢复 + 真续跑流程（restoreCheckpoint v2）

```
1. ipc.invoke('db:checkpoint-load')  → cp 或 null
2. 若 cp == null：读 localStorage 旧 checkpoint（存量兜底）；
   若旧数据存在 → sanitize 后写回 DB（迁移），否则视为无 checkpoint
3. sanitizeCheckpointData(cp)  → 形状防御/净化（C4 复用）
4. 对每个 activeRun r：
   a. const def = rehydrateWorkflow(r.type, cp.runDefs?.[r.id]?.params ?? {})
   b. def 可重建 → 恢复（见下述「恢复决断」），断点 index 由 r 状态决定
   c. def 不可重建（rehydrate 返回 null / runDefs 缺失）→ 兜底：
      waiting → 标 failed + 提示重跑（现状语义）；running → 标 paused（可查看/取消重跑）
5. 更新 store.activeRuns，返回 cp
```

**恢复决断（v1 定：按状态区分）**：
- `running`（执行中中断，非 stepByStep 等待）：**恢复后立即自动重放**——`executeRunFromIndex(r, def, r.currentStepIndex, ctxData)`，UI 实时显示进度（体现「真续跑」）。当前步可能半途崩，重放安全（依赖各 workflow executor 幂等）。
- `waiting`（stepByStep 等待用户确认）：**恢复为「等待确认」状态、不自动跑下一步**——保持 stepByStep 逐步确认语义。用户点「继续」（confirmContinue）才触发断点重放 `executeRunFromIndex(r, def, waitingAfterStepIndex + 1, ctxData)`。此时不再依赖 `continueResolveRefs`（内存），改为「有可重建 definition → 点继续重放」。**
- `hydrateInterruptedOutputs`（M2）保留：重放时已完成的步骤 result 已在 checkpoint；未完成步骤重放会产生新输出文件（`mirrorStepAppend`），无需额外补填。

### 4.9 v17 迁移

```text
CURRENT_SCHEMA_VERSION: 16 → 17
createTables: + CREATE TABLE IF NOT EXISTS workflow_checkpoints (...)
migrateExistingTables 末尾 v17 段:
  try {
    表存在性检查(sqlite_master) → 不存在则 CREATE TABLE IF NOT EXISTS
    logger.info('DB', v17 迁移: 已创建 workflow_checkpoints)
  } catch (e) { logger.warn('DB', `v17 未完成（非关键）: ${e}`) }
db.pragma('user_version = 17')  // 由现有 ensureSchemaVersion 原子机制处理
```

（checkpoint 表无需 old 列搬运/快照，纯新建表；若 v17 还有旧 localStorage → DB 迁写，在 restore 首启时做，非迁移段。）

## 5. 各 workflow 重建审计表（rehydrate 注册决策）

> 来源：审计 subagent（只读侦察 `src/services/workflows/`）。共 **11 个 `create*Workflow` 工厂 + 3 个直接内联 `startWorkflow({...})`**。

### 5.1 可直接注册 rehydrate（params 纯数据 + executor 只依赖 params/store/ipc，**低成本**）

| workflow | type | params（可序列化） | 依赖 context.data | 重建要点 |
|---|---|---|---|---|
| createArchitectureWorkflow | architecture_generation | selectedSteps[] / stepGuidance | 是（stepGuidance） | 低；stepGuidance 进 context.data |
| createChapterWorkflow | chapter_creation | chapterNumber/title/role/purpose/characters[]/keyEvents/suspenseHook/userGuidance/knowledgeQueryHint | 否 | 低 |
| createRefineOnlyWorkflow | chapter_creation | chapterNumber/chapterTitle/draftPath/draftContent/userRefinePrompt? | 否 | 低；onComplete 为空闭包 |
| createRefineFromReviewWorkflow | chapter_creation | +reviewReport/reviewFileName | 否 | 低 |
| createReviewOnlyWorkflow | chapter_creation | +reviewFocus? | 否 | 低 |
| createFinalizeWorkflow | chapter_creation | chapterNumber/chapterTitle/draftPath/draftContent | 否 | 注意 onComplete.openResult 较重（读 DB+编辑器开文件）；由工厂重建，不需持久化闭包 |
| createRepairFinalizeWorkflow | chapter_creation | chapterNumber（单参数） | 否 | 低 |
| createDirectoryWorkflow | directory | mode/startChapter?/count?/pacingGuidance?/generationMode?/batchChapterCount? | 是（architecture/existingBlueprints/newBlueprints） | 低；必须持久化 context.data |
| createImportWorkflow | novel_import | chapters[]（ImportedChapter[]） | 否（step2-4 无依赖） | 低；chapters 体量大（整本正文，持久化开销） |
| createMutualEvaluationWorkflow | post_process | draftId/draftContent/chapterNumber | 是（reviewerOutputs） | 低；必须持久化 context.data |
| createVerificationWorkflow | post_process | autoFill? | 是（blueprints/gaps/architecture） | 低；必须持久化 context.data |

### 5.2 需先重构为工厂才能注册（现为直接内联/void，但闭包只依赖纯数据 + DB/store，包裹即可重建）

| 现入口 | type | params | 重构动作 |
|---|---|---|---|
| runCharacterArchive(projectPath, nameFilter?) | post_process | projectPath/nameFilter | 包裹为 `createCharacterArchiveWorkflow({projectPath, nameFilter})` |
| runArchCharacterExtract(projectPath, characterDynamicsContent, genre) | post_process | 3 个 string | 包裹为 `createArchCharacterExtractWorkflow({projectPath, characterDynamicsContent, genre})` |
| repairArchCharacterCards(projectPath) | post_process | projectPath（charactersArch/genre 运行时 DB 解析） | 包裹为工厂；把 charactersArch/genre 在执行前解析并并入 params，或让工厂重建时同样查库 |

### 5.3 不可直接重建（params 含函数回调）→ 进入 §2.2 非目标

| workflow | type | 原因 |
|---|---|---|
| createConfigGenerationWorkflow | config_generation | params 含 `onGenerated: (config) => void`（来自 GenerateConfigDialog 的组件回调，写 project store）；纯 (type+serialized params) 无法重建等价回调语义 → **恢复走兜底**（waiting→failed、running→paused 可取消重跑） |

### 5.4 类型无工厂（registry 预留，不注册）

`new_project_setup`、`batch_generate`（`batch_generate` 仅被 `DirectoryConfigDialog.isTypeRunning('batch_generate')` 查询，无实际工作流定义）。

### 5.5 横切要求（审计强调）

- **`WorkflowContext.data` 必须持久化**（§4.2 `contextData`）：directory / mutual-eval / verification / architecture 的**后置步骤依赖前置步骤写入的 `context.data`**（architecture.existingBlueprints/newBlueprints/reviewerOutputs/blueprints/gaps/stepGuidance）。仅 (type+params+index) 重建 definition 还原不了断点时的 context.data → 从中间恢复必失败。**这是方案 A 的硬前提**：`saveCheckpoint` 必须随 run 一起存 `context.data`，恢复时注入 `executeRunFromIndex` 的 `contextData`。
- `onComplete.openResult` 是闭包，但由工厂重建时重新生成（依赖仅 params + store/ipc 单例），**无需持久化**。

## 6. 测试策略

- **迁移**：v16→v17 升级（全新库 + 存量库）、重复启动幂等（表存在跳过）、user_version 原子递增到 17。
- **写读回**：save → load 数据一致（含 runDefs/contextData）。
- **跨项目隔离**：项目 A 写 checkpoint，项目 B 库 load 为空（两个独立库）。
- **损坏降级**：state_json 为非法 JSON / activeRuns 非数组 → sanitize 返回 null → 视为无 checkpoint，不崩启动。
- **rehydrate 重建**：每可重建 workflow，`rehydrateWorkflow(type, params)` 返回的 definition 与原 definition 的 steps 名称/数量一致（executor 语义等价由各 workflow 单测保证）。
- **断点重放**：构造一个「已执行到 step 2、断点在 step 3」的 checkpoint → restore 后 executeRunFromIndex 从 step 3 重放，step 1-2 不重复执行。
- **回归**：workflow-store 现有测试（file-output.test 等）、startWorkflow 正常路径、stepByStep waiting 进程内 confirmContinue 不变。

## 7. 已知限制（登记，不修）

- 不可重建 workflow（§5 清单）：跨重启不续跑（waiting→failed 提示重跑 / running→paused 可取消重跑）——与现状一致。
- context.data 幂等性：重放时已完成的副作用（如已写 DB 的步骤）不自动回滚；重放安全性依赖各 workflow executor 幂等（CC 档已按此约束实现）。
- `stepByStep waiting` 进程内 confirmContinue 内存态不变；仅跨重启恢复走「即时重放」，不再要求内存 resolve。

## 8. 实现任务拆分（计划档）

（见配套 `docs/superpowers/plans/2026-09-05-workflow-checkpoint-db-plan.md`——SDD 任务：T1 registry + workflow-registry 类型，T2 执行循环抽取（executeRunFromIndex 可重入 + breakpointIndex），T3 checkpoint 表 + v17 迁移，T4 IPC（db:checkpoint-save/load/clear）+ WorkflowCheckpointRepository，T5 save/load/restore v2（runDefs + contextData 读写、旧 localStorage 兜底迁移、损坏降级、恢复决断 running 自动重放 / waiting 点继续），T6 rehydrate 各 workflow（§5.1 直接注册 + §5.2 三个内联重构为工厂 + 附 rehydrateParams 到 definition + config_generation 降级不进 registry），T7 测试 + 门禁）

---
*设计定稿 v1（审计 subagent 已回报，§4.8 决断点与 §5 审计表已落定）。*
