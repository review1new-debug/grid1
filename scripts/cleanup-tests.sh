#!/usr/bin/env bash
# تنظيف آثار الاختبار: مهام الاختبار من Turso + مهام الدمج من خدمة الدمج + المفتاح الوهمي
set -e
cd /home/z/my-project
node --env-file=.env <<'EOF'
const { createClient } = require("@libsql/client");
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

(async () => {
  // 1) حذف كل مهام الاختبار من جدول tasks (كلها آثار اختبار — لا مهام إنتاج)
  const before = await db.execute("SELECT COUNT(*) AS c FROM tasks");
  await db.execute("DELETE FROM tasks");
  console.log(`tasks: حُذفت ${Number(before.rows[0].c)} مهمة اختبار`);

  // 2) حذف المفتاح الوهمي (test-bad) — يبقى المفتاح الحقيقي فقط
  const r = await db.execute("SELECT id, label, api_key FROM api_keys");
  for (const row of r.rows) {
    const k = String(row.api_key);
    // المفتاح الوهمي من اختبار التبديل — ليس مفتاح kie حقيقي
    if (!/^[a-f0-9]{32}$/.test(k)) {
      await db.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [String(row.id)] });
      console.log(`api_keys: حُذف المفتاح الوهمي «${row.label}»`);
    }
  }
  const after = await db.execute("SELECT label, status FROM api_keys");
  for (const row of after.rows) console.log(`متبقي: ${row.label} (${row.status})`);
})();
EOF

echo "———— خدمة الدمج —————"
# 3) حذف مهام دمج الاختبار من خدمة الدمج (إن وجدت مهام متبقية)
node <<'EOF'
async function main() {
  // لا نقطة قائمة مهام في الخدمة (عمدًا) — نحذف المعرّفات المعروفة من الاختبارات إن كانت موجودة
  const ids = ["45b7c16baa144358", "534fbbd8d3414d09", "56a4394d38684653"];
  for (const id of ids) {
    try {
      const r = await fetch(`http://localhost:8787/api/jobs/${id}`, { method: "DELETE" });
      console.log(`merger job ${id}: HTTP ${r.status}`);
    } catch { console.log(`merger job ${id}: الخدمة غير متاحة محليًا (تُحذف تلقائيًا بعد 24 ساعة)`) }
  }
}
main();
EOF
echo "✔ اكتمل التنظيف"
