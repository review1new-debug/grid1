// lib/config.js — الحدود العامة القابلة للضبط بمتغيرات البيئة
const VERSION = "2.0.0";

function intEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const LIMITS = {
  maxSources: intEnv("MAX_SOURCES", 10),
  sourceMaxMB: intEnv("SOURCE_MAX_MB", 200),
  outputMaxMB: intEnv("OUTPUT_MAX_MB", 150),
  maxTotalDurationSec: intEnv("MAX_TOTAL_DURATION_SEC", 600),
  uploadChunkBytes: intEnv("UPLOAD_CHUNK_BYTES", 4 * 1024 * 1024),
  maxOutputW: 1920,
  maxOutputH: 1080,
  fps: 30,
  crf: 18,
  audioBitrate: "192k",
  audioRate: 44100,
};

const FFMPEG_PRESET = process.env.FFMPEG_PRESET || "medium";

module.exports = { VERSION, LIMITS, FFMPEG_PRESET };
