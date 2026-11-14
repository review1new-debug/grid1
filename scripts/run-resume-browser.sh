#!/usr/bin/env bash
# فحص واجهة حقيقي لزر «استكمال» عبر متصفح — يشغّل كل الخدمات داخل نفس الجلسة
set -u
cd /home/z/my-project
BASE="http://127.0.0.1:3100"
IMAGE_TASK="22222222-2222-4222-8222-222222222222"

cleanup() { pkill -f "next dev" 2>/dev/null; pkill -f "mock-resume-providers" 2>/dev/null; agent-browser close >/dev/null 2>&1; }
cleanup; sleep 1

node scripts/seed-resume-test.mjs > /dev/null
node scripts/mock-resume-providers.mjs > /tmp/mock.log 2>&1 &
sleep 1
TURSO_DATABASE_URL=file:/tmp/turso-resume-test.db TURSO_AUTH_TOKEN=local-test \
  COMETAPI_BASE=http://127.0.0.1:9901 MERGER_API_BASE=http://127.0.0.1:9902 \
  npx next dev -p 3100 > /tmp/next-dev.log 2>&1 &
for i in $(seq 1 40); do sleep 2; curl -s --max-time 5 "$BASE/api/health" 2>/dev/null | grep -q turso-connected && break; done
curl -s "$BASE/api/health" | grep -q turso-connected || { echo "DEV FAILED"; cleanup; exit 1; }
echo "== services ready =="

agent-browser open "$BASE" >/dev/null 2>&1
agent-browser wait --load networkidle >/dev/null 2>&1
sleep 3

echo "== عدد أزرار الاستكمال الظاهرة =="
agent-browser eval "Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('استكمال المهمة')).length"

echo "== لقطة لأزرار الصفحة =="
agent-browser snapshot -i 2>/dev/null | rg -N "استكمال|المهام" | head -10

echo "== الضغط على زر استكمال مهمة الصورة =="
agent-browser find text "استكمال المهمة" click >/dev/null 2>&1 || agent-browser eval "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('استكمال المهمة'))?.click()" >/dev/null
sleep 8

echo "== حالة الشريط بعد الاستكمال =="
agent-browser eval "
  const btn = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.includes('استكمال المهمة')).length;
  const done = Array.from(document.querySelectorAll('a')).filter(a => a.textContent.includes('فتح النتيجة')).length;
  const badges = Array.from(document.querySelectorAll('span')).map(s => s.textContent).filter(t => t === 'مكتملة' || t === 'فاشلة');
  JSON.stringify({ resumeButtonsLeft: btn, resultLinks: done, badges: badges.slice(0, 6) })
"

echo "== toast آخر =="
agent-browser eval "Array.from(document.querySelectorAll('[role=\\\"status\\\"], .toast')).map(t => t.textContent).join(' | ').slice(0, 160)" 

agent-browser screenshot --full /home/z/my-project/download/resume-button-proof.png >/dev/null 2>&1
ls -la /home/z/my-project/download/resume-button-proof.png 2>/dev/null | awk '{print "screenshot:", $9, $5"bytes"}'

cleanup
echo "== done =="