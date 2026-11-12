"use client";

// بطاقة ج) ربط السيرفر — رابط MCP + JSON جاهز للنسخ لكل عميل + رقائق الأدوات + الملاحظة الكهرمانية
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { TOOLS_AR } from "@/lib/server-info";

export function ConnectCard({ authRequired }: { authRequired: boolean }) {
  const [origin, setOrigin] = useState("");
  const { toast } = useToast();

  useEffect(() => {
    // الرابط المطلق يُحسب في المتصفح لتجنب عدم تطابق الترميز — تأجيل بسيط لتفادي cascading renders
    const t = setTimeout(() => setOrigin(window.location.origin), 0);
    return () => clearTimeout(t);
  }, []);

  const mcpUrl = origin ? `${origin}/mcp` : "";

  const configs = useMemo(() => {
    // JSON جاهز للنسخ لكل تبويب — مع Authorization إذا ضُبط MCP_ACCESS_TOKEN
    const headers = authRequired
      ? `, "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
      : "";
    return {
      chatgpt: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${headers}
    }
  }
}`,
      claude: `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl}"${headers}
    }
  }
}`,
      cursor: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${headers}
    }
  }
}`,
    };
  }, [mcpUrl, authRequired]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `تم نسخ ${what}` });
    } catch {
      toast({ title: "تعذر النسخ — انسخ يدويًا", variant: "destructive" });
    }
  };

  const tabBlock = (id: string, label: string, json: string, extra?: string) => (
    <TabsContent value={id} className="space-y-2 mt-3">
      <div className="flex items-center justify-between">
        <code className="text-xs text-slate-500" dir="ltr">
          {id === "claude" ? "claude_desktop_config.json" : id === "cursor" ? "mcp.json" : "Connectors → Custom MCP server"}
        </code>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3 text-xs border-slate-700 hover:bg-slate-700"
          onClick={() => copy(json, "الإعداد")}
        >
          نسخ JSON
        </Button>
      </div>
      <pre
        dir="ltr"
        className="ltr-num rounded-lg border border-slate-800 bg-slate-950/80 p-3 text-[11px] leading-relaxed text-cyan-200 font-mono overflow-x-auto scroll-slim"
      >
        {json}
      </pre>
      {extra && <p className="text-[11px] leading-relaxed text-slate-400">{extra}</p>}
    </TabsContent>
  );

  return (
    <section aria-labelledby="connect-card-title" className="rounded-2xl border border-slate-800 bg-slate-900/60 backdrop-blur p-6 space-y-4">
      <h2 id="connect-card-title" className="text-lg font-bold">
        <span className="text-teal-400">③</span> ربط السيرفر
      </h2>

      {/* حقل الرابط المطلق + نسخ */}
      <div className="flex gap-2">
        <input
          readOnly
          dir="ltr"
          value={mcpUrl || "..."}
          aria-label="رابط خادم MCP"
          className="ltr-num flex-1 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 font-mono text-sm text-cyan-300"
        />
        <Button
          className="bg-teal-600 hover:bg-teal-500 text-white"
          onClick={() => copy(mcpUrl, "الرابط")}
          disabled={!mcpUrl}
        >
          نسخ الرابط
        </Button>
      </div>

      {/* التبويبات الثلاثة */}
      <Tabs defaultValue="chatgpt">
        <TabsList className="bg-slate-800/70 border border-slate-700/60">
          <TabsTrigger value="chatgpt" className="text-xs data-[state=active]:bg-slate-700">ChatGPT / GPT Agents</TabsTrigger>
          <TabsTrigger value="claude" className="text-xs data-[state=active]:bg-slate-700">Claude Desktop</TabsTrigger>
          <TabsTrigger value="cursor" className="text-xs data-[state=active]:bg-slate-700">Cursor / Windsurf / Cline</TabsTrigger>
        </TabsList>
        {tabBlock(
          "chatgpt",
          "ChatGPT",
          configs.chatgpt,
          "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
        )}
        {tabBlock("claude", "Claude", configs.claude, "الصق المحتوى في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.")}
        {tabBlock("cursor", "Cursor", configs.cursor, "الصق المحتوى في mcp.json داخل Cursor / Windsurf / Cline ثم أعد التحميل.")}
      </Tabs>

      {/* رقائق الأدوات الخمس */}
      <div className="flex flex-wrap gap-2 pt-1">
        {TOOLS_AR.map((t) => (
          <span
            key={t.name}
            title={t.desc}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/70 bg-slate-800/50 px-3 py-1 text-xs"
          >
            <code className="ltr-num font-mono text-cyan-300" dir="ltr">{t.name}</code>
            <span className="text-slate-400">{t.desc}</span>
          </span>
        ))}
      </div>

      {/* الملاحظة الكهرمانية */}
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
        ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع نموذج الذكاء الاصطناعي تلقائيًا بـ get_task كل 10 ثوانٍ —
        وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
      </p>
    </section>
  );
}
