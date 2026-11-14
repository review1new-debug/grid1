// scripts/test-unit.js — اختبار وحدات محرك الدمج والتخزين:
// 1) توليد فيديوهين مختلفي الدقة بـ ffmpeg  2) دمجهما والتحقق (الدقة/المدة/الصوت)
// 3) تخزين Turso واسترجاع بتطابق sha256  4) مسار رفع الأجزاء  5) حدود الحجم  6) الحذف الشامل
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// تحميل .env يدويًا (نفس منطق dev-server)
(function loadEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
})();

const { ensureSchema, insertJob, getJob, deleteJobRows } = require("../lib/db");
const { writeOutputBlob, readOutputStream, appendSourceChunk, assembleSourceToFile } = require("../lib/store");
const { probeFile, buildFilterArgs, processJob } = require("../lib/merge");
const { isPublicHttpUrl } = require("../lib/http");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
}
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function run(bin, args) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`${bin} فشل: ${r.stderr?.toString().slice(-300)}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-unit-"));
  try {
    // ————— 1) توليد فيديوهين مختلفي الدقة (الأول بصوت، الثاني صامت) —————
    const ffmpeg = require("../lib/merge").ffmpegPath();
    const v1 = path.join(tmp, "a.mp4"); // 640x360 — 5 ثوانٍ — بصوت
    const v2 = path.join(tmp, "b.mp4"); // 1280x720 — 4 ثوانٍ — صامت
    run(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=5",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:v", "libx264", "-preset", "veryfast",
      "-c:a", "aac", "-shortest", v1]);
    run(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4",
      "-c:v", "libx264", "-preset", "veryfast", v2]);
    check("توليد مقطعَي اختبار مختلفي الدقة", fs.existsSync(v1) && fs.existsSync(v2));

    const p1 = await probeFile(v1);
    const p2 = await probeFile(v2);
    check("ffprobe: الأول 640x360 بصوت", p1.width === 640 && p1.height === 360 && p1.hasAudio);
    check("ffprobe: الثاني 1280x720 صامت", p2.width === 1280 && p2.height === 720 && !p2.hasAudio);

    // ————— 2) بناء الفلتر: الهدف = أكبر دقة (1280x720) —————
    const { args: fargs, maxW, maxH } = buildFilterArgs(
      [{ kind: "url" }, { kind: "file" }], [p1, p2],
    );
    check("أبعاد الهدف = أكبر دقة مدخل", maxW === 1280 && maxH === 720, `${maxW}x${maxH}`);
    check("الفلاتر تشمل concat مع صوت", fargs.join(" ").includes("concat=n=2:v=1:a=1"));

    // ————— 3) دمج فعلي عبر خط المعالجة الكامل (في Turso الحقيقية) —————
    await ensureSchema();
    const jobId = "unit" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const expiresAt = new Date(Date.now() + 3600_000).toISOString().replace("T", " ").slice(0, 19);

    // نرفع المصدرَين كملفات عبر مسار الأجزاء (يختبر رفع الأجزاء أيضًا)
    const srcA = crypto.randomUUID();
    const srcB = crypto.randomUUID();
    const sources = [
      { id: srcA, seq: 0, kind: "file", name: "a.mp4", size: fs.statSync(v1).size, uploaded_bytes: fs.statSync(v1).size },
      { id: srcB, seq: 1, kind: "file", name: "b.mp4", size: fs.statSync(v2).size, uploaded_bytes: fs.statSync(v2).size },
    ];
    await insertJob({ id: jobId, status: "uploading", sources, expires_at: expiresAt });

    const bufA = fs.readFileSync(v1);
    const bufB = fs.readFileSync(v2);
    // تقسيم يدوي على أجزاء 1.5MB عبر appendSourceChunk (يحاكي رفع العميل)
    for (let i = 0; i * 1_572_864 < bufA.length; i++) await appendSourceChunk(jobId, srcA, i, bufA.subarray(i * 1_572_864, (i + 1) * 1_572_864));
    for (let i = 0; i * 1_572_864 < bufB.length; i++) await appendSourceChunk(jobId, srcB, i, bufB.subarray(i * 1_572_864, (i + 1) * 1_572_864));

    // التجميع من الأجزاء بتطابق sha256
    const asmA = path.join(tmp, "asm_a.mp4");
    await assembleSourceToFile(jobId, srcA, asmA);
    check("تجميع الأجزاء المرفوعة بتطابق sha256", sha256(fs.readFileSync(asmA)) === sha256(bufA));

    const job = await getJob(jobId);
    const t0 = Date.now();
    const result = await processJob(job);
    const elapsed = (Date.now() - t0) / 1000;
    check("اكتمال الدمج", result.resolution === "1280x720", `الدقة ${result.resolution} خلال ${elapsed.toFixed(1)}ث`);
    check("دقة الناتج = أكبر دقة مدخل", result.width === 1280 && result.height === 720);

    const j2 = await getJob(jobId);
    check("حالة المهمة done والتقدم 100", j2.status === "done" && j2.progress === 100);
    const durOk = Math.abs(j2.output_duration - (p1.duration + p2.duration)) < 1.5;
    check("المدة ≈ مجموع المدد", durOk, `${j2.output_duration?.toFixed(2)}ث مقابل ${p1.duration + p2.duration}ث`);

    // استرجاع الناتج وتطابق sha256 مع إعادة الترميز؟ (الناتج مخزن كما هو)
    const stored = await readOutputStream(jobId);
    const chunks = [];
    for await (const c of stored.stream) chunks.push(c);
    const storedBuf = Buffer.concat(chunks);
    check("حجم الناتج المخزن مطابق", storedBuf.length === j2.output_size, `${storedBuf.length} بايت`);
    check("الناتج MP4 صالح يبدأ بـ ftyp", storedBuf.subarray(4, 8).toString() === "ftyp");
    // وجود صوت في الناتج (المصدر الثاني كان صامتًا → أُضيف مسار صامت بدل الفشل)
    const outProbeTmp = path.join(tmp, "out_check.mp4");
    fs.writeFileSync(outProbeTmp, storedBuf);
    const outProbe = await probeFile(outProbeTmp);
    check("الناتج يحتوي مسار صوت (المصدر الصامت أُكمل بصمت)", outProbe.hasAudio, `${outProbe.width}x${outProbe.height} ${outProbe.duration?.toFixed(1)}ث`);

    // ————— 4) Range: قراءة جزء أوسط —————
    const mid = await readOutputStream(jobId, { start: 100, end: 199 });
    const midBuf = await (async () => { const cs = []; for await (const c of mid.stream) cs.push(c); return Buffer.concat(cs); })();
    check("قراءة Range أوسط صحيحة (100 بايت)", midBuf.length === 100 && midBuf.equals(storedBuf.subarray(100, 200)));

    // ————— 5) الحذف الشامل —————
    await deleteJobRows(jobId);
    check("الحذف الشامل يزيل المهمة", (await getJob(jobId)) === null);
    const afterDel = await readOutputStream(jobId);
    check("الناتج يختفي بعد الحذف", afterDel === null);

    // ————— 6) فحص الروابط العامة —————
    check("رفض localhost", !isPublicHttpUrl("http://localhost:3000/x.mp4"));
    check("رفض 127.0.0.1", !isPublicHttpUrl("http://127.0.0.1/x.mp4"));
    check("قبول رابط عام", isPublicHttpUrl("https://www.w3schools.com/html/mov_bbb.mp4"));
    check("رفض ftp", !isPublicHttpUrl("ftp://example.com/x.mp4"));

    // ————— 7) حد الحجم: رفع أكبر من المسموح يرفض (منطقًا عبر validate) —————
    const { LIMITS } = require("../lib/config");
    check("حدود قابلة للقراءة من البيئة", LIMITS.maxSources === 10 && LIMITS.sourceMaxMB === 200);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n———————————————\nالنتيجة: ${results.length - failed.length}/${results.length} اختبار ناجح`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("❌ انهار الاختبار:", e);
  process.exit(1);
});
