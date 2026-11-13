# Video Merger API — خدمة دمج الفيديوهات على Vercel

خدمة مستقلة لدمج عدة مقاطع في **فيديو واحد عالي الجودة** (MP4 — H.264 + AAC، حتى 1080p، جودة CRF 18) مع واجهة برمجية عامة للمطورين وواجهة ويب عربية RTL.

- **Node.js خالص (CommonJS)** بدون أي خطوة بناء: واجهة ثابتة في `public/` + دوال Vercel Serverless في `api/`
- **كل التخزين في Turso (libSQL)**: بيانات المهام، أجزاء ملفات المصادر، والفيديو الناتج (Blobs) — لا S3 ولا خدمات خارجية
- **ffmpeg + ffprobe داخل الدالة نفسها** (`@ffmpeg-installer/linux-x64` + `@ffprobe-installer/linux-x64` — الثنائيات داخل حزم npm نفسها، بلا سكربتات postinstall تعمل مع bun على Vercel)

## الحدود

| الحد | القيمة | قابل للضبط عبر |
|---|---|---|
| عدد المقاطع | 10 كحد أقصى | `MAX_SOURCES` |
| حجم كل مصدر | 200 ميجابايت | `SOURCE_MAX_MB` |
| حجم الناتج | 150 ميجابايت | `OUTPUT_MAX_MB` |
| مجموع المدد | 600 ثانية | `MAX_TOTAL_DURATION_SEC` |
| حجم جزء الرفع | 4 ميجابايت (حد طلب Vercel ≈ 4.5MB) | `UPLOAD_CHUNK_BYTES` |
| الصلاحية | كل الملفات تُحذف تلقائيًا بعد 24 ساعة | ثابت |

المخرج ثابت: MP4 (H.264 CRF 18 + AAC 192k/44.1kHz + `+faststart`) — **لا توجد معاملات resolution/fps**.

## محرك الدمج (جودة عالية إلزامية)

- ffprobe لكل مصدر: الدقة، المدة، وجود صوت
- توحيد عبر `filter_complex`: `scale` + `pad` إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080 أبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p`، ثم `concat=n=:v=1:a=1`
- مصدر بلا صوت؟ يُضاف مسار صامت `anullsrc` بنفس مدته بدل أن يفشل الدمج
- تقدم الترميز يُقرأ من `-progress pipe:1` (`out_time_us`) ويُخزَّن في القاعدة: **0–40** سحب المصادر، **40–90** ترميز، **100** اكتمال
- ثنائي ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة: `ensureExecutable` ينسخه إلى `/tmp` بصلاحية 755 عند الحاجة
- لا اعتماد على نظام ملفات دائم — `/tmp` فقط أثناء المعالجة ويُنظَّف في `finally`

## التخزين والحذف التلقائي

- جداول: `jobs`, `sources`, `source_chunks`, `output_chunks` — تُنشأ بـ `CREATE TABLE IF NOT EXISTS` بمفتاح أساسي مركب
- كل Blob يُقسَّم إلى صفوف **2MB** (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات من **8 صفوف**
- كل مهمة لها `expires_at = created_at + 24 ساعة`؛ التنظيف كسول عند كل إنشاء/دمج + نقطة `/api/cron` مجدولة يوميًا في `vercel.json`
- DELETE يحذف كل صفوف المهمة في batch واحد؛ بعد نجاح الدمج تُحذف `source_chunks` — الناتج فقط هو المطلوب

## واجهة API العامة (بدون تسجيل، CORS مفتوح، الأخطاء `{"error":"..."}`)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة: `{"videos":[...]}` أو `{"sources":[{kind:"url"\|"file",...}]}` → `201 {jobId,status,statusUrl,processUrl,expiresAt[,uploads[],uploadChunkBytes]}` |
| `POST` | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء ثنائية ≤4MB (`application/octet-stream`) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن) → `{status:"done",videoUrl,downloadUrl,size,duration,resolution,expiresAt}` — قيد المعالجة → `202` |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث MP4 بدعم **Range (206 + Content-Range)** — `?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/config` | الحدود العامة + version + جهوزية Turso |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي) |

حالات المهمة: `queued` → (`uploading`) → `processing` → `done` | `failed`
الأكواد: 400 مدخلات تالفة، 404 غير موجود، 409 حالة غير مناسبة، 413 تجاوز الحجم، 405 طريقة خاطئة.

### أمثلة curl

```bash
# 1) إنشاء مهمة من روابط مباشرة
curl -X POST https://<نطاقك>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'
# → 201 {"jobId":"...","status":"queued","processUrl":"...","expiresAt":"..."}

# 2) تنفيذ الدمج (متزامن، يستغرق عادة 10–60 ثانية)
curl -X POST https://<نطاقك>/api/jobs/<jobId>/process
# → 200 {"status":"done","videoUrl":"https://<نطاقك>/api/jobs/<jobId>/video","size":...,"duration":...,"resolution":"1280x720"}

# 3) الاستطلاع / البث / التحميل / الحذف
curl https://<نطاقك>/api/jobs/<jobId>
curl -r 0-999999 https://<نطاقك>/api/jobs/<jobId>/video      # Range → 206
curl -o merged.mp4 "https://<نطاقك>/api/jobs/<jobId>/video?download=1"
curl -X DELETE https://<نطاقك>/api/jobs/<jobId>

# 4) مهمة مختلطة: ملف مرفوع + رابط
curl -X POST https://<نطاقك>/api/jobs -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"file","name":"a.mp4","size":123456},{"kind":"url","url":"https://example.com/b.mp4"}]}'
# ارفع الأجزاء بالترتيب (≤4MB لكل جزء):
curl -X POST "https://<نطاقك>/api/upload?job=<jobId>&seq=0&chunk=0" \
  -H "Content-Type: application/octet-stream" --data-binary @part0.bin
# ثم نفّذ process كما في الأعلى
```

## الواجهة

صفحة واحدة عربية RTL ثيم داكن بتدرجات سماوي/بنفسجي (`public/index.html`):

- حقل روابط متعدد + منطقة سحب وإفلات للملفات (mp4/mov/webm/mkv/avi/m4v/mpg/3gp)
- قائمة مصادر قابلة لإعادة الترتيب بالسحب أو أزرار ↑↓ مع ترقيم واضح — **ترتيب القائمة = ترتيب الدمج**
- زر «دمج الفيديوهات» ينفذ التدفق كاملًا: إنشاء → رفع الأجزاء (≤4MB مع إعادة محاولة ×3) → دمج → نتيجة، بشريط تقدم حقيقي من الخادم
- صفحة النتيجة: مشغل، الحجم/المدة/الدقة، تحميل، نسخ الرابط، عملية جديدة، وعدّاد تنازلي للصلاحية (24 ساعة)
- استئناف العرض بعد التحديث عبر `#job=<id>` (done → النتيجة فورًا، processing → تابع الاستطلاع)
- قسم «توثيق API» قابل للطي بأمثلة curl بالدومين الحقيقي

## النشر على Vercel

1. **New Project** → اختر المستودع → **Root Directory = `merger`**
2. أضف في **Settings → Environment Variables**:
   - `TURSO_DATABASE_URL` و `TURSO_AUTH_TOKEN` (إلزاميان)
   - اختياري: `MERGER_PUBLIC_BASE` لفرض نطاق الروابط، وحدود الحجم إن أردت
3. **Deploy** — `vercel.json` يضبط `maxDuration: 60` (الحد الأقصى لخطة Hobby؛ على خطة Pro ارفعه إلى 300 في `vercel.json`) + Cron يومي للتنظيف. الثنائيات تُضمَّن تلقائيًا عبر `includeFiles` بنمط نصّي واحد (Vercel يشترط نصًا لا مصفوفة) يشمل `ffmpeg` و`ffprobe` لنظام linux/x64 فقط.

> ملاحظة: مدة الدالة على خطة Hobby محدودة بـ **60 ثانية** — المقاطع الصغيرة (~10–30 ثانية) تُدمج خلالها بسهولة، وللأحجام الكبيرة يُفضَّل ترقية الخطة ثم رفع `maxDuration`.

## التشغيل والاختبار محليًا

```bash
bun install                    # أو npm install
cp .env.example .env           # ضع TURSO_DATABASE_URL و TURSO_AUTH_TOKEN
bun run dev                    # خادم تطوير يحاكي Vercel على http://localhost:8787
bun run test:unit              # اختبار وحدات: توليد مقطعين بـ ffmpeg → دمج → تحقق (الدقة/المدة/الصوت/التخزين/sha256/الأجزاء/الحذف)
bun run test:http              # اختبار HTTP كامل ضد خادم التطوير (روابط → دمج → Range 206 → مختلط → حذف → 404 → JSON تالف → حدود)
```

## متغيرات البيئة

| المتغير | إلزامي | الافتراضي |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | — |
| `TURSO_AUTH_TOKEN` | ✅ | — |
| `MERGER_PUBLIC_BASE` | — | يُستنتج من ترويسات الطلب |
| `MAX_SOURCES` | — | 10 |
| `SOURCE_MAX_MB` | — | 200 |
| `OUTPUT_MAX_MB` | — | 150 |
| `MAX_TOTAL_DURATION_SEC` | — | 600 |
| `FFMPEG_PRESET` | — | veryfast |
| `UPLOAD_CHUNK_BYTES` | — | 4194304 |

> `.env` مستثنى في `.gitignore` — لا تضع أسرارًا في المستودع إطلاقًا.
