// lib/store.js — تخزين Blobs مجزأ في Turso + قراءة تدفقية بدعم Range
// كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من 8 صفوف
const { Readable } = require("node:stream");
const { getDb, ensureSchema } = require("./db");

const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB لكل صف
const PAGE_ROWS = 8; // قراءة تدفقية بصفحات من 8 صفوف (≈16MB في الذاكرة كحد أقصى)

// ————— إعادة محاولة لمرة واحدة للأخطاء الشبكية العابرة —————
// بعد نقل ملف كبير عبر نفس اتصال HTTP يغلق Turso الاتصال الخامل وقد يعيد undici
// استخدامه في الطلب التالي (UND_ERR_SOCKET / fetch failed) — المحاولة الثانية تفتح اتصالًا جديدًا وتنجح
const TRANSIENT_NET = /fetch failed|UND_ERR|socket|ECONNRESET|network|aborted/i;
function isTransientNet(e) {
  const msg = `${e?.message || ""} ${e?.cause?.message || ""} ${e?.cause?.code || ""}`;
  return TRANSIENT_NET.test(msg);
}
async function execRetry(db, stmt) {
  try {
    return await db.execute(stmt);
  } catch (e) {
    if (isTransientNet(e)) {
      await new Promise((r) => setTimeout(r, 200));
      return await db.execute(stmt);
    }
    throw e;
  }
}

function splitBuffer(buf, size) {
  const parts = [];
  for (let off = 0; off < buf.length; off += size) parts.push(buf.subarray(off, off + size));
  return parts;
}

// كتابة الناتج النهائي: (job_id, seq, data)
async function writeOutputBlob(jobId, buf) {
  await ensureSchema();
  const db = getDb();
  const parts = splitBuffer(buf, CHUNK_SIZE);
  const batch = parts.map((p, i) => ({
    sql: "INSERT INTO output_chunks (job_id, seq, data) VALUES (?, ?, ?)",
    args: [jobId, i, p],
  }));
  await db.batch(batch, "write");
  return parts.length;
}

// إلحاق جزء مرفوع (حتى 4MB من العميل) يُقسَّم داخليًا إلى صفوف ≤2MB
// seq = chunkIndex * 1000 + subIndex — يضمن الترتيب دون الاعتماد على تزامن الوصول
async function appendSourceChunk(jobId, sourceId, chunkIndex, buf) {
  await ensureSchema();
  const db = getDb();
  const parts = splitBuffer(buf, CHUNK_SIZE);
  const batch = parts.map((p, i) => ({
    sql: "INSERT INTO source_chunks (job_id, source_id, seq, data) VALUES (?, ?, ?, ?)",
    args: [jobId, sourceId, chunkIndex * 1000 + i, p],
  }));
  await db.batch(batch, "write");
  return parts.length;
}

async function sourceBytesStored(jobId, sourceId) {
  await ensureSchema();
  const r = await execRetry(getDb(), {
    sql: "SELECT COALESCE(SUM(length(data)), 0) AS total FROM source_chunks WHERE job_id = ? AND source_id = ?",
    args: [jobId, sourceId],
  });
  return Number(r.rows[0]?.total) || 0;
}

async function outputBytesStored(jobId) {
  await ensureSchema();
  const r = await execRetry(getDb(), {
    sql: "SELECT COALESCE(SUM(length(data)), 0) AS total FROM output_chunks WHERE job_id = ?",
    args: [jobId],
  });
  return Number(r.rows[0]?.total) || 0;
}

// تجميع أجزاء مصدر مرفوع إلى ملف على /tmp أثناء المعالجة
async function assembleSourceToFile(jobId, sourceId, filePath) {
  await ensureSchema();
  const db = getDb();
  const fs = require("node:fs");
  const out = fs.createWriteStream(filePath);
  let after = -1; // نبدأ قبل seq=0 حتى لا نفوّت أول صف
  // صفحات من 8 صفوف — keyset pagination على seq
  for (;;) {
    const r = await execRetry(db, {
      sql: "SELECT seq, data FROM source_chunks WHERE job_id = ? AND source_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      args: [jobId, sourceId, after, PAGE_ROWS],
    });
    if (!r.rows.length) break;
    for (const row of r.rows) {
      const data = row.data;
      const buf = typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data);
      if (!out.write(buf)) await new Promise((res) => out.once("drain", res));
      after = Number(row.seq);
    }
  }
  await new Promise((res) => out.end(res));
  return fs.statSync(filePath).size;
}

/**
 * قراءة الناتج كتدفق Node مع دعم Range (تقليم أول/آخر جزء حسب المدى المطلوب)
 * range: { start, end } شامل — أو undefined لكامل الملف
 */
async function readOutputStream(jobId, range) {
  await ensureSchema();
  const db = getDb();
  const total = await outputBytesStored(jobId);
  if (!total) return null;
  const start = range ? Math.max(0, range.start) : 0;
  const end = range ? Math.min(total - 1, range.end) : total - 1;
  if (start > end) return null;

  const firstRow = Math.floor(start / CHUNK_SIZE);
  const lastRow = Math.floor(end / CHUNK_SIZE);
  let offsetInFirst = start - firstRow * CHUNK_SIZE;
  let remaining = end - start + 1;

  // Readable بنمط ضغط خلفي صحيح: المستهلك يستدعي _read ← نستأنف التغذية
  // (حدث drain خاص بالـ Writable ولا يعمل على Readable)
  let resumeFeed = null;
  const stream = new Readable({
    highWaterMark: 4 * 1024 * 1024,
    read() {
      if (resumeFeed) {
        const r = resumeFeed;
        resumeFeed = null;
        r();
      }
    },
  });

  (async () => {
    try {
      let after = firstRow - 1;
      for (;;) {
        const r = await execRetry(db, {
          sql: "SELECT seq, data FROM output_chunks WHERE job_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?",
          args: [jobId, after, lastRow, PAGE_ROWS],
        });
        if (!r.rows.length) break;
        for (const row of r.rows) {
          let buf = typeof row.data === "string" ? Buffer.from(row.data, "base64") : Buffer.from(row.data);
          if (offsetInFirst > 0) {
            buf = buf.subarray(offsetInFirst);
            offsetInFirst = 0;
          }
          if (buf.length > remaining) buf = buf.subarray(0, remaining);
          remaining -= buf.length;
          after = Number(row.seq);
          if (buf.length && !stream.push(buf)) {
            // المخزن ممتلئ — توقف حتى يستهلك المستهلك ويستدعي _read
            await new Promise((res) => (resumeFeed = res));
          }
          if (remaining <= 0) {
            stream.push(null);
            return;
          }
        }
        if (after >= lastRow) break;
      }
      stream.push(null);
    } catch (e) {
      stream.destroy(e);
    }
  })();
  return { stream, total, start, end, size: end - start + 1 };
}

module.exports = {
  CHUNK_SIZE,
  PAGE_ROWS,
  writeOutputBlob,
  appendSourceChunk,
  sourceBytesStored,
  outputBytesStored,
  assembleSourceToFile,
  readOutputStream,
};
