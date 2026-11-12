"use client";

// لوحة الإدارة العربية — هيدر بحالة الجهوزية + ثلاث بطاقات (مدير المفاتيح / لوحة المهام / ربط السيرفر)
import { useCallback, useEffect, useState } from "react";
import { KeysCard, type SafeKey } from "./keys-card";
import { TasksCard } from "./tasks-card";
import { ConnectCard } from "./connect-card";

export interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const data = (await res.json()) as HealthInfo;
      setHealth(data);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    // تأجيل أول جلب لتفادي cascading renders
    const t0 = setTimeout(refreshHealth, 0);
    const t = setInterval(refreshHealth, 10_000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [refreshHealth]);

  const dbConnected = health?.database === "turso-connected";

  return (
    <div className="dark min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        {/* الهيدر */}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              <span className="bg-gradient-to-l from-cyan-400 via-teal-300 to-violet-400 bg-clip-text text-transparent">
                MCP Media Generator
              </span>
            </h1>
            <p className="text-sm text-slate-400 mt-1">
              خادم توليد الصور والفيديو ودمج المقاطع — مع تبديل تسلسلي تلقائي للمفاتيح
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap" dir="ltr">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border ${
                dbConnected
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                  : "bg-rose-500/10 text-rose-400 border-rose-500/30"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${dbConnected ? "bg-emerald-400 animate-pulse" : "bg-rose-400"}`} />
              {dbConnected ? "Turso متصل" : "غير متصل"}
            </span>
            {health?.merger && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border ${
                  health.merger.healthy
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                    : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${health.merger.healthy ? "bg-emerald-400" : "bg-amber-400"}`} />
                {health.merger.healthy ? "Merger جاهزة" : "Merger غير مهيأة"}
              </span>
            )}
            {health?.authRequired && (
              <span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border bg-violet-500/10 text-violet-400 border-violet-500/30">
                حماية Bearer مفعّلة
              </span>
            )}
          </div>
        </header>

        {/* رقائق الموديلات المدعومة */}
        {health?.models && (
          <div className="flex flex-wrap gap-2" dir="ltr">
            {health.models.map((m) => (
              <span
                key={m.canonical}
                className="rounded-md border border-slate-700/60 bg-slate-800/50 px-2.5 py-1 text-[11px] font-medium text-slate-300"
              >
                {m.type === "image" ? "🖼" : "🎬"} {m.canonical}
                <span className="text-slate-500"> · {m.providers.join(" → ")}</span>
              </span>
            ))}
          </div>
        )}

        {/* البطاقات */}
        <KeysCard />
        <TasksCard />
        <ConnectCard authRequired={health?.authRequired ?? false} />
      </div>
    </div>
  );
}

export type { SafeKey };
