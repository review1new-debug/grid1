"use client";

// بطاقة أ) مدير المفاتيح — إضافة/تعطيل/تنشيط/حذف مع إخفاء دائم وقوائم ملونة
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

export interface SafeKey {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  exhausted: { label: "مستنزف", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  disabled: { label: "معطّل", cls: "bg-slate-500/10 text-slate-400 border-slate-500/30" },
};

export function KeysCard() {
  const [keys, setKeys] = useState<SafeKey[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = await res.json();
      setKeys(data.keys || []);
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      toast({ title: "أدخل المفتاح أولًا", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error || "فشل إضافة المفتاح", variant: "destructive" });
      } else {
        toast({ title: "تمت إضافة المفتاح — التجربة تسلسلية: أول مفتاح أُضيف يُجرَّب أولًا" });
        setApiKey("");
        setLabel("");
        await refresh();
      }
    } catch {
      toast({ title: "خطأ في الاتصال", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (k: SafeKey) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    const res = await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (res.ok) {
      toast({ title: next === "disabled" ? "تم تعطيل المفتاح" : "تم تنشيط المفتاح" });
      await refresh();
    } else {
      toast({ title: "فشل تحديث الحالة", variant: "destructive" });
    }
  };

  const remove = async (k: SafeKey) => {
    if (!window.confirm(`حذف المفتاح ${k.masked} نهائيًا؟`)) return;
    const res = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    if (res.ok) {
      toast({ title: "تم حذف المفتاح" });
      await refresh();
    } else {
      toast({ title: "فشل الحذف", variant: "destructive" });
    }
  };

  return (
    <section aria-labelledby="keys-card-title" className="rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 id="keys-card-title" className="text-lg font-bold">
          <span className="text-cyan-400">①</span> مدير المفاتيح
        </h2>
        <span className="text-xs text-slate-500">{keys.length} مفتاح</span>
      </div>

      <p className="rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2 text-xs leading-relaxed text-slate-400">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
      </p>

      {/* نموذج الإضافة */}
      <div className="grid gap-3 sm:grid-cols-[150px_1fr_1fr_auto]">
        <Select value={provider} onValueChange={setProvider} dir="rtl">
          <SelectTrigger aria-label="المزود">
            <SelectValue placeholder="المزود" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="kie">kie.ai</SelectItem>
            <SelectItem value="cometapi">CometAPI</SelectItem>
          </SelectContent>
        </Select>
        <Input
          placeholder="تسمية اختيارية (مثال: مفتاح رئيسي)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={100}
        />
        <Input
          placeholder="المفتاح API Key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="ltr-num font-mono text-sm"
          dir="ltr"
          type="password"
          autoComplete="off"
        />
        <Button onClick={addKey} disabled={busy} className="bg-cyan-600 hover:bg-cyan-500 text-white">
          {busy ? "جارٍ..." : "إضافة"}
        </Button>
      </div>

      {/* قائمة المفاتيح — مُقنَّعة دائمًا */}
      <div className="max-h-96 overflow-y-auto scroll-slim space-y-2">
        {keys.length === 0 && (
          <p className="text-sm text-slate-500 py-6 text-center">لا توجد مفاتيح بعد — أضف مفتاحًا واحدًا على الأقل لبدء التوليد.</p>
        )}
        {keys.map((k, i) => {
          const meta = STATUS_META[k.status] || STATUS_META.active;
          return (
            <div
              key={k.id}
              className="rounded-xl border border-slate-800 bg-slate-800/40 px-3 py-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className="text-xs text-slate-500 w-5">{i + 1}.</span>
                <span className="rounded-md bg-violet-500/10 border border-violet-500/30 text-violet-300 px-2 py-0.5 text-[11px] font-semibold">
                  {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                </span>
                <span className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>
                <code className="ltr-num font-mono text-xs text-slate-300" dir="ltr">{k.masked}</code>
                {k.label && <span className="text-xs text-slate-400 truncate max-w-40">«{k.label}»</span>}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-slate-400" title="استخدام / نجاح / فشل">
                  {k.usage_count} استخدام • <span className="text-emerald-400">{k.success_count} ناجح</span> •{" "}
                  <span className="text-rose-400">{k.fail_count} فاشل</span>
                </span>
                {k.last_error && (
                  <span className="text-[11px] text-rose-300/80 truncate max-w-52" title={k.last_error}>
                    آخر خطأ: {k.last_error.slice(0, 60)}
                  </span>
                )}
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs border-slate-700 hover:bg-slate-700"
                    onClick={() => toggle(k)}
                  >
                    {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs border-rose-900/60 text-rose-400 hover:bg-rose-950/50 hover:text-rose-300"
                    onClick={() => remove(k)}
                  >
                    حذف
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
