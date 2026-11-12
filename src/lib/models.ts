// سجل الموديلات (قسم 5.1) — الأسماء القابلة للتجاوز بمتغيرات البيئة
import type { MediaType, ProviderId } from "./types";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const fromEnv = (key: string, fallback: string): string => process.env[key]?.trim() || fallback;

let cache: ModelDef[] | null = null;

export function getModels(): ModelDef[] {
  if (!cache) {
    cache = [
      {
        canonical: "gpt-image-2-6/flare-text-to-image",
        aliases: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"],
        type: "image",
        providers: ["kie", "cometapi"],
        providerModel: {
          kie: fromEnv("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
          cometapi: fromEnv("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
        },
      },
      {
        canonical: "grok-imagine-video-1-5-preview",
        aliases: ["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"],
        type: "video",
        providers: ["kie", "cometapi"],
        providerModel: {
          kie: fromEnv("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
          cometapi: fromEnv("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
        },
      },
    ];
  }
  return cache;
}

/** توحيد الأسماء: النقاط تصبح شرطات (gpt-image-2.6 → gpt-image-2-6) */
export function normalizeModelName(name: string): string {
  return name.trim().replace(/\./g, "-");
}

/** حلّ اسم الموديل عبر الأسماء البديلة — غير معروف → null (خطأ معطيات فوري) */
export function resolveModel(name?: string, type?: MediaType): ModelDef | null {
  const models = getModels();
  if (!name || !name.trim()) {
    // الافتراضي: أول موديل من النوع المطلوب
    return (type && models.find((m) => m.type === type)) || null;
  }
  const n = normalizeModelName(name);
  return (
    models.find((m) => normalizeModelName(m.canonical) === n || m.aliases.some((a) => normalizeModelName(a) === n)) ||
    null
  );
}
