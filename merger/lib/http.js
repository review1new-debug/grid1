// lib/http.js — مساعدات استجابة موحدة: CORS مفتوح، أخطاء {"error":"..."} بأكواد صحيحة
const { URL } = require("node:url");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Content-Length, Range, Authorization",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Disposition",
};

function cors(res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
}

function sendJson(req, res, status, obj) {
  cors(res);
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

function sendError(req, res, status, message) {
  sendJson(req, res, status, { error: message });
}

// قراءة جسم JSON مع رفض التالف برسالة عربية
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const buf = await readRawBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    const e = new Error("جسم الطلب يجب أن يكون JSON صالحًا");
    e.statusCode = 400;
    throw e;
  }
}

// قراءة جسم ثنائي خام (رفع الأجزاء) بحد أقصى
function readRawBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        const e = new Error(`حجم الطلب يتجاوز الحد المسموح (${Math.round(maxBytes / 1024 / 1024)} ميجابايت)`);
        e.statusCode = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// استنتاج العنوان العام لبناء روابط النتائج (Vercel يمرر x-forwarded-*، ومحليًا http)
function publicOrigin(req) {
  const envBase = (process.env.MERGER_PUBLIC_BASE || "").trim().replace(/\/+$/, "");
  if (envBase) return envBase;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000").split(",")[0].trim();
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

// تحقق أن الرابط http/https مباشر وعام (لا نطاقات داخلية)
function isPublicHttpUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!url.hostname) return false;
    const h = url.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h)) return false;
    // نطاقات داخلية لعناوين Vercel/الدوكر الشائعة
    if (/\.internal$/.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = { cors, sendJson, sendError, readJsonBody, readRawBody, publicOrigin, isPublicHttpUrl };
