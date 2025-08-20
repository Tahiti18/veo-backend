// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(bodyParser.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "✅ Veo 3 Advanced Backend Running" });
});

// Generate fast video (mock example)
app.post("/generate-fast", async (req, res) => {
  const { prompt, resolution, fps, duration, seed, audio } = req.body;

  // Simulate backend request (you would replace with actual VEO API call)
  res.json({
    status: "success",
    message: "Fast video generated",
    params: { prompt, resolution, fps, duration, seed, audio },
    url: "https://example.com/generated_video.mp4"
  });
});

// Generate quality video (mock example)
app.post("/generate-quality", async (req, res) => {
  const { prompt, resolution, fps, duration, seed, audio } = req.body;

  res.json({
    status: "success",
    message: "Quality video generated",
    params: { prompt, resolution, fps, duration, seed, audio },
    url: "https://example.com/generated_quality.mp4"
  });
});

// Metrics endpoint
app.get("/metrics", (req, res) => {
  res.json({
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    timestamp: Date.now()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Veo backend listening on port ${PORT}`);
});
