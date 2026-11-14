// GET /api/tasks — إحصائيات + أحدث المهام للوحة المتابعة الحية
// إضافة: «دافع» المهام الجارية المجمدة — اللوحة تسأل كل 5 ثوانٍ فتحدّث نفسها من المزود
// (نفس منطق get_task تمامًا: checkAndUpdateTask للصور/الفيديو و refreshMergeTask للدمج)
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";
import { toTaskItem } from "@/lib/task-view";
import { checkAndUpdateTask } from "@/lib/generation";
import { refreshMergeTask } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// الفحص الحي للمزود قد يستغرق ثوانٍ — ضمن حد 60 ثانية لخطة Hobby
export const maxDuration = 60;

// لا نلمس مهمة حُدّثت خلال آخر 8 ثوانٍ (حماية من التزامن مع get_task القادم من عميل MCP)
const KICK_MIN_AGE_MS = 8_000;
// أقصى عدد مهام تُحدَّث حيًا في كل استدعاء — الحدود تبقي الاستجابة سريعة
const KICK_MAX = 3;

function ageMs(stamp: string): number {
  const t = Date.parse(stamp.includes("T") ? stamp : stamp.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
}

// قفل ذاكرة يمنع تحديث نفس المهمة مرتين في استدعائين متداخلين
const kickInFlight = new Set<string>();

/** تحديث حي للمهام الجارية التي لم يسأل عنها أحد مؤخرًا — يكمل التقدم وحده في اللوحة */
async function kickStaleTasks(): Promise<void> {
  let stale: Awaited<ReturnType<typeof listRecentTasks>> = [];
  try {
    const recent = await listRecentTasks(20);
    stale = recent
      .filter((t) => t.status === "processing" && t.provider_task_id && ageMs(t.updated_at) >= KICK_MIN_AGE_MS)
      .filter((t) => !kickInFlight.has(t.id))
      .slice(0, KICK_MAX);
  } catch {
    return; // القاعدة غير متاحة — يُعاد في الاستدعاء التالي
  }
  for (const t of stale) kickInFlight.add(t.id);
  await Promise.all(
    stale.map(async (t) => {
      try {
        if (t.type === "merge") await refreshMergeTask(t);
        else await checkAndUpdateTask(t);
      } catch {
        /* فحص فاشل — يُعاد تلقائيًا مع التحديث التالي للوحة */
      } finally {
        kickInFlight.delete(t.id);
      }
    }),
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;

  await kickStaleTasks();

  const [stats, tasks] = await Promise.all([taskStats(), listRecentTasks(limit, { type, status })]);

  return NextResponse.json({
    stats,
    tasks: tasks.map(toTaskItem),
  });
}
