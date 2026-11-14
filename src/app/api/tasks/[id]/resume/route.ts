// POST /api/tasks/{id}/resume — زر «استكمال» في اللوحة: يواصل المهمة فورًا على المفتاح/الخدمة التالية
import { NextResponse } from "next/server";
import { getTask } from "@/lib/turso";
import { resumeGenerationTask } from "@/lib/generation";
import { toTaskItem, isTaskResumable } from "@/lib/task-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الاستكمال محدودة (30 ثانية للتوليد / 45 ثانية للدمج) — ضمن حد 60 ثانية لخطة Hobby
export const maxDuration = 60;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = await getTask(id);
  if (!t) return NextResponse.json({ error: "المهمة غير موجودة" }, { status: 404 });

  if (!isTaskResumable(t)) {
    const msg =
      t.status === "completed"
        ? "المهمة مكتملة بالفعل — لا حاجة للاستكمال"
        : t.status === "processing"
          ? "المهمة قيد التنفيذ لدى المزود الآن — تابع التحديث التلقائي في اللوحة"
          : "المهمة غير قابلة للاستكمال في حالتها الحالية";
    return NextResponse.json({ error: msg, task: toTaskItem(t) }, { status: 409 });
  }

  try {
    if (t.type === "merge") {
      const { resumeMergeTask } = await import("@/lib/merger");
      const { task, message } = await resumeMergeTask(t);
      return NextResponse.json({ ok: true, message, task: toTaskItem(task) });
    }
    const { task, message } = await resumeGenerationTask(t);
    return NextResponse.json({ ok: true, message, task: toTaskItem(task) });
  } catch (e) {
    console.error("resume endpoint error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "تعذّر الاستكمال الآن — أعد المحاولة بعد قليل" }, { status: 500 });
  }
}
