# MCP Media Generator — خادم MCP لتوليد الصور والفيديو + خدمة دمج + لوحة إدارة عربية

خادم **MCP** (Model Context Protocol) يجمع ثلاث قدرات في أداة واحدة، مع لوحة ويب عربية RTL لإدارة كل شيء:

1. **توليد صور** من وصف نصي — الموديل: `gpt-image-2-6/flare-text-to-image`
2. **توليد فيديو** بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل: `grok-imagine-video-1-5-preview`
3. **دمج عدة مقاطع فيديو** في مقطع واحد عالي الجودة (H.264 + AAC حتى 1080p)

يعمل مع أي عميل MCP: **ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK**.

---

## القواعد الجوهرية (مطبَّقة بالكود)

- **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج في قاعدة Turso.
- **مفاتيح متعددة بترتيب تسلسلي صارم** — أول مفتاح أُضيف يُجرَّب أولًا (`created_at ASC, id ASC`)، مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة: نفس المهمة تُستأنف بنفس `task_id` على المفتاح التالي.
- **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا** — التبديل صامت تمامًا.
- مهمة فشل إنشاؤها على كل المفاتيح تبقى `processing` («بانتظار توفر مفتاح صالح…») وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح تكتمل من تلقاء نفسها.
- المهمة غير متزامنة: تعيد `task_id` فورًا مع نافذة انتظار قصيرة تبث تقدمًا حيًا (Progress notifications)، والعميل يتابع بـ `get_task` كل ~10 ثوانٍ.
- إخفاء المفاتيح إلزامي (`ABCD123••••••••WXYZ`) في كل الاستجابات والسجلات.
- ملفات الدمج تُحذف تلقائيًا بعد 24 ساعة — التنبيه مذكور في وصف الأداة وفي تعليمات السيرفر.

---

## الأدوات الخمس على `/mcp`

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة (aspect_ratio، resolution حتى 4K، شفافية، صيغة الخرج) |
| `generate_video` | توليد فيديو بصوت متزامن + image-to-video اختياري (حتى 15 ثانية) |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` أو `task_ids` (تُحل من القاعدة بالترتيب) |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — يُحدّث حيًا من المزود/خدمة الدمج |
| `list_media` | أحدث الوسائط المخزنة بروابطها من الأحدث |

## المزودون

| المزود | الصور | الفيديو | ملاحظات |
|---|---|---|---|
| **kie.ai** (أساسي) | مهام غير متزامنة عبر Jobs API الموحد | نفس النظام | `resultJson` نص JSON داخل JSON يُفك مرتين |
| **CometAPI** | صور **متزامنة** عبر نقطة متوافقة مع OpenAI | مهام غير متزامنة `/v1/videos` | تُجرَّب مفاتيحه بترتيبها بعد/بين مفاتيح kie |

تصنيف الأخطاء الموحد: `disabled` (401/403 أو رسالة مصادقة) → تعطيل تلقائي، `exhausted` (402 أو insufficient/quota/balance/credit — تُفحص **قبل** 400) → تعليم مستنزف وبقاء في القاعدة، `provider` (موديل غير مدعوم) → التالي، `params` (400/422) → توقف فوري، `temporary` (429/5xx/شبكة) → التالي.

---

## التشغيل محليًا

```bash
bun install          # أو npm install
cp .env.example .env # ثم ضع TURSO_DATABASE_URL و TURSO_AUTH_TOKEN و MERGER_API_BASE
bun run dev          # http://localhost:3000
```

- الواجهة: `http://localhost:3000/` — لوحة عربية RTL (مدير مفاتيح + لوحة مهام حية + بطاقة ربط)
- فحص الجهوزية: `GET /api/health` → `{"ok":true,"database":"turso-connected",...}`
- خادم MCP: `POST /mcp`

### اختبار سريع بالـ curl

```bash
# تهيئة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# استدعاء أداة (وضع عديم الجلسة — لا حاجة لمعرّف جلسة)
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_media","arguments":{}}}'
```

---

## متغيرات البيئة

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | ✅ | توكن Turso بصلاحيات كتابة |
| `MERGER_API_BASE` | ✅ للدمج | نطاق خدمة الدمج (مشروع Vercel ثانٍ من مجلد `merger/`) |
| `MCP_ACCESS_TOKEN` | — | حماية `/mcp` بمفتاح Bearer (يظهر في الواجهة و health) |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | — | تجاوز أسماء موديلات kie |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | — | تجاوز أسماء موديلات CometAPI |

---

## النشر على Vercel (مشروعان من نفس المستودع)

### إنشاء قاعدة Turso مجانًا

```bash
turso db create media-gen            # إنشاء القاعدة
turso db show media-gen --url        # → ضعه في TURSO_DATABASE_URL
turso db tokens create media-gen     # → ضعه في TURSO_AUTH_TOKEN
```

### 1) المشروع الرئيسي (خادم MCP + الواجهة)

1. اربط المستودع بـ Vercel → **New Project** → اختر المستودع → Root Directory = `/` (الافتراضي)
2. أضف متغيرات البيئة في **Settings → Environment Variables**:
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN`
   - `MERGER_API_BASE` = رابط خدمة الدمج بعد نشرها (الخطوة 2)
   - اختياري: `MCP_ACCESS_TOKEN`
3. **Deploy** — كل شيء يعمل عبر HTTP (libSQL) بدون ملفات محلية، و `/mcp` يدعم البث.

### 2) خدمة الدمج (مجلد `merger/`)

1. **Add New Project** → نفس المستودع → **Root Directory = `merger`**
2. أضف `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (نفس القاعدة — الجداول مختلفة فلا تعارض)
3. **Deploy**
4. ارجع للمشروع الرئيسي واضبط `MERGER_API_BASE` إلى رابط هذا المشروع ثم **Redeploy**

### 3) الربط مع عملاء MCP

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع `https://<نطاقك>/mcp` في Server URL
- **Claude Desktop**: ملف `claude_desktop_config.json`:

```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<نطاقك>/mcp" } } }
```

- **Cursor / Windsurf / Cline**: ملف `mcp.json` بنفس الصيغة (بدون `"type"`).

الواجهة تعرض JSON الجاهز للنسخ لكل عميل في تبويب «ربط السيرفر».

---

## بنية المشروع

```
├── src/
│   ├── app/
│   │   ├── mcp/route.ts              # خادم MCP (SDK الرسمي + Streamable HTTP، وضع عديم الجلسة)
│   │   ├── api/health/route.ts       # فحص الجهوزية (Turso + الموديلات + خدمة الدمج)
│   │   ├── api/keys/route.ts         # GET/POST المفاتيح (مقنعة دائمًا)
│   │   ├── api/keys/[id]/route.ts    # PATCH تعطيل/تنشيط + DELETE
│   │   ├── api/tasks/route.ts        # مهام الواجهة + الإحصائيات
│   │   ├── layout.tsx                # dir="rtl" lang="ar"
│   │   └── page.tsx                  # اللوحة الثلاثية
│   ├── components/dashboard/         # مدير المفاتيح + لوحة المهام + بطاقة الربط
│   └── lib/
│       ├── turso.ts                  # عميل Turso + ensureSchema + عمليات المهام
│       ├── keys.ts                   # الترتيب التسلسلي الصارم + maskKey + العدّادات
│       ├── errors.ts                 # classifyProviderError + sanitize (إخفاء المفاتيح عن العميل)
│       ├── models.ts                 # سجل الموديلات والأسماء البديلة (شرطات/نقاط)
│       ├── generation.ts             # runGeneration + refreshTask (التبديل «لا توقف أبدًا»)
│       ├── merger.ts                 # عميل خدمة الدمج v2 (فشل حتمي فوري لأخطاء HTTP المعلنة)
│       ├── format.ts                 # صياغة الردود العربية
│       ├── providers/kie.ts          # مزود kie.ai
│       └── providers/cometapi.ts     # مزود CometAPI
├── merger/                           # خدمة دمج مستقلة (Node.js خالص CommonJS — انظر merger/README.md)
├── scripts/                          # سكربتات الاختبار
├── .env.example                      # قالب المتغيرات (بلا قيم حقيقية)
└── .gitignore                        # .env* مستثنى منذ أول commit — لا أسرار في Git إطلاقًا
```

## الأمان

- `.env*` في `.gitignore` منذ اليوم الأول — لا تُرفع أي أسرار إلى Git.
- المفاتيح مقنَّعة في كل الاستجابات (`GET /api/keys` لا يعيد المفتاح الكامل أبدًا).
- رسائل الأخطاء الخارجة للعميل تُمرَّر عبر `sanitizePublicError` — لا ذكر لمفاتيح أو رصيد أبدًا.
- حماية اختيارية لـ `/mcp` عبر `MCP_ACCESS_TOKEN`.
