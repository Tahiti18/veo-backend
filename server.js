// server.js (ESM) — Veo 3 via fal.run (hardened + shape-agnostic)
// Requires: express, cors, axios, dotenv
// ENV: FAL_KEY (required), PORT (optional), FAL_VEO3_FAST (optional), FAL_VEO3_QUALITY (optional)

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// ---- middleware
app.use(cors());                // allow Netlify/frontends
app.use(express.json({ limit: "2mb" }));

// ---- quick health
app.get("/", (req, res) => {
  res.json({
    status: "✅ Veo 3 Backend Running (LIVE fal.run)",
    version: "1.1.0",
    time: new Date().toISOString()
  });
});

// ---- utils
const FAST_ENDPOINT =
  process.env.FAL_VEO3_FAST || "https://fal.run/fal-ai/veo3/fast";
const QUALITY_ENDPOINT =
  process.env.FAL_VEO3_QUALITY || "https://fal.run/fal-ai/veo3";

const ALLOWED_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const ALLOWED_RES = new Set(["720p", "1080p", "4k", "4K", "2k", "2K", "1440p"]);

function clampDuration(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 8;
  // keep one decimal (7.7s etc), max 8s per Veo Fast docs
  return Math.max(1, Math.min(8, Math.round(n * 10) / 10));
}

function sanitize({ prompt, audio, duration, aspect_ratio, resolution, seed }) {
  return {
    prompt: String(prompt),
    audio_enabled: !!audio,
    duration: clampDuration(duration ?? 8),
    aspect_ratio: ALLOWED_RATIOS.has(String(aspect_ratio)) ? String(aspect_ratio) : "16:9",
    resolution: ALLOWED_RES.has(String(resolution)) ? String(resolution) : "1080p",
    ...(seed !== undefined ? { seed } : {})
  };
}

// FAL sometimes expects { input: {...} } (Replicate-style) or a top-level body { ... }.
// Try both shapes automatically.
async function callFal(endpoint, input) {
  const { FAL_KEY } = process.env;
  if (!FAL_KEY) throw new Error("Missing FAL_KEY env var.");

  const cfg = {
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 600_000
  };

  // attempt 1: { input: {...} }
  try {
    const r = await axios.post(endpoint, { input }, cfg);
    return r.data;
  } catch (e1) {
    // attempt 2: top-level body {...}
    try {
      const r2 = await axios.post(endpoint, input, cfg);
      return r2.data;
    } catch (e2) {
      // bubble up the more informative error
      const errData = e2.response?.data ?? e1.response?.data ?? e2.message ?? e1.message;
      const err = new Error(typeof errData === "string" ? errData : JSON.stringify(errData));
      err.status = e2.response?.status || e1.response?.status || 500;
      throw err;
    }
  }
}

// Normalize the many output shapes fal.run models use
function pickUrl(data) {
  return (
    data?.video_url ||
    data?.video?.url ||
    data?.output?.video?.url ||
    data?.output?.[0]?.url ||
    data?.result?.video_url ||
    data?.result?.video?.url ||
    data?.assets?.video?.url ||
    data?.videos?.[0]?.url ||
    data?.media?.find?.(m => m?.url && String(m?.content_type || "").includes("video"))?.url ||
    null
  );
}

function normalizeResponse(data) {
  const url = pickUrl(data);
  const meta =
    data?.meta ||
    data?.output?.meta ||
    data?.result?.meta ||
    {};
  return { url, meta, raw: data };
}

// ---- routes

// POST /generate-fast  (Veo 3 Fast — up to ~8s)
app.post("/generate-fast", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ success: false, error: "Prompt is required." });
    }

    const payload = sanitize(req.body || {});
    const data = await callFal(FAST_ENDPOINT, payload);
    const { url, meta, raw } = normalizeResponse(data);

    if (!url) {
      return res.status(502).json({
        success: false,
        error: "No video URL returned from provider.",
        raw
      });
    }
    res.json({ success: true, video_url: url, meta, provider: "fal.run", raw });
  } catch (err) {
    console.error("FAST ERROR:", err.status || "", err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /generate-quality (Veo 3 Quality)
app.post("/generate-quality", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ success: false, error: "Prompt is required." });
    }

    const payload = sanitize(req.body || {});
    const data = await callFal(QUALITY_ENDPOINT, payload);
    const { url, meta, raw } = normalizeResponse(data);

    if (!url) {
      return res.status(502).json({
        success: false,
        error: "No video URL returned from provider.",
        raw
      });
    }
    res.json({ success: true, video_url: url, meta, provider: "fal.run", raw });
  } catch (err) {
    console.error("QUALITY ERROR:", err.status || "", err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Veo backend (LIVE) on ${PORT}`);
});
