// --- ElevenLabs TTS (streaming, no file writes) ---
const { Readable, pipeline } = require("stream");
const { promisify } = require("util");
const pipe = promisify(pipeline);

/**
 * POST /api/eleven/tts.stream
 * body: { voice_id, text, model_id?, params? }
 * Streams audio/mpeg back to the client. No disk I/O.
 * Optional query: ?download=1 to force attachment filename.
 */
app.post("/api/eleven/tts.stream", async (req, res) => {
  try {
    const ELEVEN_KEY = process.env.ELEVEN_LABS || process.env.ELEVENLABS_API_KEY || "";
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

    const r = await fetch(url, {
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

    // Forward headers and stream body
    res.setHeader("Content-Type", "audio/mpeg");
    const len = r.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    if (String(req.query.download || "") === "1") {
      res.setHeader("Content-Disposition", 'attachment; filename="voiceover.mp3"');
    }

    // Convert WHATWG ReadableStream -> Node stream and pipe to response
    const nodeStream = Readable.fromWeb(r.body);
    await pipe(nodeStream, res);
  } catch (e) {
    // If headers already sent during streaming, just destroy the socket
    if (!res.headersSent) {
      res.status(500).json({ error: String(e?.message || e) });
    } else {
      try { res.destroy(e); } catch {}
    }
  }
});
