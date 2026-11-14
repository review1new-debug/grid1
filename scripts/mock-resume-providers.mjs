// سيرفرات وهمية لاختبار زر «استكمال» محليًا:
// 9901 = مزود CometAPI وهمي (صور متزامنة + فيديو create/check)
// 9902 = خدمة الدمج وهمية (jobs/process)
import http from "node:http";

const calls = []; // سجل الاستدعاءات: { method, path, auth }
const videoChecks = new Map();

function makeServer(name, port, handler) {
  http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        handler(req, res, new URL(req.url, "http://x"), body);
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  }).listen(port, "127.0.0.1", () => console.log(`${name} mock on ${port}`));
}

function json(res, obj, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// ————— مزود CometAPI وهمي —————
makeServer("COMETAPI", 9901, (req, res, url, _body) => {
  const auth = String(req.headers["authorization"] || "").replace("Bearer ", "");
  calls.push({ at: new Date().toISOString(), method: req.method, path: url.pathname, auth });

  if (url.pathname === "/_log") return json(res, calls);
  if (url.pathname === "/v1/videos" && req.method === "POST") return json(res, { task_id: "mock-v1", status: "queued" });

  const m = url.pathname.match(/^\/v1\/videos\/([^/]+)$/);
  if (m && req.method === "GET") {
    const n = (videoChecks.get(m[1]) || 0) + 1;
    videoChecks.set(m[1], n);
    if (n === 1) return json(res, { status: "in_progress", progress: 40 });
    return json(res, { status: "completed", progress: 100, video_url: "https://example.com/mock-video.mp4" });
  }
  if (url.pathname === "/v1/images/generations" && req.method === "POST")
    return json(res, { data: [{ url: "https://example.com/mock-image.png" }] });

  json(res, { error: { message: "mock not found: " + url.pathname } }, 404);
});

// ————— خدمة الدمج وهمية —————
makeServer("MERGER", 9902, (req, res, url, _body) => {
  if (url.pathname === "/api/jobs" && req.method === "POST") return json(res, { jobId: "mock-job-1", status: "queued" });
  if (/^\/api\/jobs\/[^/]+\/process$/.test(url.pathname) && req.method === "POST") {
    // الدمج يستغرق وقتًا قصيرًا ثم ينجح
    setTimeout(() => json(res, { status: "done", videoUrl: "https://example.com/mock-merged.mp4" }), 1500);
    return;
  }
  if (/^\/api\/jobs\/[^/]+$/.test(url.pathname) && req.method === "GET")
    return json(res, { status: "done", progress: 100, videoUrl: "https://example.com/mock-merged.mp4" });
  json(res, { error: "mock not found" }, 404);
});
