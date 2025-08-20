// server.js (ESM, live fal.run integration)
import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());              // allow Netlify frontend
app.use(express.json());

// quick health
app.get("/", (req, res) => {
  res.json({ status: "✅ Veo 3 Backend Running (LIVE fal.run)", version: "1.0.2" });
});

// helper: call fal.run with auth
async function callFal(endpoint, input) {
  const { FAL_KEY } = process.env;
  if (!FAL_KEY) throw new Error("Missing FAL_KEY env var.");
  const r = await axios.post(
    endpoint,
    { input },
    {
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 600000
    }
  );
  return r.data;
}

function pickUrl(data) {
  // fal.run returns one of these shapes
  return data?.video_url || data?.output?.[0]?.url || data?.result?.video_url || null;
}

// POST /generate-fast  (Veo 3 Fast — 8s max)
app.post("/generate-fast", async (req, res) => {
  try {
    const { prompt, audio = false, duration = 8, aspect_ratio = "16:9", resolution = "720p", seed } = req.body || {};
    if (!prompt) return res.status(400).json({ success: false, error: "Prompt is required." });

    const data = await callFal("https://fal.run/fal-ai/veo3/fast", {
      prompt,
      audio_enabled: !!audio,
      duration: Math.max(1, Math.min(8, Math.round(duration))),
      aspect_ratio,
      resolution,
      seed
    });

    const url = pickUrl(data);
    if (!url) return res.status(502).json({ success: false, error: "No video URL returned from provider.", raw: data });

    res.json({ success: true, video_url: url, raw: data });
  } catch (err) {
    console.error("FAST ERROR:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// POST /generate-quality (Veo 3 Quality)
app.post("/generate-quality", async (req, res) => {
  try {
    const { prompt, audio = false, duration = 8, aspect_ratio = "16:9", resolution = "1080p", seed } = req.body || {};
    if (!prompt) return res.status(400).json({ success: false, error: "Prompt is required." });

    const data = await callFal("https://fal.run/fal-ai/veo3", {
      prompt,
      audio_enabled: !!audio,
      duration: Math.max(1, Math.min(8, Math.round(duration))),
      aspect_ratio,
      resolution,
      seed
    });

    const url = pickUrl(data);
    if (!url) return res.status(502).json({ success: false, error: "No video URL returned from provider.", raw: data });

    res.json({ success: true, video_url: url, raw: data });
  } catch (err) {
    console.error("QUALITY ERROR:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Veo backend (LIVE) on ${PORT}`);
});
