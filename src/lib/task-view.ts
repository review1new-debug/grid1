// الصيغة الموحدة لعرض المهمة في استجابات الواجهة — مشتركة بين GET /api/tasks و POST resume
import type { TaskRow } from "./types";
import { sanitizePublicError } from "./errors";

/**
 * هل المهمة قابلة للاستكمال بزر «استكمال»؟
 * - failed: فشلت (خطأ مزود حقيقي أو فشل على كل المفاتيح) → الاستكمال يعيد التشغيل من المفتاح التالي.
 * - pending/processing بدون provider_task_id: الإنشاء لم ينجح بعد → الاستكمال يعيد المحاولة فورًا دون انتظار التهدئة.
 * - جارية مع provider_task_id: تعمل فعليًا لدى المزود → غير قابلة (لا تكرار للمهمة).
 */
export function isTaskResumable(t: TaskRow): boolean {
  if (t.status === "failed") return true;
  return (t.status === "pending" || t.status === "processing") && !t.provider_task_id;
}

/** تحويل صف المهمة إلى الشكل العام الآمن للواجهة (بلا مفاتيح أو تفاصيل داخلية) */
export function toTaskItem(t: TaskRow) {
  return {
    id: t.id,
    type: t.type,
    model: t.model,
    provider: t.provider,
    status: t.status,
    progress: t.progress,
    prompt: t.prompt,
    result_urls: t.result_urls ?? [],
    error_message: t.error_message ? sanitizePublicError(t.error_message) : null,
    attempts_count: (t.attempts || []).length,
    resumable: isTaskResumable(t),
    created_at: t.created_at,
    completed_at: t.completed_at,
  };
}
