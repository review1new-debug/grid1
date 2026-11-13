// scripts/test-http.js — اختبار HTTP كامل ضد خادم التطوير:
// إنشاء من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع) → حذف → 404 → JSON تالف → قائمة فارغة → الحدود
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

// تحميل .env يدويًا
(function loadEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
})();

const BASE = `http://localhost:${process.env.PORT || 8787}`;
const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
}
// رابطا اختبار عامان يعملان من بيئة السحابة (w3schools يرفض بعض مراكز البيانات بـ 403)
const URL_A = process.env.TEST_URL_A || "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
const URL_B = process.env.TEST_URL_B || "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4";
async function api(method, p, body, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body && typeof body === "object" && headers["Content-Type"] === "application/octet-stream" ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, headers: r.headers, text };
}

async function main() {
  const created = []; // للتنظيف في النهاية
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));

  try {
    // ————— 1) config + قائمة فارغة + JSON تالف —————
    const cfg = await api("GET", "/api/config");
    check("GET /api/config يعمل مع الحدود", cfg.status === 200 && cfg.json.maxSources === 10 && cfg.json.turso === "connected", `v${cfg.json.version}`);

    const badJson = await api("POST", "/api/jobs", undefined, { "Content-Type": "application/json" });
    // جسم فارغ → {} → لا videos ولا sources → 400 برسالة عربية
    check("JSON تالف/فارغ → 400 برسالة عربية", badJson.status === 400 && /على الأقل|يجب أن/.test(badJson.json?.error || ""), badJson.json?.error?.slice(0, 50));

    const one = await api("POST", "/api/jobs", { videos: ["https://example.com/only.mp4"] });
    check("مقطع واحد → رفض 400", one.status === 400, one.json?.error?.slice(0, 50));
    const eleven = await api("POST", "/api/jobs", { videos: Array.from({ length: 11 }, (_, i) => `https://x.com/v${i}.mp4`) });
    check("11 مقطعًا → رفض 400", eleven.status === 400, eleven.json?.error?.slice(0, 50));
    const internal = await api("POST", "/api/jobs", { videos: ["http://localhost:9/x.mp4", "https://ok.com/x.mp4"] });
    check("رابط داخلي → رفض 400", internal.status === 400);

    // ————— 2) مهمة من روابط عامة → دمج → النتيجة (مقاطع مختلفا الدقة: 360p ثم 720p) —————
    const cr = await api("POST", "/api/jobs", {
      videos: [URL_A, URL_B],
    });
    check("إنشاء مهمة من روابط → 201", cr.status === 201 && cr.json.jobId && cr.json.statusUrl, `jobId=${cr.json?.jobId}`);
    const jobId = cr.json.jobId;
    created.push(jobId);

    const st0 = await api("GET", `/api/jobs/${jobId}`);
    check("الحالة الأولية queued", st0.status === 200 && st0.json.status === "queued" && st0.json.progress === 0);

    const pr = await api("POST", `/api/jobs/${jobId}/process`);
    check("process متزامن → done مع videoUrl", pr.status === 200 && pr.json.status === "done" && !!pr.json.videoUrl,
      `${(pr.json.duration || 0).toFixed?.(1) || pr.json.duration}ث ${pr.json.resolution} ${(pr.json.size / 1048576).toFixed?.(2) || "?"}MB`);
    check("الروابط على نطاق الخدمة نفسها (عام)", pr.json.videoUrl.startsWith(BASE));

    // ————— 3) بث مع Range → 206 + Content-Range —————
    const head = await fetch(`${BASE}/api/jobs/${jobId}/video`);
    const total = Number(head.headers.get("content-length"));
    check("بث كامل 200 مع Accept-Ranges", head.status === 200 && head.headers.get("accept-ranges") === "bytes" && total > 0, `${total} بايت`);
    await head.arrayBuffer();

    const range = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=100-499" } });
    const rb = Buffer.from(await range.arrayBuffer());
    const crh = range.headers.get("content-range");
    check("Range 206 مع Content-Range صحيح",
      range.status === 206 && crh === `bytes 100-499/${total}` && rb.length === 400,
      `status=${range.status} cr=${crh} len=${rb.length}`);

    const tail = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=-1000" } });
    check("Range لاحق (-1000) → 206", tail.status === 206 && Number(tail.headers.get("content-length")) === 1000);
    await tail.arrayBuffer();

    const dl = await fetch(`${BASE}/api/jobs/${jobId}/video?download=1`);
    check("download=1 يعطي Content-Disposition", (dl.headers.get("content-disposition") || "").includes("attachment"));
    await dl.arrayBuffer();

    const st1 = await api("GET", `/api/jobs/${jobId}`);
    check("الحالة done مع الحقائق", st1.json.status === "done" && st1.json.resolution && st1.json.duration > 0, `${st1.json.resolution} ${st1.json.duration?.toFixed?.(1)}ث`);
    check("دقة الناتج = أكبر دقة مدخل (720p)", st1.json.resolution === "1280x720", st1.json.resolution);
    // URL_A (10ث 360p) + URL_B (10ث 720p) = 20ث تقريبًا
    const durOk = Math.abs(st1.json.duration - 20) < 3;
    check("مدة الناتج ≈ مجموع المدد", durOk, `${st1.json.duration?.toFixed?.(1) || st1.json.duration}ث مقابل 20ث`);

    // ————— 4) مهمة مختلطة (رابط + ملف مرفوع على أجزاء) —————
    // توليد ملف اختبار محلي بـ ffmpeg (نفس الثنائي المستخدم في الإنتاج)
    const { ffmpegPath } = require("../lib/merge");
    const vfile = path.join(tmp, "up.mp4");
    await new Promise((resolve, reject) => {
      const { spawnSync } = require("node:child_process");
      const r = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4",
        "-c:v", "libx264", "-preset", "veryfast", vfile], { stdio: ["ignore", "ignore", "pipe"] });
      if (r.status !== 0) reject(new Error(r.stderr?.toString().slice(-200)));
      else resolve();
    });
    const vbuf = fs.readFileSync(vfile);

    const cr2 = await api("POST", "/api/jobs", {
      sources: [
        { kind: "file", name: "up.mp4", size: vbuf.length, mime: "video/mp4" },
        { kind: "url", url: URL_B },
      ],
    });
    check("إنشاء مهمة مختلطة → 201 مع uploads[]", cr2.status === 201 && cr2.json.status === "uploading" && Array.isArray(cr2.json.uploads) && cr2.json.uploads.length === 1);
    const j2 = cr2.json.jobId;
    created.push(j2);

    const chunkBytes = cr2.json.uploadChunkBytes || 4194304;
    let okUploads = true;
    for (let k = 0; k * chunkBytes < vbuf.length; k++) {
      const up = await api("POST",
        `/api/upload?job=${j2}&seq=0&chunk=${k}`,
        vbuf.subarray(k * chunkBytes, Math.min(vbuf.length, (k + 1) * chunkBytes)),
        { "Content-Type": "application/octet-stream" });
      if (up.status !== 200) { okUploads = false; break; }
    }
    check("رفع أجزاء الملف كاملة (≤4MB لكل جزء)", okUploads);

    const early = await api("POST", `/api/jobs/${j2}/process`);
    check("process لمهمة مكتملة الرفع يعمل", early.status === 200 && early.json.status === "done", early.json?.resolution);
    const st2 = await api("GET", `/api/jobs/${j2}`);
    check("المهمة المختلطة done", st2.json.status === "done" && st2.json.duration > 5, `${st2.json.duration?.toFixed?.(1)}ث`);

    // ————— 5) 404 لغير الموجود + حذف شامل —————
    const nf = await api("GET", "/api/jobs/doesnotexist123");
    check("مهمة غير موجودة → 404", nf.status === 404);

    const del = await api("DELETE", `/api/jobs/${j2}`);
    const nf2 = await api("GET", `/api/jobs/${j2}`);
    check("DELETE ثم GET → 404", del.status === 200 && nf2.status === 404);

    const nfProc = await api("POST", "/api/jobs/doesnotexist123/process");
    check("process لغير الموجود → 404", nfProc.status === 404);

    // ————— 6) method خاطئ —————
    const wm = await api("PUT", `/api/jobs/${jobId}`);
    check("PUT → 405", wm.status === 405);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n———————————————\nالنتيجة: ${results.length - failed.length}/${results.length} اختبار HTTP ناجح`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    // تنظيف آثار الاختبار من القاعدة ثم إنهاء العملية صراحة (خادم التطوير المولّد يبقي الحلقة حية)
    for (const id of created) await api("DELETE", `/api/jobs/${id}`).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
    try { globalThis.serverChild?.kill(); } catch {}
    process.exit(process.exitCode || 0);
  }
}

// ————— تشغيل خادم التطوير تلقائيًا إن لم يكن عاملًا —————
async function ensureServer() {
  try {
    const r = await fetch(BASE + "/api/config", { signal: AbortSignal.timeout(1500) });
    if (r.ok) return;
  } catch {}
  console.log("⏳ تشغيل خادم التطوير تلقائيًا…");
  const child = spawn(process.execPath, [path.join(__dirname, "dev-server.js")], {
    stdio: "ignore",
    env: { ...process.env, PORT: process.env.PORT || 8787 },
  });
  globalThis.serverChild = child; // نقتله بعد انتهاء الاختبار حتى لا يبقي العملية حية
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const r = await fetch(BASE + "/api/config", { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch {}
  }
  throw new Error("خادم التطوير لم يجهز — تأكد من TURSO_DATABASE_URL و TURSO_AUTH_TOKEN في merger/.env");
}

ensureServer()
  .then(main)
  .catch((e) => {
    console.error("❌ انهار الاختبار:", e);
    process.exit(1);
  });
