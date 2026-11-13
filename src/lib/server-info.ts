// معلومات السيرفر والتعليمات — مشتركة بين مسار /mcp وواجهة الإدارة
export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

// نص جاهز يُرسل مع initialize — يعلّم العميل سير العمل والتبديل الصامت للمفاتيح
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// الأدوات الخمس مع وصف عربي سطر واحد لكل أداة (تُعرض في بطاقة الربط)
export const TOOLS_AR: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي وتعيد رابطها جاهزًا أو task_id للتابع" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (حوار/مؤثرات/موسيقى)" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب (حتى 10 مقاطع)" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — يُستعلم كل ~10 ثوانٍ حتى الاكتمال" },
  { name: "list_media", desc: "أحدث الصور/الفيديوهات/الدمجات المخزنة بروابطها" },
];
