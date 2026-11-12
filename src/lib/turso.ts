// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP — إلزامية للتوافق مع Vercel (لا ملفات SQLite محلية)
import { createClient, type Client, type InValue, type Row } from "@libsql/client";
import { ensure as ensurePromise } from "./schema";

let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

/** عميل واحد مشترك — يُنشأ عند أول وصول */
export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

/** إنشاء الجداول عند أول وصول (بدون أداة migrations) — memoized لتفادي التكرار */
export async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = ensurePromise(getTurso()).catch((e) => {
      schemaPromise = null; // اسمح بإعادة المحاولة عند فشل عابر
      throw e;
    });
  }
  return schemaPromise;
}

/** فحص جهوزية القاعدة: SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    const r = await getTurso().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// ————— أدوات مساعدة للتحويل —————
function s(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function mapTask(r: Row): import("./types").TaskRow {
  const row: import("./types").TaskRow = {
    id: String(r.id),
    provider: s(r.provider) ?? "",
    provider_task_id: s(r.provider_task_id),
    key_id: s(r.key_id),
    model: s(r.model) ?? "",
    type: (s(r.type) ?? "image") as import("./types").MediaType,
    prompt: s(r.prompt) ?? "",
    params_json: s(r.params_json) ?? "{}",
    status: (s(r.status) ?? "pending") as import("./types").TaskStatus,
    progress: n(r.progress),
    result_urls_json: s(r.result_urls_json),
    error_message: s(r.error_message),
    attempts_json: s(r.attempts_json) ?? "[]",
    created_at: s(r.created_at) ?? "",
    updated_at: s(r.updated_at) ?? "",
    completed_at: s(r.completed_at),
  };
  // حقول محسوبة
  try {
    row.params = JSON.parse(row.params_json || "{}");
  } catch {
    row.params = {};
  }
  try {
    row.result_urls = row.result_urls_json ? (JSON.parse(row.result_urls_json) as string[]) : [];
  } catch {
    row.result_urls = [];
  }
  try {
    row.attempts = JSON.parse(row.attempts_json || "[]");
  } catch {
    row.attempts = [];
  }
  return row;
}

// ————— عمليات المهام —————
export async function insertTask(input: {
  id: string;
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
  model: string;
  type: import("./types").MediaType;
  prompt?: string;
  params_json?: string;
  status?: import("./types").TaskStatus;
  progress?: number;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      input.id,
      input.provider ?? "",
      input.provider_task_id ?? null,
      input.key_id ?? null,
      input.model,
      input.type,
      input.prompt ?? "",
      input.params_json ?? "{}",
      input.status ?? "pending",
      input.progress ?? 0,
    ] satisfies InValue[],
  });
}

export async function getTask(id: string): Promise<import("./types").TaskRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  return r.rows.length ? mapTask(r.rows[0]) : null;
}

export interface TaskPatch {
  provider?: string;
  provider_task_id?: string | null;
  key_id?: string | null;
  model?: string;
  prompt?: string;
  status?: import("./types").TaskStatus;
  progress?: number;
  result_urls?: string[] | null;
  error_message?: string | null;
  /** دمج مفاتيح جديدة في params_json بدل استبداله كاملًا */
  params?: Record<string, unknown>;
  /** إلحاق محاولة جديدة في attempts_json */
  appendAttempt?: import("./types").Attempt;
}

/** تحديث جزئي للمهمة: يضيف attempts ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(id: string, patch: TaskPatch): Promise<import("./types").TaskRow | null> {
  const cur = await getTask(id);
  if (!cur) return null;

  const params = { ...(cur.params || {}), ...(patch.params || {}) };
  const attempts = [...(cur.attempts || [])];
  if (patch.appendAttempt) attempts.push(patch.appendAttempt);

  // الحالة النهائية بعد الدمج
  const newStatus = patch.status ?? cur.status;
  const completedAt = newStatus === "completed" ? new Date().toISOString() : cur.completed_at;

  await getTurso().execute({
    sql: `UPDATE tasks SET
            provider = ?, provider_task_id = ?, key_id = ?, model = ?, prompt = ?,
            status = ?, progress = ?, result_urls_json = ?, error_message = ?,
            params_json = ?, attempts_json = ?, completed_at = ?,
            updated_at = datetime('now')
          WHERE id = ?`,
    args: [
      patch.provider ?? cur.provider,
      patch.provider_task_id !== undefined ? patch.provider_task_id : cur.provider_task_id,
      patch.key_id !== undefined ? patch.key_id : cur.key_id,
      patch.model ?? cur.model,
      patch.prompt ?? cur.prompt,
      newStatus,
      patch.progress ?? cur.progress,
      patch.result_urls !== undefined ? JSON.stringify(patch.result_urls ?? []) : cur.result_urls_json,
      patch.error_message !== undefined ? patch.error_message : cur.error_message,
      JSON.stringify(params),
      JSON.stringify(attempts),
      completedAt,
      id,
    ] satisfies InValue[],
  });
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filter?: { type?: string; status?: string },
): Promise<import("./types").TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter?.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter?.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  args.push(Math.min(Math.max(1, limit), 50));
  const r = await getTurso().execute({ sql, args });
  return r.rows.map(mapTask);
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const r = await getTurso().execute(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
    FROM tasks`);
  const row = r.rows[0] || {};
  return {
    total: n(row.total),
    completed: n(row.completed),
    failed: n(row.failed),
    processing: n(row.processing),
  };
}

/** حذف المهام (يُستخدم لتنظيف آثار الاختبار) */
export async function deleteTasksByIds(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await ensureSchema();
  await getTurso().execute({
    sql: `DELETE FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`,
    args: ids,
  });
}
