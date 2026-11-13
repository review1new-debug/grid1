// GET /api/jobs/<id>/video — بث الناتج من Turso بدعم Range (206 + Content-Range) لتقديم/ترجيع المشغل
// ?download=1 → تحميل مباشر (Content-Disposition: attachment)
const { getJob } = require("../../../lib/db");
const { readOutputStream } = require("../../../lib/store");
const { sendError, cors, sendJson } = require("../../../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendError(req, res, 405, "طريقة غير مسموحة — استخدم GET للبث");
  }

  const jobId = String(req.query.id || "");
  try {
    const job = await getJob(jobId);
    if (!job) return sendError(req, res, 404, "المهمة غير موجودة");
    if (job.status !== "done") {
      return sendJson(req, res, 409, {
        error: `الفيديو غير جاهز بعد (الحالة: ${job.status}، التقدم: ${job.progress}%)`,
        status: job.status,
        progress: job.progress,
      });
    }

    // تحليل ترويسة Range: bytes=start-end
    let range = null;
    const rangeHeader = String(req.headers.range || "");
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m && (m[1] !== "" || m[2] !== "")) {
      range = await resolveRange(jobId, m);
      if (!range) {
        // المدى خارج حدود الملف — 416 مع الحجم الكلي
        const total = (await readOutputStream(jobId))?.total || 0;
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.end();
      }
    }

    const out = await readOutputStream(jobId, range);
    if (!out) return sendError(req, res, 404, "لا يوجد ناتج مخزن لهذه المهمة");

    cors(res);
    const filename = `merged-${jobId}.mp4`;
    res.statusCode = range ? 206 : 200;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    if (range) {
      res.setHeader("Content-Range", `bytes ${out.start}-${out.end}/${out.total}`);
      res.setHeader("Content-Length", String(out.size));
    } else {
      res.setHeader("Content-Length", String(out.total));
    }
    if (req.query.download === "1") {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    }
    if (req.method === "HEAD") return res.end();

    // readOutputStream يعيد Node Readable جاهزًا — نمرّره مباشرة إلى استجابة Node
    out.stream.pipe(res);
  } catch (e) {
    console.error("[video] error:", e);
    if (!res.headersSent) sendError(req, res, 500, "خطأ داخلي أثناء البث");
    else res.destroy();
  }
};

async function resolveRange(jobId, m) {
  const total = (await readOutputStream(jobId))?.total || 0;
  if (!total) return null;
  let start;
  let end;
  if (m[1] === "") {
    // bytes=-N → آخر N بايت
    const n = Number(m[2]);
    if (n <= 0) return null;
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (start >= total) return null;
  return { start, end };
}
