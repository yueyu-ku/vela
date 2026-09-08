# L2 工作流 Checkpoint 迁 DB + 跨重启真续跑 实施计划（SDD）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工作流 checkpoint 从 localStorage 迁到每项目 `vela.db` 新表 `workflow_checkpoints`（v17 迁移），并实现**跨重启真续跑（executor 重建）**：持久化 run 的重建信息（type + params 快照 + context.data），恢复时按 type 从 registry 重建 definition 并从断点重放未完成步骤。

**Architecture:** 按设计 `docs/superpowers/specs/2026-09-05-workflow-checkpoint-db-design.md`（定稿 v1，用户已批准）四层落地：① `workflow-registry.ts`（type→factory(params) 重建）+ `WorkflowDefinition.rehydrateParams`；② 执行循环抽 `executeRunFromIndex`（可重入断点重放）；③ `workflow_checkpoints` 表 + v17 迁移 + `WorkflowCheckpointRepository` + IPC `db:checkpoint-save/load/clear`；④ `saveCheckpoint`/`loadCheckpoint`/`restoreCheckpoint` v2（runDefs + contextData 读写、旧 localStorage 兜底迁移、损坏降级、恢复决断：running 立即重放 / waiting 点「继续」重放）。

**Tech Stack:** TypeScript + Zustand + better-sqlite3（Electron）+ vitest + React。零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-05-workflow-checkpoint-db-design.md`
**基线:** master @ `d0a239d`（`git rev-parse HEAD` 应等于 `d0a239d...`）

## Global Constraints

- **v1 范围**（设计 §8）：registry + 执行循环抽取 + 表/迁移 + IPC/Repo + save/load/restore v2 + rehydrate 各 workflow（§5.1 直接注册 + §5.2 三内联重构为工厂）+ 测试。
- **非目标（无任务，任何任务不得触碰）**：`config_generation` 的 rehydrate 注册（params 含 `onGenerated` 组件回调，不可直接重建——恢复走旧兜底，见设计 §2.2/§5.3）；`new_project_setup`/`batch_generate` registry 预留不注册；改变执行引擎其他语义（有限并发、appendText 共享限频调度、M2 输出文件镜像、onComplete 通知行为）；多项目并发 checkpoint 合并；checkpoint 表加 project 维度（每项目一个库天然隔离）。
- **行为兼容优先**：`startWorkflow` 正常路径行为**零变化**（executeRunFromIndex 从 index 0 重放与内联循环等价）；进程内 `stepByStep waiting` 的 `confirmContinue`（内存 resolve）**保持不变**；无 checkpoint / 无 active run 时零可感知影响；`saveCheckpoint` 失败静默（补充通道不阻塞主流程）。
- **C4 净化复用**：`sanitizeCheckpointData` / `cleanupMessageText`（`conversation-recovery.ts`）**只复用不重写**——restore v2 的损坏降级与残片净化走同一函数（L2 迁移不得双写实现）。
- **db-migration-standard 铁律**：`CURRENT_SCHEMA_VERSION` 与迁移段必须**同步递增**（历史事故 f51261c：迁移段加了但版本号没加 → 旧库静默跳过）；新表必须**同时进 createTables 主清单与 migrateExistingTables 段**（否则全新库 user_version=0 走 fresh 分支跳过迁移 → 表永不存在）；每一步幂等 + 非关键 catch → logger.warn；`user_version` 只在全部成功后原子递增。
- **质量门禁**：`node node_modules/typescript/bin/tsc --noEmit`、`node node_modules/eslint/bin/eslint.js <files> --max-warnings 0`、全量 `node node_modules/vitest/vitest.mjs run` 全绿为每个任务收尾硬门槛。
- **环境注意（DSH 实测）**：受限 shell（沙箱）下 vitest/vite config 加载 spawn EPERM → 单测直跑 `node node_modules/vitest/vitest.mjs run <file>`（受限下用临时 `.vitest-min.config.mjs`，gitignored；全量门禁用 danger-full-access 官方复跑，见 Global Constraints 环境注意）；typecheck/eslint 直跑 node 单进程可用。
- **提交规范**：`feat:`/`fix:`/`docs:`/`refactor:` 前缀、一个提交一件事；不提交 `.claude/`、`.codex/`；版本号只在发版时改。
- **i18n**：本档新增用户可见文本须走 `t()` + `TextKey` 严格 union（`TextKey = keyof typeof UI_TEXTS_DATA`）+ 三语齐全（zh-CN/en-US/ru-RU）。checkpoint 迁移相关若引入新 UI 文案，按 i18n-standard。

---

### Task 1: registry + WorkflowDefinition.rehydrateParams

**Files:**
- Modify: `src/stores/workflow-store.ts`（`WorkflowDefinition` 接口 :132-142 加可选 `rehydrateParams?: WorkflowParams`；导出 `WorkflowParams` 类型）
- Create: `src/services/workflows/workflow-registry.ts`
- Create: `src/services/workflows/workflow-registry.test.ts`

**Interfaces:**
- Consumes: 无（纯新建；`WorkflowDefinition`/`WorkflowType` type import）
- Produces（Task 2/5/6 消费，签名锁定）:
  - `export type WorkflowParams = Record<string, unknown>`
  - `export type WorkflowRehydrateFactory = (params: WorkflowParams) => WorkflowDefinition`
  - `export function registerWorkflow(type: WorkflowType, factory: WorkflowRehydrateFactory): void`（重复注册 = 覆盖，或 throw？取覆盖——重启热重载不炸）
  - `export function rehydrateWorkflow(type: WorkflowType, params: WorkflowParams): WorkflowDefinition | null`（未注册 → null）

- [ ] **Step 1: 写失败测试（workflow-registry.test.ts）**

```ts
import { describe, it, expect } from 'vitest'
import { registerWorkflow, rehydrateWorkflow, type WorkflowParams } from './workflow-registry'
import type { WorkflowDefinition } from '../../stores/workflow-store'

// 用 dummy definition 验证 registry 注册/重取/未注册 null；不清空 registry（模块级）——测试用唯一 type 防互扰
describe('workflow-registry（rehydrate 重建，设计 §4.3）', () => {
  it('registerWorkflow + rehydrateWorkflow：按 type 重建 definition', () => {
    const type = 'directory' // 用真实 type 做冒烟（mock 不入 registry 冲突）
    registerWorkflow(type, (p) => ({ type, title: 't', steps: [{ name: 'step', description: 'd', executor: async () => {} }] }))
    const def = rehydrateWorkflow(type, { mode: 'full' })
    expect(def).toBeTruthy()
    expect(def!.type).toBe(type)
    expect(def!.steps).toHaveLength(1)
  })
  it('未注册 type → null（恢复走「不可续跑」兜底）', () => {
    // 用一个不可能注册的 type（@ts-expect-error 不可——直接传任意 string 走运行时）
    const def = rehydrateWorkflow('nonexistent' as never, {})
    expect(def).toBeNull()
  })
  it('factory 参数透传：rehydrate 重建需拿到启动时 params（设计 §4.4 方案 ii）', () => {
    const type = 'novel_import' as const
    let captured: WorkflowParams | null = null
    registerWorkflow(type, (p) => { captured = p; return { type, title: 't', steps: [] } })
    rehydrateWorkflow(type, { chapters: [{ number: 1, title: 'a', content: 'c', wordCount: 1 }] })
    expect(captured).toEqual({ chapters: [{ number: 1, title: 'a', content: 'c', wordCount: 1 }] })
  })
})
```

- [ ] **Step 2: 跑失败**（模块不存在）

Run: `node node_modules/vitest/vitest.mjs run src/services/workflows/workflow-registry.test.ts`
Expected: FAIL——import 解析失败。

- [ ] **Step 3: 实现**

`workflow-registry.ts`：

```ts
import type { WorkflowDefinition, WorkflowType } from '../../stores/workflow-store'

export type WorkflowParams = Record<string, unknown>
export type WorkflowRehydrateFactory = (params: WorkflowParams) => WorkflowDefinition

const registry = new Map<WorkflowType, WorkflowRehydrateFactory>()

export function registerWorkflow(type: WorkflowType, factory: WorkflowRehydrateFactory): void {
  registry.set(type, factory)
}

export function rehydrateWorkflow(type: WorkflowType, params: WorkflowParams): WorkflowDefinition | null {
  const f = registry.get(type)
  return f ? f(params) : null
}
```

`workflow-store.ts` `WorkflowDefinition` 加字段 + 导出类型（`WorkflowParams` 从 workflow-registry 引入会循环依赖（store→registry→store）→ 用 type-only import 或把 `WorkflowParams` 定义在 store 侧）：

```ts
// workflow-store.ts
export type WorkflowParams = Record<string, unknown>
export interface WorkflowDefinition {
  type: WorkflowType
  title: string
  steps: Array<{ name: string; description: string; executor: StepExecutor }>
  onComplete?: WorkflowCompleteAction
  /** L2：可重建参数快照（type + 此 params → rehydrateWorkflow 重建定义；零改动调用点，方案 ii） */
  rehydrateParams?: WorkflowParams
}
```

（`WorkflowParams` 定义在 store 侧，`workflow-registry` 从 store type-only import——避免 store←→registry 运行时循环；`workflow-store` 不 import registry。）

- [ ] **Step 4: 跑测试确认通过**

Run: 上一步命令。Expected: PASS 3 条。

- [ ] **Step 5: 门禁 + 提交**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/services/workflows/workflow-registry.ts src/services/workflows/workflow-registry.test.ts src/stores/workflow-store.ts --max-warnings 0
node node_modules/vitest/vitest.mjs run src/services/workflows/workflow-registry.test.ts src/stores/workflow-store.test.ts
git add src/services/workflows/workflow-registry.ts src/services/workflows/workflow-registry.test.ts src/stores/workflow-store.ts
git commit -m "feat: workflow-registry（type→factory(params) 重建）+ WorkflowDefinition.rehydrateParams（L2 任务1）"
```

---

### Task 2: 执行循环抽取 executeRunFromIndex（断点重放）

**Files:**
- Modify: `src/stores/workflow-store.ts`（把 `startWorkflow` 内联 for 循环 :382-451 抽为模块级 `executeRunFromIndex`；`startWorkflow` 调 `executeRunFromIndex(run, def, 0, {})`；`confirmContinue` :329-344 加「有可重建 definition 的 waiting run → 断点重放」路径）
- Modify: `src/stores/workflow-store.test.ts`（断点重放用例；现有 startWorkflow 正常路径回归）——若 store 测试现有 mock 需补 executeRunFromIndex 相关

**Interfaces:**
- Consumes: Task 1 `WorkflowDefinition.rehydrateParams`（confirmContinue 重放用）
- Produces（Task 5 restore 消费，签名锁定）:
  - `async function executeRunFromIndex(run: WorkflowRun, definition: WorkflowDefinition, startIndex: number, contextData: Record<string, unknown>): Promise<void>`
  - 内部：`const context = { data: contextData, cancelled: false }`；`activeContexts.set(run.id, context)`；从 `startIndex` 起逐 step（复用原 :390-451 逻辑——步骤状态更新 / callbacks / stepByStep waiting / 完成判定 / onComplete / 入历史 / 清理）

- [ ] **Step 1: 写失败测试（断点重放契约）**

在 `workflow-store.test.ts` 追加 describe（复用现有 mkDefinition helper 若有；无则建 `mkDef(steps)`）：

```ts
describe('executeRunFromIndex（断点重放，L2 任务2）', () => {
  it('从 startIndex 重放：跳过已完成步骤，只重放 startIndex 及之后', async () => {
    const seen: string[] = []
    const def: WorkflowDefinition = {
      type: 'post_process', title: 't',
      steps: [
        { name: 'a', description: 'a', executor: async () => { seen.push('a'); return 'a' } },
        { name: 'b', description: 'b', executor: async () => { seen.push('b'); return 'b' } },
        { name: 'c', description: 'c', executor: async () => { seen.push('c'); return 'c' } },
      ],
      rehydrateParams: { autoFill: false },
    }
    // mock 一个已执行到 step0 完成、currentStepIndex=1 的 run
    const run: WorkflowRun = { id: 'r1', type: 'post_process', title: 't', status: 'running', currentStepIndex: 1, createdAt: '', steps: [
      { id: 's0', name: 'a', description: 'a', status: 'completed', result: 'a', logs: [] },
      { id: 's1', name: 'b', description: 'b', status: 'pending', logs: [] },
      { id: 's2', name: 'c', description: 'c', status: 'pending', logs: [] },
    ] }
    // executeRunFromIndex 是模块级导出？不导出——经 startWorkflow 断言不可达（其内部自建 run）。
    // 白盒：直接把 executeRunFromIndex 导出测试（Task 2 起导出，供 Task 5 restore 白盒 + 单测）
    const { executeRunFromIndex, useWorkflowStore } = await import('./workflow-store')
    useWorkflowStore.setState({ activeRuns: [run], waitingRuns: {} })
    await executeRunFromIndex(run, def, 1, {})
    expect(seen).toEqual(['b', 'c'])  // a 不重跑
  })
})
```

> 说明：给 `executeRunFromIndex` 加 `export`（Task 5 restore + 单测白盒用）。若测试对 run 状态/入历史断言敏感，以「seen 数组含 b/c 且不含 a」为契约核心（重放精确性），其余状态断言放宽。

- [ ] **Step 2: 跑失败**（executeRunFromIndex 未导出）

- [ ] **Step 3: 实现（抽取 + export）**

把 :382-451 循环主体迁入 `executeRunFromIndex`（从 `const stepDef = definition.steps[i]` 到循环结束 :451，含 :453-507 的完成判定/入历史/清理），`context` 由 `{ data: contextData, cancelled: false }` 构造，`activeContexts.set(run.id, context)` 重建。`startWorkflow` 尾部改为 `return executeRunFromIndex(run, definition, 0, {})`（消除原内联循环 + 原 :453-507 尾部逻辑——全部进 executeRunFromIndex）。保留 `startWorkflow` 里 run 构建 / addLog / 打开面板 / 建 context（context 移到 executeRunFromIndex 建）。

`confirmContinue`：对「有 rehydrate 能力的 waiting run」增加断点重放路径（Task 5 消费；内存 resolve 保持）：

```ts
confirmContinue: (runId) => {
  const targetId = runId ?? Object.keys(get().waitingRuns).find(id => get().waitingRuns[id]?.waitingForConfirm)
  if (!targetId) return
  // L2：若 run 有可重建定义（rehydrateParams），点「继续」改用断点重放（跨重启 recovery 后 waiting 恢复的续跑路径）
  const continueViaReplay = () => {
    const r = get().activeRuns.find(x => x.id === targetId)
    if (!r) return
    const def = rehydrateWorkflow(r.type, r.rehydrateParams ?? {})
    if (!def) return
    const waitIdx = get().waitingRuns[targetId]?.waitingAfterStepIndex ?? -1
    // 清 waiting 标记 + 置回 running + 断点重放
    // （从 waitingAfterStepIndex + 1 继续）
    void executeRunFromIndex(r, def, waitIdx + 1, activeContexts.get(targetId)?.data ?? {})
  }
  const resolve = continueResolveRefs.get(targetId)
  if (resolve) { resolve(); continueResolveRefs.delete(targetId) }  // 进程内路径（现状）
  else {
    continueViaReplay()  // 跨重启恢复路径（无内存 resolve）
  }
  set(s => { ... })
}
```

> 注：`WorkflowRun` 需加 `rehydrateParams?: WorkflowParams` 字段（Task 5 存；confirmContinue 读）。Task 2 先在 `WorkflowRun` 加该可选字段。`rehydrateWorkflow` 从 `workflow-registry` import（store←registry，运行时 import registry 会回环 registry←store？registry type-only import store，store 运行时 import registry → 循环。改为 store 通过**动态 import** `import('../workflows/workflow-registry').then(m => m.rehydrateWorkflow(...))`（避免静态循环）。）

- [ ] **Step 4: 跑测试确认通过**（断点重放用例 + 现有 startWorkflow 回归全绿）

- [ ] **Step 5: 门禁 + 提交**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/stores/workflow-store.ts src/stores/workflow-store.test.ts --max-warnings 0
node node_modules/vitest/vitest.mjs run src/stores/workflow-store.test.ts src/services/workflows/workflow-registry.test.ts
git add src/stores/workflow-store.ts src/stores/workflow-store.test.ts
git commit -m "refactor: 工作流执行循环抽 executeRunFromIndex（可重入断点重放）+ confirmContinue 跨重启重放路径（L2 任务2）"
```

---

### Task 3: workflow_checkpoints 表 + v17 迁移

**Files:**
- Modify: `electron/database.ts`（`CURRENT_SCHEMA_VERSION` 16→17；`createTables` 加表；`migrateExistingTables` 末尾 v17 段）
- Modify: `electron/database.test.ts`（若有数据库迁移测试）或新建迁移测试——参照现有 database 测试模式；若无，用 `electron/repositories/*.test.ts` 的 mock getProjectDb 模式补充

**Interfaces:**
- Consumes: 无
- Produces（Task 4/5 消费）:
  - 表 `workflow_checkpoints (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER DEFAULT (unixepoch() * 1000))`
  - `CURRENT_SCHEMA_VERSION = 17`

- [ ] **Step 1: 写失败/验证测试（迁移幂等 + 全新库）**

参照现有 database 测试（若有）。核心断言：
- 全新库（user_version=0）：createTables 后 `workflow_checkpoints` 表存在（`sqlite_master` 查）。
- 存量库（user_version=16）：migrateExistingTables 后 user_version=17 且表存在。
- 重复迁移（再跑一次）：表已存在则跳过（幂等），user_version 仍 17。

（若项目无 database 单测基建，此任务以「门禁 + 人工验证 migrate 结构」为主，测试在 Task 4 repo 测试里覆盖表存在性。）

- [ ] **Step 2: 实现**

database.ts：
```ts
// :122
const CURRENT_SCHEMA_VERSION = 17  // was 16（v17：workflow_checkpoints 表——L2 checkpoint 迁 DB）

// createTables :168 内（与其它 CREATE TABLE 并列）：加在 tables 区
    -- ============================================================
    -- 16. workflow_checkpoints — 工作流 checkpoint（每项目一库单行；L2 迁 DB，跨项目隔离）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS workflow_checkpoints (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

// migrateExistingTables :575 末尾（v16 段后）：
  // 17. v17: workflow_checkpoints 表（L2 checkpoint 迁 DB——主清单已有，迁移段幂等补建）
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_checkpoints'").get()
    if (!t) {
      db.exec(`CREATE TABLE IF NOT EXISTS workflow_checkpoints (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER DEFAULT (unixepoch() * 1000)
      )`)
      logger.info('DB', 'v17 迁移: 已创建 workflow_checkpoints')
    }
  } catch (e) {
    logger.warn('DB', `v17 迁移未完成（非关键）: ${e}`)
  }
```

（`ensureSchemaVersion`/:146-155 已含 user_version 递增机制——migrate 成功后 `db.pragma('user_version = 17')` 自动执行。）

- [ ] **Step 3: 门禁 + 提交**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js electron/database.ts --max-warnings 0
node node_modules/vitest/vitest.mjs run electron/repositories/  # 或其相关
git add electron/database.ts
git commit -m "feat: v17 迁移——workflow_checkpoints 表（checkpoint 迁 DB，主清单+迁移段同步，user_version 17）"
```

---

### Task 4: WorkflowCheckpointRepository + IPC 通道

**Files:**
- Create: `electron/repositories/workflow-checkpoint-repository.ts`
- Create: `electron/repositories/workflow-checkpoint-repository.test.ts`
- Modify: `electron/controllers/db-controller.ts`（+3 `ipcMain.handle`）
- Modify: `src/shared/ipc-channels.ts`（+3 通道签名）

**Interfaces:**
- Consumes: Task 3 表 + `getProjectDb`（`electron/database.ts`）
- Produces（Task 5 save/load/restore 消费）:
  - `export class WorkflowCheckpointRepository`
    - `save(stateJson: string): void`（`INSERT INTO workflow_checkpoints(id, state_json, updated_at) VALUES(1, ?, unixepoch()*1000) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`）
    - `load(): string | null`（`SELECT state_json FROM workflow_checkpoints WHERE id = 1`）
    - `clear(): void`（`DELETE FROM workflow_checkpoints WHERE id = 1`）
  - IPC（ipc-channels.ts）:
    - `'db:checkpoint-save': { args: [data: unknown]; return: { success: boolean; error?: string } }`
    - `'db:checkpoint-load': { args: []; return: { success: boolean; data?: unknown; error?: string } }`
    - `'db:checkpoint-clear': { args: []; return: { success: boolean; error?: string } }`

- [ ] **Step 1: 写失败测试（repo，mock getProjectDb 内存库）**

参照 `preference-repository.test.ts` 模式（mock `getProjectDb` 返回内存 `DatabaseSync`）：

```ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'  // 或项目用 tsx/better-sqlite3？—— 参照现有 repo test 的库构造（better-sqlite3）
import { WorkflowCheckpointRepository } from './workflow-checkpoint-repository'

// 若项目用 better-sqlite3：new Database(':memory:')。参照 preference-repository.test.ts 的实际构造。
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
  it('save 幂等（同 id 覆盖，不产生多行）', () => {
    WorkflowCheckpointRepository.save('{"v":1}')
    WorkflowCheckpointRepository.save('{"v":2}')
    expect(WorkflowCheckpointRepository.load()).toBe('{"v":2}')  // 覆盖非追加
  })
})
```

（若项目 repo test 实际用 better-sqlite3 + `globalThis.__testDb` mock，照做。）

- [ ] **Step 2: 跑失败**

- [ ] **Step 3: 实现**

`workflow-checkpoint-repository.ts`：

```ts
import { getProjectDb } from '../database'

export class WorkflowCheckpointRepository {
  static save(stateJson: string): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(
      `INSERT INTO workflow_checkpoints (id, state_json, updated_at) VALUES (1, ?, unixepoch() * 1000)
       ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`
    ).run(stateJson)
  }
  static load(): string | null {
    const db = getProjectDb()
    if (!db) return null
    const row = db.prepare(`SELECT state_json FROM workflow_checkpoints WHERE id = 1`).get() as { state_json: string } | undefined
    return row?.state_json ?? null
  }
  static clear(): void {
    const db = getProjectDb()
    if (!db) return
    db.prepare(`DELETE FROM workflow_checkpoints WHERE id = 1`).run()
  }
}
```

db-controller.ts（revisions 段后加）：

```ts
  // ============================================================
  // checkpoint — 工作流 checkpoint（L2：迁 DB，跨项目隔离）
  // ============================================================
  ipcMain.handle('db:checkpoint-save', async (_event, data: unknown) => {
    try {
      WorkflowCheckpointRepository.save(JSON.stringify(data ?? {}))
      return { success: true }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('db:checkpoint-load', async () => {
    try {
      const raw = WorkflowCheckpointRepository.load()
      return { success: true, data: raw ? JSON.parse(raw) : null }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('db:checkpoint-clear', async () => {
    try {
      WorkflowCheckpointRepository.clear()
      return { success: true }
    } catch (err) { return { success: false, error: String(err) } }
  })
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 门禁 + 提交**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js electron/repositories/workflow-checkpoint-repository.ts electron/repositories/workflow-checkpoint-repository.test.ts electron/controllers/db-controller.ts src/shared/ipc-channels.ts --max-warnings 0
node node_modules/vitest/vitest.mjs run electron/repositories/workflow-checkpoint-repository.test.ts
git add electron/repositories/workflow-checkpoint-repository.ts electron/repositories/workflow-checkpoint-repository.test.ts electron/controllers/db-controller.ts src/shared/ipc-channels.ts
git commit -m "feat: WorkflowCheckpointRepository + db:checkpoint-save/load/clear IPC（L2 任务4）"
```

---

### Task 5: save/load/restore v2（runDefs + contextData + 兜底 + 恢复决断）

**Files:**
- Modify: `src/stores/workflow-store.ts`（`WorkflowRun` 加 `rehydrateParams?`（Task 2 已加）；`CheckpointData` 加 `runDefs?`/`contextData?`；新增模块级 `runDefs = new Map<runId, {type, params}>()`；`saveCheckpoint` → DB 写（含 runDefs + contextData）；`loadCheckpoint` → DB 读；`restoreCheckpoint` v2（rehydrate 重建 + 断点重放决断 + 旧 localStorage 兜底迁移）；`startWorkflow` 时 `runDefs.set(run.id, {type, params: definition.rehydrateParams ?? {}})`）
- Create: `src/stores/workflow-store.checkpoint.test.ts`（checkpoint v2 专项测试：写读回 runDefs/contextData、跨项目隔离、损坏降级、恢复决断）
- Modify: `src/stores/workflow-store.test.ts`（回归）

**Interfaces:**
- Consumes: Task 1 registry、Task 2 executeRunFromIndex、Task 3 表、Task 4 IPC/repo
- Produces:
  - `CheckpointData` v2（`:13-17`）加 `runDefs?: Record<string, { type: WorkflowType; params: WorkflowParams }>` + `contextData?: Record<string, Record<string, unknown>>`
  - `saveCheckpoint(state)` → `void ipc.invoke('db:checkpoint-save', data)`（data = activeRuns/waitingRuns/savedAt/runDefs/contextData；runDefs 从模块级 Map 取、contextData 从 activeContexts 取）
  - `loadCheckpoint()` → `ipc.invoke('db:checkpoint-load').then(r => r?.data ?? null)`（DB 读；空则 localStorage 兜底）
  - `restoreCheckpoint()` v2（见 §4.8 决断）

- [ ] **Step 1: 写失败测试（checkpoint v2 契约）**

`workflow-store.checkpoint.test.ts`（mock `ipc` + 复用 `sanitizeCheckpointData`；参照现有 test 的 ipc mock 方式）：

```ts
// vi.mock('../../services/ipc-client')（用内存 Map 模拟 db:checkpoint-save/load/clear）
describe('workflow-checkpoint v2（L2）', () => {
  it('saveCheckpoint 写 DB：data 含 runDefs + contextData（重建信息）', async () => {
    // 启动一个带 rehydrateParams 的 workflow → saveCheckpoint → 断言 ipc.mock INVENTORY 的 data.runDefs/contextData 存在
  })
  it('restoreCheckpoint v2：rehydrate 重建 + running 自动重放（断点）', async () => {
    // 构造 runDefs + activeRuns(status running,currentStepIndex=1) + contextData 的 checkpoint → restore → executeRunFromIndex 从 currentStepIndex 重放
  })
  it('restoreCheckpoint v2：waiting 恢复为等待确认（不自动跑），confirmContinue 断点重放', async () => {
    // waiting + waitingAfterStepIndex → restore 后 status 保持 waiting；confirmContinue 触发重放
  })
  it('restoreCheckpoint 损坏降级：state_json 非法 JSON / activeRuns 非数组 → 视为无 checkpoint（sanitize 兜底）', async () => {
    // ipc 返回损坏 data → restore 返回 null / 不崩
  })
  it('旧 localStorage 兜底：DB 空时读 localStorage 并迁移写回 DB', async () => {
    // localStorage 有旧 checkpoint、DB 空 → restore 读旧 → 写 DB
  })
})
```

（测试聚焦契约；具体 mock 以 `ipc-client` 现有 mock 模式为准。断点重放断言「已完成步骤不重跑」复用 Task 2 的 seen 数组思路。）

- [ ] **Step 2: 跑失败**（saveCheckpoint 仍写 localStorage）

- [ ] **Step 3: 实现**

关键改造（`workflow-store.ts`）：

```ts
// CheckpointData v2
export interface CheckpointData {
  activeRuns: WorkflowRun[]
  waitingRuns: Record<string, { waitingForConfirm: boolean; waitingAfterStepIndex: number }>
  savedAt: string
  runDefs?: Record<string, { type: WorkflowType; params: WorkflowParams }>
  contextData?: Record<string, Record<string, unknown>>
}

// 模块级重建信息（runId → type+params；startWorkflow 时写入）
const runDefs = new Map<string, { type: WorkflowType; params: WorkflowParams }>()

function saveCheckpoint(state: WorkflowState): void {
  try {
    const active = state.activeRuns.filter(r => r.status === 'running' || r.status === 'waiting' || r.status === 'paused')
    const data: CheckpointData = {
      activeRuns: active,
      waitingRuns: state.waitingRuns,
      savedAt: new Date().toISOString(),
      runDefs: Object.fromEntries(active.map(r => [r.id, runDefs.get(r.id) ?? { type: r.type, params: (r as { rehydrateParams?: WorkflowParams }).rehydrateParams ?? {} }])),
      contextData: Object.fromEntries([...activeContexts].filter(([id]) => active.some(r => r.id === id)).map(([id, ctx]) => [id, ctx.data])),
    }
    if (active.length > 0) {
      void ipc.invoke('db:checkpoint-save', data)
    } else {
      void ipc.invoke('db:checkpoint-clear')
    }
  } catch { /* 静默 */ }
}

function loadCheckpoint(): Promise<CheckpointData | null> {
  return ipc.invoke('db:checkpoint-load')
    .then(r => {
      const data = (r as { success?: boolean; data?: unknown })?.data
      if (data) return sanitizeCheckpointData(data)
      // 兜底：DB 空 → 读旧 localStorage（存量数据迁移）
      try {
        const raw = localStorage.getItem(CHECKPOINT_KEY)
        if (raw) {
          const legacy = sanitizeCheckpointData(JSON.parse(raw))
          if (legacy && legacy.activeRuns.length > 0) void ipc.invoke('db:checkpoint-save', legacy)  // 迁移写回 DB
          return legacy
        }
      } catch { /* ignore */ }
      return null
    })
    .catch(() => null)
}
```

`startWorkflow`：`runDefs.set(run.id, { type: run.type, params: (definition as { rehydrateParams?: WorkflowParams }).rehydrateParams ?? {} })`（在 run 建后、executeRunFromIndex 前）。

`restoreCheckpoint`（:579-608 改写为 async）：见设计 §4.8 决断——sanitize → 对每 run rehydrate → running 立即 `void executeRunFromIndex(...)` / waiting 保持等待（confirmContinue 重放）→ 不可重建走旧兜底（waiting→failed / running→paused）。`hydrateInterruptedOutputs` 保留。

（`loadCheckpoint` 变 async（IPC）；`restoreCheckpoint` 变 async；调用方（应用启动恢复点）改为 await。）

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 门禁 + 提交**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/stores/workflow-store.ts src/stores/workflow-store.checkpoint.test.ts --max-warnings 0
node node_modules/vitest/vitest.mjs run src/stores/workflow-store.checkpoint.test.ts src/stores/workflow-store.test.ts
git add src/stores/workflow-store.ts src/stores/workflow-store.checkpoint.test.ts
git commit -m "feat: checkpoint 迁 DB——save/load/restore v2（runDefs+contextData 重建信息、旧 localStorage 兜底迁移、损坏降级、恢复决断 running 重放/waiting 点继续）（L2 任务5）"
```

---

### Task 6: rehydrate 各 workflow（§5.1 直接注册 + §5.2 三内联重构 + config_generation 不注册）

**Files:**
- Modify: `src/services/workflows/architecture-workflow.ts`（createArchitectureWorkflow/createConfigGenerationWorkflow 附 rehydrateParams——后者**不注册**）
- Modify: `src/services/workflows/chapter-workflow.ts`（6 工厂附 rehydrateParams + 注册）
- Modify: `src/services/workflows/directory-workflow.ts`、`import-workflow.ts`、`mutual-evaluation-workflow.ts`、`verification-workflow.ts`（各 create*Workflow 附 rehydrateParams + 注册）
- Modify（§5.2 内联重构为工厂）: 重命名/包裹 `runCharacterArchive`→`createCharacterArchiveWorkflow`、`runArchCharacterExtract`→`createArchCharacterExtractWorkflow`、`repairArchCharacterCards`→`createRepairArchCharacterCardsWorkflow`（返回 `WorkflowDefinition` + 附 `rehydrateParams`；更新现有调用点）
- Modify: `src/services/workflows/workflow-registry.ts`（同文件末尾注册各工厂——或新建 `workflow-registry-init.ts` 汇总注册，避免各 workflow 文件互相 import 循环）
- Create: `src/services/workflows/workflow-rehydrate.test.ts`（每工厂 rehydrateWorkflow 重建 definition steps 名称/数量一致）

**Interfaces:**
- Consumes: Task 1 registry + `WorkflowDefinition.rehydrateParams`
- Produces: rehydrateWorkflow(type, params) 对 §5.1/§5.2 全部可重建 workflow 返回等价 definition；config_generation 返回 null（未注册）

- [ ] **Step 1: 写失败测试（workflow-rehydrate.test.ts）**

```ts
import { describe, it, expect } from 'vitest'
import { rehydrateWorkflow } from './workflow-registry'
// 引入注册副作用（若注册在单独 init 模块，import 它）
import './workflow-registry-init'

describe('workflow rehydrate（重建 definition，L2 任务6）', () => {
  const table: Array<[type, params]> = [
    ['architecture_generation', { selectedSteps: ['premise', 'synopsis'], stepGuidance: { premise: 'x' } }],
    ['chapter_creation', { chapterNumber: 3, title: 't', role: 'r', purpose: 'p', characters: ['c'], keyEvents: '' }],
    ['directory', { mode: 'full' }],
    ['novel_import', { chapters: [{ number: 1, title: 'a', content: 'c', wordCount: 1 }] }],
    ['post_process', { autoFill: false }],
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
  it('§5.2 三内联重构为工厂后可重建（post_process）', () => {
    const d1 = rehydrateWorkflow('post_process' as never, { projectPath: '/x', nameFilter: undefined })
    // 三个 post_process 工厂 type 相同 → 以 rehydrateParams 判别；至少 registers 到 post_process 且可重建
    expect(d1).toBeTruthy()
  })
})
```

- [ ] **Step 2: 跑失败**

- [ ] **Step 3: 实现**

- 各 `create*Workflow` 返回 definition 时附 `rehydrateParams`（= 其入参 params 的可序列化子集；`config_generation` 因含 `onGenerated` 函数**不附 rehydrateParams 且不注册**）。
- §5.2 三内联：现 `run*` 函数（fire-and-forget void）改造为返回 `WorkflowDefinition` 的工厂 + 附 rehydrateParams；现有调用点改为 `useWorkflowStore.getState().startWorkflow(createXxxWorkflow(...))`。
- 注册汇总：新建 `src/services/workflows/workflow-registry-init.ts`（import 各工厂 + `import { registerWorkflow }`）+ 注册；`workflow-registry.ts` 保持纯 registry（不含业务注册，避免 import 循环）。init 模块在应用入口（main.tsx / agent 初始化）import 一次，或各工厂文件直接自注册（但可能模块未加载）。**取 init 专门模块 + 入口 import**（或 registry 静态注册进各文件顶层——权衡循环：各 workflow 文件顶层 `registerWorkflow(type, p => createXxx(p))` 需要 import registry，而 registry type-only import store；workflow 文件已 import store 的 type——无运行时循环风险，可在各文件顶层自注册。**取各文件顶层自注册**，避免另建 init 模块漏注册；测试 import 对应文件即带副作用）。）

- `architecture-workflow.ts`：
```ts
import { registerWorkflow, type WorkflowParams } from './workflow-registry'
// createArchitectureWorkflow 返回前加 rehydrateParams
registerWorkflow('architecture_generation', (p) => createArchitectureWorkflow(p as ArchitectureWorkflowParams))
// 其余工厂同理；config_generation 不注册
```

- [ ] **Step 4: 跑测试确认通过**（rehydrate 表全绿；若真实 factory 对 params 校验严格需校准 params 构造）

- [ ] **Step 5: 门禁 + 提交**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js src/services/workflows/*.ts --max-warnings 0
node node_modules/vitest/vitest.mjs run src/services/workflows/workflow-rehydrate.test.ts
git add src/services/workflows/
git commit -m "feat: 各 workflow 附 rehydrateParams + registry 注册（§5.1 直注 + §5.2 三内联重构为工厂；config_generation 降级不注册）（L2 任务6）"
```

---

### Task 7: 全量门禁 + i18n 完整性 + 已知限制登记

**Files:**
- Verify: `src/stores/workflow-store.ts`、`src/services/workflows/*`、`electron/database.ts`、`electron/controllers/db-controller.ts`、`src/shared/ipc-channels.ts`（i18n 残留扫描——本档新增用户可见文本极可能无，验证即可）
- Verify: 全量测试 / typecheck / lint
- Docs: 设计 §7 已知限制对照（config_generation 降级、context.data 重放不自动回滚、new_project_setup/batch_generate 预留）

- [ ] **Step 1: i18n 完整性核对**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js . --ext ts,tsx --max-warnings 0   # 受限环境改逐文件跑受改文件
grep -rn "'[^']*[\u4e00-\u9fa5][^']*'" src/stores/workflow-store.ts src/services/workflows electron/controllers/db-controller.ts electron/database.ts   # 直文中不能有未走 t() 的用户可见文本
```
Expected: 本档无新增用户可见文本（全部既有/内部）；若新增须三语 + TextKey。

- [ ] **Step 2: 全量门禁（官方复跑）**

```bash
node node_modules/vitest/vitest.mjs run
```
Expected: 全绿（基线 1141 + 本档新增）。断言附真实输出（`Test Files N passed`）。

- [ ] **Step 3: 已知限制登记 + 提交（若有补强）**

若 Task 1-6 无漏，本任务结束 = L2 全量交付。提交若补强。

---

## Self-Review 记录

**① Spec/设计六条覆盖**：
- 迁 DB + v17 → Task 3/4/5
- 旧 localStorage 兜底迁移 → Task 5
- 跨项目隔离 → Task 3（每项目库）+ Task 4 repo
- 损坏降级 → Task 5（sanitize 复用）+ Task 1 registry null 兜底
- 跨重启真续跑（executor 重建）→ Task 1 registry + Task 2 executeRunFromIndex + Task 5 restore 决断 + Task 6 rehydrate 各 workflow
- 测试（迁移幂等/写读回/隔离/降级/rehydrate/断点重放）→ Task 1/2/4/5/6 各任务测试

**② 占位符扫描**：无 TBD/TODO；各 Task 给出关键代码/测试契约。

**③ 跨任务类型/签名一致性**：
- `WorkflowParams`/`WorkflowRehydrateFactory`/`registerWorkflow`/`rehydrateWorkflow`（Task 1）在 Task 2/5/6 引用一致；
- `WorkflowDefinition.rehydrateParams`/`WorkflowRun.rehydrateParams`（Task 1/2）在 Task 5 save 写、Task 6 factories 附、Task 2 confirmContinue 读 一致；
- `executeRunFromIndex(run, def, startIndex, contextData)`（Task 2）在 Task 5 restore/confirmContinue 调用签名一致；
- `CheckpointData.runDefs/contextData`（Task 5）与 IPC `db:checkpoint-save` 的 data 结构一致；
- `WorkflowCheckpointRepository.save/load/clear`（Task 4）被 db-controller IPC（Task 4）与 Task 5 loadCheckpoint 引用一致；
- i18n key：本档新增用户可见文本极少，若有统一走 `t()` + 三语。

**④ 非目标无任务**：config_generation rehydrate（Task 6 明确不注册）、new_project_setup/batch_generate（不注册）、改变执行引擎其他语义（Task 2 仅抽取不改变行为）、checkpoint 表加 project 维度（Task 3 不加）——全部仅声明，无 Task 触碰。
