// scripts/dev-server.js — خادم تطوير محلي يحاكي بيئة Vercel:
// يحلّل المسارات الديناميكية ويضعها في req.query، يحمّل .env يدويًا، ويخدم public/ ثابتًا
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT = path.join(__dirname, "..");

// ————— تحميل .env يدويًا (بدون مكتبات) — لا نتجاوز قيمًا موجودة —————
(function loadEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
})();

// ————— جدول المسارات: (method, نمط المسار → ملف الدالة) — الديناميكي [id] يجلس في req.query.id —————
const routes = [
  { method: "POST", pattern: /^\/api\/jobs\/([\w-]+)\/process$/, file: "api/jobs/[id]/process.js", param: "id" },
  { method: "GET", pattern: /^\/api\/jobs\/([\w-]+)\/video$/, file: "api/jobs/[id]/video.js", param: "id" },
  { method: "GET|DELETE", pattern: /^\/api\/jobs\/([\w-]+)$/, file: "api/jobs/[id]/index.js", param: "id" },
  { method: "POST", pattern: /^\/api\/upload$/, file: "api/upload.js" },
  { method: "POST", pattern: /^\/api\/jobs$/, file: "api/jobs.js" },
  { method: "GET", pattern: /^\/api\/config$/, file: "api/config.js" },
  { method: "GET", pattern: /^\/api\/cron$/, file: "api/cron.js" },
];

const PORT = Number(process.env.PORT || 8787);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(u.pathname);
  res.on("finish", () => console.log(`[req] ${req.method} ${pathname} → ${res.statusCode}`));

  try {
    // 1) نقاط API — نحاكي سلوك Vercel: المسار يُطابق بنمطه أينما كان، والمعاملات الديناميكية تُدمج في req.query
    // (الطريقة الخاطئة تصل للمعالج نفسه فيعود 405 منه — تمامًا مثل الإنتاج)
    for (const r of routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      req.query = { ...Object.fromEntries(u.searchParams) };
      if (r.param) req.query[r.param] = m[1];
      const handler = require(path.join(ROOT, r.file));
      await handler(req, res);
      return;
    }

    // 2) الواجهة الثابتة
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const abs = path.join(ROOT, "public", path.normalize(filePath).replace(/^(\.\.[/\\])+/, ""));
    if (abs.startsWith(path.join(ROOT, "public")) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      res.statusCode = 200;
      res.setHeader("Content-Type", MIME[path.extname(abs)] || "application/octet-stream");
      fs.createReadStream(abs).pipe(res);
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "غير موجود" }));
  } catch (e) {
    console.error("[dev-server]", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    } else res.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`✔ خادم تطوير خدمة الدمج يعمل على http://localhost:${PORT}`);
  console.log(`  TURSO_DATABASE_URL: ${process.env.TURSO_DATABASE_URL ? "مضبوط ✔" : "مفقود ✗"}`);
});
