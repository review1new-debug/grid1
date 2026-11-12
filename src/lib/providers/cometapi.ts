// مزود CometAPI — صور متزامنة عبر نقطة متوافقة مع OpenAI، وفيديو عبر نقطة مهام غير متزامنة
// التوثيق الرسمي: apidoc.cometapi.com (إنشاء الفيديو: POST /v1/videos — استعلام: GET /v1/videos/{task_id})
// حالات الفيديو: queued | in_progress | completed | failed (+ progress 0..100 + video_url)
import { ProviderError } from "../errors";
import type { CheckResult, KeyRow, ProviderAdapter } from "../types";

const BASE = (process.env.COMETAPI_BASE || "https://api.cometapi.com").replace(/\/+$/, "");

async function cometFetch(key: KeyRow, path: string, init?: RequestInit, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProviderError(0, `فشل الاتصال بـ CometAPI: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    // بعض المزودين يرسلون نفاد الرصيد بحالة 400 — التصنيف الموحد يفحص الرسالة قبل الحالة
    const msg = (body?.error as { message?: string })?.message || (body?.message as string) || `HTTP ${res.status}`;
    throw new ProviderError(res.status, String(msg));
  }
  return body || {};
}

export const cometapiAdapter: ProviderAdapter = {
  id: "cometapi",

  // CometAPI تعيد صورة النتيجة فورًا (متزامنة)
  async createImageSync(key, input) {
    const body = await cometFetch(key, `/v1/images/generations`, {
      method: "POST",
      body: JSON.stringify({
        model: input.__model,
        prompt: input.prompt,
        n: 1,
        response_format: "url",
      }),
    });
    const items = (body.data as Array<{ url?: string; b64_json?: string }>) || [];
    const url = items.find((i) => i.url)?.url;
    if (!url) {
      // لا ننزّل أي وسائط على سيرفرنا (قاعدة ذهبية 1) — b64 يُعدّ فشلًا مؤقتًا وننتقل للمفتاح/المزود التالي
      throw new ProviderError(500, "المزود أعاد الصورة مضمنة (b64_json) بدل رابط مباشر");
    }
    return { urls: [url] };
  },

  async createTask(key, model, input) {
    // الفيديو: مهام غير متزامنة بنمط create/check حسب توثيق CometAPI الحالي
    const body = await cometFetch(key, `/v1/videos`, {
      method: "POST",
      body: JSON.stringify({
        model,
        prompt: input.prompt,
        ...(input.image_url ? { image_url: input.image_url } : {}),
        ...(input.aspect_ratio && input.aspect_ratio !== "auto" ? { aspect_ratio: input.aspect_ratio } : {}),
        ...(input.resolution && input.resolution !== "auto" ? { resolution: input.resolution } : {}),
        ...(input.duration ? { duration: input.duration } : {}),
        ...(input.enable_audio !== undefined ? { audio: input.enable_audio } : {}),
      }),
    });
    const taskId = body.task_id || body.id || (body.data as { task_id?: string } | undefined)?.task_id;
    if (!taskId) throw new ProviderError(500, "استجابة غير متوقعة من CometAPI (task_id مفقود)");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const body = await cometFetch(key, `/v1/videos/${encodeURIComponent(providerTaskId)}`, undefined, 30_000);
    const status = String(body.status || "").toLowerCase();
    let urls: string[] = [];
    const v = (body.video_url as string) || (body.data as { video_url?: string } | undefined)?.video_url;
    if (v && /^https?:\/\//i.test(v)) urls = [v];

    if (status === "completed") return { status: "completed", urls };
    if (status === "failed") return { status: "failed", error: String(body.error || "فشل التوليد لدى CometAPI") };
    const progress = Number(body.progress);
    return { status: "processing", progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : undefined };
  },
};
