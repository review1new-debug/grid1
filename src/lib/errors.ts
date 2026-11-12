import type { ErrorClass } from "./types";

// خطأ موحد من المزود — يُصنَّف لاحقًا عبر classifyProviderError
export class ProviderError extends Error {
  constructor(
    public status: number, // 0 يعني خطأ شبكة/انقطاع من جهتنا
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * تصنيف موحد لأخطاء المزودين (جدول 4.2):
 * - disabled: مفتاح مرفوض (401/403 أو رسالة مصادقة) → تعطيله والانتقال للتالي
 * - exhausted: نفاد رصيد (402 أو رسائل insufficient/quota/balance...) → تعليمه مستنزفًا والانتقال للتالي
 *   (تُفحص رسائل الرصيد قبل 400 لأن بعض المزودين يرسلونها بحالة 400)
 * - provider: الموديل غير مدعوم لدى هذا المزود → الانتقال للتالي
 * - params: خطأ في معطيات الطلب → توقف فورًا (تبديل المفاتيح لن يحلّه)
 * - temporary: 429/5xx/انقطاع شبكة → الانتقال للتالي الآن والمفتاح يبقى سليمًا
 */
export function classifyProviderError(status: number, message: string): ErrorClass {
  const msg = (message || "").toLowerCase();

  if (status === 401 || status === 403) return "disabled";
  if (/(invalid api key|invalid key|unauthorized|forbidden|authentication|auth failed)/.test(msg)) return "disabled";

  if (status === 402) return "exhausted";
  if (/(insufficient|quota|balance|credit|out of credits|exhausted|充值|billing)/.test(msg)) return "exhausted";

  if (/(model not found|unsupported model|no available model|unknown model)/.test(msg) && [400, 404, 422].includes(status))
    return "provider";

  if (status === 400 || status === 422) return "params";

  if (status === 429 || status >= 500) return "temporary";

  // غير معروف → نتعامل معه كمؤقت ونجرّب المفتاح التالي بدل التوقف
  return "temporary";
}

/**
 * نمط رسائل فشل «مشكلات مفتاح/رصيد» أثناء منتصف المهمة (قسم 4.3.2):
 * إذا تطابقت رسالة فشل المزود معه نعيد إنشاء نفس المهمة على المفتاح التالي.
 */
export const KEY_FAIL_PATTERN =
  /(insufficient|balance|credit|quota|402|401|unauthorized|exhausted|invalid api key|مفتاح|رصيد)/i;

// أنماط تُخفى عن نموذج الذكاء الاصطناعي والمستخدم نهائيًا (قاعدة ذهبية 4)
const SECRET_PATTERNS = /(api[\s_-]?key|مفتاح|مفاتيح|balance|رصيد|credit|quota|unauthorized|401|402|exhausted|insufficient|billing)/i;

/** تنظيف رسالة الخطأ قبل عرضها للعميل: لا يخرج أي ذكر لمفاتيح أو رصيد أبدًا */
export function sanitizePublicError(msg: string | null | undefined): string {
  const m = (msg || "").trim() || "خطأ غير معروف";
  if (SECRET_PATTERNS.test(m)) {
    return "تعذّر إكمال المهمة في هذه اللحظة — سيُعاد المحاولة تلقائيًا، تابع بـ get_task حتى تكتمل.";
  }
  return m;
}
