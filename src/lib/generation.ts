// منسّق التوليد — runGeneration + refreshTask (الأقسام 4.3 و 6 من المواصفة)
// السلوك الجوهري: تبديل تسلسلي صارم «لا توقف أبدًا» — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح/الرصيد أبدًا
import { ensureSchema, insertTask, getTask, updateTask, type TaskPatch } from "./turso";
import { getKeyPool, getKeyById, setKeyStatus, bumpKeyCounters, maskKey } from "./keys";
import { resolveModel, getModels, type ModelDef } from "./models";
import { getAdapter } from "./providers";
import { classifyProviderError, ProviderError, KEY_FAIL_PATTERN, sanitizePublicError } from "./errors";
import {
  INTERNAL_WAIT_MSG,
  fmtNoKeys,
  fmtParamsError,
  fmtProcessing,
  fmtFailed,
  fmtImageDone,
  fmtTaskDone,
  fmtTaskNotFound,
  fmtListMedia,
} from "./format";
import type {
  Attempt,
  CheckResult,
  KeyRow,
  MediaType,
  ProgressNotifier,
  ProviderId,
  TaskRow,
  ToolResponse,
} from "./types";

export const noopNotify: ProgressNotifier = async () => {};

// تهدئة ~45 ثانية قبل إعادة محاولة الإنشاء مع كل استدعاء get_task (حتى لا نضغط المزودين)
export const CREATE_RETRY_COOLDOWN_MS = 45_000;
export const POLL_INTERVAL_MS = 3_000; // استعلام كل 3 ثوانٍ داخل نافذة الانتظار

const DEFAULT_WAIT: Record<string, number> = { image: 90, video: 25, merge: 60 };

export function clampWait(v: unknown, type: MediaType): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : DEFAULT_WAIT[type] ?? 60;
  return Math.max(0, Math.min(240, n));
}

export function asProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  return new ProviderError(0, e instanceof Error ? e.message : String(e));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** بناء input المزود حسب النوع — حقول مدققة فقط (لا نرسل «auto») */
export function buildInput(args: Record<string, unknown>, type: "image" | "video"): Record<string, unknown> {
  if (type === "image") {
    const input: Record<string, unknown> = { prompt: args.prompt };
    if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
    if (args.resolution) input.resolution = args.resolution;
    if (args.output_format) input.output_format = args.output_format;
    if (args.background && args.background !== "auto") input.background = args.background; // يُطبق فقط عند 1K
    return input;
  }
  const input: Record<string, unknown> = { prompt: args.prompt, enable_audio: args.enable_audio ?? true };
  if (args.image_url) input.image_url = args.image_url;
  if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
  if (args.resolution && args.resolution !== "auto") input.resolution = args.resolution;
  if (args.duration) input.duration = args.duration;
  return input;
}

interface Candidate {
  key: KeyRow;
  provider: ProviderId;
  model: string;
  adapter: ReturnType<typeof getAdapter>;
}

async function buildCandidates(modelDef: ModelDef): Promise<Candidate[]> {
  // الترتيب التسلسلي الصارم حسب ترتيب الإضافة
  const pool = await getKeyPool(modelDef.providers);
  return pool.map((k) => ({
    key: k,
    provider: k.provider,
    model: modelDef.providerModel[k.provider] || modelDef.canonical,
    adapter: getAdapter(k.provider),
  }));
}

/** تسجيل محاولة: في attempts_json + تحديث عدّادات المفتاح دائمًا */
async function recordAttempt(taskId: string, c: Candidate, ok: boolean, errorClass?: string, error?: string): Promise<void> {
  const attempt: Attempt = {
    provider: c.provider,
    keyId: c.key.id,
    keyLabel: c.key.label || maskKey(c.key.api_key),
    ok,
    ...(errorClass ? { errorClass } : {}),
    ...(error ? { error } : {}),
    at: new Date().toISOString(),
  };
  await bumpKeyCounters(c.key.id, { ok, error: ok ? null : (error ?? null) });
  await updateTask(taskId, { appendAttempt: attempt });
}

export interface CreateOutcome {
  ok: boolean;
  kind: "sync" | "async" | "none";
  urls?: string[];
  provider?: ProviderId;
  keyId?: string;
  providerTaskId?: string;
  paramsError?: string;
  lastAttemptAt: number;
}

/**
 * تجربة المرشحين بالترتيب حتى أول نجاح — كل محاولة (نجاح/فشل + الفئة) تُسجَّل.
 * params → توقف فورًا. disabled/exhausted → تعليم المفتاح والانتقال للتالي. provider/temporary → الانتقال للتالي.
 */
export async function tryCreateAcrossPool(
  modelDef: ModelDef,
  args: Record<string, unknown>,
  type: "image" | "video",
  taskId: string,
  startIndex = 0,
): Promise<CreateOutcome> {
  const candidates = await buildCandidates(modelDef);
  let paramsError: string | undefined;
  const lastAttemptAt = Date.now();

  for (let i = Math.max(0, startIndex); i < candidates.length; i++) {
    const c = candidates[i];
    try {
      if (type === "image" && typeof c.adapter.createImageSync === "function") {
        const input = buildInput(args, type);
        input.__model = c.model; // للصور المتزامنة يحتاجه المزود
        const { urls } = await c.adapter.createImageSync!(c.key, input);
        await recordAttempt(taskId, c, true);
        return { ok: true, kind: "sync", urls, provider: c.provider, keyId: c.key.id, lastAttemptAt };
      }
      const { providerTaskId } = await c.adapter.createTask(c.key, c.model, buildInput(args, type));
      await recordAttempt(taskId, c, true);
      return { ok: true, kind: "async", providerTaskId, provider: c.provider, keyId: c.key.id, lastAttemptAt };
    } catch (e) {
      const pe = asProviderError(e);
      const cls = classifyProviderError(pe.status, pe.message);
      await recordAttempt(taskId, c, false, cls, pe.message);
      if (cls === "disabled") {
        // مفتاح مرفوض → تعطيله تلقائيًا → انتقل للتالي
        await setKeyStatus(c.key.id, "disabled", pe.message);
      } else if (cls === "exhausted") {
        // مستنزف → يبقى في القاعدة → انتقل للتالي
        await setKeyStatus(c.key.id, "exhausted", pe.message);
      } else if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
        paramsError = pe.message;
        break;
      }
      // provider | temporary → انتقل للمفتاح التالي
    }
  }
  return { ok: false, kind: "none", paramsError, lastAttemptAt };
}

export interface CheckOutcome {
  state: "completed" | "failed" | "processing";
  urls?: string[];
  progress?: number;
}

/**
 * فحص واحد لمهمة جارية لدى المزود مع منطق التبديل:
 * فشل حقيقي → failed. فشل مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي.
 */
export async function checkAndUpdateTask(task: TaskRow): Promise<CheckOutcome> {
  const modelDef = resolveModel(task.model, task.type === "merge" ? "video" : (task.type as "image" | "video"));
  if (!modelDef) return { state: "failed" };

  const keyRow = task.key_id ? await getKeyById(task.key_id) : null;
  if (!task.provider_task_id || !task.provider || !keyRow || keyRow.status === "disabled") {
    // لا يوجد مفتاح/مهمة لدى المزود — أعد الإنشاء على المفاتيح المتاحة
    return recreateTask(task, modelDef);
  }

  const adapter = getAdapter(task.provider);
  try {
    const res: CheckResult = await adapter.checkTask(keyRow, task.provider_task_id);
    if (res.status === "completed" && res.urls?.length) {
      await updateTask(task.id, { status: "completed", progress: 100, result_urls: res.urls });
      return { state: "completed", urls: res.urls };
    }
    if (res.status === "failed") {
      const msg = res.error || "فشل التوليد لدى المزود";
      if (KEY_FAIL_PATTERN.test(msg)) {
        // فشل مفتاح/رصيد في منتصف المهمة → نفس المهمة بنفس task_id على المفتاح التالي
        return recreateTask(task, modelDef);
      }
      // فشل حقيقي (انتهاك سياسة/معطيات)
      await updateTask(task.id, { status: "failed", error_message: msg });
      return { state: "failed" };
    }
    await updateTask(task.id, { status: "processing", progress: res.progress ?? task.progress });
    return { state: "processing", progress: res.progress };
  } catch (e) {
    const pe = asProviderError(e);
    const cls = classifyProviderError(pe.status, pe.message);
    await recordAttempt(task.id, { key: keyRow, provider: task.provider as ProviderId, model: task.model, adapter }, false, cls, pe.message);
    if (cls === "disabled") await setKeyStatus(keyRow.id, "disabled", pe.message);
    else if (cls === "exhausted") await setKeyStatus(keyRow.id, "exhausted", pe.message);
    if (cls === "disabled" || cls === "exhausted" || cls === "provider") {
      return recreateTask(task, modelDef);
    }
    // خطأ مؤقت (شبكة/429) — المفتاح يبقى سليمًا ونستمر
    await updateTask(task.id, { status: "processing" });
    return { state: "processing", progress: task.progress };
  }
}

/** إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي (تبديل صامت تمامًا) */
async function recreateTask(task: TaskRow, modelDef: ModelDef): Promise<CheckOutcome> {
  const args = (task.params || {}) as Record<string, unknown>;
  const type = task.type as "image" | "video";
  // ابدأ من المفتاح التالي للمفتاح الذي فشل
  const pool = await getKeyPool(modelDef.providers);
  const failedIdx = pool.findIndex((k) => k.id === task.key_id);
  const startIndex = failedIdx < 0 ? 0 : failedIdx + 1;

  const outcome = await tryCreateAcrossPool(modelDef, args, type, task.id, startIndex);
  if (outcome.ok && outcome.kind === "async") {
    await updateTask(task.id, {
      provider: outcome.provider,
      provider_task_id: outcome.providerTaskId,
      key_id: outcome.keyId,
      status: "processing",
      progress: 5,
      error_message: null,
    });
    return { state: "processing", progress: 5 };
  }
  if (outcome.ok && outcome.kind === "sync" && outcome.urls?.length) {
    await updateTask(task.id, { status: "completed", progress: 100, result_urls: outcome.urls });
    return { state: "completed", urls: outcome.urls };
  }
  if (outcome.paramsError) {
    await updateTask(task.id, { status: "failed", error_message: `خطأ في المعطيات: ${outcome.paramsError}` });
    return { state: "failed" };
  }
  // فشل على كل المفاتيح → تبقى processing «بانتظار توفر مفتاح صالح…»
  await updateTask(task.id, {
    status: "processing",
    error_message: INTERNAL_WAIT_MSG,
    params: { lastCreateAttemptAt: outcome.lastAttemptAt },
  });
  return { state: "processing" };
}

/**
 * التدفق الكامل لأداة generate_image / generate_video (قسم 6):
 * 1) توحيد الموديل  2) فحص المفاتيح  3) تسجيل المهمة قبل أي نداء خارجي
 * 4) إنشاء بالترتيب  5) نافذة انتظار مع بث تقدم  6) اكتمال/فشل/processing
 */
export async function runGeneration(
  args: Record<string, unknown>,
  type: "image" | "video",
  notify: ProgressNotifier,
): Promise<ToolResponse> {
  await ensureSchema();

  // 1) توحيد اسم الموديل عبر الأسماء البديلة
  const modelDef = resolveModel(typeof args.model === "string" ? args.model : undefined, type);
  if (!modelDef) {
    const available = getModels()
      .filter((m) => m.type === type)
      .map((m) => m.canonical);
    return { text: fmtParamsError(`الموديل «${String(args.model)}» غير معروف. المتاح: ${available.join(", ")}`), isError: true };
  }

  // 2) مجموعة المفاتيح بالترتيب — فارغة → رد no_keys
  const pool = await getKeyPool(modelDef.providers);
  if (!pool.length) return { text: fmtNoKeys(modelDef.canonical) };

  // 3) تسجيل المهمة في Turso قبل أي نداء خارجي (تبقى قابلة للتتبع حتى مع انقطاع الاتصال)
  const taskId = crypto.randomUUID();
  await insertTask({
    id: taskId,
    model: modelDef.canonical,
    type,
    prompt: String(args.prompt ?? ""),
    params_json: JSON.stringify(args),
    status: "pending",
    progress: 0,
  });

  // 4) تجربة المرشحين بالترتيب حتى نجاح الإنشاء
  const outcome = await tryCreateAcrossPool(modelDef, args, type, taskId, 0);
  if (!outcome.ok) {
    if (outcome.paramsError) {
      await updateTask(taskId, { status: "failed", error_message: `خطأ في المعطيات: ${outcome.paramsError}` });
      return { text: fmtFailed(outcome.paramsError), isError: true };
    }
    // فشل على كل المفاتيح → processing (وليست failed) وتُعاد مع كل get_task بعد تهدئة
    await updateTask(taskId, {
      status: "processing",
      error_message: INTERNAL_WAIT_MSG,
      params: { lastCreateAttemptAt: outcome.lastAttemptAt },
    });
    return { text: fmtProcessing(taskId) };
  }

  // صور متزامنة (CometAPI تعيد الرابط فورًا)
  if (outcome.kind === "sync" && outcome.urls?.length) {
    await updateTask(taskId, { status: "completed", progress: 100, result_urls: outcome.urls, provider: outcome.provider, key_id: outcome.keyId });
    return { text: fmtImageDone(outcome.urls, taskId) };
  }

  await updateTask(taskId, {
    provider: outcome.provider,
    provider_task_id: outcome.providerTaskId,
    key_id: outcome.keyId,
    status: "processing",
    progress: 5,
  });

  // 5) نافذة الانتظار: استعلام كل 3 ثوانٍ + بث progress notifications (~كل 3 ثوانٍ)
  const waitSec = clampWait(args.wait_seconds, type);
  const deadline = Date.now() + waitSec * 1000;
  let lastProgress = 5;

  while (Date.now() < deadline) {
    const task = (await getTask(taskId))!;
    if (task.status === "completed") {
      return { text: fmtTaskDone(task) };
    }
    if (task.status === "failed") {
      return { text: fmtFailed(task.error_message), isError: true };
    }
    const r = await checkAndUpdateTask(task);
    const fresh = (await getTask(taskId))!;
    if (r.state === "completed") return { text: fmtTaskDone(fresh) };
    if (r.state === "failed") return { text: fmtFailed(fresh.error_message), isError: true };

    lastProgress = Math.max(lastProgress, Math.min(95, Math.round(fresh.progress || 0)));
    await notify(lastProgress, 100, `قيد التوليد… ${lastProgress}%`);
    await sleep(POLL_INTERVAL_MS);
  }

  // 7) انتهت النافذة والنتيجة لم تظهر → processing والعميل يتابع بـ get_task
  const final = (await getTask(taskId))!;
  return { text: fmtProcessing(taskId, Math.max(lastProgress, final.progress)) };
}

/** get_task — قراءة + تحديث حي من المزود/الخدمة إن كانت جارية، ثم صياغة عربية جاهزة للعرض */
export async function refreshTask(taskId: string): Promise<ToolResponse> {
  await ensureSchema();
  const t = await getTask(taskId);
  if (!t) return { text: fmtTaskNotFound(taskId), isError: true };

  if (t.status === "completed") return { text: fmtTaskDone(t) };
  if (t.status === "failed") return { text: fmtFailed(t.error_message), isError: true };
  if (t.type === "merge") {
    // مهمة دمج — المنطق في merger.ts (تجنب الاستيراد الدائري عبر استدعاء ديناميكي)
    const { refreshMergeTask } = await import("./merger");
    return refreshMergeTask(t);
  }

  const modelDef = resolveModel(t.model, t.type as "image" | "video");
  if (!modelDef) return { text: fmtFailed(`موديل غير معروف في المهمة: ${t.model}`), isError: true };

  if (!t.provider_task_id || !t.provider) {
    // لم ينجح الإنشاء بعد — أعد المحاولة تلقائيًا بعد تهدئة ~45 ثانية
    const last = Number(t.params?.lastCreateAttemptAt || 0);
    if (Date.now() - last >= CREATE_RETRY_COOLDOWN_MS) {
      const pool = await getKeyPool(modelDef.providers);
      if (pool.length) {
        const outcome = await tryCreateAcrossPool(modelDef, (t.params || {}) as Record<string, unknown>, t.type as "image" | "video", t.id, 0);
        if (!outcome.ok) {
          await updateTask(t.id, { params: { lastCreateAttemptAt: outcome.lastAttemptAt } });
          if (outcome.paramsError) {
            await updateTask(t.id, { status: "failed", error_message: `خطأ في المعطيات: ${outcome.paramsError}` });
          }
        } else if (outcome.kind === "sync" && outcome.urls?.length) {
          await updateTask(t.id, { status: "completed", progress: 100, result_urls: outcome.urls, provider: outcome.provider, key_id: outcome.keyId });
        } else {
          await updateTask(t.id, {
            provider: outcome.provider,
            provider_task_id: outcome.providerTaskId,
            key_id: outcome.keyId,
            status: "processing",
            progress: 5,
            error_message: null,
          });
        }
      }
    }
    const t2 = (await getTask(t.id))!;
    if (t2.status === "completed") return { text: fmtTaskDone(t2) };
    if (t2.status === "failed") return { text: fmtFailed(t2.error_message), isError: true };
    return { text: fmtProcessing(t2.id, t2.progress) };
  }

  const r = await checkAndUpdateTask(t);
  const t2 = (await getTask(t.id))!;
  if (r.state === "completed") return { text: fmtTaskDone(t2) };
  if (r.state === "failed") return { text: fmtFailed(t2.error_message), isError: true };
  return { text: fmtProcessing(t2.id, Math.max(t2.progress, r.progress ?? 0)) };
}

/** list_media — أحدث الوسائط المخزنة بروابطها من قاعدة البيانات (بدون إعادة توليد) */
export async function listMedia(args: { type?: string; status?: string; limit?: number }): Promise<ToolResponse> {
  await ensureSchema();
  const { listRecentTasks } = await import("./turso");
  const limit = Math.max(1, Math.min(50, Math.floor(Number(args.limit) || 10)));
  const tasks = await listRecentTasks(limit, { type: args.type, status: args.status });
  return { text: fmtListMedia(tasks) };
}
