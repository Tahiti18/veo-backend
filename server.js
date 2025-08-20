// server.js (Live Veo 3 Backend)
const express = require("express");
const axios = require("axios");
const dotenv = require("dotenv");
const cors = require("cors");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "✅ Veo 3 Backend Running (Live)", version: "1.0.1" });
});

// Helper to call fal.ai
async function callFal(endpoint, input) {
  const response = await axios.post(endpoint, { input }, {
    headers: {
      Authorization: `Key ${process.env.FAL_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 600000
  });
  return response.data;
}

// Generate Fast video (8 sec max)
app.post("/generate-fast", async (req, res) => {
  try {
    const { prompt, audio = false, duration = 8, aspect_ratio = "16:9" } = req.body;
    const data = await callFal("https://fal.run/fal-ai/veo3/fast", {
      prompt,
      audio_enabled: audio,
      duration,
      aspect_ratio
    });
    const url = data?.video_url || data?.output?.[0]?.url || null;
    res.json({ success: true, video_url: url, raw: data });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// Generate Quality video
app.post("/generate-quality", async (req, res) => {
  try {
    const { prompt, audio = false, duration = 8, aspect_ratio = "16:9" } = req.body;
    const data = await callFal("https://fal.run/fal-ai/veo3", {
      prompt,
      audio_enabled: audio,
      duration,
      aspect_ratio
    });
    const url = data?.video_url || data?.output?.[0]?.url || null;
    res.json({ success: true, video_url: url, raw: data });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Veo backend listening on ${PORT}`);
});
