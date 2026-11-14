// تجهيز قاعدة Turso محلية (file:) لمهام الاختبار — نفس مخطط src/lib/schema.ts
import { createClient } from "@libsql/client";

const DB = process.argv[2] || "file:/tmp/turso-resume-test.db";
const db = createClient({ url: DB });

await db.execute(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, provider TEXT, provider_task_id TEXT, key_id TEXT,
    model TEXT NOT NULL, type TEXT NOT NULL, prompt TEXT DEFAULT '',
    params_json TEXT DEFAULT '{}', status TEXT NOT NULL, progress INTEGER DEFAULT 0,
    result_urls_json TEXT, error_message TEXT, attempts_json TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), completed_at TEXT
  )`);
await db.execute(`
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT DEFAULT '', api_key TEXT NOT NULL,
    status TEXT DEFAULT 'active', usage_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0, last_used_at TEXT, last_checked_at TEXT, last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

// تنظيف سابق إن وُجد
await db.execute(`DELETE FROM tasks`);
await db.execute(`DELETE FROM api_keys`);

// مفتاحان: k1 (المفتاح الذي «فشل سابقًا» — يجب أن يتخطاه الاستكمال) ثم k2 (المفتاح التالي)
const k1 = "test-key-1-aaaaaaaa";
const k2 = "test-key-2-bbbbbbbb";
await db.execute({
  sql: `INSERT INTO api_keys (id, provider, label, api_key, created_at) VALUES (?, ?, ?, ?, datetime('now','-10 minutes'))`,
  args: [k1, "cometapi", "قديم", "mock-key-1"],
});
await db.execute({
  sql: `INSERT INTO api_keys (id, provider, label, api_key, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
  args: [k2, "cometapi", "التالي", "mock-key-2"],
});

const attemptK1 = JSON.stringify([
  { provider: "cometapi", keyId: k1, keyLabel: "mock-key-1", ok: false, errorClass: "provider", error: "خطأ مزود وهمي", at: new Date().toISOString() },
]);

// 1) مهمة فيديو فاشلة — آخر محاولة على k1 → الاستكمال يبدأ من k2
const videoTask = "11111111-1111-4111-8111-111111111111";
await db.execute({
  sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress, error_message, attempts_json)
        VALUES (?, '', ?, 'video', ?, ?, 'failed', 0, ?, ?)`,
  args: [videoTask, "grok-imagine-video-1-5-preview", "فيديو تجريبي للاستكمال", JSON.stringify({ prompt: "فيديو تجريبي للاستكمال", duration: 8 }), "خطأ مزود وهمي", attemptK1],
});

// 2) مهمة صورة فاشلة (متزامنة) — نفس منطق التخطي
const imageTask = "22222222-2222-4222-8222-222222222222";
await db.execute({
  sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress, error_message, attempts_json)
        VALUES (?, '', ?, 'image', ?, ?, 'failed', 0, ?, ?)`,
  args: [imageTask, "gpt-image-2-6/flare-text-to-image", "صورة تجريبية للاستكمال", JSON.stringify({ prompt: "صورة تجريبية للاستكمال" }), "خطأ مزود وهمي", attemptK1],
});

// 3) مهمة دمج فاشلة بروابط محفوظة
const mergeTask = "33333333-3333-4333-8333-333333333333";
await db.execute({
  sql: `INSERT INTO tasks (id, provider, provider_task_id, model, type, prompt, params_json, status, progress, error_message)
        VALUES (?, 'merger', 'dead-job-9', 'video-merger', 'merge', ?, ?, 'failed', 0, ?)`,
  args: [mergeTask, "دمج 2 مقاطع", JSON.stringify({ urls: ["https://example.com/a.mp4", "https://example.com/b.mp4"], resolvedUrls: ["https://example.com/a.mp4", "https://example.com/b.mp4"] }), "فشل خدمة وهمي"],
});

// 4) مهمة مكتملة — لاختبار رفض الاستكمال (409)
const doneTask = "44444444-4444-4444-8444-444444444444";
await db.execute({
  sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, status, progress, result_urls_json, completed_at)
        VALUES (?, 'cometapi', 'pv-old', ?, ?, 'image', 'مكتملة', 'completed', 100, ?, datetime('now'))`,
  args: [doneTask, k1, "gpt-image-2-6/flare-text-to-image", JSON.stringify(["https://example.com/done.png"])],
});

console.log(JSON.stringify({ videoTask, imageTask, mergeTask, doneTask, k1, k2 }, null, 2));
