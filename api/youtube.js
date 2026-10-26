// StudyPal YouTube transcript endpoint (Vercel Edge Function).
// Gets a video's transcript from just its link, using Supadata (https://supadata.ai).
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   SUPADATA_API_KEY  (required for link-only summaries) free key from dash.supadata.ai
//   ACCESS_CODE       (optional) same class code used by the AI
//   YT_DAILY_LIMIT    (optional) videos per visitor per day, default 15

export const config = { runtime: "edge" };

const KEY = process.env.SUPADATA_API_KEY || "";
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const DAILY = parseInt(process.env.YT_DAILY_LIMIT || "15", 10);
const YT_RE = /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?(.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]{6,}/i;
const MAX_CHARS = 80000;

const hits = new Map();
function overLimit(ip) {
  const key = ip + "|" + new Date().toISOString().slice(0, 10);
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 20000) hits.clear();
  return n > DAILY;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asText = (content) => Array.isArray(content) ? content.map((s) => s && s.text ? s.text : "").join(" ") : String(content || "");

async function videoInfo(url) {
  try {
    const r = await fetch("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url));
    if (!r.ok) return {};
    const j = await r.json();
    return { title: j.title || "", author: j.author_name || "" };
  } catch { return {}; }
}
async function pollJob(jobId, tries) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch("https://api.supadata.ai/v1/transcript/" + encodeURIComponent(jobId), { headers: { "x-api-key": KEY } });
    if (!r.ok) return { error: "upstream_error" };
    const j = await r.json();
    if (j.status === "completed") return { text: asText(j.content), lang: j.lang };
    if (j.status === "failed") return { error: "no_transcript" };
    await sleep(3500);
  }
  return { pending: true };
}

export default async function handler(req) {
  if (ACCESS_CODE && (req.headers.get("x-access-code") || "").trim() !== ACCESS_CODE) return json({ error: "code_required" }, 401);
  if (!KEY) return json({ error: "not_configured" }, 501);

  // Follow-up check on a long transcription job
  if (req.method === "GET") {
    const job = new URL(req.url).searchParams.get("job");
    if (!job) return json({ error: "bad_request" }, 400);
    const r = await pollJob(job, 1);
    if (r.pending) return json({ pending: true, jobId: job }, 202);
    if (r.error) return json({ error: r.error }, r.error === "no_transcript" ? 422 : 502);
    return json({ text: r.text.slice(0, MAX_CHARS), lang: r.lang });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "anon";
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const url = String((body && body.url) || "").trim();
  if (!YT_RE.test(url)) return json({ error: "bad_link" }, 400);
  if (overLimit(ip)) return json({ error: "daily_limit" }, 429);

  const [info, r] = await Promise.all([
    videoInfo(url),
    fetch("https://api.supadata.ai/v1/transcript?text=true&mode=auto&url=" + encodeURIComponent(url), { headers: { "x-api-key": KEY } }).catch(() => null)
  ]);
  if (!r) return json({ error: "upstream_error", ...info }, 502);
  if (r.status === 202) {
    let j = {}; try { j = await r.json(); } catch {}
    if (!j.jobId) return json({ error: "upstream_error", ...info }, 502);
    const p = await pollJob(j.jobId, 5);
    if (p.pending) return json({ pending: true, jobId: j.jobId, ...info }, 202);
    if (p.error) return json({ error: p.error, ...info }, p.error === "no_transcript" ? 422 : 502);
    return json({ ...info, text: p.text.slice(0, MAX_CHARS), lang: p.lang });
  }
  if (!r.ok) {
    const map = { 400: ["bad_link", 400], 401: ["not_configured", 501], 403: ["not_configured", 501], 404: ["no_transcript", 422], 206: ["no_transcript", 422], 429: ["busy", 503] };
    const [code, status] = map[r.status] || ["upstream_error", 502];
    return json({ error: code, ...info }, status);
  }
  let j = {};
  try { j = await r.json(); } catch { return json({ error: "upstream_error", ...info }, 502); }
  const text = asText(j.content).trim();
  if (!text) return json({ error: "no_transcript", ...info }, 422);
  return json({ ...info, text: text.slice(0, MAX_CHARS), lang: j.lang });
}
