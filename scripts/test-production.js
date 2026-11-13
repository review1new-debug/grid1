// اختبار e2e كامل ضد نشر Vercel الحقيقي
const BASE = "https://grid1-merger.vercel.app";
const URL_A = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";
const URL_B = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4";

const r = [];
function check(name, cond, extra = "") {
  r.push(cond);
  console.log(`${cond ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
}

async function main() {
  // 0) turso connected
  const cfg = await fetch(BASE + "/api/config", { signal: AbortSignal.timeout(20000) });
  const cj = await cfg.json();
  check("turso:connected في /api/config", cfg.status === 200 && cj.turso === "connected", `turso=${cj.turso}`);

  // 1) إنشاء مهمة
  const cr = await fetch(BASE + "/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: [URL_A, URL_B] }),
    signal: AbortSignal.timeout(30000),
  });
  const job = await cr.json();
  check("إنشاء مهمة → 201", cr.status === 201 && job.jobId, `jobId=${job.jobId}`);
  const id = job.jobId;

  // 2) الحالة الأولية
  const st0 = await (await fetch(`${BASE}/api/jobs/${id}`, { signal: AbortSignal.timeout(20000) })).json();
  check("الحالة الأولية queued", st0.status === "queued" && st0.progress === 0, `status=${st0.status}`);

  // 3) الدمج الفعلي (حد الدالة على Vercel Hobby = 60ث)
  console.log("⏳ تنفيذ الدمج على Vercel (قد يستغرق حتى 60ث)…");
  const t0 = Date.now();
  const pr = await fetch(`${BASE}/api/jobs/${id}/process`, {
    method: "POST",
    signal: AbortSignal.timeout(120000),
  });
  const pj = await pr.json();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check("process → done", pr.status === 200 && pj.status === "done",
    pr.status === 200
      ? `${(pj.duration || 0).toFixed?.(1)}ث ${pj.resolution} ${((pj.size || 0) / 1048576).toFixed(2)}MB خلال ${secs}ث`
      : `HTTP ${pr.status} ${JSON.stringify(pj).slice(0, 120)}`);

  if (pj.status === "done") {
    // 4) بث مع Range
    const rg = await fetch(`${BASE}/api/jobs/${id}/video`, {
      headers: { Range: "bytes=100-499" },
      signal: AbortSignal.timeout(20000),
    });
    const rb = Buffer.from(await rg.arrayBuffer());
    check("Range 206 على النشر الحقيقي",
      rg.status === 206 && rb.length === 400 && (rg.headers.get("content-range") || "").includes(`100-499/${pj.size}`),
      `status=${rg.status} len=${rb.length} cr=${rg.headers.get("content-range")}`);

    // 5) فحص الناتج MP4 (أول بايتات ftyp)
    const full = await fetch(`${BASE}/api/jobs/${id}/video`, { signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await full.arrayBuffer());
    check("الناتج MP4 صالح يبدأ بـ ftyp", full.status === 200 && buf.length === pj.size && buf.slice(4, 8).toString() === "ftyp",
      `${buf.length} بايت، header=${buf.slice(4, 8).toString()}`);
  }

  // 6) حذف المهمة (تنظيف أثر الاختبار)
  const del = await fetch(`${BASE}/api/jobs/${id}`, { method: "DELETE", signal: AbortSignal.timeout(20000) });
  const nf = await fetch(`${BASE}/api/jobs/${id}`, { signal: AbortSignal.timeout(20000) });
  check("حذف المهمة ثم 404", del.status === 200 && nf.status === 404, `del=${del.status} get=${nf.status}`);

  const ok = r.filter(Boolean).length;
  console.log(`\n———————————————\nالنتيجة: ${ok}/${r.length} على النشر الحقيقي`);
  process.exitCode = ok === r.length ? 0 : 1;
}

main().catch((e) => { console.error("❌ انهار الاختبار:", e.message); process.exit(1); });
