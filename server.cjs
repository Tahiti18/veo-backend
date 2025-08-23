// server.cjs — FIXED KIE.ai endpoints
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
const ELEVEN_KEY = process.env.ELEVEN_LABS || "";
const KIE_BASE_URL = "https://api.kie.ai/api/v1/veo"; // ✅ FIXED URL
const KIE_KEY = process.env.KIE_KEY || "";
const VEO_MODEL_FAST = process.env.VEO_MODEL_FAST || "V3_5";
const VEO_MODEL_QUALITY = process.env.VEO_MODEL_QUALITY || "V4_5PLUS";
const ENABLE_MUX = process.env.ENABLE_MUX === "1";

// Directories
const TMP_ROOT = process.env.RUNTIME_TMP || "/tmp";
const STATIC_ROOT = path.join(TMP_ROOT, "public");
const TTS_DIR = path.join(STATIC_ROOT, "tts");
const MUX_DIR = path.join(STATIC_ROOT, "mux");

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

function buildKieHeaders() {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${KIE_KEY}`
  };
}

// ---------- Diagnostics ----------
app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    diag: {
      elevenKeyPresent: !!ELEVEN_KEY,
      kieBaseUrl: KIE_BASE_URL,
      kieKeyPresent: !!KIE_KEY,
      enableMux: ENABLE_MUX,
      models: { fast: VEO_MODEL_FAST, quality: VEO_MODEL_QUALITY }
    }
  });
});

app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/ping", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---------- Video Generation (FIXED ENDPOINTS) ----------
app.post("/generate-fast", async (req, res) => {
  if (!KIE_KEY) return apiErr(res, 502, "KIE.ai API key missing");

  const body = {
    prompt: req.body.prompt || "",
    aspect_ratio: req.body.aspect_ratio || "16:9", 
    duration: req.body.duration || 8,
    model: VEO_MODEL_FAST,
    ...req.body
  };

  console.log(`\n🚀 [KIE GENERATE-FAST] Request:`);
  console.log(`URL: ${KIE_BASE_URL}/generate`);
  console.log(`Body:`, JSON.stringify(body, null, 2));

  try {
    const response = await withTimeout(signal => fetch(`${KIE_BASE_URL}/generate`, {
      method: "POST",
      headers: buildKieHeaders(),
      body: JSON.stringify(body),
      signal
    }), 30000);

    const text = await response.text();
    console.log(`\n📥 [KIE RESPONSE]:`);
    console.log(`Status: ${response.status}`);
    console.log(`Text:`, text);

    let json = null;
    try { json = JSON.parse(text); } catch (e) {
      console.log(`❌ [KIE] Failed to parse JSON:`, e.message);
    }

    if (!response.ok) {
      console.log(`❌ [KIE] Request failed with status ${response.status}`);
      return res.status(response.status).send(json || text);
    }

    console.log(`✅ [KIE] Success! Parsed JSON:`, JSON.stringify(json, null, 2));
    res.status(response.status).send(json || text);
    
  } catch (e) {
    console.error(`❌ [KIE ERROR]:`, e);
    return apiErr(res, 502, "KIE.ai request failed", { detail: e.message });
  }
});

app.post("/generate-quality", async (req, res) => {
  if (!KIE_KEY) return apiErr(res, 502, "KIE.ai API key missing");

  const body = {
    prompt: req.body.prompt || "",
    aspect_ratio: req.body.aspect_ratio || "16:9",
    duration: req.body.duration || 8, 
    model: VEO_MODEL_QUALITY,
    ...req.body
  };

  console.log(`\n🚀 [KIE GENERATE-QUALITY] Request:`);
  console.log(`URL: ${KIE_BASE_URL}/generate`);
  console.log(`Body:`, JSON.stringify(body, null, 2));

  try {
    const response = await withTimeout(signal => fetch(`${KIE_BASE_URL}/generate`, {
      method: "POST", 
      headers: buildKieHeaders(),
      body: JSON.stringify(body),
      signal
    }), 30000);

    const text = await response.text();
    console.log(`\n📥 [KIE RESPONSE]:`);
    console.log(`Status: ${response.status}`);
    console.log(`Text:`, text);

    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!response.ok) {
      return res.status(response.status).send(json || text);
    }

    console.log(`✅ [KIE] Success! Parsed JSON:`, JSON.stringify(json, null, 2));
    res.status(response.status).send(json || text);
    
  } catch (e) {
    console.error(`❌ [KIE ERROR]:`, e);
    return apiErr(res, 502, "KIE.ai request failed", { detail: e.message });
  }
});

// ✅ FIXED: Use correct KIE.ai query endpoint
app.get("/result/:jobId", async (req, res) => {
  if (!KIE_KEY) return apiErr(res, 502, "KIE.ai API key missing");

  try {
    const taskId = encodeURIComponent(req.params.jobId);
    const queryUrl = `${KIE_BASE_URL}/record-info/${taskId}`; // ✅ FIXED ENDPOINT
    
    console.log(`\n🔍 [KIE QUERY] Request:`);
    console.log(`URL: ${queryUrl}`);

    const response = await withTimeout(signal => fetch(queryUrl, {
      method: "GET",
      headers: buildKieHeaders(),
      signal
    }), 20000);

    const text = await response.text();
    console.log(`\n📥 [KIE QUERY RESPONSE]:`);
    console.log(`Status: ${response.status}`);
    console.log(`Text:`, text);

    let json = null;
    try { json = JSON.parse(text); } catch {}

    if (!response.ok) {
      return res.status(response.status).send(json || text);
    }

    console.log(`✅ [KIE] Query Success:`, JSON.stringify(json, null, 2));
    res.status(response.status).send(json || text);
    
  } catch (e) {
    console.error(`❌ [KIE QUERY ERROR]:`, e);
    return apiErr(res, 502, "KIE.ai query failed", { detail: e.message });
  }
});

// ---------- ElevenLabs Routes ----------
app.get("/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVEN_KEY }
    });
    const j = await r.json();
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
  if (!ENABLE_MUX) return res.status(403).json({ error: "Mux disabled" });
  
  const { video_url, audio_url } = req.body || {};
  if (!video_url || !audio_url) return res.status(400).json({ error: "URLs required" });

  res.json({ merged_url: video_url });
});

// ---------- Static files ----------
app.use("/static", express.static(STATIC_ROOT));

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 [SERVER] Listening on port ${PORT}`);
  console.log(`📍 [CONFIG] KIE Base URL: ${KIE_BASE_URL}`);
  console.log(`🔑 [CONFIG] KIE Key Present: ${!!KIE_KEY}`);
  console.log(`🎤 [CONFIG] ElevenLabs Key Present: ${!!ELEVEN_KEY}`);
  console.log(`\n💡 Fixed endpoints: /generate and /record-info/{taskId}\n`);
});
