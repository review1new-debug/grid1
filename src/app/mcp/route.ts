// خادم MCP على المسار /mcp — نقل Streamable HTTP حسب مواصفة MCP (قسم 8)
// يستخدم SDK الرسمي: McpServer + WebStandardStreamableHTTPServerTransport (بدون JSON-RPC يدوي)
// وضع عديم الجلسة (stateless) — كل طلب مستقل، متوافق تمامًا مع بيئة Serverless على Vercel
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { runGeneration, refreshTask, listMedia, noopNotify } from "@/lib/generation";
import { runMerge } from "@/lib/merger";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "@/lib/server-info";
import type { ProgressNotifier, ToolResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** بناء مُبلِّغ التقدم — يُرسل notifications/progress إذا زوّد العميل الطلب بـ _meta.progressToken */
function makeNotifier(extra: unknown): ProgressNotifier {
  const ex = extra as { _meta?: { progressToken?: unknown }; requestInfo?: { _meta?: { progressToken?: unknown } }; sendNotification?: (n: unknown) => Promise<void> };
  const progressToken = ex?._meta?.progressToken ?? ex?.requestInfo?._meta?.progressToken;
  if (!progressToken || typeof ex?.sendNotification !== "function") return noopNotify;
  return async (progress: number, total: number, message: string) => {
    try {
      await ex.sendNotification!({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      });
    } catch {
      // لا نُعطّل المهمة أبدًا بسبب فشل إشعار تقدّم
    }
  };
}

function toToolResult(r: ToolResponse) {
  return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
}

/** تسجيل الأدوات الخمس — الأوصاف الإنجليزية الدقيقة للعميل، والنتائج تُصاغ بالعربية */
function registerTools(server: McpServer) {
  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys in strict order). " +
        "Returns the image URL ready to show if it finishes within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => toToolResult(await runGeneration(args as Record<string, unknown>, "image", makeNotifier(extra))),
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue/SFX/music; optional image-to-video). " +
        "Video takes minutes: short wait with live progress broadcast, then a task_id — poll get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => toToolResult(await runGeneration(args as Record<string, unknown>, "video", makeNotifier(extra))),
  );

  // 3) merge_videos — بلا resolution/fps: خدمة الدمج تثبّت المخرج، والحد 10 مقاطع
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links) or 'task_ids' " +
        "(completed video generation tasks — their result URLs are resolved from the database in this order — ideal after generating several clips). " +
        "Merging is usually fast: short wait with live progress, then a task_id if not finished — track it with get_task. " +
        "NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2)
          .max(10)
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => toToolResult(await runMerge(args as { urls?: string[]; task_ids?: string[]; wait_seconds?: number }, makeNotifier(extra))),
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live from the provider/merging service when still processing). " +
        "Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async ({ task_id }) => toToolResult(await refreshTask(task_id)),
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      description:
        "List the latest stored images/videos/merges with their result URLs from the database (no re-generation) — recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => toToolResult(await listMedia(args as { type?: string; status?: string; limit?: number })),
  );
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, mcp-session-id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, mcp-session-id",
  };
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(corsHeaders())) out.headers.set(k, v);
  return out;
}

function jsonWithCors(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handle(req: Request): Promise<Response> {
  // حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>
  const token = process.env.MCP_ACCESS_TOKEN?.trim();
  if (token) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${token}`) {
      return jsonWithCors({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: Bearer token required" }, id: null }, 401);
    }
  }

  // وضع عديم الجلسة: نقل جديد لكل طلب — آمن على Serverless لأن حالة المهام كلها في Turso
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  await server.connect(transport);

  const res = await transport.handleRequest(req);
  return withCors(res);
}

export async function POST(req: Request): Promise<Response> {
  try {
    return await handle(req);
  } catch (e) {
    console.error("MCP POST error:", e instanceof Error ? e.message : e);
    return jsonWithCors({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, 500);
  }
}

export async function GET(): Promise<Response> {
  // وضع عديم الجلسة: لا دفق SSE للاستماع — 405 حسب المواصفة
  return jsonWithCors({ error: "Method Not Allowed — use POST for JSON-RPC messages" }, 405);
}

export async function DELETE(): Promise<Response> {
  // لا جلسات تُنهى في الوضع العديم — 405 حسب المواصفة
  return jsonWithCors({ error: "Session termination not supported in stateless mode" }, 405);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
