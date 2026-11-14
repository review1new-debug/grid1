// خدمة دمج الفيديو — Video Merger API v2 (قسم 7 من المواصفة)
// بلا مفاتيح أو توثيق. MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — لا توجد معاملات resolution/fps.
// القيود: 10 مقاطع كحد أقصى، 200MB لكل مصدر، 150MB للناتج، 600 ثانية مجموع المدد.
// كل الملفات تُحذف تلقائيًا بعد 24 ساعة — مذكورة في وصف الأداة و SERVER_INSTRUCTIONS.
import { ensureSchema, insertTask, getTask, updateTask } from "./turso";
import { ProviderError, sanitizePublicError } from "./errors";
import { fmtMergeNeedsTwo, fmtMergeDone, fmtProcessing, fmtFailed, fmtMergerNotConfigured, INTERNAL_WAIT_MSG } from "./format";
import { clampWait, noopNotify, type ResumeResult } from "./generation";
import type { ProgressNotifier, TaskRow, ToolResponse } from "./types";

const RAW_BASE = (process.env.MERGER_API_BASE || "").trim();
// تجاهل القيمة الافتراضية التوضيحية «https://xxxxxxxx»
export const MERGER_BASE = RAW_BASE && !/xxxx/.test(RAW_BASE) ? RAW_BASE.replace(/\/+$/, "") : "";

export function mergerConfigured(): boolean {
  return MERGER_BASE.length > 0;
}

/** خطأ HTTP معلن من خدمة الدمج = فشل نهائي فوري (قاعدة 6) — أخطاء شبكتنا مؤقتة */
export class MergerHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "MergerHttpError";
  }
}

async function mergerFetch(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // timeout/fetch من جهتنا → مؤقت
    throw new ProviderError(0, `فشل الاتصال بخدمة الدمج: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new MergerHttpError(res.status, String(body?.error || `HTTP ${res.status}`));
  }
  return body || {};
}

/** فحص جهوزية الخدمة: GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerConfigured()) return false;
  try {
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function mergerCreateJob(videos: string[]): Promise<{ jobId: string; statusUrl?: string; processUrl?: string; expiresAt?: string }> {
  const b = await mergerFetch(`/api/jobs`, { method: "POST", body: JSON.stringify({ videos }) });
  if (!b?.jobId) throw new MergerHttpError(500, "استجابة غير متوقعة من خدمة الدمج (jobId مفقود)");
  return b as { jobId: string };
}

/** يستغرق ~10–15 ثانية (blocking) — نجاح 200 → done + videoUrl — المهلة قابلة للضبط (resume يستخدم 45 ثانية) */
async function mergerProcess(jobId: string, timeoutMs = 240_000): Promise<{ status: string; videoUrl?: string; downloadUrl?: string; size?: number; duration?: number; resolution?: string; expiresAt?: string }> {
  return (await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, timeoutMs)) as never;
}

export interface MergerJobState {
  status: "queued" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

/** قراءة حالة المهمة — تحليل دفاعي (قسم 7.2) */
export async function mergerGetJob(jobId: string): Promise<MergerJobState> {
  let res: Response;
  try {
    res = await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new ProviderError(0, `فشل الاتصال بخدمة الدمج: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 404) {
    // مهمة غير موجودة → فشل نهائي: حُذفت أو انتهت صلاحيتها بعد 24 ساعة
    throw new MergerHttpError(404, "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
  }
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) throw new MergerHttpError(res.status, String(body?.error || `HTTP ${res.status}`));

  const s = String(body?.status ?? "").toLowerCase();
  let status: MergerJobState["status"];
  if (body?.error && !body?.status) {
    // قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
    status = "failed";
  } else if (/done|completed|complete|success|succeeded|finished/.test(s)) {
    status = "done";
  } else if (/error|failed|failure|cancelled|canceled/.test(s)) {
    status = "failed";
  } else {
    status = "queued";
  }

  let progress = Number(body?.progress ?? 0);
  if (!Number.isFinite(progress) || progress < 0) progress = 0;
  if (progress > 0 && progress <= 1) progress = progress * 100; // يأتي أحيانًا كسرًا 0..1

  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبطه من jobId
  const videoUrl = (body?.videoUrl as string) || (body?.video_url as string) || "";
  const downloadUrl = (body?.downloadUrl as string) || (body?.download_url as string) || "";
  return {
    status,
    progress,
    videoUrl: videoUrl || (!downloadUrl && jobId ? `${MERGER_BASE}/api/jobs/${jobId}/video` : ""),
    downloadUrl,
    error: (body?.error as string) || undefined,
  };
}

/** روابط عامة مباشرة فقط — لا نطاقات داخلية */
function isPublicHttpUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

// قفل في الذاكرة حتى لا يتزامن process مع get_task (يُنفَّذ مرة واحدة فقط)
const processInFlight = new Set<string>();

/** إطلاق POST /process خلفيًا وبمرة واحدة فقط — بقفل ذاكرة + علم دائم في القاعدة */
export async function fireProcess(taskId: string, jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  const t = await getTask(taskId);
  if (!t) return;
  const params = (t.params || {}) as Record<string, unknown>;
  if (params.processDone) return;
  // علم processStarted موجود ولم يمر بعد 90 ثانية من إطلاقه → العملية طبيعية قيد التنفيذ
  if (params.processStarted && Date.now() - Number(params.processStartedAt || 0) < 90_000) return;

  processInFlight.add(jobId);
  await updateTask(taskId, { params: { ...params, processStarted: true, processStartedAt: Date.now() } });
  void (async () => {
    try {
      const r = await mergerProcess(jobId);
      if (r.status === "done" && r.videoUrl) {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: [r.videoUrl] });
      }
      await updateTask(taskId, { params: { processDone: true } });
    } catch (e) {
      if (e instanceof MergerHttpError) {
        // خطأ معلن من الخدمة → فشل نهائي فوري — لا إعادة محاولة
        await updateTask(taskId, { status: "failed", error_message: e.message });
      }
      // أخطاء شبكتنا مؤقتة — يتابع get_task بالاستعلام
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

/**
 * تدفق merge_videos (قسم 7.3): تحقق صارم → تسجيل أولًا → إنشاء → process خلفيًا مرة واحدة
 * → نافذة انتظار مع بث تقدم (استعلام كل 3 ثوانٍ وتحديث فوري في Turso)
 */
export async function runMerge(
  args: { urls?: string[]; task_ids?: string[]; wait_seconds?: number },
  notify: ProgressNotifier = noopNotify,
): Promise<ToolResponse> {
  await ensureSchema();
  if (!mergerConfigured()) return { text: fmtMergerNotConfigured(), isError: true };

  // 1) حلّ task_ids أولًا (لمهام فيديو مكتملة) ثم الروابط المباشرة بنفس ترتيبها
  const resolved: string[] = [];
  const failedIds: { id: string; reason: string }[] = [];
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(String(tid));
    if (t && t.status === "completed" && t.result_urls && t.result_urls.length) {
      resolved.push(t.result_urls[0]);
    } else {
      failedIds.push({
        id: String(tid),
        reason: !t ? "غير موجودة في قاعدة البيانات" : t.status === "completed" ? "مكتملة بلا روابط" : `حالتها ليست مكتملة (${t.status})`,
      });
    }
  }
  const directUrls = (args.urls ?? []).map((u) => String(u).trim()).filter(Boolean);
  const urls = [...resolved, ...directUrls];

  // 2) تحقق صارم
  if (urls.length < 2) return { text: fmtMergeNeedsTwo(failedIds), isError: true };
  if (urls.length > 10) {
    return { text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", isError: true };
  }
  const bad = urls.filter((u) => !isPublicHttpUrl(u));
  if (bad.length) {
    return {
      text: `❌ روابط غير صالحة — يجب أن تكون http/https مباشرة وعامة:\n${bad.map((u) => `- ${u}`).join("\n")}`,
      isError: true,
    };
  }

  // 3) تسجيل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${urls.length} مقاطع`,
    params_json: JSON.stringify({ ...args, resolvedUrls: urls }),
    status: "pending",
    progress: 0,
  });

  // 4) إنشاء المهمة لدى الخدمة
  let jobId = "";
  try {
    const job = await mergerCreateJob(urls);
    jobId = job.jobId;
    await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 3 });
  } catch (e) {
    if (e instanceof MergerHttpError) {
      // أي خطأ HTTP معلن = فشل نهائي فوري
      await updateTask(taskId, { status: "failed", error_message: e.message });
      return { text: fmtFailed(sanitizePublicError(e.message)), isError: true };
    }
    // خطأ شبكتنا — مؤقت: المهمة تبقى جارية وتُعاد مع get_task
    await updateTask(taskId, { status: "processing", error_message: INTERNAL_WAIT_MSG });
    return { text: fmtProcessing(taskId) };
  }

  // 5) إطلاق process خلفيًا وبمرة واحدة فقط (قفل processInFlight)
  await fireProcess(taskId, jobId);

  // 6) نافذة الانتظار (افتراضي 60 ثانية): GET /api/jobs/{id} كل 3 ثوانٍ مع بث تقدم
  const waitSec = clampWait(args.wait_seconds, "merge");
  const deadline = Date.now() + waitSec * 1000;
  let lastProgress = 3;

  while (Date.now() < deadline) {
    try {
      const st = await mergerGetJob(jobId);
      if (st.status === "done") {
        const url = st.videoUrl || st.downloadUrl || `${MERGER_BASE}/api/jobs/${jobId}/video`;
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: [url] });
        return { text: fmtMergeDone([url]) };
      }
      if (st.status === "failed") {
        // خطأ معلن = فشل نهائي فوري (مثل مصدر يرفض التحميل — التكرار يعطي النتيجة نفسها)
        await updateTask(taskId, { status: "failed", error_message: st.error || "فشلت خدمة الدمج" });
        return { text: fmtFailed(sanitizePublicError(st.error)), isError: true };
      }
      const p = Math.max(lastProgress, Math.min(95, Math.round(st.progress)));
      if (p !== lastProgress) await updateTask(taskId, { status: "processing", progress: p });
      lastProgress = p;
      await notify(lastProgress, 100, `قيد الدمج… ${lastProgress}%`);
    } catch (e) {
      if (e instanceof MergerHttpError) {
        await updateTask(taskId, { status: "failed", error_message: e.message });
        return { text: fmtFailed(sanitizePublicError(e.message)), isError: true };
      }
      // خطأ شبكتنا نحن (timeout/fetch) = مؤقت → استمر بالاستعلام حتى انتهاء النافذة
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  return { text: fmtProcessing(taskId, lastProgress) };
}

/**
 * زر «استكمال» لمهمة دمج فاشلة أو لم تُنشأ لدى الخدمة بعد:
 * ينشئ مهمة جديدة لدى خدمة الدمج من الروابط المحفوظة (المهمة القديمة ميتة ولا تُعاد)
 * وينتظر النتيجة حتى 45 ثانية — إن انقضت يبقى الدمج مستمرًا لدى الخدمة وتُجلب النتيجة تلقائيًا لاحقًا.
 * تُستدعى من POST /api/tasks/{id}/resume (زر «استكمال» في اللوحة).
 */
export async function resumeMergeTask(t: TaskRow): Promise<ResumeResult> {
  await ensureSchema();
  if (!mergerConfigured()) {
    return { task: t, message: "خدمة الدمج غير مهيأة — اضبط MERGER_API_BASE أولًا" };
  }

  const urls = ((t.params?.resolvedUrls as string[]) || []).filter((u) => isPublicHttpUrl(u));
  if (urls.length < 2) {
    const msg = "روابط المصادر المحفوظة غير مكتملة — لا يمكن استكمال هذا الدمج";
    const cur = await updateTask(t.id, { status: "failed", error_message: msg });
    return { task: cur!, message: msg };
  }

  let jobId = "";
  try {
    const job = await mergerCreateJob(urls);
    jobId = job.jobId;
  } catch (e) {
    if (e instanceof MergerHttpError) {
      const cur = await updateTask(t.id, { status: "failed", error_message: e.message });
      return { task: cur!, message: sanitizePublicError(e.message) };
    }
    // خطأ شبكتنا — نبقيها جارية وتُعاد المحاولة تلقائيًا مع أي استعلام لاحق
    const cur = await updateTask(t.id, { status: "processing", error_message: INTERNAL_WAIT_MSG });
    return { task: cur!, message: "تعذّر الاتصال بخدمة الدمج — ستُعاد المحاولة تلقائيًا" };
  }

  // صفّر أعلام process حتى يُسمح بتنفيذه من جديد (تنفيذ المهمة القديمة لم يكتمل أصلًا)
  await updateTask(t.id, {
    provider_task_id: jobId,
    status: "processing",
    progress: 3,
    error_message: null,
    params: { processDone: false, processStarted: false, processStartedAt: 0 },
  });

  // تنفيذ متزامن بحد 45 ثانية (الدمج العادي 10–15 ثانية) وضمن حد 60 ثانية لوظائف Vercel
  try {
    const r = await mergerProcess(jobId, 45_000);
    if (r.status === "done" && r.videoUrl) {
      const cur = await updateTask(t.id, { status: "completed", progress: 100, result_urls: [r.videoUrl] });
      return { task: cur!, message: "اكتمل الدمج بنجاح — النتيجة جاهزة" };
    }
  } catch (e) {
    if (e instanceof MergerHttpError) {
      const cur = await updateTask(t.id, { status: "failed", error_message: e.message });
      return { task: cur!, message: sanitizePublicError(e.message) };
    }
    // خطأ شبكتنا — الخدمة تكمل الدمج وتُجلب النتيجة مع التحديث التالي (fireProcess/get_task)
  }

  const cur = (await getTask(t.id))!;
  if (cur.status === "completed") return { task: cur, message: "اكتمل الدمج بنجاح — النتيجة جاهزة" };
  return { task: cur, message: "الدمج مستمر الآن — ستُحدَّث الحالة في اللوحة تلقائيًا" };
}

/** get_task لمهمة دمج — تحديث حي من الخدمة مع نفس قواعد الفشل الحتمي */
export async function refreshMergeTask(t: TaskRow): Promise<ToolResponse> {
  await ensureSchema();
  if (!mergerConfigured()) return { text: fmtMergerNotConfigured(), isError: true };

  if (!t.provider_task_id) {
    // لم تُنشأ لدى الخدمة (فشل شبكة سابق) — أعد المحاولة من الروابط المحفوظة
    const urls = ((t.params?.resolvedUrls as string[]) || []).filter((u) => isPublicHttpUrl(u));
    if (urls.length < 2) {
      await updateTask(t.id, { status: "failed", error_message: "روابط المصادر مفقودة أو غير صالحة" });
      return { text: fmtFailed("روابط المصادر مفقودة أو غير صالحة"), isError: true };
    }
    try {
      const job = await mergerCreateJob(urls);
      await updateTask(t.id, { provider_task_id: job.jobId, status: "processing", progress: 3 });
      await fireProcess(t.id, job.jobId);
    } catch (e) {
      if (e instanceof MergerHttpError) {
        await updateTask(t.id, { status: "failed", error_message: e.message });
        return { text: fmtFailed(sanitizePublicError(e.message)), isError: true };
      }
    }
  } else {
    // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (القفل يحمي من التزامن)
    await fireProcess(t.id, t.provider_task_id);
    try {
      const st = await mergerGetJob(t.provider_task_id);
      if (st.status === "done") {
        const url = st.videoUrl || st.downloadUrl || `${MERGER_BASE}/api/jobs/${t.provider_task_id}/video`;
        await updateTask(t.id, { status: "completed", progress: 100, result_urls: [url] });
      } else if (st.status === "failed") {
        await updateTask(t.id, { status: "failed", error_message: st.error || "فشلت خدمة الدمج" });
      } else {
        const p = Math.max(t.progress, Math.min(95, Math.round(st.progress)));
        await updateTask(t.id, { status: "processing", progress: p });
      }
    } catch (e) {
      if (e instanceof MergerHttpError) {
        // 404 → فشل نهائي: «مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)»
        await updateTask(t.id, { status: "failed", error_message: e.message });
      }
      // أخطاء شبكتنا مؤقتة — أعد الاستعلام في get_task القادم
    }
  }

  const t2 = (await getTask(t.id))!;
  if (t2.status === "completed" && t2.result_urls?.length) return { text: fmtMergeDone(t2.result_urls) };
  if (t2.status === "failed") return { text: fmtFailed(t2.error_message), isError: true };
  return { text: fmtProcessing(t2.id, t2.progress) };
}
