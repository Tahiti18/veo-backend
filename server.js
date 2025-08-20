import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// Root status check
app.get("/", (req, res) => {
  res.json({ status: "✅ Veo 3 backend live on Railway" });
});

// Fast generation endpoint
app.post("/generate-fast", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "No prompt provided" });

    // Example fal.ai call
    const response = await axios.post(
      "https://fal.run/google/veo-fast",
      { prompt },
      {
        headers: {
          Authorization: `Key ${process.env.FAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ videoUrl: response.data.video_url || response.data });
  } catch (err) {
    console.error("Fast gen error:", err.message);
    res.status(500).json({ error: "Fast generation failed" });
  }
});

// Quality generation endpoint
app.post("/generate-quality", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "No prompt provided" });

    const response = await axios.post(
      "https://fal.run/google/veo-quality",
      { prompt },
      {
        headers: {
          Authorization: `Key ${process.env.FAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ videoUrl: response.data.video_url || response.data });
  } catch (err) {
    console.error("Quality gen error:", err.message);
    res.status(500).json({ error: "Quality generation failed" });
  }
});

// Listen on Railway's port
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Veo backend listening on ${PORT}`);
});
