// GET /api/health — فحص الجهوزية الشامل (قسم 9 من المواصفة)
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { getModels } from "@/lib/models";
import { mergerConfigured, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const dbOk = await dbHealthy();
  const mergerOk = await mergerHealthy(); // فحص GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ

  return NextResponse.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "turso-error",
      mcpEndpoint: "/mcp",
      models: getModels().map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: {
        base: mergerConfigured() ? process.env.MERGER_API_BASE?.replace(/\/+$/, "") : null,
        healthy: mergerOk,
      },
      authRequired: !!process.env.MCP_ACCESS_TOKEN?.trim(),
    },
    { status: dbOk ? 200 : 503 },
  );
}
