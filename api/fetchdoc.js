// StudyPal "Homework from a link" endpoint (Vercel Edge Function).
// Opens a public link (Google Docs, Slides, Sheets, Drive files, PDFs, images or web pages) and returns its text,
// or the PDF / image itself, so StudyPal can read the homework. It does not call the AI and costs nothing extra.
//
// Uses the same sign-in settings as api/ask.js. Optional:
//   LINK_DAILY_LIMIT  links per person per day, default 40

export const config = { runtime: "edge" };

const DAILY_LIMIT = parseInt(process.env.LINK_DAILY_LIMIT || "40", 10);
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const MAX_BYTES = 8 * 1024 * 1024;

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
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function safeUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return null;
  if (/^(\d+\.){3}\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
  }
  if (host.includes(":")) return null; // raw IPv6
  return u;
}
// Turn Google sharing links into direct export links.
function exportUrl(u) {
  const host = u.hostname; const path = u.pathname;
  let m;
  if (host === "docs.google.com" && (m = path.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { url: `https://docs.google.com/document/d/${m[1]}/export?format=txt`, kind: "Google Doc" };
  if (host === "docs.google.com" && (m = path.match(/^\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)/))) return { url: `https://docs.google.com/presentation/d/${m[1]}/export/txt`, kind: "Google Slides" };
  if (host === "docs.google.com" && (m = path.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/))) {
    const gid = (u.hash.match(/gid=(\d+)/) || u.search.match(/gid=(\d+)/) || [])[1];
    return { url: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? "&gid=" + gid : ""}`, kind: "Google Sheet" };
  }
  if (host === "drive.google.com") {
    const id = (path.match(/\/file\/(?:u\/\d+\/)?d\/([\w-]+)/) || [])[1] || u.searchParams.get("id");
    if (id) return { url: `https://drive.google.com/uc?export=download&id=${id}`, kind: "Drive file" };
  }
  return { url: u.toString(), kind: "" };
}
function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}
function toBase64(buf) {
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const titleOf = (html) => { const m = html.match(/<title[^>]*>([^<]*)<\/title>/i); return m ? htmlToText(m[1]).slice(0, 120) : ""; };

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let uid = null;
  if (LOGIN_ON) { uid = await signedInUser(req); if (!uid) return json({ error: "login_required" }, 401); }
  else if (ACCESS_CODE && (req.headers.get("x-access-code") || "").trim() !== ACCESS_CODE) return json({ error: "code_required" }, 401);
  const who = uid || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
  if (overLimit(who)) return json({ error: "daily_limit" }, 429);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const u = safeUrl(body && body.url);
  if (!u) return json({ error: "hw_badlink" }, 400);
  if (u.hostname === "classroom.google.com") return json({ error: "hw_classroom" }, 400);
  const { url, kind } = exportUrl(u);

  let r;
  try {
    r = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; StudyPal/1.0)", accept: "text/html,text/plain,application/pdf,image/*,*/*;q=0.5" }, signal: AbortSignal.timeout(20000) });
  } catch { return json({ error: "hw_fetch_failed" }, 502); }
  const finalHost = (() => { try { return new URL(r.url).hostname; } catch { return ""; } })();
  if (finalHost === "accounts.google.com" || r.status === 401 || r.status === 403) return json({ error: "hw_not_shared" }, 403);
  if (!r.ok) return json({ error: r.status === 404 ? "hw_fetch_failed" : "hw_fetch_failed" }, 502);
  if (Number(r.headers.get("content-length") || 0) > MAX_BYTES) return json({ error: "hw_too_big" }, 413);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return json({ error: "hw_too_big" }, 413);
  const type = (r.headers.get("content-type") || "").toLowerCase();
  const name = ((r.headers.get("content-disposition") || "").match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1];
  const title = name ? decodeURIComponent(name).replace(/\.[^.]+$/, "") : "";

  if (type.includes("application/pdf") || /\.pdf$/i.test(name || "")) return json({ pdf: toBase64(buf), title });
  if (type.startsWith("image/")) {
    const t = type.split(";")[0];
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(t)) return json({ error: "hw_unsupported" }, 415);
    return json({ image: toBase64(buf), type: t, title });
  }
  const raw = new TextDecoder().decode(buf);
  if (type.includes("text/html") || /^\s*<(!doctype|html)/i.test(raw)) {
    if (kind === "Drive file") return json({ error: "hw_unsupported" }, 415); // Drive virus-scan page or non-downloadable file
    const text = htmlToText(raw);
    if (text.length < 20) return json({ error: "hw_empty" }, 422);
    return json({ text: text.slice(0, 60000), title: titleOf(raw) || title });
  }
  if (type.startsWith("text/") || type.includes("csv") || type.includes("json") || kind) {
    const text = raw.replace(/^﻿/, "").trim();
    if (text.length < 5) return json({ error: "hw_empty" }, 422);
    return json({ text: text.slice(0, 60000), title: title || kind });
  }
  return json({ error: "hw_unsupported" }, 415);
}
