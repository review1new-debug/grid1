// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB، Content-Type: application/octet-stream)
const { getJob, patchJob } = require("../lib/db");
const { appendSourceChunk, sourceBytesStored } = require("../lib/store");
const { LIMITS } = require("../lib/config");
const { sendJson, sendError, readRawBody, cors } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return sendError(req, res, 405, "طريقة غير مسموحة — استخدم POST لرفع الأجزاء");
  }

  try {
    const jobId = String(req.query.job || "");
    const sourceSeq = Number(req.query.seq);
    const chunkIdx = Number(req.query.chunk ?? 0);

    if (!jobId || !Number.isFinite(sourceSeq)) {
      return sendError(req, res, 400, "المعاملات job و seq مطلوبة (chunk اختياري ويبدأ من 0)");
    }

    const job = await getJob(jobId);
    if (!job) return sendError(req, res, 404, "المهمة غير موجودة");
    if (["done", "failed", "processing"].includes(job.status)) {
      return sendError(req, res, 409, `لا يمكن الرفع في حالة المهمة الحالية (${job.status})`);
    }
    const source = (job.sources || []).find((s) => s.seq === sourceSeq);
    if (!source) return sendError(req, res, 404, "لا يوجد مصدر بهذا الترتيب في المهمة");
    if (source.kind !== "file") return sendError(req, res, 409, "هذا المصدر رابط وليس ملفًا مرفوعًا");

    const buf = await readRawBody(req, LIMITS.uploadChunkBytes + 512 * 1024);
    if (!buf.length) return sendError(req, res, 400, "جسم الطلب فارغ — أرسل البيانات الثنائية مباشرة");

    // حد الحجم الكلي لكل مصدر (نفحص التراكمي أثناء الرفع)
    const stored = await sourceBytesStored(jobId, source.id);
    if (stored + buf.length > LIMITS.sourceMaxMB * 1024 * 1024) {
      return sendError(req, res, 413, `حجم الملف «${source.name}» يتجاوز الحد (${LIMITS.sourceMaxMB} ميجابايت)`);
    }

    await appendSourceChunk(jobId, source.id, chunkIdx, buf);
    const total = await sourceBytesStored(jobId, source.id);
    await patchJob(jobId, { sources: job.sources.map((s) => (s.seq === sourceSeq ? { ...s, uploaded_bytes: total } : s)) });

    return sendJson(req, res, 200, {
      ok: true,
      storedBytes: total,
      declaredBytes: source.size || 0,
      complete: source.size ? total >= source.size : true,
    });
  } catch (e) {
    console.error("[upload] error:", e);
    return sendError(req, res, e.statusCode || 500, e.message || "خطأ داخلي أثناء الرفع");
  }
};
