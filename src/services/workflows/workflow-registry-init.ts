// workflow-registry-init.ts —— 恢复前加载所有 workflow 模块，触发各文件顶层 registerWorkflow。
// 这些 workflow 文件常被 `await import(...)` 懒加载，顶层自注册只在该文件加载时执行；
// 为保证恢复前所有注册生效，应用启动初始化时 import 本模块（须在 restoreCheckpoint 调用之前）。
import './architecture-workflow'
import './chapter-workflow'
import './directory-workflow'
import './import-workflow'
import './mutual-evaluation-workflow'
import './verification-workflow'
import './character-archive-workflow'
