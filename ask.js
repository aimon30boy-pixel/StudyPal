// StudyPal AI endpoint (Vercel Edge Function).
// Forwards study questions to the Claude API with your secret key and streams the answer back as plain text.
//
// Environment variables (set them in Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  (required) your key from console.anthropic.com
//   ACCESS_CODE        (optional) if set, visitors must enter this class code before using the AI
//   DAILY_LIMIT        (optional) questions per visitor per day, default 60
//   MODEL              (optional) Claude model ID, default claude-haiku-5-5

export const config = { runtime: "edge" };

const MODEL = process.env.MODEL || "claude-haiku-5-5";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "60", 10);
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const MAX_TOKENS = 8000;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const SYSTEM = "You are StudyPal, a friendly study helper for high school students. Be accurate, encouraging and age-appropriate. Help with any school subject. Do not help with anything harmful, explicit, or inappropriate for students; kindly steer back to studying instead.";

// Best-effort per-visitor daily limit. It lives in each server instance's memory, so it resets when
// Vercel recycles the instance. Your monthly spend limit in the Anthropic Console is the hard stop.
const hits = new Map();
function overLimit(ip) {
  const key = ip + "|" + new Date().toISOString().slice(0, 10);
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 20000) hits.clear();
  return n > DAILY_LIMIT;
}

const json = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 30) return null;
  const out = [];
  let total = 0;
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
    const text = m.content.slice(0, 80000);
    if (!text.trim()) continue;
    total += text.length;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + text; // merge same-role turns
    else out.push({ role: m.role, content: text });
  }
  if (total > 200000) return "too_large";
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return json({ error: "server_config" }, 500);
  if (ACCESS_CODE && (req.headers.get("x-access-code") || "").trim() !== ACCESS_CODE) return json({ error: "code_required" }, 401);

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("x-real-ip") || "anon";
  if (overLimit(ip)) return json({ error: "daily_limit" }, 429);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const messages = cleanMessages(body && body.messages);
  if (messages === "too_large") return json({ error: "too_large" }, 413);
  if (!messages) return json({ error: "bad_request" }, 400);

  const images = Array.isArray(body.images) ? body.images.slice(0, 5) : [];
  for (const img of images) {
    if (!img || !IMAGE_TYPES.includes(img.media_type) || typeof img.data !== "string" || img.data.length > 7000000) return json({ error: "bad_image" }, 400);
  }
  if (images.length) {
    const last = messages[messages.length - 1];
    last.content = [
      ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } })),
      { type: "text", text: last.content }
    ];
  }

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM, stream: true, messages }),
      signal: req.signal
    });
  } catch {
    return json({ error: "upstream_error" }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    const status = upstream.status;
    if (status === 429 || status === 529) return json({ error: "busy" }, 503);
    if (status === 401 || status === 403) return json({ error: "server_config" }, 500);
    if (status === 413) return json({ error: "too_large" }, 413);
    return json({ error: "upstream_error" }, 502);
  }

  // Turn Claude's server-sent events into a plain stream of answer text.
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buffer = "";
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      const handleEvent = (line) => {
        if (!line.startsWith("data:")) return;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { return; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") controller.enqueue(enc.encode(ev.delta.text));
        else if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason === "refusal") controller.enqueue(enc.encode("\u0000ERR:refused"));
        else if (ev.type === "error") controller.enqueue(enc.encode("\u0000ERR:" + (ev.error && ev.error.type === "overloaded_error" ? "busy" : "upstream_error")));
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) { handleEvent(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); }
        }
        if (buffer) handleEvent(buffer);
      } catch {
        controller.enqueue(enc.encode("\u0000ERR:upstream_error"));
      } finally {
        controller.close();
      }
    },
    cancel() { try { upstream.body.cancel(); } catch {} }
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
