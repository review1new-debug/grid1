"use client";

// بطاقة ب) لوحة المهام — إحصائيات + قائمة حية تتحدث تلقائيًا كل ~5 ثوانٍ
import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";

interface TaskItem {
  id: string;
  type: string;
  model: string;
  provider: string;
  status: string;
  progress: number;
  prompt: string;
  result_urls: string[] | null;
  error_message: string | null;
  attempts_count: number;
  created_at: string;
  completed_at: string | null;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const TYPE_META: Record<string, { label: string; cls: string }> = {
  image: { label: "صورة", cls: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30" },
  video: { label: "فيديو", cls: "bg-violet-500/10 text-violet-400 border-violet-500/30" },
  merge: { label: "دمج", cls: "bg-teal-500/10 text-teal-400 border-teal-500/30" },
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  completed: { label: "مكتملة", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  failed: { label: "فاشلة", cls: "bg-rose-500/10 text-rose-400 border-rose-500/30" },
  processing: { label: "جارية", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  pending: { label: "بالانتظار", cls: "bg-slate-500/10 text-slate-400 border-slate-500/30" },
};

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return d.toLocaleString("ar", { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export function TasksCard() {
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const data = await res.json();
      setStats(data.stats || { total: 0, completed: 0, failed: 0, processing: 0 });
      setTasks(data.tasks || []);
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    // تأجيل أول جلب لتفادي cascading renders
    const t0 = setTimeout(refresh, 0);
    const t = setInterval(refresh, 5_000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [refresh]);

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "تم نسخ الرابط" });
    } catch {
      /* تجاهل */
    }
  };

  const statChip = (label: string, value: number, cls: string) => (
    <span className={`rounded-lg border px-3 py-1.5 text-xs font-semibold ${cls}`}>
      {label}: <span className="ltr-num">{value}</span>
    </span>
  );

  return (
    <section aria-labelledby="tasks-card-title" className="rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 id="tasks-card-title" className="text-lg font-bold">
          <span className="text-violet-400">②</span> لوحة المهام
        </h2>
        <span className="text-[11px] text-slate-500 flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" /> تحديث تلقائي كل 5 ثوانٍ
        </span>
      </div>

      {/* شرائح الإحصائيات */}
      <div className="flex flex-wrap gap-2">
        {statChip("الإجمالي", stats.total, "bg-slate-500/10 text-slate-300 border-slate-500/30")}
        {statChip("مكتملة", stats.completed, "bg-emerald-500/10 text-emerald-400 border-emerald-500/30")}
        {statChip("فاشلة", stats.failed, "bg-rose-500/10 text-rose-400 border-rose-500/30")}
        {statChip("جارية", stats.processing, "bg-amber-500/10 text-amber-400 border-amber-500/30")}
      </div>

      {/* قائمة المهام */}
      <div className="max-h-96 overflow-y-auto scroll-slim space-y-2">
        {tasks.length === 0 && (
          <p className="text-sm text-slate-500 py-6 text-center">
            لا توجد مهام بعد — استدعِ generate_image أو generate_video من عميل MCP لبدء التوليد.
          </p>
        )}
        {tasks.map((t) => {
          const typeM = TYPE_META[t.type] || TYPE_META.image;
          const stM = STATUS_META[t.status] || STATUS_META.pending;
          return (
            <div key={t.id} className="rounded-xl border border-slate-800 bg-slate-800/40 px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${typeM.cls}`}>{typeM.label}</span>
                <span className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${stM.cls}`}>{stM.label}</span>
                <code className="ltr-num font-mono text-[10px] text-slate-400" dir="ltr">{t.model}</code>
                <span className="text-[11px] text-slate-500">{fmtTime(t.created_at)}</span>
                <span className="text-[11px] text-slate-500" title="عدد المحاولات">
                  محاولات: <span className="ltr-num">{t.attempts_count}</span>
                </span>
              </div>

              {t.prompt && <p className="text-xs text-slate-400 truncate" title={t.prompt}>{t.prompt}</p>}

              {/* شريط التقدم */}
              {t.status !== "completed" && t.status !== "failed" && (
                <div className="h-1.5 w-full rounded-full bg-slate-700/60 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-l from-cyan-500 to-violet-500 transition-all duration-500"
                    style={{ width: `${Math.max(3, Math.min(100, t.progress))}%` }}
                  />
                </div>
              )}

              {t.status === "failed" && t.error_message && (
                <p className="text-xs text-rose-300/90 leading-relaxed">❌ {t.error_message}</p>
              )}

              {/* أزرار فتح الروابط عند الاكتمال */}
              {t.status === "completed" && t.result_urls && t.result_urls.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.result_urls.map((u, i) => (
                    <span key={i} className="inline-flex gap-1 items-center">
                      <a
                        href={u}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/20"
                      >
                        {t.result_urls!.length > 1 ? `فتح النتيجة ${i + 1} ↗` : "فتح النتيجة ↗"}
                      </a>
                      <button
                        onClick={() => copyUrl(u)}
                        className="rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-700/60"
                      >
                        نسخ الرابط
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <p className="ltr-num font-mono text-[10px] text-slate-600" dir="ltr" title={t.id}>
                {t.id.slice(0, 8)}…
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
