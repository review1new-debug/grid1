// GET /api/config — الحدود العامة + version + جهوزية Turso (تُستخدم لفحص الجهوزية)
const { VERSION, LIMITS } = require("../lib/config");
const { dbHealthy } = require("../lib/db");
const { sendJson, sendError, cors } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") return sendError(req, res, 405, "طريقة غير مسموحة");

  const tursoOk = await dbHealthy();
  return sendJson(req, res, tursoOk ? 200 : 503, {
    version: VERSION,
    maxSources: LIMITS.maxSources,
    sourceMaxMB: LIMITS.sourceMaxMB,
    outputMaxMB: LIMITS.outputMaxMB,
    maxTotalDurationSec: LIMITS.maxTotalDurationSec,
    uploadChunkBytes: LIMITS.uploadChunkBytes,
    output: { container: "mp4", codec: "h264+aac", crf: LIMITS.crf, maxResolution: "1920x1080", fps: LIMITS.fps },
    retentionHours: 24,
    turso: tursoOk ? "connected" : "error",
  });
};
