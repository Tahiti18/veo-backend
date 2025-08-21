// server.js (ESM) — Veo 3 via fal.run (hardened + shape-agnostic)
// Requires: express, cors, axios, dotenv
// ENV: FAL_KEY (required), PORT (optional),
//      FAL_VEO3_FAST (optional), FAL_VEO3_QUALITY (optional)

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// ---- middleware
app.use(cors()); // allow frontend origins (adjust if you need strict CORS)
app.use(express.json({ limit: "2mb" }));

// ---- quick root ping
app.get("/", (req, res) => {
  res.json({
    status: "✅ Veo 3 Backend Running (LIVE fal.run)",
    version: "1.2.0",
    time: new Date().toISOString()
  });
});

// ---- health (so you don’t see “Cannot GET /health” again)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "veo-backend",
    time: new Date().toISOString(),
    env: {
      fal_key_present: Boolean(process.env.FAL_KEY),
      fast_endpoint: process.env.FAL_VEO3_FAST || "https://fal.run/fal-ai/veo3/fast",
      quality_endpoint: process.env.FAL_VEO3_QUALITY || "https://fal.run/fal-ai/veo3"
    }
  });
});

// ---- TEMP DIAG: confirm FAL_KEY is loaded (masked)
app.get("/_keycheck", (req, res) => {
  const v = process.env.FAL_KEY || "";
  res.json({
    present: !!v,
    length: v.length,
    preview: v ? v.slice(0, 8) + "..." + v.slice(-8) : null
  });
});

// ---- utils
const FAST_ENDPOINT =
  process.env.FAL_VEO3_FAST || "https://fal.run/fal-ai/veo3/fast";
const QUALITY_ENDPOINT =
  process.env.FAL_VEO3_QUALITY || "https://fal.run/fal-ai/veo3";

const ALLOWED_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const ALLOWED_RES = new Set(["720p", "1080p", "1440p", "2k", "2K", "4k", "4K"]);

function clampDuration(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 8;
  // allow one decimal, bound 1..8 sec (fast tier typically caps at ~8s)
  return Math.max(1, Math.min(8, Math.round(n * 10) / 10));
}

function sanitize(body = {}) {
  const {
    prompt,
    audio,
    duration,
    aspect_ratio,
    resolution,
    seed
  } = body;

  if (!prompt || !String(prompt).trim()) {
    const e = new Error("Prompt is required.");
    e.status = 400;
    throw e;
  }

  return {
    prompt: String(prompt),
    audio_enabled: Boolean(audio),
    duration: clampDuration(duration ?? 8),
    aspect_ratio: ALLOWED_RATIOS.has(String(aspect_ratio)) ? String(aspect_ratio) : "16:9",
    resolution: ALLOWED_RES.has(String(resolution)) ? String(resolution) : "1080p",
    ...(seed !== undefined ? { seed } : {})
  };
}

// fal.run APIs vary between { input: {...} } and top-level {...}.
// Try both shapes automatically and surface the best error.
async function callFal(endpoint, input) {
  const { FAL_KEY } = process.env;
  if (!FAL_KEY) {
    const e = new Error("Missing FAL_KEY env var.");
    e.status = 500;
    throw e;
  }

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
      const errData = e2.response?.data ?? e1.response?.data ?? e2.message ?? e1.message;
      const err = new Error(
        typeof errData === "string" ? errData : JSON.stringify(errData)
      );
      err.status = e2.response?.status || e1.response?.status || 502;
      throw err;
    }
  }
}

// Normalize various output shapes into { url, meta, raw }
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
    (Array.isArray(data?.media)
      ? data.media.find(m => m?.url && String(m?.content_type || "").includes("video"))?.url
      : null) ||
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
    const payload = sanitize(req.body);
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

// POST /generate-quality (Veo 3 Quality — longer/more detailed)
app.post("/generate-quality", async (req, res) => {
  try {
    const payload = sanitize(req.body);
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
