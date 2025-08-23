// server.cjs — Unity Lab backend (CommonJS, Node >=20)
// - Proxies /generate-fast, /generate-quality, /result/:id to KIE (auto-probes multiple paths)
// - ElevenLabs: voices + TTS (stream + iPad test)
// - Diagnostics you can tap from iPad: /health, /api/health-eleven, /diag/upstream, /diag/upstream-post
// - No extra deps; uses global fetch

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const { Readable, pipeline } = require("stream");
const { promisify } = require("util");
const pipe = promisify(pipeline);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* ----------------------- ENV ----------------------- */
const PORT = process.env.PORT || 8080;

// KIE upstream
const KIE_BASE = (process.env.VEO_BACKEND_URL || process.env.KIE_API_PREFIX || "").replace(/\/$/, ""); // e.g. https://api.kie.ai/api/v1
const KIE_KEY = process.env.KIE_KEY || process.env.KIE_API_KEY || "";

// ElevenLabs
const ELEVEN_KEY =
  process.env.ELEVEN_LABS ||
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_LABS_API_KEY ||
  "";

/* -------------------- HELPERS ---------------------- */
function withTimeout(fn, ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return Promise.resolve(fn(ac.signal)).finally(() => clearTimeout(t));
}

function kieHeaders() {
  const h = { "Content-Type": "application/json" };
  if (KIE_KEY) {
    // Send both styles so we don’t guess which the upstream expects
    h["Authorization"] = `Bearer ${KIE_KEY}`;
    h["X-API-Key"] = KIE_KEY;
  }
  return h;
}

async function tryCandidates({ method, body, candidates }) {
  for (const rel of candidates) {
    const url = KIE_BASE + rel;
    try {
      const r = await withTimeout(
        (signal) =>
          fetch(url, {
            method,
            headers: kieHeaders(),
            body: body ? JSON.stringify(body) : undefined,
            signal
          }),
        30000
      );
      // If not 404/405, assume it’s the right path and return immediately
      if (![404, 405].includes(r.status)) {
        const text = await r.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
        return { url, status: r.status, ok: r.ok, data };
      }
    } catch (e) {
      // network/timeout — keep trying next candidate
    }
  }
  return { status: 404, ok: false, data: { success: false, error: "Upstream path not found (all candidates failed)" } };
}

/* -------------------- HEALTH ----------------------- */
app.get("/ping", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/health-eleven", (_req, res) =>
  res.json({ ok: true, elevenKeyPresent: !!ELEVEN_KEY, ts: new Date().toISOString() })
);

/* --------------- KIE DIAGNOSTICS (tap) ------------- */
// GET: /diag/upstream?path=/some/path
app.get("/diag/upstream", async (req, res) => {
  if (!KIE_BASE) return res.status(400).json({ error: "KIE_BASE missing (set VEO_BACKEND_URL or KIE_API_PREFIX)" });
  const rel = String(req.query.path || "/");
  const url = KIE_BASE + rel;
  try {
    const r = await withTimeout((signal) => fetch(url, { headers: kieHeaders(), signal }), 15000);
    const text = await r.text();
    res.json({ url, status: r.status, ok: r.ok, body: text.slice(0, 1500) });
  } catch (e) {
    res.status(502).json({ url, error: String(e?.message || e) });
  }
});

// POST: /diag/upstream-post?path=/some/path   (body forwarded)
app.post("/diag/upstream-post", async (req, res) => {
  if (!KIE_BASE) return res.status(400).json({ error: "KIE_BASE missing (set VEO_BACKEND_URL or KIE_API_PREFIX)" });
  const rel = String(req.query.path || "/");
  const url = KIE_BASE + rel;
  try {
    const r = await withTimeout(
      (signal) => fetch(url, { method: "POST", headers: kieHeaders(), body: JSON.stringify(req.body || {}), signal }),
      15000
    );
    const text = await r.text();
    res.json({ url, status: r.status, ok: r.ok, body: text.slice(0, 2000) });
  } catch (e) {
    res.status(502).json({ url, error: String(e?.message || e) });
  }
});

/* ------------- VEO PROXY (auto-probe KIE) ---------- */
// Frontend calls these. We try a set of likely KIE routes until one works.

app.post("/generate-fast", async (req, res) => {
  if (!KIE_BASE) return res.status(502).json({ success: false, error: "VEO_UPSTREAM missing (set VEO_BACKEND_URL)" });
  const candidates = [
    "/generate-fast",
    "/veo/generate-fast",
    "/video/generate-fast",
    "/veo3/generate-fast",
    "/veo/v1/generate-fast"
  ];
  const out = await tryCandidates({ method: "POST", body: req.body, candidates });
  return res.status(out.status).json(out.data);
});

app.post("/generate-quality", async (req, res) => {
  if (!KIE_BASE) return res.status(502).json({ success: false, error: "VEO_UPSTREAM missing (set VEO_BACKEND_URL)" });
  const candidates = [
    "/generate-quality",
    "/veo/generate-quality",
    "/video/generate-quality",
    "/veo3/generate-quality",
    "/veo/v1/generate-quality"
  ];
  const out = await tryCandidates({ method: "POST", body: req.body, candidates });
  return res.status(out.status).json(out.data);
});

app.get("/result/:jobId", async (req, res) => {
  if (!KIE_BASE) return res.status(502).json({ success: false, error: "VEO_UPSTREAM missing (set VEO_BACKEND_URL)" });
  const id = encodeURIComponent(req.params.jobId);
  const candidates = [`/result/${id}`, `/veo/result/${id}`, `/video/result/${id}`, `/veo3/result/${id}`, `/veo/v1/result/${id}`];
  const out = await tryCandidates({ method: "GET", body: null, candidates });
  return res.status(out.status).json(out.data);
});

/* --------------- ELEVENLABS ENDPOINTS --------------- */
// List voices
app.get("/api/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  try {
    const r = await withTimeout(
      (signal) => fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": ELEVEN_KEY }, signal }),
      15000
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(j);
    const voices = (j.voices || []).map((v) => ({ id: v.voice_id || v.id, name: v.name, category: v.category || "" }));
    res.json({ voices });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

// Stream TTS (preview)
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

    const r = await withTimeout(
      (signal) =>
        fetch(url, {
          method: "POST",
          headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify(payload),
          signal
        }),
      20000
    );

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: errText });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    const len = r.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    if (String(req.query.download || "") === "1")
      res.setHeader("Content-Disposition", 'attachment; filename="voiceover.mp3"');

    const nodeStream = Readable.fromWeb(r.body);
    await pipe(nodeStream, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e?.message || String(e) });
    else try {
      res.destroy(e);
    } catch {}
  }
});

// iPad test (GET → mp3 download)
app.get("/api/eleven/test-tts", async (req, res) => {
  try {
    if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
    const voiceId = String(req.query.voice_id || "21m00Tcm4TlvDq8ikWAM"); // Rachel
    const text = String(
      req.query.text || "Hello Marwan, your Unity Lab backend generated this voice successfully via the iPad test endpoint."
    );

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?optimize_streaming_latency=0`;
    const payload = {
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }
    };

    const r = await withTimeout(
      (signal) =>
        fetch(url, {
          method: "POST",
          headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify(payload),
          signal
        }),
      20000
    );

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: errText });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'attachment; filename="unitylab-test.mp3"');
    const nodeStream = Readable.fromWeb(r.body);
    await pipe(nodeStream, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e?.message || String(e) });
    else try {
      res.destroy(e);
    } catch {}
  }
});

/* -------------------- STATIC (optional) ------------- */
const STATIC_ROOT = path.join("/tmp", "public");
app.use(
  "/static",
  express.static(STATIC_ROOT, {
    setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
  })
);

/* --------------------- START ----------------------- */
app.listen(PORT, "0.0.0.0", () => console.log(`[OK] Listening on ${PORT}`));
