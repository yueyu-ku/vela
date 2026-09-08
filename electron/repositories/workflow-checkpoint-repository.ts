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
