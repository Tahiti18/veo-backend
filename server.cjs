// server.cjs — Unity Lab backend (CommonJS, Node >=20)
// - Fixes 404s: proxies /generate-* and /result/:id to your upstream (VEO_BACKEND_URL / KIE_API_PREFIX)
// - Sends KIE_KEY to upstream via Authorization: Bearer and x-api-key (covers both auth styles)
// - ElevenLabs: accepts ELEVEN_LABS, ELEVENLABS_API_KEY, ELEVEN_LABS_API_KEY, and "11_Labs"
// - TTS streaming + iPad test; optional saved MP3 in /tmp/public/tts
// - Optional mux (ENABLE_MUX=1 + ffmpeg); static files served from /tmp/public
// - Adds /diag so you can sanity-check config without exposing secrets

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

// Accept multiple ElevenLabs var names (no assumptions).
const ELEVEN_KEY =
  process.env.ELEVEN_LABS ||
  process.env.ELEVENLABS_API_KEY ||
  process.env.ELEVEN_LABS_API_KEY ||
  process.env["11_Labs"] ||
  "";

// Upstream for video generation (use whichever you provided)
const VEO_UPSTREAM =
  (process.env.VEO_BACKEND_URL || process.env.VEO_WORKER_URL || process.env.KIE_API_PREFIX || "").replace(/\/$/,"");

// Allow overriding paths if your upstream doesn’t use our defaults
const VEO_FAST_PATH    = process.env.VEO_FAST_PATH    || "/generate-fast";
const VEO_QUALITY_PATH = process.env.VEO_QUALITY_PATH || "/generate-quality";
const VEO_RESULT_PATH  = process.env.VEO_RESULT_PATH  || "/result"; // we append /:jobId

// Auth for upstream (we’ll send both header styles, only if present)
const KIE_KEY = process.env.KIE_KEY || process.env.VEO_API_KEY || "";

// Mux/FFmpeg options
const ENABLE_MUX = process.env.ENABLE_MUX === "1";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

// Writable locations on Railway
const TMP_ROOT    = process.env.RUNTIME_TMP || "/tmp";
const STATIC_ROOT = path.join(TMP_ROOT, "public");
const TTS_DIR     = path.join(STATIC_ROOT, "tts");
const MUX_DIR     = path.join(STATIC_ROOT, "mux");

// Ensure dirs exist
(async () => { try {
  await fs.mkdir(TTS_DIR, { recursive: true });
  await fs.mkdir(MUX_DIR, { recursive: true });
} catch (_) {} })();

// ---------- Helpers ----------
function withTimeout(fn, ms = 20000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return Promise.resolve(fn(ac.signal)).finally(() => clearTimeout(t));
}
const apiErr = (res, status, msg, extra) => res.status(status).json({ success:false, error: msg, ...(extra||{}) });

function buildUpstreamHeaders() {
  const h = { "Content-Type": "application/json" };
  if (KIE_KEY) {
    h["Authorization"] = `Bearer ${KIE_KEY}`;
    h["x-api-key"] = KIE_KEY;
  }
  return h;
}

// ---------- Diagnostics (no secrets leaked) ----------
app.get("/diag", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    healthPath: "/health",
    diag: {
      elevenKeyPresent: !!ELEVEN_KEY,
      upstreamSet: !!VEO_UPSTREAM,
      upstream: VEO_UPSTREAM ? (new URL(VEO_UPSTREAM)).origin + (new URL(VEO_UPSTREAM)).pathname : null,
      paths: { fast: VEO_FAST_PATH, quality: VEO_QUALITY_PATH, resultBase: VEO_RESULT_PATH },
      kieKeyPresent: !!KIE_KEY,
      enableMux: ENABLE_MUX
    }
  });
});

// ---------- Health ----------
app.get("/ping", (_req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));
app.get("/health", (_req,res)=>res.json({ ok:true, ts:new Date().toISOString() }));

// ---------- VEO pass-through (fixes your 404s) ----------
async function proxyJsonPost(upPath, req, res) {
  if (!VEO_UPSTREAM) return apiErr(res, 502, "VEO_UPSTREAM missing. Set VEO_BACKEND_URL or KIE_API_PREFIX.");
  try {
    const r = await withTimeout(signal => fetch(VEO_UPSTREAM + upPath, {
      method: "POST",
      headers: buildUpstreamHeaders(),
      body: JSON.stringify(req.body || {}),
      signal
    }), 30000);
    const text = await r.text();
    let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(r.status).json(data);
  } catch (e) {
    return apiErr(res, 502, e?.message || String(e));
  }
}
async function proxyJsonGet(upPath, res) {
  if (!VEO_UPSTREAM) return apiErr(res, 502, "VEO_UPSTREAM missing. Set VEO_BACKEND_URL or KIE_API_PREFIX.");
  try {
    const r = await withTimeout(signal => fetch(VEO_UPSTREAM + upPath, {
      method: "GET",
      headers: buildUpstreamHeaders(),
      signal
    }), 30000);
    const text = await r.text();
    let data = {}; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(r.status).json(data);
  } catch (e) {
    return apiErr(res, 502, e?.message || String(e));
  }
}

// Endpoints your frontend calls:
app.post("/generate-fast",    (req,res)=>proxyJsonPost(VEO_FAST_PATH, req, res));
app.post("/generate-quality", (req,res)=>proxyJsonPost(VEO_QUALITY_PATH, req, res));
app.get("/result/:jobId",     (req,res)=>proxyJsonGet(`${VEO_RESULT_PATH}/${encodeURIComponent(req.params.jobId)}`, res));

// ---------- ElevenLabs: list voices ----------
app.get("/api/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  try {
    const r = await withTimeout(signal => fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVEN_KEY }, signal
    }), 15000);
    const j = await r.json().catch(()=> ({}));
    if (!r.ok) return res.status(r.status).json(j);
    const voices = (j.voices||[]).map(v => ({ id: v.voice_id || v.id, name: v.name, category: v.category||"" }));
    res.json({ voices });
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
});

// ---------- ElevenLabs: TTS streaming (best for UI preview; no disk) ----------
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

    const r = await withTimeout(signal => fetch(url, {
      method:"POST",
      headers:{ "xi-api-key": ELEVEN_KEY, "Content-Type":"application/json", "Accept":"audio/mpeg" },
      body: JSON.stringify(payload), signal
    }), 20000);

    if (!r.ok) {
      const errText = await r.text().catch(()=> "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: errText });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    const len = r.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    if (String(req.query.download||"") === "1") res.setHeader("Content-Disposition", 'attachment; filename="voiceover.mp3"');

    const nodeStream = Readable.fromWeb(r.body);
    await pipe(nodeStream, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e?.message || String(e) });
    else try { res.destroy(e); } catch {}
  }
});

// ---------- ElevenLabs: TTS save to /tmp/public/tts (optional) ----------
app.post("/api/eleven/tts", async (req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  const { voice_id, text, model_id, params } = req.body || {};
  if (!voice_id || !text) return res.status(400).json({ error: "voice_id and text required" });

  try {
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
    const r = await withTimeout(signal => fetch(url, {
      method:"POST",
      headers:{ "xi-api-key": ELEVEN_KEY, "Content-Type":"application/json", "Accept":"audio/mpeg" },
      body: JSON.stringify(payload), signal
    }), 20000);
    if (!r.ok) {
      const t = await r.text().catch(()=> "");
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

// ---------- ElevenLabs: iPad test (GET) ----------
app.get("/api/eleven/test-tts", async (req, res) => {
  try {
    if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
    const voiceId = String(req.query.voice_id || "21m00Tcm4TlvDq8ikWAM"); // Rachel
    const text = String(req.query.text || "Hello Marwan, your Unity Lab backend generated this voice successfully.");

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?optimize_streaming_latency=0`;
    const payload = { text, model_id: "eleven_multilingual_v2",
      voice_settings: { stability:0.45, similarity_boost:0.8, style:0.0, use_speaker_boost:true } };

    const r = await withTimeout(signal => fetch(url, {
      method:"POST", headers:{ "xi-api-key":ELEVEN_KEY, "Content-Type":"application/json", "Accept":"audio/mpeg" },
      body: JSON.stringify(payload), signal
    }), 20000);
    if (!r.ok) {
      const errText = await r.text().catch(()=> "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: errText });
    }
    res.setHeader("Content-Type","audio/mpeg");
    res.setHeader("Content-Disposition",'attachment; filename="unitylab-test.mp3"');
    const nodeStream = Readable.fromWeb(r.body);
    await pipe(nodeStream, res);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ error: e?.message || String(e) });
    else try { res.destroy(e); } catch {}
  }
});

// ---------- Optional: simple mux (FFmpeg required) ----------
app.post("/api/mux", async (req, res) => {
  if (!ENABLE_MUX) return res.status(403).json({ error: "Mux disabled. Set ENABLE_MUX=1 and ensure ffmpeg is installed." });
  const { video_url, audio_url } = req.body || {};
  if (!video_url || !audio_url) return res.status(400).json({ error: "video_url and audio_url required" });

  const vPath = path.join(TMP_ROOT, `v_${Date.now()}.mp4`);
  const aPath = path.join(TMP_ROOT, `a_${Date.now()}.mp3`);
  const outPath = path.join(MUX_DIR, `out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);

  try {
    // download inputs
    const dl = async (u, fp) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Download failed: ${u} -> ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(fp, b);
    };
    await dl(video_url, vPath);
    await dl(audio_url, aPath);

    // run ffmpeg
    const { spawn } = require("child_process");
    const args = ["-y", "-i", vPath, "-i", aPath, "-c:v", "copy", "-c:a", "aac", "-shortest", outPath];
    const proc = spawn(FFMPEG, args);
    proc.on("error", err => res.status(500).json({ error: "FFmpeg spawn failed", detail: String(err) }));
    proc.on("close", async (code) => {
      try { await fs.rm(vPath,{force:true}); await fs.rm(aPath,{force:true}); } catch {}
      if (code !== 0) return res.status(500).json({ error: `FFmpeg exit ${code}` });
      res.json({ merged_url: `/static/mux/${path.basename(outPath)}` });
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Static (serve anything we saved in /tmp/public) ----------
app.use("/static", express.static(STATIC_ROOT, {
  setHeaders: (res) => res.setHeader("Cache-Control","public, max-age=31536000, immutable")
}));

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () => console.log(`[OK] Listening on ${PORT}`));
