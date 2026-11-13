// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا بشكل متزامن → رابط الفيديو النهائي
// لو المهمة قيد المعالجة فعله يرجع 202، ولو منتهية يرجع النتيجة مباشرة
const { getJob, deleteExpiredJobs } = require("../../../lib/db");
const { processJob } = require("../../../lib/merge");
const { sendJson, sendError, publicOrigin, cors } = require("../../../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return sendError(req, res, 405, "طريقة غير مسموحة — استخدم POST لتنفيذ الدمج");
  }

  const jobId = String(req.query.id || "");
  try {
    void deleteExpiredJobs().catch(() => {});
    const job = await getJob(jobId);
    if (!job) return sendError(req, res, 404, "المهمة غير موجودة");

    const origin = publicOrigin(req);
    const videoUrl = `${origin}/api/jobs/${jobId}/video`;
    const downloadUrl = `${videoUrl}?download=1`;
    const baseResult = {
      jobId,
      videoUrl,
      downloadUrl,
      expiresAt: job.expires_at,
    };

    if (job.status === "done") {
      return sendJson(req, res, 200, {
        status: "done",
        ...baseResult,
        size: job.output_size,
        duration: job.output_duration,
        resolution: job.output_resolution,
      });
    }
    if (job.status === "failed") {
      return sendJson(req, res, 500, { status: "failed", ...baseResult, error: job.error || "فشل الدمج" });
    }
    if (job.status === "processing") {
      // منع تنفيذ مزدوج متزامن
      return sendJson(req, res, 202, { status: "processing", ...baseResult, progress: job.progress });
    }
    // queued أو uploading — تأكد أن الملفات مكتملة الرفع
    if (job.status === "uploading") {
      const missing = (job.sources || []).filter((s) => s.kind === "file" && s.size && (s.uploaded_bytes || 0) < s.size);
      if (missing.length) {
        return sendError(req, res, 409, `الملفات غير مكتملة الرفع بعد (${missing.length} مصدر ناقص) — أكمل رفع الأجزاء أولًا`);
      }
    }

    // تنفيذ متزامن (استغرق عادة 10-60 ثانية حسب الأحجام) — التقدم يُخزَّن في القاعدة ليقرأه GET المتوازي
    const result = await processJob(job);
    return sendJson(req, res, 200, {
      status: "done",
      ...baseResult,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
    });
  } catch (e) {
    console.error("[process] error:", e);
    return sendJson(req, res, 500, {
      status: "failed",
      jobId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
