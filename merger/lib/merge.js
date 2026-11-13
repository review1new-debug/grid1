// lib/merge.js — محرك الدمج (الأهم): ffprobe لكل مصدر ← توحيد عبر filter_complex ← libx264 CRF 18 + AAC
// تقدم الترميز يُقرأ من -progress pipe:1 ويُخزَّن في القاعدة (0-40 سحب، 40-90 ترميز، 100 اكتمال)
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { getDb, patchJob } = require("./db");
const { LIMITS, FFMPEG_PRESET } = require("./config");

// ————— ضمان صلاحية تنفيذ الثنائيات (قد تفقد في الاستضافة) — ننسخها إلى /tmp بصلاحية 755 عند الحاجة —————
function resolveBin(npmModule, envKey, fallbackCmd) {
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) return process.env[envKey];
  try {
    const mod = require(npmModule);
    const p = typeof mod === "string" ? mod : mod.path;
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return fallbackCmd; // ثنائي النظام كاحتياط أخير
}

function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), `merger-bin-${path.basename(binPath)}-${process.pid}`);
    fs.copyFileSync(binPath, tmp);
    fs.chmodSync(tmp, 0o755);
    return tmp;
  }
}

function ffmpegPath() {
  return ensureExecutable(resolveBin("ffmpeg-static", "FFMPEG_PATH", "ffmpeg"));
}
function ffprobePath() {
  return ensureExecutable(resolveBin("ffprobe-static", "FFPROBE_PATH", "ffprobe"));
}

function run(bin, args, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (onStdout) onStdout(d.toString());
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} خرج برمز ${code}: ${stderr.slice(-600)}`));
    });
  });
}

// ————— ffprobe: الدقة، معدل الإطارات، المدة، وجود صوت —————
async function probeFile(filePath) {
  const { stdout } = await run(ffprobePath(), [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ]);
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("الملف لا يحتوي مسار فيديو صالح");
  return {
    width: v.width || 0,
    height: v.height || 0,
    duration: Number(info.format?.duration || v.duration || 0),
    hasAudio: !!a,
    size: Number(info.format?.size || 0),
  };
}

// تنزيل مصدر رابط إلى /tmp مع عدّاد بايتات وحد حجم لكل مصدر
async function downloadUrlSource(url, filePath, onBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(150_000), redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) — رفض المصدر التحميل`);
  }
  const maxBytes = LIMITS.sourceMaxMB * 1024 * 1024;
  const out = fs.createWriteStream(filePath);
  let bytes = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) {
      out.destroy();
      throw new Error(`حجم المصدر يتجاوز الحد (${LIMITS.sourceMaxMB} ميجابايت)`);
    }
    if (onBytes) onBytes(bytes);
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once("drain", r));
  }
  await new Promise((r) => out.end(r));
  if (bytes === 0) throw new Error("المصدر فارغ (0 بايت)");
  return bytes;
}

function toEven(n) {
  return Math.max(2, Math.floor(n / 2) * 2);
}

// ————— بناء filter_complex: scale + pad إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080 أبعاد زوجية)
// fps=30، setsar=1، format=yuv420p، ثم concat=n=:v=1:a=1 — مصدر بلا صوت يُضاف له مسار صامت بنفس مدته
function buildFilterArgs(sources, probes) {
  const maxW = toEven(Math.min(LIMITS.maxOutputW, Math.max(...probes.map((p) => p.width || 0)) || LIMITS.maxOutputW));
  const maxH = toEven(Math.min(LIMITS.maxOutputH, Math.max(...probes.map((p) => p.height || 0)) || LIMITS.maxOutputH));

  const args = [];
  const chains = [];
  const concatPairs = [];
  let silentIdx = sources.length; // مدخلات anullsrc تُضاف بعد المصادر مباشرة

  sources.forEach((s, i) => {
    const p = probes[i];
    chains.push(
      `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,` +
        `pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${LIMITS.fps},format=yuv420p[v${i}]`,
    );
    if (p.hasAudio) {
      chains.push(`[${i}:a]aresample=${LIMITS.audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      // مصدر بلا صوت → مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج
      const dur = Math.max(0.5, p.duration || 5);
      args.push("-f", "lavfi", "-t", String(dur), "-i", `anullsrc=r=${LIMITS.audioRate}:cl=stereo`);
      chains.push(`[${silentIdx}:a]aresample=${LIMITS.audioRate},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      silentIdx += 1;
    }
    concatPairs.push(`[v${i}][a${i}]`);
  });

  args.push("-filter_complex", `${chains.join(";")};${concatPairs.join("")}concat=n=${sources.length}:v=1:a=1[vout][aout]`);
  return { args, maxW, maxH };
}

/**
 * خط المعالجة الكامل لمهمة دمج:
 * ير ما في tmpDir ثم يرمّز ويخزّن الناتج في Turso — يحدّث progress في القاعدة في كل مرحلة
 */
async function processJob(job) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merger-${job.id.slice(0, 8)}-`));
  try {
    await patchJob(job.id, { status: "processing", progress: 1, error: null });
    const sources = job.sources || [];
    if (sources.length < 2) throw new Error("الدمج يحتاج مقطعَين على الأقل");
    if (sources.length > LIMITS.maxSources) throw new Error(`أقصى عدد مقاطع هو ${LIMITS.maxSources}`);

    // ————— المرحلة 1: سحب المصادر (0-40%) —————
    const perSource = 40 / sources.length;
    const files = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const filePath = path.join(tmpDir, `src_${i}.bin`);
      if (s.kind === "url") {
        await downloadUrlSource(s.url, filePath, (bytes) => {
          const pct = Math.round(i * perSource + (bytes / Math.max(1, s.size || 1)) * perSource);
          void patchJob(job.id, { progress: Math.min(39, pct) }).catch(() => {});
        });
      } else {
        // مصدر مرفوع — يُجمَّع من صفوف source_chunks
        const { assembleSourceToFile } = require("./store");
        const size = await assembleSourceToFile(job.id, s.id, filePath);
        if (s.size && size > LIMITS.sourceMaxMB * 1024 * 1024) {
          throw new Error(`حجم المصدر يتجاوز الحد (${LIMITS.sourceMaxMB} ميجابايت)`);
        }
      }
      const p = await probeFile(filePath);
      if (p.duration > LIMITS.maxTotalDurationSec) {
        throw new Error(`مدة أحد المقاطع (${Math.round(p.duration)} ثانية) تتجاوز الحد الكلي`);
      }
      files.push({ filePath, probe: p });
      await patchJob(job.id, { progress: Math.min(40, Math.round((i + 1) * perSource)) });
    }

    // التحقق من المدة الإجمالية قبل الترميز
    const totalDuration = files.reduce((a, f) => a + f.probe.duration, 0);
    if (totalDuration > LIMITS.maxTotalDurationSec) {
      throw new Error(`مجموع مدد المقاطع (${Math.round(totalDuration)} ثانية) يتجاوز الحد (${LIMITS.maxTotalDurationSec} ثانية)`);
    }

    // ————— المرحلة 2: الترميز الموحد (40-90%) —————
    const { args: filterArgs, maxW, maxH } = buildFilterArgs(
      sources,
      files.map((f) => f.probe),
    );
    const outPath = path.join(tmpDir, "out.mp4");
    const ffArgs = [
      "-y", "-hide_banner", "-loglevel", "error",
      ...files.flatMap((f) => ["-i", f.filePath]),
      ...filterArgs,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", FFMPEG_PRESET, "-crf", String(LIMITS.crf),
      "-c:a", "aac", "-b:a", LIMITS.audioBitrate, "-ar", String(LIMITS.audioRate),
      "-movflags", "+faststart", "-pix_fmt", "yuv420p",
      "-progress", "pipe:1", "-nostats",
      outPath,
    ];

    let lastPct = 40;
    await run(ffmpegPath(), ffArgs, (chunk) => {
      const m = /out_time_us=(\d+)/g;
      let match;
      for (;;) {
        match = m.exec(chunk);
        if (!match) break;
        const sec = Number(match[1]) / 1_000_000;
        const pct = 40 + Math.min(50, (sec / Math.max(0.1, totalDuration)) * 50);
        const rounded = Math.floor(pct);
        if (rounded > lastPct) {
          lastPct = rounded;
          void patchJob(job.id, { progress: Math.min(90, rounded) }).catch(() => {});
        }
      }
    });

    // ————— التحقق من الحدود بعد الترميز —————
    const outSize = fs.statSync(outPath).size;
    if (outSize > LIMITS.outputMaxMB * 1024 * 1024) {
      throw new Error(`حجم الناتج (${(outSize / 1024 / 1024).toFixed(1)} ميجابايت) يتجاوز الحد (${LIMITS.outputMaxMB} ميجابايت)`);
    }
    const outProbe = await probeFile(outPath);

    // ————— المرحلة 3: تخزين الناتج في Turso (90-99%) —————
    await patchJob(job.id, { progress: 90 });
    const { writeOutputBlob } = require("./store");
    const { deleteSourceChunks } = require("./db");
    const buf = fs.readFileSync(outPath);
    await writeOutputBlob(job.id, buf);
    await deleteSourceChunks(job.id); // الناتج فقط هو المطلوب — أجزاء المصادر تُحذف

    const resolution = `${outProbe.width}x${outProbe.height}`;
    await patchJob(job.id, {
      status: "done",
      progress: 100,
      output_size: outSize,
      output_duration: outProbe.duration,
      output_resolution: resolution,
      error: null,
    });
    return { size: outSize, duration: outProbe.duration, resolution, width: outProbe.width, height: outProbe.height };
  } catch (e) {
    await patchJob(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) }).catch(() => {});
    throw e;
  } finally {
    // لا اعتماد على نظام ملفات دائم — نظّف /tmp دائمًا
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { ffmpegPath, ffprobePath, probeFile, downloadUrlSource, buildFilterArgs, processJob };
