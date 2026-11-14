#!/usr/bin/env bash
# اختبار E2E كامل لزر «استكمال» — يشغّل: مزود وهمي + خدمة دمج وهمية + next dev ثم ينفذ كل الحالات ويتحقق من النتائج
set -u
cd /home/z/my-project

BASE="http://127.0.0.1:3100"
VIDEO_TASK="11111111-1111-4111-8111-111111111111"
IMAGE_TASK="22222222-2222-4222-8222-222222222222"
MERGE_TASK="33333333-3333-4333-8333-333333333333"
DONE_TASK="44444444-4444-4444-8444-444444444444"

cleanup() { pkill -f "next dev" 2>/dev/null; pkill -f "mock-resume-providers" 2>/dev/null; }
cleanup; sleep 1

echo "== [0] تجهيز القاعدة + تشغيل الوهمي =="
node scripts/seed-resume-test.mjs > /tmp/seed.json || { echo "SEED FAILED"; exit 1; }
node scripts/mock-resume-providers.mjs > /tmp/mock.log 2>&1 &
MOCK_PID=$!
sleep 1

TURSO_DATABASE_URL=file:/tmp/turso-resume-test.db TURSO_AUTH_TOKEN=local-test \
  COMETAPI_BASE=http://127.0.0.1:9901 MERGER_API_BASE=http://127.0.0.1:9902 \
  npx next dev -p 3100 > /tmp/next-dev.log 2>&1 &
DEV_PID=$!

for i in $(seq 1 60); do
  sleep 2
  H=$(curl -s --max-time 5 "$BASE/api/health" 2>/dev/null)
  echo "$H" | grep -q "turso-connected" && { echo "== dev READY (after $((i*2))s) =="; break; }
done
echo "$H" | grep -q "turso-connected" || { echo "DEV FAILED TO START"; tail -20 /tmp/next-dev.log; cleanup; exit 1; }

echo; echo "== [1] GET /api/tasks — أعلام resumable =="
curl -s --max-time 30 "$BASE/api/tasks?limit=10" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('stats:', d['stats'])
for t in d['tasks']:
    print(' ', t['id'][:8], '|', t['type'], '|', t['status'], '| resumable:', t['resumable'], '| attempts:', t['attempts_count'])
"
echo; echo "== [2] استكمال مهمة الصورة (متزامنة → مكتملة فورًا على k2) =="
curl -s --max-time 60 -X POST "$BASE/api/tasks/$IMAGE_TASK/resume" | python3 -m json.tool | head -22

echo; echo "== [3] استكمال مهمة الفيديو (check أول 40% ثم مكتمل → مكتملة داخل النافذة) ="
curl -s --max-time 90 -X POST "$BASE/api/tasks/$VIDEO_TASK/resume" | python3 -m json.tool | head -22

echo; echo "== [4] استكمال مهمة الدمج → مكتملة من الخدمة الوهمية =="
curl -s --max-time 90 -X POST "$BASE/api/tasks/$MERGE_TASK/resume" | python3 -m json.tool | head -18

echo; echo "== [5] استكمال مهمة مكتملة → يجب 409 =="
curl -s -o /tmp/r5.json -w "HTTP %{http_code}\n" --max-time 30 -X POST "$BASE/api/tasks/$DONE_TASK/resume"; head -c 200 /tmp/r5.json; echo

echo; echo "== [6] استكمال معرف غير موجود → يجب 404 =="
curl -s -o /tmp/r6.json -w "HTTP %{http_code}\n" --max-time 30 -X POST "$BASE/api/tasks/does-not-exist/resume"; head -c 150 /tmp/r6.json; echo

echo; echo "== [7] سجل المزود الوهمي — يجب ألا يظهر mock-key-1 إطلاقًا (تخطي المفتاح الفاشل) =="
curl -s "http://127.0.0.1:9901/_log" | python3 -c "
import json,sys
calls=json.load(sys.stdin)
for c in calls: print(' ', c['method'], c['path'], 'auth=', c['auth'])
bad=[c for c in calls if c['auth']=='mock-key-1']
print('mock-key-1 calls:', len(bad), '(يجب أن تكون 0)')
"

echo; echo "== [8] حالة قاعدة البيانات النهائية للمهام الثلاث =="
node -e "
const { createClient } = require('@libsql/client');
(async () => {
  const db = createClient({ url: 'file:/tmp/turso-resume-test.db' });
  for (const id of ['$VIDEO_TASK', '$IMAGE_TASK', '$MERGE_TASK']) {
    const r = await db.execute({ sql: 'SELECT id, type, status, progress, provider, provider_task_id, key_id, result_urls_json, attempts_json FROM tasks WHERE id = ?', args: [id] });
    const t = r.rows[0];
    const attempts = JSON.parse(String(t.attempts_json || '[]'));
    console.log(' ', String(t.id).slice(0, 8), '|', t.type, '|', t.status, '| progress:', t.progress, '| provider:', t.provider, '| provider_task_id:', t.provider_task_id, '| key_id:', String(t.key_id).slice(0, 12), '| attempts:', attempts.length, '| urls:', String(t.result_urls_json).slice(0, 60));
  }
})();
"

echo; echo "== [9] عدّادات المفتاحين =="
node -e "
const { createClient } = require('@libsql/client');
(async () => {
  const db = createClient({ url: 'file:/tmp/turso-resume-test.db' });
  const r = await db.execute('SELECT label, api_key, usage_count, success_count, fail_count FROM api_keys ORDER BY created_at');
  for (const k of r.rows) console.log(' ', k.label, '|', k.api_key, '| usage:', k.usage_count, '| success:', k.success_count, '| fail:', k.fail_count);
})();
"

echo; echo "== [10] «دافع» اللوحة: مهمة جارية مجمدة تُكمل تلقائيًا عبر GET /api/tasks =="
echo "-- استدعاء أول (يفحص المزود: 40%) ثم انتظار 9 ثوانٍ ثم استدعاء ثانٍ (يكتمل)"
curl -s --max-time 40 "$BASE/api/tasks?limit=10" > /dev/null
sleep 9
curl -s --max-time 40 "$BASE/api/tasks?limit=10" | python3 -c "
import json,sys
d=json.load(sys.stdin)
t=[x for x in d['tasks'] if x['id'].startswith('55555555')][0]
print('  stuck task:', t['status'], '| progress:', t['progress'], '| resumable:', t['resumable'], '| urls:', t['result_urls'])
"

cleanup
echo; echo "== تم الانتهاء =="