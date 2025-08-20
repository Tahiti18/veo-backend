const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors());

const PRICING = {
  fast: { audio_on: 0.40, audio_off: 0.25 },
  quality: { audio_on: 0.75, audio_off: 0.50 }
};

app.get("/", (req, res) => {
  res.json({ status: "Veo backend running", version: "1.1.0" });
});

app.get("/pricing", (req, res) => {
  res.json(PRICING);
});

function clampDuration(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n)) return 8;
  return Math.max(1, Math.min(8, Math.round(n)));
}

function extractUrl(data) {
  if (data?.video_url) return data.video_url;
  if (Array.isArray(data?.output) && data.output[0]?.url) return data.output[0].url;
  if (data?.result?.video_url) return data.result.video_url;
  return null;
}

app.post("/generate", async (req, res) => {
  try {
    const {
      prompt,
      audio = false,
      mode = "fast",
      duration = 8,
      aspect_ratio = "16:9",
      resolution = "720p",
      seed,
      image_url,
      negative_prompt,
      guidance
    } = req.body || {};

    if (!prompt && !image_url) {
      return res.status(400).json({ success: false, error: "Provide a prompt and/or image_url." });
    }

    const seconds = clampDuration(duration);
    const endpoint = mode === "quality" ? "https://fal.run/fal-ai/veo3" : "https://fal.run/fal-ai/veo3/fast";

    const input = {
      prompt,
      audio_enabled: !!audio,
      duration: seconds,
      aspect_ratio,
      resolution,
      seed,
      image_url,
      negative_prompt,
      guidance
    };

    Object.keys(input).forEach(k => input[k] === undefined && delete input[k]);

    const response = await axios.post(endpoint, { input }, {
      headers: {
        Authorization: `Key ${process.env.FAL_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 600000
    });

    const url = extractUrl(response.data);
    const est = (mode === "quality"
      ? (audio ? PRICING.quality.audio_on : PRICING.quality.audio_off)
      : (audio ? PRICING.fast.audio_on : PRICING.fast.audio_off)) * seconds;

    res.json({
      success: true,
      mode,
      seconds,
      estimated_cost_usd: Number(est.toFixed(2)),
      video_url: url,
      raw: response.data
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: err?.response?.data || err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Veo backend listening on ${PORT}`));
