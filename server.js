// server.js
// Minimal secure backend for VEO3 + ElevenLabs + optional mux
// Node 18+, Express 4, FFmpeg optional (see notes)

import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const PORT = process.env.PORT || 8080;
const ELEVEN_KEY = process.env.ELEVEN_LABS || process.env.ELEVENLABS_API_KEY || "";

if (!ELEVEN_KEY) {
  console.warn("[WARN] ELEVEN_LABS / ELEVENLABS_API_KEY not set. ElevenLabs endpoints will 401.");
}

// --- Health ---
app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// --- VEO3 passthroughs (keep your existing handlers if you already have them) ---
// These are placeholders to retain your current URLs (/generate-fast, /generate-quality).
// If you already have working logic, do NOT overwrite it. Keep yours.
app.post("/generate-fast", async (req, res) => {
  // Forward to your existing VEO fast implementation
  return res.status(501).json({ success: false, error: "Not implemented here (keep your existing /generate-fast)." });
});
app.post("/generate-quality", async (req, res) => {
  return res.status(501).json({ success: false, error: "Not implemented here (keep your existing /generate-quality)." });
});
app.get("/result/:jobId", async (req, res) => {
  return res.status(501).json({ success: false, error: "Not implemented here (keep your existing /result/:jobId)." });
});

// --- ElevenLabs: list voices ---
app.get("/eleven/voices", async (_req, res) => {
  if (!ELEVEN_KEY) return res.status(401).json({ error: "ElevenLabs key missing" });
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": ELEVEN_KEY }
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    // Normalize to minimal shape
    const voices = (j.voices || []).map(v => ({
      id: v.voice_id || v.voiceId || v.id,
      name: v.name,
      category: v.category || "",
    }));
    res.json({ voices });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- ElevenLabs: text-to-speech ---
// body: { voice_id, text, model_id?, stability?, similarity_boost?, style?, use_speaker_boost? }
app.post("/eleven/tts", async (req, res) => {
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
      const t = await r.text().catch(()=> "");
      return res.status(r.status).json({ error: "ElevenLabs error", detail: t });
    }

    // Save to temp and serve back a signed URL
    const buf = Buffer.from(await r.arrayBuffer());
    const fname = `tts_${Date.now()}_${crypto.randomBytes(5).toString("hex")}.mp3`;
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const outDir = path.join(__dirname, "public", "tts");
    await fs.mkdir(outDir, { recursive: true });
    const full = path.join(outDir, fname);
    await fs.writeFile(full, buf);
    res.json({ audio_url: `/static/tts/${fname}`, bytes: buf.length });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// --- Optional: simple mux (merge external mp4 + mp3 into an mp4 with narration) ---
// Requires FFmpeg available at runtime (Railway Nixpacks often include it; if not, add it).
// body: { video_url, audio_url }
app.post("/mux", async (req, res) => {
  const { video_url, audio_url } = req.body || {};
  if (!video_url || !audio_url) return res.status(400).json({ error: "video_url and audio_url required" });

  // Lazy dependency: run only if ffmpeg present
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";

  // Download inputs
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const tmpDir = path.join(__dirname, "tmp");
    const outDir = path.join(__dirname, "public", "mux");
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.mkdir(outDir, { recursive: true });

    const vPath = path.join(tmpDir, `v_${Date.now()}.mp4`);
    const aPath = path.join(tmpDir, `a_${Date.now()}.mp3`);
    const outPath = path.join(outDir, `out_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp4`);

    // helpers
    const dl = async (u, fp) => {
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Download failed: ${u} -> ${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      await fs.writeFile(fp, b);
    };
    await dl(video_url, vPath);
    await dl(audio_url, aPath);

    // exec ffmpeg
    const { spawn } = await import("child_process");
    const args = [
      "-y",
      "-i", vPath,
      "-i", aPath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-shortest",
      outPath
    ];
    const proc = spawn(ffmpegPath, args, { stdio: "inherit" });
    proc.on("error", (err) => res.status(500).json({ error: "FFmpeg spawn failed", detail: String(err) }));
    proc.on("close", async (code) => {
      try {
        await fs.rm(vPath, { force: true });
        await fs.rm(aPath, { force: true });
      } catch {}
      if (code !== 0) return res.status(500).json({ error: `FFmpeg exit ${code}` });
      res.json({ merged_url: `/static/mux/${path.basename(outPath)}` });
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Static serving of generated assets
app.use("/static", express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "public"), {
  setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable")
}));

app.listen(PORT, () => console.log(`[OK] API up on :${PORT}`));
