// POST /api/jobs — إنشاء مهمة دمج: يقبل {"videos":[...]} أو {"sources":[{kind:"url"|"file",...}]}
const crypto = require("node:crypto");
const { ensureSchema, insertJob, deleteExpiredJobs } = require("../lib/db");
const { LIMITS, VERSION } = require("../lib/config");
const { sendJson, sendError, readJsonBody, publicOrigin, isPublicHttpUrl } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    require("../lib/http").cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    return sendError(req, res, 405, "طريقة غير مسموحة — استخدم POST لإنشاء مهمة");
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendError(req, res, e.statusCode || 400, e.message);
  }

  try {
    // تنظيف كسول للمهمات المنتهية عند كل إنشاء
    void deleteExpiredJobs().catch(() => {});

    let sources = [];
    if (Array.isArray(body.videos)) {
      sources = body.videos.map((u) => ({ kind: "url", url: String(u || "").trim() }));
    } else if (Array.isArray(body.sources)) {
      sources = body.sources.map((s) => {
        if (!s || typeof s !== "object") return { kind: "bad" };
        if (s.kind === "file") {
          return {
            kind: "file",
            name: String(s.name || "file.bin").slice(0, 200),
            size: Number(s.size) || 0,
            mime: String(s.mime || "video/mp4").slice(0, 100),
          };
        }
        return { kind: "url", url: String(s.url || "").trim() };
      });
    } else {
      return sendError(req, res, 400, 'جسم الطلب يجب أن يحتوي {"videos":["رابط1","رابط2"]} أو {"sources":[...]}');
    }

    // تحقق صارم: ≥2 مصادر وكل الروابط http/https مباشرة وعامة
    if (sources.length < 2) {
      return sendError(req, res, 400, "الدمج يحتاج مقطعَين على الأقل — أضف مصدرَين على الأقل بالترتيب المطلوب");
    }
    if (sources.length > LIMITS.maxSources) {
      return sendError(req, res, 400, `أقصى عدد مقاطع للدمج هو ${LIMITS.maxSources}`);
    }
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (s.kind === "url" && !isPublicHttpUrl(s.url)) {
        return sendError(req, res, 400, `المصدر رقم ${i + 1} ليس رابط http/https مباشرًا وعامًا: ${s.url || "(فارغ)"}`);
      }
      if (s.kind === "file" && s.size > LIMITS.sourceMaxMB * 1024 * 1024) {
        return sendError(req, res, 413, `حجم الملف «${s.name}» يتجاوز الحد (${LIMITS.sourceMaxMB} ميجابايت)`);
      }
    }

    const jobId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const hasFiles = sources.some((s) => s.kind === "file");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

    // معرّفات المصادر تُنشأ هنا وتُخزَّن بالترتيب (ترتيب القائمة = ترتيب الدمج)
    sources = sources.map((s, i) => ({ ...s, id: crypto.randomUUID(), seq: i }));

    await ensureSchema();
    await insertJob({ id: jobId, status: hasFiles ? "uploading" : "queued", sources, expires_at: expiresAt });

    const origin = publicOrigin(req);
    const response = {
      jobId,
      status: hasFiles ? "uploading" : "queued",
      statusUrl: `${origin}/api/jobs/${jobId}`,
      processUrl: `${origin}/api/jobs/${jobId}/process`,
      expiresAt,
    };
    // إن وُجدت ملفات يرجع uploads[] برابط رفع لكل مصدر + حجم الجزء المطلوب
    if (hasFiles) {
      response.uploads = sources
        .filter((s) => s.kind === "file")
        .map((s) => ({
          sourceId: s.id,
          name: s.name,
          size: s.size,
          uploadUrl: `${origin}/api/upload?job=${jobId}&seq=${s.seq}&chunk=0`,
          uploadChunkBytes: LIMITS.uploadChunkBytes,
        }));
    }
    return sendJson(req, res, 201, response);
  } catch (e) {
    console.error("[jobs] create error:", e);
    return sendError(req, res, 500, "خطأ داخلي أثناء إنشاء المهمة");
  }
};

module.exports.VERSION = VERSION;
