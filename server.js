// server.js — KIE-only backend (ESM)
// Requires: express, cors, axios, dotenv
// ENV: KIE_KEY (required), KIE_API_PREFIX (default https://api.kie.ai/api/v1), PORT

import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;
const API = (process.env.KIE_API_PREFIX || "https://api.kie.ai/api/v1").replace(/\/+$/,"");
const KEY = process.env.KIE_KEY;

// ---------- middleware
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- health & root
app.get("/", (req, res) =>
  res.json({ status: "✅ Kie.ai backend running", version: "2.0.0", time: new Date().toISOString() })
);
app.get("/health", (req, res) =>
  res.json({ ok: true, service: "kie-backend", api_prefix: API, kie_key_present: Boolean(KEY) })
);

// ---------- helpers
const ALLOWED_RATIOS = new Set(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const clamp = d => {
  const n = Number(d);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(8, Math.round(n * 10) / 10));
};

function sanitize(body = {}) {
  const { prompt, duration, fps, aspect_ratio, seed, with_audio } = body;
  if (!prompt || !String(prompt).trim()) {
    const e = new Error("Prompt is required."); e.status = 400; throw e;
  }
  return {
    prompt: String(prompt),
    duration: clamp(duration ?? 8),
    fps: Number.isFinite(Number(fps)) ? Number(fps) : 30,
    aspect_ratio: ALLOWED_RATIOS.has(String(aspect_ratio)) ? String(aspect_ratio) : "9:16",
    seed: seed ?? 42101,
    with_audio: with_audio === false ? false : true
  };
}

async function kiePost(path, payload) {
  if (!KEY) { const e = new Error("Missing KIE_KEY"); e.status = 500; throw e; }
  const url = `${API}${path}`;
  const { data } = await axios.post(url, payload, {
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    timeout: 600_000
  });
  return data;
}
async function kiePoll(path, id) {
  const url = `${API}${path}`;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const { data } = await axios.get(url, {
      params: { id },
      headers: { Authorization: `Bearer ${KEY}` },
      timeout: 20000
    });
    if (data.status === "succeeded" && data.output?.video_url) {
      return { success: true, video_url: data.output.video_url, meta: data };
    }
    if (data.status === "failed") {
      const e = new Error(data.error || "Render failed"); e.status = 502; e.meta = data; throw e;
    }
  }
  const e = new Error("Render timeout"); e.status = 504; throw e;
}

// ---------- Veo-3 FAST
app.post("/generate-fast", async (req, res) => {
  try {
    const p = sanitize(req.body);
    const sub = await kiePost("/veo/generate", { mode: "fast", ...p });
    const jobId = sub.id || sub.job_id;
    if (!jobId) return res.status(502).json({ success: false, error: "No job id from KIE", raw: sub });
    const out = await kiePoll("/veo/record-info", jobId);
    res.json({ ...out, provider: "kie.veo3.fast" });
  } catch (err) {
    console.error("KIE FAST:", err.status || "", err.message);
    res.status(err.status || 500).json({ success: false, error: err.message, meta: err.meta });
  }
});

// ---------- Veo-3 QUALITY
app.post("/generate-quality", async (req, res) => {
  try {
    const p = sanitize(req.body);
    const sub = await kiePost("/veo/generate", { mode: "quality", ...p });
    const jobId = sub.id || sub.job_id;
    if (!jobId) return res.status(502).json({ success: false, error: "No job id from KIE", raw: sub });
    const out = await kiePoll("/veo/record-info", jobId);
    res.json({ ...out, provider: "kie.veo3.quality" });
  } catch (err) {
    console.error("KIE QUALITY:", err.status || "", err.message);
    res.status(err.status || 500).json({ success: false, error: err.message, meta: err.meta });
  }
});

// ---------- Runway via KIE (B-roll / bridges)
app.post("/generate-runway", async (req, res) => {
  try {
    const p = sanitize(req.body);
    const sub = await kiePost("/runway/generate", p);
    const jobId = sub.id || sub.job_id;
    if (!jobId) return res.status(502).json({ success: false, error: "No job id from KIE", raw: sub });
    const out = await kiePoll("/runway/record-info", jobId);
    res.json({ ...out, provider: "kie.runway" });
  } catch (err) {
    console.error("KIE RUNWAY:", err.status || "", err.message);
    res.status(err.status || 500).json({ success: false, error: err.message, meta: err.meta });
  }
});

app.listen(PORT, () => console.log(`🚀 Kie backend (LIVE) on ${PORT}`));
