// server.cjs — enhanced baseline + ElevenLabs (voices cache, retries, TTS stream, iPad test)
// Node >= 18 (global fetch). CommonJS.

const express = require("express");
const cors = require("cors");
const { Readable, pipeline } = require("stream");
const { promisify } = require("util");
const crypto = require("crypto");

const pipe = promisify(pipeline);
const app = express();

// ---------- config ----------
const PORT = process.env.PORT || 8080;
const ORIGIN = process.env.CORS_ORIGIN || "*";
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 0); // 0 = off
const RATE_WINDOW_MS = 60_000;

const ELEVEN_KEY =
  process.env.ELEVEN_LABS_API_KEY ||
  process.env.ELEVENLABS_API_KEY   ||
  process.env.ELEVEN_LABS          ||
  "";

// ---------- middleware ----------
app.use(cors({ origin: ORIGIN, methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "2mb" }));

// Security headers (simple, no extra deps)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-DNS-Prefetch-Control", "off");
  next();
});

// Request ID
app.use((req, res, next) => {
  const rid =
    req.headers["x-request-id"] ||
    crypto.randomUUID?.() ||
    Math.random().toString(36).slice(2);
  req.id = String(rid);
  res.setHeader("X-Request-ID", req.id);
  next();
});

// OPTIONS handler (iPad-friendly)
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  res.status(204).end();
});

// Rate limit (in-memory, per IP)
const hits = new Map();
app.use((req, res, next) => {
  if (!RATE_LIMIT_MAX || req.method === "OPTIONS") return next();
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.socket.remoteAddress || "ip";
  const now = Date.now();
  const bucket = hits.get(ip) || { count: 0, reset: now + RATE_WINDOW_MS };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + RATE_WINDOW_MS;
  }
  bucket.count += 1;
  hits.set(ip, bucket);
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_MAX);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_LIMIT_MAX - bucket.count));
  res.setHeader("X-RateLimit-Reset", Math.floor(bucket.reset / 1000));
  if (bucket.count > RATE_LIMIT_MAX) return res.status(429).json({ error: "rate_limited" });
  next();
});

// ---------- helpers ----------
function withTimeout(fn, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return Promise.resolve(fn(ac.signal))
    .finally(() => clearTimeout(t));
}

// minimal retry on 5xx/timeout
async function fetchWithRetry(url, opts, { retries = 2, baseDelay = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await withTimeout((signal) => fetch(url, { ...opts, signal }), 20000);
      if (r.ok) return r;
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
      return r; // 4xx: don't retry
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      await new Promise((res) => setTimeout(res, baseDelay * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

// ---------- health/readiness ----------
app.get("/ping", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/version", (_req, res) => res.json({ version: "1.0.0", env: { elevenKeyPresent: !!ELEVEN_KEY } }));
app.get("/api/health-eleven", (_req, res) => {
  res.json({ ok: true, elevenKeyPresent: !!ELEVEN_KEY, ts: new Date().toISOString() });
});

// ---------- ElevenLabs: voices (cached 10 min) ----------
let voicesCache = { at: 0, data: [] };
const VOICES_TTL_MS = 10 * 60 * 1000;

app.get("/api/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing (set ELEVEN_LABS_API_KEY)" });
  try {
    const now = Date.now();
    if (voicesCache.data.length && now - voicesCache.at < VOICES_TTL_MS) {
      return res.json({ voices: voicesCache.data, cached: true });
    }

    const r = await fetchWithRetry("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVEN_KEY, "Accept": "application/json" }
    });

    if (!r.ok) {
      const err = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "voices fetch failed", detail: err });
    }

    const j = await r.json().catch(() => ({}));
    const voices = (j.voices || []).map((v) => ({
      id: v.voice_id || v.voiceId || v.id,
      name: v.name,
      category: v.category || ""
    }));

    voicesCache = { at: now, data: voices };
    res.json({ voices, cached: false });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Voices request timed out" : e?.message || String(e);
    res.status(502).json({ error: msg });
  }
});

// ---------- ElevenLabs: TTS (POST, streaming) ----------
app.post("/api/eleven/tts.stream", async (req, res) => {
  try {
    if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
    const { voice_id, text, model_id, params } = req.body || {};
    if (!voice_id || !text) return res.status(400).json({ error: "voice_id and text required" });

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}?optimize_streaming_latency=0`;
    const payload = {
      text,
      model_id: model_id || "eleven_multilingual_v2",
      voice_settings: {
        stability: params?.stability ?? 0.45,
        similarity_boost: params?.similarity_boost ?? 0.8,
        style: params?.style ?? 0.0,
        use_speaker_boost: params?.use_speaker_boost ?? true
      }
    };

    const r = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: errText });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    const len = r.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    if (String(req.query.download || "") === "1") {
      res.setHeader("Content-Disposition", 'attachment; filename="voiceover.mp3"');
    }

    const nodeStream = Readable.fromWeb(r.body);
    await pipe(nodeStream, res);
  } catch (e) {
    if (!res.headersSent) {
      const msg = e?.name === "AbortError" ? "TTS request timed out" : e?.message || String(e);
      res.status(502).json({ error: msg });
    } else {
      try { res.destroy(e); } catch {}
    }
  }
});

// ---------- ElevenLabs: iPad test (GET -> MP3 download) ----------
app.get("/api/eleven/test-tts", async (req, res) => {
  try {
    if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
    const voiceId = String(req.query.voice_id || "21m00Tcm4TlvDq8ikWAM"); // Rachel
    const text = String(req.query.text || "Hello Marwan. Backend iPad test endpoint is working.");

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?optimize_streaming_latency=0`;
    const payload = {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }
    };

    const r = await fetchWithRetry(url, {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", "Accept": "audio/mpeg" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: errText });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="unitylab-test.mp3"');
    const nodeStream = Readable.fromWeb(r.body);
    await pipe(nodeStream, res);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Test TTS timed out" : e?.message || String(e);
    if (!res.headersSent) res.status(502).json({ error: msg });
    else { try { res.destroy(e); } catch {} }
  }
});

// ---------- start & graceful shutdown ----------
const server = app.listen(PORT, "0.0.0.0", () => console.log(`[OK] Listening on ${PORT}`));
const shutdown = () => {
  console.log("[INFO] Shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
