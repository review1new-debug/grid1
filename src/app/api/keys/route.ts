// GET /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey)
// POST /api/keys — إضافة مفتاح مع رفض التكرار لنفس المزود
import { NextResponse } from "next/server";
import { listKeys, insertKey, toSafeKey } from "@/lib/keys";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: ProviderId[] = ["kie", "cometapi"];

export async function GET() {
  const keys = await listKeys();
  // لا يُعاد المفتاح الكامل في أي استجابة إطلاقًا
  return NextResponse.json({ keys: keys.map(toSafeKey) });
}

export async function POST(req: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
  }

  const provider = (body.provider || "").trim() as ProviderId;
  const apiKey = (body.api_key || "").trim();
  const label = (body.label || "").trim().slice(0, 100);

  if (!PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "المزود غير صالح — المسموح: kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return NextResponse.json({ error: "المفتاح مطلوب (8 أحرف على الأقل)" }, { status: 400 });
  }

  // رفض التكرار لنفس المزود (نفس قيمة المفتاح)
  const existing = await listKeys();
  const dup = existing.find((k) => k.provider === provider && k.api_key === apiKey);
  if (dup) {
    return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
  }

  const key = await insertKey({ provider, api_key: apiKey, label });
  return NextResponse.json({ key: toSafeKey(key) }, { status: 201 });
}
