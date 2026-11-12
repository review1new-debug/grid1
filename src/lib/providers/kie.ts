// مزود kie.ai — Jobs API الموحد (الأشكال المقاسة فعليًا بالاختبار الحقيقي)
// ملاحظة مقاسة: kie يرجع HTTP 200 حتى عند الأخطاء — حالة الخطأ في حقل code داخل الجسم!
import { ProviderError } from "../errors";
import type { CheckResult, KeyRow, ProviderAdapter } from "../types";

const KIE_BASE = "https://api.kie.ai/api/v1/jobs";

async function callKie(key: KeyRow, path: string, init?: RequestInit, timeoutMs = 45_000): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${KIE_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // انقطاع شبكة/timeout → خطأ مؤقت (status = 0)
    throw new ProviderError(0, `فشل الاتصال بـ kie.ai: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // الحالة الحقيقية من الجسم (code الداخلي) — وليس HTTP status
  const code = typeof body?.code === "number" ? body.code : res.status;
  if (code !== 200) {
    const msg = (body?.msg as string) || (body?.data as string) || `HTTP ${res.status}`;
    throw new ProviderError(code, String(msg));
  }
  return (body?.data as Record<string, unknown>) || {};
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createTask(key, model, input) {
    const data = await callKie(key, `/createTask`, {
      method: "POST",
      body: JSON.stringify({ model, input }),
    });
    const taskId = data.taskId;
    if (!taskId) throw new ProviderError(500, "استجابة غير متوقعة من kie.ai (taskId مفقود)");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key, providerTaskId): Promise<CheckResult> {
    const data = await callKie(key, `/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`);
    const state = String(data.state || "").toLowerCase();

    // resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا — والاحتياط حقل response الجديد
    let urls: string[] = [];
    try {
      if (typeof data.resultJson === "string" && data.resultJson.trim()) {
        const inner = JSON.parse(data.resultJson) as { resultUrls?: string[] };
        urls = inner.resultUrls || [];
      } else if (data.resultJson && typeof data.resultJson === "object") {
        urls = ((data.resultJson as { resultUrls?: string[] }).resultUrls) || [];
      }
    } catch {
      /* تجاهل — نعتمد الاحتياط أدناه */
    }
    if (!urls.length && data.response && typeof data.response === "object") {
      urls = ((data.response as { resultUrls?: string[] }).resultUrls) || [];
    }
    urls = urls.filter((u) => /^https?:\/\//i.test(u));

    if (state === "success") return { status: "completed", urls };
    if (state === "fail") {
      return { status: "failed", error: (data.failMsg as string) || (data.failCode ? `failCode ${data.failCode}` : "") || "فشل التوليد لدى المزود" };
    }

    // تقدّم تقديري حسب الحالة (recordInfo لا يوفر progress رقميًا دائمًا)
    const progress =
      state === "generating" ? 55 : state === "queuing" ? 20 : state === "waiting" ? 10 : 5;
    return { status: "processing", progress };
  },
};
