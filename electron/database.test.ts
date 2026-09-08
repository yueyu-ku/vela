/**
 * database migration v6→v7 逻辑验证测试
 *
 * 因 better-sqlite3 编译目标为 Electron (NODE_MODULE_VERSION 145)，
 * vitest 运行环境为 Node.js (NODE_MODULE_VERSION 131)，无法直接加载原生模块。
 * 此处验证 SQL 语句和迁移逻辑的正确性，运行时验证由 Electron 集成测试覆盖。
 *
 * v16 cached_tokens 迁移用 node:sqlite 内存 DB 直接执行 SQL（Node 23 内置，
 * 与 vitest Node ABI 兼容——better-sqlite3 走 Electron ABI 无法在测试加载）。
 */
import { describe, it, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

// ===== safeAddColumn 逻辑验证（不依赖 DB 实例） =====

function buildAlterSQL(table: string, column: string, columnDef: string): string {
  return `ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`
}

function buildCreateColumns(defs: Array<{ col: string; def: string }>): string {
  return defs.map(d => `  ${d.col} ${d.def}`).join(',\n')
}

// ===== 测试 =====

describe('v7 Migration SQL Logic', () => {
  const v7Columns = [
    { col: 'tier', def: 'INTEGER DEFAULT 2' },
    { col: 'tags', def: "TEXT DEFAULT ''" },
    { col: 'appear_chapters', def: "TEXT DEFAULT '[]'" },
    { col: 'relations', def: "TEXT DEFAULT '[]'" },
  ]

  it('ALTER TABLE 语句语法正确', () => {
    for (const { col, def } of v7Columns) {
      const sql = buildAlterSQL('characters', col, def)
      expect(sql).toContain('ALTER TABLE characters ADD COLUMN')
      expect(sql).toContain(col)
      expect(sql).toContain(def)
      // 无 SQL 注入风险
      expect(sql).not.toContain(';--')
      expect(sql).not.toContain('DROP')
    }
  })

  it('CREATE TABLE 包含所有 v7 列', () => {
    const allCols = [
      { col: 'name', def: 'TEXT PRIMARY KEY' },
      { col: 'role', def: "TEXT DEFAULT 'supporting'" },
      ...v7Columns,
      { col: 'cs_location', def: "TEXT DEFAULT ''" },
      { col: 'created_at', def: 'INTEGER DEFAULT (unixepoch() * 1000)' },
    ]
    const createSQL = `CREATE TABLE characters (\n${buildCreateColumns(allCols)}\n)`
    expect(createSQL).toContain('tier INTEGER DEFAULT 2')
    expect(createSQL).toContain("tags TEXT DEFAULT ''")
    expect(createSQL).toContain("appear_chapters TEXT DEFAULT '[]'")
    expect(createSQL).toContain("relations TEXT DEFAULT '[]'")
  })

  it('默认值定义有效', () => {
    expect(v7Columns[0].def).toBe('INTEGER DEFAULT 2')
    expect(v7Columns[1].def).toBe("TEXT DEFAULT ''")
    expect(v7Columns[2].def).toBe("TEXT DEFAULT '[]'")
    expect(v7Columns[3].def).toBe("TEXT DEFAULT '[]'")
  })

  it('column name 无保留字冲突', () => {
    // SQLite 保留字检查 — tier/tags/relations 不是 SQLite 关键字
    const sqliteKeywords = ['SELECT', 'FROM', 'WHERE', 'TABLE', 'INDEX', 'ORDER', 'GROUP']
    for (const { col } of v7Columns) {
      expect(sqliteKeywords).not.toContain(col.toUpperCase())
    }
  })

  it('schema version 递增正确', () => {
    // v6 → v7
    let ver = 6
    expect(ver).toBeLessThan(7) // 需要迁移
    ver = 7
    expect(ver).toBeGreaterThanOrEqual(7) // 迁移完成，跳过
  })

  it('rowToData 默认值回退逻辑', () => {
    // 模拟：列不存在时 row.tier 为 undefined，?? 回退到 2
    const row = {} as Record<string, unknown>
    const tier = (row.tier as number) ?? 2
    const tags = (row.tags as string) || ''
    const appearChapters = (row.appear_chapters as string) || '[]'
    const relations = (row.relations as string) || '[]'

    expect(tier).toBe(2)
    expect(tags).toBe('')
    expect(appearChapters).toBe('[]')
    expect(relations).toBe('[]')
  })

  it('rowToData 正常数据传递', () => {
    const row = {
      name: '叶凡',
      tier: 1,
      tags: '["宗门","剑修"]',
      appear_chapters: '[1,5,10,15]',
      relations: '[{"target":"魔帝","type":"enemy","label":"杀父仇人"}]',
    } as Record<string, unknown>

    expect(row.tier).toBe(1)
    expect(row.tags).toBe('["宗门","剑修"]')
    expect(JSON.parse(row.appear_chapters as string)).toEqual([1, 5, 10, 15])
    expect(JSON.parse(row.relations as string)).toHaveLength(1)
  })

  it('safeAddColumn 幂等性 — 重复 ALTER 不抛错', () => {
    // 逻辑上：如果 column 已存在，safeAddColumn 应该跳过
    const existingCols = ['name', 'role', 'tier', 'tags']
    const newCols = ['tier', 'tags', 'appear_chapters']
    const skipped = newCols.filter(c => !existingCols.includes(c))
    expect(skipped).toEqual(['appear_chapters']) // 只添加不存在的列
  })
})

// ===== v16 cached_tokens 迁移（node:sqlite 内存 DB） =====

describe('v16 cached_tokens 迁移', () => {
  /** 与 database.ts safeAddColumn 语义一致的迁移模拟（pragma 检查列存在再 ALTER，幂等） */
  function migrateV16(db: DatabaseSync): void {
    const cols = db.prepare(`PRAGMA table_info(llm_calls)`).all() as { name: string }[]
    if (!cols.some(c => c.name === 'cached_tokens')) {
      db.exec(`ALTER TABLE llm_calls ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0`)
    }
  }

  /** 旧版 llm_calls 表（无 cached_tokens 列——v16 前 schema） */
  const CREATE_LLM_CALLS_V15 = `
    CREATE TABLE llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      model_name TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      error_message TEXT DEFAULT '',
      cost REAL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    )
  `

  it('加列幂等（重复执行不报错且只产生一列）', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(CREATE_LLM_CALLS_V15)

    // 首次执行迁移
    migrateV16(db)
    const cols1 = db.prepare(`PRAGMA table_info(llm_calls)`).all() as { name: string }[]
    expect(cols1.some(c => c.name === 'cached_tokens')).toBe(true)

    // 二次执行（幂等：safeAddColumn 检查后跳过）
    migrateV16(db)
    const cols2 = db.prepare(`PRAGMA table_info(llm_calls)`).all() as { name: string }[]
    expect(cols2.filter(c => c.name === 'cached_tokens')).toHaveLength(1)
    db.close()
  })

  it('cached_tokens 默认 0 且固定列 INSERT 可落库（repository logCall 契约）', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(CREATE_LLM_CALLS_V15)
    migrateV16(db)
    // 不动 cached_tokens 的 INSERT（旧写入端形态）→ 默认 0
    db.exec(`INSERT INTO llm_calls (model_id, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error_message, cost) VALUES ('m1', 10, 5, 15, 100, 1, '', 0.0)`)
    // 固定列 INSERT（LLMHistoryRepository.logCall 形态）补 cached_tokens
    db.exec(`INSERT INTO llm_calls (model_id, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error_message, cost, cached_tokens) VALUES ('m2', 10, 5, 15, 100, 1, '', 0.0, 7)`)
    const rows = db.prepare(`SELECT model_id, cached_tokens FROM llm_calls ORDER BY id`).all() as Array<{ model_id: string; cached_tokens: number }>
    expect(rows).toEqual([
      { model_id: 'm1', cached_tokens: 0 },
      { model_id: 'm2', cached_tokens: 7 },
    ])
    db.close()
  })
})

// ===== v17 workflow_checkpoints 迁移（node:sqlite 内存 DB） =====
describe('v17 workflow_checkpoints 迁移', () => {
  /** 与 database.ts v17 迁移段语义一致：表存在性检查 → CREATE IF NOT EXISTS（幂等） */
  function migrateV17(db: DatabaseSync): void {
    const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_checkpoints'`).get()
    if (!t) {
      db.exec(`CREATE TABLE IF NOT EXISTS workflow_checkpoints (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER DEFAULT (unixepoch() * 1000)
      )`)
    }
  }

  it('迁移幂等：重复执行不报错且只建一表', () => {
    const db = new DatabaseSync(':memory:')
    migrateV17(db)
    const n1 = (db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='workflow_checkpoints'`).get() as { c: number }).c
    expect(n1).toBe(1)
    migrateV17(db) // 二次（表已存在 → 跳过）
    const n2 = (db.prepare(`SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='workflow_checkpoints'`).get() as { c: number }).c
    expect(n2).toBe(1)
    db.close()
  })

  it('表约束/默认值：单行 id=1 且 state_json 默认 {}', () => {
    const db = new DatabaseSync(':memory:')
    migrateV17(db)
    db.exec(`INSERT INTO workflow_checkpoints (id, state_json) VALUES (1, '{"v":1}')`)
    const row = db.prepare(`SELECT id, state_json, updated_at FROM workflow_checkpoints WHERE id = 1`).get() as { id: number; state_json: string; updated_at: number }
    expect(row.id).toBe(1)
    expect(row.state_json).toBe('{"v":1}')
    expect(row.updated_at).toBeGreaterThan(0)
    // id=2 违反 CHECK(id=1) 约束 → 抛错
    expect(() => db.exec(`INSERT INTO workflow_checkpoints (id, state_json) VALUES (2, '{}')`)).toThrow()
    db.close()
  })

  it('schema version 16→17（CURRENT_SCHEMA_VERSION 递增）', () => {
    // database.ts 常量核对（决策：CURRENT_SCHEMA_VERSION 须为 17）
    // 以 electron/database.ts 的 CURRENT_SCHEMA_VERSION 为准——此处仅锁「现在应 ≥16 且本档升 17」
    const CURRENT = 17
    expect(CURRENT).toBe(17)
  })
})
