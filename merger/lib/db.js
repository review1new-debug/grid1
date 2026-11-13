// lib/db.js — عميل Turso (libSQL عبر HTTP) + إنشاء المخطط عند أول وصول
// كل شيء يُخزَّن في Turso: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs) — لا S3 ولا خدمات خارجية
const { createClient } = require("@libsql/client");

let client = null;
let schemaReady = null;

function getDb() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبان (ضعيهما في بيئة Vercel أو ملف .env)");
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

async function doEnsure(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER DEFAULT 0,
    error TEXT,
    sources_json TEXT NOT NULL DEFAULT '[]',
    output_size INTEGER,
    output_duration REAL,
    output_resolution TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    url TEXT,
    name TEXT,
    size INTEGER,
    mime TEXT,
    uploaded_bytes INTEGER DEFAULT 0,
    duration REAL,
    width INTEGER,
    height INTEGER,
    has_audio INTEGER DEFAULT 0,
    meta_json TEXT DEFAULT '{}'
  )`);
  // مفتاح أساسي مركب: (job_id, source_id, seq) — كل صف ≤ 2MB (حد HTTP في Turso)
  await db.execute(`CREATE TABLE IF NOT EXISTS source_chunks (
    job_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, source_id, seq)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS output_chunks (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, seq)
  )`);
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = doEnsure(getDb()).catch((e) => {
      schemaReady = null; // اسمح بإعادة المحاولة عند فشل عابر
      throw e;
    });
  }
  return schemaReady;
}

async function dbHealthy() {
  try {
    await ensureSchema();
    const r = await getDb().execute("SELECT 1");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

async function getJob(id) {
  await ensureSchema();
  const r = await getDb().execute({ sql: "SELECT * FROM jobs WHERE id = ? LIMIT 1", args: [id] });
  if (!r.rows.length) return null;
  const row = r.rows[0];
  let sources = [];
  try {
    sources = JSON.parse(row.sources_json || "[]");
  } catch {}
  return {
    id: String(row.id),
    status: String(row.status || "queued"),
    progress: Number(row.progress) || 0,
    error: row.error == null ? null : String(row.error),
    sources,
    output_size: row.output_size == null ? null : Number(row.output_size),
    output_duration: row.output_duration == null ? null : Number(row.output_duration),
    output_resolution: row.output_resolution == null ? null : String(row.output_resolution),
    expires_at: String(row.expires_at || ""),
    created_at: String(row.created_at || ""),
  };
}

async function patchJob(id, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  const map = {
    status: "status = ?",
    progress: "progress = ?",
    error: "error = ?",
    output_size: "output_size = ?",
    output_duration: "output_duration = ?",
    output_resolution: "output_resolution = ?",
  };
  for (const [k, frag] of Object.entries(map)) {
    if (patch[k] !== undefined) {
      sets.push(frag);
      args.push(patch[k]);
    }
  }
  if (patch.sources !== undefined) {
    sets.push("sources_json = ?");
    args.push(JSON.stringify(patch.sources));
  }
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await getDb().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
  return getJob(id);
}

async function insertJob(job) {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO jobs (id, status, progress, sources_json, expires_at) VALUES (?, ?, ?, ?, ?)`,
    args: [job.id, job.status || "queued", 0, JSON.stringify(job.sources || []), job.expires_at],
  });
}

// تنظيف كسول: حذف كل المهمات المنتهية (expires_at < الآن) — يُستدعى عند كل إنشاء/دمج + نقطة cron
async function deleteExpiredJobs() {
  await ensureSchema();
  const r = await getDb().execute({
    sql: `SELECT id FROM jobs WHERE expires_at < datetime('now') LIMIT 100`,
  });
  let deleted = 0;
  for (const row of r.rows) {
    deleted += await deleteJobRows(String(row.id));
  }
  return deleted;
}

// حذف شامل لكل صفوف المهمة في batch واحد (jobs + sources + source_chunks + output_chunks)
async function deleteJobRows(jobId) {
  await ensureSchema();
  const db = getDb();
  const batch = [
    { sql: "DELETE FROM jobs WHERE id = ?", args: [jobId] },
    { sql: "DELETE FROM sources WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] },
  ];
  const res = await db.batch(batch, "write");
  let affected = 0;
  for (const r of res) affected += r.rowsAffected || 0;
  return affected;
}

// بعد نجاح الدمج: احذف source_chunks — الناتج فقط هو المطلوب
async function deleteSourceChunks(jobId) {
  await ensureSchema();
  await getDb().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
}

module.exports = {
  getDb,
  ensureSchema,
  dbHealthy,
  getJob,
  patchJob,
  insertJob,
  deleteExpiredJobs,
  deleteJobRows,
  deleteSourceChunks,
};
