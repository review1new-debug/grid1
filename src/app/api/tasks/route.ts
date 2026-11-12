// GET /api/tasks — إحصائيات + أحدث المهام للوحة المتابعة الحية
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";
import { sanitizePublicError } from "@/lib/errors";

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
    tasks: tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      provider: t.provider,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt,
      result_urls: t.result_urls,
      error_message: t.error_message ? sanitizePublicError(t.error_message) : null,
      attempts_count: (t.attempts || []).length,
      created_at: t.created_at,
      completed_at: t.completed_at,
    })),
  });
}
