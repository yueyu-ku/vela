/**
 * NovelForge SQLite 数据库服务 — 主进程使用
 *
 * 负责 SQLite 实例的连接、生命周期与建表。
 * 具体业务逻辑由 /repositories 提供。
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { dialog } from 'electron'
import { t } from '../src/shared/locale'
import { logger } from './utils/logger'
import { getProjectVelaDir } from './utils/config-utils'
import type BetterSqlite3 from 'better-sqlite3'

let projectDb: BetterSqlite3.Database | null = null
/** 当前已打开的项目路径（get-summary 等可判断"当前项目"直接走主连接，免只读连接） */
let currentProjectPath: string | null = null

/** 获取当前已打开项目的路径（未打开返回 null） */
export function getCurrentProjectPath(): string | null {
  return currentProjectPath
}

/** 初始化项目数据库（打开项目时调用） */
export function initProjectDatabase(projectPath: string): void {
  closeProjectDatabase()
  currentProjectPath = projectPath

  const dbPath = path.join(getProjectVelaDir(projectPath), 'vela.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  try {
    projectDb = new Database(dbPath)
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    const isCorrupt = errMsg.includes('SQLITE_CORRUPT') || errMsg.includes('SQLITE_NOTADB')

    logger.error('DB', t('log.db.openFailed').replace('{err}', errMsg))

    if (isCorrupt) {
      // 备份损坏的数据库文件
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backupPath = dbPath + `.corrupted.${timestamp}`
        fs.renameSync(dbPath, backupPath)
        logger.warn('DB', t('log.db.corruptBackedUp').replace('{path}', backupPath))
      } catch (backupErr) {
        logger.error('DB', t('log.db.corruptBackupFailed').replace('{err}', String(backupErr)))
      }

      // 创建新数据库
      try {
        projectDb = new Database(dbPath)
        logger.info('DB', t('log.db.createdNewReplacement'))
      } catch (createErr) {
        logger.error('DB', t('log.db.createFailed').replace('{err}', String(createErr)))
        throw createErr
      }

      // 通知用户
      dialog.showMessageBox({
        type: 'error',
        title: t('dialog.dbCorruptTitle'),
        message: t('dialog.dbCorruptMsg'),
        detail: t('dialog.dbCorruptDetail').replace('{path}', path.dirname(dbPath)),
        buttons: [t('dialog.buttons.ok')],
      }).catch(() => { /* dialog may fail in headless */ })
    } else {
      throw error // 非损坏错误，继续抛出
    }
  }

  // 数据库完整性检查
  try {
    const integrity = projectDb.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') {
      logger.error('DB', t('log.db.integrityFailed').replace('{result}', integrity))
      dialog.showMessageBox({
        type: 'warning',
        title: t('dialog.dbIntegrityTitle'),
        message: t('dialog.dbIntegrityMsg'),
        detail: t('dialog.dbIntegrityDetail').replace('{result}', integrity),
        buttons: [t('dialog.buttons.ok')],
      }).catch(() => { /* ignore */ })
    }
  } catch (checkErr) {
    logger.error('DB', t('log.db.integrityCheckFailed').replace('{err}', String(checkErr)))
  }

  projectDb.pragma('journal_mode = WAL')
  projectDb.pragma('foreign_keys = ON')

  // 创建表结构
  createTables(projectDb)
  logger.info('DB', t('log.db.opened').replace('{path}', dbPath))
}

/** 关闭项目数据库 */
export function closeProjectDatabase(): void {
  if (projectDb) {
    // WAL checkpoint — 将 WAL 日志合并回主数据库，防止 WAL 文件无限增长
    try { projectDb.pragma('wal_checkpoint(TRUNCATE)') } catch { /* 忽略 */ }
    projectDb.close()
    projectDb = null
  }
  // ⚠️ P3 修复：切换项目时关闭旧项目的 LanceDB 连接（此前 connectionPool 无界累积，
  //    每个连接持有原生内存）
  if (currentProjectPath) {
    import('./vector-store').then(m => m.closeConnection(currentProjectPath!)).catch(() => {})
  }
  currentProjectPath = null
}

/** 获取当前数据库实例 */
export function getProjectDb(): BetterSqlite3.Database | null {
  return projectDb
}

// ===== Schema 版本管理 =====
/** 当前数据库 schema 版本号（v17：workflow_checkpoints 表——L2 checkpoint 迁 DB） */
const CURRENT_SCHEMA_VERSION = 17

/** 检查并执行 schema 迁移（仅在版本号低于当前版本时运行） */
function ensureSchemaVersion(db: BetterSqlite3.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number

  // 降级哨兵：数据库版本高于当前应用（用户回退了安装包）。
  // 不执行任何迁移（降级迁移风险极高），提示用户使用匹配版本。
  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    logger.error('DB', t('log.db.schemaDowngradeDetected')
      .replace('{current}', String(currentVersion))
      .replace('{supported}', String(CURRENT_SCHEMA_VERSION)))
    dialog.showMessageBox({
      type: 'warning',
      title: t('dialog.dbDowngradeTitle'),
      message: t('dialog.dbDowngradeMsg'),
      detail: t('dialog.dbDowngradeDetail')
        .replace('{current}', String(currentVersion))
        .replace('{supported}', String(CURRENT_SCHEMA_VERSION)),
      buttons: [t('dialog.buttons.ok')],
    }).catch(() => { /* dialog may fail in headless */ })
    return
  }

  if (currentVersion >= CURRENT_SCHEMA_VERSION) return

  logger.info('DB', t('log.db.schemaMigration')
    .replace('{from}', String(currentVersion))
    .replace('{to}', String(CURRENT_SCHEMA_VERSION)))
  try {
    migrateExistingTables(db)
    // 仅在全部迁移步骤成功后才递增版本号
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
    logger.info('DB', t('log.db.schemaMigrationDone').replace('{version}', String(CURRENT_SCHEMA_VERSION)))
  } catch (error) {
    logger.error('DB', t('log.db.schemaMigrationFailed')
      .replace('{version}', String(currentVersion))
      .replace('{err}', String(error)))
    // 不递增版本号，下次启动时重新尝试迁移
    throw new Error(
      t('dialog.migrationFailed')
        .replace('{from}', String(currentVersion))
        .replace('{to}', String(CURRENT_SCHEMA_VERSION))
    )
  }
}
function createTables(db: BetterSqlite3.Database) {
  db.exec(`
    -- ============================================================
    -- 1. project_core — 项目主台账（NovelConfig + 架构四大件）
    -- ============================================================
    -- ============================================================
    -- 0. project_archives — 大文本归档（premise/worldbuilding/characters/synopsis）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS project_archives (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'main',
      field_key TEXT NOT NULL,
      body TEXT DEFAULT '',
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_field ON project_archives(project_id, field_key);

    -- ============================================================
    -- 1. project_core — 项目主台账（NovelConfig + 架构四大件）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS project_core (
      id TEXT PRIMARY KEY DEFAULT 'main',
      project_name TEXT NOT NULL DEFAULT '',      -- 小说工程名
      -- [基础定位]
      genre TEXT DEFAULT '',                      -- 核心流派
      sub_genre TEXT DEFAULT '',                  -- 细分流派
      target_audience TEXT DEFAULT '',            -- 目标受众
      total_chapters INTEGER DEFAULT 100,         -- 预计总章数
      words_per_chapter INTEGER DEFAULT 3000,     -- 单章基准字数
      -- [写作技法]
      plot_structure TEXT DEFAULT 'three_act',    -- 故事模型
      narrative_pov TEXT DEFAULT 'third_limited', -- 叙事视角
      writing_style TEXT DEFAULT '',              -- 文风描述
      reference_works TEXT DEFAULT '',            -- 参考作品
      global_guidance TEXT DEFAULT '',            -- 全局行文指导
      golden_finger TEXT DEFAULT '',              -- 金手指设定
      -- [架构四大件]
      premise TEXT DEFAULT '',                    -- 故事前提
      worldbuilding TEXT DEFAULT '',              -- 世界观
      characters_arch TEXT DEFAULT '',            -- 人物群像网络
      synopsis TEXT DEFAULT '',                   -- 情节总大纲
      -- [小说配置独立字段（v13：与架构解耦，此前复用 synopsis/worldbuilding/characters_arch）]
      core_outline TEXT DEFAULT '',               -- 核心大纲（配置）
      world_setting TEXT DEFAULT '',              -- 世界观设定（配置）
      protagonist_profile TEXT DEFAULT '',        -- 主角人设档案（配置）
      -- [系统缓存]
      character_states TEXT DEFAULT '',           -- 全书角色动态快照
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- ============================================================
    -- 2. blueprints — 章节蓝图
    -- ============================================================
    CREATE TABLE IF NOT EXISTS blueprints (
      chapter_number INTEGER PRIMARY KEY,         -- 章节序号
      title TEXT NOT NULL DEFAULT '',             -- 章节标题
      role TEXT DEFAULT '',                       -- 章节角色
      purpose TEXT DEFAULT '',                    -- 核心目的
      key_events TEXT DEFAULT '',                 -- 关键事件
      characters TEXT DEFAULT '[]',               -- 出场角色 (JSON Array)
      suspense_hook TEXT DEFAULT '',              -- 悬念钩子
      user_guidance TEXT DEFAULT '',              -- 用户预设指导
      notes TEXT DEFAULT '',                      -- 后处理提取的章节要点
      notes_updated_at INTEGER DEFAULT 0,           -- notes 提取时间（毫秒戳）
      sort_order INTEGER DEFAULT 0,              -- 自定义排序序号
      priority INTEGER DEFAULT 0,                -- 优先级 (0=普通, 1=高, 2=关键)
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- ============================================================
    -- 3. characters — 角色卡（currentState 拍平为 cs_* 列）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS characters (
      name TEXT PRIMARY KEY,                      -- 角色名
      role TEXT DEFAULT 'supporting',             -- protagonist/antagonist/supporting/minor
      gender TEXT DEFAULT '',
      age TEXT DEFAULT '',
      appearance TEXT DEFAULT '',                 -- 外貌
      personality TEXT DEFAULT '',                -- 性格
      background TEXT DEFAULT '',                 -- 背景
      abilities TEXT DEFAULT '',                  -- 能力
      motivation TEXT DEFAULT '',                 -- 动机
      relationships TEXT DEFAULT '',              -- 关系链（旧版纯文本，保留兼容）
      arc TEXT DEFAULT '',                        -- 弧光
      notes TEXT DEFAULT '',                      -- 备忘录
      tier INTEGER DEFAULT 2,                     -- v7: 戏份等级 1=核心 2=配角 3=龙套
      tags TEXT DEFAULT '',                       -- v7: JSON数组标签 ["宗门","正道"]
      appear_chapters TEXT DEFAULT '[]',          -- v7: JSON数组出场章节 [1,5,10]
      relations TEXT DEFAULT '[]',                -- v7: 结构化关系 [{target,type,label,sinceChapter}]
      aliases TEXT DEFAULT '[]',                  -- v14: 别名/称呼注册表 JSON数组 ["阿晚","苏仙子"]
      appear_count INTEGER DEFAULT 0,             -- v15: 出场章数统计（定稿时维护）
      first_chapter INTEGER DEFAULT 0,            -- v15: 首次出场章号（0=未记录）
      last_chapter INTEGER DEFAULT 0,             -- v15: 最近出场章号（0=未记录）
      status TEXT DEFAULT 'active',               -- v15: 生命周期 active/departed/dead（dead 退出关系检测）
      cs_location TEXT DEFAULT '',                -- 当前位置
      cs_power_level TEXT DEFAULT '',             -- 修为境界
      cs_physical_state TEXT DEFAULT '',          -- 身体状态
      cs_mental_state TEXT DEFAULT '',            -- 心理状态
      cs_key_items TEXT DEFAULT '',               -- 关键道具
      cs_recent_events TEXT DEFAULT '',           -- 最近事件
      cs_updated_at_chapter INTEGER DEFAULT 0,    -- 状态更新于第几章
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- ============================================================
    -- 4. contents — 文本内容池（正文与元数据分离）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS contents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL DEFAULT '',              -- 正文/报告内容
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- ============================================================
    -- 5. drafts — 草稿主线（finalized = 定稿）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,            -- 归属章节（与 blueprints 松散关联，导入时先于蓝图创建）
      version INTEGER NOT NULL,                   -- v1, v2...
      status TEXT DEFAULT 'draft',                -- draft/revised/finalized/archived
      source TEXT DEFAULT 'write',                -- write/rewrite
      content_id INTEGER NOT NULL,                -- FK -> contents
      word_count INTEGER DEFAULT 0,               -- 字数缓存
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_chapter ON drafts(chapter_number);
    CREATE INDEX IF NOT EXISTS idx_drafts_content ON drafts(content_id);
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_chapter_status ON drafts(chapter_number, status);
    -- 注：chapter_number 与 blueprints 无硬 FK，因导入流程先建草稿后推演蓝图

    -- ============================================================
    -- 6. revisions — 修稿（派生自 draft）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,             -- 父草稿 FK
      revision_index INTEGER NOT NULL,            -- r1, r2
      revision_type TEXT NOT NULL,                -- refine | review-fix
      status TEXT DEFAULT 'pending',              -- pending/merged/discarded
      merged_to_draft_id INTEGER,                 -- 合并产出的新 draft
      user_prompt TEXT DEFAULT '',                -- 用户指导
      review_source_id INTEGER,                   -- 关联审稿 ID
      content_id INTEGER NOT NULL,                -- FK -> contents
      word_count INTEGER DEFAULT 0,               -- 字数缓存
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_base_draft ON revisions(base_draft_id);
    CREATE INDEX IF NOT EXISTS idx_revisions_content ON revisions(content_id);
    CREATE INDEX IF NOT EXISTS idx_revisions_merged_to ON revisions(merged_to_draft_id);

    -- ============================================================
    -- 7. reviews — 审稿（派生自 draft）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_draft_id INTEGER NOT NULL,             -- 审查对象 FK
      review_index INTEGER NOT NULL,              -- 审阅顺位
      content_id INTEGER NOT NULL,                -- FK -> contents
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (base_draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
      FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_base_draft ON reviews(base_draft_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_content ON reviews(content_id);

    -- ============================================================
    -- 8. post_process_runs — 后处理跑批实例
    -- ============================================================
    CREATE TABLE IF NOT EXISTS post_process_runs (
      id TEXT PRIMARY KEY,                        -- UUID
      trigger_source_type TEXT NOT NULL,           -- chapter_finalize / arch_extract
      trigger_source_id TEXT NOT NULL,             -- 章节号 / draft_id
      source_label TEXT DEFAULT '',               -- UI 标签
      all_critical_passed INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_post_runs_source
      ON post_process_runs(trigger_source_type, trigger_source_id);

    -- ============================================================
    -- 9. post_process_steps — 后处理步骤明细
    -- ============================================================
    CREATE TABLE IF NOT EXISTS post_process_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,                       -- FK -> post_process_runs
      step_key TEXT NOT NULL,                     -- 步骤标识
      label TEXT DEFAULT '',                      -- 展示名称
      critical INTEGER DEFAULT 0,                 -- 是否关键步骤
      ok INTEGER DEFAULT 0,                       -- 是否完成
      error_msg TEXT DEFAULT '',
      attempt_count INTEGER DEFAULT 0,
      completed_at INTEGER DEFAULT 0,
      last_attempt_at INTEGER DEFAULT 0,
      FOREIGN KEY (run_id) REFERENCES post_process_runs(id) ON DELETE CASCADE,
      UNIQUE(run_id, step_key)
    );

    -- ============================================================
    -- 沿用表：LLM 调用记录
    -- ============================================================
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      model_name TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,  -- v16: 缓存命中 token 数（CacheAligner 效果事后统计）
      duration_ms INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      error_message TEXT DEFAULT '',
      cost REAL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- ============================================================
    -- 沿用表：角色状态快照
    -- ============================================================
    CREATE TABLE IF NOT EXISTS summary_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chapter_number INTEGER NOT NULL,
      character_states TEXT DEFAULT '',
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- 分卷（长篇小说按卷组织章节：卷号唯一、起止章节为含边界）
    CREATE TABLE IF NOT EXISTS volumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      volume_number INTEGER NOT NULL UNIQUE,
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      chapter_start INTEGER NOT NULL DEFAULT 0,
      chapter_end INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    -- 偏好记忆（用户把 AI 文本的 X 改成 Y 的替换对，供写稿注入）
    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ai_text TEXT NOT NULL,
      user_text TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      last_chapter INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000),
      UNIQUE (ai_text, user_text)
    );

    -- ⚠️ P0 修复：evaluation_scores 与 CHECK 触发器此前只在迁移路径创建，
    --    全新数据库（user_version=0）走 fresh 分支跳过迁移 → 表/约束永不存在
    --    （互评结果静默丢失、新旧库约束不一致）。移入主清单，迁移段保留兼容旧库
    CREATE TABLE IF NOT EXISTS evaluation_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id INTEGER NOT NULL,
      reviewer_perspective TEXT NOT NULL,
      scores TEXT NOT NULL DEFAULT '{}',
      overall_score REAL DEFAULT 0,
      strengths TEXT DEFAULT '[]',
      weaknesses TEXT DEFAULT '[]',
      suggestions TEXT DEFAULT '[]',
      raw_response TEXT DEFAULT '',
      tokens_used INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_draft ON evaluation_scores(draft_id);

    -- drafts.status 四值约束（CHECK 触发器，SQLite 不支持 ALTER TABLE ADD CHECK）
    CREATE TRIGGER IF NOT EXISTS check_draft_status_insert
    BEFORE INSERT ON drafts
    WHEN NEW.status NOT IN ('draft', 'revised', 'finalized', 'archived')
    BEGIN
      SELECT RAISE(ABORT, 'Invalid draft status: ' || NEW.status);
    END;
    CREATE TRIGGER IF NOT EXISTS check_draft_status_update
    BEFORE UPDATE ON drafts
    WHEN NEW.status NOT IN ('draft', 'revised', 'finalized', 'archived')
    BEGIN
      SELECT RAISE(ABORT, 'Invalid draft status: ' || NEW.status);
    END;
    -- blueprints.priority 0/1/2 约束
    CREATE TRIGGER IF NOT EXISTS check_blueprint_priority_insert
    BEFORE INSERT ON blueprints
    WHEN NEW.priority NOT IN (0, 1, 2)
    BEGIN
      SELECT RAISE(ABORT, 'Invalid blueprint priority: ' || NEW.priority);
    END;
    CREATE TRIGGER IF NOT EXISTS check_blueprint_priority_update
    BEFORE UPDATE ON blueprints
    WHEN NEW.priority NOT IN (0, 1, 2)
    BEGIN
      SELECT RAISE(ABORT, 'Invalid blueprint priority: ' || NEW.priority);
    END;

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_llm_calls_time ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_summary_chapter ON summary_snapshots(chapter_number);
    CREATE INDEX IF NOT EXISTS idx_summary_created ON summary_snapshots(created_at);
    CREATE INDEX IF NOT EXISTS idx_preferences_count ON preferences(count DESC, updated_at DESC);
    -- ⚠️ P1 修复：活动聚合/统计热点索引（此前全表扫描）
    CREATE INDEX IF NOT EXISTS idx_drafts_source_created ON drafts(source, created_at);
    CREATE INDEX IF NOT EXISTS idx_revisions_created ON revisions(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_success ON llm_calls(success, created_at);

    -- v12: 连载监控（手动导入平台章节，本地优先——不自动抓取）
    CREATE TABLE IF NOT EXISTS publication_tracker (
      chapter_number INTEGER PRIMARY KEY,
      external_title TEXT DEFAULT '',
      external_content TEXT DEFAULT '',
      imported_at INTEGER DEFAULT 0,
      similarity REAL DEFAULT 0,
      audit_issues INTEGER DEFAULT 0
    );

    -- ============================================================
    -- workflow_checkpoints — 工作流 checkpoint（每项目一库单行；L2 迁 DB，跨项目隔离）
    -- ============================================================
    CREATE TABLE IF NOT EXISTS workflow_checkpoints (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );
  `)

  // ===== 旧表迁移 =====
  // 对于全新数据库（user_version=0），表结构已是最新版本，直接标记为当前版本
  // 对于旧数据库（user_version<CURRENT_SCHEMA_VERSION），执行增量迁移补加缺失的列/约束
  const currentVersion = db.pragma('user_version', { simple: true }) as number
  if (currentVersion === 0) {
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
    logger.info('DB', t('log.db.freshSchemaMarked').replace('{version}', String(CURRENT_SCHEMA_VERSION)))
  } else {
    ensureSchemaVersion(db)
  }
}

/**
 * 确保旧版本数据库中所有表都包含当前 schema 所需的列。
 * CREATE TABLE IF NOT EXISTS 不会修改已存在的表，
 * 所以需要单独 ALTER TABLE ADD COLUMN 补加缺失的列。
 */
function ensureMigrationColumns(db: BetterSqlite3.Database) {
  // post_process_steps — v1 表，后续版本新增列
  safeAddColumn(db, 'post_process_steps', 'completed_at', 'INTEGER DEFAULT 0')
  safeAddColumn(db, 'post_process_steps', 'last_attempt_at', 'INTEGER DEFAULT 0')

  // post_process_runs — v1 表，后续版本新增 updated_at
  safeAddColumn(db, 'post_process_runs', 'updated_at', "INTEGER DEFAULT (unixepoch() * 1000)")

  // blueprints — 后续版本新增列
  safeAddColumn(db, 'blueprints', 'notes_updated_at', 'INTEGER DEFAULT 0')
  safeAddColumn(db, 'blueprints', 'sort_order', 'INTEGER DEFAULT 0')
  safeAddColumn(db, 'blueprints', 'priority', 'INTEGER DEFAULT 0')

  // contents — v1 新增 updated_at
  safeAddColumn(db, 'contents', 'updated_at', "INTEGER DEFAULT (unixepoch() * 1000)")

  // project_core — v4 后新增列
  safeAddColumn(db, 'project_core', 'writing_style', "TEXT DEFAULT ''")
  safeAddColumn(db, 'project_core', 'reference_works', "TEXT DEFAULT ''")

  // project_core — v13 新增小说配置独立列（与架构 synopsis/worldbuilding/characters_arch 解耦，见 #27）
  safeAddColumn(db, 'project_core', 'core_outline', "TEXT DEFAULT ''")
  safeAddColumn(db, 'project_core', 'world_setting', "TEXT DEFAULT ''")
  safeAddColumn(db, 'project_core', 'protagonist_profile', "TEXT DEFAULT ''")

  // llm_calls — v8 新增 cost（单次调用费用，美元）
  safeAddColumn(db, 'llm_calls', 'cost', 'REAL DEFAULT 0')

  // llm_calls — v16 新增 cached_tokens（缓存命中 token 数，CacheAligner 效果事后统计）
  safeAddColumn(db, 'llm_calls', 'cached_tokens', 'INTEGER NOT NULL DEFAULT 0')

  // characters — v14 新增 aliases（别名/称呼注册表，角色名匹配的变体形态）
  safeAddColumn(db, 'characters', 'aliases', "TEXT DEFAULT '[]'")

  // characters — v15 新增生命周期列（出场统计 + 状态）
  safeAddColumn(db, 'characters', 'appear_count', 'INTEGER DEFAULT 0')
  safeAddColumn(db, 'characters', 'first_chapter', 'INTEGER DEFAULT 0')
  safeAddColumn(db, 'characters', 'last_chapter', 'INTEGER DEFAULT 0')
  safeAddColumn(db, 'characters', 'status', "TEXT DEFAULT 'active'")

  logger.info('DB', t('log.db.columnBackfillDone'))
}

/** 安全地给表添加列（列已存在则跳过） */
function safeAddColumn(db: BetterSqlite3.Database, table: string, column: string, columnDef: string) {
  try {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (!cols.some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`)
      logger.info('DB', t('log.db.columnAdded').replace('{table}', table).replace('{column}', column))
    }
  } catch (e) {
    // 表不存在时静默跳过（后续 createTables 会处理）
    logger.warn('DB', t('log.db.columnAddFailed')
      .replace('{table}', table)
      .replace('{column}', column)
      .replace('{err}', String(e)))
  }
}

/** 为已存在的旧表补加缺失的列/约束（兼容性迁移） */
function migrateExistingTables(db: BetterSqlite3.Database) {
  // 0. 先补齐所有旧表可能缺失的列（后续步骤依赖这些列存在）
  try {
    ensureMigrationColumns(db)
  } catch (e) {
    logger.error('DB', t('log.db.migrationColumnsFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'ensure columns').replace('{err}', String(e)))
  }

  // 1. contents 表：补加 updated_at 列
  try {
    const cols = db.pragma('table_info(contents)') as Array<{ name: string }>
    if (!cols.some(c => c.name === 'updated_at')) {
      db.exec("ALTER TABLE contents ADD COLUMN updated_at INTEGER DEFAULT (unixepoch() * 1000)")
      logger.info('DB', t('log.db.migContentsUpdatedAt'))
    }
  } catch (e) {
    logger.error('DB', t('log.db.migContentsUpdatedAtFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'contents.updated_at').replace('{err}', String(e)))
  }

  // 2. post_process_steps 表：补加唯一约束
  try {
    const indexes = db.pragma('index_list(post_process_steps)') as Array<{ name: string }>
    if (!indexes.some(i => i.name === 'uq_post_steps_run_key')) {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_post_steps_run_key ON post_process_steps(run_id, step_key)')
      logger.info('DB', t('log.db.migStepsUniqueConstraint'))
    }
  } catch (e) {
    logger.error('DB', t('log.db.migStepsUniqueFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'post_process_steps').replace('{err}', String(e)))
  }

  // 3. summary_snapshots 表：补加索引
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_summary_chapter ON summary_snapshots(chapter_number)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_summary_created ON summary_snapshots(created_at)')
  } catch (e) {
    logger.error('DB', t('log.db.migSnapshotsIndexFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'summary_snapshots indexes').replace('{err}', String(e)))
  }

  // 4. v2: blueprints 表：添加 sort_order, priority 列
  try {
    const bpCols = db.pragma('table_info(blueprints)') as Array<{ name: string }>
    if (!bpCols.some(c => c.name === 'sort_order')) {
      db.exec('ALTER TABLE blueprints ADD COLUMN sort_order INTEGER DEFAULT 0')
      logger.info('DB', t('log.db.migBlueprintsSortOrder'))
    }
    if (!bpCols.some(c => c.name === 'priority')) {
      db.exec('ALTER TABLE blueprints ADD COLUMN priority INTEGER DEFAULT 0')
      logger.info('DB', t('log.db.migBlueprintsPriority'))
    }
  } catch (e) {
    logger.error('DB', t('log.db.migBlueprintsColumnsFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'blueprints').replace('{err}', String(e)))
  }

  // 5. v2: evaluation_scores 表
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_scores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id INTEGER NOT NULL,
        reviewer_perspective TEXT NOT NULL,
        scores TEXT NOT NULL DEFAULT '{}',
        overall_score REAL DEFAULT 0,
        strengths TEXT DEFAULT '[]',
        weaknesses TEXT DEFAULT '[]',
        suggestions TEXT DEFAULT '[]',
        raw_response TEXT DEFAULT '',
        tokens_used INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_evaluation_draft ON evaluation_scores(draft_id);
    `)
    logger.info('DB', t('log.db.migEvaluationScores'))
  } catch (e) {
    logger.error('DB', t('log.db.migEvaluationScoresFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'evaluation_scores').replace('{err}', String(e)))
  }

  // 6. v4: project_archives 表 + 大文本字段迁移
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_archives (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT 'main',
        field_key TEXT NOT NULL,
        body TEXT DEFAULT '',
        updated_at INTEGER DEFAULT (unixepoch() * 1000)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_field ON project_archives(project_id, field_key);
    `)
    // 迁移现有的 4 个大文本字段到 project_archives
    // ★ 幂等性保护：step 10 可能在上一轮迁移中已删除这些列，
    //    此时数据已在 project_archives 中，无需再次迁移。
    const FIELDS = ['premise', 'worldbuilding', 'characters_arch', 'synopsis']
    const coreCols = db.pragma('table_info(project_core)') as Array<{ name: string }>
    const existingCols = new Set(coreCols.map(c => c.name))

    for (const field of FIELDS) {
      if (!existingCols.has(field)) {
        logger.info('DB', t('log.db.migFieldAlreadyDropped').replace('{field}', field))
        continue
      }
      const row = db.prepare(`SELECT ${field} FROM project_core WHERE id = 'main'`).get() as Record<string, string> | undefined
      if (row?.[field]) {
        db.prepare(`
          INSERT OR REPLACE INTO project_archives (id, project_id, field_key, body)
          VALUES (?, 'main', ?, ?)
        `).run(`main_${field}`, field, row[field])
      }
    }
    logger.info('DB', t('log.db.migArchivesCreated'))
  } catch (e) {
    logger.error('DB', t('log.db.migArchivesFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'project_archives').replace('{err}', String(e)))
  }

  // 7. v5: 时间字段 TEXT → INTEGER 迁移（毫秒级 unix 时间戳）
  try {
    const TIME_COL_TABLES: Array<{ table: string; cols: string[] }> = [
      { table: 'project_core', cols: ['created_at', 'updated_at'] },
      { table: 'blueprints', cols: ['created_at', 'updated_at'] },
      { table: 'characters', cols: ['created_at', 'updated_at'] },
      { table: 'contents', cols: ['created_at', 'updated_at'] },
      { table: 'drafts', cols: ['created_at', 'updated_at'] },
      { table: 'revisions', cols: ['created_at', 'updated_at'] },
      { table: 'reviews', cols: ['created_at'] },
      { table: 'post_process_runs', cols: ['created_at', 'updated_at'] },
      { table: 'llm_calls', cols: ['created_at'] },
      { table: 'summary_snapshots', cols: ['created_at'] },
      { table: 'project_archives', cols: ['updated_at'] },
    ]

    for (const { table, cols } of TIME_COL_TABLES) {
      // ★ 检查表是否存在（幂等性保护）
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table)
      if (!tableCheck) {
        logger.info('DB', t('log.db.timeMigTableMissing').replace('{table}', table))
        continue
      }

      for (const col of cols) {
        try {
          // 将旧的 TEXT 时间戳转换为 INTEGER 毫秒时间戳
          const rows = db.prepare(
            `SELECT rowid, ${col} FROM ${table} WHERE typeof(${col}) = 'text'`
          ).all() as Array<{ rowid: number; [key: string]: unknown }>

          for (const row of rows) {
            const textVal = row[col] as string
            if (textVal && typeof textVal === 'string') {
              const parsed = Date.parse(textVal)
              if (!isNaN(parsed)) {
                db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`).run(parsed, row.rowid)
              }
            }
          }
        } catch {
          // 列可能不存在（已被上一轮迁移删除），跳过
          logger.info('DB', t('log.db.timeMigSkipped').replace('{table}', table).replace('{col}', col))
        }
      }
    }
    logger.info('DB', t('log.db.timeMigDone'))
  } catch (e) {
    logger.error('DB', t('log.db.timeMigFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'time migration v5').replace('{err}', String(e)))
  }

  // 8. v6: 补充遗漏的 TEXT 时间列 → INTEGER（post_process_steps + blueprints）
  try {
    const V6_TIME_TABLES: Array<{ table: string; cols: string[] }> = [
      { table: 'post_process_steps', cols: ['completed_at', 'last_attempt_at'] },
      { table: 'blueprints', cols: ['notes_updated_at'] },
    ]

    for (const { table, cols } of V6_TIME_TABLES) {
      for (const col of cols) {
        try {
          const rows = db.prepare(
            `SELECT rowid, ${col} FROM ${table} WHERE typeof(${col}) = 'text'`
          ).all() as Array<{ rowid: number; [key: string]: unknown }>

          for (const row of rows) {
            const textVal = row[col] as string
            if (textVal && typeof textVal === 'string') {
              const parsed = Date.parse(textVal)
              if (!isNaN(parsed)) {
                db.prepare(`UPDATE ${table} SET ${col} = ? WHERE rowid = ?`).run(parsed, row.rowid)
              } else {
                db.prepare(`UPDATE ${table} SET ${col} = 0 WHERE rowid = ?`).run(row.rowid)
              }
            }
          }
        } catch {
          logger.info('DB', t('log.db.v6TimeMigSkipped').replace('{table}', table).replace('{col}', col))
        }
      }
    }
    logger.info('DB', t('log.db.v6TimeMigDone'))
  } catch (e) {
    logger.error('DB', t('log.db.v6TimeMigFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'time migration v6').replace('{err}', String(e)))
  }

  // 9. v6: CHECK 约束触发器（SQLite 不支持 ALTER TABLE ADD CHECK，用触发器替代）
  try {
    // drafts.status 四值约束
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS check_draft_status_insert
      BEFORE INSERT ON drafts
      WHEN NEW.status NOT IN ('draft', 'revised', 'finalized', 'archived')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid draft status: ' || NEW.status);
      END;
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS check_draft_status_update
      BEFORE UPDATE ON drafts
      WHEN NEW.status NOT IN ('draft', 'revised', 'finalized', 'archived')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid draft status: ' || NEW.status);
      END;
    `)
    // blueprints.priority 0/1/2 约束
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS check_blueprint_priority_insert
      BEFORE INSERT ON blueprints
      WHEN NEW.priority NOT IN (0, 1, 2)
      BEGIN
        SELECT RAISE(ABORT, 'Invalid blueprint priority: ' || NEW.priority);
      END;
    `)
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS check_blueprint_priority_update
      BEFORE UPDATE ON blueprints
      WHEN NEW.priority NOT IN (0, 1, 2)
      BEGIN
        SELECT RAISE(ABORT, 'Invalid blueprint priority: ' || NEW.priority);
      END;
    `)
    logger.info('DB', t('log.db.v6CheckTriggersCreated'))
  } catch (e) {
    logger.error('DB', t('log.db.v6CheckTriggersFailed').replace('{err}', String(e)))
    throw new Error(t('error.migrationStepFailed').replace('{step}', 'CHECK triggers v6').replace('{err}', String(e)))
  }

  // 10. v6: 删除 project_core 中已归档到 project_archives 的冗余大文本列
  try {
    const coreCols = db.pragma('table_info(project_core)') as Array<{ name: string }>
    const archivedFields = ['premise', 'worldbuilding', 'characters_arch', 'synopsis']
    for (const field of archivedFields) {
      if (coreCols.some(c => c.name === field)) {
        db.exec(`ALTER TABLE project_core DROP COLUMN ${field}`)
        logger.info('DB', t('log.db.v6ColumnArchived').replace('{field}', field))
      }
    }
  } catch (e) {
    // 非关键迁移，旧版 SQLite 可能不支持 DROP COLUMN，降级为警告
    logger.warn('DB', t('log.db.v6RedundantColDropFailed').replace('{err}', String(e)))
  }

  // 11. v7: 角色戏份分级 + 标签 + 出场章节 + 结构化关系
  //    非关键 — 即使列不存在，CharacterRepository.rowToData() 也会回退默认值
  try {
    safeAddColumn(db, 'characters', 'tier', 'INTEGER DEFAULT 2')
    safeAddColumn(db, 'characters', 'tags', "TEXT DEFAULT ''")
    safeAddColumn(db, 'characters', 'appear_chapters', "TEXT DEFAULT '[]'")
    safeAddColumn(db, 'characters', 'relations', "TEXT DEFAULT '[]'")
    logger.info('DB', t('log.db.v7CharsColumnsAdded'))
  } catch (e) {
    logger.warn('DB', t('log.db.v7CharsMigIncomplete').replace('{err}', String(e)))
  }

  // 12. v9: 分卷表（长篇小说按卷组织章节）
  //    非关键 — 表不存在时 VolumeRepository 返回空列表，分卷功能自动降级
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS volumes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        volume_number INTEGER NOT NULL UNIQUE,
        title TEXT DEFAULT '',
        description TEXT DEFAULT '',
        chapter_start INTEGER NOT NULL DEFAULT 0,
        chapter_end INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER DEFAULT (unixepoch() * 1000)
      );
      -- 冗余索引已移除（volume_number UNIQUE 自建索引覆盖）
    `)
    logger.info('DB', t('log.db.v9VolumesCreated'))
  } catch (e) {
    logger.warn('DB', t('log.db.v9VolumesMigIncomplete').replace('{err}', String(e)))
  }

  // 13. v10: 偏好记忆表（用户把 AI 文本的 X 改成 Y 的替换对）
  //    非关键 — 表不存在时偏好记录/注入自动降级为空
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ai_text TEXT NOT NULL,
        user_text TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        last_chapter INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch() * 1000),
        updated_at INTEGER DEFAULT (unixepoch() * 1000),
        UNIQUE (ai_text, user_text)
      );
      CREATE INDEX IF NOT EXISTS idx_preferences_count ON preferences(count DESC, updated_at DESC);
    `)
    logger.info('DB', t('log.db.v10PreferencesCreated'))
  } catch (e) {
    logger.warn('DB', t('log.db.v10PrefsMigIncomplete').replace('{err}', String(e)))
  }

  // 14. v11: 活动聚合/统计热点索引（旧库升级；此前全表扫描）
  //    非关键 — 索引缺失仅性能问题
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_drafts_source_created ON drafts(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_revisions_created ON revisions(created_at);
      CREATE INDEX IF NOT EXISTS idx_llm_calls_success ON llm_calls(success, created_at);
      -- 冗余索引清理（与新库一致：UNIQUE 约束自建索引已覆盖）
      DROP INDEX IF EXISTS idx_post_steps_run;
      DROP INDEX IF EXISTS idx_volumes_number;
    `)
    logger.info('DB', t('log.db.v11HotIndexes'))
  } catch (e) {
    logger.warn('DB', t('log.db.v11HotIndexesFailed').replace('{err}', String(e)))
  }

  // 15. v12: 连载监控表（手动导入平台章节，本地优先）
  //    非关键 — 表缺失仅连载监控不可用
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS publication_tracker (
        chapter_number INTEGER PRIMARY KEY,
        external_title TEXT DEFAULT '',
        external_content TEXT DEFAULT '',
        imported_at INTEGER DEFAULT 0,
        similarity REAL DEFAULT 0,
        audit_issues INTEGER DEFAULT 0
      );
    `)
    logger.info('DB', t('log.db.v12PublicationTable'))
  } catch (e) {
    logger.warn('DB', t('log.db.v12PublicationTableFailed').replace('{err}', String(e)))
  }

  // 16. v13: 小说配置独立列快照（#27）——列由 ensureMigrationColumns 补齐，
  //    此处将 v13 前共享列数据（project_archives 的 synopsis/worldbuilding/characters_arch）
  //    一次性快照到独立列（仅独立列为空时）。此后配置与架构读写彻底解耦。
  //    非关键 — 快照失败仅旧库配置字段回退显示架构内容，数据不丢
  try {
    db.exec(`
      UPDATE project_core SET core_outline = COALESCE(
        (SELECT body FROM project_archives WHERE project_id = 'main' AND field_key = 'synopsis'), '')
        WHERE core_outline IS NULL OR core_outline = '';
      UPDATE project_core SET world_setting = COALESCE(
        (SELECT body FROM project_archives WHERE project_id = 'main' AND field_key = 'worldbuilding'), '')
        WHERE world_setting IS NULL OR world_setting = '';
      UPDATE project_core SET protagonist_profile = COALESCE(
        (SELECT body FROM project_archives WHERE project_id = 'main' AND field_key = 'characters_arch'), '')
        WHERE protagonist_profile IS NULL OR protagonist_profile = '';
    `)
    logger.info('DB', t('log.db.v13ConfigColumnsSnapshot'))
  } catch (e) {
    logger.warn('DB', t('log.db.v13ConfigColumnsSnapshotFailed').replace('{err}', String(e)))
  }

  // 17. v17: workflow_checkpoints 表（L2 checkpoint 迁 DB——主清单已有，迁移段幂等补建）
  //    非关键 — 表缺失仅 checkpoint 持久化降级回 localStorage
  try {
    const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_checkpoints'`).get()
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
}
