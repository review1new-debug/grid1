// GET /api/tasks — إحصائيات + أحدث المهام للوحة المتابعة الحية
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";
import { toTaskItem } from "@/lib/task-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 20)));
  const type = url.searchParams.get("type") || undefined;
  const status = url.searchParams.get("status") || undefined;

  const [stats, tasks] = await Promise.all([taskStats(), listRecentTasks(limit, { type, status })]);

  return NextResponse.json({
    stats,
    tasks: tasks.map(toTaskItem),
  });
}
