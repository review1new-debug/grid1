#!/usr/bin/env bash
# اختبار get_task و list_media عبر MCP — يستخدم أحدث مهمة دمج مكتملة من القاعدة
set -e
cd /home/z/my-project
MERGE_ID=$(node --env-file=.env -e "
const { createClient } = require('@libsql/client');
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
(async () => {
  const r = await db.execute({ sql: \"SELECT id FROM tasks WHERE type='merge' AND status='completed' ORDER BY created_at DESC LIMIT 1\" });
  process.stdout.write(String(r.rows[0].id));
})();
")
echo "أحدث مهمة دمج: $MERGE_ID"

mt() {
  curl -s -m 25 -X POST http://localhost:3000/mcp \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "$1" | python3 -c "
import sys, re, json
raw = sys.stdin.read()
for f in re.findall(r'data: (.*)', raw):
    d = json.loads(f)
    if 'result' in d:
        print(d['result']['content'][0]['text'][:400])
        print('-----')
"
}

echo "=== get_task لدمج مكتمل ==="
mt "{\"jsonrpc\":\"2.0\",\"id\":40,\"method\":\"tools/call\",\"params\":{\"name\":\"get_task\",\"arguments\":{\"task_id\":\"$MERGE_ID\"}}}"

echo "=== list_media merge فقط ==="
mt '{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"list_media","arguments":{"type":"merge","limit":3}}}'

echo "=== get_task غير موجود ==="
mt '{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"get_task","arguments":{"task_id":"no-such-task-xyz"}}}'
