// GET /api/jobs/<id> — الحالة + التقدم (0-100) + الرابط عند الاكتمال
// DELETE /api/jobs/<id> — حذف فوري شامل (كل الصفوف في batch واحد)
const { getJob, deleteJobRows } = require("../../../lib/db");
const { sendJson, sendError, publicOrigin, cors } = require("../../../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }

  const jobId = String(req.query.id || "");
  if (!jobId) return sendError(req, res, 400, "معرّف المهمة مطلوب");

  try {
    const job = await getJob(jobId);
    if (!job) return sendError(req, res, 404, "المهمة غير موجودة");

    if (req.method === "DELETE") {
      await deleteJobRows(jobId);
      return sendJson(req, res, 200, { ok: true, deleted: jobId });
    }
    if (req.method !== "GET") {
      return sendError(req, res, 405, "طريقة غير مسموحة — استخدم GET للحالة أو DELETE للحذف");
    }

    const origin = publicOrigin(req);
    const out = {
      jobId,
      status: job.status,
      progress: job.progress,
      expiresAt: job.expires_at,
      sources: (job.sources || []).map((s) => ({
        seq: s.seq,
        kind: s.kind,
        name: s.name || s.url || "",
        size: s.size || null,
        uploadedBytes: s.uploaded_bytes || 0,
      })),
    };
    if (job.status === "done") {
      out.videoUrl = `${origin}/api/jobs/${jobId}/video`;
      out.downloadUrl = `${origin}/api/jobs/${jobId}/video?download=1`;
      out.size = job.output_size;
      out.duration = job.output_duration;
      out.resolution = job.output_resolution;
    }
    if (job.status === "failed") out.error = job.error || "فشل الدمج";
    return sendJson(req, res, 200, out);
  } catch (e) {
    console.error("[jobs/:id] error:", e);
    return sendError(req, res, 500, "خطأ داخلي");
  }
};
