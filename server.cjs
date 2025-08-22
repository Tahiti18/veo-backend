// server.cjs — stable baseline + ElevenLabs (voices + TTS stream + iPad test)
// Node >= 20, CommonJS. No file writes. No FFmpeg. Uses global fetch.

const express = require("express");
const cors = require("cors");
const { Readable, pipeline } = require("stream");
const { promisify } = require("util");
const pipe = promisify(pipeline);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- helpers ----------
const ELEVEN_KEY = process.env.ELEVEN_LABS || process.env.ELEVENLABS_API_KEY || "";

function withTimeout(fn, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return Promise.resolve(fn(ac.signal)).finally(() => clearTimeout(t));
}

// ---------- health ----------
app.get("/ping", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/api/health-eleven", (_req, res) => {
  res.json({ ok: true, elevenKeyPresent: !!ELEVEN_KEY, ts: new Date().toISOString() });
});

// ---------- ElevenLabs: voices (read-only) ----------
app.get("/api/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing (set ELEVEN_LABS or ELEVENLABS_API_KEY)" });
  try {
    const r = await withTimeout(
      (signal) =>
        fetch("https://api.elevenlabs.io/v1/voices", {
          headers: { "xi-api-key": ELEVEN_KEY },
          signal
        }),
      15000
    );
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(j);
    const voices = (j.voices || []).map((v) => ({
      id: v.voice_id || v.voiceId || v.id,
      name: v.name,
      category: v.category || ""
    }));
    res.json({ voices });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "Voices request timed out" : e?.message || String(e);
    res.status(502).json({ error: msg });
  }
});

// ---------- ElevenLabs: TTS (POST, streaming, no disk IO) ----------
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
          headers: {
            "xi-api-key": ELEVEN_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg"
          },
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
    if (String(req.query.download || "") === "1") {
      res.setHeader("Content-Disposition", 'attachment; filename="voiceover.mp3"');
    }

    // WHATWG -> Node stream and pipe out
    const nodeStream = Readable.fromWeb(r.body);
    await pipe(nodeStream, res);
  } catch (e) {
    if (!res.headersSent) {
      const msg = e?.name === "AbortError" ? "TTS request timed out" : e?.message || String(e);
      res.status(502).json({ error: msg });
    } else {
      try {
        res.destroy(e);
      } catch (_) {}
    }
  }
});

// ---------- ElevenLabs: iPad test endpoint (GET -> downloadable MP3) ----------
app.get("/api/eleven/test-tts", async (req, res) => {
  try {
    if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
    const voiceId = String(req.query.voice_id || "21m00Tcm4TlvDq8ikWAM"); // Rachel
    const text = String(
      req.query.text ||
        "Hello Marwan. Your Unity Lab backend just generated this voice successfully from the iPad test endpoint."
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
    const msg = e?.name === "AbortError" ? "Test TTS timed out" : e?.message || String(e);
    if (!res.headersSent) res.status(502).json({ error: msg });
    else {
      try {
        res.destroy(e);
      } catch (_) {}
    }
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`[OK] Listening on ${PORT}`));
