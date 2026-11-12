// PATCH /api/keys/{id} — تعطيل/تنشيط يدوي (والتنشيط يعيد المفتاح المستنزف إلى active)
// DELETE /api/keys/{id} — حذف
import { NextResponse } from "next/server";
import { getKeyById, setKeyStatus, deleteKey, toSafeKey } from "@/lib/keys";
import type { KeyStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
  }

  const status = body.status as KeyStatus;
  if (!["active", "disabled"].includes(status)) {
    return NextResponse.json({ error: "الحالة يجب أن تكون active أو disabled" }, { status: 400 });
  }

  const existing = await getKeyById(id);
  if (!existing) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });

  await setKeyStatus(id, status, null); // التنشيط اليدوي يصفّر آخر خطأ
  const updated = await getKeyById(id);
  return NextResponse.json({ key: updated ? toSafeKey(updated) : null });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
