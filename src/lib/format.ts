// صياغة الردود العربية للأدوات (قسم 8 من المواصفة)
// المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية
import { sanitizePublicError } from "./errors";
import type { TaskRow } from "./types";

/** رسالة داخلية فقط — لا تخرج للعميل عند الفشل على كل المفاتيح (المهمة تبقى processing) */
export const INTERNAL_WAIT_MSG = "بانتظار توفر مفتاح صالح…";

export function fmtNoKeys(model: string): string {
  return `❌ لا توجد مفاتيح نشطة لخدمة ${model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`;
}

export function fmtImageDone(urls: string[], taskId?: string): string {
  const lines = ["✅ تم توليد الصورة بنجاح", "", `![image](${urls[0]})`, "", `الرابط المباشر: ${urls[0]}`];
  if (urls.length > 1) {
    lines.push("", "روابط إضافية:", ...urls.slice(1).map((u) => `- ${u}`));
  }
  if (taskId) lines.push("", `معرّف المهمة: ${taskId}`);
  return lines.join("\n");
}

export function fmtVideoDone(urls: string[], taskId?: string): string {
  const lines = ["✅ تم توليد الفيديو بنجاح", "", `الرابط المباشر: ${urls[0]}`];
  if (urls.length > 1) lines.push("", "روابط إضافية:", ...urls.slice(1).map((u) => `- ${u}`));
  if (taskId) lines.push("", `معرّف المهمة: ${taskId}`);
  return lines.join("\n");
}

export function fmtMergeDone(urls: string[], extra?: { size?: number; duration?: number; resolution?: string }): string {
  const lines = ["✅ تم دمج المقاطع بنجاح", "", `الرابط المباشر: ${urls[0]}`];
  if (extra?.duration || extra?.resolution || extra?.size) {
    const info: string[] = [];
    if (extra.resolution) info.push(`الدقة: ${extra.resolution}`);
    if (extra.duration) info.push(`المدة: ${Number(extra.duration).toFixed(1)} ثانية`);
    if (extra.size) info.push(`الحجم: ${(extra.size / 1024 / 1024).toFixed(2)} ميجابايت`);
    if (info.length) lines.push("", info.join(" • "));
  }
  // ملاحظة إلزامية لمهام الدمج
  lines.push("", "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
  return lines.join("\n");
}

export function fmtProcessing(taskId: string, progress?: number): string {
  const p = typeof progress === "number" && progress > 0 ? ` (التقدّم ${Math.min(99, Math.round(progress))}%)` : "";
  return `⏳ المهمة قيد المعالجة${p} — task_id: ${taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function fmtFailed(reason: string | null | undefined): string {
  return `❌ فشلت المهمة: ${sanitizePublicError(reason)}`;
}

export function fmtParamsError(detail: string): string {
  return `❌ معطيات غير صالحة: ${sanitizePublicError(detail)}`;
}

export function fmtMergeNeedsTwo(failedIds: { id: string; reason: string }[]): string {
  let s = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
  if (failedIds.length) {
    s += "\n\nتفاصيل المعرّفات غير الصالحة:";
    for (const f of failedIds) s += `\n- ${f.id}: ${f.reason}`;
  }
  return s;
}

export function fmtMergerNotConfigured(): string {
  return "❌ خدمة الدمج غير مهيأة بعد — يجب ضبط متغير البيئة MERGER_API_BASE ثم إعادة النشر. توليد الصور والفيديو يعمل بشكل طبيعي.";
}

export function fmtUnknownTool(name: string, available: string[]): string {
  return `❌ أداة غير معروفة: ${name}. المتاح: ${available.join(", ")}`;
}

export function fmtTaskNotFound(taskId: string): string {
  return `❌ لا توجد مهمة بهذا المعرّف: ${taskId}. تحقق من task_id أو استخدم list_media لاستعراض المهام المخزّنة.`;
}

export function statusAr(status: string): string {
  return status === "completed" ? "مكتملة" : status === "failed" ? "فاشلة" : status === "processing" ? "جارية" : "بالانتظار";
}

export function typeAr(type: string): string {
  return type === "image" ? "صورة" : type === "merge" ? "دمج" : "فيديو";
}

export function fmtTaskDone(t: TaskRow): string {
  const urls = t.result_urls && t.result_urls.length ? t.result_urls : [];
  if (!urls.length) return fmtProcessing(t.id, t.progress);
  if (t.type === "image") return fmtImageDone(urls, t.id);
  if (t.type === "merge") return fmtMergeDone(urls);
  return fmtVideoDone(urls, t.id);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** list_media — أحدث الوسائط المخزنة بروابطها مرتبة من الأحدث */
export function fmtListMedia(tasks: TaskRow[]): string {
  if (!tasks.length) return "لا توجد وسائط مخزّنة بعد — ابدأ بـ generate_image أو generate_video ثم استعلم list_media مجددًا.";
  const lines = [`📊 آخر ${tasks.length} مهمة مخزّنة (من الأحدث):`, ""];
  tasks.forEach((t, i) => {
    const st = t.status === "completed" ? "✅ مكتملة" : t.status === "failed" ? "❌ فاشلة" : "⏳ جارية";
    lines.push(`${i + 1}. [${typeAr(t.type)}] ${st} — ${t.created_at}`);
    if (t.prompt) lines.push(`   الوصف: ${truncate(t.prompt, 90)}`);
    if (t.result_urls && t.result_urls.length) lines.push(`   الرابط: ${t.result_urls[0]}`);
    if (t.status === "failed" && t.error_message) lines.push(`   السبب: ${truncate(sanitizePublicError(t.error_message), 100)}`);
    lines.push(`   task_id: ${t.id}`);
  });
  return lines.join("\n");
}
