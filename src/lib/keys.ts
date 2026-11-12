// نظام المفاتيح المتسلسلة — قلب المشروع (قسم 4)
import { getTurso, ensureSchema } from "./turso";
import type { InValue } from "@libsql/client";
import type { KeyRow, KeyStatus, ProviderId } from "./types";

/** إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات (قاعدة ذهبية 9) */
export function maskKey(key: string): string {
  const k = (key || "").trim();
  if (k.length <= 8) return k.slice(0, 3) + "••••";
  return k.slice(0, 7) + "••••••••" + k.slice(-4);
}

/**
 * جلب مفاتيح المزودين بالترتيب التسلسلي الصارم حسب ترتيب الإضافة:
 * أول مفتاح أُضيف يُجرَّب أولًا ثم الثاني ثم الثالث... (ليس round-robin وليس الأقل استخدامًا أولًا)
 * المفتاح المستنزف (exhausted) يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي (disabled).
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getTurso().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers as InValue[],
  });
  return r.rows.map(mapKeyRow);
}

function mapKeyRow(r: Record<string, unknown>): KeyRow {
  return {
    id: String(r.id),
    provider: String(r.provider) as ProviderId,
    label: (r.label as string) ?? "",
    api_key: String(r.api_key),
    status: (String(r.status || "active")) as KeyStatus,
    usage_count: Number(r.usage_count) || 0,
    success_count: Number(r.success_count) || 0,
    fail_count: Number(r.fail_count) || 0,
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const r = await getTurso().execute(`SELECT * FROM api_keys ORDER BY created_at ASC, id ASC`);
  return r.rows.map((x) => mapKeyRow(x as unknown as Record<string, unknown>));
}

export async function getKeyById(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: `SELECT * FROM api_keys WHERE id = ? LIMIT 1`, args: [id] });
  return r.rows.length ? mapKeyRow(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function insertKey(input: { provider: ProviderId; api_key: string; label?: string }): Promise<KeyRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [id, input.provider, input.label ?? "", input.api_key],
  });
  return (await getKeyById(id))!;
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const r = await getTurso().execute({ sql: `DELETE FROM api_keys WHERE id = ?`, args: [id] });
  return r.rowsAffected > 0;
}

/** تعطيل/تنشيط يدوي أو تعليم مستنزف تلقائيًا */
export async function setKeyStatus(id: string, status: KeyStatus, lastError?: string | null): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET status = ?, last_error = COALESCE(?, last_error), last_checked_at = datetime('now') WHERE id = ?`,
    args: [status, lastError ?? null, id],
  });
}

/**
 * تحديث عدّادات المفتاح — تُستدعى دائمًا بعد كل محاولة (نجاح أو فشل):
 * usage_count++ / success_count++ أو fail_count++ + last_used_at + last_error
 */
export async function bumpKeyCounters(id: string, opts: { ok: boolean; error?: string | null }): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = ?
          WHERE id = ?`,
    args: [opts.ok ? 1 : 0, opts.ok ? 0 : 1, opts.error ?? null, id],
  });
}

export interface SafeKey {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** صيغة آمنة للعرض في الواجهة — لا يُعاد المفتاح الكامل في أي استجابة */
export function toSafeKey(k: KeyRow): SafeKey {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    masked: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}
