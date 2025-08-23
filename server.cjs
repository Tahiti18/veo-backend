// server.cjs — Unity Lab backend (CommonJS, Node >=20)
// Smart-proxy for generate/result + ElevenLabs + diag + optional mux

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const { Readable, pipeline } = require("stream");
const { promisify } = require("util");
const pipe = promisify(pipeline);

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "2mb" }));

// ---------- ENV ----------
const PORT = process.env.PORT || 8080;

// ElevenLabs API key
const ELEVEN_KEY = process.env.ELEVEN_LABS || "";

// KIE.ai configuration (fixed to use KIE_API_PREFIX)
const VEO_UPSTREAM = process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1";
const KIE_KEY = process.env.KIE_KEY || "";

// Model defaults
const VEO_MODEL_FAST = process.env.VEO_MODEL_FAST || "V3_5";
const VEO_MODEL_QUALITY = process.env.VEO_MODEL_QUALITY || "V4_5PLUS";

// Mux options
const ENABLE_MUX = process.env.ENABLE_MUX === "1";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// Writable locations on Railway
const TMP_ROOT = process.env.RUNTIME_TMP || "/tmp";
const STATIC_ROOT = path.join(TMP_ROOT, "public");
const TTS_DIR = path.join(STATIC_ROOT, "tts");
const MUX_DIR = path.join(STATIC_ROOT, "mux");

// Ensure dirs exist
(async () => { 
  try { 
    await fs.mkdir(TTS_DIR, { recursive: true }); 
    await fs.mkdir(MUX_DIR, { recursive: true }); 
  } catch (_) {} 
})();

// ---------- Helpers ----------
function withTimeout(fn, ms = 120000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return Promise.resolve(fn(ac.signal)).finally(() => clearTimeout(t));
}

const apiErr = (res, status, msg, extra) => res.status(status).json({ 
  success: false, 
  error: msg, 
  ...(extra || {}) 
});

function buildUpstreamHeaders() {
  const h = { "Content-Type": "application/json" };
  if (KIE_KEY) {
    h["Authorization"] = `Bearer ${KIE_KEY}`;
    h["x-api-key"] = KIE_KEY;
  }
  return h;
}

function joinUrl(base, p) { 
  return base + (p.startsWith("/") ? p : `/${p}`); 
}

// ---------- Diagnostics ----------
app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    healthPath: "/health",
    diag: {
      elevenKeyPresent: !!ELEVEN_KEY,
      upstreamSet: !!VEO_UPSTREAM,
      upstream: VEO_UPSTREAM || null,
      kieKeyPresent: !!KIE_KEY,
      enableMux: ENABLE_MUX,
      models: {
        fast: VEO_MODEL_FAST,
        quality: VEO_MODEL_QUALITY
      }
    }
  });
});

// ---------- Health ----------
app.get("/ping", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---------- Video Generation Routes ----------
app.post("/generate-fast", async (req, res) => {
  if (!VEO_UPSTREAM || !KIE_KEY) {
    return apiErr(res, 502, "KIE.ai configuration missing");
  }

  try {
    const body = {
      ...req.body,
      model: VEO_MODEL_FAST
    };

    const response = await withTimeout(signal => fetch(`${VEO_UPSTREAM}/generate`, {
      method: "POST",
      headers: buildUpstreamHeaders(),
      body: JSON.stringify(body),
      signal
    }), 25000);

    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!response.ok) {
      return res.status(response.status).send(json || text);
    }

    res.status(response.status).send(json || text);
  } catch (e) {
    return apiErr(res, 502, "KIE.ai request failed", { detail: e.message });
  }
});

app.post("/generate-quality", async (req, res) => {
  if (!VEO_UPSTREAM || !KIE_KEY) {
    return apiErr(res, 502, "KIE.ai configuration missing");
  }

  try {
    const body = {
      ...req.body,
      model: VEO_MODEL_QUALITY
    };

    const response = await withTimeout(signal => fetch(`${VEO_UPSTREAM}/generate`, {
      method: "POST",
      headers: buildUpstreamHeaders(),
      body: JSON.stringify(body),
      signal
    }), 25000);

    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!response.ok) {
      return res.status(response.status).send(json || text);
    }

    res.status(response.status).send(json || text);
  } catch (e) {
    return apiErr(res, 502, "KIE.ai request failed", { detail: e.message });
  }
});

app.get("/result/:jobId", async (req, res) => {
  if (!VEO_UPSTREAM || !KIE_KEY) {
    return apiErr(res, 502, "KIE.ai configuration missing");
  }

  try {
    const id = encodeURIComponent(req.params.jobId);
    const response = await withTimeout(signal => fetch(`${VEO_UPSTREAM}/result/${id}`, {
      method: "GET",
      headers: buildUpstreamHeaders(),
      signal
    }), 20000);

    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!response.ok) {
      return res.status(response.status).send(json || text);
    }

    res.status(response.status).send(json || text);
  } catch (e) {
    return apiErr(res, 502, "KIE.ai result request failed", { detail: e.message });
  }
});

// ---------- ElevenLabs Routes ----------
app.get("/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  
  try {
    const r = await withTimeout(signal => fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVEN_KEY },
      signal
    }), 15000);
    
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json(j);
    
    const voices = (j.voices || []).map(v => ({
      id: v.voice_id || v.id,
      name: v.name,
      category: v.category || ""
    }));
    
    res.json({ voices });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

app.post("/eleven/tts", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  
  const { voice_id, text, model_id } = req.body || {};
  if (!voice_id || !text) return res.status(400).json({ error: "voice_id and text required" });

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}`;
    const payload = {
      text,
      model_id: model_id || "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const r = await withTimeout(signal => fetch(url, {
      method: "POST",
      headers: { 
        "xi-api-key": ELEVEN_KEY, 
        "Content-Type": "application/json", 
        "Accept": "audio/mpeg" 
      },
      body: JSON.stringify(payload),
      signal
    }), 20000);

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: t });
    }

    const buf = Buffer.from(await r.arrayBuffer());
    const fname = `tts_${Date.now()}_${crypto.randomBytes(5).toString("hex")}.mp3`;
    await fs.writeFile(path.join(TTS_DIR, fname), buf);
    
    res.json({ audio_url: `/static/tts/${fname}`, bytes: buf.length });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

app.post("/mux", async (req, res) => {
  if (!ENABLE_MUX) {
    return res.status(403).json({ 
      error: "Mux disabled. Set ENABLE_MUX=1 and ensure ffmpeg is installed." 
    });
  }

  const { video_url, audio_url } = req.body || {};
  if (!video_url || !audio_url) {
    return res.status(400).json({ error: "video_url and audio_url required" });
  }

  const vPath = path.join(TMP_ROOT, `v_${Date.now()}.mp4`);
  const aPath = path.join(TMP_ROOT, `a_${Date.now()}.mp3`);
  const outPath = path.join(MUX_DIR, `out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);

  try {
    // Download files
    const dl = async (u, fp) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Download failed: ${u} -> ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(fp, b);
    };

    await dl(video_url, vPath);
    await dl(audio_url, aPath);

    // Run FFmpeg
    const { spawn } = require("child_process");
    const args = ["-y", "-i", vPath, "-i", aPath, "-c:v", "copy", "-c:a", "aac", "-shortest", outPath];
    const proc = spawn(FFMPEG, args);

    proc.on("error", err => {
      res.status(500).json({ error: "FFmpeg spawn failed", detail: String(err) });
    });

    proc.on("close", async (code) => {
      try { 
        await fs.rm(vPath, { force: true }); 
        await fs.rm(aPath, { force: true }); 
      } catch {}
      
      if (code !== 0) {
        return res.status(500).json({ error: `FFmpeg exit ${code}` });
      }
      
      res.json({ merged_url: `/static/mux/${path.basename(outPath)}` });
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Alternative /api routes for compatibility ----------
app.get("/api/eleven/voices", async (req, res) => {
  return app._router.handle({ ...req, url: "/eleven/voices" }, res);
});

app.post("/api/eleven/tts", async (req, res) => {
  return app._router.handle({ ...req, url: "/eleven/tts" }, res);
});

app.post("/api/mux", async (req, res) => {
  return app._router.handle({ ...req, url: "/mux" }, res);
});

// ---------- Static files ----------
app.use("/static", express.static(STATIC_ROOT, {
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
}));

// ---------- Start server ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[OK] Server listening on port ${PORT}`);
  console.log(`[CONFIG] KIE Upstream: ${VEO_UPSTREAM}`);
  console.log(`[CONFIG] KIE Key Present: ${!!KIE_KEY}`);
  console.log(`[CONFIG] ElevenLabs Key Present: ${!!ELEVEN_KEY}`);
});
