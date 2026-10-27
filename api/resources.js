// StudyPal "Find resources" endpoint (Vercel Edge Function).
// Uses Claude with web search to find real, free videos and articles that teach what a student asks for.
//
// Uses the same environment variables as api/ask.js, plus:
//   RES_DAILY_LIMIT  (optional) resource searches per person per day, default 15
//   RES_MODEL        (optional) model for resource searches, default MODEL (claude-haiku-5-5)
// Cost: about 1 to 2 cents per search (Claude's web search is $10 per 1,000 searches, plus a little for tokens).

export const config = { runtime: "edge" };

const MODEL = process.env.RES_MODEL || process.env.MODEL || "claude-haiku-5-5";
const FALLBACK_MODEL = "claude-sonnet-5-5"; // used only if the main model can't use web search
const DAILY_LIMIT = parseInt(process.env.RES_DAILY_LIMIT || "15", 10);
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const BLOCKED = ["chegg.com", "coursehero.com", "brainly.com", "quizlet.com", "studocu.com", "reddit.com", "tiktok.com", "pinterest.com"];

const SYSTEM = "You are StudyPal, a friendly study helper for students. You find free, trustworthy, age-appropriate learning resources. Never suggest anything explicit, harmful, or meant for cheating (answer-key or homework-answer sites).";

const hits = new Map();
function overLimit(id) {
  const key = id + "|" + new Date().toISOString().slice(0, 10);
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 20000) hits.clear();
  return n > DAILY_LIMIT;
}

const SB_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
const SB_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();
const LOGIN_ON = !!(SB_URL && SB_KEY) && process.env.REQUIRE_LOGIN !== "false";
const tokenCache = new Map();
async function signedInUser(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const hit = tokenCache.get(m[1]);
  if (hit && hit.until > Date.now()) return hit.id;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, authorization: "Bearer " + m[1] } });
    if (!r.ok) return null;
    const u = await r.json();
    if (!u || !u.id) return null;
    if (tokenCache.size > 5000) tokenCache.clear();
    tokenCache.set(m[1], { id: u.id, until: Date.now() + 5 * 60 * 1000 });
    return u.id;
  } catch { return null; }
}

const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const ytId = (u) => { const m = String(u).match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/); return m ? m[1] : null; };
const norm = (u) => { const y = ytId(u); if (y) return "yt:" + y; try { const x = new URL(u); return (x.hostname.replace(/^www\.|^m\./, "") + x.pathname.replace(/\/$/, "") + (x.hostname.includes("youtube") ? x.search : "")).toLowerCase(); } catch { return ""; } };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

function prompt(need, level) {
  return `A student needs help learning this: "${need}"
About the student: ${level || "a high school student"}.

Use web search to find the best FREE resources that teach this at the student's level:
- 3 or 4 videos (YouTube or Khan Academy videos from clear, trusted educational channels)
- 3 or 4 articles or lesson pages (trusted free sites like Khan Academy, CK-12, OpenStax, LibreTexts, BBC Bitesize, Britannica, Math is Fun, Purplemath, Paul's Online Notes, .edu or .gov pages)
Prefer pages that explain step by step, not answer keys. Skip paywalled pages.

When you are done searching, reply with ONLY this JSON (no other text) and use the exact URLs from your search results:
{"videos": [{"title": "...", "url": "...", "source": "channel or site name", "why": "one sentence on how it helps with what they asked"}],
 "articles": [{"title": "...", "url": "...", "source": "site name", "why": "one sentence"}],
 "tip": "one short study tip for this topic"}
If the request is not appropriate for students, reply with ONLY {"error": "refused", "message": "a short, kind reason"}.`;
}

async function callClaude(key, model, messages, signal) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model, max_tokens: 3000, system: SYSTEM, messages,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4, blocked_domains: BLOCKED }]
    }),
    signal
  });
  if (!r.ok) {
    const e = new Error("upstream"); e.code = r.status === 429 || r.status === 529 ? "busy" : r.status === 401 || r.status === 403 ? "server_config" : r.status === 400 ? "bad_request_upstream" : "upstream_error";
    let detail = ""; try { detail = await r.text(); } catch {}
    console.log("resources upstream error", r.status, detail.slice(0, 500));
    throw e;
  }
  return r.json();
}

async function findResources(key, need, level, signal) {
  const messages = [{ role: "user", content: prompt(need, level) }];
  let data; let model = MODEL;
  for (let round = 0; round < 3; round++) {
    try { data = await callClaude(key, model, messages, signal); }
    catch (e) {
      if (e.code === "bad_request_upstream" && model !== FALLBACK_MODEL && round === 0) { model = FALLBACK_MODEL; data = await callClaude(key, model, messages, signal); }
      else throw e;
    }
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }
  // every URL the search actually returned
  const found = new Map();
  for (const m of [...messages.filter((x) => x.role === "assistant").flatMap((x) => x.content), ...(data.content || [])]) {
    if (m && m.type === "web_search_tool_result" && Array.isArray(m.content)) {
      for (const r of m.content) if (r && r.url) found.set(norm(r.url), { url: r.url, title: r.title || "" });
    }
    if (m && m.type === "text" && Array.isArray(m.citations)) for (const c of m.citations) if (c && c.url) found.set(norm(c.url), { url: c.url, title: c.title || "" });
  }
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  let j = null;
  try { j = JSON.parse(text.slice(start, end + 1)); } catch { j = null; }
  if (j && j.error) return { error: "res_refused", message: String(j.message || "That's not something StudyPal can look up.") };
  if (!j) return { error: "res_empty" };
  // keep only links that really came from the search, so nothing is made up
  const keep = (arr) => (Array.isArray(arr) ? arr : []).map((x) => {
    if (!x || typeof x.url !== "string") return null;
    const hit = found.get(norm(x.url));
    if (!hit) return null;
    if (BLOCKED.some((d) => hostOf(hit.url).endsWith(d))) return null;
    return { title: String(x.title || hit.title || hit.url).slice(0, 140), url: hit.url, source: String(x.source || hostOf(hit.url)).slice(0, 60), why: String(x.why || "").slice(0, 300) };
  }).filter(Boolean).slice(0, 5);
  const out = { videos: keep(j.videos), articles: keep(j.articles), tip: String(j.tip || "").slice(0, 300) };
  if (!out.videos.length && !out.articles.length) return { error: "res_empty" };
  return out;
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: "server_config" }, 500);
  let uid = null;
  if (LOGIN_ON) { uid = await signedInUser(req); if (!uid) return json({ error: "login_required" }, 401); }
  else if (ACCESS_CODE && (req.headers.get("x-access-code") || "").trim() !== ACCESS_CODE) return json({ error: "code_required" }, 401);
  const who = uid || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
  if (overLimit(who)) return json({ error: "res_limit" }, 429);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const need = String((body && body.need) || "").trim().slice(0, 500);
  const level = String((body && body.level) || "").trim().slice(0, 200);
  if (need.length < 2) return json({ error: "bad_request" }, 400);

  // Web searches can take 20-40 seconds, so stream spaces while we wait to keep the connection open,
  // then send the JSON answer at the end.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => { try { controller.enqueue(enc.encode(" ")); } catch {} }, 4000);
      try {
        const out = await findResources(key, need, level, req.signal);
        controller.enqueue(enc.encode(JSON.stringify(out)));
      } catch (e) {
        controller.enqueue(enc.encode(JSON.stringify({ error: (e && e.code) || "upstream_error" })));
      } finally {
        clearInterval(ping);
        controller.close();
      }
    }
  });
  return new Response(stream, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
