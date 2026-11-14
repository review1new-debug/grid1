// GET /api/cron — حذف المهام المنتهية صلاحيتها (Cron يومي عبر vercel.json + تنظيف كسول عند كل إنشاء/دمج)
const { deleteExpiredJobs, dbHealthy } = require("../lib/db");
const { sendJson, sendError, cors } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") return sendError(req, res, 405, "طريقة غير مسموحة");

  try {
    const deleted = await deleteExpiredJobs();
    return sendJson(req, res, 200, { ok: true, deleted, turso: (await dbHealthy()) ? "connected" : "error", at: new Date().toISOString() });
  } catch (e) {
    console.error("[cron] error:", e);
    return sendError(req, res, 500, "فشل التنظيف: " + (e instanceof Error ? e.message : String(e)));
  }
};
