// المخطط — يُنشأ عند أول وصول بـ CREATE TABLE IF NOT EXISTS (لا حاجة لأداة migrations)
import type { Client } from "@libsql/client";

export async function ensure(db: Client): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      provider TEXT,
      provider_task_id TEXT,
      key_id TEXT,
      model TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT DEFAULT '',
      params_json TEXT DEFAULT '{}',
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      result_urls_json TEXT,
      error_message TEXT,
      attempts_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    )`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT DEFAULT '',
      api_key TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      usage_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      fail_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      last_checked_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  // فهيدات مفيدة — تجاهل الفشل إن وُجدت
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)`).catch(() => {});
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_keys_order ON api_keys(provider, created_at)`).catch(() => {});
}
